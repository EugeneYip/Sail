import * as THREE from 'three';
import { DEG, RAD, smoothstep } from '../util/math';
import { computeCelestial, createCelestial } from './Celestial';

/**
 * Day length, and the golden-hour time warp.
 *
 * A full 24 h cycle takes `dayLengthMinutes` of real time (default 24 min, so
 * 60x). But `timeOfDay` does NOT advance at a constant rate: we spend more real
 * seconds per simulated hour when the sun is near the horizon, and fewer in the
 * dead middle of the night, because that is where the beautiful minutes are.
 *
 * The curve is a "slowness" factor s of the solar altitude a (degrees):
 *
 *   golden    = exp(-((a - 2) / 9)^2)        Gaussian, peak at +2°, sigma 9°
 *   deepNight = smoothstep(-10, -24, a)      1 below -24°
 *   highDay   = smoothstep(16, 40, a)        1 above  +40°
 *   s(a)      = 1 + 1.45*golden - 0.52*deepNight - 0.20*highDay   clamped 0.40..2.60
 *
 * so the clock crawls to ~2.4x slower through civil twilight, sunrise, golden
 * hour and sunset, runs ~2.1x faster through the middle of the night, and ~1.25x
 * faster around local noon.
 *
 * The clock then advances at
 *
 *   rate = baseRate * mean(s) / s(a)
 *
 * where mean(s) is the average of s over the whole day, recomputed once per
 * simulated day (96 samples). That normalisation is the important part: it keeps
 * a full cycle taking exactly `dayLengthMinutes` no matter how aggressive the
 * curve is or how extreme the latitude gets — the warp only redistributes time
 * within the day, it can never change the day's length. Polar day and polar
 * night, where the altitude never crosses zero, degenerate gracefully to a
 * near-constant rate.
 *
 * Continuity: s is a smooth function of a smoothly varying altitude, so the rate
 * is C1. The fastest and slowest parts of a day differ by ~5x but they are hours
 * apart and the transition between them is monotone and gradual, so it never
 * reads as a speed change. Set `enabled = false` for a linear clock.
 */

export const DEFAULT_DAY_LENGTH_MINUTES = 24;

const GOLDEN_CENTRE_DEG = 2;
const GOLDEN_SIGMA_DEG = 9;
const GOLDEN_GAIN = 1.45;
const NIGHT_GAIN = 0.52;
const DAY_GAIN = 0.2;
const SLOWNESS_MIN = 0.4;
const SLOWNESS_MAX = 2.6;

const CAL_SAMPLES = 96;

export class TimeWarp {
  dayLengthMinutes = DEFAULT_DAY_LENGTH_MINUTES;
  enabled = true;

  private meanSlowness = 1;
  private calDay = Number.NaN;
  private calLat = Number.NaN;
  private calEnabled = true;
  private readonly calScratch = createCelestial();

  /** How much longer than average we linger at this solar altitude. */
  slowness(altRad: number): number {
    if (!this.enabled) return 1;
    const a = altRad * RAD;
    const g = (a - GOLDEN_CENTRE_DEG) / GOLDEN_SIGMA_DEG;
    const golden = Math.exp(-g * g);
    const deepNight = smoothstep(-10, -24, a);
    const highDay = smoothstep(16, 40, a);
    const s = 1 + GOLDEN_GAIN * golden - NIGHT_GAIN * deepNight - DAY_GAIN * highDay;
    return THREE.MathUtils.clamp(s, SLOWNESS_MIN, SLOWNESS_MAX);
  }

  /** Unwarped clock speed, simulated hours per real second. */
  get baseRate(): number {
    return 24 / (Math.max(0.05, this.dayLengthMinutes) * 60);
  }

  /** Warped clock speed at the current solar altitude, simulated hours per real second. */
  rate(altRad: number): number {
    const base = this.baseRate;
    if (!this.enabled) return base;
    return (base * this.meanSlowness) / this.slowness(altRad);
  }

  /**
   * Recompute the normalisation. Cheap enough to call every frame — it early-outs
   * unless the day, the latitude or the enable flag actually changed.
   */
  calibrate(absDays: number, latDeg: number): void {
    const day = Math.floor(absDays);
    if (day === this.calDay && latDeg === this.calLat && this.enabled === this.calEnabled) return;
    this.calDay = day;
    this.calLat = latDeg;
    this.calEnabled = this.enabled;

    if (!this.enabled) {
      this.meanSlowness = 1;
      return;
    }
    let sum = 0;
    const step = 24 / CAL_SAMPLES;
    for (let i = 0; i < CAL_SAMPLES; i++) {
      const t = (i + 0.5) * step;
      computeCelestial(day + t / 24, t, latDeg, -1, this.calScratch);
      sum += this.slowness(this.calScratch.sunAltitude);
    }
    this.meanSlowness = sum / CAL_SAMPLES;
  }
}

/** Exposed so the test harness can assert the curve without duplicating it. */
export const TIME_WARP_CURVE = {
  goldenCentreDeg: GOLDEN_CENTRE_DEG,
  goldenSigmaDeg: GOLDEN_SIGMA_DEG,
  goldenGain: GOLDEN_GAIN,
  nightGain: NIGHT_GAIN,
  dayGain: DAY_GAIN,
  min: SLOWNESS_MIN,
  max: SLOWNESS_MAX,
  horizonRad: 0 * DEG,
};
