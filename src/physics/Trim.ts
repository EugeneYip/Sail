import * as THREE from 'three';
import type { InputState, SailState } from '../types';
import { clamp01, smoothstep } from '../util/math';
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
   * letting fly on its own.
   */
  update(
    sails: SailState[],
    input: InputState,
    wx: number,
    wz: number,
    windSpeed: number,
    heel: number,
    rudderFrac: number,
    dt: number,
  ): void {
    const n = this.count;

    /* --- how much canvas ------------------------------------------------- */
    const cmd = THREE.MathUtils.clamp(input.sailTrim, -1, 1);
    this.ordered = THREE.MathUtils.clamp(this.ordered + cmd * (n / SAIL_LEVEL_TIME) * dt, 0, n);
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
    const pinned = this.cap > STORM_CANVAS ? clamp01((Math.abs(rudderFrac) - 0.7) / 0.3) : 0;
    const shorten = Math.max(over, pinned * 0.8);
    if (shorten > 0) this.cap -= shorten * REEF_RATE * dt;
    else if (Math.abs(heel) < REEF_HEEL * 0.7) this.cap += RESET_RATE * dt;
    this.cap = THREE.MathUtils.clamp(this.cap, 0, n);

    const level = this.level;
    const setRate = dt / SAIL_SLEW_TIME;
    for (let i = 0; i < n; i++) {
      const want = clamp01(level - this.setRank[i]);
      const s = sails[i];
      const d = want - s.set;
      s.set = Math.abs(d) <= setRate ? want : s.set + Math.sign(d) * setRate;
    }

    /* --- where the yards go ---------------------------------------------- */
    this.bias += THREE.MathUtils.clamp(input.brace, -1, 1) * (BRACE_MAX / BRACE_SLEW_TIME) * dt;
    this.bias -= (this.bias * dt) / BIAS_DECAY_TIME;
    this.bias = THREE.MathUtils.clamp(this.bias, -BRACE_MAX, BRACE_MAX);

    // Below this there is no wind to trim to; hold what we have.
    if (windSpeed > 0.4) {
      for (let i = 0; i < n; i++) this.braceTarget[i] = this.solveBrace(sails[i], i, wx, wz);
    }

    const braceRate = (BRACE_MAX / BRACE_SLEW_TIME) * dt;
    const sheetRate = (SHEET_MAX / SHEET_GAIN / SHEET_SLEW_TIME) * dt;
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
