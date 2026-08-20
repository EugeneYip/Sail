import * as THREE from 'three';

/**
 * Procedural detail textures for the surface shader. Baked once at init — a
 * texture LUT is always cheaper than the same noise evaluated per fragment, and
 * these are sampled four or five times per pixel across the whole screen.
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

/**
 * Jittered feature point per cell of a `cells` x `cells` torus, precomputed.
 *
 * Hashing the nine candidate points per *texel* rehashes every point once for
 * each texel that can see it — nine times the necessary work. Baking the grid
 * once makes the per-texel loop nine array reads, which is what pays for three
 * scales instead of one.
 */
function featureGrid(cells: number, seed: number): Float32Array {
  const g = new Float32Array(cells * cells * 2);
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      const o = (y * cells + x) * 2;
      g[o] = x + hash2i(x, y, seed);
      g[o + 1] = y + hash2i(x, y, seed + 977);
    }
  }
  return g;
}

/**
 * Distance to the SECOND nearest feature point minus the nearest, scaled.
 *
 * This is the bubble-raft primitive. F2 - F1 is largest deep inside a cell and
 * falls to exactly zero on the wall between two cells, so a threshold on it
 * gives convex bubbles separated by hard dark films — which is what a mass of
 * whitewater actually looks like close up.
 *
 * `1 - F1`, which this file used to use for the whole R channel, is a smooth
 * radial falloff from every cell centre: literally a field of soft round blobs.
 * `src/vfx/textures.ts` identified that primitive as the single biggest reason
 * hull foam read as cotton wool and removed it; the ocean's own detail texture
 * kept it, which is why the sea's foam had the same problem from the other side.
 *
 * `k` MUST SCALE WITH THE CELL COUNT: F2 - F1 is measured in tile units, so its
 * magnitude inside a cell is proportional to the cell spacing. A fixed k against
 * a 10-cell grid never saturates, and then every cell is a soft dome with a
 * mid-grey film between — a field of soft round blobs wearing a Worley costume.
 */
function cellFilm(x: number, y: number, cells: number, g: Float32Array, k: number): number {
  const cx = Math.floor(x);
  const cy = Math.floor(y);
  let f1 = 1e9;
  let f2 = 1e9;
  for (let j = -1; j <= 1; j++) {
    const gy = cy + j;
    const wy = ((gy % cells) + cells) % cells;
    const row = wy * cells;
    const offY = gy - wy;
    for (let i = -1; i <= 1; i++) {
      const gx = cx + i;
      const wx = ((gx % cells) + cells) % cells;
      const o = (row + wx) * 2;
      const dx = g[o] + (gx - wx) - x;
      const dy = g[o + 1] + offY - y;
      const d = dx * dx + dy * dy;
      if (d < f1) {
        f2 = f1;
        f1 = d;
      } else if (d < f2) {
        f2 = d;
      }
    }
  }
  const v = (Math.sqrt(f2) - Math.sqrt(f1)) * k;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const sstep = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/**
 * Rewrite `f` in place so its values are UNIFORM on 0..1 — the rank of each
 * sample divided by the last rank.
 *
 * The surface shader's foam coverage depends on this and on nothing else. It
 * decides coverage with `linstep(t - w, t + w, decide)` for `t = 1 - coverage`,
 * and for a field that is uniform on 0..1 the expectation of that is exactly
 * `1 - t`, i.e. exactly the coverage asked for, at ANY ramp width and under any
 * zero-mean perturbation of `t`. That is what lets the shader tear the boundary
 * with as much high-frequency noise as it likes without changing how much foam
 * there is — the property the old "subtract a noise field and multiply by 1.7"
 * form did not have (measured: it rendered a mean alpha of 0.31 where the
 * physics asked for 0.18, spread as a wash instead of concentrated into
 * patches, which is the pale plate).
 */
function flatten(f: Float32Array): void {
  const n = f.length;
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((a, b) => f[a] - f[b]);
  const inv = 1 / (n - 1);
  for (let r = 0; r < n; r++) f[order[r]] = r * inv;
}

/**
 * Foam breakup, a bubble normal, and the coverage decision field.
 *   r  bubble raft plus large-scale patchiness — the shader's coarse clumping
 *      term and the far-field wind streak
 *   g  normal.x, b normal.z, both biased to 0.5
 *   a  the coverage DECISION field, histogram-flattened to uniform 0..1
 *
 * Whitecap foam is a raft of bubbles with holes in it, not a soft blob, so both
 * masks want hard cell edges (F2 - F1) modulated by a softer fbm rather than
 * plain fbm, which always reads as smoke.
 */
export function makeFoamDetail(): THREE.DataTexture {
  const n = FOAM_SIZE;
  const height = new Float32Array(n * n);
  const decide = new Float32Array(n * n);

  const raft1 = featureGrid(10, 3);
  const raft2 = featureGrid(22, 91);
  const raft3 = featureGrid(46, 137);
  // The decision field's own cells are deliberately finer than the raft's: it is
  // sampled at four tile scales at once, and the finest of them (43 cm) is what
  // has to carry a torn edge with the camera at the rail.
  const dec1 = featureGrid(14, 4409);
  const dec2 = featureGrid(31, 2311);

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const u = (i + 0.5) / n;
      const v = (j + 0.5) / n;
      const clouds = fbm2(u * 8, v * 8, 8, 3, 4);

      const c1 = cellFilm(u * 10, v * 10, 10, raft1, 12.5);
      const c2 = cellFilm(u * 22, v * 22, 22, raft2, 27.5);
      const c3 = cellFilm(u * 46, v * 46, 46, raft3, 57.5);
      // Steep: a wide ramp puts a soft gradient back on every cell wall, which
      // is the whole thing this primitive exists to avoid.
      const bubbles = sstep(0.22, 0.62, c1 * 0.44 + c2 * 0.34 + c3 * 0.22);
      height[j * n + i] = bubbles * 0.72 + clouds * 0.28;

      const d1 = cellFilm(u * 14, v * 14, 14, dec1, 17.5);
      const d2 = cellFilm(u * 31, v * 31, 31, dec2, 38.8);
      // '1 - |2n - 1|' creases along every zero crossing, and it is those
      // creases that let a threshold cut a torn edge instead of a smooth
      // contour. Weighted for its GRADIENT, not for its level — the flatten
      // below removes any bias it introduces.
      const ridge = 1 - Math.abs(fbm2(u * 6, v * 6, 6, 5501, 4) * 2 - 1);
      decide[j * n + i] = d1 * 0.40 + d2 * 0.29 + ridge * 0.31;
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

  flatten(decide);

  const data = new Uint8Array(n * n * 4);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const idx = j * n + i;
      const l = height[j * n + ((i - 1 + n) % n)];
      const r = height[j * n + ((i + 1) % n)];
      const d = height[((j - 1 + n) % n) * n + i];
      const t = height[((j + 1) % n) * n + i];
      const gx = (r - l) * 2.6;
      const gy = (t - d) * 2.6;
      const o = idx * 4;
      data[o] = Math.round(255 * clamp01(height[idx]));
      data[o + 1] = Math.round(255 * clamp01(0.5 - gx * 0.5));
      data[o + 2] = Math.round(255 * clamp01(0.5 - gy * 0.5));
      data[o + 3] = Math.round(255 * clamp01(decide[idx]));
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
