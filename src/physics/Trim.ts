import * as THREE from 'three';
import type { InputState, SailState } from '../types';
import { clamp01, damp, smoothstep } from '../util/math';
import { ASSIST_BIAS_DECAY_TIME, ASSIST_HAND_RATE } from './Assist';
import {
  BRACE_MAX,
  BRACE_SLEW_TIME,
  REEF_HEEL,
  REEF_PANIC_HEEL,
  SAIL_LEVEL_TIME,
  SAIL_SLEW_TIME,
  SHEET_GAIN,
  SHEET_MAX,
  SHEET_SLEW_TIME,
} from './constants';
import {
  sailCoefficients,
  targetIncidence,
  braceSolutions,
  geometryFor,
  luffTarget,
  type Coefficients,
} from './Rig';

/**
 * The watch on deck: how much canvas is set, and where the yards are braced.
 *
 * This is the only part of the ship that is not a differential equation, and it
 * is deliberately a slow one. Everything here is rate-limited in real seconds —
 * a wheel takes 4.5 s to put over, a yard 12 s to come round against the
 * shrouds, a sail 9 s to set or furl, and a full press of canvas 18 s to get
 * aloft. That lag is most of what makes a square-rigger feel like 2200 tonnes
 * rather than a dinghy: you commit to a manoeuvre long before it happens.
 *
 * TRIM POLICY. The yards are trimmed for maximum drive by solving, per sail,
 * for the brace angle that puts it at just under its stall incidence to the
 * apparent wind, and picking whichever of the candidate angles actually pushes
 * the ship forward once clamped to the shrouds. That is what a competent watch
 * does, and it means the player is not obliged to micro-trim sixteen sails.
 * `input.brace` adds a bias on top which decays back to zero over ~25 s, so Q/E
 * gives immediate manual authority (you can deliberately back the yards to box
 * her head round) and the watch gradually recovers the best trim afterwards.
 */

/**
 * Order canvas is taken in, first to last. Royals and topgallants come in
 * first — they are the highest and least efficient, and they contribute the
 * largest heeling moment per square metre. What is left at the end is storm
 * canvas: fore topmast staysail, close-reefed fore and main topsails, and the
 * spanker to keep her head from falling off.
 */
const FURL_ORDER = [
  'main-royal',
  'fore-royal',
  'mizzen-royal',
  'flying-jib',
  'main-topgallant',
  'fore-topgallant',
  'mizzen-topgallant',
  'outer-jib',
  'main-course',
  'mizzen-topsail',
  'fore-course',
  'inner-jib',
  'spanker',
  'main-topsail',
  'fore-topsail',
  'fore-staysail',
];

/** Seconds for the player's brace bias to be trimmed out by the watch. */
const BIAS_DECAY_TIME = 25;
/**
 * How hard the watch shortens sail when she is over-pressed, in sails per
 * second at full panic. A ship is not sailed to her capsize angle; this is what
 * keeps the gale scene on her feet instead of knocked flat, and it is why heel
 * plateaus near 25-30 deg however hard it blows.
 */
const REEF_RATE = 1.4;
/** ...and how slowly canvas goes back up once she is easy again. */
const RESET_RATE = 0.12;
/**
 * Canvas the watch will not go below on account of the helm: fore topmast
 * staysail, close-reefed fore and main topsails, and the spanker. A ship needs
 * that much to steer at all, and scudding under bare poles is a decision, not
 * something the watch does by itself.
 */
const STORM_CANVAS = 4;
/**
 * Yaw rate, rad/s, between which the watch decides she IS answering her helm
 * and a pinned rudder therefore means nothing. 0.8 to 2.0 deg/s.
 *
 * MEASURED. A Pro ship with the after sails carrying her head to wind holds
 * 0.40 deg/s with the wheel hard over, and a Pro ship being held on a heading in
 * a gale holds 0.0 — both are "she will not steer" and both must still shorten
 * sail. An assisted turn runs at 4.7 deg/s at cruising speed and 1.9 deg/s at
 * 6 kn, so the same rudder there is a player turning, not a ship in trouble.
 */
const ANSWERING_LO = 0.8 * (Math.PI / 180);
const ANSWERING_HI = 2.0 * (Math.PI / 180);
/** Seconds of low-pass on the yaw rate, so one wave cannot cancel a reef. */
const ANSWERING_SMOOTH_TIME = 1.5;
/**
 * Below this a trim command is no hand on the key at all. `input.sailTrim` is an
 * exponential approach and `Input.ts` snaps its last 1e-4, but nothing here
 * should depend on another module's epsilon.
 */
const TRIM_DEADBAND = 1e-3;
/** Must match SHROUD_FOUL in Aero.ts — the watch and the wind see one rig. */
const SHROUD_FOUL_TRIM = 0.45;

const coeff: Coefficients = { cl: 0, cd: 0 };
const roots = new THREE.Vector2();

export class SailTrim {
  /** Rank in the setting order: 0 is set first (and furled last). */
  private setRank!: Int32Array;
  /** Aspect ratio per sail, cached from the rig geometry. */
  private ar!: Float64Array;
  /** Target brace angle per sail, radians of yard rotation (not sheet units). */
  private braceTarget!: Float64Array;
  private count = 0;

  /**
   * Canvas the player has ordered, in units of sails. 0 = bare poles,
   * `count` = a full press.
   */
  ordered = 0;
  /**
   * What the watch will actually carry: lowered when she is over-pressed,
   * recovering toward `ordered` once she is easy again. Kept separate so
   * shortening sail is not silently undone a minute later, and so an order to
   * reef is never overridden by the weather easing.
   */
  cap = 0;
  /** Player brace offset, radians, decaying back to the watch's trim. */
  bias = 0;
  /**
   * Low-passed rate at which she is coming round the way the wheel is asking,
   * rad/s, negative when she is going the other way. Lagged state: it decides
   * whether a rudder held hard over means she will not steer, or simply that the
   * player is turning.
   */
  private answerRate = 0;
  /**
   * Assist mode: the watch works the ship `ASSIST_HAND_RATE` times faster.
   * Every rate below is still rate-limited in real seconds — a yard still takes
   * 4 s to come round rather than snapping — so the rig visibly works. What
   * goes is the half-minute of dead time between an order and anything
   * happening, which is lag the player experiences as the ship ignoring them.
   */
  assist = false;

  /**
   * Drop any player bias and brace every yard straight to the trim this
   * apparent wind calls for, with no slew. Only the LAGGED state is touched;
   * `ordered`, `cap` and each sail's `set` are the caller's, because
   * `physics-test.mjs` sets them either side of a reset.
   *
   * This exists for test isolation. `run()` is supposed to be a pure function of
   * (pose, rig, weather, dt), and it was not: the yards carried over from
   * whatever the previous scenario left them at, so the first `run()` after a
   * different scenario answered differently from the second. That read as a
   * frame-rate-independence failure and was not one.
   *
   * Braced to the SOLVED angle rather than squared, because squaring them is not
   * a neutral starting state — it is a badly trimmed ship, and in 24 m/s of wind
   * the heel spike off a square rig makes the watch shorten sail before the
   * measurement has even begun.
   */
  reset(sails: SailState[], wx: number, wz: number, windSpeed: number): void {
    this.bias = 0;
    this.answerRate = 0;
    for (let i = 0; i < this.count; i++) {
      const target = windSpeed > 0.4 ? this.solveBrace(sails[i], i, wx, wz) : 0;
      this.braceTarget[i] = target;
      sails[i].brace = sails[i].triangular ? target / SHEET_GAIN : target;
    }
  }

  get level(): number {
    return Math.min(this.ordered, this.cap);
  }

  set level(v: number) {
    this.ordered = v;
    this.cap = v;
  }

  init(sails: SailState[]): void {
    this.count = sails.length;
    this.setRank = new Int32Array(this.count);
    this.ar = new Float64Array(this.count);
    this.braceTarget = new Float64Array(this.count);
    const n = this.count;
    for (let i = 0; i < n; i++) {
      const furl = FURL_ORDER.indexOf(sails[i].id);
      // Unknown ids sit in the middle of the order rather than at an extreme.
      this.setRank[i] = furl < 0 ? (n >> 1) : n - 1 - furl;
      this.ar[i] = geometryFor(sails[i]).ar;
    }
    this.level = n;
  }

  /**
   * One frame of sail handling. `wx`/`wz` are the apparent wind's direction of
   * travel in the ship's body XZ plane; `heel` decides whether the watch starts
   * letting fly on its own; `yawRate` is the body yaw rate in rad/s, which is how
   * the watch tells a ship that will not steer from a player putting the wheel
   * over on purpose.
   */
  update(
    sails: SailState[],
    input: InputState,
    wx: number,
    wz: number,
    windSpeed: number,
    heel: number,
    rudderFrac: number,
    yawRate: number,
    dt: number,
  ): void {
    const n = this.count;

    /* --- how much canvas ------------------------------------------------- */
    const hand = this.assist ? ASSIST_HAND_RATE : 1;
    const raw = THREE.MathUtils.clamp(input.sailTrim, -1, 1);
    const cmd = Math.abs(raw) > TRIM_DEADBAND ? raw : 0;
    this.ordered = THREE.MathUtils.clamp(
      this.ordered + cmd * ((n * hand) / SAIL_LEVEL_TIME) * dt,
      0,
      n,
    );
    if (cmd !== 0) this.cap = Math.max(this.cap, this.ordered);

    // The watch shortens sail when she is over-pressed and shakes it out again
    // once she is easy. Emergent reefing: nobody scripts the storm, and nobody
    // overrides an order to reef either.
    const over = clamp01((Math.abs(heel) - REEF_HEEL) / (REEF_PANIC_HEEL - REEF_HEEL));
    // ...and when she will not steer. A rudder held near hard over means the
    // after sails are carrying her head to wind faster than the helm can hold
    // it; taking in canvas is what relieves the helm. This is the difference
    // between shortening sail before she is in trouble and broaching.
    // Only down to storm canvas: below that there is nothing left to take in
    // that would help, and under bare poles she cannot steer at all — so a rule
    // keyed on the rudder would strike every sail and then keep insisting.
    //
    // AND ONLY IF SHE IS NOT ANSWERING. The rudder alone cannot tell the two
    // cases apart, and in assist the player turns by HOLDING the arrow key, so
    // the wheel sits at hard over for the whole turn. Measured before this gate
    // existed: 25 s on the left arrow took the rig from 16 sails to storm canvas
    // and cost 5.5 kn, then needed 100 s at RESET_RATE to shake out again — the
    // watch sabotaging every turn the player asked for. A ship coming round at
    // 4.7 deg/s is not overpowered; one at 0.4 deg/s with the wheel hard over is.
    //
    // SIGNED, not just fast. Positive rudder is a turn to starboard and heading
    // rate is -wby, so she is answering at -sign(rudder)*yawRate. A broach — the
    // wheel hard over one way and her head going the other — comes out negative
    // and the rule still fires, which is the case it was written for.
    //
    // ASSIST ONLY, and that is a deliberate retreat from a better rule. Gating
    // the rule in Pro as well is more honest — Pro's 0.41 deg/s with the wheel
    // hard over reads as "will not steer" either way — but it is not free:
    // measured, it moved the heading she holds at 24 m/s from 84 to 86 deg and
    // the determinism case from 174.21 to 175.93, and that 2 deg of trajectory
    // was enough to walk the floating-origin case from 4069 m to 4162 m and fail
    // it. Pro is the calibrated ship and its numbers are a fixed point, so the
    // gate stops at the mode that needs it. In Pro `answering` is exactly zero
    // and this whole block reduces to what it was.
    this.answerRate = damp(
      this.answerRate,
      -Math.sign(rudderFrac) * yawRate,
      1 / ANSWERING_SMOOTH_TIME,
      dt,
    );
    const answering = this.assist
      ? smoothstep(ANSWERING_LO, ANSWERING_HI, this.answerRate)
      : 0;
    const pinned =
      this.cap > STORM_CANVAS
        ? clamp01((Math.abs(rudderFrac) - 0.7) / 0.3) * (1 - answering)
        : 0;
    const shorten = Math.max(over, pinned * 0.8);
    if (shorten > 0) this.cap -= shorten * REEF_RATE * dt;
    else if (Math.abs(heel) < REEF_HEEL * 0.7) this.cap += RESET_RATE * dt;
    this.cap = THREE.MathUtils.clamp(this.cap, 0, n);

    const level = this.level;
    const setRate = (dt * hand) / SAIL_SLEW_TIME;
    for (let i = 0; i < n; i++) {
      const want = clamp01(level - this.setRank[i]);
      const s = sails[i];
      const d = want - s.set;
      s.set = Math.abs(d) <= setRate ? want : s.set + Math.sign(d) * setRate;
    }

    /* --- where the yards go ---------------------------------------------- */
    this.bias +=
      THREE.MathUtils.clamp(input.brace, -1, 1) * ((BRACE_MAX * hand) / BRACE_SLEW_TIME) * dt;
    this.bias -= (this.bias * dt) / (this.assist ? ASSIST_BIAS_DECAY_TIME : BIAS_DECAY_TIME);
    this.bias = THREE.MathUtils.clamp(this.bias, -BRACE_MAX, BRACE_MAX);

    // Below this there is no wind to trim to; hold what we have.
    if (windSpeed > 0.4) {
      for (let i = 0; i < n; i++) this.braceTarget[i] = this.solveBrace(sails[i], i, wx, wz);
    }

    const braceRate = ((BRACE_MAX * hand) / BRACE_SLEW_TIME) * dt;
    const sheetRate = ((SHEET_MAX * hand) / SHEET_GAIN / SHEET_SLEW_TIME) * dt;
    for (let i = 0; i < n; i++) {
      const s = sails[i];
      const rate = s.triangular ? sheetRate : braceRate;
      const want = s.triangular ? this.braceTarget[i] / SHEET_GAIN : this.braceTarget[i];
      const d = want - s.brace;
      s.brace = Math.abs(d) <= rate ? want : s.brace + Math.sign(d) * rate;
    }
  }

  /**
   * Brace (or sheet) angle for one sail, in yard-rotation radians.
   *
   * `braceSolutions` gives the two angles that put the sail at its target
   * incidence to the apparent wind — one for each tack. A yard braced to `b` and
   * to `b - 180` is the same physical yard with the sail's two faces swapped, so
   * each root contributes two candidates and only one of the pair may fall
   * inside the shrouds: missing that is the difference between a rig that draws
   * on a reach and one that hangs there edge-on. Square and hard-against-the-
   * shrouds are candidates too, because running dead before the wind the
   * incidence solution is unreachable and the right answer is a squared yard
   * working as a pure drag device.
   *
   * Whichever candidate generates the most forward force wins. That single rule
   * reproduces sharp braces close-hauled, square yards running, and a rig that
   * stops dead if you put her head to wind.
   */
  private solveBrace(sail: SailState, i: number, wx: number, wz: number): number {
    const ar = this.ar[i];
    const tri = sail.triangular;
    // A fore-and-aft sail's normal is 90 deg round from a yard's, so the same
    // solver serves both: solve in yard space, then shift.
    const shift = tri ? -Math.PI / 2 : 0;
    const limit = tri ? SHEET_MAX : BRACE_MAX;
    const bias = tri ? 0 : this.bias;

    braceSolutions(wx, wz, targetIncidence(ar), roots);

    let best = 0;
    let bestThrust = -Infinity;
    for (let k = 0; k < 6; k++) {
      let b: number;
      if (k === 0) b = wrap(roots.x + shift) + bias;
      else if (k === 1) b = wrap(roots.x + shift + Math.PI) + bias;
      else if (k === 2) b = wrap(roots.y + shift) + bias;
      else if (k === 3) b = wrap(roots.y + shift + Math.PI) + bias;
      else if (k === 4) b = limit;
      else b = -limit;
      b = THREE.MathUtils.clamp(b, -limit, limit);
      const thrust = drive(b, tri, ar, wx, wz);
      if (thrust > bestThrust) {
        bestThrust = thrust;
        best = b;
      }
    }
    return best;
  }
}

function wrap(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/**
 * Forward force coefficient a sail would generate at brace angle `b`. Same
 * lift/drag decomposition as `RigAero.solve`, evaluated per unit dynamic
 * pressure and area — only the ordering of the candidates matters.
 */
function drive(b: number, tri: boolean, ar: number, wx: number, wz: number): number {
  const nx = tri ? Math.cos(b) : Math.sin(b);
  const nz = tri ? -Math.sin(b) : Math.cos(b);
  const dot = THREE.MathUtils.clamp(wx * nx + wz * nz, -1, 1);
  const alpha = Math.asin(Math.abs(dot));
  sailCoefficients(alpha, ar, tri, coeff);
  // Charge the candidate for shivering, the same way `RigAero` does, or the
  // watch happily trims a sail to an incidence at which it cannot hold shape.
  const draw = 1 - luffTarget(alpha, 0, tri);
  // Same shroud-fouling penalty RigAero applies, or the watch braces right up
  // against the rigging chasing lift that is not there.
  const foul = tri ? 1 : 1 - SHROUD_FOUL_TRIM * smoothstep(0.6 * BRACE_MAX, BRACE_MAX, Math.abs(b));
  let lx = nx - dot * wx;
  let lz = nz - dot * wz;
  const ll = Math.sqrt(lx * lx + lz * lz);
  if (ll > 1e-6) {
    lx /= ll;
    lz /= ll;
  } else {
    lx = 0;
    lz = 0;
  }
  const sgn = dot >= 0 ? 1 : -1;
  // Forward is -Z. Charge the candidate for the side force it makes as well:
  // drive bought with enormous heeling moment is not drive a crew would take.
  const fz = coeff.cl * draw * foul * sgn * lz + coeff.cd * wz;
  const fx = coeff.cl * draw * foul * sgn * lx + coeff.cd * wx;
  return -fz - 0.06 * Math.abs(fx);
}
