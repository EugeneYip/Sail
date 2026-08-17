import * as THREE from 'three';
import { angleDelta, wrapTau } from '../util/math';

/**
 * Fetch/duration integrator. THE most important lag in the whole director:
 * wind up is not waves up.
 *
 * The sea is carried as two components whose energies add:
 *
 *   waveHeight = sqrt(windSea^2 + swell^2)
 *
 *   windSea — the local wind chop. Responds in tens of minutes and dies almost
 *             as fast. Runs from (a slightly lagged) `windBearing`.
 *   swell   — the old, long sea. Takes hours to build and most of a day to die.
 *             Keeps running from wherever the wind used to be.
 *
 * At equilibrium windSea = 0.6*Hs and swell = 0.8*Hs (0.6^2 + 0.8^2 = 1), so the
 * pair reproduces the fully developed height exactly while giving the build an
 * S-shaped toe rather than a bare exponential — and giving crossed seas for free
 * after any wind shift.
 *
 * Time constants (simulated minutes), and what they actually produce for a
 * 4 -> 20 m/s step and back (numbers verified in scripts/weather-test.mjs):
 *
 *   windSea rise  20      swell rise  150     -> 63% of the build at ~67 min
 *   windSea fall  25      swell fall  480     -> 63% of the decay at ~351 min
 *
 * i.e. the sea builds over about an hour and takes nearly six to lie down again:
 * a 5.2x asymmetry. At the default 60x clock that is ~67 s to build and ~5.9 min
 * to decay, so the lag is plainly felt inside a single session without anyone
 * having to wait out a real gale.
 *
 * Swell BEARING turns toward the wind only in proportion to how much new energy
 * the wind is putting in relative to what is already running:
 *
 *   feed = Heq / (Heq + 1.6*swell + 0.15)
 *
 * At equilibrium that is ~0.43, giving an effective 150 min turn constant. Once
 * the wind drops, Heq collapses, feed falls to ~0.05 and the old swell holds its
 * direction for the best part of a day. That is exactly the behaviour that
 * produces a beautiful crossed sea after a frontal wind shift.
 */

const TAU_WINDSEA_RISE_S = 20 * 60;
const TAU_WINDSEA_FALL_S = 25 * 60;
const TAU_SWELL_RISE_S = 150 * 60;
const TAU_SWELL_FALL_S = 480 * 60;
const TAU_WINDSEA_DIR_S = 12 * 60;
/** Nominal; divided by `feed`, which is ~0.43 in a fully developed sea. */
const TAU_SWELL_DIR_S = 65 * 60;

const WIND_SEA_SHARE = 0.6;
const SWELL_SHARE = 0.8;

/**
 * Fully developed significant wave height, metres, from wind speed in m/s.
 *
 * A power-law fit rather than Pierson-Moskowitz: PM's fetch-unlimited Hs at
 * 20 m/s is nearly 10 m, which needs a thousand kilometres of fetch and two days
 * of blowing. This fit is calibrated to the Douglas scale and to the capture
 * harness's own scene table (10.5 m/s -> 2.0 m, 22 m/s -> 6.5 m) so that the
 * director and the reference screenshots agree with each other.
 */
const HS_COEF = 0.0472;
const HS_EXP = 1.594;
export function fullyDevelopedHs(windSpeed: number): number {
  return HS_COEF * Math.pow(Math.max(0, windSpeed), HS_EXP);
}

/** Upper Hs bound of each Douglas sea state, metres. */
const DOUGLAS_HS = [0, 0.1, 0.5, 1.25, 2.5, 4, 6, 9, 14, 20];

/**
 * Douglas sea state from Hs. Returns a CONTINUOUS 0..9 rather than an integer:
 * consumers that want the band can round, and the ocean/audio can lerp without
 * a visible or audible step as a sea builds through a boundary.
 */
export function douglasFromHs(hs: number): number {
  if (!(hs > 0)) return 0;
  for (let i = 1; i < DOUGLAS_HS.length; i++) {
    if (hs < DOUGLAS_HS[i]) {
      const lo = DOUGLAS_HS[i - 1];
      return Math.min(9, i + (hs - lo) / (DOUGLAS_HS[i] - lo));
    }
  }
  return 9;
}

function lagTo(cur: number, target: number, dt: number, tauRise: number, tauFall: number): number {
  const tau = target > cur ? tauRise : tauFall;
  return cur + (target - cur) * (1 - Math.exp(-dt / tau));
}

function dampAngle(cur: number, target: number, rate: number, dt: number): number {
  return wrapTau(cur + angleDelta(cur, target) * (1 - Math.exp(-rate * dt)));
}

export class SeaState {
  /** Hs of the wind-driven chop, metres. */
  windSea = 0;
  /** Hs of the old swell, metres. */
  swell = 0;
  /** Combined significant wave height, metres. */
  height = 0;
  /** Continuous Douglas state 0..9. */
  douglas = 0;
  /** 0 = long clean swell, 1 = short steep chop. */
  choppiness = 0.5;
  /** Bearing (from) the wind chop runs, radians. Lags windBearing by ~12 min. */
  windSeaBearing = 0;
  /** Bearing (from) the swell runs, radians. Lags heavily. */
  swellBearing = 0;
  /** 0..1 — how crossed the sea is. Peaks when the two trains are equal and 90° apart. */
  crossSea = 0;

  /** Seed the split so that the combined height is exactly `hs`. */
  setHeight(hs: number): void {
    const h = Math.max(0, hs);
    this.windSea = h * WIND_SEA_SHARE;
    this.swell = h * SWELL_SHARE;
    this.height = h;
    this.douglas = douglasFromHs(h);
  }

  reset(hs: number, bearing: number): void {
    this.setHeight(hs);
    this.windSeaBearing = wrapTau(bearing);
    this.swellBearing = wrapTau(bearing);
  }

  /**
   * @param simDt      simulated seconds since the last call
   * @param freezeHeight   true while `waveHeight` is pinned — hold the split so
   *                       the forced value is exactly stable
   * @param freezeSwellDir true while `swellBearing` is pinned
   */
  update(
    simDt: number,
    windSpeed: number,
    windBearing: number,
    freezeHeight: boolean,
    freezeSwellDir: boolean,
  ): void {
    const heq = fullyDevelopedHs(windSpeed);

    if (!freezeHeight && simDt > 0) {
      this.windSea = lagTo(
        this.windSea,
        heq * WIND_SEA_SHARE,
        simDt,
        TAU_WINDSEA_RISE_S,
        TAU_WINDSEA_FALL_S,
      );
      this.swell = lagTo(this.swell, heq * SWELL_SHARE, simDt, TAU_SWELL_RISE_S, TAU_SWELL_FALL_S);
    }
    this.height = Math.sqrt(this.windSea * this.windSea + this.swell * this.swell);
    this.douglas = douglasFromHs(this.height);

    if (simDt > 0) {
      this.windSeaBearing = dampAngle(this.windSeaBearing, windBearing, 1 / TAU_WINDSEA_DIR_S, simDt);
      if (!freezeSwellDir) {
        const feed = heq / (heq + 1.6 * this.swell + 0.15);
        this.swellBearing = dampAngle(
          this.swellBearing,
          this.windSeaBearing,
          feed / TAU_SWELL_DIR_S,
          simDt,
        );
      }
    }

    // Steep and short while the wind is still feeding energy in; long and clean
    // once the wind has dropped and only old swell is left running.
    const scale = 0.55 * heq + 0.35;
    const building = THREE.MathUtils.clamp((heq - this.height) / scale, 0, 1);
    const decaying = THREE.MathUtils.clamp((this.height - heq) / scale, 0, 1);
    this.choppiness = THREE.MathUtils.clamp(
      0.27 + 0.027 * windSpeed + 0.26 * building - 0.32 * decaying,
      0.05,
      0.96,
    );

    const swellEnergyShare =
      (this.swell * this.swell) / Math.max(1e-6, this.height * this.height);
    const cross = Math.abs(Math.sin(angleDelta(this.windSeaBearing, this.swellBearing)));
    this.crossSea = cross * 4 * swellEnergyShare * (1 - swellEnergyShare);
  }
}

/** Exposed for the test harness so it never has to hard-code these. */
export const SEA_TIME_CONSTANTS = {
  windSeaRiseMin: TAU_WINDSEA_RISE_S / 60,
  windSeaFallMin: TAU_WINDSEA_FALL_S / 60,
  swellRiseMin: TAU_SWELL_RISE_S / 60,
  swellFallMin: TAU_SWELL_FALL_S / 60,
  windSeaDirMin: TAU_WINDSEA_DIR_S / 60,
  swellDirNominalMin: TAU_SWELL_DIR_S / 60,
  windSeaShare: WIND_SEA_SHARE,
  swellShare: SWELL_SHARE,
  hsCoef: HS_COEF,
  hsExp: HS_EXP,
};
