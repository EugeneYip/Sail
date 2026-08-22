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

`.tmp/probehemi.mjs` (gitignored). Locates the probe's render target by scanning
the module list for a `WebGLRenderTarget` whose `.texture` **is** `scene.environment`
— that identity is the lever assertion, so the thing measured is provably the map
the scene lights from, not a lookalike. Reads the 256x128 equirect back with
`readRenderTargetPixels` into a `Uint16Array` and decodes half-floats in JS
(`readRenderTargetPixels` wants a buffer matching `HalfFloatType`). Weights every
texel by `sin(theta)` for solid angle.

Found at `modules[5]:Sky.probe.target`.

## Log

(append-only, newest last)

### Verified independently on main, before any change

noon (`timeOfDay` 12.3), `seaState` 3, `cloudCover` 0.3, 256x128 equirect:

| quantity | measured |
|---|---|
| upper-hemisphere mean radiance | 0.318 |
| **lower-hemisphere mean radiance** | **0.484** |
| zenith (within 8 deg) | 0.260 |
| nadir (within 8 deg) | 0.207 |
| **share of a vertical surface's cosine-weighted irradiance from below the horizon** | **55.4%** |

The lower hemisphere is **1.52x brighter than the upper one**. Note this is a
different and stronger statement than §87's nadir-outshines-zenith: at these
conditions the nadir is *not* brighter than the zenith (0.207 against 0.260), but
the hemisphere means still invert, because the bright near-horizon rows carry most
of the solid angle. §87's 36.0% was measured at different conditions; the integral
that matters reads 55.4% here. Both are the same defect.

### Mechanism, read off the shader

`EnvProbe` compiles `SKY_FRAG` with `SKY_ENV`, and `SKY_ENV` is set **nowhere
else** — the probe is its only consumer. For a below-horizon ray the shader takes
`hitsGround = viewZenithCos < horizonCos` and then reads the same sky-view LUT:

    L = texture(tSkyView, skyViewToUv(hitsGround, viewZenithCos, lightViewCos, r)).rgb;

`skyViewToUv` maps ground-hitting rays onto the LUT's lower half, which stores
atmospheric in-scattering. At sea level `zenithHorizon` is 90 deg, so every
downward direction lands there. **There is no sea term anywhere in the path.** The
engine computes exactly the right quantity — `Radiometry.groundColor`, documented
in `src/sky/index.ts` as "radiance bounced back up off the sea" and reaching
`world.uniforms.uGroundColor` — and the probe never consults it.

That the probe is `SKY_ENV`'s only consumer is what makes this safe to fix in the
shader: the *visible* sky needs no synthetic sea because it has the real ocean mesh
below the horizon.

### A measurement bug of my own, worth recording

The first version of `probehemi.mjs` assumed `v = 0` was the zenith. The shader
builds the equirect as three does — `v = asin(y)/PI + 0.5` — so **`v = 0` is the
NADIR**. Every hemisphere label in my first run was inverted. Corrected, the
pre-change numbers land on §87's: nadir **0.260** against §87's 0.259.

The tell was that the "upper" hemisphere moved when I changed a branch that can
only run below the horizon. A change appearing where it is impossible is a
measurement bug, not a discovery.

### The fix, and its same-load A/B

`SKY_ENV` only: below the horizon, Fresnel-mirror the sky in a flat sea and let
`uSeaRadiance` (= `Radiometry.groundColor`) through the rest.
`L = mix(uSeaRadiance, mirrorL, fres)`, `fres = 0.02 + 0.98 * pow(1 - cosN, 5)`.
Flat because the probe is prefiltered into SH and a roughness chain, so per-wave
structure would be averaged away regardless.

Both arms in one page load, sea branch neutralised by string-patching
`material.fragmentShader` and recompiling, so they share one cloud field, one sun
and one sea state:

| | as shipped | with sea | |
|---|---|---|---|
| nadir | **0.2649** | **0.1661** | −37% |
| zenith | 0.2039 | 0.2067 | — |
| lower hemisphere mean | 0.3210 | 0.2835 | −12% |
| upper hemisphere mean | 0.4939 | 0.4775 | −3%, and this is DRIFT (see below) |
| lower-hemisphere B−R | 0.1463 | **0.2191** | hue moves toward sea |
| share of a vertical surface's irradiance from below | 44.7% | 43.1% | **−1.6 points only** |

**The inversion is corrected**: the nadir was brighter than the zenith (0.265
against 0.204) and is now darker (0.166 against 0.207).

**Drift floor.** The upper hemisphere cannot be touched by a below-horizon branch,
so its 3% movement is the drift between the two arms (the second arm is 30 ticks
later and the clouds have moved). The nadir's 37% is an order above that floor;
the `fracBelow` change of 1.6 points is not clearly above it.

**And the hue moves.** §87 warned that dimming without hue movement is the wrong
axis. Lower-hemisphere B−R goes 0.146 → 0.219, so this is not a dimming dial.

### The prior this sets for the settling test, before running it

`fracBelow` barely moves, and that is not a shortcoming of the fix — it is
physics. A *vertical* surface's cosine lobe peaks at the horizon, and at grazing
angles Fresnel goes to 1, so a correct sea still mirrors the sky there. The
directions a near-vertical sail is most sensitive to are exactly the ones that
should stay sky-bright.

So the honest expectation going in is that this fix will **not** remove the sail
film, even though it is a real defect and really is fixed. Recorded before
measuring, so the settling test cannot be read as confirming a hypothesis chosen
after the fact.
