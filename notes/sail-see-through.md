# Sails read as a translucent film — which object owns those pixels

Running log. Appended as I go; not a final report until the last line says so.

## The defect as reported

At close inspection stations (`port-side`, `rail-close` via `.tmp/inspect.mjs`)
the sails read as a translucent blue-grey film: sea and sky appear to show
*through* the canvas, with the sail's own seam lines drawn on top. A player
called the ship "incomplete / see-through". Highest-priority visual defect.

## The question

Not "does it look blue". It is: **which object produced the final pixels that
visually read as sea/sky through the sail?**

## What was NOT established by the previous attempt (do not inherit)

- Material *configuration* is opaque (`transparent:false, depthWrite:true,
  opacity:1, NormalBlending, side:DoubleSide`). That is a fact about
  configuration only. It does not rule out geometry, culling, depth or post.
- A vfx ablation "6.4% of sail pixels changed" was run at a 92 m orbit station
  where the artefact is not visible. Says nothing.
- An ocean ablation never executed (no mesh matched the name regex).
- A `uClothTrans` test was a silent no-op: `material.userData.shader` absent.
- "Opaque at 92 m, translucent at 34 m" confounds distance, angle, facing,
  what lies behind the sail, and exposure.

Standing statement at start of this session: **the artefact is
view-configuration dependent and the root cause is unisolated.**

## Method constraints inherited

- Freeze with `eng.stop()` then `eng.tick(eng.lastTime)` (dt = 0).
- `tick(lastTime)` does *not* freeze the frame with TAA on: two renders of one
  variant differ mean 2.00 / max 98.55 codes. Set
  `world.settings.antialias = 'smaa'` for any A/B, and render the null twice.
- Auto-exposure carries across variants within one run; absolute levels are not
  comparable across variants, contrast ratios are.
- `world.uniforms.uExposure` is a CPU estimate, not the applied multiplier.

## Log

### The partition test: the sail owns the pixels

`.tmp/sailmask.mjs port-side` — one page, one frozen frame, one camera,
`antialias='smaa'`, `adaptiveResolution=false`, `renderScale=1`, and exposure
**pinned** (read `world.stats['post:exposureStops']` from the settled null,
write it to `settings.exposureBias`, set `autoExposure=false`) so the
exposure-carry-over confound is removed rather than tolerated. Buffer 1600x900.
Readback is `gl.readPixels` off the default framebuffer in the *same JS task* as
the render, so no capture is ever compared across time.

Station `port-side` (eye 34 m abeam, 6 m up, aimed at the ship's midpoint).
Variants, all in ONE run against ONE frozen frame:

| variant | mean code |
|---|---|
| null | 96.484 |
| null again | 96.314 |
| sail fragment forced `vec3(0.0)` | 70.677 |
| sail fragment forced `vec3(4.0)` | 134.669 |
| sail fragment forced magenta | 117.735 |
| sail meshes `visible = false` | 104.814 |

| diff | mean | max | % of frame > 8 codes |
|---|---|---|---|
| null vs null again (**noise floor**) | 1.95 | 110 | 0.139 |
| flat0 vs flat4 (**sail coverage mask**) | 68.9 | 255 | **31.10** |
| null vs sails hidden | 19.0 | 176 | 28.02 |
| null vs magenta | 36.6 | 183 | 28.51 |

**Result: the sail region turns magenta.** Every pixel that read as sky, cloud
or sea "through" the canvas is magenta in the flat-unlit variant, and the
flat0/flat4 coverage mask is *solid* over the whole sail silhouette — no holes,
no missing faces. The only blue left inside the silhouette is a genuine gap
between the foot of a sail and the yard below it, and real sky between sails.

So by the brief's own partition: **cause is shading or post-processing. It is
not geometry, culling or depth.** The mask also rules out post *importing*
neighbouring sea/sky into the silhouette — flat magenta comes back clean and
saturated with no sea bleeding in, so DoF/motion blur are not transporting the
sea inwards.

What the null actually shows, now that it can be looked at honestly: the canvas
is a blue-grey film carrying **structured cloud shapes and a horizon line** that
are a recognisable image of the sky, not a wash. A flat ambient term cannot
produce structure. That points at a term that samples the environment.

Noted for later: the same frame shows the **hull** reading blue-black with
vertical lines printing through it. Out of scope here (hull.ts is another
agent's) but it is the same family of symptom.
### Two instrument traps found before any narrowing was trusted

**1. `material.envMapIntensity = 0` is a silent no-op on this material, and it is
the same class of mistake as the failed `uClothTrans` test.** three r0.185.1,
`src/renderers/webgl/WebGLMaterials.js`:

```
if ( material.envMap ) {
  uniforms.envMapIntensity.value = material.envMapIntensity;
}
```

The sail's env map is `scene.environment`, not `material.envMap`, so
`material.envMap` is null, the guard never fires, and `envMapIntensity` is never
uploaded — it stays at the ShaderLib default of 1 no matter what is assigned.
My first sweep dutifully reported `env0` mean 93.65 against a null of 93.64 and
that number means **nothing**. Do not cite it.

**2. `shader.fragmentShader` inside `onBeforeCompile` is the source BEFORE
`resolveIncludes` and before the `#define` prefix.** So `USE_ENVMAP`,
`getIBLRadiance`, `getIBLIrradiance` and `NUM_HEMI_LIGHTS` are simply not in that
string yet. A probe that greps it for those names reports `false` for all of them
on a material that has every one of them — I did exactly that and nearly
concluded there was no IBL. The reliable lever is to replace a whole
`#include <name>` with hand-written GLSL, and to make the probe **report a
pattern that did not match** rather than silently doing nothing.

Both of these are now enforced in `.tmp/sailabl.mjs`: every string edit is
checked against the source and misses are printed.

### What the first (partly invalid) sweep did establish

Statistics INSIDE the flat0/flat4 coverage mask (31.9% of frame), one frozen
frame, exposure pinned, smaa:

| variant | mean luma | std | R | G | B | B-R |
|---|---|---|---|---|---|---|
| null | 93.64 | 23.19 | 86.4 | 94.5 | 106.3 | **+19.99** |
| null again | 93.15 | 23.14 | 85.3 | 94.1 | 106.7 | +21.44 |
| `sheen = 0` | 83.97 | 20.20 | 76.1 | 84.9 | 98.1 | +22.03 |
| `uClothTrans = 0` | 83.13 | 21.08 | 71.3 | 84.8 | 101.7 | +30.36 |
| sky half of translucency = 0 | 91.44 | 22.91 | 83.6 | 92.4 | 104.9 | +21.36 |
| sun half of translucency = 0 | 85.98 | 21.54 | 75.1 | 87.5 | 103.4 | +28.28 |
| aerial perspective = 0 | 92.71 | 23.14 | 85.0 | 93.7 | 106.0 | +20.95 |

Read against a null-vs-null floor of 0.5 codes of mean, the shape of this is:
the canvas is **+20 codes bluer in B than in R**, and *every* term I could ablate
either leaves that alone or makes it **worse**. Killing the cloth translucency
takes 10 codes of luma out and pushes B-R from +20 to +30, i.e. the
translucency is one of the few things adding *warmth*. So the blue is not the
translucency, not the sheen lobe, and not aerial perspective. Nothing tested so
far moves the std (23.2 -> 20.2 at best), so nothing tested so far is what draws
the cloud-shaped structure either.

Next: the component breakdown — write each light accumulator straight to
`gl_FragColor` at the end of main, one at a time, same frozen frame.
### The component breakdown, and a calibration ramp so the numbers mean something

`envtest` — a variant whose only job is to write green if
`USE_ENVMAP && ENVMAP_TYPE_CUBE_UV` is defined and red if not — comes back
**green** (mean G 170, R 34, B 24 inside the mask). So the sail program does have
three's image-based lighting compiled in, off `scene.environment`, and trap 1
above was the only reason the first sweep said otherwise.

Every accumulator written straight to `gl_FragColor` at the end of main, same
frozen frame, same camera, statistics inside the coverage mask:

| written out | mean luma | std | B-R |
|---|---|---|---|
| `diffuseColor.rgb` (cloth albedo) | 104.6 | 24.6 | -12.1 |
| `iblIrradiance` | **166.4** | 42.7 | +30.2 |
| `radiance` (IBL specular) | **114.5** | 26.5 | +49.1 |
| `irradiance` (ambient + hemi + probe) | 11.5 | 26.1 | +0.6 |
| `reflectedLight.indirectDiffuse` | 63.2 | 18.5 | +11.8 |
| `reflectedLight.indirectSpecular` | 30.4 | 19.8 | +20.5 |
| `sheenSpecularIndirect` | 46.7 | 15.9 | +20.1 |
| `sheenSpecularDirect` | 22.3 | **38.7** | -2.8 |
| `reflectedLight.directDiffuse` | 16.7 | 29.2 | -1.3 |
| `reflectedLight.directSpecular` | 14.0 | 26.1 | +0.2 |
| null, for reference | 94.3 | 26.7 | +17.9 |

`irradiance` at 11.5 is the same as a flat 0.0 write, so there are **no ambient
or hemisphere lights** on this scene: every bit of indirect light on the canvas
arrives through the environment probe.

To turn display codes back into scene-linear radiance I rendered a **calibration
ramp** — flat values 0.0 to 4.8 written at the end of main, through the identical
exposure/AgX/composite stack in the identical frame. That is the only honest way
to read these numbers; AgX means a code difference is not a radiance ratio.

| flat linear in | mean code out |
|---|---|
| 0.0 | 11.8 |
| 0.05 | 40.5 |
| 0.1 | 59.8 |
| 0.2 | 85.7 |
| 0.3 | 103.7 |
| 0.4 | 117.4 |
| 0.6 | 137.2 |
| 0.8 | 151.4 |
| 1.2 | 171.8 |
| 1.6 | 185.7 |
| 3.2 | 212.2 |

### The probe is NOT over-bright, and three's diffuse IBL on the canvas is exact

`iblIrradiance` reads 166 codes, i.e. about 1.12 linear. `getIBLIrradiance`
returns `PI * envMapColor * envMapIntensity`, so the probe's diffuse-convolved
sky value is 1.12 / PI = **0.357** — against a measured 0.40 for the actual sky
and sea *behind* the sail in the same frame. The probe is calibrated correctly.
This rules out an over-bright environment probe, which was my first guess.

And the diffuse IBL arithmetic closes: `indirectDiffuse = iblIrradiance *
diffuseColor / PI` = 1.12 * 0.30 / PI = **0.107**, and `c_iDiff` measures 63.2
codes, which the ramp puts at 0.108. So three's Lambert-from-probe on this cloth
is right to one per cent, and it is **not** the thing to change.

### Two separate artefacts, and they have different causes

**A. THE FILM is the environment probe, and its size is 72 per cent.**
Replacing `#include <lights_fragment_maps>` with nothing — which removes
`iblIrradiance` and `radiance`, and with `iblIrradiance` also removes the IBL
sheen, since `RE_IndirectSpecular_Physical` takes it as its `irradiance`
argument — takes the canvas from 94.3 codes to **47.8**. Inverted through the
ramp that is 0.247 -> 0.069 linear: **image-based lighting is 72 per cent of the
sail's outgoing radiance at this station.**

The same frame with the sail meshes hidden gives 117.7 codes inside the mask,
i.e. **0.40 linear is what is behind the canvas**. So the shipped sail sits at
0.62 times the radiance of the sky and sea behind it, in the same blue hue
(sail B-R +17.9, background B-R +64.2). Mean |null - hide| inside the mask is
57 codes with 85 per cent of pixels over 24 — the sail is not invisible, but a
1.6:1 luminance ratio at matching hue is exactly the arithmetic of a translucent
film, and it is why the eye reads sky *through* the cloth rather than cloth.

Pure diffuse IBL alone would put the canvas at 0.107 against 0.40, a 3.7:1
ratio, which reads as opaque cloth. Everything between 0.107 and 0.247 is the
problem.

**B. THE "CLOUDS" ON THE CANVAS ARE `sheenSpecularDirect`.** This is the finding
I did not expect. The soft white streaky patches that read as cloud seen through
the sail are still there with the whole environment probe removed, and still
there with the cloth sun-transmission term removed — so they are neither. Writing
`sheenSpecularDirect` on its own gives a black frame with *exactly those patches*
in it, blown out to white, scalloped along the head of each sail and running down
in flutes that follow the cockle relief. Its mean is only 22.3 codes but its
standard deviation is **38.7, the highest of any component**, which is the
signature of a term concentrated in a few very hot places.

That is three's Charlie/Ashikhmin sheen lobe at `sheen: 1`,
`sheenRoughness: 0.62`, `sheenColor: 0xa8a294`, under a grazing sun, on a
`DoubleSide` surface whose normal is flipped toward the camera. A grazing sheen
lobe peaks hard, and three adds `sheenSpecularDirect + sheenSpecularIndirect` on
top of the FULL Lambert diffuse with no `(1 - sheenAlbedo)` compensation — see
`meshphysical.glsl.js` line 202. So the cloth reflects more energy than reaches
it, in the places where sheen peaks.
### The environment probe is a full sphere of sky, and a sail is a vertical surface

`.tmp/envprobe.mjs` reads `scene.environment`'s render target directly and
integrates it, with the equirect solid angle `cos(lat) dlat dlon` done properly.
One trap on the way: the target is `HalfFloatType`, so
`readRenderTargetPixels` must be handed a `Uint16Array` and the half-floats
decoded by hand — a `Float32Array` reads back **all zeros silently**, and the
first run of this probe reported an entirely black sky.

256x128 equirect, `timeOfDay` 12.3, `cloudCover` 0.3. Mean luminance by
latitude band, -90 straight down to +90 zenith:

| latitude | mean radiance |
|---|---|
| -83 (straight down) | 0.2593 |
| -68 | 0.2683 |
| -53 | 0.3616 |
| -38 | 0.3808 |
| -23 | 0.2754 |
| -8 | 0.2651 |
| +7 (just above horizon) | 0.6033 |
| +22 | 0.5176 |
| +37 | 0.4269 |
| +52 | 0.3494 |
| +67 | 0.2503 |
| +82 (zenith) | 0.1648 |

- upper hemisphere mean radiance **0.454**
- lower hemisphere mean radiance **0.306**
- straight down **0.259**, which is *brighter than the zenith's 0.165*
- the engine's own downward radiance, `uniforms.uGroundColor`, is **0.146**
- a real sea at normal incidence at noon is roughly **0.05**

`EnvProbe` renders `SKY_FRAG` over the whole sphere, so every direction below the
horizon returns the atmosphere's airlight column. There is no sea in the IBL at
all. Integrating cosine-weighted irradiance on a horizontal normal against the
probe gives **35.4 per cent of a vertical surface's irradiance arriving from
below the horizon** — and a sail is a vertical surface.

I tested the correction without touching `src/sky`, by replacing
`#include <lights_fragment_maps>` with a version that re-weights the probe's
contribution using the same `clamp(n.y * 0.5 + 0.5)` sky/ground split
`materials.ts` already uses for its analytic lobe, with the two radiances above
as the endpoints. Result at `port-side`: sail 0.2701 -> **0.2335** linear,
ratio to background 0.601 -> **0.519**, and hue B-R +18.65 -> +15.17. Real, and
in the right direction, and **not committed**: the two constants are measured at
one sun elevation and will be wrong at dawn, dusk and in fog, and patching one
material around a defect that lives in the probe leaves the hull, deck and spars
still wrong. This belongs in `EnvProbe`, which is not my directory.

### Other surfaces in the same frame — and why the hull is a different bug

Named rectangles, mean scene-linear radiance, inverted per pixel through the
calibration ramp, `port-side` null:

| region | linear | B-R |
|---|---|---|
| sail (mask) | 0.2975 | +14.3 |
| what is behind the sail | 0.4503 | +61.5 |
| hull, black topsides | **0.1841** | +1.2 |
| gunport stripe (white/buff) | 0.2740 | -4.5 |
| sea, near | 0.2373 | +66.0 |
| sky, high | 0.4891 | +82.2 |
| sky, at the horizon | 0.3277 | +8.6 |

The hull looked like the same defect and it is not. Black paint at 0.184 linear
against a 0.357-radiance sky is an effective albedo of about **0.5** — and its
B-R is +1.2, i.e. neutral, so it is not skylight doing it. A white gunport
stripe and black topsides differ by 1.49x where they should differ by 15-20x.
That is a **hull albedo** problem, not an ambient one, and `hull.ts` belongs to
another session (`notes/hull-bulwark-and-head.md`). I did not pursue it. Worth
saying out loud because I spent a while assuming it was one scene-wide error.

### What I did not commit, and why

Two levers live in my files and both are magnitude dials, not corrections:

| candidate | sail linear | ratio to background |
|---|---|---|
| as shipped | 0.2701 | 0.601 |
| probe horizon re-weight only | 0.2335 | 0.519 |
| `sheen` 1 -> 0.22, `uClothTrans` 0.34 -> 0.15 | 0.1974 | 0.439 |
| both, i.e. all three at once | 0.1665 | **0.370** |

0.370 does stop reading as a film. It reads as a **dark blue tarpaulin** instead:
the 1:1 crop at `port-side` is a slab of slate, the pale sheen patches are still
there, and — the part that decides it — **the hue does not move at all**, B-R
+18.65 to +20.56. Dimming is the wrong axis. Committing three simultaneous
constants, two of them chosen by eye and two of them measured at a single sun
elevation, to make a frame darker without making it read as cloth, is exactly
the speculative fix I was told not to commit. **No source change in this
session.**

### What to do instead, in order

1. **`src/sky/EnvProbe.ts`** — put the sea in the probe's lower hemisphere, or
   scale the below-horizon rows to the sea's reflectance before flagging
   `needsPMREMUpdate`. Measured: 35.4 per cent of a vertical surface's irradiance
   currently comes from bright airlight below the horizon. This is one place and
   it fixes every material on the ship at once.
2. **`sheen` in `build/sails.ts`** — `sheen: 1` with `sheenColor: 0xa8a294` puts
   29 per cent of the canvas's outgoing radiance into a grazing lobe and *is*
   the blown-out cloud-shaped patches, proved by rendering
   `sheenSpecularDirect` alone. Heavy flax duck is a tight plain weave with
   almost no nap; sheen at maximum with a 0.40-linear colour is a velvet
   parameterisation. Note three r0.185.1 **does** already apply
   `1 - max3(sheenColor) * IBLSheenBRDF` energy compensation
   (`lights_physical_pars_fragment` lines 547 and 567) — I was about to add it
   and it is already there — but that compensation uses the view-direction
   albedo, so at grazing angles the lobe still returns net more than arrives,
   which is precisely where the patches are.
3. **The thing that is actually missing: geometric occlusion between the sails
   and the rig.** Every sail currently sees the entire hemisphere. On a real
   ship the fore course is deeply shaded by the topsail above it, by the mast,
   the tops and the yards, and that occlusion is what gives canvas its shape and
   its separation from the sky. The measurable symptom is flatness: the standard
   deviation inside the sail mask is 23-27 codes and most of it is *between*
   sails rather than across any one of them. `aoMap` is the weave texture, not
   geometry. No amount of scaling a uniform ambient substitutes for this.

### What I could not verify

- **The sunlit side.** `stbd-side` never produced a usable frame: the station
  put the eye at y = -0.8, i.e. under water, and the frame was not static —
  null against null again differed by mean 36 codes over 100 per cent of the
  frame, which is the underwater pass animating. So I have **not** measured how
  the lit face reads, and cannot say whether darkening the shaded side would
  hurt it. Anyone continuing should fix that station first.
- **One time of day only.** Every number here is `timeOfDay` 12.3,
  `cloudCover` 0.3, `turbidity` 2.2, `seaState` 3, `visibility` 34 km. Nothing
  is known about dawn, dusk, night, storm or fog.
- **The cloth's baked albedo.** I measured the *effective* albedo the fragment
  shader arrives at, 0.30 linear with B-R -12 — after grime, seams, panel tone
  and the bundle shadow. I did not measure what `makeCanvas` bakes.
- **Accuracy of the linear inversion.** The ramp is accurate to a few per cent
  at mid values and coarse below 0.05, so per-component sums overshoot the null
  by about 15 per cent. The trustworthy numbers are the **ablation
  differences** (null minus one-term-removed), which are reproducible to about
  1 per cent: the same station gave ratios 0.589, 0.593 and 0.601 in three
  separate runs.
- **Whether the artefact is worse or better at range.** I deliberately did not
  repeat the "opaque at 92 m, translucent at 34 m" comparison, because it
  confounds distance with facing, with what lies behind the canvas, and with
  exposure, and nothing in this note needs it.

### Reproducing all of it

- `.tmp/sailmask.mjs <station>` — the partition test. Magenta, hide, and the
  flat0/flat4 coverage mask.
- `.tmp/sailabl.mjs <station> <comma-separated variants>` — one frozen frame,
  one camera, one term at a time, with the calibration ramp, the coverage mask,
  mask-restricted statistics and named rectangles. Every string edit is checked
  against the shader source and a miss is printed, because a patch that silently
  does nothing is how the previous attempt at this task produced four numbers
  that meant nothing.
- `.tmp/envprobe.mjs` — the probe, integrated hemisphere by hemisphere.
- `.tmp/sailinfo.mjs` — what is compiled into and bound to the sail program.
- Frames kept at `.tmp/sail-see-through/`.

All four kill Vite's HMR socket and count navigations, because a concurrent
agent editing `src/` reloads the page mid-run. That is not hypothetical: it
dropped `window.__p` in the middle of a paired run, and later `hull.ts` was left
in a state that threw `Cannot read properties of null (reading 'flip')` in
`buildBulwarks` and the app stopped booting entirely. The last measurements in
this note were taken in a **detached `git worktree` with its own dev server on
port 5191**, which is what `AGENTS.md` prescribes and what I should have started
with.
### Confirmed against the tree as it stands

Re-run on the main tree at `port-side` after `hull.ts` came back to a booting
state, so nothing in this note rests on the worktree:

| | linear | share of the sail |
|---|---|---|
| sail, as shipped | 0.2656 | |
| what is behind it | 0.4542 | ratio **0.585** |
| environment probe removed | 0.0876 | IBL is **67%** |
| `sheen = 0` | 0.2122 | sheen is **20%** |
| `uClothTrans = 0` | 0.2079 | translucency is **22%** |
| flat magenta | R 199, G 94, B 203 | the silhouette is unmistakably the sail |

Null against null again: mean 2.29 codes, 0.2 per cent of the mask over 8, none
over 24. Ratios across four independent runs at this station: 0.585, 0.589,
0.593, 0.601.
