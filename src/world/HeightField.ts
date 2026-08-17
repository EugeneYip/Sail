import * as THREE from 'three';
import type { GenResult } from './api';

/** Patch resolution: 33x33 vertices, 2048 triangles per quadtree node. */
export const PATCH = 32;
/** A node of size S is adequate out to S * LOD_FACTOR metres. */
export const LOD_FACTOR = 5.2;

/**
 * CPU mirror of one island's generated heightfield: the same bilinear
 * interpolation the vertex shader performs, plus the CDLOD node selector.
 *
 * Grid convention (identical in gen.worker.ts and wcommon.ts):
 *   texel i  <->  island-local metres  lx = (i / (n - 1) - 0.5) * extent
 */
export class HeightField {
  readonly n: number;
  readonly extent: number;
  readonly cell: number;
  readonly hm: Float32Array;
  readonly mat: Uint8Array;
  readonly mm: Float32Array;
  readonly nBase: number;
  readonly maxLevel: number;
  readonly maxHeight: number;
  readonly landRadius: number;
  /** Per-level byte offset into `mm`, in nodes. */
  private readonly mmOff: Int32Array;

  constructor(res: GenResult) {
    this.n = res.gridN;
    this.extent = res.extentM;
    this.cell = res.extentM / (res.gridN - 1);
    this.hm = res.hm;
    this.mat = res.mat;
    this.mm = res.mm;
    this.nBase = res.gridN >> 5;
    this.maxLevel = Math.round(Math.log2(this.nBase));
    this.maxHeight = res.maxHeight;
    this.landRadius = res.landRadius;
    this.mmOff = new Int32Array(this.maxLevel + 1);
    let off = 0;
    for (let l = 0; l <= this.maxLevel; l++) {
      this.mmOff[l] = off;
      const s = this.nBase >> l;
      off += s * s;
    }
  }

  /** Node edge length in metres at a LOD level (0 = finest). */
  nodeSize(level: number): number {
    return (this.extent * (1 << level)) / this.nBase;
  }

  height(lx: number, lz: number): number {
    const n = this.n;
    const t = (lx / this.extent + 0.5) * (n - 1);
    const u = (lz / this.extent + 0.5) * (n - 1);
    let i0 = Math.floor(t);
    let j0 = Math.floor(u);
    const fx = t - i0;
    const fz = u - j0;
    const i1 = i0 + 1 < 0 ? 0 : i0 + 1 > n - 1 ? n - 1 : i0 + 1;
    const j1 = j0 + 1 < 0 ? 0 : j0 + 1 > n - 1 ? n - 1 : j0 + 1;
    i0 = i0 < 0 ? 0 : i0 > n - 1 ? n - 1 : i0;
    j0 = j0 < 0 ? 0 : j0 > n - 1 ? n - 1 : j0;
    const hm = this.hm;
    const h00 = hm[(j0 * n + i0) * 2];
    const h10 = hm[(j0 * n + i1) * 2];
    const h01 = hm[(j1 * n + i0) * 2];
    const h11 = hm[(j1 * n + i1) * 2];
    const a = h00 + (h10 - h00) * fx;
    const b = h01 + (h11 - h01) * fx;
    return a + (b - a) * fz;
  }

  /** Nearest-texel channel read: 0 = moisture, and mat 0..3. */
  moistureAt(lx: number, lz: number): number {
    const i = this.clampIdx((lx / this.extent + 0.5) * (this.n - 1));
    const j = this.clampIdx((lz / this.extent + 0.5) * (this.n - 1));
    return this.hm[(j * this.n + i) * 2 + 1];
  }

  matAt(lx: number, lz: number, ch: number): number {
    const i = this.clampIdx((lx / this.extent + 0.5) * (this.n - 1));
    const j = this.clampIdx((lz / this.extent + 0.5) * (this.n - 1));
    return this.mat[(j * this.n + i) * 4 + ch] / 255;
  }

  /** Surface normal from the baked channels. */
  normalAt(lx: number, lz: number, out: THREE.Vector3): THREE.Vector3 {
    const nx = this.matAt(lx, lz, 0) * 2 - 1;
    const nz = this.matAt(lx, lz, 1) * 2 - 1;
    const ny = Math.sqrt(Math.max(1e-4, 1 - nx * nx - nz * nz));
    return out.set(nx, ny, nz).normalize();
  }

  private clampIdx(v: number): number {
    const i = Math.round(v);
    return i < 0 ? 0 : i > this.n - 1 ? this.n - 1 : i;
  }

  minAt(level: number, ix: number, iy: number): number {
    return this.mm[(this.mmOff[level] + iy * (this.nBase >> level) + ix) * 2];
  }

  maxAt(level: number, ix: number, iy: number): number {
    return this.mm[(this.mmOff[level] + iy * (this.nBase >> level) + ix) * 2 + 1];
  }
}

/* ------------------------------------------------------------------ *
 *  CDLOD node selection
 * ------------------------------------------------------------------ */

const stack = new Int32Array(3 * 512);
const box = new THREE.Box3();
const bmin = new THREE.Vector3();
const bmax = new THREE.Vector3();

export interface SelectResult {
  terrain: number;
  shore: number;
}

/**
 * Descend the island quadtree and emit the visible node set into two instance
 * buffers: land nodes and shallow-shelf nodes. Each node is
 * `(originX, originZ, size, level)` in island-local metres.
 *
 * The LOD test uses the distance to the node's XZ footprint at y = 0, which is
 * the same value the vertex shader recomputes per vertex, so selection and
 * morphing never disagree.
 */
export function selectNodes(
  hf: HeightField,
  camX: number,
  camZ: number,
  islandX: number,
  islandZ: number,
  lodEnd: Float32Array,
  frustum: THREE.Frustum | null,
  outTerrain: Float32Array,
  outShore: Float32Array,
  maxNodes: number,
  result: SelectResult,
): void {
  let nt = 0;
  let ns = 0;
  const half = hf.extent * 0.5;
  const cx = camX - islandX;
  const cz = camZ - islandZ;

  let sp = 0;
  stack[0] = hf.maxLevel;
  stack[1] = 0;
  stack[2] = 0;
  sp = 3;

  while (sp > 0) {
    sp -= 3;
    const level = stack[sp];
    const ix = stack[sp + 1];
    const iy = stack[sp + 2];
    const size = hf.nodeSize(level);
    const ox = -half + ix * size;
    const oz = -half + iy * size;

    // Distance from the camera to the node footprint, y ignored.
    const dx = cx < ox ? ox - cx : cx > ox + size ? cx - (ox + size) : 0;
    const dz = cz < oz ? oz - cz : cz > oz + size ? cz - (oz + size) : 0;
    const dist = Math.sqrt(dx * dx + dz * dz);

    const nmin = hf.minAt(level, ix, iy);
    const nmax = hf.maxAt(level, ix, iy);

    if (frustum) {
      bmin.set(islandX + ox, nmin - 2, islandZ + oz);
      bmax.set(islandX + ox + size, nmax + 2, islandZ + oz + size);
      box.set(bmin, bmax);
      if (!frustum.intersectsBox(box)) continue;
    }

    if (level > 0 && dist < lodEnd[level - 1] && nt + 4 < maxNodes && sp + 12 < stack.length) {
      const c = level - 1;
      for (let d = 0; d < 4; d++) {
        stack[sp] = c;
        stack[sp + 1] = ix * 2 + (d & 1);
        stack[sp + 2] = iy * 2 + (d >> 1);
        sp += 3;
      }
      continue;
    }

    if (nmax > -55 && nt < maxNodes) {
      const o = nt * 4;
      outTerrain[o] = ox;
      outTerrain[o + 1] = oz;
      outTerrain[o + 2] = size;
      outTerrain[o + 3] = level;
      nt++;
    }
    if (nmin < 1.5 && nmax > -50 && ns < maxNodes) {
      const o = ns * 4;
      outShore[o] = ox;
      outShore[o + 1] = oz;
      outShore[o + 2] = size;
      outShore[o + 3] = level;
      ns++;
    }
  }

  result.terrain = nt;
  result.shore = ns;
}

/** The shared unit patch: positions in [0,1] on XZ, wound so the normal is +Y. */
export function createPatchGeometry(): { position: THREE.BufferAttribute; index: THREE.BufferAttribute } {
  const v = PATCH + 1;
  const pos = new Float32Array(v * v * 3);
  for (let j = 0; j < v; j++) {
    for (let i = 0; i < v; i++) {
      const o = (j * v + i) * 3;
      pos[o] = i / PATCH;
      pos[o + 1] = 0;
      pos[o + 2] = j / PATCH;
    }
  }
  const idx = new Uint16Array(PATCH * PATCH * 6);
  let k = 0;
  for (let j = 0; j < PATCH; j++) {
    for (let i = 0; i < PATCH; i++) {
      const a = j * v + i;
      const b = a + 1;
      const c = a + v;
      const d = c + 1;
      idx[k++] = a;
      idx[k++] = c;
      idx[k++] = b;
      idx[k++] = b;
      idx[k++] = c;
      idx[k++] = d;
    }
  }
  return {
    position: new THREE.BufferAttribute(pos, 3),
    index: new THREE.BufferAttribute(idx, 1),
  };
}
