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
 *     include three's `colorspace_fragment` chunk — our passes do not, so the
 *     single sRGB encode happens by hand at the end of the composite
 *   - nothing between the scene target and that encode is ever sRGB
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
