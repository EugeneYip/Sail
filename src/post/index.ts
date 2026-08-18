/**
 * Post-processing. Owned by the post agent.
 *
 * Entry point is `core/PostProcessing.ts`, which is a five-line adapter onto
 * `Pipeline` — the engine's `RenderHook` contract lives in core, everything
 * else lives here.
 *
 * STATUS
 *   wired      prepare/exposure, velocity, TAA + RCAS, FXAA, SMAA 1x, half-res
 *              DoF, tile-max motion blur, 6-level progressive bloom, underwater,
 *              composite (CA, lens dirt, cos^4 vignette, AgX, 4 procedural look
 *              LUTs, runtime lift/gamma/gain + split tone, film grain, 1-LSB
 *              triangular dither, sRGB encode)
 *   contract   `world.ext.post` (see ext.ts), `world.uniforms.uJitter`
 *   not done   no MRT velocity from animated vertex shaders — see the artefact
 *              note in Pipeline.ts; no SSR; no volumetric light shafts
 *
 * Everything is gated by `world.settings`; sample counts scale with
 * `settings.quality` through `BUDGET` in Pipeline.ts.
 */
export { PostProcessing } from '../core/PostProcessing';
export { Pipeline } from './Pipeline';
export type { PostExt } from './ext';
export { LOOKS } from './luts/LookLut';
