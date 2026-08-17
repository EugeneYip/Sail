/**
 * Pure-TS deterministic noise, shared by the main thread and the generation
 * worker. No imports so it bundles into the worker cheaply.
 *
 * Gradient directions come from a 256-entry table rather than trig per corner —
 * an fBm at 6 octaves is ~24 hashes and 0 trig calls, which is what makes
 * generating a 512x512 field affordable.
 */

const GRAD = (() => {
  const g = new Float32Array(512);
  for (let i = 0; i < 256; i++) {
    // 0.31 offset keeps axis-aligned gradients off the cardinal directions,
    // which otherwise leaves faint grid artefacts in ridged noise.
    const a = (i / 256) * Math.PI * 2 + 0.31;
    g[i * 2] = Math.cos(a);
    g[i * 2 + 1] = Math.sin(a);
  }
  return g;
})();

export function ihash2(x: number, y: number, seed: number): number {
  let h = (seed | 0) ^ Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 13), 0x297a2d39);
  return (h ^ (h >>> 16)) >>> 0;
}

export function hash01(x: number, y: number, seed: number): number {
  return ihash2(x, y, seed) / 4294967296;
}

/** Gradient (Perlin-style) noise, roughly [-1, 1]. */
export function gnoise2(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const i00 = (ihash2(ix, iy, seed) & 255) << 1;
  const i10 = (ihash2(ix + 1, iy, seed) & 255) << 1;
  const i01 = (ihash2(ix, iy + 1, seed) & 255) << 1;
  const i11 = (ihash2(ix + 1, iy + 1, seed) & 255) << 1;
  const a = GRAD[i00] * fx + GRAD[i00 + 1] * fy;
  const b = GRAD[i10] * (fx - 1) + GRAD[i10 + 1] * fy;
  const c = GRAD[i01] * fx + GRAD[i01 + 1] * (fy - 1);
  const d = GRAD[i11] * (fx - 1) + GRAD[i11 + 1] * (fy - 1);
  const ab = a + (b - a) * ux;
  const cd = c + (d - c) * ux;
  return (ab + (cd - ab) * uy) * 1.4142;
}

export function fbm2(x: number, y: number, seed: number, octaves = 5, lac = 2.02, gain = 0.5): number {
  let s = 0;
  let a = 0.5;
  let n = 0;
  let px = x;
  let py = y;
  for (let i = 0; i < octaves; i++) {
    s += a * gnoise2(px, py, seed + i * 1013);
    n += a;
    px *= lac;
    py *= lac;
    a *= gain;
  }
  return s / n;
}

/** Ridged multifractal — the basis for mountain spines. Returns [0, 1]. */
export function ridged2(x: number, y: number, seed: number, octaves = 5, lac = 2.03, gain = 0.5): number {
  let s = 0;
  let a = 0.5;
  let n = 0;
  let px = x;
  let py = y;
  let weight = 1;
  for (let i = 0; i < octaves; i++) {
    let v = 1 - Math.abs(gnoise2(px, py, seed + i * 733));
    v *= v;
    v *= weight;
    // Feeding the previous octave forward is what gives ridged noise its
    // characteristic connected ridgelines instead of isolated bumps.
    weight = v < 0 ? 0 : v > 1 ? 1 : v;
    s += a * v;
    n += a;
    px *= lac;
    py *= lac;
    a *= gain;
  }
  return s / n;
}

export function billow2(x: number, y: number, seed: number, octaves = 4): number {
  let s = 0;
  let a = 0.5;
  let n = 0;
  let px = x;
  let py = y;
  for (let i = 0; i < octaves; i++) {
    s += a * Math.abs(gnoise2(px, py, seed + i * 431));
    n += a;
    px *= 2.02;
    py *= 2.02;
    a *= 0.5;
  }
  return s / n;
}

/**
 * Worley F1/F2 on a jittered grid. `out` receives [f1, f2, cellHashX]; used for
 * mangrove channels, boulder fields and reef cells.
 */
export function worley2(x: number, y: number, seed: number, out: Float32Array): void {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  let f1 = 1e9;
  let f2 = 1e9;
  let id = 0;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const cx = ix + i;
      const cy = iy + j;
      const h = ihash2(cx, cy, seed);
      const jx = cx + (h & 1023) / 1023;
      const jy = cy + ((h >>> 10) & 1023) / 1023;
      const dx = jx - x;
      const dy = jy - y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < f1) {
        f2 = f1;
        f1 = d;
        id = h;
      } else if (d < f2) {
        f2 = d;
      }
    }
  }
  out[0] = f1;
  out[1] = f2;
  out[2] = (id >>> 20) / 4096;
}

/** Domain warp: writes the warped coordinate into `out`. */
export function warp2(x: number, y: number, seed: number, amp: number, freq: number, out: Float32Array): void {
  const wx = fbm2(x * freq, y * freq, seed + 7717, 3);
  const wy = fbm2(x * freq + 5.2, y * freq + 1.3, seed + 3319, 3);
  out[0] = x + wx * amp;
  out[1] = y + wy * amp;
}

/** Smoothstep. */
export function sstep(a: number, b: number, x: number): number {
  const t = a === b ? (x < a ? 0 : 1) : (x - a) / (b - a);
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
