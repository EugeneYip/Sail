import * as THREE from 'three';
import { DEG, angleDelta, gaussian, smoothstep, wrapTau } from '../util/math';
import { fbm1 } from './Noise';

/**
 * Wind direction and gust structure, layered at four clearly separated time
 * scales. Nothing here shares a time scale with anything else, which is what
 * stops it collapsing into one indistinguishable wobble.
 *
 *   1. SYNOPTIC   — the mean bearing. Only moves when a weather system passes.
 *                   A frontal passage veers it 25-70° (clockwise in the northern
 *                   hemisphere, anticlockwise in the southern — real, and quietly
 *                   felt when you have to re-trim) over 8-20 simulated minutes.
 *                   A non-frontal change wanders +/-18° over 40-90 minutes.
 *   2. MESOSCALE  — an Ornstein-Uhlenbeck random walk about that mean. Mean-
 *                   reverting, so it wanders without ever drifting away. Tau 90
 *                   simulated minutes; stationary std dev 5-14° depending on wind
 *                   strength (light air is shifty, a gale is steady — true, and
 *                   it makes light weather more interesting to sail).
 *   3. GUSTS      — 4-octave fBm with a 26 s base period, i.e. energy from ~3 s
 *                   to ~60 s, which is roughly the real over-water gust spectrum.
 *                   Coherent, not white. Skewed: gusts overshoot more than lulls
 *                   undershoot, as they do in reality.
 *   4. SQUALLS    — a Poisson process. 20-40 s, peaking at 1.45-1.75x, fast 4 s
 *                   attack and slower 10 s release, and a 12-28° veer while it
 *                   lasts.
 *
 * Layers 1 and 2 run on SIMULATED time so that "the wind backed through the
 * afternoon" is literally true. Layers 3 and 4 run on REAL time, deliberately:
 * they are felt through the ship's heel, and at a 60x clock a "30 second squall"
 * would last half a real second and be violent nonsense. This is the one place
 * the director knowingly breaks its own single-clock rule.
 */

const TAU_OU_S = 90 * 60;
const GUST_BASE_PERIOD_S = 26;
const GUST_SEED = 0x9e37;
/** Peak fast veer coupled to the gust signal — a gust usually veers. */
const GUST_VEER_MAX = 3.5 * DEG;

const SQUALL_MIN_S = 20;
const SQUALL_MAX_S = 40;
const SQUALL_ATTACK_S = 4;
const SQUALL_RELEASE_S = 10;
const SQUALL_PEAK_MIN = 1.45;
const SQUALL_PEAK_MAX = 1.75;
const SQUALL_VEER_MIN = 12 * DEG;
const SQUALL_VEER_MAX = 28 * DEG;

/** Hard safety rails so nothing downstream can ever see a silly multiplier. */
export const GUST_MIN = 0.65;
export const GUST_MAX = 1.85;

const FRONTAL_VEER_MIN = 25 * DEG;
const FRONTAL_VEER_MAX = 70 * DEG;
const FRONTAL_RAMP_MIN_S = 8 * 60;
const FRONTAL_RAMP_MAX_S = 20 * 60;
const SLOW_SHIFT_MAX = 18 * DEG;
const SLOW_RAMP_MIN_S = 40 * 60;
const SLOW_RAMP_MAX_S = 90 * 60;

export class WindField {
  /** Synoptic mean, radians (bearing the wind comes from). */
  meanBearing = 0;
  /** Published bearing: mean + wander + fast veer + squall veer. */
  bearing = 0;
  /** Gust multiplier on `windSpeed`. */
  gust = 1;
  /** 0..1 squall envelope, for VFX/audio to hook if they want. */
  squallEnvelope = 0;
  /** Signed fBm gust signal in ~[-1, 1] — reused for the fast veer. */
  gustSignal = 0;

  private ouOffset = 0;
  private targetMean = 0;
  private rampRate = 3 / SLOW_RAMP_MIN_S;
  private gustTime = 0;
  private squallT = -1;
  private squallDuration = 0;
  private squallPeak = 1;
  private squallVeer = 0;

  reset(bearing: number): void {
    this.meanBearing = wrapTau(bearing);
    this.targetMean = this.meanBearing;
    this.bearing = this.meanBearing;
    this.ouOffset = 0;
  }

  /** Adopt an externally forced bearing without losing the gust texture. */
  setBearing(bearing: number): void {
    const b = wrapTau(bearing);
    this.meanBearing = wrapTau(b - this.ouOffset - this.fastVeer());
    this.targetMean = this.meanBearing;
    this.bearing = b;
  }

  private fastVeer(): number {
    return GUST_VEER_MAX * this.gustSignal + this.squallVeer * this.squallEnvelope;
  }

  /**
   * Queue a synoptic shift. `hemisphereSign` is +1 north of the equator, -1
   * south, so fronts veer the correct way in both.
   */
  shift(frontal: boolean, hemisphereSign: number, rng: () => number): void {
    let delta: number;
    if (frontal) {
      delta =
        hemisphereSign * (FRONTAL_VEER_MIN + rng() * (FRONTAL_VEER_MAX - FRONTAL_VEER_MIN));
      this.rampRate = 3 / (FRONTAL_RAMP_MIN_S + rng() * (FRONTAL_RAMP_MAX_S - FRONTAL_RAMP_MIN_S));
    } else {
      delta = (rng() * 2 - 1) * SLOW_SHIFT_MAX;
      this.rampRate = 3 / (SLOW_RAMP_MIN_S + rng() * (SLOW_RAMP_MAX_S - SLOW_RAMP_MIN_S));
    }
    this.targetMean = wrapTau(this.targetMean + delta);
  }

  /**
   * @param dt        real seconds
   * @param simDt     simulated seconds
   * @param freezeDir true while `windBearing` is pinned
   */
  update(
    dt: number,
    simDt: number,
    gustiness: number,
    squallsPerMinute: number,
    wanderDeg: number,
    hemisphereSign: number,
    freezeDir: boolean,
    rng: () => number,
  ): void {
    // --- 1. synoptic mean
    if (simDt > 0) {
      this.meanBearing = wrapTau(
        this.meanBearing +
          angleDelta(this.meanBearing, this.targetMean) * (1 - Math.exp(-this.rampRate * simDt)),
      );

      // --- 2. mesoscale Ornstein-Uhlenbeck walk
      const k = 1 / TAU_OU_S;
      const std = wanderDeg * DEG;
      const sigma = std * Math.sqrt(2 * k);
      this.ouOffset += -k * this.ouOffset * simDt + sigma * Math.sqrt(simDt) * gaussian(rng);
      // A hard rail: three sigma is already a very odd shift.
      this.ouOffset = THREE.MathUtils.clamp(this.ouOffset, -3 * std, 3 * std);
    }

    // --- 4. squalls (real time — see the module note)
    if (this.squallT < 0) {
      if (squallsPerMinute > 0 && rng() < (squallsPerMinute / 60) * dt) {
        this.squallT = 0;
        this.squallDuration = SQUALL_MIN_S + rng() * (SQUALL_MAX_S - SQUALL_MIN_S);
        this.squallPeak = SQUALL_PEAK_MIN + rng() * (SQUALL_PEAK_MAX - SQUALL_PEAK_MIN);
        this.squallVeer =
          hemisphereSign * (SQUALL_VEER_MIN + rng() * (SQUALL_VEER_MAX - SQUALL_VEER_MIN));
      }
    } else {
      this.squallT += dt;
      if (this.squallT >= this.squallDuration) {
        this.squallT = -1;
        this.squallVeer = 0;
      }
    }
    if (this.squallT >= 0) {
      const d = this.squallDuration;
      this.squallEnvelope =
        smoothstep(0, SQUALL_ATTACK_S, this.squallT) *
        (1 - smoothstep(d - SQUALL_RELEASE_S, d, this.squallT));
    } else {
      this.squallEnvelope = 0;
    }

    // --- 3. gusts (real time)
    this.gustTime += dt;
    const g = fbm1(this.gustTime / GUST_BASE_PERIOD_S, GUST_SEED);
    this.gustSignal = g;
    // Turbulence intensity over open water: ~6% in a smooth light air, ~17% in a
    // convective gale. Lulls are shallower than gusts, so the signal is skewed.
    const ti = 0.06 + 0.11 * THREE.MathUtils.clamp(gustiness, 0, 1);
    const base = 1 + ti * 2 * (g > 0 ? g : g * 0.6);
    const peak = this.squallPeak * (1 + 0.06 * g);
    this.gust = THREE.MathUtils.clamp(
      base + (peak - base) * this.squallEnvelope,
      GUST_MIN,
      GUST_MAX,
    );

    if (!freezeDir) {
      this.bearing = wrapTau(this.meanBearing + this.ouOffset + this.fastVeer());
    }
  }
}
