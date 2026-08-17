import * as THREE from 'three';

/** Radical-inverse in an arbitrary base — the Halton building block. */
function radicalInverse(index: number, base: number): number {
  let f = 1;
  let r = 0;
  let i = index;
  while (i > 0) {
    f /= base;
    r += f * (i % base);
    i = Math.floor(i / base);
  }
  return r;
}

const SEQUENCE_LENGTH = 8;

/**
 * Halton(2,3) sub-pixel jitter for TAA.
 *
 * ## The contract with the rest of the engine
 *
 * `PostProcessing.render()` runs *after* every module's `update()`. We jitter
 * `camera.projectionMatrix` in place there, render, and restore it before
 * returning — so no module ever observes a jittered matrix from `update()`.
 *
 * Anything that reprojects *inside a shader during the main scene pass* (the
 * sky's cloud reprojection, an SSR temporal accumulation) does see the jittered
 * matrix and must remove it:
 *
 *   vec2 ndcUnjittered = ndc - uJitter;   // uJitter is in NDC units
 *
 * `uJitter` is defined so that a static world point rasterises at
 * `ndcUnjittered + uJitter`. It is `(0,0)` whenever TAA is inactive, so the
 * subtraction is always safe to leave in.
 *
 * The sequence is offset to the pixel centre and scaled to slightly under one
 * pixel: a full ±0.5 px spread with a bilinear history fetch reads a touch soft,
 * and 0.92 px of coverage still resolves the whole pixel footprint.
 */
export class Jitter {
  /** NDC offset currently baked into camera.projectionMatrix. */
  readonly ndc = new THREE.Vector2();
  /** The same offset in pixels, for shaders that think in texels. */
  readonly pixels = new THREE.Vector2();

  private samples: THREE.Vector2[] = [];
  private saved = [0, 0];
  private applied = false;
  private index = 0;

  constructor(spread = 0.92) {
    for (let i = 0; i < SEQUENCE_LENGTH; i++) {
      this.samples.push(
        new THREE.Vector2(
          (radicalInverse(i + 1, 2) - 0.5) * spread,
          (radicalInverse(i + 1, 3) - 0.5) * spread,
        ),
      );
    }
  }

  /** Pick this frame's sample. Call once per frame before `apply`. */
  advance(frame: number, width: number, height: number, active: boolean): void {
    if (!active) {
      this.ndc.set(0, 0);
      this.pixels.set(0, 0);
      return;
    }
    this.index = frame % SEQUENCE_LENGTH;
    const s = this.samples[this.index];
    this.pixels.set(s.x, s.y);
    this.ndc.set((s.x * 2) / Math.max(1, width), (s.y * 2) / Math.max(1, height));
  }

  /**
   * Bake `ndc` into the camera's projection matrix.
   *
   * Column-major element 8 is m13 and element 9 is m23, the two terms that
   * offset clip x/y by the (negative) view z. Because `ndc.x = m11*vx/-vz - m13`
   * the offset has to be *subtracted* to shift the image by `+ndc.x`.
   */
  apply(camera: THREE.PerspectiveCamera): void {
    if (this.applied) return;
    if (this.ndc.x === 0 && this.ndc.y === 0) return;
    const e = camera.projectionMatrix.elements;
    this.saved[0] = e[8];
    this.saved[1] = e[9];
    e[8] -= this.ndc.x;
    e[9] -= this.ndc.y;
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    this.applied = true;
  }

  /** Restore the matrix. Must run before any module reads it again. */
  remove(camera: THREE.PerspectiveCamera): void {
    if (!this.applied) return;
    const e = camera.projectionMatrix.elements;
    e[8] = this.saved[0];
    e[9] = this.saved[1];
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    this.applied = false;
  }
}
