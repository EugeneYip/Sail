import * as THREE from 'three';
import type { IOcean, World } from '../types';

/**
 * A coarse CPU-sampled height field of the sea around the ship, uploaded as a
 * small float texture every frame.
 *
 * Four systems need to know where the water actually is:
 *   - GPU spray must die when it hits the surface, and must fade softly as it
 *     approaches it (this is what removes the hard intersection line);
 *   - spindrift must spawn on wave crests;
 *   - the sea-smoke carpet is thicker in troughs;
 *   - splash ripples must be stamped at the real surface height.
 *
 * A texture is the only sane way to hand that to a shader without depending on
 * the ocean agent's internal cascade layout. Resolution is deliberately low —
 * this is for particle interaction, not for shading.
 *
 * Channels (RGBA16F): R = height (m), G = dH/dx, B = dH/dz, A = crest measure
 * (0 in a trough, 1 on a steep crest).
 *
 * PERFORMANCE. Every cell costs one `ocean.sampleHeight`, and the ocean's CPU
 * wave sum is not cheap: a full 50x50 refresh measured 2.4-2.9 ms/frame on its
 * own. Rows are therefore refreshed on an interleaved cycle — every `PHASES`-th
 * row each frame — so two adjacent rows are never more than `PHASES - 1` frames
 * apart in age. At 60 fps that is a sub-centimetre step between neighbouring
 * rows even in a gale, and these consumers use the field for soft fades and
 * crest picking, not for shading.
 */
const PHASES = 3;

/**
 * Crest measure is built from surface curvature, which must be divided by the
 * texel size squared or the number silently changes meaning whenever the grid
 * does. This gain reproduces the original tuning at the original 4.4 m texel.
 */
const CREST_CURV_GAIN = 34.0;

export class WaterProbe {
  /** Metres covered by the whole texture. */
  readonly worldSize: number;
  readonly res: number;
  readonly texture: THREE.DataTexture;
  /** World XZ of the texture's lower-left corner, texel-snapped. */
  readonly origin = new THREE.Vector2();
  /** world XZ -> probe uv. */
  readonly matrix = new THREE.Matrix3();

  private data: Float32Array;
  private heights: Float32Array;
  private texel: number;
  private phase = 0;
  private primed = false;

  constructor(res = 32, worldSize = 240) {
    this.res = res;
    this.worldSize = worldSize;
    this.texel = worldSize / res;
    this.data = new Float32Array(res * res * 4);
    this.heights = new Float32Array((res + 2) * (res + 2));
    this.texture = new THREE.DataTexture(
      this.data,
      res,
      res,
      THREE.RGBAFormat,
      THREE.FloatType,
    );
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.wrapS = this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.colorSpace = THREE.NoColorSpace;
    this.texture.needsUpdate = true;
  }

  /** Height at a world XZ, bilinear from the cached grid. Cheap, no ocean call. */
  heightAt(x: number, z: number): number {
    const r = this.res;
    const stride = r + 2;
    const fx = (x - this.origin.x) / this.texel - 0.5;
    const fz = (z - this.origin.y) / this.texel - 0.5;
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    const tx = fx - ix;
    const tz = fz - iz;
    // Grid index is cell + 1 because of the guard ring; clamp to the ring.
    const last = stride - 1;
    const gx0 = ix < -1 ? 0 : ix > r ? last : ix + 1;
    const gx1 = ix < -2 ? 0 : ix + 1 > r ? last : ix + 2;
    const gz0 = (iz < -1 ? 0 : iz > r ? last : iz + 1) * stride;
    const gz1 = (iz < -2 ? 0 : iz + 1 > r ? last : iz + 2) * stride;
    const h = this.heights;
    const a = h[gz0 + gx0];
    const b = h[gz0 + gx1];
    const c = h[gz1 + gx0];
    const d = h[gz1 + gx1];
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
  }

  /** Sample grid columns [i0, i1) of grid row `j` straight from the ocean. */
  private sampleRow(ocean: IOcean, j: number, i0: number, i1: number): void {
    const stride = this.res + 2;
    const t = this.texel;
    const wz = this.origin.y + (j - 0.5) * t;
    const x0 = this.origin.x - 0.5 * t;
    const row = j * stride;
    const h = this.heights;
    for (let i = i0; i < i1; i++) h[row + i] = ocean.sampleHeight(x0 + i * t, wz);
  }

  /**
   * Slide the cached heights by a whole number of texels so a moving window
   * keeps its samples instead of re-sampling the whole grid. Returns nothing;
   * the caller re-samples the exposed border.
   */
  private shift(dix: number, diz: number): void {
    const stride = this.res + 2;
    const h = this.heights;
    const rowStep = diz > 0 ? 1 : -1;
    const jStart = diz > 0 ? 0 : stride - 1;
    const jEnd = diz > 0 ? stride : -1;
    for (let jd = jStart; jd !== jEnd; jd += rowStep) {
      const js = jd + diz;
      if (js < 0 || js >= stride) continue;
      const dst = jd * stride;
      const src = js * stride;
      if (dix >= 0) h.copyWithin(dst, src + dix, src + stride);
      else h.copyWithin(dst - dix, src, src + stride + dix);
    }
  }

  update(world: World): void {
    const ocean = world.ocean;
    const r = this.res;
    const t = this.texel;
    const stride = r + 2;

    const cx = world.ship.position.x;
    const cz = world.ship.position.z;
    const ox = Math.floor((cx - this.worldSize * 0.5) / t) * t;
    const oz = Math.floor((cz - this.worldSize * 0.5) / t) * t;

    let full = !this.primed || !ocean;
    let dix = 0;
    let diz = 0;
    if (!full) {
      dix = Math.round((ox - this.origin.x) / t);
      diz = Math.round((oz - this.origin.y) / t);
      if (Math.abs(dix) >= stride || Math.abs(diz) >= stride) full = true;
    }
    this.origin.set(ox, oz);

    const inv = 1 / this.worldSize;
    this.matrix.set(
      inv, 0, -this.origin.x * inv,
      0, inv, -this.origin.y * inv,
      0, 0, 1,
    );

    if (!ocean) {
      this.heights.fill(0);
    } else if (full) {
      for (let j = 0; j < stride; j++) this.sampleRow(ocean, j, 0, stride);
      this.primed = true;
    } else {
      if (dix !== 0 || diz !== 0) {
        this.shift(dix, diz);
        // Rows the row-shift left undefined, then columns the column-shift did.
        const jNew0 = diz > 0 ? stride - diz : 0;
        const jNew1 = diz > 0 ? stride : -diz;
        for (let j = jNew0; j < jNew1; j++) this.sampleRow(ocean, j, 0, stride);
        if (dix !== 0) {
          const iNew0 = dix > 0 ? stride - dix : 0;
          const iNew1 = dix > 0 ? stride : -dix;
          for (let j = 0; j < stride; j++) {
            if (j >= jNew0 && j < jNew1) continue;
            this.sampleRow(ocean, j, iNew0, iNew1);
          }
        }
      }
      // Interleaved refresh: every PHASES-th row, so neighbours stay in step.
      for (let j = this.phase; j < stride; j += PHASES) this.sampleRow(ocean, j, 0, stride);
    }
    this.phase = (this.phase + 1) % PHASES;

    const inv2t = 1 / (2 * t);
    const invt2 = CREST_CURV_GAIN / (t * t);
    const h = this.heights;
    for (let j = 0; j < r; j++) {
      const row = (j + 1) * stride;
      for (let i = 0; i < r; i++) {
        const c = h[row + i + 1];
        const xp = h[row + i + 2];
        const xm = h[row + i];
        const zp = h[row + stride + i + 1];
        const zm = h[row - stride + i + 1];
        const dx = (xp - xm) * inv2t;
        const dz = (zp - zm) * inv2t;
        // Curvature picks crests out of troughs; slope picks steep faces.
        const lap = xp + xm + zp + zm - 4 * c;
        const crest = Math.max(0, Math.min(1, -lap * invt2 + Math.hypot(dx, dz) * 0.9 - 0.05));
        const o = (j * r + i) * 4;
        this.data[o] = c;
        this.data[o + 1] = dx;
        this.data[o + 2] = dz;
        this.data[o + 3] = crest;
      }
    }
    this.texture.needsUpdate = true;
  }

  /**
   * Pick the steepest crest cell near a jittered grid location. Used by the
   * spindrift emitter; returns false if nothing there is crest-like.
   */
  sampleCell(i: number, j: number, out: THREE.Vector4): boolean {
    if (i < 0 || j < 0 || i >= this.res || j >= this.res) return false;
    const o = (j * this.res + i) * 4;
    out.set(
      this.origin.x + (i + 0.5) * this.texel,
      this.data[o],
      this.origin.y + (j + 0.5) * this.texel,
      this.data[o + 3],
    );
    return out.w > 0.02;
  }

  dispose(): void {
    this.texture.dispose();
  }
}
