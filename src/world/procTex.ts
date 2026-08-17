import * as THREE from 'three';
import { ihash2 } from './wnoise';

/**
 * Procedural terrain and foliage textures, generated once at init. Everything is
 * tileable: the lattice indices wrap on the texture period, so RepeatWrapping
 * never shows a seam. 128px is plenty at the 3-13 m tiling periods the terrain
 * shader uses, and keeps init under ~80 ms.
 */

const TEX = 128;

const GRAD = (() => {
  const g = new Float32Array(512);
  for (let i = 0; i < 256; i++) {
    const a = (i / 256) * Math.PI * 2 + 0.17;
    g[i * 2] = Math.cos(a);
    g[i * 2 + 1] = Math.sin(a);
  }
  return g;
})();

function wrap(v: number, p: number): number {
  return ((v % p) + p) % p;
}

/** Tileable gradient noise with period `p` lattice cells. */
function tnoise(x: number, y: number, p: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const x0 = wrap(ix, p);
  const y0 = wrap(iy, p);
  const x1 = wrap(ix + 1, p);
  const y1 = wrap(iy + 1, p);
  const i00 = (ihash2(x0, y0, seed) & 255) << 1;
  const i10 = (ihash2(x1, y0, seed) & 255) << 1;
  const i01 = (ihash2(x0, y1, seed) & 255) << 1;
  const i11 = (ihash2(x1, y1, seed) & 255) << 1;
  const a = GRAD[i00] * fx + GRAD[i00 + 1] * fy;
  const b = GRAD[i10] * (fx - 1) + GRAD[i10 + 1] * fy;
  const c = GRAD[i01] * fx + GRAD[i01 + 1] * (fy - 1);
  const d = GRAD[i11] * (fx - 1) + GRAD[i11 + 1] * (fy - 1);
  const ab = a + (b - a) * ux;
  const cd = c + (d - c) * ux;
  return (ab + (cd - ab) * uy) * 1.414;
}

function tfbm(x: number, y: number, p: number, seed: number, oct: number): number {
  let s = 0;
  let amp = 0.5;
  let norm = 0;
  let f = 1;
  for (let i = 0; i < oct; i++) {
    s += amp * tnoise(x * f, y * f, p * f, seed + i * 811);
    norm += amp;
    f *= 2;
    amp *= 0.5;
  }
  return s / norm;
}

const wt = new Float32Array(3);

/** Tileable Worley on a period-p jittered grid. */
function tworley(x: number, y: number, p: number, seed: number): Float32Array {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  let f1 = 1e9;
  let f2 = 1e9;
  let id = 0;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const h = ihash2(wrap(ix + i, p), wrap(iy + j, p), seed);
      const jx = ix + i + (h & 1023) / 1023;
      const jy = iy + j + ((h >>> 10) & 1023) / 1023;
      const dx = jx - x;
      const dy = jy - y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < f1) {
        f2 = f1;
        f1 = d;
        id = h;
      } else if (d < f2) f2 = d;
    }
  }
  wt[0] = f1;
  wt[1] = f2;
  wt[2] = ((id >>> 20) & 4095) / 4095;
  return wt;
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Height + tint + roughness for one material layer. */
function materialCell(layer: number, u: number, v: number, out: Float32Array): void {
  switch (layer) {
    case 0: {
      // rock — fractured, blocky, with joint cracks
      const w = tworley(u * 5, v * 5, 5, 91);
      const crack = 1 - smooth(0.0, 0.075, w[1] - w[0]);
      const facet = 0.45 + w[2] * 0.35;
      const rough = tfbm(u * 14, v * 14, 14, 17, 4) * 0.5 + 0.5;
      let h = facet * 0.55 + rough * 0.45;
      h -= crack * 0.55;
      out[0] = Math.max(0, Math.min(1, h));
      out[1] = 0.55 + rough * 0.5 - crack * 0.3;
      out[2] = 0.82 + rough * 0.14;
      break;
    }
    case 1: {
      // sand — fine grain plus wind ripples
      const rip = Math.sin(u * Math.PI * 2 * 9 + tfbm(u * 3, v * 3, 3, 41, 3) * 5.5) * 0.5 + 0.5;
      const grain = tfbm(u * 42, v * 42, 42, 7, 3) * 0.5 + 0.5;
      const clump = tfbm(u * 7, v * 7, 7, 61, 3) * 0.5 + 0.5;
      out[0] = rip * 0.42 + grain * 0.3 + clump * 0.28;
      out[1] = 0.86 + grain * 0.22 + clump * 0.1;
      out[2] = 0.88 + grain * 0.08;
      break;
    }
    case 2: {
      // grass / low scrub — clumpy tufts
      const w = tworley(u * 11, v * 11, 11, 33);
      const tuft = 1 - smooth(0.05, 0.55, w[0]);
      const fine = tfbm(u * 30, v * 30, 30, 71, 3) * 0.5 + 0.5;
      out[0] = tuft * 0.68 + fine * 0.32;
      out[1] = 0.6 + tuft * 0.55 + w[2] * 0.25;
      out[2] = 0.93 + fine * 0.06;
      break;
    }
    default: {
      // scree — packed pebbles
      const w = tworley(u * 16, v * 16, 16, 53);
      const pebble = Math.sqrt(Math.max(0, 1 - Math.min(1, w[0] / 0.42) ** 2));
      const grit = tfbm(u * 36, v * 36, 36, 23, 3) * 0.5 + 0.5;
      out[0] = pebble * 0.7 + grit * 0.3;
      out[1] = 0.5 + w[2] * 0.7 + grit * 0.2;
      out[2] = 0.86 + grit * 0.1;
      break;
    }
  }
}

export interface DetailTextures {
  albedo: THREE.DataArrayTexture;
  normal: THREE.DataArrayTexture;
  dispose(): void;
}

export function createDetailTextures(): DetailTextures {
  const layers = 4;
  const alb = new Uint8Array(TEX * TEX * 4 * layers);
  const nrm = new Uint8Array(TEX * TEX * 4 * layers);
  const height = new Float32Array(TEX * TEX);
  const tint = new Float32Array(TEX * TEX);
  const rough = new Float32Array(TEX * TEX);
  const cell = new Float32Array(3);

  for (let l = 0; l < layers; l++) {
    for (let j = 0; j < TEX; j++) {
      for (let i = 0; i < TEX; i++) {
        materialCell(l, i / TEX, j / TEX, cell);
        const k = j * TEX + i;
        height[k] = cell[0];
        tint[k] = cell[1];
        rough[k] = cell[2];
      }
    }
    const base = l * TEX * TEX * 4;
    // Normal strength is per-material: rock reads as rock only when its detail
    // normal is strong; sand needs almost none or it looks like gravel.
    const strength = l === 0 ? 3.2 : l === 1 ? 0.85 : l === 2 ? 1.5 : 2.2;
    for (let j = 0; j < TEX; j++) {
      for (let i = 0; i < TEX; i++) {
        const k = j * TEX + i;
        const o = base + k * 4;
        const t = tint[k];
        alb[o] = Math.min(255, t * 210);
        alb[o + 1] = Math.min(255, t * 208);
        alb[o + 2] = Math.min(255, t * 204);
        alb[o + 3] = Math.min(255, height[k] * 255);

        const xm = height[j * TEX + ((i - 1 + TEX) % TEX)];
        const xp = height[j * TEX + ((i + 1) % TEX)];
        const zm = height[((j - 1 + TEX) % TEX) * TEX + i];
        const zp = height[((j + 1) % TEX) * TEX + i];
        let nx = -(xp - xm) * strength * 0.5;
        let nz = -(zp - zm) * strength * 0.5;
        const inv = 1 / Math.sqrt(nx * nx + nz * nz + 1);
        nx *= inv;
        nz *= inv;
        nrm[o] = (nx * 0.5 + 0.5) * 255;
        nrm[o + 1] = (nz * 0.5 + 0.5) * 255;
        nrm[o + 2] = Math.min(255, (0.42 + height[k] * 0.6) * 255);
        nrm[o + 3] = Math.min(255, rough[k] * 255);
      }
    }
  }

  const mk = (data: Uint8Array): THREE.DataArrayTexture => {
    const t = new THREE.DataArrayTexture(data, TEX, TEX, layers);
    t.format = THREE.RGBAFormat;
    t.type = THREE.UnsignedByteType;
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 4;
    t.needsUpdate = true;
    return t;
  };

  const albedo = mk(alb);
  const normal = mk(nrm);
  // Albedo is authored as reflectance typed by eye, so it must be decoded.
  albedo.colorSpace = THREE.SRGBColorSpace;
  normal.colorSpace = THREE.NoColorSpace;

  return {
    albedo,
    normal,
    dispose() {
      albedo.dispose();
      normal.dispose();
    },
  };
}

/* ------------------------------------------------------------------ *
 *  foliage
 * ------------------------------------------------------------------ */

/**
 * Leaf-cluster texture used by broadleaf canopies and scrub. Alpha is a soft
 * blob broken up by leaf-sized worley cells so the silhouette is organic.
 */
export function createLeafTexture(size = 128): THREE.DataTexture {
  const d = new Uint8Array(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const u = i / (size - 1);
      const v = j / (size - 1);
      const dx = u - 0.5;
      const dy = v - 0.5;
      const r = Math.sqrt(dx * dx + dy * dy) * 2;
      const w = tworley(u * 9, v * 9, 9, 301);
      const leaf = 1 - smooth(0.1, 0.5, w[0]);
      const edge = 1 - smooth(0.55, 1.0, r);
      const a = Math.max(0, Math.min(1, edge * (0.35 + leaf * 0.9) - 0.14)) ;
      const shade = 0.55 + leaf * 0.5 + w[2] * 0.25;
      const o = (j * size + i) * 4;
      d[o] = Math.min(255, shade * 150);
      d[o + 1] = Math.min(255, shade * 205);
      d[o + 2] = Math.min(255, shade * 120);
      d[o + 3] = Math.min(255, a * 255 * 1.6);
    }
  }
  const t = new THREE.DataTexture(d, size, size, THREE.RGBAFormat);
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

/** Rendering-friendly stone/plaster texture for buildings, harbour walls, forts. */
export function createStoneTexture(size = 128): THREE.DataTexture {
  const d = new Uint8Array(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const u = i / size;
      const v = j / size;
      // Running-bond courses.
      const course = Math.floor(v * 14);
      const off = (course & 1) * 0.5;
      const bx = (u * 7 + off) % 1;
      const by = v * 14 - course;
      const mortar =
        smooth(0.0, 0.07, bx) * smooth(1.0, 0.93, bx) * smooth(0.0, 0.12, by) * smooth(1.0, 0.88, by);
      const grain = tfbm(u * 26, v * 26, 26, 131, 3) * 0.5 + 0.5;
      const stone = 0.62 + grain * 0.42;
      const val = mortar * stone + (1 - mortar) * 0.42;
      const o = (j * size + i) * 4;
      d[o] = Math.min(255, val * 232);
      d[o + 1] = Math.min(255, val * 224);
      d[o + 2] = Math.min(255, val * 208);
      d[o + 3] = Math.min(255, (0.35 + mortar * 0.65) * 255);
    }
  }
  const t = new THREE.DataTexture(d, size, size, THREE.RGBAFormat);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}
