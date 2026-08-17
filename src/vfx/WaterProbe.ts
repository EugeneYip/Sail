import * as THREE from 'three';
import type { World } from '../types';

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
 */
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
    const fx = (x - this.origin.x) / this.texel - 0.5;
    const fz = (z - this.origin.y) / this.texel - 0.5;
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    const tx = fx - ix;
    const tz = fz - iz;
    const g = (cx: number, cz: number) => {
      const qx = cx < -1 ? -1 : cx > r ? r : cx;
      const qz = cz < -1 ? -1 : cz > r ? r : cz;
      return this.heights[(qz + 1) * (r + 2) + (qx + 1)];
    };
    const a = g(ix, iz);
    const b = g(ix + 1, iz);
    const c = g(ix, iz + 1);
    const d = g(ix + 1, iz + 1);
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
  }

  update(world: World): void {
    const ocean = world.ocean;
    const r = this.res;
    const t = this.texel;

    // Bias the window forward of the ship: that is where the bow spray, the
    // bow wave and the oncoming crests all live.
    const cx = world.ship.position.x;
    const cz = world.ship.position.z;
    this.origin.set(
      Math.floor((cx - this.worldSize * 0.5) / t) * t,
      Math.floor((cz - this.worldSize * 0.5) / t) * t,
    );

    const inv = 1 / this.worldSize;
    this.matrix.set(
      inv, 0, -this.origin.x * inv,
      0, inv, -this.origin.y * inv,
      0, 0, 1,
    );

    // One guard ring so central differences never read out of bounds.
    const stride = r + 2;
    if (ocean) {
      for (let j = -1; j <= r; j++) {
        const wz = this.origin.y + (j + 0.5) * t;
        const row = (j + 1) * stride;
        for (let i = -1; i <= r; i++) {
          this.heights[row + i + 1] = ocean.sampleHeight(this.origin.x + (i + 0.5) * t, wz);
        }
      }
    } else {
      this.heights.fill(0);
    }

    const inv2t = 1 / (2 * t);
    for (let j = 0; j < r; j++) {
      const row = (j + 1) * stride;
      for (let i = 0; i < r; i++) {
        const h = this.heights[row + i + 1];
        const dx = (this.heights[row + i + 2] - this.heights[row + i]) * inv2t;
        const dz = (this.heights[row + stride + i + 1] - this.heights[row - stride + i + 1]) * inv2t;
        // Curvature picks crests out of troughs; slope picks steep faces.
        const lap =
          this.heights[row + i + 2] +
          this.heights[row + i] +
          this.heights[row + stride + i + 1] +
          this.heights[row - stride + i + 1] -
          4 * h;
        const crest = Math.max(0, Math.min(1, -lap * 1.8 + Math.hypot(dx, dz) * 0.9 - 0.05));
        const o = (j * r + i) * 4;
        this.data[o] = h;
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
