import { clamp01, damp } from '../util/math';

/**
 * Deterministic gradient (Perlin) noise in 1D plus the shake generator built on
 * it. Perlin rather than white noise because a camera driven by uncorrelated
 * per-frame randomness reads as digital hash, not as a physical camera being
 * jolted: real shake has continuous velocity, which band-limited gradient noise
 * gives you for free.
 */

/** Integer avalanche hash -> [-1, 1). */
function hash1(i: number): number {
  let h = i | 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 2147483648 - 1;
}

/** 1D gradient noise, C1-continuous, output ~[-1, 1]. */
export function gradientNoise1(x: number, seed: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  const ga = hash1(i * 1597334677 + seed * 668265263);
  const gb = hash1((i + 1) * 1597334677 + seed * 668265263);
  const va = ga * f;
  const vb = gb * (f - 1);
  return (va + u * (vb - va)) * 2;
}

/** Three-octave fbm. Frequencies are irrational-ish so octaves never phase-lock. */
export function fbm1(x: number, seed: number): number {
  return (
    (gradientNoise1(x, seed) +
      gradientNoise1(x * 2.17, seed + 101) * 0.5 +
      gradientNoise1(x * 4.63, seed + 211) * 0.26) *
    0.568
  );
}

/** Peak rotational amplitude at full envelope, radians. Small on purpose —
 *  shake reads far bigger on screen than the numbers suggest. */
const SHAKE_YAW_MAX = 0.0157; // 0.90 deg
const SHAKE_PITCH_MAX = 0.0218; // 1.25 deg
const SHAKE_ROLL_MAX = 0.0297; // 1.70 deg

/** Envelope decay, per second. ~0.9 s to fall to 10% of an impact. */
const SHAKE_DECAY_RATE = 2.4;

/**
 * Rotational-only camera shake. Position is never touched, so an impact can
 * never pop the camera through geometry or break a composed frame — it only
 * jolts the aim, which is what a real body-mounted or gimbal camera does.
 */
export class CameraShake {
  /** 0..1 envelope, decays from impacts. */
  private energy = 0;
  /** Applied amplitude 0..1, published on `cam.shake`. */
  amplitude = 0;
  yaw = 0;
  pitch = 0;
  roll = 0;

  reset(): void {
    this.energy = 0;
    this.amplitude = 0;
    this.yaw = 0;
    this.pitch = 0;
    this.roll = 0;
  }

  /**
   * @param impact  0..1 impulse this frame (bow slam, external request).
   * @param baseline 0..1 continuous tremble floor from the sea state.
   * @param scale   per-mode multiplier; 0 disables.
   */
  update(dt: number, t: number, impact: number, baseline: number, scale: number): void {
    // Impacts set a floor rather than accumulating, so a train of slams does
    // not integrate into an unbounded shake.
    if (impact > this.energy) this.energy = impact;
    this.energy = damp(this.energy, 0, SHAKE_DECAY_RATE, dt);

    const amp = clamp01(this.energy + baseline) * scale;
    this.amplitude = amp;
    if (amp <= 1e-4) {
      this.yaw = 0;
      this.pitch = 0;
      this.roll = 0;
      return;
    }

    // Two layers per axis: a tremble in the 4-8 Hz band where handheld camera
    // noise actually lives, and a slow sub-1 Hz wander that reads as an
    // operator fighting the motion.
    this.yaw = (fbm1(t * 5.5, 11) * 0.62 + gradientNoise1(t * 0.85, 41) * 0.38) * SHAKE_YAW_MAX * amp;
    this.pitch =
      (fbm1(t * 7.3, 23) * 0.66 + gradientNoise1(t * 1.05, 53) * 0.34) * SHAKE_PITCH_MAX * amp;
    this.roll = (fbm1(t * 4.1, 37) * 0.58 + gradientNoise1(t * 0.7, 59) * 0.42) * SHAKE_ROLL_MAX * amp;
  }
}
