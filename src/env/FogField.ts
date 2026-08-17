import { smoothstep } from '../util/math';
import { vnoise2 } from './Noise';

/**
 * Fog as a spatial field rather than a global slider.
 *
 * Two octaves of value noise over ABSOLUTE voyage coordinates (world position
 * plus `world.origin`, so it survives the floating origin), thresholded so that
 * fog only exists in the upper part of the range. That gives real banks with
 * hazy edges and dense cores separated by clear water, instead of a uniform
 * murk that fades in and out on a timer.
 *
 * Bank scale is 1700 m for the large octave and 620 m for the texture, so at a
 * typical 4 m/s over the ground you sail into and out of a bank every 6-8 real
 * minutes, with structure inside it every couple of minutes.
 *
 * The field advects downwind at 6% of the wind speed on REAL time. Advecting on
 * simulated time at a 60x clock would blow the banks past the ship in ninety
 * seconds, which reads as flicker rather than as weather.
 *
 * HONEST LIMITATION: this is sampled at the ship and used to modulate the global
 * `env.visibility`, so the fog is spatially varying ALONG THE TRACK but still
 * uniform across the frame at any instant — you cannot see a wall of fog
 * approaching on the beam. Doing that properly needs the atmosphere/post pass to
 * sample a density function per-pixel, so `world.ext.env.fogDensityAt(x, z)` is
 * published for exactly that purpose.
 */

const BANK_LARGE_M = 1700;
const BANK_SMALL_M = 620;
const LARGE_WEIGHT = 0.64;
const SMALL_WEIGHT = 0.36;
/** Below `EDGE_LO` there is no fog at all; the densest cores are rare. */
const EDGE_LO = 0.46;
const EDGE_HI = 0.9;
const ADVECT_FRACTION = 0.06;

export class FogField {
  private driftX = 0;
  private driftZ = 0;

  /** @param dt real seconds. */
  advect(windVecX: number, windVecZ: number, windSpeed: number, dt: number): void {
    const v = windSpeed * ADVECT_FRACTION * dt;
    this.driftX += windVecX * v;
    this.driftZ += windVecZ * v;
  }

  /** 0..1 fog-bank occupancy at an absolute voyage position. */
  at(x: number, z: number): number {
    const sx = x - this.driftX;
    const sz = z - this.driftZ;
    const a = vnoise2(sx / BANK_LARGE_M, sz / BANK_LARGE_M, 0);
    const b = vnoise2(sx / BANK_SMALL_M + 13.1, sz / BANK_SMALL_M + 7.7, 991);
    return smoothstep(EDGE_LO, EDGE_HI, LARGE_WEIGHT * a + SMALL_WEIGHT * b);
  }
}
