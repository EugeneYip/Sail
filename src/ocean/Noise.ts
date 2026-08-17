import * as THREE from 'three';
import { makeRng } from '../util/math';

/**
 * The random half of the wave field, generated once and shared by every
 * cascade and by the CPU sampler.
 *
 * Indexed by *mode number*, not by texel: mode (n, m) lives at texel
 * (n + HALF, m + HALF). That is what makes the CPU mirror exact — a 64x64 CPU
 * grid of the same tile picks the identical random numbers the 256x256 GPU grid
 * uses for those same modes, so the CPU field is the GPU field truncated to the
 * modes it carries rather than a different realisation of the same spectrum.
 *
 * Stored as a Rayleigh amplitude times a uniform phase, which is exactly
 * equivalent to Tessendorf's (xi_r + i xi_i)/sqrt(2) but needs one log instead
 * of a Box-Muller pair.
 */
export const NOISE_SIZE = 512;
export const NOISE_HALF = NOISE_SIZE / 2;

export class SpectralNoise {
  readonly texture: THREE.DataTexture;
  /** Interleaved (re, im) per mode, row-major over (m + HALF, n + HALF). */
  readonly data: Float32Array;

  constructor(seed: number) {
    const n = NOISE_SIZE;
    this.data = new Float32Array(n * n * 2);
    const rng = makeRng(seed);
    for (let i = 0; i < n * n; i++) {
      const u = Math.max(rng(), 1e-7);
      const phase = rng() * Math.PI * 2;
      const r = Math.sqrt(-Math.log(u));
      this.data[i * 2] = r * Math.cos(phase);
      this.data[i * 2 + 1] = r * Math.sin(phase);
    }
    this.texture = new THREE.DataTexture(this.data, n, n, THREE.RGFormat, THREE.FloatType);
    this.texture.minFilter = THREE.NearestFilter;
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.wrapS = THREE.RepeatWrapping;
    this.texture.wrapT = THREE.RepeatWrapping;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true;
  }

  /** Real part for mode (n, m). Out-of-range modes read as zero amplitude. */
  re(n: number, m: number): number {
    const i = this.index(n, m);
    return i < 0 ? 0 : this.data[i];
  }

  im(n: number, m: number): number {
    const i = this.index(n, m);
    return i < 0 ? 0 : this.data[i + 1];
  }

  private index(n: number, m: number): number {
    const x = n + NOISE_HALF;
    const y = m + NOISE_HALF;
    if (x < 0 || y < 0 || x >= NOISE_SIZE || y >= NOISE_SIZE) return -1;
    return (y * NOISE_SIZE + x) * 2;
  }

  dispose(): void {
    this.texture.dispose();
  }
}
