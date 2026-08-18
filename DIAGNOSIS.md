# Open defects — measured, not guessed

Probe: `node .tmp/probe.mjs` (reads live values off `window.__leeward`).
Scene: `noon` preset, settled 6 s, 1280x720, M2.

## 1. Radiometric units are inconsistent between sky and direct light

Measured at noon:

| quantity | value |
|---|---|
| `ext.sky.zenithColor` (linear) | `[0.007, 0.013, 0.031]` |
| `ext.sky.horizonColor` (linear) | `[0.040, 0.067, 0.125]` |
| `ext.sky.skyLuminance` | `0.0159` |
| `uniforms.uSunIntensity` | `12.16` |
| `ext.sky.sunLuminance` | `10.87` |
| `uniforms.uFogColor` | `[0.040, 0.068, 0.126]` |
| `post:sceneLog2Lum` | `-1.616` → avg scene luminance `0.326` |
| `post:exposureStops` | `-0.813` |
| `uniforms.uExposure` | `0.565` |

**The problem.** Sky radiance sits around `0.01–0.13`, while the sun drives lit
surfaces at intensity `12.16`. A surface of albedo 0.3 therefore returns roughly
`3.6` — about **250x the sky's radiance**. Auto-exposure sees a mean of `0.326`,
settles on `0.565`, and the result is that every sun-lit surface clips to white
while the sky sits near black. That is exactly the observed frame: white sea,
white ship silhouette, and only a faint gradient surviving at the top of frame.

Auto-exposure is **not** broken — it is metering a scene whose two light sources
disagree about what "1.0" means.

**The fix is a units contract, not a magic number.** Pick one convention and
make sky radiance, `uSunIntensity`, `uSkyColor`/`uGroundColor`, and every
material's response obey it. Either:
- carry real-ish photometric values and let auto-exposure do the whole job
  (then `uSunIntensity` must be in the same scale as `zenithColor`, i.e. sun
  illuminance producing ~0.1–1.0 surface radiance at noon, not 12), or
- normalise everything so a noon diffuse surface lands near `0.18` before
  exposure, and keep the sun's *relative* brightness in the sky shader only.

Whichever is chosen, document it in `src/sky/constants.ts` next to
`RADIANCE_SCALE` and make `Radiometry.ts` the single source of truth. Verify
across `dawn / noon / golden / night` — a correct contract exposes all four
without per-scene tweaking.

## 2. Framebuffer feedback loop

`GL_INVALID_OPERATION: glDrawElementsInstanced: Feedback loop formed between
Framebuffer and active Texture`, repeating every frame. A texture is bound for
reading while being rendered into. Suspects: SSR/refraction sampling the scene
colour target while writing to it; a ping-pong target not swapped; a pass
missing `setRenderTarget(null)`.

## 3. A program fails to link

Many `WebGL: INVALID_OPERATION: useProgram: program not valid`, with **no** GLSL
compile errors in the log — so this is a link failure or use-after-failed-compile.
Identify the material by name (`renderer.debug.checkShaderErrors`, or bisect by
disabling passes).

## 4. Performance

**34 fps at 1600x900 ultra on M2; target 60.** 65 draw calls, 0.55 M triangles —
low enough that the cost is fill/shader-bound, not batching. `sky:passes` was
**34 per frame**, which is worth auditing first: the aerial-perspective froxel
volume alone reports 32 passes.
