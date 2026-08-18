import * as THREE from 'three';

/**
 * Procedural detail textures for the surface shader. Baked once at init — a
 * texture LUT is always cheaper than the same noise evaluated per fragment, and
 * these are sampled two or three times per pixel across the whole screen.
 */

const FOAM_SIZE = 256;

function hash2i(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Tileable value noise: the lattice wraps at `period` cells. */
function vnoise(x: number, y: number, period: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const x0 = ((xi % period) + period) % period;
  const y0 = ((yi % period) + period) % period;
  const x1 = (x0 + 1) % period;
  const y1 = (y0 + 1) % period;
  const a = hash2i(x0, y0, seed);
  const b = hash2i(x1, y0, seed);
  const c = hash2i(x0, y1, seed);
  const d = hash2i(x1, y1, seed);
  return (a + (b - a) * ux) * (1 - uy) + (c + (d - c) * ux) * uy;
}

function fbm2(x: number, y: number, period: number, seed: number, octaves: number): number {
  let amp = 0.5;
  let sum = 0;
  let norm = 0;
  let p = period;
  for (let o = 0; o < octaves; o++) {
    sum += amp * vnoise(x * (p / period), y * (p / period), p, seed + o * 71);
    norm += amp;
    p *= 2;
    amp *= 0.52;
  }
  return sum / norm;
}

/** Tileable Worley F1, normalised to roughly 0..1. */
function worleyF1(x: number, y: number, period: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  let best = 8;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const cx = xi + i;
      const cy = yi + j;
      const wx = ((cx % period) + period) % period;
      const wy = ((cy % period) + period) % period;
      const px = cx + hash2i(wx, wy, seed);
      const py = cy + hash2i(wx, wy, seed + 977);
      const dx = px - x;
      const dy = py - y;
      const d = dx * dx + dy * dy;
      if (d < best) best = d;
    }
  }
  return Math.min(1, Math.sqrt(best));
}

/**
 * Foam breakup + a bubble normal.
 *   r  ragged coverage mask, used to erode the foam edge into clumps
 *   g  normal.x, b normal.z, both biased to 0.5
 *   a  a second, finer clump mask
 *
 * Whitecap foam is a raft of bubbles with holes in it, not a soft blob, so the
 * mask wants hard cell edges (Worley) modulated by a softer fbm rather than
 * plain fbm, which always reads as smoke.
 */
export function makeFoamDetail(): THREE.DataTexture {
  const n = FOAM_SIZE;
  const height = new Float32Array(n * n);
  const CELLS = 8;

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const u = (i / n) * CELLS;
      const v = (j / n) * CELLS;
      const bubbles = 1 - worleyF1(u * 2, v * 2, CELLS * 2, 17);
      const fine = 1 - worleyF1(u * 5, v * 5, CELLS * 5, 91);
      const clouds = fbm2(u, v, CELLS, 3, 4);
      height[j * n + i] = bubbles * 0.5 + fine * 0.22 + clouds * 0.46;
    }
  }

  let lo = 1e9;
  let hi = -1e9;
  for (let i = 0; i < height.length; i++) {
    if (height[i] < lo) lo = height[i];
    if (height[i] > hi) hi = height[i];
  }
  const span = Math.max(hi - lo, 1e-5);
  for (let i = 0; i < height.length; i++) height[i] = (height[i] - lo) / span;

  const data = new Uint8Array(n * n * 4);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const idx = j * n + i;
      const l = height[j * n + ((i - 1 + n) % n)];
      const r = height[j * n + ((i + 1) % n)];
      const d = height[((j - 1 + n) % n) * n + i];
      const t = height[((j + 1) % n) * n + i];
      const gx = (r - l) * 2.2;
      const gy = (t - d) * 2.2;
      const h = height[idx];
      const o = idx * 4;
      data[o] = Math.round(255 * THREE.MathUtils.clamp(h, 0, 1));
      data[o + 1] = Math.round(255 * THREE.MathUtils.clamp(0.5 - gx * 0.5, 0, 1));
      data[o + 2] = Math.round(255 * THREE.MathUtils.clamp(0.5 - gy * 0.5, 0, 1));
      data[o + 3] = Math.round(255 * THREE.MathUtils.clamp(h * h * 1.4, 0, 1));
    }
  }

  const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** 1x1 black stand-in so a sampler is never left unbound. */
export function makeStubTexture(): THREE.DataTexture {
  const tex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, THREE.RGBAFormat);
  tex.needsUpdate = true;
  return tex;
}
