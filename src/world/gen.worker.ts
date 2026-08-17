/**
 * Island generation worker. Inlined by Vite (`?worker&inline`) so the whole game
 * stays a single bundle with no extra request and no new dependency.
 *
 * Pipeline, all inside one message so the main thread never blocks:
 *   1. archetype profile at half resolution, Catmull-Rom upsampled  (cheap)
 *   2. two octaves of fine detail at full resolution
 *   3. droplet hydraulic erosion                                    (dominant cost)
 *   4. D8 flow accumulation -> moisture + rivers
 *   5. normals, sandiness, curvature AO
 *   6. min/max quadtree pyramid for LOD + culling
 *   7. blue-noise-ish prop scatter masked by slope/altitude/moisture
 *   8. landmark siting from the finished terrain
 *
 * Grid convention (must match HeightField.ts and terrain.glsl exactly):
 *   texel i maps to island-local metres  lx = (i / (N - 1) - 0.5) * extent
 */

import type { GenRequest, GenResult } from './api';
import { LM, LM_STRIDE, SCATTER_STRIDE, SPECIES } from './api';
import { ARCH_META, archHeight, speciesFor, warpedRadius } from './archetypes';
import { clamp01, fbm2, gnoise2, ihash2, mix, sstep } from './wnoise';

const ctx = self as unknown as {
  onmessage: ((ev: MessageEvent<GenRequest>) => void) | null;
  postMessage(msg: unknown, transfer?: Transferable[]): void;
};

const EDGE_DEPTH = -120;

/* ------------------------------------------------------------------ *
 *  base field
 * ------------------------------------------------------------------ */

const rtmp = new Float32Array(2);

function baseField(req: GenRequest, ns: number): Float32Array {
  const out = new Float32Array(ns * ns);
  const { extentM, radiusM, seed, archA, archB, blend, peakScale } = req;
  const inv = 1 / (ns - 1);
  for (let j = 0; j < ns; j++) {
    const lz = (j * inv - 0.5) * extentM;
    for (let i = 0; i < ns; i++) {
      const lx = (i * inv - 0.5) * extentM;
      warpedRadius(lx, lz, radiusM, seed, rtmp);
      const rn = rtmp[0];
      const th = rtmp[1];
      let h = archHeight(archA, lx, lz, rn, th, seed, radiusM, peakScale);
      if (blend > 0.02) {
        const hb = archHeight(archB, lx, lz, rn, th, seed + 9001, radiusM, peakScale);
        // Spatial, low-frequency mix so one coast belongs to A and another to B.
        const w = clamp01(fbm2(lx * 0.00032, lz * 0.00032, seed + 271, 3) * 1.6 + 0.5) * blend;
        h = mix(h, hb, w);
      }
      out[j * ns + i] = mix(h, EDGE_DEPTH, sstep(1.28, 1.62, rn));
    }
  }
  return out;
}

function cr(a: number, b: number, c: number, d: number, t: number): number {
  const t2 = t * t;
  return (
    0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t2 * t)
  );
}

function upsample(src: Float32Array, ns: number, dst: Float32Array, nd: number): void {
  const k = (ns - 1) / (nd - 1);
  const row = new Float32Array(4);
  for (let j = 0; j < nd; j++) {
    const sy = j * k;
    const jy = Math.floor(sy);
    const ty = sy - jy;
    for (let i = 0; i < nd; i++) {
      const sx = i * k;
      const jx = Math.floor(sx);
      const tx = sx - jx;
      for (let m = 0; m < 4; m++) {
        let yy = jy - 1 + m;
        yy = yy < 0 ? 0 : yy > ns - 1 ? ns - 1 : yy;
        const o = yy * ns;
        const x0 = jx - 1 < 0 ? 0 : jx - 1;
        const x1 = jx;
        const x2 = jx + 1 > ns - 1 ? ns - 1 : jx + 1;
        const x3 = jx + 2 > ns - 1 ? ns - 1 : jx + 2;
        row[m] = cr(src[o + x0], src[o + x1], src[o + x2], src[o + x3], tx);
      }
      dst[j * nd + i] = cr(row[0], row[1], row[2], row[3], ty);
    }
  }
}

/* ------------------------------------------------------------------ *
 *  erosion
 * ------------------------------------------------------------------ */

const BRUSH_R = 2;
const brushOff: number[] = [];
const brushW: number[] = [];
{
  let sum = 0;
  for (let j = -BRUSH_R; j <= BRUSH_R; j++) {
    for (let i = -BRUSH_R; i <= BRUSH_R; i++) {
      const d = Math.sqrt(i * i + j * j);
      if (d > BRUSH_R + 0.5) continue;
      const w = 1 - d / (BRUSH_R + 1);
      brushOff.push(i, j);
      brushW.push(w);
      sum += w;
    }
  }
  for (let i = 0; i < brushW.length; i++) brushW[i] /= sum;
}

const INERTIA = 0.055;
const CAPACITY = 3.2;
const MIN_SLOPE = 0.015;
const DEPOSIT_RATE = 0.28;
const ERODE_RATE = 0.32;
const GRAVITY = 5.5;
const EVAPORATE = 0.022;
const MAX_STEPS = 44;

function erode(H: Float32Array, N: number, droplets: number, seed: number): void {
  // Droplets must start on land or they do nothing; collect land cells once.
  const land: number[] = [];
  for (let j = 2; j < N - 2; j++) {
    for (let i = 2; i < N - 2; i++) {
      if (H[j * N + i] > 2.5) land.push(j * N + i);
    }
  }
  if (land.length < 64) return;

  let rs = (seed | 0) ^ 0x9e3779b9;
  const rnd = (): number => {
    rs = (rs + 0x6d2b79f5) | 0;
    let t = rs;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const nb = brushW.length;
  for (let d = 0; d < droplets; d++) {
    const c = land[(rnd() * land.length) | 0];
    let px = (c % N) + rnd() - 0.5;
    let pz = ((c / N) | 0) + rnd() - 0.5;
    let dx = 0;
    let dz = 0;
    let speed = 1;
    let water = 1;
    let sed = 0;

    for (let s = 0; s < MAX_STEPS; s++) {
      const ix = px | 0;
      const iz = pz | 0;
      if (ix < 1 || iz < 1 || ix > N - 3 || iz > N - 3) break;
      const fx = px - ix;
      const fz = pz - iz;
      const i00 = iz * N + ix;
      const h00 = H[i00];
      const h10 = H[i00 + 1];
      const h01 = H[i00 + N];
      const h11 = H[i00 + N + 1];
      const gx = (h10 - h00) * (1 - fz) + (h11 - h01) * fz;
      const gz = (h01 - h00) * (1 - fx) + (h11 - h10) * fx;
      const hOld = h00 + (h10 - h00) * fx + (h01 - h00) * fz + (h00 - h10 - h01 + h11) * fx * fz;

      dx = dx * INERTIA - gx * (1 - INERTIA);
      dz = dz * INERTIA - gz * (1 - INERTIA);
      const len = Math.sqrt(dx * dx + dz * dz);
      if (len < 1e-5) break;
      dx /= len;
      dz /= len;
      px += dx;
      pz += dz;

      const nx = px | 0;
      const nz = pz | 0;
      if (nx < 1 || nz < 1 || nx > N - 3 || nz > N - 3) break;
      const gfx = px - nx;
      const gfz = pz - nz;
      const j00 = nz * N + nx;
      const k00 = H[j00];
      const k10 = H[j00 + 1];
      const k01 = H[j00 + N];
      const k11 = H[j00 + N + 1];
      const hNew = k00 + (k10 - k00) * gfx + (k01 - k00) * gfz + (k00 - k10 - k01 + k11) * gfx * gfz;
      const dh = hNew - hOld;

      if (hNew < -1.0) {
        // Reached the sea: drop the load as an alluvial fan at the river mouth.
        const w00 = (1 - fx) * (1 - fz);
        H[i00] += sed * w00;
        H[i00 + 1] += sed * fx * (1 - fz);
        H[i00 + N] += sed * (1 - fx) * fz;
        H[i00 + N + 1] += sed * fx * fz;
        break;
      }

      const cap = Math.max(-dh, MIN_SLOPE) * speed * water * CAPACITY;
      if (dh > 0 || sed > cap) {
        const amt = dh > 0 ? Math.min(dh, sed) : (sed - cap) * DEPOSIT_RATE;
        sed -= amt;
        H[i00] += amt * (1 - fx) * (1 - fz);
        H[i00 + 1] += amt * fx * (1 - fz);
        H[i00 + N] += amt * (1 - fx) * fz;
        H[i00 + N + 1] += amt * fx * fz;
      } else {
        const amt = Math.min((cap - sed) * ERODE_RATE, -dh);
        sed += amt;
        for (let b = 0; b < nb; b++) {
          const bi = ix + brushOff[b * 2];
          const bj = iz + brushOff[b * 2 + 1];
          if (bi < 0 || bj < 0 || bi >= N || bj >= N) continue;
          const idx = bj * N + bi;
          // Never scour a beach into a pit — coastal cells stay above the swash.
          if (H[idx] > 0.25) H[idx] = Math.max(0.25, H[idx] - amt * brushW[b]);
        }
      }
      speed = Math.sqrt(Math.max(0, speed * speed - dh * GRAVITY));
      water *= 1 - EVAPORATE;
      if (water < 0.02) break;
    }
  }
}

/* ------------------------------------------------------------------ *
 *  flow accumulation
 * ------------------------------------------------------------------ */

const NB8X = [1, 1, 0, -1, -1, -1, 0, 1];
const NB8Z = [0, 1, 1, 1, 0, -1, -1, -1];

function flowAccum(H: Float32Array, N: number, acc: Float32Array): void {
  // Bucket sort by height (descending) — a comparator sort on 260k indices is
  // an order of magnitude slower and precision here is irrelevant.
  const BUCKETS = 2048;
  let hi = -1e9;
  let lo = 1e9;
  for (let i = 0; i < H.length; i++) {
    const h = H[i];
    if (h > hi) hi = h;
    if (h < lo) lo = h;
  }
  const span = Math.max(1e-3, hi - lo);
  const counts = new Int32Array(BUCKETS + 1);
  const cell = new Int32Array(H.length);
  let n = 0;
  for (let j = 1; j < N - 1; j++) {
    for (let i = 1; i < N - 1; i++) {
      const idx = j * N + i;
      if (H[idx] <= 0.05) continue;
      const b = Math.min(BUCKETS - 1, ((hi - H[idx]) / span) * (BUCKETS - 1)) | 0;
      cell[n++] = idx | (b << 20);
      counts[b + 1]++;
    }
  }
  for (let b = 0; b < BUCKETS; b++) counts[b + 1] += counts[b];
  const order = new Int32Array(n);
  for (let k = 0; k < n; k++) {
    const b = cell[k] >>> 20;
    order[counts[b]++] = cell[k] & 0xfffff;
  }
  for (let k = 0; k < n; k++) acc[order[k]] = 1;
  for (let k = 0; k < n; k++) {
    const idx = order[k];
    const h = H[idx];
    let best = -1;
    let bestD = 0;
    for (let d = 0; d < 8; d++) {
      const nidx = idx + NB8Z[d] * N + NB8X[d];
      const drop = (h - H[nidx]) / (d & 1 ? 1.4142 : 1);
      if (drop > bestD) {
        bestD = drop;
        best = nidx;
      }
    }
    if (best >= 0) acc[best] += acc[idx];
  }
}

/* ------------------------------------------------------------------ *
 *  helpers
 * ------------------------------------------------------------------ */

function boxBlur(src: Float32Array, dst: Float32Array, N: number, r: number, scratch: Float32Array): void {
  const inv = 1 / (2 * r + 1);
  for (let j = 0; j < N; j++) {
    const o = j * N;
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += src[o + Math.min(N - 1, Math.max(0, i))];
    for (let i = 0; i < N; i++) {
      scratch[o + i] = sum * inv;
      const add = Math.min(N - 1, i + r + 1);
      const sub = Math.max(0, i - r);
      sum += src[o + add] - src[o + sub];
    }
  }
  for (let i = 0; i < N; i++) {
    let sum = 0;
    for (let j = -r; j <= r; j++) sum += scratch[Math.min(N - 1, Math.max(0, j)) * N + i];
    for (let j = 0; j < N; j++) {
      dst[j * N + i] = sum * inv;
      const add = Math.min(N - 1, j + r + 1);
      const sub = Math.max(0, j - r);
      sum += scratch[add * N + i] - scratch[sub * N + i];
    }
  }
}

function pyramidTotal(nBase: number): number {
  let t = 0;
  for (let n = nBase; n >= 1; n >>= 1) t += n * n;
  return t;
}

/* ------------------------------------------------------------------ *
 *  main job
 * ------------------------------------------------------------------ */

function generate(req: GenRequest): GenResult {
  const t0 = performance.now();
  const N = req.gridN;
  const extent = req.extentM;
  const cell = extent / (N - 1);
  const meta = ARCH_META[req.archA];
  const metaB = ARCH_META[req.archB];
  const beachiness = mix(meta.beachiness, metaB.beachiness, req.blend * 0.5);
  const reefiness = mix(meta.reefiness, metaB.reefiness, req.blend * 0.5);

  const ns = N >> 1;
  const H = new Float32Array(N * N);
  upsample(baseField(req, ns), ns, H, N);

  // Fine detail the half-res pass cannot carry. Amplitude falls off under water
  // so the seabed stays smooth and the shallows read clean.
  const inv = 1 / (N - 1);
  for (let j = 0; j < N; j++) {
    const lz = (j * inv - 0.5) * extent;
    for (let i = 0; i < N; i++) {
      const lx = (i * inv - 0.5) * extent;
      const idx = j * N + i;
      const h = H[idx];
      const above = clamp01(h * 0.12 + 0.4);
      H[idx] =
        h +
        (gnoise2(lx * 0.0072, lz * 0.0072, req.seed + 601) * 3.4 +
          gnoise2(lx * 0.019, lz * 0.019, req.seed + 907) * 1.1) *
          above;
    }
  }

  erode(H, N, req.erosionDroplets, req.seed);

  const acc = new Float32Array(N * N);
  flowAccum(H, N, acc);

  const blurA = new Float32Array(N * N);
  const blurB = new Float32Array(N * N);
  const scratch = new Float32Array(N * N);
  boxBlur(H, blurA, N, 4, scratch);
  boxBlur(H, blurB, N, 14, scratch);

  const hm = new Float32Array(N * N * 2);
  const mat = new Uint8Array(N * N * 4);
  let maxHeight = 0;
  let landRadius = 0;
  let landCells = 0;

  const snowLine = Math.min(meta.snowLine, metaB.snowLine);

  for (let j = 0; j < N; j++) {
    const lz = (j * inv - 0.5) * extent;
    for (let i = 0; i < N; i++) {
      const idx = j * N + i;
      const lx = (i * inv - 0.5) * extent;
      const h = H[idx];
      if (h > maxHeight) maxHeight = h;
      if (h > 0.25) {
        landCells++;
        const r = Math.sqrt(lx * lx + lz * lz);
        if (r > landRadius) landRadius = r;
      }

      const xm = i > 0 ? idx - 1 : idx;
      const xp = i < N - 1 ? idx + 1 : idx;
      const zm = j > 0 ? idx - N : idx;
      const zp = j < N - 1 ? idx + N : idx;
      const dhx = (H[xm] - H[xp]) / (2 * cell);
      const dhz = (H[zm] - H[zp]) / (2 * cell);
      const nl = 1 / Math.sqrt(dhx * dhx + dhz * dhz + 1);
      const slope = Math.sqrt(dhx * dhx + dhz * dhz);

      // moisture: flow-fed, drier with altitude and slope
      const wet = sstep(0.7, 4.4, Math.log(1 + acc[idx]));
      const altDry = 1 - sstep(0.3, 0.95, h / Math.max(60, maxHeight));
      const slopeDry = 1 - sstep(0.5, 1.35, slope);
      let moist = clamp01((0.22 + 0.62 * wet) * (0.35 + 0.65 * altDry) * (0.3 + 0.7 * slopeDry));
      moist *= clamp01(sstep(0.2, 4.0, h));
      moist = Math.min(0.87, moist * mix(meta.vegetation, metaB.vegetation, req.blend * 0.5));
      // Values above 0.89 encode a river channel — see terrain.glsl.
      const river = sstep(5.0, 6.8, Math.log(1 + acc[idx]));
      if (river > 0.02 && h > 0.4) moist = 0.9 + 0.09 * river;

      // sandiness
      const beach = sstep(9.0, 0.3, h) * sstep(0.55, 0.13, slope);
      const shelf = sstep(-34, -0.5, h) * sstep(0.4, 0.09, slope);
      const reef = sstep(-9, -0.6, h) * reefiness * 0.65;
      const sand = clamp01(beachiness * (beach + shelf * 0.9) + reef);

      // curvature AO from two blur scales
      const occ = clamp01(((blurA[idx] - h) / 12) * 0.62 + ((blurB[idx] - h) / 42) * 0.5);
      const ao = clamp01(1 - 0.8 * occ);

      hm[idx * 2] = h;
      hm[idx * 2 + 1] = moist;
      mat[idx * 4] = ((dhx * nl) * 0.5 + 0.5) * 255;
      mat[idx * 4 + 1] = ((dhz * nl) * 0.5 + 0.5) * 255;
      mat[idx * 4 + 2] = sand * 255;
      mat[idx * 4 + 3] = ao * 255;
    }
  }

  /* --- min/max pyramid ------------------------------------------- */
  const nBase = N >> 5;
  const mm = new Float32Array(pyramidTotal(nBase) * 2);
  let off = 0;
  for (let bj = 0; bj < nBase; bj++) {
    for (let bi = 0; bi < nBase; bi++) {
      let lo = 1e9;
      let hiV = -1e9;
      const i1 = Math.min(N - 1, (bi + 1) * 32);
      const j1 = Math.min(N - 1, (bj + 1) * 32);
      for (let j = bj * 32; j <= j1; j++) {
        for (let i = bi * 32; i <= i1; i++) {
          const h = H[j * N + i];
          if (h < lo) lo = h;
          if (h > hiV) hiV = h;
        }
      }
      mm[(bj * nBase + bi) * 2] = lo;
      mm[(bj * nBase + bi) * 2 + 1] = hiV;
    }
  }
  let prevOff = 0;
  let prevN = nBase;
  off = nBase * nBase;
  for (let n = nBase >> 1; n >= 1; n >>= 1) {
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        let lo = 1e9;
        let hiV = -1e9;
        for (let d = 0; d < 4; d++) {
          const ci = i * 2 + (d & 1);
          const cj = j * 2 + (d >> 1);
          const k = (prevOff + cj * prevN + ci) * 2;
          if (mm[k] < lo) lo = mm[k];
          if (mm[k + 1] > hiV) hiV = mm[k + 1];
        }
        mm[(off + j * n + i) * 2] = lo;
        mm[(off + j * n + i) * 2 + 1] = hiV;
      }
    }
    prevOff = off;
    prevN = n;
    off += n * n;
  }

  /* --- prop scatter ---------------------------------------------- */
  const scatter = new Float32Array(req.scatterMax * SCATTER_STRIDE);
  let sc = 0;
  {
    const spacing = 17;
    const gn = Math.max(4, Math.floor(extent / spacing));
    const gstep = extent / gn;
    const veg = mix(meta.vegetation, metaB.vegetation, req.blend * 0.5);
    for (let gj = 0; gj < gn && sc < req.scatterMax; gj++) {
      for (let gi = 0; gi < gn && sc < req.scatterMax; gi++) {
        const hsh = ihash2(gi, gj, req.seed + 4441);
        // Jittered grid — cheap Poisson-disc stand-in with no rejection loop.
        const jx = ((hsh & 1023) / 1023 - 0.5) * 0.92;
        const jz = (((hsh >>> 10) & 1023) / 1023 - 0.5) * 0.92;
        const lx = (gi + 0.5 + jx) * gstep - extent * 0.5;
        const lz = (gj + 0.5 + jz) * gstep - extent * 0.5;
        const fi = (lx / extent + 0.5) * (N - 1);
        const fj = (lz / extent + 0.5) * (N - 1);
        if (fi < 1 || fj < 1 || fi > N - 2 || fj > N - 2) continue;
        const ii = fi | 0;
        const jjc = fj | 0;
        const idx = jjc * N + ii;
        const h = H[idx];
        if (h < 0.9 || h > 520) continue;
        const dhx = (H[idx - 1] - H[idx + 1]) / (2 * cell);
        const dhz = (H[idx - N] - H[idx + N]) / (2 * cell);
        const slope = Math.sqrt(dhx * dhx + dhz * dhz);
        if (slope > 1.15) continue;
        const m = hm[idx * 2 + 1];
        const moist = m > 0.89 ? 0.8 : m;
        const u = ((hsh >>> 20) & 4095) / 4095;
        const dens = clamp01(moist * 1.25) * (1 - sstep(0.6, 1.15, slope)) * veg;
        if (u > dens) continue;
        // Species from a second hash so density and species are uncorrelated.
        const h2 = ihash2(gi + 977, gj - 613, req.seed + 8887);
        const su = (h2 & 65535) / 65535;
        let species = speciesFor(meta, su);
        if (h < 2.2 && species === SPECIES.pine) species = SPECIES.scrub;
        if (species === SPECIES.mangrove && (h > 2.6 || h < 0.2)) species = SPECIES.palm;
        if (h > 260 && species !== SPECIES.pine) species = SPECIES.scrub;
        const o = sc * SCATTER_STRIDE;
        scatter[o] = lx;
        scatter[o + 1] = lz;
        scatter[o + 2] = h;
        scatter[o + 3] = 0.7 + (((h2 >>> 16) & 255) / 255) * 0.65;
        scatter[o + 4] = (((h2 >>> 24) & 255) / 255) * Math.PI * 2;
        scatter[o + 5] = species;
        scatter[o + 6] = (((hsh >>> 12) & 255) / 255) * 2 - 1;
        scatter[o + 7] = ((hsh >>> 4) & 1023) / 1023;
        sc++;
      }
    }
  }

  /* --- landmark siting ------------------------------------------- */
  const lms = new Float32Array(96 * LM_STRIDE);
  let lc = 0;
  const push = (kind: number, lx: number, lz: number, y: number, rot: number, scale: number, a = 0, b = 0): void => {
    if (lc >= 96) return;
    const o = lc * LM_STRIDE;
    lms[o] = kind;
    lms[o + 1] = lx;
    lms[o + 2] = lz;
    lms[o + 3] = y;
    lms[o + 4] = rot;
    lms[o + 5] = scale;
    lms[o + 6] = a;
    lms[o + 7] = b;
    lc++;
  };
  const at = (i: number, j: number): number => H[Math.min(N - 1, Math.max(0, j)) * N + Math.min(N - 1, Math.max(0, i))];
  const localX = (i: number): number => (i * inv - 0.5) * extent;

  if (landCells > 40) {
    const swx = Math.sin(req.swellBearing + Math.PI);
    const swz = -Math.cos(req.swellBearing + Math.PI);

    // Coastal candidates, subsampled for speed.
    let bestLight = -1;
    let bestLightScore = -1e9;
    let bestBay = -1;
    let bestBayScore = -1e9;
    for (let j = 3; j < N - 3; j += 2) {
      for (let i = 3; i < N - 3; i += 2) {
        const idx = j * N + i;
        const h = H[idx];
        if (h < 0.6) continue;
        if (at(i - 2, j) > 0 && at(i + 2, j) > 0 && at(i, j - 2) > 0 && at(i, j + 2) > 0) continue;
        const dhx = (at(i - 1, j) - at(i + 1, j)) / (2 * cell);
        const dhz = (at(i, j - 1) - at(i, j + 1)) / (2 * cell);
        const gl = Math.sqrt(dhx * dhx + dhz * dhz) + 1e-4;
        // Outward normal points down-slope, i.e. toward open water.
        const ox = dhx / gl;
        const oz = dhz / gl;
        const exposure = ox * swx + oz * swz;
        const lx = localX(i);
        const lz = localX(j);
        const rad = Math.sqrt(lx * lx + lz * lz);
        const lightScore = (h > 6 && h < 110 ? 1 : 0) * (rad * 0.01 + h * 0.5 + exposure * 60);
        if (lightScore > bestLightScore) {
          bestLightScore = lightScore;
          bestLight = idx;
        }
        const bayScore = (h > 0.8 && h < 14 ? 1 : 0) * (-exposure * 60 - gl * 25 + rad * 0.004);
        if (bayScore > bestBayScore) {
          bestBayScore = bayScore;
          bestBay = idx;
        }
      }
    }

    const lightRoll = ((ihash2(1, 2, req.seed) & 1023) / 1023) * 1.4;
    if (bestLight >= 0 && (req.forceLandmarks || lightRoll < meta.lighthouse)) {
      const i = bestLight % N;
      const j = (bestLight / N) | 0;
      push(LM.lighthouse, localX(i), localX(j), Math.max(3, H[bestLight]), 0, 1);
    }

    const setRoll = ((ihash2(5, 8, req.seed) & 1023) / 1023) * 1.35;
    if (bestBay >= 0 && (req.forceLandmarks || setRoll < meta.settlement)) {
      const bi = bestBay % N;
      const bj = (bestBay / N) | 0;
      const bx = localX(bi);
      const bz = localX(bj);
      const want = 7 + ((ihash2(11, 13, req.seed) >>> 3) % 12);
      let placed = 0;
      const usedX: number[] = [];
      const usedZ: number[] = [];
      // Spiral outward from the bay head; buildings follow the contour.
      for (let k = 1; k < 900 && placed < want; k++) {
        const ang = k * 2.399963;
        const rad = 14 + Math.sqrt(k) * 20;
        const lx = bx + Math.cos(ang) * rad;
        const lz = bz + Math.sin(ang) * rad;
        const fi = (lx / extent + 0.5) * (N - 1);
        const fj = (lz / extent + 0.5) * (N - 1);
        if (fi < 2 || fj < 2 || fi > N - 3 || fj > N - 3) continue;
        const ii = fi | 0;
        const jj = fj | 0;
        const h = H[jj * N + ii];
        if (h < 1.4 || h > 55) continue;
        const dhx = (at(ii - 1, jj) - at(ii + 1, jj)) / (2 * cell);
        const dhz = (at(ii, jj - 1) - at(ii, jj + 1)) / (2 * cell);
        if (Math.sqrt(dhx * dhx + dhz * dhz) > 0.3) continue;
        let clash = false;
        for (let u = 0; u < usedX.length; u++) {
          const ddx = usedX[u] - lx;
          const ddz = usedZ[u] - lz;
          if (ddx * ddx + ddz * ddz < 13 * 13) {
            clash = true;
            break;
          }
        }
        if (clash) continue;
        usedX.push(lx);
        usedZ.push(lz);
        // Ridge line of the roof runs along the contour.
        push(LM.house, lx, lz, h, Math.atan2(dhx, dhz), 0.8 + ((ihash2(k, 3, req.seed) & 255) / 255) * 0.6, k % 3);
        placed++;
      }
      if (placed > 2) {
        const dhx = (at(bi - 1, bj) - at(bi + 1, bj)) / (2 * cell);
        const dhz = (at(bi, bj - 1) - at(bi, bj + 1)) / (2 * cell);
        const gl = Math.sqrt(dhx * dhx + dhz * dhz) + 1e-4;
        const seaward = Math.atan2(dhx / gl, dhz / gl);
        push(LM.quay, bx, bz, Math.max(0.9, H[bestBay]), seaward, 1);
        push(LM.mole, bx, bz, 0, seaward, 1, 90 + (placed * 4));
        push(LM.boathouse, bx + Math.cos(seaward + 1.4) * 26, bz + Math.sin(seaward + 1.4) * 26, Math.max(1.2, H[bestBay]), seaward, 1);
        push(LM.nets, bx + Math.cos(seaward - 1.2) * 20, bz + Math.sin(seaward - 1.2) * 20, Math.max(1.2, H[bestBay]), seaward, 1);

        // Fort on the highest ground within 800 m of the harbour.
        let fi = -1;
        let fscore = -1e9;
        for (let j = 3; j < N - 3; j += 3) {
          for (let i = 3; i < N - 3; i += 3) {
            const idx = j * N + i;
            const h = H[idx];
            if (h < 18 || h > 190) continue;
            const ddx = localX(i) - bx;
            const ddz = localX(j) - bz;
            const d2 = ddx * ddx + ddz * ddz;
            if (d2 > 800 * 800) continue;
            const s = h - Math.sqrt(d2) * 0.05;
            if (s > fscore) {
              fscore = s;
              fi = idx;
            }
          }
        }
        if (fi >= 0 && (ihash2(17, 19, req.seed) & 255) < 150) {
          push(LM.fort, localX(fi % N), localX((fi / N) | 0), H[fi], ((ihash2(21, 4, req.seed) & 255) / 255) * 6.28, 1);
        }
        // Chapel a few hundred metres inland on a rise.
        for (let k = 6; k < 120; k++) {
          const ang = k * 2.399963 + 1.1;
          const rad = 120 + Math.sqrt(k) * 30;
          const lx = bx + Math.cos(ang) * rad;
          const lz = bz + Math.sin(ang) * rad;
          const fii = ((lx / extent + 0.5) * (N - 1)) | 0;
          const fjj = ((lz / extent + 0.5) * (N - 1)) | 0;
          if (fii < 2 || fjj < 2 || fii > N - 3 || fjj > N - 3) continue;
          const h = H[fjj * N + fii];
          if (h < 12 || h > 90) continue;
          push(LM.chapel, lx, lz, h, Math.atan2(bx - lx, bz - lz), 1);
          break;
        }
        // Terrace walls on the workable slopes above the village.
        for (let k = 2; k < 300 && lc < 80; k += 3) {
          const ang = k * 2.399963 + 0.4;
          const rad = 60 + Math.sqrt(k) * 26;
          const lx = bx + Math.cos(ang) * rad;
          const lz = bz + Math.sin(ang) * rad;
          const fii = ((lx / extent + 0.5) * (N - 1)) | 0;
          const fjj = ((lz / extent + 0.5) * (N - 1)) | 0;
          if (fii < 2 || fjj < 2 || fii > N - 3 || fjj > N - 3) continue;
          const h = H[fjj * N + fii];
          if (h < 8 || h > 120) continue;
          const dx2 = (at(fii - 1, fjj) - at(fii + 1, fjj)) / (2 * cell);
          const dz2 = (at(fii, fjj - 1) - at(fii, fjj + 1)) / (2 * cell);
          const sl = Math.sqrt(dx2 * dx2 + dz2 * dz2);
          if (sl < 0.12 || sl > 0.42) continue;
          push(LM.wall, lx, lz, h, Math.atan2(dx2, dz2) + Math.PI * 0.5, 1, 26 + (k % 5) * 9);
        }
      }
    }

    // Windmill on an exposed ridge.
    if ((ihash2(23, 29, req.seed) & 255) < 74) {
      let wi = -1;
      let ws = -1e9;
      for (let j = 4; j < N - 4; j += 4) {
        for (let i = 4; i < N - 4; i += 4) {
          const idx = j * N + i;
          const h = H[idx];
          if (h < 25 || h > 220) continue;
          const conv = h * 4 - (at(i - 3, j) + at(i + 3, j) + at(i, j - 3) + at(i, j + 3));
          if (conv > ws) {
            ws = conv;
            wi = idx;
          }
        }
      }
      if (wi >= 0) push(LM.windmill, localX(wi % N), localX((wi / N) | 0), H[wi], 0, 1);
    }

    // Ruin on a remote coastal spur.
    {
      const hh = ihash2(31, 37, req.seed);
      if ((hh & 255) < 120) {
        const ang = ((hh >>> 8) & 4095) / 4095 * Math.PI * 2;
        for (let k = 0; k < 40; k++) {
          const rad = req.radiusM * (0.9 - k * 0.02);
          const lx = Math.cos(ang) * rad;
          const lz = Math.sin(ang) * rad;
          const fii = ((lx / extent + 0.5) * (N - 1)) | 0;
          const fjj = ((lz / extent + 0.5) * (N - 1)) | 0;
          if (fii < 2 || fjj < 2 || fii > N - 3 || fjj > N - 3) continue;
          const h = H[fjj * N + fii];
          if (h < 6 || h > 120) continue;
          push(LM.ruin, lx, lz, h, ang, 1);
          break;
        }
      }
    }

    // Sea stacks and an arch on steep coasts; a wreck on a shallow reef.
    {
      let stacks = 0;
      const wantStacks = meta.beachiness < 0.7 ? 4 : 1;
      for (let k = 0; k < 700 && stacks < wantStacks; k++) {
        const hh = ihash2(k, 71, req.seed + 55);
        const ang = (hh & 4095) / 4095 * Math.PI * 2;
        const rad = req.radiusM * (1.02 + ((hh >>> 12) & 1023) / 1023 * 0.16);
        const lx = Math.cos(ang) * rad;
        const lz = Math.sin(ang) * rad;
        const fii = ((lx / extent + 0.5) * (N - 1)) | 0;
        const fjj = ((lz / extent + 0.5) * (N - 1)) | 0;
        if (fii < 2 || fjj < 2 || fii > N - 3 || fjj > N - 3) continue;
        const h = H[fjj * N + fii];
        if (h > -1.5 || h < -22) continue;
        push(stacks === 1 && wantStacks > 2 ? LM.arch : LM.stack, lx, lz, h, ang, 0.7 + ((hh >>> 22) & 255) / 255 * 0.8);
        stacks++;
      }
      if (reefiness > 0.4 && (ihash2(41, 43, req.seed) & 255) < 96) {
        for (let k = 0; k < 400; k++) {
          const hh = ihash2(k, 97, req.seed + 13);
          const ang = (hh & 4095) / 4095 * Math.PI * 2;
          const rad = req.radiusM * (1.0 + ((hh >>> 12) & 1023) / 1023 * 0.22);
          const lx = Math.cos(ang) * rad;
          const lz = Math.sin(ang) * rad;
          const fii = ((lx / extent + 0.5) * (N - 1)) | 0;
          const fjj = ((lz / extent + 0.5) * (N - 1)) | 0;
          if (fii < 2 || fjj < 2 || fii > N - 3 || fjj > N - 3) continue;
          const h = H[fjj * N + fii];
          if (h > -1.0 || h < -7) continue;
          push(LM.wreck, lx, lz, h, ang + 1.1, 1);
          break;
        }
      }
    }
  }

  return {
    id: req.id,
    gridN: N,
    extentM: extent,
    hm,
    mat,
    mm,
    scatter,
    scatterCount: sc,
    landmarks: lms,
    landmarkCount: lc,
    maxHeight,
    landRadius,
    landFraction: landCells / (N * N),
    genMs: performance.now() - t0,
  };
}

ctx.onmessage = (ev: MessageEvent<GenRequest>) => {
  const res = generate(ev.data);
  ctx.postMessage(res, [
    res.hm.buffer,
    res.mat.buffer,
    res.mm.buffer,
    res.scatter.buffer,
    res.landmarks.buffer,
  ]);
};
