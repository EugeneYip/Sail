/**
 * Adaptive internal resolution: the control law, as a pure function of frame
 * periods.
 *
 * It lives apart from `Engine` for one reason: **a vsync-driven controller
 * cannot be tested by rendering in an environment without a display.** On this
 * box headless Chromium's rAF is a 60 Hz *rate limiter* — measured on an empty
 * page at p50 16.7 ms in every flag set tried, including
 * `--disable-gpu-vsync` (`.tmp/rafcap.mjs`) — so
 *
 *     harness:      period ~= max(16.67, cost)
 *     real display: period  = ceil(cost / 16.67) * 16.67
 *
 * and the on-time share the controller steers by means something different in
 * each. Keeping the law here, DOM-free and THREE-free, lets
 * `.tmp/adaptsim.mjs` drive **this exact code** with measured frame-cost traces
 * from a fixed-scale sweep, quantised the way a real panel would quantise them.
 * A copy of the law transcribed into the simulation would prove nothing about
 * what ships.
 *
 * The controller has two knobs, and only one of them is expensive:
 *
 *  - the **rung** (`level`), which reallocates the whole post stack and throws
 *    away the TAA history. Measured on this box: a size never used before costs
 *    one frame of 100-475 ms, a size already seen ~20-40 ms. That price is why
 *    the law is written to arrive somewhere and stay, and why it refuses to
 *    retest a rung it already knows fails.
 *  - the **accepted interval count** (`intervals`), i.e. how many display
 *    intervals a frame may take. Changing it costs nothing at all. So when no
 *    rung on the ladder can hold the target, the right move is to accept a
 *    lower frame rate and *keep the pixels*, not to spend the whole ladder
 *    chasing a target the machine cannot reach.
 */

/**
 * Discrete render-scale levels. Coarse on purpose: every change reallocates the
 * whole post stack and throws away the TAA history, so the controller should
 * arrive somewhere and stay rather than creep.
 *
 * The bottom of the ladder has to be genuinely low, because `renderScale` is
 * only half of the pixel count: the backing store is
 * `min(devicePixelRatio, maxPixelRatio) * renderScale * cssSize`. On a Retina
 * panel at `ultra` that first factor is 2, so `renderScale` 1 at a 1600x900
 * window is 3200x1800 — 5.76 Mpx, four times what every measurement in this
 * project used before DIAGNOSIS §57. A rung that reads as extreme as a fraction
 * is not extreme in pixels: 0.36 of a Retina 1600x900 is 1152x648, which is
 * more pixels than 0.7 of the same window at dpr 1. The floor exists to cover a
 * 5K panel, where dpr 2 x a 2560 CSS width is 14.7 Mpx before any scaling.
 */
export const SCALE_LADDER = [1, 0.92, 0.84, 0.76, 0.68, 0.6, 0.52, 0.44, 0.36, 0.3, 0.25];

/** Frames per decision. 90 is 1.5 s at 60 fps. */
export const ADAPT_WINDOW = 90;
/**
 * ...but close the window early on wall clock too, with this many frames as the
 * minimum sample. Without it a first-run Retina machine at 6 fps needs 15 s of
 * 6 fps to fill a 90-frame window before anything is done about it. The frame
 * floor only ever binds when the frame rate is under ~8 fps, where one miss in
 * twelve is not a false alarm, it is the frame rate.
 */
export const ADAPT_WINDOW_MS = 1500;
export const ADAPT_WINDOW_MIN_FRAMES = 12;
/** Frames skipped after a step: the reallocation frame plus its wake. */
export const ADAPT_SETTLE = 8;
/**
 * Boot grace, in MILLISECONDS not frames. Shader compilation is a wall-clock
 * cost, and a frame-counted grace period is unbounded in time exactly when the
 * frame rate is worst: 30 frames at the 3.4 fps a Retina panel boots at is nine
 * seconds, and a first attempt at this measured its first correction arriving
 * at t=21.9 s.
 */
export const ADAPT_BOOT_MS = 1200;
/**
 * Ceiling on one frame's contribution to the window clock, which doubles as the
 * mean period the descent step is sized from. Capping understates the load, so
 * the error is always in the direction of a smaller step.
 */
export const ADAPT_OUTLIER_MS = 250;
/**
 * A frame is on time if its period is within this multiple of the budget.
 *
 * 1.4 rather than 1.5 so the rule is right at every combination of target and
 * panel, since the period can only ever be a whole number of display intervals:
 *
 * | target | panel | threshold | hits | misses |
 * |---|---|---|---|---|
 * | 60 | 60 Hz | 23.3 | 16.7 | 33.3 |
 * | 60 | 120 Hz | 23.3 | 8.3, 16.7 | 25.0 |
 * | 30 | 60 Hz | 46.7 | 16.7, 33.3 | 50.0 |
 *
 * At 1.5 the third row would admit 50.0 ms — 20 fps counted as on time. The
 * second row is why `targetFps` 60 on a 120 Hz panel converges to a steady 60
 * rather than to a 60/120 judder. The same arithmetic is what makes the
 * relaxed target (`intervals` 2) exactly equivalent to `targetFps` 30 on a
 * 60 Hz panel — row three IS row one with the budget doubled.
 */
export const ADAPT_HIT_BUDGETS = 1.4;
/**
 * Below this share of on-time frames, resolution must come down. The 6% of
 * slack is also what absorbs an isolated GC or shader-compile hitch: five
 * misses in a 90-frame window still reads as healthy, so single stalls need no
 * special case.
 */
export const ADAPT_DROP_BELOW = 0.94;
/** At or above this share it may go back up. */
export const ADAPT_RAISE_ABOVE = 0.985;
/**
 * A reading between this and `ADAPT_DROP_BELOW` must be repeated before the
 * controller spends a reallocation on it.
 *
 * One window is 90 frames, so the on-time share it reports has a standard error
 * of `sqrt(p(1-p)/90)`: at a true share of 0.95 that is 2.3 points, and the
 * 0.94 threshold sits 0.4 sd away — a coin flip. At a true 0.85 it is 2.5 sd
 * away, which is not noise. So the confirm band covers exactly the region where
 * one window cannot tell, and a genuine overload (which reads far below it, 0.00
 * at the opening rung on a Retina panel) is still acted on immediately. Without
 * this the controller flaps across a marginal rung: simulated at 2.2 scale
 * changes per minute, each one a reallocation and a discarded TAA history.
 */
export const ADAPT_DROP_CONFIRM = 0.85;
/**
 * Windows of patience. Two things are paced by it:
 *
 *  - an UNTESTED rung is probed after `ADAPT_PROBE_HOLD` good windows, ~6 s;
 *  - a rung already PROVED to fail is not probed at all until that knowledge
 *    expires, after `probeHold` windows, which doubles on each proof up to the
 *    cap: 4, 8, 16, 32, 64, 128, 200 windows — a first retry at ~6 s and a
 *    steady state of one retry every five minutes.
 *
 * That distinction is the fix for the branch this replaces, where every
 * load-driven descent STEP also doubled the backoff. A four-step descent — what
 * happens whenever the pixel-cost model undershoots, i.e. whenever part of the
 * cost is not in the pixels — left 32 windows, 18-48 s, before the first
 * attempt to climb back, and it was observed over 16 s. It read as "descends
 * and never returns". A descent chain is ONE decision; its steps are not
 * independent failures, so only a failed probe doubles anything.
 *
 * The cap matters more than it looks. A probe that fails costs two
 * reallocations — measured at 100-475 ms each for a size not seen before — so a
 * controller that has learned its level and keeps retesting it is a hitch on a
 * timer.
 */
export const ADAPT_PROBE_HOLD = 4;
export const ADAPT_PROBE_HOLD_MAX = 200;
/**
 * Opening bid for the render scale, in megapixels of backing store.
 *
 * A first-run Retina machine at `ultra` opens at 3200x1800 = 5.76 Mpx, measured
 * at 0% of frames inside one vsync and a p50 90 ms period. The controller needs
 * a boot grace plus one window before it can act, so without this the first
 * seconds of the session — the title screen, which is what the owner reported
 * as worst — are the worst frames in it. This caps only the OPENING size; the
 * controller climbs straight back out if the machine can take it, and on a
 * dpr-1 1600x900 window (1.44 Mpx) it does nothing at all.
 *
 * 2 Mpx is about 1080p. It is not a performance target, it is a refusal to
 * guess high before anything has been measured.
 */
export const ADAPT_OPENING_MPX = 2;
/**
 * A descent step has to pay for itself: the new mean period must come in at or
 * below this fraction of the best the chain has seen, or the step is a strike.
 *
 * This is what stops the controller spending the whole ladder on a cost that is
 * not in the pixels. Measured at dpr 2 on this box, the noon scene at `ultra`
 * costs about 7.5 ms + 13 ms/Mpx: below ~0.5 Mpx the curve is flat, so rungs
 * 0.30 and 0.25 are indistinguishable and everything below 0.30 is resolution
 * thrown away for nothing.
 */
export const ADAPT_PAYOFF = 0.92;
/**
 * Consecutive non-paying steps before the descent gives up. Two, not one,
 * because under vsync a real improvement can hide inside one interval: a step
 * from 26 ms to 19.5 ms presents at 33.3 ms both times, and the step after it
 * crosses to 16.7. One strike would stop a descent two rungs short of the
 * answer; two lets it through the quantiser's blind spot.
 */
export const ADAPT_STRIKES = 2;
/**
 * The lowest frame rate the relaxed target may aim for. At `targetFps` 60 this
 * allows one relaxation, to 30 fps; below that a sailing game with a moving
 * camera is not worth the pixels it would buy.
 */
export const ADAPT_MIN_FPS = 30;
/**
 * Once the controller has established that pixels are not the bottleneck it
 * stops descending. It starts again if the mean period gets this much worse,
 * which is a genuinely different scene rather than the same one re-measured.
 */
export const ADAPT_RELAPSE = 1.25;

export interface AdaptState {
  /** Index into `SCALE_LADDER`. */
  level: number;
  /** Frames still to skip after a step (the reallocation and its wake). */
  settle: number;
  /** Boot grace remaining, ms. */
  bootMs: number;
  /** Display intervals a frame is allowed to take. 1 = hold `targetFps`. */
  intervals: number;
  frames: number;
  hits: number;
  tightHits: number;
  ms: number;
  /** Last closed window. */
  meanMs: number;
  hitRate: number;
  /** Windows to wait before probing an UNTESTED rung. */
  hold: number;
  /** Current backoff length; doubles each time a rung is proved to fail. */
  probeHold: number;
  /**
   * Highest index (lowest resolution) known to fail at the current target.
   * Cost rises with pixels, so a failure here implies every rung above it
   * fails too. -1 when nothing is known.
   */
  failLevel: number;
  /** Windows until `failLevel` is forgotten, so a cheaper scene is noticed. */
  failWait: number;
  /** Level an upward probe was launched from, i.e. the revert target. -1 idle. */
  raisedFrom: number;
  /** Descent chain: best mean period seen, and the level that achieved it. */
  chainMs: number;
  chainBest: number;
  chainActive: boolean;
  strikes: number;
  /** Mean period at which descending was abandoned; 0 = not abandoned. */
  stuck: number;
  /** Consecutive marginal-bad windows, for `ADAPT_DROP_CONFIRM`. */
  badWindows: number;
  windows: number;
  steps: number;
}

export function createAdaptState(level = 0): AdaptState {
  return {
    level,
    settle: 0,
    bootMs: ADAPT_BOOT_MS,
    intervals: 1,
    frames: 0,
    hits: 0,
    tightHits: 0,
    ms: 0,
    meanMs: 0,
    hitRate: 1,
    hold: ADAPT_PROBE_HOLD,
    probeHold: ADAPT_PROBE_HOLD,
    failLevel: -1,
    failWait: 0,
    raisedFrom: -1,
    chainMs: 0,
    chainBest: level,
    chainActive: false,
    strikes: 0,
    stuck: 0,
    badWindows: 0,
    windows: 0,
    steps: 0,
  };
}

/** Throw away the current decision window — used after any reallocation. */
export function resetAdaptWindow(st: AdaptState, settle = ADAPT_SETTLE): void {
  st.settle = settle;
  st.frames = 0;
  st.hits = 0;
  st.tightHits = 0;
  st.ms = 0;
}

/**
 * The opening bid: the first rung whose backing store is inside
 * `ADAPT_OPENING_MPX`. `devicePx` is the FULL-scale pixel count, i.e.
 * `cssW * cssH * min(devicePixelRatio, maxPixelRatio)^2`.
 */
export function seedOpeningLevel(devicePx: number): number {
  let level = 0;
  while (
    level + 1 < SCALE_LADDER.length &&
    devicePx * SCALE_LADDER[level] * SCALE_LADDER[level] > ADAPT_OPENING_MPX * 1e6
  ) {
    level++;
  }
  return level;
}

/**
 * Re-anchor on whatever `renderScale` actually is. The settings panel, a
 * quality preset or a probe may set it directly, and a controller that ignored
 * that would yank the picture back to its own idea of the level.
 *
 * Returns true when it snapped, in which case the caller must write
 * `SCALE_LADDER[level]` back. That write matters: a value off the ladder — a
 * persisted 0.62 from the clamp of the previous controller, say — would
 * otherwise mismatch on every single frame, and re-anchoring resets the descent
 * chain, so the controller could never assemble two windows of evidence.
 */
export function syncAdaptLevel(st: AdaptState, renderScale: number): boolean {
  if (Math.abs(SCALE_LADDER[st.level] - renderScale) <= 1e-4) return false;
  let best = 0;
  for (let i = 1; i < SCALE_LADDER.length; i++) {
    if (Math.abs(SCALE_LADDER[i] - renderScale) < Math.abs(SCALE_LADDER[best] - renderScale)) best = i;
  }
  st.level = best;
  st.chainActive = false;
  st.strikes = 0;
  st.badWindows = 0;
  st.raisedFrom = -1;
  st.failLevel = -1;
  st.failWait = 0;
  st.stuck = 0;
  return true;
}

/**
 * How far to come down is not a guess. The mean period, in units of the budget,
 * IS the load factor — a frame presenting every third vsync at a 60 fps target
 * is costing three budgets — and fragment cost is proportional to pixels, which
 * go as the square of the scale. So the scale that fits is
 * `current / sqrt(load)`, rounded DOWN to a rung.
 *
 * Measured at dpr 2 on this box: scale 1 has a mean period of ~5.4 budgets, so
 * sqrt(1/5.4) = 0.43 and the first move lands on 0.36 — two rungs from the 0.30
 * the fixed-scale sweep says is right, in one reallocation instead of the seven
 * the old EMA controller took to reach its clamp.
 *
 * Two known errors, both handled elsewhere. Quantisation reads a frame costing
 * 1.1 budgets as costing 2, so the step can be up to twice as large as needed —
 * the raise path recovers from that. And any cost that is NOT in the pixels
 * makes the model undershoot, so the descent takes more than one step — which
 * is what `ADAPT_PAYOFF` is there to stop from running to the ladder floor.
 *
 * Returns false when it is already at the floor and cannot move.
 */
function descend(st: AdaptState, budget: number): boolean {
  const prev = st.level;
  const load = Math.max(1, st.meanMs / (budget * st.intervals));
  const want = SCALE_LADDER[st.level] / Math.sqrt(load);
  let level = SCALE_LADDER.length - 1;
  for (let i = 0; i < SCALE_LADDER.length; i++) {
    if (SCALE_LADDER[i] <= want) {
      level = i;
      break;
    }
  }
  st.level = Math.min(SCALE_LADDER.length - 1, Math.max(st.level + 1, level));
  if (st.level === prev) return false;
  // Cost rises with pixels, so the rung we just left failing means every rung
  // above it fails too. Keep the strongest such bound, and hold that knowledge
  // for the current backoff — but do NOT double the backoff: a chain of steps
  // is one decision, and doubling per step is what buried the climb-back.
  st.failLevel = Math.max(st.failLevel, prev);
  st.failWait = Math.max(st.failWait, st.probeHold);
  // A big step skips rungs, and a skipped rung is untested, not known-bad. It
  // gets the base wait; the failure backoff only gates `failLevel` itself.
  st.hold = ADAPT_PROBE_HOLD;
  return true;
}

/** No rung held the target: give up frame rate rather than more pixels. */
function relaxOrStick(st: AdaptState, targetFps: number): void {
  st.level = st.chainBest;
  st.chainActive = false;
  st.strikes = 0;
  st.failLevel = -1;
  st.failWait = 0;
  st.raisedFrom = -1;
  st.hold = ADAPT_PROBE_HOLD;
  if (targetFps / (st.intervals + 1) >= ADAPT_MIN_FPS) {
    st.intervals++;
    st.stuck = 0;
    // The window that follows is judged against the looser budget, so any
    // backoff earned under the tighter one is stale.
    st.probeHold = ADAPT_PROBE_HOLD;
  } else {
    st.stuck = st.meanMs;
  }
}

/**
 * Feed one frame period. Returns true when `level` changed and the caller must
 * apply `SCALE_LADDER[state.level]`.
 */
export function adaptFrame(st: AdaptState, ms: number, targetFps: number): boolean {
  if (st.bootMs > 0) {
    st.bootMs -= ms;
    return false;
  }
  // The frame a reallocation lands on is the controller's own cost — 100-475 ms
  // for a size never used before, measured. Reading it as evidence about
  // resolution is how the previous controller talked itself down to its floor.
  if (st.settle > 0) {
    st.settle--;
    return false;
  }

  const budget = 1000 / Math.max(1, targetFps);
  st.frames++;
  st.ms += Math.min(ms, ADAPT_OUTLIER_MS);
  if (ms <= budget * st.intervals * ADAPT_HIT_BUDGETS) st.hits++;
  if (ms <= budget * ADAPT_HIT_BUDGETS) st.tightHits++;
  if (
    st.frames < ADAPT_WINDOW &&
    !(st.frames >= ADAPT_WINDOW_MIN_FRAMES && st.ms >= ADAPT_WINDOW_MS)
  ) {
    return false;
  }

  const rate = st.hits / st.frames;
  const tightRate = st.tightHits / st.frames;
  st.meanMs = st.ms / st.frames;
  st.hitRate = rate;
  st.frames = 0;
  st.hits = 0;
  st.tightHits = 0;
  st.ms = 0;
  st.windows++;
  // Failure knowledge expires, or a scene that became cheaper would never be
  // noticed: under vsync a rung that makes its interval reports the same period
  // whether it has 1 ms of headroom or 10.
  if (st.failWait > 0 && --st.failWait === 0) st.failLevel = -1;

  /*
   * Tightening the target back up is free — no reallocation, no TAA reset — so
   * it is always the first thing to try, and it cannot flap: it only fires when
   * the frames at THIS rung are already inside one interval, which is the same
   * condition that would keep it tight.
   */
  if (st.intervals > 1 && tightRate >= ADAPT_RAISE_ABOVE) {
    st.intervals = 1;
    st.failLevel = -1;
    st.failWait = 0;
    st.stuck = 0;
    st.chainActive = false;
    st.strikes = 0;
    st.hold = ADAPT_PROBE_HOLD;
    st.probeHold = ADAPT_PROBE_HOLD;
    return false;
  }

  const prev = st.level;

  if (rate < ADAPT_DROP_BELOW && rate >= ADAPT_DROP_CONFIRM && st.badWindows < 1) {
    // Marginal, and one window cannot tell. Ask for the same answer twice.
    st.badWindows++;
    return false;
  }
  // Either this window was good, or it is the second bad one and about to be
  // acted on. Either way the streak is spent.
  st.badWindows = 0;

  if (rate < ADAPT_DROP_BELOW) {
    if (st.raisedFrom >= 0) {
      /*
       * The rung we just probed does not hold, so go back to the one that did —
       * exactly, and not to wherever the load model below points. Quantisation
       * reads a frame costing 1.1 budgets as costing 2, so the model would
       * overshoot a rung on every failed probe, and a probe that costs a rung
       * ratchets downward forever.
       */
      st.failLevel = Math.max(st.failLevel, st.level);
      st.level = st.raisedFrom;
      st.raisedFrom = -1;
      st.chainActive = false;
      st.strikes = 0;
      st.hold = ADAPT_PROBE_HOLD;
      st.failWait = st.probeHold;
      st.probeHold = Math.min(ADAPT_PROBE_HOLD_MAX, st.probeHold * 2);
    } else if (st.stuck > 0 && st.meanMs <= st.stuck * ADAPT_RELAPSE) {
      // Established that pixels are not the bottleneck. Spending more of them
      // would buy nothing, and this is the same scene it was established in.
    } else if (!st.chainActive) {
      st.chainActive = true;
      st.chainMs = st.meanMs;
      st.chainBest = st.level;
      st.strikes = 0;
      if (!descend(st, budget)) relaxOrStick(st, targetFps);
    } else if (st.meanMs <= st.chainMs * ADAPT_PAYOFF) {
      // The previous step paid for itself. New reference, keep going.
      st.chainMs = st.meanMs;
      st.chainBest = st.level;
      st.strikes = 0;
      if (!descend(st, budget)) relaxOrStick(st, targetFps);
    } else {
      st.strikes++;
      if (st.strikes >= ADAPT_STRIKES || !descend(st, budget)) relaxOrStick(st, targetFps);
    }
  } else if (rate >= ADAPT_RAISE_ABOVE && st.level > 0) {
    // This rung holds. Everything the controller believed about failure at or
    // below it is contradicted by that.
    if (st.failLevel >= st.level) {
      // A rung believed to fail is holding, so the scene got cheaper. That is
      // the only evidence that justifies forgetting the accumulated backoff —
      // and the only place it may be reset, or the backoff never outgrows a
      // marginal rung that is retried forever.
      st.failLevel = -1;
      st.failWait = 0;
      st.probeHold = ADAPT_PROBE_HOLD;
    }
    st.chainActive = false;
    st.strikes = 0;
    st.stuck = 0;
    if (st.failLevel >= 0 && st.level - 1 <= st.failLevel) {
      // The rung above is known not to hold. Probing it would cost two
      // reallocations to learn nothing; wait for the knowledge to expire.
      st.raisedFrom = -1;
    } else if (st.hold > 0) {
      st.hold--;
      st.raisedFrom = -1;
    } else {
      st.raisedFrom = st.level;
      st.level--;
    }
  } else {
    /*
     * Inside the band: this level is the right one, and it is NOT evidence of
     * headroom — a rung that drops two frames in ninety is working exactly as
     * intended. So the climb counter goes back to the start: the probe above
     * needs `ADAPT_PROBE_HOLD` *consecutive* windows that dropped at most one
     * frame each, which is what separates real headroom from a marginal rung.
     *
     * At a true on-time share of 0.97 a window reads >= 0.985 about half the
     * time, so demanding four in a row makes a pointless probe of a marginal
     * rung roughly fifteen times rarer; at a true 1.0 every window qualifies
     * and the climb is as prompt as before. Simulated, this and the backoff
     * reset above took the steady state from 5.9 scale changes per minute to
     * under one, each of which is a reallocation and a discarded TAA history.
     */
    if (st.failLevel >= st.level) {
      st.failLevel = -1;
      st.failWait = 0;
    }
    st.chainActive = false;
    st.strikes = 0;
    st.stuck = 0;
    st.raisedFrom = -1;
    st.hold = ADAPT_PROBE_HOLD;
  }

  if (st.level !== prev) {
    st.settle = ADAPT_SETTLE;
    st.steps++;
    return true;
  }
  return false;
}
