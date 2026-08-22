# The environment probe's lower hemisphere is sky, not sea

Scope: `src/sky/EnvProbe.ts` and its shaders only. Cloud work is explicitly out
of scope for this pass.

## The question

Two questions, deliberately kept apart.

1. **The defect.** `EnvProbe` renders the sky shader over the *full* sphere, so
   below-horizon directions come back sky-bright. As §87 measured and
   independently reconfirmed on main:
   - mean lower-hemisphere radiance **0.306**
   - straight down **0.259**, brighter than the zenith's **0.165**
   - against the engine's own `uGroundColor` of **0.146**
   - **36.0%** of a vertical surface's cosine-weighted irradiance arrives from
     below the horizon.
   A probe whose nadir outshines its zenith is wrong whatever else is true.
   Fixing it is in scope.

2. **The settling test.** §87 stops short of calling this the root cause of the
   close-view sail film (sail outgoing radiance sits at 0.585 of the radiance
   behind it, in a similar hue; a surface matching its background reads as
   film). Single-term ablation attributes 67% of the sail's outgoing radiance to
   the probe — a *contribution* measurement, not proof. The settling test is a
   same-view causal A/B: station, frame, clock and exposure fixed, change *only*
   the lower-hemisphere contribution, report whether the film goes. Either
   answer is a good answer.

Prior constraint from §87: **dimming is the wrong axis.** A dial combination
reached ratio 0.370 and stopped reading as film, but the crop became a dark blue
tarpaulin and the hue did not move at all (B-R +18.65 -> +20.56). Watch the hue.

## Instrument traps already paid for (do not re-learn)

1. `material.envMapIntensity = 0` is a silent no-op here — `WebGLMaterials.js`
   only uploads it when `material.envMap` is set, and this material's env map is
   `scene.environment`.
2. `shader.fragmentShader` inside `onBeforeCompile` is pre-include-resolution and
   pre-`#define`, so grepping it for `USE_ENVMAP`/`getIBLRadiance` returns false
   on a material that has both.
3. **Assert the lever moves before measuring with it.** Two investigations lost
   to no-op levers already (see §91: `Pipeline.render` rewrites composite
   uniforms from `world.settings` every frame, so a page-set uniform ablated
   nothing). A no-op lever and an innocent suspect produce identical evidence.
4. A probe writing PNGs under the Vite root reloads the page it is measuring.
   Stage screenshots outside the project, as `scripts/capture.mjs` does.

## Instrument

TBD — filled in below as it is built.

## Log

(append-only, newest last)
