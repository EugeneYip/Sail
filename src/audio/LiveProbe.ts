import { ClickWatcher, type LeadSweepRow, type WatchStats } from './ClickProbe';
import { LEAD_S, observeLead, schedule } from './Context';
import { makeSim, resolveMute, step, type ProbeOptions } from './Probe';
import { Rig } from './Rig';

/**
 * The acceptance test, on a REAL audio thread.
 *
 * `Probe.renderProbe` is deterministic and fast and structurally cannot see the
 * defect the owner reports: in an `OfflineAudioContext` nothing has been
 * rendered when the driving loop runs, so no event can land in the past and no
 * ramp can collapse. Only a live `AudioContext` has a thread that is already
 * some way ahead of `currentTime`.
 *
 * The other half of the condition is a stalling main thread. On the title screen
 * `dt` averages 63.8 ms and every value is an exact multiple of 16.67 ms
 * (DIAGNOSIS.md §32), so a frame arriving 80-150 ms late is the NORMAL case
 * there, not an exception — and that is where the owner hears it worst.
 *
 * This builds the rig against a live context and drives it from a real timer
 * loop, so it reproduces both halves. It deliberately does NOT go through the
 * game: `world.ext.audio` needs the engine, the dev server and the other five
 * subsystems to boot, and the audio module must be measurable when any of them
 * is broken. The scene comes from the same `ProbeOptions` the offline render
 * uses, so the two are directly comparable.
 */
export interface LiveProbeOptions extends ProbeOptions {
  /**
   * Block the main thread for `ms` every `everyMs` of wall clock, by spinning —
   * a real hitch is compute, not sleep, so `requestAnimationFrame` and the frame
   * loop are both denied the thread exactly as they would be.
   */
  stall?: { ms: number; everyMs: number };
  /** Leads to price against this device, seconds. See `ClickWatcher.inject`. */
  leads?: number[];
  /** Envelopes injected per lead. */
  injectCount?: number;
}

export interface LiveProbeResult {
  watch: WatchStats | null;
  /** Frames the driving loop actually served. */
  frames: number;
  meanDtMs: number;
  maxDtMs: number;
  /** Main-thread cost of `rig.update`, mean and worst, ms. Budget is 1.5 ms. */
  costMeanMs: number;
  costMaxMs: number;
  stalls: number;
  blockedMs: number;
  wallSeconds: number;
  /** Populated when `leads` was given. */
  leadSweep: LeadSweepRow[];
  /** `Context.schedule` — events the backstop had to push forward. Must be 0. */
  late: number;
  worstLeadS: number;
  /** What this device's render-ahead actually demands of LEAD_S. */
  needLeadS: number;
  renderQuantumS: number;
  frameGapS: number;
  shortfall: number;
  leadS: number;
  baseLatencyS: number;
  outputLatencyS: number;
  sampleRate: number;
  liveNodes: number;
  createdNodes: number;
  usesWorklet: boolean;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Build the rig live, drive it for `seconds`, and report what the per-sample
 * detector on the master heard.
 *
 * The caller owns nothing: the context is closed on the way out, so a harness
 * can run a dozen scenes in one page without accumulating audio threads.
 */
export async function liveProbe(opts: LiveProbeOptions = {}): Promise<LiveProbeResult> {
  const seconds = opts.seconds ?? 12;
  const fps = opts.fps ?? 60;
  const warmup = opts.warmup ?? 2;

  const ctx = new AudioContext({ latencyHint: 'interactive' });
  if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined);
  const rig = await Rig.build(ctx, {
    analyser: false,
    mute: resolveMute(opts),
    voiceScale: opts.voiceScale ?? 1,
  });
  const watcher = await ClickWatcher.attach(ctx, rig.mixer.out);

  const late0 = schedule.late;
  const shortfall0 = schedule.shortfall;
  const sim = makeSim(opts);
  let frames = 0;
  let costSum = 0;
  let costMax = 0;
  let dtSum = 0;
  let dtMax = 0;
  let stalls = 0;
  let blocked = 0;
  let lastCtx = 0;
  let lastWall = performance.now();
  let nextStall = opts.stall ? lastWall + opts.stall.everyMs : Infinity;

  // Warm up before the detector's window opens, so the first frames — which
  // legitimately move every parameter from its build value to its scene value —
  // are not counted as the mix clicking.
  const t0 = performance.now();
  const warmEnd = t0 + warmup * 1000;
  const end = t0 + (seconds + warmup) * 1000;
  let armed = false;

  for (;;) {
    const wall = performance.now();
    if (wall >= end) break;
    if (!armed && wall >= warmEnd) {
      armed = true;
      await watcher?.stats(true);
    }

    const elapsed = (wall - t0) / 1000;
    step(sim, opts, elapsed, seconds + warmup);
    const dtMs = wall - lastWall;
    lastWall = wall;
    sim.dt = Math.max(1 / fps, dtMs / 1000);
    if (armed) {
      dtSum += dtMs;
      dtMax = Math.max(dtMax, dtMs);
    }

    const c0 = performance.now();
    const now = ctx.currentTime;
    observeLead(ctx.baseLatency, lastCtx > 0 ? now - lastCtx : 0);
    lastCtx = now;
    rig.update(sim, now);
    const cost = performance.now() - c0;
    if (armed) {
      costSum += cost;
      costMax = Math.max(costMax, cost);
      frames++;
    }

    if (opts.stall && wall >= nextStall) {
      // Spin, do not sleep: the frame loop must be genuinely denied the thread.
      const ms = opts.stall.ms;
      const until = performance.now() + ms;
      while (performance.now() < until) {
        /* burn */
      }
      if (armed) {
        stalls++;
        blocked += ms;
      }
      nextStall = performance.now() + opts.stall.everyMs;
    }

    await sleep(Math.max(0, 1000 / fps - (performance.now() - wall)));
  }

  // Let the thread render what is already scheduled before reading counters.
  await sleep(250);
  const watch = (await watcher?.stats(false)) ?? null;

  const leadSweep: LeadSweepRow[] = [];
  if (opts.leads && watcher) {
    for (const leadS of opts.leads) {
      await watcher.stats(true);
      leadSweep.push(await watcher.inject({ leadS, count: opts.injectCount ?? 6 }));
    }
  }

  const out: LiveProbeResult = {
    watch,
    frames,
    meanDtMs: frames > 0 ? dtSum / frames : 0,
    maxDtMs: dtMax,
    costMeanMs: frames > 0 ? costSum / frames : 0,
    costMaxMs: costMax,
    stalls,
    blockedMs: blocked,
    wallSeconds: (performance.now() - t0) / 1000,
    leadSweep,
    late: schedule.late - late0,
    worstLeadS: schedule.worstLeadS,
    needLeadS: schedule.needLeadS,
    renderQuantumS: schedule.renderQuantumS,
    frameGapS: schedule.frameGapS,
    shortfall: schedule.shortfall - shortfall0,
    leadS: LEAD_S,
    baseLatencyS: ctx.baseLatency,
    outputLatencyS: ctx.outputLatency,
    sampleRate: ctx.sampleRate,
    liveNodes: rig.nodes.live,
    createdNodes: rig.nodes.created,
    usesWorklet: rig.usesWorklet,
  };

  watcher?.detach();
  rig.dispose();
  await ctx.close().catch(() => undefined);
  return out;
}
