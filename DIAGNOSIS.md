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

## 9. State 2026-08-18 late — sails and clouds are in

Clean run: **zero GLSL errors, zero failing materials**, no feedback loop, no
program-link failures. `npm run typecheck` (which now runs `check-glsl`) passes.

| scene | fps | draw calls | tris |
|---|---|---|---|
| noon | 23 | 63 | 0.58 M |
| golden | 18 | 69 | 0.60 M |
| orbit | 18 | 70 | 0.59 M |
| storm | 21 | 91 | 0.60 M |

**fps up from ~14 to 18-23** — the ocean/vfx CPU work partially landed before the
agents were interrupted. Still well short of 60.

**Landed and visible:** the full sail plan renders (square sails on all three
masts, jibs, spanker, with camber); volumetric clouds render with real volume and
shading; the hull reads dark with its gunport stripe and stern gallery; the wake
trails; the ocean has wave structure and a sun-glitter path.

### Verified NOT a bug — do not chase this

The ship *looks* heeled far more than the HUD's reported angle. It is not. Probed
live (`.tmp/heel.mjs`):

```
physics_heel_deg    10.03   ->  shipRoot_roll_deg   -10.03
physics_pitch_deg   -0.99   ->  shipRoot_pitch_deg   -0.99
ship.quaternion == shipRoot.quaternion  (identical to 4dp)
```

The transform is exact. The apparent tilt is a 31 deg yaw relative to the chase
camera plus 67 m masts exaggerating a modest heel in perspective. **Measure before
dispatching** — this looked like a doubled-rotation bug and was not.

### Remaining, ranked

1. **Foam and spray are far too bright** and dominate the frame — the missing
   `INV_PI` from section 6.2 is still unfixed (the VFX agent was interrupted
   mid-fix). This is the largest remaining visual defect.
2. **Still washed out / low contrast** overall, though much improved.
3. **18-23 fps against 60.** CPU `update()` in ocean and vfx remains the blocker.
4. **Camera framing** — the ship sits off-centre and clipped at the right frame
   edge in `noon`. Composition axis of RUBRIC.md is not being served.
5. Sails read as blown-out white rather than off-white weathered flax; may resolve
   once (1) and (2) are fixed.
6. 11x `THREE.Material: parameter 'defines' has value of undefined` and 12x
   `GL_INVALID_VALUE: glGetProgramiv` remain in the console.

## 10. State 2026-08-18 evening — the look landed, performance regressed

Clean run: zero GLSL errors, zero failing materials.

| scene | fps | draw calls | tris |
|---|---|---|---|
| noon | 12 | 70 | 0.60 M |
| golden | 11 | 86 | 0.60 M |
| orbit | 12 | 67 | 0.59 M |
| storm | 10 | 74 | 0.60 M |

**Visually this is the best the game has looked.** Golden hour reads
cinematically: warm structured clouds with silver-lit edges, a sun-glitter path,
deep water with real wave structure and colour, the black hull with its gunport
stripe silhouetted, islands sitting correctly in the haze, foam finally at a
plausible quantity, and genuine blacks in the frame.

**But fps went 18-23 -> 10-12.** That is a regression, and performance is now the
single dominant defect. Draw calls (67-86) and triangles (0.60 M) are still tiny,
so this remains CPU `update()` and per-pass GPU cost, not batching or geometry.

Known contributors to chase, in order:
1. The exposure readback fence: **160x** `READ-usage buffer was written, then
   fenced, but written again before being read back`, previously measured at
   **6.8 ms** for the exposure pass alone. The async path is saving nothing and
   may cost more than the sync path did.
2. Volumetric clouds — new since the last measurement, budgeted at 2.5 ms GPU.
   Verify the actual cost.
3. `upd:ocean`, last measured at 18.9 ms and only partially reduced.
4. `upd:vfx`, reported down to ~1.3 ms p50 but unverified on a quiet machine.

### Resolved: the stray waterline lines

Not a debug helper and not a clipmap seam. The VFX agent identified them as
**the Kelvin wake arms** — a faint-foam tail that reads as a dark line against
the water at golden hour. It was fixing this with a hard termination of the tail
when interrupted. I had mis-routed this to the ship agent; it was VFX's all along.

### Still open visually

- Sails read flat and pale — closer to bent planes than loaded cloth. Camber
  shaping, cloth translucency and the woven sheen still need work.
- Composition: the ship sits right of centre and grazes the right frame edge.

## 11. Ocean perf resolved; bottleneck has moved (2026-08-18 night)

**`upd:ocean` 18.9 ms -> 1.3-1.5 ms**, verified, with **no visual cost** — the
render path was untouched and only the CPU physics mirror was approximated.
`solveSpectrum` (2.27 ms) and `cpu.setParams` (2.2 ms) had been running *every
frame* instead of on their documented rebake thresholds.

CPU-vs-GPU agreement after the change (`debugCompare`, 4096 points):

| scene | GPU rms | CPU rms | rms diff | correlation |
|---|---|---|---|---|
| noon | 0.4104 m | 0.4040 m | **5.4 cm** (2.7% of Hs) | 0.996 |
| storm | 1.4698 m | 1.4751 m | **12.4 cm** (1.9% of Hs) | 0.997 |

**The bottleneck has moved.** All `upd:*` modules now sum to about 5 ms. The
remaining cost is in post/sky/core.

**Caveat on every timing in this section:** the machine sat at load average
130-300 for the whole session with several agents running their own headless
Chromium and `tsc`. Wall-clock frame time and any ablation done under that load
is unreliable — one ablation made the frame *slower* by removing the ship. Trust
`upd:*` and GPU-timer numbers; re-measure frame time on a quiet machine.

## 12. Why the storm sea rendered as a flat slab

Worth recording because it is a class of bug, not a one-off. Under heavy overcast
`uSkyColor` (0.284, 0.272, 0.258) and `uFogColor` (0.303, 0.320, 0.383) land
within 10% of each other, so the reflected sky is the same grey in every
direction, and the body term's own `N.y` factor varies only 1.8% across the whole
slope range. **Nothing in the water shader responded to the surface normal.** A
Force 9 gale therefore shaded as featureless concrete. Noon looked fine only
because its sky actually has a gradient.

Fixed with nine changes (wetness roughness double-count, reflection over-blur,
crest/trough sky occlusion written symmetrically about 1.0 so far water is exactly
unmodulated, whitecap ramp width, wake foam headroom, a foam threshold that
disagreed between `Foam.ts` and the shader, bounded foam accumulation via
max-blend rather than a runaway rate integral, persistent buffer no longer
suppressing live foam, and the wake anchored to VFX's published centre).
Storm went from an effective auto-fail to a real gale with wind-aligned whitecap
streaking; measured whitecap coverage 0.41 -> 0.18 against Monahan's 0.145.

## 13. Two verification-tool bugs — check your instruments before your code

Both were found inside agents' own measurement tools, and both produced
confident, wrong answers:

1. `bilinear()` returned a shared module-level scratch array, so two sample
   results aliased.
2. **Reading a HalfFloat render target into a `Float32Array` returns all zeros
   and does NOT throw.** A foam probe reported "the buffer is empty" in both
   scenes; decoding the raw halves showed storm was actually at 41%.

If a measurement says something is exactly zero or exactly empty, verify the
instrument before believing it.

## 14. The stray waterline line is still unattributed

Ruled out empirically, not by reasoning:
- **Not the ocean clipmap** — the ocean agent confirmed it has no line primitives.
- **Not the ship transform** — probed exact (see section 9).
- **Not VFX geometry** — it survives `wakeStrength = 0` *and* hiding every
  `vfx-*` mesh.

It now reads as a hard **bright** hairline in storm and golden hour. It has been
mis-routed twice (once by me to the ship agent, once by VFX claiming it as its own
Kelvin arms). **Do not guess at it again — bisect by disabling scene objects until
it disappears, then report which one.**

## 15. The frame-rate regression: a synchronous readback, not the clouds

**Root cause: `gl.getBufferSubData` in `AutoExposure.readback` cost 117-156 ms
per call at 0.3 calls/frame = 38-52 ms/frame.** It is a synchronous IPC
round-trip to Chrome's GPU process, so its latency tracks machine contention,
not GPU completion. **A fence can never fix it** — `clientWaitSync` returned
SATISFIED, `readPixels` into the PBO cost 0.012 ms, and the entire cost was the
`getBufferSubData` itself. The two-slot PBO design was sound and irrelevant.

Auto-exposure is now GPU-resident: a one-fragment pass adapts into a 1x1
RGBA32F ping-pong texture that `prepare`, TAA's history rescale and the
underwater scatter sample directly. No readback in the render path. Visual cost:
none — same percentile band, same knee, same asymmetric damping, moved into a
shader.

| | before | after |
|---|---|---|
| frame period p50 | 84.9 ms | **18.4 ms** |
| tick mean / p50 | 43.8 / 21.5 ms | **7.3 / 6.5 ms** |
| sync GL round-trips | 38-52 ms/frame | **none** |
| ANGLE fenced warnings | 160-207/run | **0** |

Engine cost is now **CPU 7.3 ms + GPU ~1.9 ms = 9.2 ms** against a 16.6 ms budget.

**Clouds are exonerated.** Budgeted <=2.5 ms, measured **0.4 ms**; `cloudSteps`
80 -> 24 changed nothing. I had suspected them in section 10 — wrongly.

Also fixed: a bake-loop bug where `requestBake` re-armed stage 1 every frame
while a bake was in flight, so the transmittance table re-rendered **every frame
forever** and multi-scatter was **never baked after init**.

## 16. How to measure performance in THIS environment

Three standard methods are unusable here. Do not repeat them:

| method | why it fails |
|---|---|
| `gl.finish()` bracketing | drifts 60x — one scene render measured 0.6 ms then 36 ms *in the same loop* |
| `EXT_disjoint_timer_query_webgl2` (exposed!) | ANGLE-on-Metal returns the whole command buffer's duration for any sub-region; a 1-tap blit "cost" 35 ms and regions summed to 20x the frame |
| single wall-clock A/B | baselines drifted 65 -> 129 ms between consecutive runs at load 25-215 |

**What works:** the *slope method* for per-pass GPU cost (run a pass K extra
times/frame, round-robin K so drift decorrelates, take the 35th-percentile frame
time; noise lands in the intercept, the slope is the marginal cost), and
**tick/period percentiles** for engine cost. Probes are in `.tmp/slope.mjs`,
`after.mjs`, `storm.mjs`.

**Headless Chromium caps rAF at 60 Hz.** A stubbed page measures 16.6-16.7 ms
even at load 163, so 60 fps is the observation ceiling — a p25 at the cap means
"as fast as this harness can see", not "exactly 60".

**Every raw fps number printed before this section is unreliable** — the same
unchanged scene measured 9 fps and 34 fps twenty minutes apart. `capture.mjs`
now reports p25/p50/p95 frame periods instead.

Current, at load ~15 (not idle): noon p25 **16.7 ms** (at the cap), golden p25
20.2, **storm p25 31.1 ms** — storm is the remaining gap.

**Shared caveat for all owners:** ocean, vfx, sky and weather all show 50-155 ms
maxima in the *same* storm run. That pattern is one shared stall (GC, or a late
shader compile) landing wherever it falls — not four independent bugs. Check that
before optimising your own p95.

## 17. Owner-observed defects, 2026-08-19 — highest priority

The owner played the build and reported five things. Four are rendering defects;
the fifth is repo structure. A zoomed crop of the starboard bow
(`orbit` scene, region 780,480 420x270) confirms all four and links two of them.

**A. The "bracket" off the starboard bow is a BUG, not a design feature.**
A flat grey plank-like slab extends from the bow area out over the water to
starboard, floating *above* the sea surface, roughly horizontal. It is not a
cathead (those are small, paired, and sit at deck level) and not the bowsprit
(that is round, forward, and much higher).

**Strong hypothesis: this slab IS the "stray waterline line" of sections 8/10/14.**
Seen edge-on from a distance a flat horizontal slab reads exactly as a thin line
passing through the hull at waterline height and extending to both frame edges —
which is precisely how it was described. That also explains why it survived
`wakeStrength = 0` and hiding every `vfx-*` mesh: if the slab is a *separate*
mesh (a bow-wave sheet, hull-water skirt, or a mis-oriented quad) that is not
named `vfx-*`, both of those tests would miss it.
**Bisect by name and by module: log every mesh in the scene with its bounding box,
find the one whose box is a thin horizontal slab wider than the hull, and report
which module created it.** Do not reason about it again — it has been
mis-attributed three times now (to the ship, to the ocean clipmap, and to the
Kelvin wake arms).

**B. Foam reads as cotton wool.** At close range the bow and stern foam is a mass
of soft round blobs rather than water. It needs a sharp breaking leading edge,
directional streaking, and much finer detail near the hull. This is the same
"scattered blotches, not breaking crests" the ocean agent already flagged.

**C. Horizontal streak lines across the sea, and they flicker.** Clearly visible
as darker horizontal bands in the mid-distance. The *flickering* is the important
new information: it means temporal instability, not a static shading artefact.
Candidates: cascade/mip band boundaries in the ocean normal or displacement
sampling; specular aliasing that TAA is failing to resolve; or a wake-buffer
sampling seam. This is separate from defect A.

**D. Materials are too flat when zoomed in.** The hull and deck read as flat
colour with almost no grain; the sails read as flat cloth. The owner specifically
asked for deck wood grain and sail fabric weave to hold up under close
inspection. Procedural albedo/normal/roughness detail needs to survive at close
range, not just read correctly at 80 m.

## 18. Repo migration to a standalone project (owner decision 2026-08-19)

The owner asked for the work to live on `main` rather than in a worktree. Checking
the topology first turned up a hazard worth recording: **this git repo is rooted at
`/Users/eugene` — the entire home directory — and `main` is checked out there**,
tracking only 41 files. A naive merge would have put the game at `~/tallship`,
committed `.claude/` (session data, worktrees, settings) and `.DS_Store` into
version control, and left a repo spanning the home directory — which would then
publish the home directory when pushed to GitHub for Pages.

Owner chose a **standalone repo**. Step 1 is done and durable:

```
git subtree split --prefix=tallship -b leeward-standalone
```

That branch has **17 commits with the files at the repo root** (no `tallship/`
prefix) — full history preserved, correctly rewritten.

**Remaining, to run when no agents are active** (it needs a quiet machine; the
first attempt timed out at load 163 competing with six agents):

```bash
DEST=/Users/eugene/Desktop/sail/leeward
mkdir -p "$DEST" && cd "$DEST" && git init -b main
git fetch <worktree-path> leeward-standalone && git reset --hard FETCH_HEAD
# then: add .tmp/ and .DS_Store to .gitignore (both are currently tracked),
# verify `npm ci && npm run build` is green, and confirm base:'./' still
# resolves for a GitHub Pages subpath.
```

Do NOT delete the worktree until the standalone repo is verified building — the
worktree is where every agent is currently working, and `leeward-standalone` must
be re-split after their work lands to pick up the final commits.

## 19. Audio: chains of noise, popping and distortion (owner, 2026-08-19)

The owner reports that when sound appears it is "連環的雜音炸音破音" — successive
bursts of noise, popping and clipping. They also note it may relate to frame
stutter, which is a plausible partial cause: when the main thread stalls, queued
`AudioParam` ramps bunch up and what should be a smooth glide executes as a step,
which is audible as a click. The game was running at 10-30 fps for much of its
life, so this hypothesis is credible — but it is unlikely to be the only cause.

Other candidates, all of which the original spec warned against:
- bare `.value =` assignments on running nodes instead of
  `setTargetAtTime`/ramps (the classic click)
- voice-pool exhaustion or restarting a `AudioBufferSourceNode` that is already
  playing
- summing many voices without headroom so the master exceeds 0 dBFS
- denormals or NaN entering a filter/resonator chain and never leaving
- an `AudioWorklet` (the rigging resonator bank) producing values outside
  [-1, 1] or going unstable at high wind speeds

**Direction change:** see AGENTS.md directive 5. Comfort outranks sophistication.
A calm sea bed is the deliverable; anything that cannot be made clean should be
cut rather than defended.

**This must be verified numerically, not by ear** — no agent can hear the output.
Render through an `OfflineAudioContext` and assert: peak <= 0 dBFS with margin,
no sample-to-sample discontinuity above a threshold (that is what a click *is*),
no DC offset, no NaN/denormal, and a bounded live `AudioNode` count. Then repeat
the test **with simulated main-thread stalls** to reproduce the owner's condition.

## 20. Assist mode landed (2026-08-19). Two findings worth not re-chasing.

Both suites green: `physics-test.mjs` 32/32 (Pro unchanged), `assist-test.mjs`
45/45. Solver 0.074 ms assisted / 0.165 ms Pro against a 2.5 ms budget.

| | Pro | assist |
|---|---|---|
| cruising speed | 12.8 kn (hull-speed wall) | 15.5 kn |
| 90% of cruise from rest | — | 11.2 s |
| steady turn rate | 0.40 deg/s | **4.62 deg/s** |
| 90 deg turn | 73 s | 22.9 s |
| turn radius | — | 92 m = 1.7 ship lengths |
| dead upwind (TWA 0) | in irons, stops | 7.3 kn, never in irons |
| free-decay roll period | 9.31 s | **9.31 s** (mass preserved) |

Pro is provably untouched: in Pro the gate's `answering` term is exactly `0`, so
the expression is a multiplication by exactly `1.0` — bit-identical in IEEE 754.

### A RETRACTED measurement — do not trust single runs of this suite

The previous session reported "gating the rule in Pro moved heading 84 -> 86 deg
and walked the floating-origin case 4069 -> 4162 m". **That was noise.** Two runs
of *identical committed code* gave floating origin **4083 m then 226 m**, and the
24 m/s row **11.49 kn/held 86 then 11.33 kn/held 84**. The origin case samples the
phase of a 4 km sawtooth (`shiftOrigin` rebases past ~4 km), so the result depends
entirely on where the run stops relative to a rebase. Any conclusion drawn from a
single run of that case is worthless.

### Test-isolation leak, deliberately NOT fixed

`sail.luff` — 16 floats of lagged state written only by `Aero.ts` — survives
`SailTrim.reset()`, which covers `brace`, `bias` and `answerRate` but not `luff`.
Same class as the brace leak already fixed. Left alone because `luff` feeds the
force path (`draw = 1 - sail.luff`), so touching it moves Pro's calibrated numbers.
Also: `px.reset()` deliberately lands in Pro, so **set the mode AFTER the reset** —
a probe that sets `assist = true` first silently measures Pro and reproduces the
Pro polar to two decimals.

### USER-VISIBLE BUG: the rig has no "aback" state

Assist, 10 m/s, full press — drawing area by true wind angle:

| TWA | 0 | 30 | 45 | 70 | 135 |
|---|---|---|---|---|---|
| drawing m2 | **2996** | 906 | **629** | 2203 | 2996 |

Dead into the wind the model reports the *entire* sail plan full and drawing;
beating at 10.7 kn it reports four fifths of it flogging. Both are wrong and they
are the wrong way round. Cause: `luffTarget` uses `|alpha|`, so it cannot
distinguish a sail that is drawing from one pressed backwards against the mast —
**there is no aback state**. `sail.luff` feeds the sail shader directly, so this is
what the player actually sees on the canvas.

Fixing it properly means adding a real aback state, which is *more* physically
correct but moves Pro's calibration. That is a judgement call, not a mechanical
fix: either gate the new state to assist (cheap, leaves Pro subtly wrong) or add it
for both and re-measure Pro's polar (correct, costs a calibration pass).

### NON-BUGS — verified, do not chase

- The `IN IRONS` badge appearing in HUD text dumps. `.irons-tag` is
  `opacity: 0` by default and `innerText` reads hidden text. The physics flag
  measured correct in all three states.
- Two transient build breaks seen mid-session (`src/camera/modes/Free.ts`
  undefined `MAX_AXIS_ELEVATION` in a class field initialiser, which stopped the
  app booting entirely; `src/vfx/textures.ts` `worley is not defined`) were fixed
  by their owners. Noted only because live verification is fragile while several
  agents edit concurrently.

## 21. Repo migration DONE (2026-08-19) — this project now lives at Desktop/sail/leeward

**The problem the owner spotted was real and worse than a wrong path.** The git repo
was rooted at `/Users/eugene` (the whole home directory), `main` there tracked only
`global-trade-shock-monitor`, and **all 21 of this game's commits had gone into that
other project's repository**. On top of that, two unrelated agent worktrees
(`exciting-jang-c78a92`, `mystifying-cartwright-0a80c4`, 19 MB) were sitting
physically nested inside `tallship/`.

Now: `/Users/eugene/Desktop/sail/leeward` is a standalone repo on `main` with all
21 commits, history rewritten so the project is at the ROOT (no `tallship/` prefix).
Clean by construction — `git subtree split` carries only tracked content, and the
nested worktrees were never tracked, so none of that came across. Verified:

- `git ls-files | grep -c '\.claude/'` → **0**
- `npm ci && npm run build` → **green**, `dist` **386 KB gzipped** total
- boots and renders from the new repo: noon p25 25.4 ms, 83 draw calls, 0.60 Mtri
- `.tmp/`, `.DS_Store`, `shots/`, `dist/` now gitignored and untracked

**The old worktree at `.claude/worktrees/sailing-game-aaa-quality-ca2247` is now a
stale backup.** Do not work in it. `/Users/eugene/Desktop/sail/leeward` is the single
source of truth; `.claude/launch.json` points the dev server there.

The two nested worktrees are still registered in the home repo and belong to other
sessions, so I left them alone rather than deleting another session's work.

## 22. A tooling bug that invalidated earlier crops

`.tmp/crop.mjs` mixed CSS-percentage and pixel coordinate systems, so its zoom and
registration disagreed by a factor of 1600/1400. **Every crop any agent took with it
landed off-register at the wrong magnification.** Fixed by the ocean agent.

This does not invalidate the *observations* made from those crops — the pixels were
real pixels from a real frame, including the flat grey slab off the bow (§17 defect
A). It does invalidate the **coordinates**: the region examined was not the region
requested. Re-crop before trusting any position stated in §17.

## 23. Camera: why dragging felt broken (2026-08-19, measured)

The owner reported that dragging to look around went the wrong way and that the
angle lock was pointless. **Two independent bugs, plus a third found while fixing
them.**

### A. The recentre was eating held drags — this is the whole "feels wrong"

The chase recentre armed off *"no look **delta** for four seconds"*. A pointer that
is **held but motionless** produces no delta, so a player who drags round to the
bow and then holds still to watch it was indistinguishable from one who had let go.
Measured: **0.741 rad of deliberate look decayed to 0.005 rad — 99.3% removed with
the button still down.**

Fixed with a grip flag (`pointerLooking` tracks pointer *down*, not motion), stall
immunity (`STALL_RAW_DT = 0.25 s`: a frame longer than that taught us nothing about
the player, so the idle timer neither advances nor resets across it), and two soft
gates instead of a switch. Measured 5/5, including the two that prove the recentre
is still alive: it still pulls back 0.420 -> 0.004 rad over 11 s of genuine idle,
and a player parked on the bow stays parked at -3.14 rad.

### B. The inversion was ONE axis plus four modes reading the wrong vector

`src/input/Input.ts:71-72` accumulates **both** axes as `-= movement`. Yaw needs the
flip; pitch does not, because screen Y grows downward. On top of that, four modes
derived their pose from the **eye** rather than the view direction. Signs are now
normalised once in `readPlayerInput`, and no mode reads `world.input.look*` directly.

Measured view rotation per 300 px (= 0.840 rad demanded), **24/24 for the six
player modes**: chase +0.861/-0.862/+0.754/-0.661, helm, bowsprit, masthead, orbit,
free all correctly signed on both axes.

**FOLLOW-UP for whoever next owns `src/input/Input.ts`** (the camera agent
deliberately did not reach in):
1. The real yaw fix is **one character on line 71: `-=` -> `+=`**. Then set
   `INPUT_LOOK_YAW_SIGN = +1` in the camera and change nothing else. Behaviour is
   already correct today via compensation; this only removes the double negation.
2. Publish `s.looking = this.dragging;` plus the field on `InputState`. The rig
   currently duplicates that listener, and it is only leak-free because `Input.ts`
   calls `setPointerCapture` on the same element, which retargets an off-canvas
   `pointerup`. **If that capture call ever leaves `Input.ts`, a drag released
   off-canvas latches the flag and permanently disables the recentre.**

`cinematic` is an honest exception: its own within-shot dolly contributes +0.77 rad
common-mode against a 0.5 rad pan allowance, so no single-window band can separate
drag from director. Its *differential* measured +0.554 on an expected 0.500,
correctly signed.

### C. Yaw locks removed, and one of them was documented falsely

Yaw is now **+/-pi, wrapped rather than clamped** in chase, helm, bowsprit, masthead
and orbit (free is unclamped). The old locks were 60 deg chase, 150 deg helm,
140 deg bowsprit. Measured 7.83-8.27 rad reachable against 7.84 demanded, 5/5.

The bowsprit limit was documented as "you can look right forward" and **was not
true**: its composed axis is 172 deg from the bow, so 140 deg left the view 32 deg
shy of dead ahead. Pitch keeps only physical limits, derived from a single shared
`MAX_AXIS_ELEVATION = 1.45 rad` where a world-up `lookAt` basis degenerates.

### D. Composition — and a coincidence worth naming

Two causes. The lateral offset was specified as a fraction of follow distance, but
chase changes FOV with speed and those agree at only one FOV. And both offset terms
were signed by heel and rudder, so on a steady upright reach they were near zero and
the hull settled **dead centre** (measured NDC -0.10, an outright rubric failure).
Now specified in NDC with `MIN_SHIP_NDC = 0.19`, so heel and rudder *modulate* the
offset rather than create it.

Separately, `LOOK_HEIGHT_PER_M` had put the mainmast truck **eight pixels** from the
top of a 900-line frame. Eight pixels is not a crop, it is a coincidence.

Then the bow screenshot exposed a further defect: at half a turn the composition
offsets were rotating **rigidly** with the look yaw into a shot they were never
written for, crushing the ship against the left edge with the jibboom clipped.
Leading room exists to hold the water she is sailing *into*; at half a turn that
water is behind the lens. Both framing offsets now fade over the first quarter turn
(`FRAMING_FADE_FROM/FULL = 0.45/1.6`, 0.35 residual). The orbit itself does not
fade — only the composition rules — and at `lookYaw = 0` the factor is exactly 1,
so existing captures are arithmetically unchanged.

### UNVERIFIED, and one instrument error to distrust

Three changes made after the last full probe run are typechecked but **not
measured**: the framing fade above, a cinematic accumulator/differential split, and
a switch from bounding-box corners to subsampled real vertices for framing
measurement.

**Distrust the reading "ndc x -4.506" from the earlier run.** `ship-oak` is a merged
batch whose bounding-box corner sits beside and just ahead of the lens, where a tiny
depth yields a colossal NDC. The clipping it flagged was real but nowhere near that
severe.

### A real limitation, stated plainly

Because the idle timer freezes on any frame over 0.25 s wall-clock, on a machine
loaded enough that *most* frames exceed that, **the recentre effectively never
arms**. It fails in the safe direction — a machine that cannot render cannot tell
you the player let go — but its timing is machine-dependent and that is not
finished. Evidence: an injected 3 s stall reported a longest frame of 6.02 s.

To finish: run `node .tmp/camdrag.mjs` on a quiet machine (should read 49/49 or
name what is left), then a capture, then re-read `shots/cam-bow-chase.png` to
confirm the head rig is inside the frame.

## 24. Camera §B strengthened, and one of my own instruments retracted

**Double-measured.** A second independent probe run reproduced the drag result:
24/24 for the six player modes, gains 0.87-1.17, two runs agreeing to within ~2%
per cell. **Drag-up = look-up and drag-right = look-right in all six modes the
player sails with — measured twice, not inferred.** Yaw range re-confirmed too
(chase 8.27, helm 7.83, bowsprit 7.84, masthead 7.84 rad).

**RETRACTED: the cinematic view-axis differential was a bad instrument.** Run B
reported gain 1.11 "correctly signed"; Run 4 gives **1.67**. The flaw is in the
method, not the noise: the differential assumed the director's own motion is
*common* to a drag-right window and a drag-left window, but those are two separate
`enter('cinematic')` calls that land in **different shots at different phases**, so
there is no shared term to cancel. The +0.77 rad of "common" motion in Run B and
+0.102 in Run 4 are just what those particular window pairs coincidentally shared.
A second confound: `dYaw` subtracts the ship's heading change, and that model does
not fit a cinematic shot's aim, so a turning ship injects a further non-common
error. **Treat any cinematic view-axis number as uninformative and demote that
assertion to an informational print.**

What replaced it is exact and passed 4/4 at gain 1.00 — the accumulator half is
director-proof, and `aimOffset` rotates the axis by exactly `lookYaw` by
construction (`bearing = atan2(dx,-dz) + yawOff`). That also settled an older
defect: cinematic declared `lookYawLimit = 0` and gave a dragging player **nothing
at all**.

## 25. The pattern: ten measurement bugs, and they all read as confident answers

This is the most transferable lesson of the project so far. Every one of these
produced a plausible, confidently-stated number that was wrong:

| # | instrument | failure |
|---|---|---|
| 1 | `scripts/capture.mjs` (mine) | wrote PNGs inside the Vite root, so the dev server reloaded between scenes and every scene after the first was captured on an unsettled engine |
| 2 | `.tmp/crop.mjs` | mixed CSS-percentage and pixel coordinates; every crop was off-register at the wrong magnification |
| 3 | ocean `bilinear()` | returned a shared module-level scratch array, so two samples aliased |
| 4 | ocean foam probe | read a HalfFloat target into a `Float32Array`, which returns **all zeros without throwing** — reported "the buffer is empty" when storm was at 41% |
| 5 | `settings.debug` | enabling `upd:*` stats also enables a synchronous readback costing 117-370 ms every 60 frames, so the profiler perturbed what it measured and faked a "shared stall" across four subsystems |
| 6 | camera framing probe | measured a merged batch's bounding-box corner sitting beside the lens, where tiny depth yields a colossal NDC (reported -4.506) |
| 7 | camera orbit probe | a 2.4 s window is ~14 simulated seconds here, and orbit drifts 0.055 rad/s by design, so drift swamped the signal |
| 8 | camera cinematic differential | assumed a common-mode term that does not exist between two separate shot entries |
| 9 | physics floating-origin assertion | sampled the phase of a 4 km sawtooth; gave 4083 m then 226 m on identical code |
| 10 | `scripts/capture.mjs` frame-period percentiles (mine) | reported p25/p50 silently inflated up to 3x when other agents ran headless captures on the same GPU. This is the §29 "3x regression" that §31 retracted: `4cbc8c0` and HEAD measure identically. The tell was in the same data all along — min period 5.7-6.7 ms and 6-7% of frames inside one vsync. **Load average cannot see a busy GPU**, so §29 recorded "load 1.9 at start" while 4-9 rival renderers spun up mid-run |

**Rules that follow, and they are cheap:**
- If a measurement says something is *exactly* zero or *exactly* empty, suspect the
  instrument first.
- Assert that your ablation actually applied. A silent no-op replace is how you
  "verify" a fix that never ran.
- Never trust a single run of anything with a periodic or drifting component;
  run it twice and compare per-cell.
- Two-sided bands, not one-sided sign checks — a one-sided check passed happily
  while chase was losing 70% of the drag.
- Check whether enabling the instrumentation changes the thing being measured.
- Do not infer contention from a metric that cannot see it. Load average is a
  CPU run-queue number and the GPU is invisible to it, so count your actual
  competitors — at BOTH ends of the window, because they arrive mid-run.
  `capture.mjs` now does this and exits 3 rather than print a contended timing:
  a contended number is worse than no number, because it reads as authoritative.
- Prefer a statistic the noise cannot fake. Contention can only ADD time, so the
  minimum period and the share of frames landing within one vsync bound the real
  cost from below. Those two, not the percentiles, are what disproved §29 — and
  they separate "the engine is slow" from "the box is busy" in a single number.

## 26. Camera Run 4: the unverified changes are now proven

**The `Chase.ts` framing fade works** — this was the biggest open risk, and it also
settles the instrument question from §25 conclusively:

| ship at the bow | Run B (box instrument, pre-fade) | Run 4 (vertex instrument, post-fade) |
|---|---|---|
| ndc x range | −4.506 … −0.073 **FAIL** | **−0.332 … +0.107 PASS** |
| worst offender | `ship-oak` at −4.51 | `ship-oak` at **−0.33** |
| off centreline | not asserted | **−0.113 PASS** |

Measured on **6237 real vertex samples, 0 behind the lens**. Same mesh, same shot:
−4.51 from a bounding-box corner versus −0.33 from its actual vertices. **The box
was lying AND the clipping was real** — the screenshot was right to prompt the look.
`noon` composition survived as the arithmetic promised (centre −0.185, rig top at
ndc y 1.213, decisively cropped).

Re-confirmed a third time: all 24 player-mode drag directions, full 360° yaw in all
five modes, pitch saturation 4/4 with no dead band and the lens out of the sea.

### Three residual failures, all diagnosed

1. **`cinematic` yaw over-delivers, and it is REAL** — previously blamed on probe
   contamination, now retracted again in the other direction. The accumulator is
   exact (±0.500, gain 1.00) but the view rotates +0.935/−0.730: differential 0.833
   against a 0.5 rad clamp, **gain 1.67**. The director contributed only +0.102 this
   run, so contamination cannot explain it. Likely the rig's independent
   position/target smoothing amplifying `aimOffset`'s bearing rotation while the
   shot dollies. Lowest priority — auto-director, not a mode you sail in.
2. **`chase / stall after release`** was the harness scoring itself: its own `view()`
   round trip plus a 600 ms wait exceeded the 4 s idle threshold at load 340, so the
   recentre fired legitimately. Patched to a cheap marker sample; patch unverified.
   **But it exposed a real feel question:** at 0.84 rad the hold factor is only
   0.54, so `rate = 0.5 × 0.46 = 0.23/s` and a player who parks at **48° and watches
   for ~10 s loses most of it**. 3.14 rad (the bow) is fully protected and 0.42 rad
   correctly decays, but the middle is soft. `LOOK_HOLD_FROM = 0.55` is probably too
   high a threshold for "deliberate". **Deliberately not retuned** — changing a feel
   constant blind, on a machine that cannot verify it, is how this defect arrived.
   Lower it once the machine is quiet.
3. **`bowsprit / look forward`** read −37.0° versus −7.7° in Run B on identical code
   — a dropped pointer move at load 340 costs 45° of look. Load flake, not a
   regression; capability independently proven by the full-circle pass.

## 27. "typecheck clean" does NOT mean the shaders compile

Two runtime shader errors were live in the tree while `npm run typecheck` reported
clean, and they poison **all** visual QA for every agent:

- `ERROR: 'uHazeBeta' : redefinition` — twice, two materials. `src/sky` declares it
  in `atmosphere.ts` and a material pulls that chunk in twice. **Third instance of
  this exact class** after `luminance` and `D_GGX`/`F_Schlick`. The fix is an
  include guard, which `src/util/glsl.ts` already uses on every snippet
  (`#ifndef LEEWARD_x / #define / #endif`) — sky's own chunks lack them.
- `ERROR: 'vAback' : undeclared identifier` in `MeshDepthMaterial` — the sails-aback
  state landed and the sail shader writes the varying, but the **depth/shadow pass
  compiles a separate program** that never sees the declaration, so sail shadows
  are broken.

`scripts/check-glsl.mjs` catches only the backtick-in-template-text bug. It cannot
catch a redefinition, an undeclared varying, or anything on an alternate material
path. **The only thing that catches these is a runtime compile:**

```bash
node scripts/capture.mjs --out shots/x --scene noon --console
python3 -c "import re,collections;t=open('shots/x-console.log',errors='replace').read();print(collections.Counter(re.findall(r'ERROR: \d+:\d+: (.*)',t)).most_common());print(sorted(set(re.findall(r'Material Name: (.*)\nMaterial Type: (.*)',t))))"
```

Both relayed to their owners. **Any capture taken while these are live is poisoned**
— check the console log for `ERROR:` before trusting a frame.

## 28. Both "blocking" shader errors resolved — one was never real

Cleared with a verified capture: **zero GLSL errors, zero failing materials,
exit 0.** Visual QA is unblocked.

**`uHazeBeta : redefinition` was NOT a live defect.** That block already carried
its own `SKY_WEATHER_HAZE` guard *in addition to* the chunk's `SKY_ATMOSPHERE`
guard, and the comment beside it predicts precisely the observed failure: a
half-applied hot reload pairing a new atmosphere chunk with a cached sky shader
still carrying its own copy. It was a transient artefact of concurrent editing.
**I began adding a third, redundant guard before checking whether one already
existed, and reverted.** Same lesson as §25: read the instrument, and the code,
before fixing.

**`vAback : undeclared identifier` was real, and the fix was half-landed.** The
ship agent had written exactly the right structural fix — a single
`SAIL_VERT_OUT_DECLS` array plus `sailVertOuts(varying: boolean)`, so the cloth
material and its depth material cannot drift — then was interrupted **before
calling it anywhere**. `grep` showed zero call sites. The depth material's
`#include <common>` injection still hand-declared five names and omitted
`float vAback;`, so `MeshDepthMaterial` wrote an undeclared identifier and **every
sail shadow silently failed to compile**.

Wired the helper into all three sites (depth material, `VERT_HEAD`, `FRAG_HEAD`),
so the next varying added cannot repeat this. A half-landed structural fix is
worse than no fix: the abstraction exists, looks authoritative, and is not in the
path.

## 29. PERFORMANCE HAS REGRESSED BADLY — top priority

Measured on a quiet machine (load 1.9 at start), both shader errors resolved:

| scene | p25 now | p25 before | delta |
|---|---|---|---|
| noon | **48.9–51.4 ms** | 16.7 ms | **~3x worse** |
| golden | 58.5 ms | 32.3 ms | ~1.8x worse |
| orbit | 29.2–56.2 ms | 24.9 ms | worse |
| storm | 65.2 ms | 32.9 ms | ~2x worse |

Draw calls (65–87) and triangles (0.56–0.64 M) are unchanged, so this is **not**
geometry. Something landed in the last wave — candidates: the sail aback work, the
ocean clipmap ring rewrite, cloud changes, or the ship's new close-range material
detail (more texture fetches per pixel).

**Bisect this against `758dde4` (the last known-good measurement point) rather than
guessing.** Note §16: `gl.finish()` and `EXT_disjoint_timer_query` are unusable on
ANGLE-on-Metal, and `settings.debug` perturbs what it measures — use the slope
method and p25/p50 percentiles.

## 30. Owner-observed defects, 2026-08-19 evening

### A. Two-frame stutter + full-screen dim flicker, worst on the title screen

The owner reports, **before pressing begin**: a persistent full-screen dim
flicker, and the sails stuttering — described as "stuck, stuck, going back and
forth between two frames". **Catastrophic at close camera on the sails.** Unknown
whether it also occurs in-game.

That signature — alternating between exactly two states, plus a whole-frame
brightness flicker — is characteristic of a **temporal system ping-ponging**, not
of low frame rate. Prime suspects, and note they are all in the same territory as
§29's regression and may share a root cause:
- TAA history alternately accepted and rejected (neighbourhood clamp too tight, or
  a velocity/jitter sign flipping frame to frame)
- the sail vertex animation sampling an alternating jitter or an odd/even frame
  index, which would make it worst exactly where the owner says — close up on cloth
- auto-exposure oscillating between two adaptation states (explains the dim flicker
  specifically, since it is whole-frame)
- the cloud or ocean temporal reprojection disagreeing with TAA's jitter

**The title screen is the tell.** If the sim is paused or time-warped pre-begin,
any system keyed on frame parity rather than elapsed time will alternate visibly.
Check what `dt` and `world.time.frame` do before `begin`.

### B. Ship parts intersect — ropes pass through sails

Needs care rather than brute force: the rig is instanced and the sails are
vertex-animated, so a rope that clears a furled sail may pierce a full one. Routing
must account for the cloth's animated envelope, not its rest shape.

### C. Bow, side and stern spray still read as fake

The owner's description is diagnostic: the **side spray looks like a square, tidy
horizontal waterfall**. That says the emitter is a rectangular grid or sheet quad
rather than something following the hull's curve, with too much regularity and a
hard edge. Bow and stern are also called out.

### D. The US ensign — accuracy matters here

The Constitution should fly the ensign. The owner asks explicitly for care over
position, historical fidelity, cloth quality and physics. Getting a national flag
visibly wrong reads as carelessness, so:
- **Era.** This is the 1797 44-gun frigate. Her War-of-1812 ensign was the
  **15-star, 15-stripe** flag (1795–1818) — the Star-Spangled Banner pattern, stars
  in five rows of three. Today's ship flies a 50-star flag; the 15-star one is
  correct for the vessel being modelled. `AGENTS.md` already specifies "the 15-star
  ensign at the spanker gaff".
- **Position.** The ensign flies at the **spanker gaff** (aft, on the mizzen), not
  at a masthead. A commissioning pennant belongs at the main truck.
- Proportions, star geometry and stripe count must be exact; the cloth needs a
  proper travelling-wave response to `uWind` rather than a flat waving quad.

## 31. §29 RETRACTED — there was no regression, and my instrument was blind

**No commit caused the "3x regression".** The reference point `4cbc8c0`, whose own
message records noon p25 16.7 ms, measures **52.6 ms today — marginally SLOWER
than HEAD's 50.3 ms**. Two independent statistics agree.

**Why I got it wrong, twice over:**

1. **My commit hygiene broke the bisect.** Several commits labelled `docs:` also
   carried large source changes (`84534fa`: 38 files/2205 lines; `3f4ed9d`: 21/1501;
   `200cae3`: 24/1452; `edef72b`: 35/1197). So every candidate I named — the ocean
   clipmap rewrite, the ship material detail, the cloud work — had landed *before*
   my "known good" point, and the window I sent the agent to bisect contained only
   `DIAGNOSIS.md`, three lines of audio, and the sail varying fix. **Source and docs
   go in separate commits from now on.**
2. **Load average cannot see GPU contention.** §29 recorded "load 1.9 at start" and
   still measured 50 ms, because 4-9 other headless Chromium processes spin up
   *during* a run and the 1-minute average lags badly. Load is a CPU run-queue
   metric; the GPU is invisible to it.

**The engine is not slow.** Minimum observed frame period is **5.7-7.1 ms** and
**6-7% of frames complete within one vsync** even with 5-9 competitors rendering.
A frame that genuinely costs 50 ms cannot produce a 7 ms frame. Cost is
fragment-bound: 1-vsync share by render scale is 7% @1.00, 42% @0.70, 47% @0.50,
58% @0.35.

`scripts/capture.mjs` now counts competing headless renderers before and after each
scene and refuses to print an unflagged timing when any exist.

## 32. §30A is frame pacing, not a temporal ping-pong

Every hypothesis I proposed was disproven by measurement over 90 consecutive
title-screen frames:

| my hypothesis | measured | verdict |
|---|---|---|
| whole-frame flicker | brightness ac1(Δ) **−0.01**, ac2 −0.03 | no period-2 signal |
| auto-exposure oscillating | ac1(Δ) **+0.83** (smooth ramp) | not oscillating |
| TAA history rejected | `aa.reset` **0/90** frames | never reset |
| jitter sign flip | **8 distinct** offsets = full Halton cycle | correct |
| frame-parity keying | none found (jitter is `frame % 8`) | none |

**Actual cause: vsync beat aliasing.** `dt` averages **63.8 ms pre-begin / 49.3 ms
post-begin** and **every value is an exact multiple of 16.67** (33.2 / 50.0 / 66.7 /
83.3 / 100.0). A frame cost straddling vsync boundaries lands alternately on 2, 3,
4 and 6 intervals, so animation advances in lurches — precisely "stuck, stuck,
going back and forth". Worst on the sails because that is the motion you watch, and
worst pre-begin because the title screen is ~30% slower. `dt` also pins at the
100 ms clamp in `Engine.tick`, so the sim then advances slower than wall clock and
amplifies the stall. The "dim flicker" is the auto-exposure **ramp** (24.4% swing
pre-begin vs 5.9% post) sampled at 16 fps — a slow pump, not a flicker.

So §29 and §30A are one bug, as suspected — but via frame **cost**, not a temporal
system. Fixing it means fewer competitors and/or genuine fragment-cost reduction,
not touching TAA.

## 33. Two more visual claims that measurement disproved

The perf agent reported the noon frame showing "the ship heeled to roughly 50-60°
at 15.8 kn" and "the square sail plan rendering as one large sheet rather than
discrete sails". **Both are wrong**, measured live:

```
assist true, 14.66 kn
physics_heel_deg   9.96
visual_roll_deg   -9.96     <- exact, not 50-60
sailMeshCount      1  ("ship-sail-cloth")
sailsSetSum        16 of 16
sailAreaDrawing    2775 m2
```

A single sail mesh is **expected** — it is an `InstancedMesh` drawing all 16 sails,
which is what AGENTS.md demands ("instance everything repeated", ship under ~120
draw calls). An earlier full-frame capture plainly shows discrete sails on three
masts.

**This is the second time an observer has misjudged heel from a screenshot** (§9
records me doing it). Tall masts plus yaw relative to the chase camera plus a wide
lens reads as far more heel than 10°. **Measure `ship.heel` against the
`shipRoot` matrix before reporting heel — it takes one probe.**

## 34. A hazard someone created while bisecting

The perf agent bisected using `git checkout <sha> -- src/`, which is **destructive
to concurrent uncommitted work** in a shared tree. It checked the tree was clean at
each step and believes nothing was lost, and flagged it unprompted. Recorded in
AGENTS.md: use a `git worktree` with its own dev server instead.

Also noted: `src/post/Pipeline.ts` sets `(globalThis).__rcPipe = this` under a
`TEMP-DEBUG-RC` comment — a shipped debug global, zero per-frame cost, currently
depended on by probes. Remove before release.

## 35. The hull-side "waterfall" found, and work lost to a shared-tree git operation

**Cause: `vfx-hull-skirt`**, identified by hiding each mesh in turn rather than by
reasoning. A `40 x 6` grid over a **fixed ship-local band**, whose fragment shader
cut coverage with

```glsl
climb = 1.0 - smoothstep(0.15 + uSpeedN*1.5, 0.9 + uSpeedN*2.6, vD);
```

`vD` is height above local water, so that is a cut at **constant height for the
whole length of the ship on both sides** — a ruled top edge with an airbrushed
gradient beneath. `bowGain` floored at 0.35 aft of t≈0.25, so intensity was uniform
end to end. Nothing downstream could rescue it: the silhouette was decided by a
quantity that did not vary along the hull. Replaced by `frothReach(t, side)`, and
height now drives the **threshold** on the filament field rather than multiplying
it, so the boundary tears instead of fading.

Two real bugs found alongside:
- **`bowSlam`'s burst gated at 0.55 g = 5.4 m/s², which is the TOP of the range
  physics writes even in a storm** (under 1.5 in every other scene), so it almost
  never fired. Now 0.35 g.
- `hullSkirtFrag` faked premultiplication by passing `uFogColor * a` into
  `applyAerial`, whose inscatter term `sunColor * mie * 0.55` is **not** scaled — so
  a nearly transparent band received a full-strength sun glow.

### Two of my briefs were wrong, and one cost real work

- **The 11 `THREE.Material: parameter 'defines' has value of undefined` warnings do
  NOT come from `Particles.ts`/`WakeField.ts`** as I told two agents. Traced by
  stack capture to **`src/sky/Pass.ts:38`**, which forwards `defines`
  unconditionally while `bakeMoonAlbedo`, `AtmosphereLuts` and the LUT passes all
  omit it. Fixed with `...(defines ? { defines } : {})`.
- **Uncommitted work was destroyed at ~23:10** by a `git checkout <sha> -- src/`
  during the perf bisect. The VFX agent's four files reverted mid-session (it had
  backups and re-applied them), but **a previous VFX agent's uncommitted
  `textures.ts` / `Particles.ts` work — the fleck sprite and foam-texture
  improvements — was lost and not recovered.** AGENTS.md now forbids that command
  here, but the deeper fault is mine: **agents' work sat uncommitted in a shared
  tree.** Commit each agent's output as soon as it reports, not in batches.
- `scripts/capture.mjs` used playwright's default 30 s screenshot timeout, which
  aborts outright under GPU contention — it killed three of one agent's runs and one
  of mine. Raised to 120 s.

### Still not good enough, and it needs two owners together

**The near-field foam plate is now the dominant fake element.** With all three vfx
meshes hidden, the sea beside the hull is *still* a flat pale plate with a straight
upper boundary. It lives in `WakeField` plus the ocean's consumption of
`wakeTexture.R`, and the field spans **1024 m over its texture**, so it physically
cannot carry near-hull detail — the **ocean** has to add the breakup. This is the
next job and it requires the ocean and vfx owners in the loop together.

Also open: Kelvin arms still read as a broad dark lane at golden hour; bow spray is
still soft because the mist sprite is a torn oval and motion-stretch cannot help
when the camera moves with the ship (relative screen velocity ≈ 0, so sprites draw
square by construction) — the fix is a more anisotropic sheet sprite in
`textures.ts`, which is exactly the file whose work was destroyed; waterline froth
is now too sparse, the direction the agent deliberately chose to err in given the
reported defect was excess regularity.

## 36. The stray line, found: the clipmap cut its holes in the wrong place

Sections 8.5, 10, 14 and 17A are one defect, and it is the ocean's after all — not a
line primitive, not the Kelvin arms, not a ship mesh. `Ocean.updateClipmap` snapped
**every level to its own two-cell grid**, which is right, and then let each ring's
hole sit at **its own centre**, which is wrong: neighbouring levels do not share a
centre. Level k-1's centre lands 0 or +/-1 of level k's cells away on each axis, so
the hole overlapped the finer level on one side and left a **gap running the full
length of the boundary** on the other. A slit of unpainted sea shows the flat grey
of the distance through it: a plank from above, a line at waterline height edge-on,
mitred at the corners. It is scale-invariant, which is why it was seen "at different
distances" — every boundary leaks about the same 20-25 px across.

Measured in the running engine with `.tmp/clipgap.mjs`, which recovers each hole
from its **index buffer** and compares it with the child level's footprint:

| boundary | gap before | frames w/ gap | gap after |
|---|---|---|---|
| L0/L1 | 1.5 m x 96 m | 290/400 | 0 |
| L1/L2 | 3 m x 192 m | 307/400 | 0 |
| L2/L3 | 6 m x 384 m | 299/400 | 0 |
| L3/L4 | 12 m x 768 m | 309/400 | 0 |
| L4/L5 | 24 m x 1536 m | 264/400 | 0 |
| L5/L6 | 48 m x 3072 m | 196/400 | 0 |
| L6/L7 | 96 m x 6144 m | 218/400 | 0 |
| L7/L8 | 192 m x 12288 m | 400/400 | 0 |
| L8/L9 | 384 m x 24576 m | 192/400 | 0 |
| L9/L10 (skirt) | 768 m x 49152 m | 400/400 | 0 |

Overlap on the opposite side was equal to the gap in every case, and is also now 0.

**Do not "snap all levels to one common grid" — it is the obvious fix and it is
wrong.** The only grid common to every level is the skirt's, whose snap is 12.288 km:
simulated over 20 000 camera positions that leaves the camera up to 3.7 km from the
centre of a level 0 whose half-extent is 48 m, i.e. no fine water under the ship at
all. Snapping all levels to the *finest* grid does close the gap and keep the camera
centred, but then every coarse level's lattice drifts a fraction of its own cell as
the camera moves, so the far sea resamples itself every 1.5 m of travel. The
per-level snap is load-bearing: two of level k's cells is a whole number of cells of
every finer level, which is what lands a fine level's morphed outer band exactly on
the coarse level's vertices, and it pins each level to one fixed world lattice.

The fix keeps all of that and moves the hole instead. The offset is always a whole
level-k cell, so nine ring index buffers (hole displaced -1/0/+1 on each axis, all
nine sharing one vertex buffer, ~1.3 MB at gridM 128) cover every case, and
`updateClipmap` picks the one that frames the level below it. Zero extra triangles,
zero extra draw calls, 0.60 Mtri unchanged. The skirt is the exception — its snap is
sixteen of the last ring's, so its offset is a fraction of a skirt cell and cannot
come out of the hole; it is flat and unmorphed (every cascade has faded out by its
6 km cell), so it has no lattice to keep and simply takes the last ring's centre.
That also makes the `HORIZON_RADIUS` comment true in practice for the first time.

`.tmp/gapshot.mjs` projects the strips through the live camera and prints the crop
rectangle for each, so the next person does not have to hunt for a 20 px line in a
1600x900 frame. Before: 14 strips at 5 boundaries on screen in `masthead`, two of
them photographed as hard-edged bands crossing open water. After: "no uncovered
strip at any boundary" in `orbit`, `masthead` and `waterline`.

**Residual, for whoever chases 17C (the flickering streaks):** `effCell` in
`surface.ts` is `max(cell, 2*cheb/uGridM)`, and the second term only reaches `cell`
at a ring's outer edge, so the max picks `cell` throughout — `effCell` is piecewise
constant per level and steps **2x at every boundary**. The morph aligns the two
sides' vertex *positions* exactly; their displacement *mip* still differs by a full
level, so the heights need not match. Not visible in the crops taken here, but it is
the remaining mechanism that can put a hairline at a level boundary.

The fix is mirrored into the stale `ca2247` backup worktree (both files byte-identical
to this repo's) only because the task naming that path predates §21.

## 36. State 2026-08-20, quiet box (0 rivals) — and one severe new artefact

First capture on a genuinely uncontended machine since the harness gained its
contention gate. Zero GLSL errors, zero failing materials, **zero warnings**.

| scene | p25 | p50 | min | 1-vsync | dc |
|---|---|---|---|---|---|
| noon | 21.6 ms | 40.1 | **6.5 ms** | 29% | 85 |
| orbit | 35.4 | 50.5 | 7.0 | 14% | 83 |
| golden | 35.2 | 54.1 | 8.7 | 13% | 74 |

A **6.5 ms minimum against a 40 ms median** is not steady cost — it is intermittent
stalling, which corroborates §31: the engine can render the frame, something
periodically prevents it.

**Landed and confirmed good:** the minimal default UI is in and reads exactly as the
owner asked — speed, heading, wind, and a `MINIMAL | PRO` toggle, nothing else. The
full sail plan renders as discrete sails on three masts. The hull-side "waterfall"
is gone.

### SEVERE: a soft opaque cloud smear covering most of the sky

In `orbit` a large soft-edged pinkish-grey mass covers roughly the upper-left 60% of
the sky. **At full frame it reads as a dark bite taken out of the sky; zoomed 2x it
is the opposite** — the mass is a cloud layer *in front*, and the dark blue region is
correct sky showing through a hole in it, with properly-formed cirrus streaks and
cumulus visible inside. So the defect is that layer, not the blue.

Observations, without a diagnosis attached — do not guess, bisect:
- the mass is soft, blobby and directional, with a scalloped boundary
- there is a **matching hard vertical discontinuity in the water** below its right
  edge, so whatever it is also drives the water's lighting or shadow
- the whole frame carries a warm cast that appears to come from this layer
- it is prominent in `orbit`, where the camera **rotates continuously**

That last point is the cheapest thing to test first: the cloud march runs at quarter
resolution with **temporal reprojection**, and a continuously rotating camera is the
classic disocclusion case. A history that cannot keep up smears into exactly this
kind of soft mass. But the two-layer system (cumulus deck plus high cirrus) could
equally be rendering the cirrus as an opaque sheet, and the water discontinuity
points at `cloudShadowMap` extent. **Bisect by disabling reprojection, then each
layer, then the shadow slice** — three cheap ablations that separate all three.

## 37. Owner's live gameplay screenshots, 2026-08-20 — seven defects, all confirmed

Three real in-game screenshots (12.5–13.0 kn, minimal UI, `MINIMAL | PRO` visible).
More reliable evidence than a headless capture because it is what the player sees.
All seven of the owner's observations are confirmed from the images.

### 1. THE ENSIGN IS A MODERN 50-STAR FLAG — wrong by ~200 years
Clearly legible in the third screenshot: a dense field of small stars in the canton
and 13 stripes. **This vessel is the 1797 frigate; her ensign is 15 stars and 15
stripes** (1795–1818, stars in five rows of three). The *position* looks right — flying
at the spanker gaff aft — but the design is the modern flag.
The previous ship agent was interrupted **precisely while dumping the flag texture to
verify stars and stripes**, so it never checked. Dump the texture to a PNG and count
the stars and stripes before claiming it is correct; do not trust the generator.

### 2. Ropes pass visibly THROUGH the sails
Unambiguous in the first screenshot: rigging lines cross over and through the sail
faces at close range. Still open from §30 B.

### 3–4. Bow, side and stern water still reads as big white masses with straight edges
The owner reports straight-line artefacts still present at bow and stern despite the
hull-skirt fix (§35). Consistent with §35's own closing note: **the near-field foam
plate in `WakeField` plus the ocean's consumption of `wakeTexture.R` is now the
dominant fake element**, and the field spans 1024 m over its texture so it cannot
carry near-hull detail. This needs the ocean and vfx owners together.

### 5–6. Bow and stern read as hollow / see-through structures
New, and distinct from the water defects. The gun-port rows read as an openwork
lattice — you appear to see *through* the hull at the bow and at the stern gallery.
Most likely the ports are modelled as apertures with no interior backing and no
closed lids, so the camera sees sky or the far side through them. A hull with visible
holes reads as unfinished more than any texture flaw.

### 7. The "foreign object" extending from the starboard bow is STILL THERE
The owner has now reported this four times. It has been attributed to the ship, the
ocean clipmap, the Kelvin wake arms and a hull skirt, and a background session is
fixing an ocean clipmap per-level snap gap. **It is still visible.** Whoever next
touches this: bisect by hiding every mesh in the scene one at a time and name the
one that removes it — that is the only method that has ever worked here.

## 38. The cloud mass: coverage confused *columns* with *sky*

Isolated by **twelve ablations on fresh pages**, each asserting the ablation applied
*and still held after 4 s of frames*. All three hypotheses I supplied were wrong,
and one rested on a false premise:

| my hypothesis | verdict |
|---|---|
| temporal reprojection smearing under a rotating camera | **wrong — and the premise is false.** The orbit camera does not rotate continuously during a capture; `CameraRig`'s capture hold stops the azimuth dead 3.4 s in, ~8.6 s before the shot |
| high cirrus rendering as an opaque sheet | wrong — with the deck off, cirrus renders as correct thin wisps |
| cloud-shadow extent | **half right**: the shadow slice is the *water* discontinuity but not the sky mass. Two separable defects that shared a cause |

**The mechanism.** `coverageAt` thresholds a histogram-flattened weather map, so its
knob selects a fraction of **columns** — which equals a fraction of **sky** only for
a vertical ray. Measured: marched shells span **4785 m**, the weather field
decorrelates in **~2500 m** (ACF 0.86 @750 m, 0.59 @1500 m, 0.08 @3000 m). A ray at
25° therefore crosses `4785/(2500·tan25°) = 4.1` independent columns and is opaque if
**any** is dense, so sky coverage is `1-(1-p)^4.1`, not `p`:

| per-column cover | opaque fraction at 10-15° / 15-20° / 20-25° |
|---|---|
| 0.05 | 0 / 0 / 0 — literally no cloud anywhere |
| 0.40 (the scene's value) | 0.78 / 0.995 / 0.998 |

`noon` measures the same — one global defect. `orbit` only *shows* it because it is
the only shot that looks up (40° lens tilted +6°, top of frame at 25.8°, 63% sky);
`noon`'s chase looks down so the ceiling is off the top of frame.

Second bug in the same function: `max(0.12, 1-t)` stopped `u` reaching 1 once
per-column cover fell under 0.12, and a column makes no cloud until `cf` clears
~0.37 — so **low cover rendered zero cloud rather than sparse cloud**.

**Third bug, visible only once the first was fixed.** Every cumulus carried
geometrically-spaced concentric ring terraces. The start dither was applied once as
`t0 + dt*jitter` with `dt` the *first* step, but steps grow `1.055^48 = 13x`, so deep
in the march the offset randomised **1/13** of the interval it was meant to — fixed
sample distances paint iso-distance shells. It survived 96 steps, so it was never
undersampling. Now samples a uniform random point inside each step, which is also
the unbiased estimator.

**Discipline worth copying:** the agent measured whether *its own* change caused an
apparent frame-time difference. A matched interleaved A/B in one page, switching only
`uCoverage` between the new and old values, came out indistinguishable — so it
reported the difference as not attributable to itself rather than claiming a win or
a regression.

### Still open in the sky
1. **`cloudLightDepth` has no dither at all** — five geometrically-growing sun-march
   steps at fixed offsets, i.e. exactly the bug just fixed in the view march, so
   `tauLight` is still quantised on fixed cone shells. Best next suspect for residual
   brightness banding.
2. Cloud silhouettes stair-step (half-res buffer plus a hard density threshold).
3. Clouds read as cotton wool, not cauliflower cumulus — `uErosion` 0.376 and a 750 m
   detail tile barely register at these distances.
4. `CLOUD_COLUMNS_PER_RAY = 4.1` is one scalar for a quantity that genuinely varies
   with elevation, and **cannot** be made view-dependent: the density field must be
   single-valued or clouds would change as you look around and the shadow map would
   disagree. Calibrated at 25°, so the zenith is slightly under-covered.

### Two infrastructure consequences
- **Gating the debug globals breaks 15 `.tmp/*.mjs` probes** — they must now set
  `settings.debug = true` and let a frame pass. Note the trap: `settings.debug` also
  arms §25 #5's synchronous readback, so a probe wanting the handle *and* a timing
  must use `ext.post.profile()`.
- **`capture.mjs` was exiting 1 on a headless `AudioContext` device error**, which
  made the exit code meaningless — a real GLSL failure and "this box has no sound
  card" became indistinguishable. Environment noise is now separated from real page
  errors. Fixed.

## 39. The ensign, the see-through hull, and TWO objects at the same station

### The stars were inverted pentagrams
Stripe and star *counts* were already right (15/15, `RWRWRWRWRWRWRWR`, 3 columns x
5 rows). But ray-casting one star's outline gave arms at **36.8, 108.5, 180.3,
252.5, 325.5 degrees** instead of 0/72/144/216/288 — **a point straight down**.
`starSd()` takes `+y` as the star's up; the caller passed `fy - cy` while `v` runs
*down* the hoist. Fixed with `cy - fy`.

**This is the case for dumping the texture rather than reading the generator.** The
code computed a correct star at a correct position; only the rendered pixels showed
it upside down.

### I gave a wrong specification and was corrected with evidence
I specified the canton spanning the top **7** of 15 stripes. The agent kept **8**
(measured 7.992) and explained why: 7 is a count belonging to a **13**-stripe field
(7/13 = 0.538 of the hoist), and the same *proportion* on 15 stripes is 8.08 —
which is what the surviving flag's 16 ft 1 in union on a 30 ft hoist measures.
Carrying the count rather than the proportion would put the union at 0.467 and leave
it visibly shallower than the real flag. **It is right and I was wrong.** Recorded at
`UNION_STRIPES` so nobody "fixes" it back.

### The hull was see-through because of face culling, not missing lids
Worse than reported: spar-deck ports showed the far-side **sails** straight through
the ship. The surfaces that should stop the eye — the gun deck's inner shell, the
inboard face of the bulwark — are single-sided and face *inboard*, so from outside
they are back faces and get culled. Fixed with port backing quads (two, not a
double-sided material, because the family shares one material and the faces want
different values), a gun in every open port sized from the aperture's measured
depth, and a liner brightness gradient — sighted *along* the hull the ports had read
as a row of glowing ochre slots, which was the "openwork lattice".

Also: **the port lids were rotating the wrong way.** `-ang` carried the hanging
direction inboard on *both* sides, so every open lid swung in through the bulwark,
leaving the aperture completely unobstructed and laying a black plate flat on the
spar-deck planking.

### The four-times-misattributed object is TWO objects at the same station
1. **Ours: the spritsail yard.** `Parts.ts` gave every non-mast yard
   `pivot.set(0,0,0)`, so its 60° brace was applied about the **ship's origin
   31.7 m away** instead of its own centre. Ship-local extent, by mirroring
   `shipPart()` on the CPU:
   `x [22.91, 30.12] -> x [-3.61, 3.61]` against a **6.65 m half-beam**. It was
   hanging 23-30 m out to starboard, 8 m above the water, with its gear stretched
   out to it.
2. **Not ours: `vfx-hull-skirt`** (`src/vfx/HullWater.ts:113`) — a flat hard-edged
   white slab on the water running forward past the stem. **Its geometry is a unit
   grid displaced entirely in the vertex shader, which is why every bounding-box
   hunt came back empty.**

**Two different objects at one station is why this was misattributed four times** —
each investigation found *a* cause, fixed it, and the other remained.

### Rope survey, measured before touching
Piercings by family in live trim: `ratline-lower` 17-23, `brace` 15,
`shroud-lower` 7-10, `headstay` 4, `backstay` 3-4, `buntline` 2, others ≤2.
Course braces re-routed aft to a pin rail — which is where they actually lead, not
to the next mast — took brace 15 -> 12. A second change measured no better and was
**reverted rather than kept unmeasured**.

### A probe artefact retracted mid-run
The agent was convinced the sails were ~25% transparent and had measured an alpha.
They are not: DoF was focused by the camera rig for *its* eye 70-110 m astern while
the probe's eye was 3 m from the subject, and TAA was reprojecting with the rig's
matrices rather than the ones forced inside `render()`. Material reads
`transparent: false, opacity: 1, transmission: 0`. **Tenth measurement bug** (§25).

### Still open
- **Ratlines and lower shrouds pierce the bellying courses** (17-23 and 7-10) —
  this is the *sail* reaching into the shroud gang, not a misrouted rope, so it needs
  a camber-envelope clamp or contact-aware routing, not a constant. Largest count by
  far.
- Upper-tier braces pierce 12: a straight chord from a topgallant yardarm to the next
  mast cannot clear that mast's own canvas; needs a curved route.
- **Spanker cluster:** the mizzen crossjack yard sits at y 15.4, *below* the gaff at
  16.4, so braced round, its after arm sweeps into the spanker's cloth and its
  footropes, lifts and topping lift pierce with it.
- **The bowsprit is too long** — `ship-oak` reaches z = -51.6, i.e. 24.6 m forward of
  the stem, giving ~78 m sparred length against the 62 m in AGENTS.md.
- Hull salt-streak weathering reads as heavy vertical rain streaks at close range.
- The ensign hides behind the spanker in light air.
- The helm camera frames wheel, fife rail and grating as an unreadable jumble.

## 40. The foam plate IS fixed — and fixing it revealed the next defect

### Verified visually at last
The near-field plate is gone. Waterline and orbit crops now show **discrete torn
foam flecks over deep blue water with clear water between them** — which is exactly
what thresholding a histogram-flattened field should produce, and the opposite of
the uniform wash bounded by a smooth curve that was there before.

The cause was never detail, it was the coverage function. Integrated over 6400
samples against the real baked texture, the old form rendered **0.056 coverage when
asked for 0.000** (a 5.6% white haze over the entire open sea) and **0.302 when
asked for 0.180** — a third of an alpha over 100% of the footprint. That is the
plate, in one line of arithmetic. `saturate(x*1.7)` cannot produce foam; it produces
a wash with a smooth boundary.

Note the shape of the insight, because it generalises: thresholding a **flattened**
field has expectation exactly `c` at *any* ramp width, so the boundary can be torn
with as much high-frequency detail as the pixel resolves **while the area stays what
the physics asked for**. Detail and correctness stop competing.

### NEW: hard rectangular shadow blocks on the sails
Clearly visible in the `orbit` crop: the sails carry **hard-edged dark rectangular
patches** where other sails shadow them. They read as grey rectangles pasted onto
the canvas, not as soft cloth shadows, and they are now the most damaging thing in
a close view of the ship.

**This is very likely a defect that our own fix exposed.** §28 restored sail shadows
by wiring `sailVertOuts()` — before that, `MeshDepthMaterial` wrote an undeclared
`vAback` and **every sail shadow silently failed to compile**, so there were no sail
shadows at all to look wrong. Now they render, and their quality is poor.

Do not guess the owner: the shadow map itself (CSM cascade count, `shadowMapSize`,
filtering) is `src/sky`, while the sail depth material is `src/ship`. Bisect —
vary `settings.shadowMapSize` and the cascade split first, since a resolution or
filter problem and a depth-bias problem look nothing alike once you change one.

Also still visible: a hard-edged white slab under the hull at the waterline, and
the sails still read papery.

### A measurement caveat worth keeping
The `waterline` frame is smeared by motion blur, because the `cinematic` camera
moves during a **106 ms** frame under 9 rivals of GPU contention — the shutter
integrates far more movement than it would at 16 ms. Contention does not change
pixels, but it *does* change motion blur, so **a contended frame is not a valid
reference for anything the camera moves through.** Use `orbit` or a static mode
when the box is busy.

## 40. Audio: the click question, and why every previous zero was unverified

The owner's "chains of noise, popping and distortion" (§19) is now measured
rather than argued, and the headline is that **the measurement was the missing
piece, not the fix**. Every predecessor reported 0 clicks. None had shown that
their detector could count a click that was really there.

**The positive control.** `ClickWatcher.inject` schedules 4 ms attack ramps of
known amplitude at a known lead, straight into the detector's own input
(inaudible — the detector's output is zeroed). Sweeping the lead:

| lead | caught | worst jump |
|---|---|---|
| -20 ms | **6/6** | -25.9 dBFS, x99 over local |
| -5 ms | **6/6** | -26.0 dBFS, x100 |
| 0 ms | 0/6 | none |
| +2 ms | 0/6 | none |
| +55 ms (LEAD_S) | 0/6 | none |

So the detector is not blind: it catches a deliberate step with a 99x margin.

**But the mechanism written into `Probe.ts` and `ClickProbe.ts` does not
reproduce.** Those files state that online, an event at `currentTime + 2 ms`
lands in the PAST and collapses a ramp into a step. On this box it does not:
0 ms lead is clean, and only a NEGATIVE lead steps. `baseLatency` is 5.33 ms and
Chrome picks the automation up about one 2.7 ms quantum after `currentTime`, so a
4 ms ramp is *compressed*, not collapsed. LEAD_S stays at 55 ms — it costs
nothing audible and a device with a larger buffer may need it — but the margin is
the whole 55 ms, not the few milliseconds the comments imply. `needLeadS`
measured 16.00 ms (3 quanta) against LEAD_S 55 ms, shortfall 0.

**The acceptance test.** Live `AudioContext`, per-sample detector on the master,
main thread blocked by spinning 80-150 ms at intervals — which on the title
screen is the normal state, not a corner case (§32).

    140 stalls, 16 960 ms blocked, worst frame gap 198 ms  ->  0 clicks, 0.00/s

across calm / gale / worst case. Peak -9.8 to -32.5 dBFS, 0 clipped samples,
DC 1.3e-5, 0 NaN, 0 denormals, 556 nodes live == created in every scene, main
thread 0.10-0.15 ms/frame against a 1.5 ms budget.

**The limitation that matters, and it is not fixable by tuning.** The detector's
threshold is 12x the LOCAL first-difference RMS, so it rises with the programme.
Measured detection floors:

| bed | floor | programme peak | verdict |
|---|---|---|---|
| calm | **-41.9 dBFS** | -32.5 dBFS | 9.4 dB of margin — the zero is real evidence |
| gale | -12.0 dBFS | -14.0 dBFS | floor ABOVE the peak — the zero is weak |
| worst case | -6.0 dBFS | -9.8 dBFS | weak |

A bright broadband bed masks a step that a calm bed makes obvious. That is
auditory masking, not a bug: dropping CLICK_RATIO would buy ~3 dB against a
>12 dB gap and spend the false-positive margin the constant exists to protect.
The right reading is that **the calm bed — directive 5's priority, and the title
screen where the owner heard the worst of it — is proven clean, and a gale's zero
must never be quoted as proof.** Every click count in `audio-live.mjs` is now
printed next to the floor of the bed it was measured under.

**Two holes closed in the lead invariant.** `minLeadS` can only see events that
carry a time, so a bare `.value =` on a running parameter — the classic click —
was invisible to it. `LeadSpy` now patches the `value` setter too: 0 bare
assignments across 19 949 timed automation calls. `late` (backstop clamps) is 0
both offline and on live hardware.

**Sea bed rebalanced (directive 5).** At sea state 7 the 150-800 Hz band had
collapsed to 9% of the bed while everything above 3 kHz held 34% — exactly the
"rumble with a hiss on top and nothing in between" `Sea.ts` exists to prevent.
Mid rush given 17 dB of range instead of 14 and a shelf that opens less far, foam
hiss 6 dB quieter at full breaking, wake 5 dB quieter at full speed. Result:

| state | RMS | body 150-800 Hz | above 3 kHz | envelope cv | breath |
|---|---|---|---|---|---|
| flat calm | -44.6 | 29% | 0.0% | 0.13 | 4 s |
| light air | -42.8 | 41% | 0.6% | 0.12 | 34 s |
| moderate | -37.2 | 53% | 1.1% | 0.12 | 25 s |
| gale | -27.1 | 22% (was 9%) | 11% (was 34%) | 0.12 | 9 s |

Worst-case peak improved from -9.70 to -12.18 dBFS as a side effect, and so did
the detector's own sensitivity, because a less bright bed masks less. The speed
cue survived the cut: centroid 959 -> 3878 Hz over 0-13 kn, monotonic.

**Tooling.** `scripts/audio-live.mjs` needs no dev server and no game: it bundles
`src/audio` with esbuild and builds the rig against a real `AudioContext` inside
the page. Two runs were lost to the old coupling — Vite full-reloads on any
module it cannot hot-patch, which destroys the `AudioContext` and the detector's
counters while every call still succeeds. It also means a broken ocean shader
could stop audio being measured at all. One trap worth not re-finding:
`about:blank` has an opaque origin, so `URL.createObjectURL` yields
`blob:null/...` and `audioWorklet.addModule` refuses it — both worklets here load
that way, so the rig silently fell back to biquads and the detector failed to
attach, reporting `usesWorklet=false` and a null `watch`. Intercepting a fake
https origin with `page.route` fixes it and still needs no server.

45/45 checks green, `node scripts/audio-live.mjs`, exit 0, reproducible across
three runs.

## 41. Audio: a mechanism I recorded as fact does NOT reproduce here

**Correction to §19 and to several briefs I wrote.** `Probe.ts` states — and I
repeated to three agents — that an event scheduled at `currentTime + 2 ms` lands in
the past and collapses a 4 ms ramp into a step. **On this box it does not.**
Measured with a positive control that injects known 4 ms ramps at known leads:

| lead | click caught |
|---|---|
| **−20 ms** | 6/6, worst jump −25.9 dBFS, ×99 over local threshold |
| **−5 ms** | 6/6 |
| 0 / +2 / +5 / +20 / +55 ms | **0/6** |

Only *negative* lead steps. `baseLatency` is 5.33 ms, `outputLatency` 32.00 ms, and
Chrome picks automation up about one 2.7 ms quantum after `currentTime`, so a 4 ms
ramp at +2 ms is **compressed, not collapsed**. `LEAD_S` stays at 55 ms because it
costs nothing audible and a device with a larger buffer may need it — but the real
margin is the whole 55 ms, not 2 ms.

### The gap was the instrument, not the count
The click count was already 0 everywhere. **Nobody had shown the detector could
count a click that was really there**, so the zeros carried no information. That
positive control is now the thing that makes every subsequent zero meaningful.

Two holes closed in the lead invariant: `minLeadS` was blind to a bare `.value =`
assignment — no time argument, so no lead, a step by construction. A spy on the
value setter reports **0 bare assignments** across **19,949** automation calls,
min lead 55.00 ms, 0 backstop clamps. **A grep was not an invariant.**

### An honest limit that must be quoted with every zero
**The detector cannot resolve a click inside a loud bed, and this is not tunable.**
Measured noise floors against programme peak:

| scene | floor | peak | margin |
|---|---|---|---|
| calm | −41.9 dBFS | −32.5 | **9.4 dB — the zero is real evidence** |
| gale | −12.0 | −14.0 | floor above peak |
| worst case | −6.0 | −9.8 | floor above peak |

In bright broadband beds the floor sits *above* the programme peak. That is
masking, not a bug — lowering the ratio buys ~3 dB against a >12 dB gap and spends
the false-positive margin. So: **the calm bed is proven clean; a gale's zero must
never be quoted as proof.** Every count now prints beside its floor.

That is the right priority anyway — the title screen, where the owner heard the
worst of it, is a calm bed.

### Instrument bug #11, and it inverted a result
`uifoam.mjs`'s palest-tercile statistic lies about thin marks. The HUD divider is
1×10 px, so its padded box is mostly halo and the palest third *by ground* can
contain no lit pixel at all — `q(0.98)` then returns a shadow pixel. It printed
"ink 1.1:1" for a hairline measured elsewhere at sRGB 255 on a ground of 61, i.e.
**11:1**. That empty sample made the first after-run look flat (storm 1.70→1.86)
when the real move was **3.32→4.48**. Fixed by scoring thin marks over their whole
length against the palest ground they land on.

### Two serverless harnesses now exist
The dev server has been down for whole agent sessions, so two agents built around
it rather than waiting:
- `scripts/audio-live.mjs` bundles `src/audio` with the esbuild already inside vite
  and builds the rig against a real `AudioContext` in-page. **Trap worth not
  re-finding:** `about:blank` has an opaque origin, so `blob:null/...` URLs make
  `audioWorklet.addModule` fail — the rig then silently fell back to biquads and the
  detector never attached (`usesWorklet=false`, null watch). `page.route` on a fake
  https origin fixes it, still serverless.
- `.tmp/glslcompile.mjs` compiles real WebGL2 programs on a `data:` URL. Its own
  first version compiled as GLSL ES 1.00 and reported eight bogus `textureLod`
  errors — the instrument was fixed, not the shader.

## 42. Findings handed over from the UI agent

**Helm view: not the UI.** The readout is 112×117 px bottom-left over deck planking
and fully legible; UI is under 2% of the frame. For `src/camera`: the eye sits
~0.5–1.5 m from the grating and fife rail so timber fills the centre-bottom ~45%
with no silhouette, **no ship's wheel is identifiable anywhere in the frame**, and
the lens is low and pitched down so the horizon survives only in the left third —
a helmsman steers by horizon and bow.

Also: near timber is heavily smeared while sails and distant deck are sharp — a
TAA/motion-blur history problem on **near** geometry (`src/post`/`src/vfx`) — and
the shrouds render as dense moiré (`src/ship`).

**Phone chase framing:** the chase camera does not adapt to a 0.46 aspect ratio; on
a 390×844 viewport the ship fills the left half with the bow cut off. `src/camera`,
and direction 4 makes small viewports a real target.

**Open question for the owner.** `KN` and `PRO` are the weakest marks left (ink
221/237 against 255 for `MINIMAL`/`NNE`) because K, N, P, R and O at 9 px are
diagonals and curves that never reach full pixel coverage. The fix is 10 px caps,
which changes a look the owner has already approved — so it is a question, not a
change.
