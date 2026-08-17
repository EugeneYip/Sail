/**
 * Allocation-free value noise for the weather director.
 *
 * Local to `src/env` on purpose: nothing outside needs it, and the gust
 * spectrum specifically wants a C2 fade so that the noise *derivative* — which
 * we reuse for gust-coupled wind veer — is itself continuous. A C1 smoothstep
 * would make the veer visibly kink at every lattice point.
 */

function hashInt(i: number): number {
  let h = i | 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

function hashInt2(i: number, j: number): number {
  return hashInt(Math.imul(i, 73856093) ^ Math.imul(j, 19349663));
}

/** Quintic fade — C2 continuous, unlike smoothstep. */
function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** 1-D value noise, output in [-1, 1]. */
export function vnoise1(x: number, seed: number): number {
  const i = Math.floor(x);
  const f = fade(x - i);
  const a = hashInt(i + seed) * 2 - 1;
  const b = hashInt(i + 1 + seed) * 2 - 1;
  return a + (b - a) * f;
}

// Lacunarity is deliberately not 2.0 so the octaves never phase-lock into an
// audibly/visibly periodic gust pattern.
const LACUNARITY = 2.13;
const GAIN = 0.55;
const FBM_NORM = 1 / (1 + GAIN + GAIN * GAIN + GAIN * GAIN * GAIN);

/**
 * 4-octave fBm, output in roughly [-1, 1] (typical excursion ±0.7).
 * Unrolled: this runs every frame and the loop overhead is a measurable
 * fraction of the whole module's cost.
 */
export function fbm1(x: number, seed: number): number {
  let v = vnoise1(x, seed);
  v += GAIN * vnoise1(x * LACUNARITY, seed + 101);
  v += GAIN * GAIN * vnoise1(x * LACUNARITY * LACUNARITY, seed + 211);
  v += GAIN * GAIN * GAIN * vnoise1(x * LACUNARITY * LACUNARITY * LACUNARITY, seed + 337);
  return v * FBM_NORM;
}

/** 2-D value noise, output in [0, 1]. */
export function vnoise2(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = fade(x - ix);
  const fy = fade(y - iy);
  const s = seed | 0;
  const a = hashInt2(ix + s, iy + s);
  const b = hashInt2(ix + 1 + s, iy + s);
  const c = hashInt2(ix + s, iy + 1 + s);
  const d = hashInt2(ix + 1 + s, iy + 1 + s);
  const top = a + (b - a) * fx;
  const bot = c + (d - c) * fx;
  return top + (bot - top) * fy;
}
