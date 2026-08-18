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

## 5. Shader compile failures (measured 2026-08-18, blocking all visual QA)

Parsed from a live capture console log. Six distinct classes; the hull, terrain
and shore do not render at all, so no visual critique is possible until these
are fixed.

| error | material | cause |
|---|---|---|
| `D_GGX : function already has a body` | MeshStandardMaterial | three ships its own `D_GGX`/`F_Schlick`; ours in `GLSL.brdf` collided |
| `ocSpectrumK` / `ocSpreadSech2` : no matching overloaded function | `ocean-surface` | call sites disagree with the declarations' arity/types |
| `gl_FragColor : undeclared identifier` | `world-terrain`, `world-shore` | legacy output written from a GLSL3 / WebGL2 context |
| `vUv : undeclared identifier` | ship rigging (`src/ship/shaders/line.ts`) | varying used in an injected chunk that never declares it |
| `geometryNormal : undeclared identifier` | MeshStandardMaterial | `onBeforeCompile` injecting at a chunk where that name is not in scope |
| `half : Illegal use of reserved word` | RawShaderMaterial | `half` is reserved in GLSL ES; used as an identifier |

The `assign : l-value required`, `dimension mismatch` and
`z : vector field selection out of range` lines are downstream cascades of the
above, not independent bugs.

**Root-cause note for the collisions.** `luminance` and `D_GGX`/`F_Schlick` were
the same bug twice: `src/util/glsl.ts` defined helpers whose names three.js also
emits into its material prefixes, so every material including our snippet failed
to compile. All of our shared BRDF helpers are now `lw`-prefixed
(`lwD_GGX`, `lwF_Schlick`, `lwF_SchlickF`, `lwV_SmithGGX`, `lwFd_Burley`,
`lwEnvBRDF`, `lwFresnelWater`, `lwLuminance`) precisely so three's built-ins can
never shadow them again. **Keep new helpers in `src/util/glsl.ts` prefixed.**

## 6. Cross-subsystem radiometry follow-ups (from the units fix, 2026-08-18)

The units contract landed: sun:sky ratio went **765:1 -> 59:1**, and night sky
luminance went from **exactly 0** (custom materials had no sky fill at all after
astronomical twilight) to 3.4e-4. Root cause was that `RADIANCE_SCALE` was applied
to sun and moon irradiance but not to sky radiance, ambient SH, fog or ground
bounce, while the GPU sky *was* scaled — so the sky you saw was 13x brighter than
the sky every material was told about.

**Convention, now documented at `src/sky/constants.ts`:** absolute scene-linear
radiance, one scale, applied once. Irradiance uniforms (`uSunIntensity`,
`uMoonIntensity`, `DirectionalLight.intensity`) owe the material a `1/PI`;
radiance uniforms (`uSkyColor`, `uGroundColor`, `uFogColor`, SH, envMap,
aerialLUT) do not. 1.0 game unit is about 1e4 cd/m^2.

These consumers are now wrong *because* the uniforms are finally right:

1. **`src/ship/materials/materials.ts`** adds `indirectSpecular += amb * lwEnvBRDF(...)`
   while `scene.environment` is set, so three's `<lights_fragment_maps>` already
   supplies specular IBL — a straight double count. It was invisible while
   `uSkyColor` was 13x too dark; it will now over-brighten every ship surface.
   Delete it or guard with `#ifndef USE_ENVMAP`.
2. **`src/vfx/shaders/particles.ts`** — `vec3 sun = uSunColor * uSunIntensity;`
   is missing `INV_PI`. Every other consumer divides. Spray and foam are
   therefore PI x too bright and are the most blown-out thing in the frame.
3. **`src/vfx/shaders/rain.ts`** and **`src/world/shaders/shore.ts`** — hand-tuned
   `uSkyColor * 1.25/1.35` and `uFogColor * 0.65/0.35` coefficients. `uFogColor`
   is horizon radiance (0.5-1.6 at noon), so these will clip. Re-check at true scale.

## 7. The 60 fps blocker is CPU, not GPU

Measured with `gl.finish()` at 1600x900 ultra. **GPU total is about 0.47 ms/frame** —
16 ms of headroom. The deficit is entirely CPU `update()` cost:

| module | ms/frame |
|---|---|
| `upd:ocean` | **18.9** |
| `upd:vfx` | 4.3 |
| `upd:vfx:weather` | 1.1 (observed spiking to 53.7) |
| `upd:physics` | 0.6 |
| `upd:sky` | 0.6 |
| everything else | <0.2 each |

This corrects the earlier guess in section 4 that `sky:passes` was the problem.
Sky CPU was independently fixed (10.5 ms -> 0.30 ms: a quantised aerosol
multiplier was re-baking a 2048-texel transmittance table nearly every frame),
aerial froxel passes cut 34 -> 2 average, and the exposure readback went from
2.3 ms to about zero via a fenced pixel-pack buffer. **`src/ocean` and `src/vfx`
CPU cost is now the whole remaining deficit.**

Note: wall-clock fps in this environment is not trustworthy while other agents
run their own headless Chromium and `tsc`. Trust the per-pass GPU numbers and the
`upd:*` CPU numbers, not the fps figure.

## 8. State after the shader repair — measured on a QUIET machine, 2026-08-18

All shaders compile. Zero GLSL errors, zero failing materials, no framebuffer
feedback loop, no `useProgram: program not valid`. The ship renders in full.

**Trustworthy performance numbers** (no other agent running, 1600x900, ultra):

| scene | fps | draw calls | tris |
|---|---|---|---|
| noon | 16 | 60 | 0.57 M |
| golden | 14 | 64 | 0.57 M |
| orbit | 16 | 62 | 0.56 M |
| island | 15 | 65 | 0.75 M |
| storm | 12 | 68 | 0.81 M |

**~14 fps against a 60 target.** Earlier readings of 34 fps and of 2-9 fps were
both taken while other agents were running their own Chromium and `tsc`; ignore
them. Draw calls and triangle counts are very low, which confirms section 7: the
cost is CPU in `update()`, not geometry, batching or fill.

### Visual defects, ranked by how much they cost the frame

1. **No sails.** Masts and yards are bare while the HUD reports ~2870 m2 drawing
   at 76%. Physics is trimming sails that do not exist visually. This is the
   single largest visual gap — it is the hero asset's silhouette.
2. **Everything is washed out and hazy.** Low contrast, pale blue-grey overall.
   The deep saturated blue of open ocean is absent. Suspects, in order: aerial
   perspective / fog applied too strongly at close range; the spray/foam
   `INV_PI` error in section 6.2 making foam PI x too bright; the ship's
   double-counted specular IBL in section 6.1.
3. **Hull colour is wrong.** It reads mostly buff/tan. The Constitution is
   **black above the wale with a single buff gunport stripe** (see AGENTS.md).
4. **The wake is a white blob at the hull**, not a Kelvin V with divergent arms
   at ~19.47 degrees and a persistent trail.
5. **Two stray dark horizontal lines** run across the water either side of the
   ship, roughly at the waterline in the `orbit` capture. Looks like a mesh seam
   or a stray line primitive. Owner unknown — ocean clipmap edge or a world
   prop are the likeliest candidates.
6. **`cloudCover` does nothing** — volumetric clouds unimplemented, so `storm`
   and `fog` cannot pass the rubric's atmosphere axis.

### Remaining console noise

- 131 x `READ-usage buffer was written, then fenced, but written again before
  being read back` — the post stack's new fenced exposure readback is being
  rewritten before the fence is consumed. Harmless but it means the async path
  is not actually saving the readback.
- 5 x `THREE.Material: parameter 'defines' has value of undefined` from
  `src/vfx/Particles.ts` and `src/vfx/WakeField.ts`.
