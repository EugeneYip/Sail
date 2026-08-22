import type { World } from '../types';
import type { RenderHook } from './Engine';
import { Pipeline } from '../post/Pipeline';

/**
 * The engine's `RenderHook`. Everything of substance lives in `src/post/`;
 * this file exists only so `main.ts` never has to know what the post stack is
 * made of.
 *
 * Colour management contract, in one place because it is the easiest thing in a
 * renderer to get quietly wrong:
 *
 *   - the scene renders to an RGBA16F target in scene-linear radiance
 *   - `renderer.toneMapping` stays `NoToneMapping` and every post material sets
 *     `toneMapped: false`, so three never applies a curve behind our back
 *   - `renderer.outputColorSpace` is sRGB, but that only affects materials that
 *     include three's `colorspace_fragment` chunk — our passes do not, so no
 *     automatic encode ever touches what the composite writes
 *   - the display encode *is* `agx()`: it ends on the AgX outset matrix and
 *     deliberately omits the AgX EOTF, so its output is already display-encoded
 *     (sRGB gamma, values in [0,1]). Nothing after it re-encodes — the look
 *     LUT, the lift/gamma/gain trim, the split tone, the grain and the dither
 *     are all display-referred on purpose — and the frame is written out as-is.
 *     Adding a `linearToSrgb()` at the end is a *second* encode, and was the
 *     whole of the old "pale, milky, no contrast" defect; the header of
 *     `src/post/shaders/composite.ts` carries the measured numbers.
 *   - everything upstream of `agx()` — scene target, bloom, CA, vignette — is
 *     scene-linear radiance and never sRGB
 */
export class PostProcessing implements RenderHook {
  private pipeline: Pipeline;

  constructor(world: World) {
    this.pipeline = new Pipeline(world);
  }

  resize(world: World): void {
    this.pipeline.resize(world);
  }

  render(world: World): void {
    this.pipeline.render(world);
  }

  dispose(): void {
    this.pipeline.dispose();
  }
}
