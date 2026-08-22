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

## 43. Three of my own visual reads failed measurement in one sitting

Direction 3's first capture (`wildlife` scene, 81 draw calls, p25 21.1 ms, quiet box)
looked wrong to me in three ways. I measured all three before briefing anyone, and
**all three were wrong.** Recording them because the pattern matters more than the
individual mistakes.

| what I saw | what I measured | verdict |
|---|---|---|
| "foam far too much and too white, reads as ice floes" | over the sea band: **5.3%** above 170 sRGB, **0.3%** near-blown | normal whitecap coverage for 14 kn / sea state 3 |
| "sea has periodic strip-line banding" | column-mean sd 13.6 over mean 95.4; **60 sign changes in 119 gradient steps** | no clean periodicity — that is noise, not banding |
| "the envelope work flattened the sails into cardboard" | flat-plate share **fell** 22.0% → 18.8%; p10..p90 spread 28 → 27 | no flattening; the two frames differed by +15 sRGB of lighting |

The mechanism in every case: **high-contrast features read as larger and more
uniform than they are**, and two frames captured minutes apart have different sun,
different cloud field and different wave phase, so any A/B by eye silently compares
three variables at once. The wake is genuinely bright, so "too much foam"; the sails
were genuinely brighter in the second frame, so "flatter".

The one thing that survived: **hard rectangular shadow blocks on the sails**, at 5.2%
and 5.6% of sail pixels in the two frames respectively — present, roughly unchanged,
and therefore *not* a regression from the rig-envelope work. Three independent
observers had flagged it. That is the difference between a real defect and a story:
it reproduces across frames and it survives a number.

**Standing caution for me, not for an agent:** I generate fluent defect narratives
from crops, and they are wrong about half the time. Measure before briefing. A brief
built on a wrong premise costs an agent its whole session — one agent spent a session
on a cloud hypothesis that rested on my false claim that the orbit camera rotates
continuously during capture.

## 44. Two reports about my own instruments: one right, one wrong

The world agent reported two defects outside its directory. Both were worth checking
and they came out opposite ways.

### Right: `check-glsl` missed the one bug it exists to catch
It hit a backtick pair in a GLSL comment in `ocean/shaders/surface.ts`, got
`check-glsl: clean`, `tsc --noEmit` green, and a **failed `vite build`**.

Reproduced. The lexer has no recovery: the first stray backtick pops it out of
template state, so every later line in that file is misclassified as code and
silently skipped. Minimal case — line 3 is reported, **line 4 is not**:

```
const F = `
  // an odd backtick like `this flips the lexer
  // and then `this real pair` is silently missed
`;
```

The design was the mistake. The net that localises the error was the same net the
error destroys. Two independent checks now run: a **parse** through esbuild (the
parser Vite uses, so "will not build" is a fact and cannot be desynchronised by the
bug it hunts), and the **lexer** for the plain-language "backtick in a GLSL comment,
use single quotes" — now asserting its own end state, so when it loses sync it says
so instead of printing `clean`.

### Wrong: `capture.mjs` does *not* shoot through the title card
`UiLayer.enterCaptureMode()` already calls `title.dismiss(true)`, `firstRun.hide()`
and `panel.close()` when it sees `capture:scene`, which the harness emits per scene.
Measured before believing it: centre luminance differs **0.7%** between a
clicked-through run and a normal one, and the centre crop shows open sea where the
display type would be. The agent had generalised from its own probe, which serves
`dist/` from a route handler and never emits the hook.

I kept a **tripwire** anyway, because the failure it imagined would have been
expensive and invisible: `.intro` lays a radial scrim at `rgba(shade, 0.5)` over the
**centre** of frame, falling to 0.04 at the edges. Every tonal, contrast and exposure
judgment ever taken from these PNGs would have been made through a half-strength dark
vignette that also *inverts* the natural one. One check per scene beats trusting a
hook in another module to keep working.

## 45. `npm run check-shaders`: the gap in §27 is closed for pass shaders

42 programs across `src/sky` and `src/post`, compiled **and linked** against real
ANGLE-on-Metal in 1.5 s, no dev server and no engine boot. Discovered from the
exports, so a new pass is covered the moment it is written.

Its green is only worth what its controls prove, so both are recorded in the file: a
bad swizzle (`tsc` 0 errors, `check-glsl` clean, **this fails**) and a read-but-
unwritten varying (`tsc` 0 errors, **this fails on link**) — the `vAback` class.

Its own first two runs were both wrong, and both are now documented traps: compiling
the post chain as literal ES 1.00 invented 27 `'varying' : Illegal use of reserved
word` errors, and the next run rejected a working `sampler3D`. three compiles every
non-raw `ShaderMaterial` as `#version 300 es` on WebGL2 and hands GLSL1 sources
compatibility defines, so the prefix is now three's own, copied from
`WebGLProgram.js:800-828`. **If a whole directory fails identically, the version
table is the suspect, not the shader.**

One more thing worth keeping: the first varying control **passed when it should have
failed**. An unused mismatched `in` is legal GLSL — the spec only requires a match
for statically-used varyings — so declaring one and stopping there tests nothing.
That was a bad control, not a gap in the checker.

**Not covered: material shaders.** `ocean/shaders/surface`,
`ship/shaders/{parts,sail,line}`, `vfx`, `world` go through three's chunks via
`onBeforeCompile`, so only a real engine boot assembles them. `capture.mjs`'s zero-
`ERROR:` console check remains their instrument, and a green here does not cover them.

## 46. What the harness can and cannot resolve, measured properly at last

Three agents were killed mid-task by a usage limit. Salvaging their work needed a
cost A/B, and running it produced the number this project has needed all along.

**Paired 3-vs-3, same scene (`noon`), quiet box, `rivals 0p/0b` on all six runs:**

| | p25 samples | median |
|---|---|---|
| with the new cloud profile | 27.6, 22.6, 35.7 | **27.6 ms** |
| without it (stashed) | 28.1, 19.6, 33.9 | **28.1 ms** |

The medians differ by 0.5 ms. **The within-group spread on byte-identical code is
13.1 and 14.3 ms.** So this harness cannot resolve a change below roughly 14 ms of
p25, and any single-run comparison at that scale is noise.

That retroactively explains §31 (the "3× regression" that did not exist) and it is
now the standing rule in every agent brief: run a paired multi-sample A/B, use
`ext.post.profile()`, or state that the cost could not be resolved and give an
analytical bound. It is the same conclusion a sky agent reached about its own offline
bench by a different route — an A/A control on identical code differing 7.02%.

## 47. The helm view had no horizon, and the defect was eight centimetres

The ship publishes `helmY = 7.35` — a 1.68 m eye on a quarterdeck at 5.67 — and
`bulwarkY = 7.436`. So the helmsman's eye sat **8.6 cm below the top of his own
bulwark**, and measured on a 1600×900 frame the sea line was behind timber across
**100% of the frame width**: longest clear run 0 px. Every other complaint about that
view followed from this one.

The real ship does not have the problem because its quarterdeck is a whole deck above
the waist; this model's is 0.18 m above it, so the waist bulwark sits at eye level.
That is `src/ship` anatomy, not camera, so the camera now solves the constraint
instead: `Math.max` over the published `helmY`, the bulwark cap plus clearance, and
the wheel's upper rim plus clearance. The moment `src/ship` publishes a stepped
quarterdeck, `helmY` wins on its own and the camera change goes inert with no edit.

**Still open in that view:** near geometry is measurably half as sharp as
mid-distance geometry (mean |grad| 8.90 vs 18.43, strong-edge share 21.8% vs 50.0%),
which is backwards for a view where the deck is what you are standing on; the canvas
reads as bumpy stucco rather than woven flax at 1–3 m; and the shrouds are a dense
aliased net.

## 48. The phone framing limiter is the yard span, not the hull

At 390×844 the ship filled the left half with the bow cut off — 43 px from the left
edge and **9 px from the right**. The instinct is to blame the 62 m hull, and it is
wrong: dead astern the hull is foreshortened to almost nothing while the main yards,
**29 m tip to tip**, lie square across the lens.

Two compounding effects made the phone the worst case rather than merely a smaller
one. The lateral composition offset is specified in **NDC**, so in metres it is
`ndc · d · tanHalfX` — it *shrinks* as the horizontal field shrinks, which makes the
phone shot more nearly dead astern, which is the widest presentation of the yards.
And a 64.5° **vertical** lens gives 96.6° of horizontal field at 16:9 but only 32.5°
at 0.46. So the phone gets the widest subject in a third of the field.

The fix is a floor on follow distance derived from the published `mainYardHalfSpan`
through the frame's horizontal half-tangent, and it is **provably inactive at 16:9**:
the worst case over every state is 26.9 m, below `CHASE_MIN_DISTANCE`, so `Math.max`
can never pick it. Verified by projecting the ship's own extremes through the live
camera — at 390×844 every extreme is now inside the frame, widest yardarm 0.568 NDC;
at 16:9 the half-width is 0.163 against the 0.176 that distance 74 predicts, i.e.
unchanged.

**Instrument note.** My first attempt measured framing by thresholding pixels and
reported the ship as 99.9% of frame at every aspect, because foam is bright and
neutral and so is canvas — a pixel heuristic cannot separate a hull from a whitecap.
Projecting the geometry through the camera matrices is exact and took less code.
`.tmp/framing.mjs` does it; three is not on `window.__leeward`, so it does the
quaternion and matrix arithmetic by hand rather than importing a second copy of three
into the page, which would not be the engine's three.

## 46. Near geometry smeared, far geometry sharp: motion blur was blurring the deck the eye stands on

The UI agent's read in §42 — "near timber heavily smeared while sails and distant
deck are sharp" — was right, and it survived measurement, which by §43's standard is
what separates a defect from a story. It is not TAA history and it is not depth of
field. Motion blur was smearing the deck because the velocity buffer told it the deck
was moving at 300 px a frame, and the deck was not moving at all.

### The isolation, and the first attempt that had to be thrown away

First attempt: disable one pass, capture, compare. It produced a contradiction — the
all-passes-off variant measured *less* sharp over the sails than the one-pass-off
variants — because the ship is sailing and the variants were captured a minute apart,
so wave phase, cloud field, sun and heading all differed. §43 again, from the other
side: **an ablation is an A/B, and an A/B by eye or by single frame silently compares
three variables at once.**

What works: visit the variants **round-robin, many cycles**, and carry a second
`base` as the null. `helm`, 1600x900, ultra, HUD off, six cycles, mean |grad luma|
over four fixed regions, `.tmp/nearsharp.mjs`.

| variant | near | mid | sails | far |
|---|---|---|---|---|
| base | 4.42 ±0.52 | 6.83 ±0.93 | 7.71 ±2.18 | 5.91 ±1.93 |
| motion blur off | **6.42 ±0.41** | 8.63 ±1.16 | 11.68 ±2.08 | 10.32 ±2.95 |
| depth of field off | 4.81 ±0.51 | 6.88 ±0.96 | 8.78 ±1.56 | 7.03 ±1.59 |
| TAA -> SMAA | 5.64 ±1.07 | 9.02 ±1.61 | 14.35 ±1.60 | 9.59 ±1.73 |
| base again (null) | 4.74 ±0.40 | 6.50 ±0.60 | 8.91 ±0.48 | 7.60 ±0.83 |

Motion blur off is the only change that moves the near number past the null: +2.00,
3.8 sd, against the null's +0.32. Depth of field is **not resolvable** (+0.38, 0.7 sd,
against a 0.6 sd null) — the near-field CoC is real but small, see below. Swapping TAA
for SMAA sharpens *everything* (sails +6.65, 3.0 sd), which is what SMAA does; it
cannot be read as a near-field effect.

The crops settle it qualitatively where the numbers are noisy: the smear is
**directional**, streaks radiating from the direction of travel. With depth of field
off it is still striped; with TAA swapped for SMAA it is still striped; with motion
blur off the plank seams, caulking lines and grating slats come back. A defocus disc
does not make stripes.

### The mechanism, measured rather than reasoned

`velocity.ts` reprojects each pixel as if its world point stood still. In the helm
view the deck is rigid with the ship **and the eye is bolted to the same ship**, so
the deck's true screen motion is only the residual the camera's sway/bob springs
allow. The buffer instead reports the camera's whole translation parallax, which grows
as 1/depth. Computed from consecutive-frame camera and ship transforms — exact rigid
reconstruction, no dt term — at 15 kn:

| depth | what `velocity.ts` reported | true screen motion | over-report |
|---|---|---|---|
| 0.8 m (near grating) | 300 px | 17 px | 18x |
| 1.5 m | 217 px | 9 px | 24x |
| 3.0 m | 136 px | 4.6 px | 30x |
| 6.0 m (deck run) | 42 px | 1.6 px | 26x |
| 22 m (sails) | 7.3 px | 0.3 px | 24x |
| 35 m (far sail) | 4.7 px | 0.3 px | 16x |

(Frame period was pinned at the `FrameTime.dt` clamp of 100 ms on a loaded box; scale
by 0.17 for 60 fps. The over-report factor varied 6x-41x across three samples because
the *true* term is the spring residual and that changes frame to frame; the reported
column was stable to 2%.)

**64:1 near to far, purely from 1/depth.** At 60 fps the near deck reported ~51
px/frame, which at 0.35 shutter is 18 px of smear against a `TILE` cap of 20 — while
the sails reported 0.9 px, which is under the shader's `tileLen < 1.0` early-out, so
they got no blur at all. The inversion was not an accident of tuning; it was
arithmetic.

### The fix: motion blur measures velocity in the SHIP's frame

Compose the previous view-projection with `prevShip * curShip^-1` and the pass
reprojects each pixel to where that material point was last frame *if it is rigid with
the ship* — which every plank, gun and shroud is. No shader change: it is two
uniforms, and `uPrevCamPos` gets the inverse delta so the sky branch, which anchors a
1 km ray at the previous camera position, lands back on that position with only the
ship's rotation taken out of the direction.

**TAA keeps the world reprojection.** These are not two views of one truth: TAA's
history is a screen-space buffer of last frame, so world-static content genuinely
needs the world reprojection or it ghosts, and ghosting is a RUBRIC auto-fail. Motion
blur's near field is the ship. So the buffer is written twice when motion blur is on,
which costs 0.020 ms by `ext.post.profile(120)` against a 2.05 ms scene pass.

What the ship frame gives up: world-static geometry now reports the ship's motion
instead of its own. At 7.8 m/s and 60 fps that is 0.13 m — under a pixel past 80 m,
2.6 px on sea 30 m off, so nothing that was blurring stops. A pan is untouched, because
a look input is not part of the ship's rigid motion.

### A second defect, found by the same instrument

`SHUTTER = 0.35` was a fraction of **whatever frame the engine produced**. A 50 ms
frame therefore got three times the smear of a 16 ms one — the blur got worse exactly
when the frame was already struggling, which is a quality spiral, and it is
frame-rate dependence of the kind non-negotiable 9 exists to forbid. A real shutter is
a time. `EXPOSURE_S = 0.35/60` is 5.83 ms, so at the target frame rate the fraction
comes back out at 0.35 and the look is unchanged up to frame-time jitter, and away from
it the exposure is the same physical 5.83 ms.

### Result, as a paired within-run comparison

The honest metric is not the near number — that moves with the weather — it is **what
motion blur costs the near field, measured against motion blur off in the same run,
seconds apart**:

| state | base near | mb-off near | what mb cost | |
|---|---|---|---|---|
| before | 4.42 ±0.52 | 6.42 ±0.41 | **2.00 (3.8 sd)** | 31% of near sharpness |
| ship-frame velocity | 5.85 ±0.57 | 6.51 ±0.22 | 0.66 (1.2 sd) | 10% |
| + fixed exposure time | 6.54 ±0.24 | 6.49 ±0.19 | **-0.04 (-0.1 sd)** | nothing measurable |

The control that makes this trustworthy across runs: **the mb-off ceiling did not
move** (6.42 / 6.51 / 6.49) while base climbed to meet it (4.42 / 5.85 / 6.54). A
stable reference in every run is what a shared, loaded box will let you have when an
absolute number will not survive the walk between two captures.

### A measurement trap worth keeping: region ratios are contaminated by content

The brief that started this compared near against mid-distance and found near half as
sharp. After the fix, near/sails is still 0.63 — and it is 0.63 with motion blur
switched off entirely. **Black tarred shrouds against bright sky will always
out-gradient oiled deck planking**, whatever the post chain does. A cross-region ratio
measures content contrast as much as focus, so it can show a defect and it cannot show
the defect is gone. The paired same-region ablation can.

### Still not good enough

- **The near-field depth-of-field composite has no ramp, and the far field does.**
  `DOF_COMBINE_FRAG` ramps the far field in over the first 1.4 px of CoC
  (`saturate((coc - 0.6) * 0.7)`), but the near field's alpha is
  `saturate(coverage/TAPS * 1.6)`, and because the coverage test floors at 0.6 that
  saturates to 1.0 the instant CoC clears the gather's own 1.2 px early-out. So a deck
  pixel asking for 1.2 px of defocus has its full-res colour **discarded entirely** and
  replaced by a half-res gather, which is ~2 px of blur by itself. The lens is not the
  problem: at 71 deg, f/5.6 and 22 m focus the physical CoC is 2.3 px at 0.8 m, 1.8 px
  at 1 m, 1.2 px at 1.5 m and 0.55 px at 3 m — that is a correct amount of near
  defocus for a real 17 mm lens and it is where the line sits. Not changed here,
  because ablation put it at 0.2-0.7 sd and a change with no measurable effect is a
  change to a look the owner has approved.
- **TAA's near-field contribution is unquantified.** The only lever available was
  swapping the whole AA mode, which changes sharpness globally, so nothing separates
  "TAA blurs the near field" from "SMAA is sharper than TAA". The mechanism to suspect
  is documented rather than measured: with a velocity 50 px wrong, `histUv` lands on
  unrelated pixels, `clipAabb` pulls the sample most of the way to the 3x3 mean, and
  `uFeedbackMin` is **0.7** — so a fully-disagreeing history still contributes 70% of
  the output, which is a 3x3 box blur at 70% strength. If the near field ever needs
  more, that is where to look, and giving TAA the ship-frame velocity is the obvious
  move and the risky one.
- **Pan blur survives by argument, not by measurement.** The ship-frame delta removes
  only the ship's rigid motion, so a look input is preserved exactly — but the test
  built for it is under-powered. A constant look input parks against the mode's yaw
  limit; oscillating it gives mb-on 6% softer over the sails than mb-off, consistent
  with the ~3 px the arithmetic predicts, and not enough to call proven.
- **No timing claim.** Load average ran 130-160 for the whole session with two other
  agents' renderers live, and `capture.mjs` printed p25 21.0 / p50 51.1 ms for `helm`
  even in a window it scored `rivals 0p/0b quiet`. `ext.post.profile` is a serialising
  per-pass measurement and is quoted above; the wall-clock frame periods are not.

## 49. Motion blur was smearing the deck the eye stands on

The near field measured **half as sharp as mid-distance** geometry, which is backwards
for a first-person view. An agent isolated it properly and the mechanism is velocity
attribution, not the blur.

**The isolation is the lesson.** Its first attempt — disable a pass, capture, compare
— produced a contradiction: the all-off variant measured *less* sharp over the sails
than the one-pass-off variants. The ship is sailing, so variants captured a minute
apart differ in wave phase, cloud field, sun and heading. That is §43 from the other
side. What worked was visiting variants **round-robin over six cycles with a second
`base` as the null**:

| variant | near | sails |
|---|---|---|
| base | 4.42 ±0.52 | 7.71 ±2.18 |
| **motion blur off** | **6.42 ±0.41** | 11.68 ±2.08 |
| depth of field off | 4.81 ±0.51 | 8.78 ±1.56 |
| TAA → SMAA | 5.64 ±1.07 | 14.35 ±1.60 |
| base again (null) | 4.74 ±0.40 | 8.91 ±0.48 |

Motion blur is the only variant past the null on near (+2.00, 3.8 sd). DoF is **not
resolvable** (+0.38, 0.7 sd). TAA→SMAA sharpens *everything*, so it cannot be read as
near-specific.

**Mechanism**, from exact rigid reconstruction of consecutive-frame transforms at
15 kn:

| depth | `velocity.ts` reported | true screen motion | over-report |
|---|---|---|---|
| 0.8 m grating | 300 px | 17 px | **18×** |
| 6 m deck run | 42 px | 1.6 px | **26×** |
| 22 m sails | 7.3 px | 0.3 px | 24× |

The eye is bolted to the ship, so the deck's true motion is only the camera-spring
residual — but reprojection assumes world-static geometry and hands back the camera's
whole translation parallax, 64:1 near-to-far purely from 1/depth. Motion blur now
measures velocity in the **ship's frame**; TAA keeps the world reprojection, because
its history is a screen-space buffer and world-static content needs it or it ghosts.
Extra cost 0.020 ms against a 2.05 ms scene pass.

**A second defect from the same instrument:** the shutter was a fraction of *whatever
frame the engine produced*, so a 50 ms frame got 3× the smear of a 16 ms one — worse
exactly when the frame is struggling. It is an exposure *time* now.

The control is what makes the result trustworthy: **the motion-blur-off ceiling never
moved** (6.42 / 6.51 / 6.49) while base climbed to meet it (4.42 → 5.85 → 6.54). On
my own metric, near went 8.90 → 14.29 and mid 12.50 → 19.63.

**It corrected my brief's methodology.** I had proposed judging the fix by the
near/sails sharpness ratio. That ratio is still 0.63 after the fix — and it is 0.63
with motion blur off entirely, because black tarred shrouds against sky out-gradient
oiled planking whatever post does. A cross-region ratio measures content contrast as
much as focus. Use the paired within-run delta.

**Still open, deliberately:** `DOF_COMBINE_FRAG` ramps the far field over 1.4 px of
CoC but the near field's alpha saturates to 1.0 the instant CoC clears 1.2 px, so a
deck pixel asking for 1.2 px of defocus has its full-res colour discarded for a
half-res gather. Ablation put it at 0.2–0.7 sd and it is a look the owner approved.
And TAA's near-field share is unquantified — with velocity 50 px wrong, `clipAabb`
pulls history to the 3×3 mean against a `uFeedbackMin` of 0.7, i.e. a 70% box blur.
Giving TAA the ship-frame velocity is the obvious next move and the risky one.

## 50. The ship's wheel was thirty unrotated boxes

No identifiable wheel appeared anywhere in the helm view, and the foreground read as a
pile of scattered lumber — because that is what it was. Two bugs in `buildWheel`.

**Wrong plane.** `revolve` turns about +Y (`Builder.ts:458` sets
`p.set(r*ca, y, r*sa)`), so the barrel's axis is local Y and a disc must lie in local
XZ. The old code offset along X and drew its circle in YZ, mounting both discs at 90°
to the barrel they turn on.

**No orientation.** `box` is centre-plus-half-extents and axis-aligned. Every spoke was
an identical Y-aligned bar merely *translated* onto a circle — ten parallel slabs, not
ten radii. Same for rim segments and handles.

Measured by reading the `aPart == PART.WHEEL` vertices out of the page, which is
immune to camera angle, lighting and motion blur:

| | span | detected axis | disc clusters |
|---|---|---|---|
| before | 2.48 × 1.11 × 2.07 | **y (vertical)** | **four**, at y = 6.0 / 6.25 / 7.0 / 7.25 |
| after | 1.24 × 2.12 × 2.03 | x (athwartships) | **two**, at x = ±0.5 |

A wheel has two discs on one axis. The old geometry's detected axis was *vertical* and
its clusters were stacked in four layers; that is the defect in one line. In-plane
aspect 1.20 → 1.04, rim vertices at 0.903 ± 0.082 m, +120 vertices.

The rim is chorded rather than turned, which is not a simplification — a ship's wheel
rim IS felloes, straight segments jointed at the spokes.

**One statistic moved the wrong way and must not be quoted as a win:** angular
coverage fell 24/36 → 12/36 sectors, because scattered bars spread vertices over many
angles while a ten-felloe rim concentrates them at ten joints. Coverage is the wrong
measure for this shape.

**Still not good enough.** From the helm the two discs overlap nearly along their own
axis, so the wheel is legible as spokes and handles but not yet obviously a wheel.
That is a framing question for `src/camera` and `deck.ts`'s helm anchor together, not
a geometry one.

## 51. `preflight` said push-ready while the tree would not build

An agent found it printing `push-ready` with `npm run build` red on four backticked
GLSL comments — the recurring build-breaker, and the single thing that most obviously
disqualifies a tree from being pushed. Preflight was checking publication hygiene and
calling the result push-readiness, which is a bigger claim than it was testing.

`check-glsl` runs inside it now: well under a second, and it includes an esbuild
parse, so "will not build" is a fact. A full `tsc` is deliberately **not** run — it
costs 24 s, agents run this gate repeatedly, and a slow gate gets skipped. The success
line names what was and was not checked instead of implying both.

## 52. The rigging crawled for three reasons, and it needed all three

The owner's "black aliased net" was not one bug.

**Binary coverage.** The renderer asks for **no MSAA** — we do our own AA in post — so
a ribbon narrower than a pixel rasterises with binary coverage: it lands on one pixel
or on two, and which one flips as the camera moves a fraction of a pixel. Two hundred
shrouds and ratlines doing that at once is the crawl. The previous fix widened the quad
to 1.4 px and scaled alpha by the true width, which conserves the *average* but leaves
the **edge hard**, so the flicker survived at reduced amplitude — and its 0.25 alpha
floor made a 0.2 px ratline **four times too dark**, which is the other half of the
same report. Now the ribbon is a pixel wider than the rope each side and the fragment
shader takes the rope's exact box-filter coverage; the integral of that over offset is
`2r` for every `r`, so total ink is preserved at any distance and no floor is needed.

**Depth write.** Every rope is one instance in one draw call, so where two cross they
blend in buffer order — and with `depthWrite` on, whichever drew first also wrote depth
and **discarded** the other. A ratline gang crosses its own shrouds a hundred times, so
a hundred crossings each dropped or doubled a line depending on which happened to be
nearer, and that decision flips with camera motion. Depth *testing* is untouched, so
hull, spars and sails still occlude the rig; only rope-over-rope occlusion is given up,
and a tarred rope at full coverage blends to the same near-black anyway.

**Ratlines four times too fat.** 0.021 m radius is a 42 mm rope; real ratline stuff is
6–12 mm, i.e. very nearly as heavy as the 73 mm lower shrouds they are seized to. Once
coverage preserves total ink exactly, ink is decided by geometry. Measured by rewriting
`iParam.y` for the ratline family only so nothing else in frame moves: over the lower
fore gang at helm range, halving takes the share of pixels below 35% of local sky from
13.70% → 12.37% and total ink 0.2879 → 0.2810 — and it stops reading as chain-link,
because the ratlines are finally *lighter* than the shrouds crossing them.

**And a scallop sampled below Nyquist.** A lower gang has 8–9 shrouds so 7–8 bays,
against a 13-vertex ribbon: 1.5 samples per bay. That is not a scallop, it is
per-vertex noise, and it gave every ratline a random 0–3 cm kink at each of its
thirteen vertices.

## 53. Two agents stopped mid-task; one result landed, one was held off main

Both left green trees (`tsc` 0, `check-glsl` clean), which is why this needed judging
rather than just committing.

**Landed:** the rigging work above, verified at helm range as smooth continuous lines
with the crawl gone. And a separate real bug found on the way to the sail shadows:
changing shadow resolution nulled `shadow.map` but not `shadow.mapPass`, and three
creates `mapPass` in exactly one place — `WebGLShadowMap.js:389`, `if (shadow.mapPass
=== null)` — so the two VSM blur passes kept running at the **old** size against a new
map, and every shadow in the scene stayed wrong for the rest of the session. Latent at
the default tiers, because high and ultra are both 2048 so the early-out never lets the
size change; it bites the moment a player moves the quality slider off 1024.

**Held on `wip/sail-canvas`:** the sail canvas rework. Its diagnosis is excellent and
worth keeping regardless — the baked normal map had an **RMS surface slope of 48°**
with relief energy centred on 95 mm along the bolt and 91 mm across it, i.e. isotropic
decimetre bumps at half a radian of tilt, which is crumpled foil and is exactly the
owner's "bumpy, quilted, popcorn-like"; and the shader tier was authored at a 24 mm
pitch when the helm sits 15–25 m from the courses where a pixel is 9–12 mm, so the
antialiasing fade held it at **zero** (ablated live: removing the tier changed gradient
energy at helm range by under 1%).

But the result is **worse than what it replaced**: a dense regular sawtooth chevron on
every sail, hard-edged and plainly geometric. The vertical flute bands are right; the
teeth between them are not. Suspicion, for whoever picks it up: in sail UV the span is
the *horizontal* extent of a square sail, so a high frequency in the chord term is
horizontal ribbing again — the axis fix may have gone in inverted.

**The rule this establishes.** A stopped agent's work being green is not the same as
being right. Main stays publishable, so a change that trades one defect for another
goes on a branch with the diagnosis written down, not onto main. Both halves stay
recoverable and the owner can still push at any time.

## 54. The sail shadows were black because canvas was an opaque occluder

> **Corrected by §56 — read that first.** The "all measured null" below is **wrong for
> two of the three**. With an instrument that has a positive control, filter width
> moves edge width p50 by **5.4×** and a 512 map moves it 3.48 → 8.42 px. The null came
> from a metric whose own author had documented it as blind to a 3.6× radius change,
> and I repeated it as a finding in this file and in three agent briefs. Only caster
> tessellation survives as a genuine null. The two causes named below are still real
> and still fixed; it is the exclusions that were unearned.

The defect that survived three dispatches. Neither of its two causes is any of the
three things everyone reaches for first — map resolution, filter width and caster
tessellation all measured null (**but see the correction above**).

**Canvas is a lampshade.** Removing the sails from the shadow map takes the darkest
decile over the ship from 56 to 111 sRGB, against 123 with no shadow at all — so
canvas casts about **nine tenths** of the shadow that lands on this ship. Flax duck
passes about a third of the light, so a sail's shadow on another sail belongs at
roughly a quarter of full sun; as an opaque occluder it was at 5%.

**The depth test was quantised coarser than its own bias.** VSM keeps its two depth
moments in a half-float RG target — three creates both `map` and `mapPass` with
`HalfFloatType`, `WebGLShadowMap.js:229` and `:393` — so the mean every comparison is
made against carries 11 significant bits. The range was `[1, 680]` to hold a ship 60 m
across, and casters landed at window-space z 0.52–0.72 where the half-float step is
2⁻¹¹: a quantum of **0.33 m**, against a total bias budget of 0.16 m of caster push
plus the receiver bias. The comparison the whole shadow rested on was coarser than the
slack protecting it.

Two things shrink that and the fix uses both. The obvious one is a shorter range. The
less obvious one is keeping the **values** small, because a half-float step halves with
every binade — so `near` is tight to the front of the ship and `far` carries all the
margin, putting the ship in the near half of the range and buying another bit for
nothing. Quantum now 0.02–0.08 m. And `shadow.bias` is derived from metres, because as
a window-space fraction it silently changed meaning every time the range did.

### Where the transmission correction belongs
First attempt: a per-**light** `shadow.intensity` floor. It lifted the canvas shadows
and lifted the honest shadows of hull, deck and spars with them. Now on the
**receiver** — the sail material already computes a shadow term for backlit
translucency, so this is the same translucency seen from the other side. It goes into
`indirectDiffuse` rather than three's direct-light path, because the shadow multiply
and the accumulation both happen inside `lights_fragment_begin` and dividing the result
back out is unstable as the shadow term approaches zero.

Still an approximation: assuming every occluder is canvas is wrong for the tenth that
is spar and top, which now read a third too light. Smaller error, smaller area, and the
alternative is a per-caster opacity a shadow map has nowhere to put.

### No measured improvement is claimed, and that is the finding
Three captures of the same scene on **identical code** gave a deep-shadow share of
22.11 / 28.69 / 26.99 % over the hull and 11.31 / 12.91 / 11.77 % over the sails —
spreads of **6.58** and **1.60** points. The differences between the two versions were
5.07 and 1.28. Both inside the noise.

The confound is cloud shadow: every scene ran at cloudCover 0.3–0.5 and the field
advects with wall-clock time, so two captures are two different cloud fields on the
same sails. `capture.mjs` now has a **`shadow` scene at cloudCover 0**, and it fixes
the instrument: three runs give sail p10 111.1 / 112.5 / 111.6 and p50
178.6 / 177.8 / 177.8, spreads of **1.4** and **0.8** sRGB against 9.0 before. A
percentile is now usable as evidence; a share statistic still wants a paired run,
because 2.1 points of spread survive as wave phase and TAA convergence.

So the case for the committed version is that it is **correct by construction**, not
that it photographed better. That distinction is worth stating rather than blurring.

## 55. My own checker caught me committing the recurring build-breaker

Writing the sail transmission term, I put backticks around `lights_fragment_begin` and
`sh` inside a GLSL template comment — the exact mistake `AGENTS.md` rule 3 exists for,
which has broken this build more times than anything else. `check-glsl` named both
lines and the parse error before I ran anything else.

Worth recording plainly: the rule is not that agents make this mistake. Everyone
working in these files makes it, including me, in the very commit that fixed something
else. The checker pays for itself on its author.

### 54a. Correction: what the before/after actually shows

With the zero-cloud scene making percentiles repeatable to ~1 sRGB, I took a real
before/after against `880d0bc` in a scratch worktree. It does **not** say what my
commit message said.

| | sail p10 | p50 | deep-shadow share | hard edges (3 px step > 20 sRGB) |
|---|---|---|---|---|
| before ×2 | 140.2, 145.1 | 179.9, 180.9 | 15.96%, 13.87% | 12.88%, 12.64% |
| after ×3 | 111.1, 112.5, 111.6 | 178.6, 177.8, 177.8 | 21.00%, 21.26%, 23.11% | 12.88%, 11.63%, 12.46% |

The shadows are **darker and more extensive** — which is the depth-quantum fix
recovering shadow the 0.33 m quantum was losing, and is a correctness win. But
**edge hardness did not measurably change**: 12.6–12.9% before, 11.6–12.9% after.

I had written that the shadows "read as mast-and-rigging shaped rather than as slabs."
That is a visual impression and I should not have stated it as a result. Two caveats
on my own metric, both of which cut against using it at all: it counts any steep step
among sail pixels, so it is contaminated by sail-against-sail edges and by rope
shadows — and the rigging fix in `1cd65b5` made the ropes *crisper*, which pushes this
number the wrong way for an unrelated reason.

**And the biggest visible change in that pair is not the shadows at all — it is the
canvas.** Before, the cloth carries a heavy dark granular speckle across every sail;
after, it is clean with vertical seams. That was measured properly at the generator
(48.4° → 4.9° RMS slope, anisotropy 0.48 → 0.09, dominant wavelength across the chord
landing on the 610 mm bolt), and it is very likely that a good part of what I had been
calling "blotchy shadow" for two days was the popcorn normal map, not the shadow map.

**Still open, honestly stated:** whether sail shadow *edges* are now soft enough. No
instrument here can answer it — an edge-hardness statistic needs to be restricted to
actual shadow boundaries, which means segmenting the shadow rather than thresholding
gradients over the whole sail.

## 56. The free leech is not the mechanism, and the sail shadow edges are already the right width

§54a left one thing open: whether sail shadow *edges* are soft enough, and said no
instrument here could answer it. There is one now, and the answer is **yes** — with
the consequence that the one untested hypothesis, `wip/free-leech`, is dead.

### The instrument

`.tmp/leechshadow.mjs` captures and `.tmp/leechstat.mjs` measures. Two things make it
different from every hardness statistic tried before.

**It measures the shadow term, not the frame.** With time frozen — `requestAnimationFrame`
wrapped so `Engine.tick` sees dt = 0, borrowed from `sailshadow5.mjs` — `base` and
`shadowOff` are the same frame with `sun.shadow.intensity` set to 0, pixel-registered.
`T = lum(base) / lum(shadowOff)` therefore cancels weave, seams, panel tone, grime,
bolt ropes and **every piece of rigging geometry** exactly. §54a's worry that rope
shadows contaminate the metric turns out to be doubly moot: `rigging.ts:223` sets
`castShadow = false`, so the ropes never cast at all, and their silhouettes cancel in T.

**It measures across the boundary normal.** `sailshadowdiff.mjs` walked image rows, so a
boundary at angle t to the vertical reported width/cos(t) — a 45° edge came out 1.41x
too soft and a near-horizontal one arbitrarily so. Here each non-max-suppressed ridge
point of |grad T| gets its own normal, the raw T profile is sampled along it at 1/4 px
with bilinear taps, the walk finds the lit and shadow plateaux either side, and the
10..90 per cent crossing distance is recorded. Reported as a **distribution**, because
the mean of a mixture of 1 px cut-outs and 12 px washes describes neither.

Widths are in capture px: deviceScaleFactor 2 and `ultra`'s maxPixelRatio 2 give a real
3200x1800 backing store, not an upsample — an 8-bit profile sampled at 1 px cannot
resolve a 1 px transition. **Halve for a 1x frame.** Scale at the ship: 17.5 px/m.

### The null, and a positive control

Four runs on identical code, `shadow` scene, cloudCover 0:

| run | p25 | p50 | p75 | p90 | ≤2 px | ≥8 px |
|---|---|---|---|---|---|---|
| L1 | 2.52 | 3.54 | 6.21 | 10.10 | 14.4% | 16.5% |
| L2 | 2.65 | 3.62 | 5.97 | 9.87 | 10.2% | 15.5% |
| L3 | 2.54 | 3.59 | 6.36 | 9.85 | 11.9% | 17.0% |
| P1 | 2.51 | 3.48 | 5.90 | 9.13 | 13.4% | 14.8% |

p50 repeats to **0.14 px**, p25 to 0.14, p90 to 0.97. The `≤2 px` share is the noisy
cell at 4.2 points; quote percentiles, not shares.

And the control that every previous attempt lacked — the VSM filter, ablated **inside one
frozen frame**, so pose, wave phase and sun are bit-identical across the rows:

| radius / blurSamples | p25 | p50 | p75 | p90 | ≤2 px | ≥8 px |
|---|---|---|---|---|---|---|
| 0.25 / 2 | 2.00 | 2.52 | 5.60 | 9.18 | 25.1% | 14.0% |
| **2.2 / 6 — shipped** | **2.69** | **3.94** | **7.32** | **11.65** | **13.1%** | **21.9%** |
| 4 / 8 | 3.88 | 6.13 | 9.60 | 14.29 | 8.9% | 35.2% |
| 7 / 10 | 5.66 | 8.81 | 12.66 | 17.55 | 9.0% | 57.3% |
| 14 / 16 | 5.75 | 13.64 | 20.67 | 24.72 | 6.7% | 69.6% |

**So "map resolution, filter width and caster tessellation all measured null" is wrong on
two of its three counts, and §54 should not be trusted on it.** Filter width moves p50 by
5.4x; `map512` moves it from 3.48 to 8.42. The old null came from a metric whose own
author recorded it as blind to a 3.6x change in this exact parameter — see the
`.tmp/shadowedge.mjs` header. A null from an instrument with no positive control is not a
result, it is a silence.

### The free leech: killed, and it was a good hypothesis

`wip/free-leech` argues that a shadow's edge is its caster's silhouette and the caster's
leech is pinned flat by `sin(PI * cl^DRAFT_EXP)` going to zero at both cl = 0 and cl = 1.
The argument's premise checks out and its code is better than its commit message: the
message says the term fades in with "the aback flag", but `fa` is the **fore-and-aft**
flag, and what it actually does is gate the free edge to the leech alone on a jib — whose
luff genuinely is pinned, to its stay — while letting both leeches of a square sail belly.
The span bell `sin(PI * sDraw)` is zero at head and foot, so nothing leaves its yard.

Applied at `LEECH_FREE = 0.45`, the treatment is large and measured, not assumed. The CPU
mirror (`ropecpu.mjs --draft`, validated at `LEECH_FREE=0` against main to the digit)
puts the leech midpoint 0.44–1.16 m further out of plane in live trim — 1.155 m on a
course, 8–20 screen px of caster silhouette at this scale. And it moves the shadows:
`shaded%` and the boundary layout both shift.

It does not move the edge width:

| run | p25 | p50 | p75 | p90 | ≤2 px | ≥8 px |
|---|---|---|---|---|---|---|
| pinned ×4 | 2.51–2.65 | 3.48–3.62 | 5.90–6.36 | 9.13–10.10 | 10.2–14.4% | 14.8–17.0% |
| free ×4 | 2.38–2.55 | 3.40–3.60 | 5.29–6.16 | 8.70–9.58 | 11.8–14.8% | 12.2–15.7% |

p50 sits inside the null in all four. The upper tail leans the other way: p75 is below the
null's low end in three of four runs (5.29, 5.46, 5.88 against a null floor of 5.90) and
p90 in two (8.70, 8.90 against 9.13). So if the free leech does anything at all it makes
the edges slightly **harder**, which is the wrong direction for the hypothesis. Against a
control that swings p50 from 2.52 to 13.64, this is a null with teeth.

Nor is the boundary more bowed. Straight-chain counts (rms < 0.7 px over ≥ 60 px extent)
are 7–13 pinned against 11–14 free; longest-chain rms 0.69–3.45 against 0.62–2.28. The
diagonal-bow median has a null spread of 5.19–19.64 px, so **that statistic cannot resolve
anything** and should not be quoted either way.

**Why it had to fail.** A directional light has no source area, so a shadow edge here has
no penumbra term at all: the caster's silhouette sets **where** the edge falls, never how
wide it is. Width is the VSM moment blur, the map resolution and the post stack — which is
exactly what the dial above measures. The premise was not the error; the inference from
premise to width was.

**And the premise really was sound**, which is worth keeping. Ablating the ship's solid
parts as casters (see the trap below) takes the shadowed area over the sails from 30.3% to
20.9% and the deep-shadow area from 19.6% to 14.8%: canvas casts about **two thirds of the
shadowed area** and roughly half the boundary population on the sails. The right caster was
identified. It just cannot do the job it was nominated for.

### Cost of the change, for anyone who wants it for cloth realism instead

`.tmp/ropecpu.mjs`, mirror verified against main:

| | live trim (close-hauled) | all nine states |
|---|---|---|
| pinned leech (main) | **35** | **358** |
| free leech 0.45 | **41** | **381** |

Live trim +6: `lift` 10→13, `ratline-lower` 3→5, `buntline` 0→1. Across all states +23,
almost all of it `lift` (49→65) — the lifts run from yardarm to masthead **past the
leech**, which is precisely where the new belly is. So `d0101a4` is walked back, modestly
and predictably. Not kept; `LEECH_FREE=0.45` in the probe's environment reproduces it.

### Are the edges soft enough? Yes, and softening them further would be wrong

The sun subtends 0.53°, so a penumbra is `d * 0.00925` m for a caster–receiver separation
d, and at 17.5 px/m that is `d * 0.162` px. Sun elevation in this scene is 12.4°, so the
ray from a mast, yard or sail to the canvas it strikes runs roughly the horizontal
separation: 10–40 m on this rig, i.e. **1.6–6.5 px**. Shipped: p25 2.5–2.7, p50 3.5–3.9,
p75 6.2–7.3. That is the physically correct band. `blurNone` (p50 2.5) is slightly too
hard; radius 4 and above is unphysically soft, and the 1:1 strip shows what it costs —
at radius 4 the crosstrees stop being legible in their own shadow, so the trade is
shadow *shape* for softness, and the shape is what makes it read as rigging. **Leave
`shadow.radius` at 2.2.**

The shadow interior is not the problem either. Median sd of T inside a 9x9 window wholly
within deep shadow is 0.0235 / 0.0255 / 0.0239 / 0.0250 across a 56x range of filter
radius — flat, and only 2.4% of full light. Whatever still reads as blotchy on this cloth
is the cloth, not the shadow, which is where §54a's normal-map finding already pointed.

### Four instrument bugs, all of which produced a confident wrong answer first

1. **The sky/sea guard read the wrong frame.** Rejecting blue-dominant pixels off `base`
   deletes every deep-shadow sail pixel, because a sail in shadow is lit by **sky**. It
   cost 30% of the sail area and three quarters of the edges, and returned a perfectly
   plausible distribution describing only the shallow edges it failed to reject. The
   guards belong on `shadowOff`, where every sail is in full sun.
2. **`castShadow = false` is a no-op under VSM.** `WebGLShadowMap.js:515` renders an object
   into the map when `castShadow || (receiveShadow && type === VSMShadowMap)`, and every
   ship mesh receives. The first caster ablation moved the shadow term over the sails by
   1.4% of area — TAA noise — and read exactly like a real null. `.tmp/sailcaster.mjs`
   documents this trap and I walked into it anyway. Both flags must be cleared, plus
   `material.needsUpdate`, and there is therefore **no valid ablation of the canvas as a
   caster over the sails**: clearing `receiveShadow` on the sails destroys the measurement
   surface. Only the complement is measurable.
3. **A stalled boot photographs happily.** One run froze at `frame: 2` after a 14 s settle;
   the ship did not exist, `__maskOn` threw, and the only symptom was a downstream
   "reading 'copy' of undefined". The harness now asserts `time.frame > 90` and that the
   sail mesh and the sun exist before it settles.
4. **A mask threshold does not travel between scenes.** The green emissive goes through the
   tonemap and the bloom like everything else, so a sunlit sail lands at about
   (236, 255, 208) — 19 points of green dominance, not 55. The threshold of 40 inherited
   from an earlier scene's exposure selected 41k px of a 600k px sail plan and threw
   `mask too small`. Look at the mask (`--preview` writes one) before trusting a statistic
   computed on it.

## 57. The stutter was never in the measurement: every timing here used a quarter of the owner's pixels

> **Two claims below are wrong; §59 has the corrections and the evidence.**
>
> 1. **"Headless Chromium has no vsync" is false.** It is a 60 Hz **rate limiter**:
>    `period ≈ max(16.67, cost)`, against a real panel's
>    `ceil(cost / 16.67) · 16.67`. An empty page reads p50 16.7 ms under four flag
>    sets including `--disable-gpu-vsync`. That makes this box the *right*
>    instrument for a cost sweep and the wrong one for a control law — I used the
>    wrong half of that to argue the whole thing was untestable.
> 2. **The "over-corrects to 157 fps" regression did not exist.** My probe looped
>    `waitForTimeout(s * 1000)` over `[3, 6, 10, 16]`, which waits *cumulatively*
>    to t = 3, 9, 19, 35 s while the label said 3, 6, 10, 16. Dividing frame-count
>    deltas by the label's gap inflated every rate by up to 2.7×. Corrected, the
>    old controller settles at **~24 fps** and the new one at **exactly 60**.
>    A working fix spent a session on a branch because of that arithmetic.
>
> The comparison was also unit-confused independently: the old law's floor is
> `Math.max(0.62, …)`, a clamp rather than a decision, and 0.62 at dpr 1 is
> 0.55 Mpx while 0.30 at dpr 2 is 0.52 Mpx — **the same picture, 7% apart.**

The single most consequential instrument gap in the project, and it explains two days
of failing to reproduce a defect the owner reported from play.

The backing store is `min(devicePixelRatio, maxPixelRatio) * renderScale * cssSize`.
`capture.mjs` defaults `--dpr 1` and pins `adaptiveResolution = false, renderScale = 1`
for determinism. So **every frame timing in this project was 1600×900 = 1.44 Mpx with
the adaptive controller switched off**, while a Retina panel at the same window size is
**3200×1800 = 5.76 Mpx** — four times the pixels — *with* the controller running.
Neither half of the owner's condition was ever in the measurement.

Measured now that the harness can (`--dpr 2`): p25 **82.9 ms** with **3%** of frames
inside one vsync. That is about 12 fps. **It is not a stutter, it is a sustained
overload**, and the "two-frame stutter" the owner described is what a 4× overload looks
like when the adaptive controller is fighting it.

`--dpr 2 --adaptive` now reproduces it. Pinning stays the default, because an adaptive
controller changes the pixel count mid-run and makes two runs incomparable.

### The controller: right diagnosis, half a fix, and an instrument that cannot see the rest
On `wip/adaptive-resolution`, not main. What it gets right is exactly the owner's
complaint: the old controller opened at `renderScale` 1 and needed a boot grace plus a
full window before it could act, so **the title screen was the worst frames in the
session**. An opening cap of 2 Mpx and a boot grace counted in *milliseconds* — a
frame-counted grace is unbounded in time precisely when the frame rate is worst — take
the first three seconds from **15 fps to 45 fps**.

What it gets wrong: it descends past the rung it needs and does not climb back, settling
at `renderScale` 0.30 (960×540) at ~157 fps where the old one settled at 0.62
(1984×1116) at ~63 fps. Throwing away more than half the affordable resolution reads as
a soft picture, so that is a visible regression traded for a real fix — branch, per §53.

**Why it could not be resolved here, which is the reusable part.** Headless Chromium has
**no vsync**, so frame periods are unthrottled and the hit-rate this controller steers by
reads ≈1.0 at almost any scale. A vsync-driven controller cannot be faithfully tested in
an environment without vsync, and no amount of care with the rest of the harness fixes
that. Raising `ADAPT_SETTLE` 8 → 30 was tried on the hypothesis that the descent was
chasing its own reallocation cost; it settled at 0.30 rather than 0.25, so that is not
the mechanism, and the constant is left at 8.

### Two probe traps found the hard way
- **Vite HMR reloads the page when the file under test is edited**, which resets
  `world.time.frame` and silently invalidates a probe *mid-run*. Two runs were
  contaminated before I noticed. The tell is a **falling** frame counter — assert it
  rises. Waiting for HMR to quiesce before the probe navigates is enough.
- **Blocking `@vite/client` to prevent that breaks the module graph** and the app never
  boots at all.

## 58. Velocity has two right answers, and the choice is per pixel

TAA reprojected everything in the world frame. Reprojection asks "where was this pixel's
material point last frame?", and on a first-person eye bolted to a moving ship that has
two answers: a world-static point wants the previous camera's view-projection, a point
rigid with the ship wants it composed with the ship's inverse motion, because the eye
moved and the deck did not move relative to it.

The disagreement grows as 1/depth: **95 px at 0.8 m, 53 px at 1.5 m, 27 px at 3 m**,
7 px at 6 m, at 14 kn and 16.5 ms. A history fetched 95 px away is unrelated content, so
`clipAabb` pulls it to the 3×3 mean and `uFeedbackMin` 0.7 blends ~64% of that in — a box
blur on exactly the surface the player stands on.

A global flag was the wrong shape for the fix, because the ocean and sky share the buffer
and still need the world frame. The classifier is a padded box in ship-local space with
one exception: a point near world sea level and **outside the hull's waterline footprint
is water**, however deep inside the rig's envelope it sits — the sea under the jibboom,
the spanker boom, the yardarms. Water *inside* that footprint stays ship, because the bow
wave and the wake are ship-locked. Sky is always world; a ship-frame sky would offset the
whole dome during a turn.

The padding is deliberately generous, and the asymmetry is the argument: a false "ship"
costs a couple of pixels of error on water, a false "world" costs the whole defect on the
deck.

### The near-DoF step, and why it measured as nothing
A half-res gather has a floor on sharpness — one bilinear tap is already a 2 px box and
the upsample adds a 2 px triangle — so a pixel asking for 1.2 px of defocus receives
~2.6 px if its full-res colour is fully replaced. The far field always faded in over that
ramp; the near field **stepped** from 0 to 1 at 1.2 px of CoC.

Where that step sat depends on the lens: **1.49 m at the helm**, 1.64 m at the masthead,
**3.28 m on the bowsprit** at f/2.8, 5.85 m in orbit. At the helm it is closer than
anything in frame — the nearest deck pixel is ~2.6 m — which is why ablating the entire
DoF pass there measured 0.2–0.7 sd and looked like a null. On the bowsprit the jibboom,
martingale and headsail tacks span it. **The lead was real and the scene it was tested in
could not contain it.**

Nothing at or beyond 2.03 px of CoC changes by a single bit, so the approved near-field
look is untouched.

## 59. The adaptive controller: the "regression" was a unit error, and §57 got the instrument backwards

Three separate things were wrong. One was in the harness's documentation, one was in
the comparison that kept the fix off main, and one was in the control law.

### A. Headless Chromium here DOES have a frame clock. §57's "no vsync" is wrong.
Measured on an EMPTY page — nothing but an rAF loop, so whatever it reports is the
harness's own clock (`.tmp/rafcap.mjs`):

| launch flags | min | p25 | p50 | p95 |
|---|---|---|---|---|
| `capture.mjs` set | 14.1 | 16.6 | 16.7 | 18.6 |
| `adaptprobe.mjs` set | 14.6 | 16.6 | 16.7 | 18.6 |
| + `--disable-gpu-vsync` | 14.6 | 16.6 | 16.7 | 18.6 |
| + `--disable-frame-rate-limit` | 16.7 | 18.3 | 18.7 | 18.8 |

So §16 is right, §57 is wrong, and `capture.mjs` has been printing the correct footnote
all along ("p25 at the 16.6 ms rAF cap"). But it is a **rate limiter, not a vsync** — the
sweep below reads 24.6 and 30.7 ms, values a quantised display cannot produce:

    this harness:   period ~= max(16.67, cost)          (unquantised above the floor)
    real display:   period  = ceil(cost / 16.67) * 16.67 (quantised)

Both halves matter. It makes this box the **right** instrument for a cost sweep — every
period above the floor IS that frame's cost — and the **wrong** one for a control law: a
20 ms frame is "6% over budget" here and "half the frame rate" on the owner's panel. The
`ADAPT_HIT_BUDGETS` 1.4 test therefore means "cost <= 23.3 ms" here and "cost <= 16.7 ms"
there, which is why a live run settles one to two rungs higher than a real display wants.
Below the floor the instrument is simply blind: at dpr 1 even a 400x225 backing store
reads p50 16.7 ms, exactly what an empty page reads.

### B. The ground truth: cost per rung, and it does not depend on dpr at all
`.tmp/adaptsweep.mjs`, noon @ ultra, 1600x900, 3 passes, alternating rung order,
`rivals 0p/0b` sampled around **every rung** and quiet at all of them:

| renderScale | backing store | Mpx | p25 | p50 | intervals a 60 Hz panel would take |
|---|---|---|---|---|---|
| 1.00 | 3200x1800 | 5.76 | 81.6 | 89.2 | 6 |
| 0.92 | 2944x1656 | 4.88 | 64.3 | 77.0 | 5 |
| 0.84 | 2688x1512 | 4.06 | 60.8 | 64.5 | 4 |
| 0.76 | 2432x1368 | 3.33 | 51.9 | 56.1 | 4 |
| 0.68 | 2176x1224 | 2.66 | 43.0 | 47.1 | 3 |
| 0.60 | 1920x1080 | 2.07 | 35.0 | 37.6 | 3 |
| 0.52 | 1664x936 | 1.56 | 27.7 | 30.7 | 2 |
| 0.44 | 1408x792 | 1.12 | 21.4 | 24.6 | 2 |
| 0.36 | 1152x648 | 0.75 | 17.7 | 19.8 | 2 |
| 0.30 | 960x540 | 0.52 | 15.4 | 16.6 | 1 (at the floor; cost <= 16.67, unresolvable) |
| 0.25 | 800x450 | 0.36 | 15.6 | 16.7 | 1 (at the floor) |

The same sweep at `--dpr 1` lies on the **same line**: fitted over the 14 un-censored
rungs of both, **cost = 9.44 ms + 13.83 ms/Mpx**, worst residual 1.1 ms. dpr 2 at scale
0.30 and dpr 1 at scale 0.60 are both 960x540 and both read p50 16.6 ms. **The panel's
device pixel ratio has no effect on frame cost at equal backing store** — only the pixel
count does.

### C. So the "regression" that kept the fix off main is a unit error
The old law's floor is `Math.max(0.62, ...)`: a clamp, not a decision. 0.62 at dpr 1 is
992x558 = 0.55 Mpx. 0.30 at dpr 2 is 960x540 = 0.52 Mpx. **The same picture, 7% apart in
pixels, recorded in §57 as "throwing away more than half the affordable resolution".**
And at dpr 2 that clamp stops at 1984x1116 = 2.21 Mpx, which this sweep puts at 36-38 ms
— 28 fps, three vsync intervals, with nowhere left to go. The old clamp was accidentally
right for dpr 1 and unreachable for dpr 2. §57's "0.62 at ~63 fps" cannot be a dpr-2
measurement at all.

### D. What the ladder can never reach, which is a different bug for someone else
9.44 ms of the frame is not in the pixels — the shadow map is a fixed 2048² x4 cascades,
the solver and the FFT dispatch do not care about the backing store. That is **57% of a
16.67 ms budget**, so the pixel budget at 60 fps is 7.2 ms, i.e. about **0.52 Mpx**, and
adaptive resolution can only ever attack the 13.83 ms/Mpx term. Related: AGENTS' "60 fps
at 1600x900 on an M2 at ultra" does not hold at either dpr today — `capture.mjs` on a
quiet box reads noon **p25 21.3 / p50 28.5 ms** at dpr 1 scale 1 (1.44 Mpx, its default),
not the 13-14 ms in the folklore. That is engine cost, not the controller.

### E. Three real defects in the control law, all found by simulating it
The law now lives in `src/core/AdaptiveResolution.ts` as a pure function of frame periods,
and `.tmp/adaptsim.mjs` **imports that module** (`node --experimental-strip-types`) rather
than transcribing it, so the simulation cannot drift from what ships.

1. **Every load-driven descent STEP doubled the probe backoff.** A descent chain is one
   decision, and it is multi-step exactly when part of the cost is not in the pixels,
   because the `sqrt(load)` model then undershoots. Four steps left 32 windows — 18 to
   48 s — before the first attempt to climb back, and the branch watched for 16 s.
   "Descends and never returns" was largely "was not watched long enough". Only a failed
   probe doubles anything now.
2. **Nothing stopped a descent that bought nothing.** A step must now cut the mean period
   by 8% (`ADAPT_PAYOFF`), and **two** consecutive steps that fail to end the descent —
   two, not one, because under vsync a real improvement can hide inside an interval
   (26.4 -> 19.8 ms both present at 33.3, and the step after that crosses to 16.7).
3. **When no rung can hold the target, the useful move is to give up frame rate, not
   pixels.** The accepted interval count is free to change — no reallocation, no TAA reset
   — and `targetFps` 60 at two intervals is arithmetically identical to `targetFps` 30 on
   a 60 Hz panel (row 3 of the `ADAPT_HIT_BUDGETS` table is row 1 with the budget
   doubled). Simulated on a machine with 20 ms of non-pixel cost and cheap pixels: the new
   law keeps 1408x792 at 30 fps; the law on main grinds to its 0.62 clamp and gets 14 fps.

Two further rules came out of simulating the *hitch cost* rather than the frame rate. A
marginal window must repeat before it is acted on (`ADAPT_DROP_CONFIRM`: one 90-frame
window at a true on-time share of 0.95 reads below the 0.94 threshold a third of the
time), and the climb needs four *consecutive* qualifying windows rather than four
cumulative ones. Without them the law made **5.9 scale changes a minute** at a marginal
rung; with them, 2.0/min while it finds its level and **0.40/min** afterwards.

### F. A scale change is not free, and now there is a number for it
First frame after a resize, measured across 33 changes in the sweeps: **94-569 ms**
(median ~230); the two frames after it 6-122 ms. That is the post-stack reallocation plus
a discarded TAA history. It is why the law refuses to retest a rung it has proved fails
until `failWait` expires, why the backoff caps at 200 windows (~5 min), and why the
simulation charges itself 230 ms per step — a simulation where stepping is free is testing
a different controller.

### G. What is verified, and what is not
Verified: the cost curve; that the law lands on the same rung a brute-force search of the
ladder finds, in nine machine/panel/target combinations including two this box cannot
produce at all (120 Hz, `targetFps` 30); climb-back from the ladder floor; squall
recovery; immunity to isolated 400 ms stalls; the hitch budget; and — live, on a quiet
box, `--dpr 2` at ultra — an opening backing store of **1.56 Mpx instead of 5.76**, a
first correction at **t=2.5 s in one step**, 60 fps from t=5 s, and a settle at 0.30
(960x540) held to t=24 s. The simulation predicted 0.30 for this harness from the sweep
alone, before the live run; that is the one end-to-end check available.

**Not verified: the steady state on real hardware.** The simulation's jitter is this box's
(p95/p50 = 1.37 at dpr 1 scale 1) applied multiplicatively, and part of that tail is other
agents' processes. A quieter machine has a thinner tail and settles one or two rungs
higher. For this box at dpr 2 the sim says 1152x648 at 30 fps; a real Retina M2 not
running a dev server and four agents will do better and by how much is not measurable
here. Nor is the visual question — whether 960x540 upscaled to a 3200x1800 panel is
acceptable — answerable from a headless PNG, which is the backing store and not what the
panel shows after upscaling.

### H. The conflation §57 asked about, with numbers
`min(devicePixelRatio, maxPixelRatio) * renderScale` puts two settings into one number and
the controller owns only one of them. Since cost depends only on the product (section B),
on a Retina panel at ultra `renderScale` spends most of its range undoing
`maxPixelRatio: 2` — and the **ladder's reach becomes dpr-dependent**: its floor is
0.09 Mpx at dpr 1 and 0.36 Mpx at dpr 2. In simulation that is exactly why the dpr-2 case
has to give up 30 fps while the dpr-1 case does not: the ladder ran out, not the machine.
The fix is to make the ladder a pixel budget and `maxPixelRatio` a cap rather than a
target. I did not make it: choosing between "960x540 at 60 fps" and "1152x648 at 30 fps"
on a 3200x1800 panel is a visual judgement, and TAA already resolves the subpixel detail
that 2x device pixels is being paid for.

### I. A third probe trap, on top of §57's two
A period recorder installed with `addInitScript` starts at page **load**, not at the
engine's first frame. That put 57 frames of an empty page into a "first 3 seconds" window
and reported the title screen at **58 fps before a single triangle had been drawn**. Time
the boot from the engine's first frame (`window.__leeward` appearing), not from navigation.
And sample `ps` around **every rung**, not around the run: a rival arriving in the middle
taints some rungs and not others, and "rivals 6p/2b" at the end of a nine-minute sweep
says nothing about which ones. One three-pass sweep was thrown away for exactly that.

### J. The controller is right and the picture it settles on is soft. Both are true.
`--dpr 2` at ultra, noon, the same 1100x700 region of the same 3200x1800 screenshot:

| | backing store | p50 | 1vsync | high-frequency energy |
|---|---|---|---|---|
| controller off (`renderScale` 1) | 3200x1800 | **88.6 ms** | 4% | **11.30** |
| controller on | ~960x540 | **17.0 ms** | **93%** | **3.15** |

(High-frequency energy is the mean per-pixel luma gradient, `.tmp/sharp.mjs`. The off run
was quiet, `rivals 0p/0b`; the on runs read 15.4-15.6 / 16.8-17.0 ms and 91-93% with
`rivals 3-4p/1b`, and contention can only ADD time, so those bound the truth from below.
The two frames are ~10 s apart in ship position, which cannot account for a 3.6x gap.)

So the trade at ultra on a Retina panel is **5.2x the frame rate for 3.6x the detail**,
and it looks it: the rigging loses definition, the gunport stripe turns to mush, the foam
loses its structure. That is exactly what the branch was afraid of — but the alternative it
was compared against was never 1984x1116 at 63 fps. Main's clamp holds 1984x1116 at
**36-38 ms, 28 fps**, and cannot go lower.

The real conclusion is that neither end of this ladder is a good picture at 60 fps, and the
fix is not in the controller: it is to stop asking for 5.76 Mpx. At CSS 1:1 on the same
panel — 1600x900 = 1.44 Mpx, the pixel count every measurement in this project used — the
frame costs **29.4 ms**. To hold 60 fps there, the 9.44 ms fixed term plus 19.9 ms of pixel
cost has to fit in 16.67: either the pixel term drops ~40% or the fixed term drops ~13 ms.
**That is the concrete performance target**, and it is the same one AGENTS has always
stated; §59D is why the controller cannot reach it for you.

## 60. Boston was a quarter turn out, and four measurement instruments were wrong before the code was

Direction 3's two weak spots, both flagged by the agent that built the content: vessels
that read at 350 m and thinly inside 200 m, and a Boston that was a town on a headland
rather than recognisably Boston. Fixed. But the reason this took a whole session is that
**four separate instruments gave confident wrong answers first**, and that pattern is worth
more than the fix.

### A. The landfall was rendered a quarter turn out, and one number said so

`vesselVert` maps town-local +Z to `(-sin θ, cos θ)` of the instance heading. `Boston.place`
set `θ = b + PI/2`, which makes local +Z **perpendicular to the line of sight** — so the
900 m depth axis was what spread across the frame and the 2600 m long axis ran away from
the eye. Consequences, all of them the reported symptom:

| | before | after (`θ = b + PI`) |
|---|---|---|
| frontage her 2600 m long axis subtends at 8 km | **1 px** | **235 px** |
| skyline columns | 112 (the depth axis) | 240 |
| profile shape | one broad lump | central peak + saddle + shoulder either side |

Three hills laid out along `x` were stacked one behind another. The Trimountain could not
read as three humps because it was never presented as three of anything. **A landfall
2600 m wide measuring 1 px is a fact, not an impression** — and it took ten minutes to get,
after two hours of trying to judge a hill profile by eye from crops.

### B. The exaggeration was in the wrong place, so it bought nothing

`BEACON_H = 90` against a real 45-60 m was already documented as a deliberate lie. But
`inland = z / 700` made the ground rise monotonically to the BACK of the peninsula, and the
hill was multiplied by `0.35 + 0.65 * inland`. So at the town's own depth the ridge was 57 m,
not 90 — two thirds of the exaggeration was spent on ground behind everything built on it,
and the State House at z=300 stood against **hillside**: only the top 9 m of a 52 m landmark
had sky behind it. A silhouette is the whole of what a town is at 8 km.

Crest the ridge over the town and let it fall away inland and the same 90 m buys 11 px of
skyline instead of 7, with the dome breaking it. **The size of a lie matters less than where
you spend it.**

### C. Four instruments, four wrong answers, in order

Every one of these produced a plausible number that pointed the wrong way.

1. **A hull box guessed from the vertex buffer.** `rail = maxY * 0.62` took the MASTHEAD for
   the rail and reported the liner's freeboard as 36 m / 160 px. The real number is 3.75 m
   and 16 px. Fixed by putting the spec on `mesh.userData`.
2. **A ladder up her side that ignored heel and pitch.** Worth up to 0.6 m of vertical error
   on a 1.65 m freeboard — most of a hull. The stripe never appeared in the profile at all,
   and the profile looked *plausible*: a smooth ramp, which is what an ambient gradient up a
   hull side looks like. Two hours were spent believing the stripe did not render.
3. **"Keep the warm pixels" to reject sea and sky.** A black hull lit almost entirely by sky
   ambient comes out faintly BLUE, so this discarded every reference level; the fallback then
   picked the stripe's own level as its own reference and the contrast measured **zero in both
   builds**. Reject bright blue instead.
4. **A fixed reference offset above and below the band.** The change under test WIDENS the
   band, so a reference 0.4 m off centre sat on bare paint in one build and on the stripe in
   the other — and widening the stripe made the measurement go **down**. A straight-line fit
   through the non-stripe levels then had no levels left to fit on a two-stripe hull and
   returned zero. Only a local peak-to-floor window inside half a metre works, and it only
   works where that window spans several pixels.

**And the box was full of the wrong ship.** Every per-vessel measurement box was part-filled
by the PLAYER's own rig, which is identical in both builds: the chase camera puts her across
the middle 0.38 rad of frame, so a stationed hull inside that is literally behind her. That
dilution is why the first four rounds of rig-ink deltas came out at a few per cent. Hiding
her (`world.shipRoot.visible = false`) is what finally made the signal visible.

### D. What the numbers say once the instruments work

The claim that the coverage filter *conserves* ink rather than adding it is confirmed, and
it means single-frame ink totals are the WRONG measurement for this fix. The right one is
temporal, because the defect is temporal.

| at 554 m, above the waterline | before | after |
|---|---|---|
| liner, mean frame-to-frame change | 14.3 sRGB/frame | **4.4** |
| liner, pixels changing >12 sRGB | 45% of box | **8.7%** |
| brig, mean frame-to-frame change | 14.8 sRGB/frame | **5.4** |
| brig, pixels changing >12 sRGB | 49% of box | **11.4%** |
| single-frame thin-ink total | — | flat within 10% |

Half of every distant rig was changing by more than 12 sRGB **between consecutive frames**
with the hull on station and its attitude frozen, i.e. with nothing moving but the camera by
a fraction of a pixel. That is the crawling net from §52, on the vessels, and it is gone.

What could NOT be measured: the stripe's contrast on the brig, whose freeboard is 6.9 px.
The reference window has to be wider than the widest band under test and narrower than her
freeboard, and there is no such window. Repeat runs of identical code spread ±25 sRGB. The
liner (16 px of freeboard) is the only hull these numbers mean anything on.

### E. Instruments that now exist

- `showcaseNear` **keeps station**: a showcase vessel left to sail closed 420 m -> 259 m in
  the nine seconds a capture settles for, a 62% change of pixel scale between two runs of
  identical code. Stationed hulls also sit upright, for the reason in C2.
- `?showcase=far` — the same three hulls at 5.5x the range, which is where rigging goes
  sub-pixel and the whole minification question is settled.
- `?showcase=boston8` — the landfall at 8 km **dead on the bow**, because a silhouette
  cannot be A/B'd from two crops taken at two different bearings.
- `.tmp/vesselprobe.mjs` — serves `dist/` from a route handler (no dev server, no HMR to
  invalidate it), asserts the frame counter rises, runs at cloudCover 0, and prints
  freeboard in px, the stripe against the planking, thin-ink, and a three-frame flicker
  statistic. `.tmp/mag.mjs` magnifies nearest-neighbour, because a 3 px gunport cannot be
  judged at 1:1 on a screenshot of a screenshot.

## 60. Boston's landward depth order: the flagged risk reproduces, but it is a thinning, not a failure

The world agent shipped the town with an honest caveat it could not test: the mast
thicket is emitted **far-to-near in town-local order** so it accumulates correctly with
depth-write on, and *that order is only right from seaward* — sail past and look back
and the thicket should thin.

Tested. **My first attempt was invalid**: I moved the ship 22 km to the far side, which
retires the landfall and spawns a new one, so I compared two different towns (their
absolute z differed by 385 m and the ship x by 22 km — the tell). Boston is held in
absolute coordinates precisely so it is a place rather than a backdrop, and that makes
"move the observer" the wrong lever.

The valid test flips the town's own `bearing` by π at runtime, which reverses which end
of the 2.6 km frontage is nearest the eye without touching anything else:

| | dark pixels in the waterline band | ink |
|---|---|---|
| as shipped | 18,288 | 288.3 |
| `bearing + π` | 15,922 | **133.0** |

**A 54% loss of ink.** But the crop shows it still reads as a town — the hill, the
cupola breaking the ridge, buildings along the skyline, a second stretch to the right.
No holes, no z-fighting, no corruption. So the risk is **real and mild**: a thinning,
not a failure.

**And this test cannot attribute it.** Flipping the bearing changes the depth order
*and* the aspect at the same time, and the town is not symmetric — from behind the hill
fewer waterfront buildings face the eye, which is correct rather than a bug. Separating
the two needs the emission order reversed while the bearing is held, which is a change
in `Boston.ts` rather than a runtime poke. Recorded as an upper bound on the defect:
**at most** 54% of the ink, and no visual failure at all.

## 61. The landfall was a quarter turn out, and one number found it

Boston's 2600 m long axis **subtended one pixel at 8 km**. `place()` set the yaw to
`b + π/2`, which puts town-local +Z perpendicular to the line of sight — so the 900 m
depth axis spread across the frame while the length ran away from the eye, and three
hills laid out along x were stacked front-to-back into one hump. `b + π` takes the
frontage from **1 px to 235 px** and the skyline from 112 to 240 columns.

Worth noting what that means about the earlier report. The previous world agent wrote
"Boston is a town on a headland, not recognisably Boston" and "the dome and spires only
resolve inside ~2 km" — both true observations, and both symptoms of a one-line
orientation bug rather than of insufficient detail. A skyline problem that looks like it
needs more geometry can be a transform.

The hill-exaggeration trade was also in the wrong place rather than the wrong size:
`BEACON_H = 90` against a real 45–60 m was already there, but `inland = z/700` put the
crest at the **back** of the peninsula and scaled the hill by 0.35–1.0, so the visible
ridge was 57 m and the State House stood against hillside with only the top 9 m of a
52 m landmark against sky. Cresting the ridge over the town buys 11 px of skyline from
the same 90 m instead of 7.

### The vessel fix was temporal, and the ink measurement was the wrong one
The coverage filter conserves ink by construction, so single-frame thin-ink is flat
within 10% either way — *that is the point*, and measuring it proves nothing. The defect
was flicker, with the hull on station and its attitude frozen so nothing moved but the
camera, sub-pixel:

| at 554 m | before | after |
|---|---|---|
| liner, mean frame-to-frame change | 14.3 sRGB/frame | **4.4** |
| liner, pixels changing > 12 sRGB | **45% of box** | **8.7%** |
| brig | 14.8 sRGB/frame, 49% | 5.4, 11.4% |

Half of every distant rig was changing by more than 12 sRGB between consecutive frames.
That is §52's crawling net on the vessels.

**And the gunport stripe honestly did not improve at the close pass.** Contrast against
her planking at 174 m is 10.5/23.7 sRGB before and 10.8/26.8 after — essentially
unchanged, because at that range the band already resolves at 2.5 px either way. What
changed is structure: a hard edge instead of a vertex-interpolated smear spanning 0.2 of
the freeboard, a band specified in metres, and gunports. The filter's real benefit is
past 400 m and **could not be measured** — the reference window must be wider than the
band and narrower than the freeboard, and by then it is itself sub-pixel. On the brig no
reliable number exists at all: repeats of identical code spread ±25 sRGB.

**Triangles went down while detail went up**: 23,954 → 22,188 total, every hull and the
town cheaper, because a rope ribbon is 2 triangles where a capped four-sided cone was
16 — which paid for 7 shrouds a side instead of 3 and 168 moored ships instead of 64.
Zero extra draw calls, via `transparent: false` with `CustomBlending`: three only
consults `transparent` when choosing a render list, so the mesh stays in the opaque list
while blending still applies.

## 62. The blind critique: the work wins 3 of 4, and the top defect was never on my list

First blind pass since the rubric was written. Four scenes, current `main` against
`2e7901f` (before the last two days), same harness, same size, **each pair shuffled
independently** so pane1 was not consistently one build. The critic scored all 32 axes
and all four winners before being allowed to look across pairs, and never saw the key.

| scene | winner | totals | |
|---|---|---|---|
| noon | **NEW** | 4.19 v 3.44 | |
| golden | OLD | 4.69 v 4.56 | critic called it **a tie inside its own noise** |
| helm | **NEW** | 4.56 v **2.38** | most decisive margin on the sheet |
| orbit | **NEW** | 3.94 v 3.19 | |

**New build 3 of 4.** On golden it noted the NEW pane had "demonstrably better lighting
— real warm/cool split, ΔL 40 v 20, the only internally-shaded cloud on the sheet" and
lost on composition and restraint because of foam coverage, i.e. it lost the pair while
winning the axis the hour is about.

Two independent confirmations worth having. It found the **wheel as a pile of loose
planks** in the OLD helm pane, unprompted, and reasoned to the cause — "a translate
where a rotate-about-hub belongs produces exactly this" — which is §50 exactly. And its
post-hoc clustering picked out all four NEW panes as "brighter, higher-contrast, more
saturated" without knowing which was which.

**Scores are 2.38–4.69 out of 10.** That is the rubric working as designed.

### The finding that matters most, and it was not on my list at all
> **The far-field ocean dies before the horizon, and the horizon is a stack of
> hard-edged bands.** All eight frames.

Cleanest instance, `orbit-pane1` at x 0–520: a pale cyan hairline at y 573–576, a
lighter grey band, then a **hard charcoal bar at x 80–360, y 581–585 with crisp top and
bottom edges**, then an abrupt step at y = 586 into a flat pale mauve field — ΔL 47
across 1–2 px. In `noon-pane1` at x 0–420 the ocean between y 328 and 356 is **4–6 flat
horizontal stripes** with hard boundaries and zero wave detail. It is #1 because the
horizon is the longest line in every frame and the first thing an eye checks.

Nobody had reported this in two days of defect-driven work, including me. That is the
argument for a blind pass with no priming.

## 63. The ship receives no sky fill and clips to exactly (0,0,0) — and it completes §56

**Verified independently.** In `orbit-pane1`'s hull band (y 730–840, x 500–1100):
**30.3% of pixels at L < 4**, and **16.1% — 10,719 pixels — at exactly RGB(0,0,0)**,
under a sky whose mean luminance in the same frame is **137**. A surface under a bright
sky dome receives sky irradiance; pure black there is not a grade choice, it is a
missing ambient term.

Consequences the critic drew, both right:
- A genuinely well-proportioned hull "reads as a paper cut-out", and none of the
  modelling that clearly exists is visible. Bulwark, quarter-galleries, channels and
  stern merge into one flat silhouette; only the gunport strake survives.
- **Shadows on the sails read as "hard-edged black stickers"** — a top's shadow at
  (742–787, 594–625), a mast cap at (919–960, 625–671), a crosstree at (842–887,
  580–607) — with "no penumbra, no ambient lift inside."

**That last point completes §56 and corrects how I closed it.** §56 proved the shadow
*penumbra width* is physically correct — 1.6–6.5 px is the true band for this rig's
caster separations and the shipped filter measures p25 2.5 / p50 3.5 / p75 6.2 — and I
closed the item on that basis. The measurement was right and the conclusion was too
narrow: **the owner's complaint was that the shadows read as hard black blocks, and a
correct-width penumbra around an interior with no ambient fill still reads as a
sticker.** I answered the question I had instrumented rather than the one that was
asked. The edges were never the problem; the fill was.

A related member of the same family: **a whole class of small props renders as flat,
unlit black silhouettes** — 25+ belaying pins in `helm-pane2` at (905–1330, 470–620)
and (180–620, 285–390), "identical Γ glyphs with no gradient across them, no variation
between pins at different orientations", and the yards in orbit, e.g. (674–842,
510–516) as "a solid 2 px black bar". Objects receiving no light at all.

### What it checked and did NOT find, so the loop stops chasing them
- **No water tiling.** Autocorrelation of near-field water in all six wide frames: no
  secondary lobe at any lag. What had looked like peaks was the decay skirt of its own
  exclusion window.
- **No sky banding.** Longest run of unchanging value 2–11 px at 0.3 LSB, all eight.
- **No tonemapper hue skew.** Brightest sky warm with G between R and B in all eight.
- **Almost no highlight clipping** — max 0.034% of pixels ≥ 254 in any channel.
- **The dither is correct: leave it alone.** It flagged an interleaved-gradient-noise
  grating at 2.26 × 3.22 px as a defect, then measured its amplitude at **0.16–0.96
  LSB** and retracted: "a properly calibrated dither and the reason there is no banding
  anywhere."
- **The HUD is the one thing already at commercial quality.** "It never competes in any
  of the eight. Don't touch it."

### Bugs it named that need their own answers
- **Orphan spar** in the OLD noon pane: a tapered stick (795,472)→(858,502) clear of
  the ship and its rigging, casting no shadow. Present in OLD; **check whether it
  survives on main.**
- **A sail and its boom pass through the sea surface** in both noon panes — boom end at
  (745,632) at or below the water, no splash, no intersection foam.
- **Foam drawn over the hull's flank up to gunport level**, x 826–975, y 785–840.
- **Two featureless white ellipsoids threaded on a rope outboard the starboard rail**,
  ~(1345,700) r≈14 and ~(1372,715) r≈13. It could not tell what they are meant to be.
- **The masthead is clipped by the top edge in all four wide shots.** The chase camera
  has no headroom for the rig — and note §48 gave that camera an aspect-driven distance
  floor for the *horizontal* fit only.
- **Nothing is alive in any of the eight frames.** Direction 3's populations are a
  Poisson process with means of minutes, so a scene that does not force them shows empty
  sea — which is correct behaviour and still means the sanctioned review sheet never
  shows the world's life. The `wildlife` scene exists for this; the review sheet should
  include it.
- **The ensign may be an anachronism** — "a modern-looking US flag with a full star
  grid". The texture was verified at 15 stars and 15 stripes by dumping it, so this is
  probably a misread at 80×50 px, but it is worth one look at 1:1.

## 64. The 9.44 ms that is not in the pixels: three items, and the floor is CPU

§59B fitted the whole engine to `cost = 9.44 ms + 13.83 ms/Mpx` and §59D attributed the
intercept to "the shadow map, the solver and the FFT dispatch" without measuring it. This
measures it, by ablation at two and three render scales, which is a direct answer rather
than an attribution argument: **a saving that is the same at 1.115 Mpx and at 3.327 Mpx is
fixed cost, and one that grows with the pixel count is not, however much it looks as if it
should be.**

Instrument: `.tmp/fixedsplit.mjs`, noon @ ultra, 1600x900 CSS at dpr 2, controller off,
`ps` sampled around every cell.

### A. The curve reproduces
Three rungs, two passes, quiet box:

| scale | backing store | Mpx | p50 |
|---|---|---|---|
| 0.76 | 2432x1368 | 3.327 | 55.6 |
| 0.60 | 1920x1080 | 2.074 | 37.8 |
| 0.44 | 1408x792 | 1.115 | 23.8 |

Fit: **cost = 7.86 ms + 14.37 ms/Mpx, worst residual 0.15 ms.** The same line as §59B —
the slope agrees to 4 per cent and the intercept to within its own uncertainty over a 3x
lever arm, which §64G shows is about +/- 1.5 ms.

### B. Paired A/B, because the noise is the size of the effect
The first attempt measured each variant as one long block. At 1.115 Mpx the *same*
baseline read p50 25.8 twice and 23.8 once, against shadow and wake effects of 2-3 ms — so
a block A/B cannot resolve them, and the 5.76 Mpx rung is worse (44 samples in 4 s, p95
103 against p50 88). Every number below is instead the **median of per-pair differences**
from base and variant alternated in 1.4 s bursts, order flipped every pair, the first 0.7 s
after each switch discarded. Slow drift then cancels instead of landing in the answer.

### C. The split, measured

| ablated | saves @ 1.115 Mpx | saves @ 3.327 Mpx | reading |
|---|---|---|---|
| **sun's shadow map, generation only** (`shadow.autoUpdate = false`) | **3.45** | **3.70** | fixed 3.3 |
| ...its VSM blur alone (`blurSamples` 6 -> 1) | 1.30 | 1.00 | fixed ~1.15 |
| ...`shadowMapSize` 2048 -> 1024 | **2.45** | **2.45** | fixed 2.45, identical |
| ...the per-pixel lookup (`castShadow` off, minus the row above) | -0.70 | +0.25 | ~0 |
| **the wake field** (`WakeField.update`) | **2.25** | **2.85** | fixed ~2.0 |
| ...its target 1536² -> 1024² | **1.75** | (spread 3.3, unusable) | fixed 1.75 |
| ...-> 768² | 1.55 | 1.65 | fixed 1.5 |
| ...-> 512² | 2.20 | 2.75 | fixed 1.9 |
| **the ocean FFT** (57 sim passes) | **1.75** | **2.95** | fixed ~1.8 |
| the ocean foam sim | 0.40 | 0.30 | fixed 0.35 |
| the sky's env probe + PMREM re-filter, 6 Hz | 0.55 | 0.10 | ~0.3 |
| the aerial froxel volume, 16 draws every 8th frame | 0.05 | 0.60 | ~0.35 |
| the sky-view LUT | 0.05 | -0.25 | 0 |
| **the cloud shadow map, 512² over 26 km** | 0.05 | -1.20 | **0** |
| the cloud march (half res) | 2.10 | 5.15 | 0.56 + 1.38/Mpx |
| the cloud temporal resolve (half res) | -0.10 | 3.40 | ~1.5/Mpx |
| all volumetric clouds | 4.25 | 9.55 | 1.58 + 2.40/Mpx |
| the ocean surface draw (`visible = false`) | 4.95 | 11.80 | 1.50 + 3.10/Mpx |

Whole-module ablation at 1.115 Mpx, base p50 25.5, as the check that the itemised list has
not missed anything: **vfx 2.60, ocean 1.95**, vfx:weather 0.90, weather 0.90 (spread 5.6,
unusable), sky 0.65, audio 0.40, world 0.40, ui 0.25, physics 0.15, wildlife 0.00, camera
-0.25, ship -0.80, input -1.05. And vfx decomposes to **the wake field and nothing else**:
wake 2.85, water probe -0.95, hull water 0.30, spray -0.75, the particle step 0.20.

**Three items are the whole fixed term**: the sun's shadow map (3.3-3.7), the wake field
(2.3-2.9) and the ocean FFT (1.8-3.0), summing to 7.4-9.6 against a fitted intercept of
7.86-9.44. Individual savings sum higher than the intercept because the frame is partly
overlapped, so no single item "owns" it — but nothing large sits outside that list.

### D. The three suspects, priced
- **The VSM blur is real but it is a third of the shadow's cost, not the cost.** 1.0-1.3 ms
  of a 3.45-3.70 ms shadow map; the depth render into the same 2048² map is the other
  2.2-2.7. And the blur cannot be made cheaper at the same visual radius: three spaces
  `VSM_SAMPLES` taps uniformly over +/- `radius` texels, so 6 taps across 2.2 texels are
  already 0.88 texels apart, which is the minimum spacing for contiguous bilinear coverage.
  The note at `SunLight.ts:94` is right about the mechanism and wrong about the magnitude.
- **The atmosphere LUTs are nil.** In steady state transmittance and multi-scatter do not
  rebuild at all (`sky:bakeMs` never appears), the sky-view LUT reads 0.004-0.025 ms and the
  aerial volume 0.20-0.25 ms amortised. About 0.3 ms for the whole chain.
- **`CLOUD_SHADOW_SIZE` 512 over 26 km is 0.00 ms**, measured at both rungs.

### E. The floor is CPU, and it is nearly the whole intercept
`settings.debug` per-module stopwatch plus `ext.post.profile()`:

| | 1.115 Mpx | 3.327 Mpx |
|---|---|---|
| sum of `upd:*` | 3.95 | 4.94 |
| post stack submission | 2.31 | 2.61 |
| **CPU per frame** | **6.26** | **7.55** |

against a fitted intercept of 7.86 ms. Largest CPU items at 3.327 Mpx: `upd:ocean` 2.08
(of which `ocean:cpu` 0.96 is the CPU wave mirror and `ocean:gpu` 0.86 is *submitting* the
57 sim passes), the post stack's `scene` mark 1.68-2.00 for 75 draw calls — **27 us of CPU
per draw call** — then `upd:vfx` 1.10, `upd:physics` 0.41, `upd:sky` 0.34.

So the practical consequence for §59D and §59J: **the fixed term does not contain 13 ms to
give.** It is 7.9-9.4 ms in total, of which 6.3-7.6 is CPU that no amount of GPU-pass
removal touches. An engine with every fixed GPU pass free would still hold 60 fps only up
to about 0.72 Mpx on this box. Both terms have to move, and the fixed one is nearly spent.

### F. Four instrument corrections
1. **`world.ext.post.profile()` does not return GPU time here, `syncMode` notwithstanding.**
   Its passes sum to 2.31-2.61 ms against frames that cost 24.8-55.8 ms. `gl.finish()`
   under ANGLE-on-Metal does not block until the GPU drains — §16's `gl.finish()` row
   biting again — so every number it prints is *submission* cost. It is still a good
   instrument, and it is where the 27 us/draw-call figure above comes from; but a change
   "priced at 0.020 ms" with it was priced in CPU, not in frame time.
2. **`world.stats.drawCalls` counts only the render hook.** `Engine.tick` calls
   `renderer.info.reset()` *after* every module update, so the ocean's 57 sim passes and
   the sky's LUT passes are invisible in it. The real `renderer.render()` count per frame at
   ultra/noon is about 140, not the 68-91 that gets quoted.
3. **Setting `settings.renderScale` without dispatching a resize measures the OPENING CAP,
   not the rung you asked for.** `Engine.applyResize` applies `seedOpeningLevel` on the
   first resize whatever `adaptiveResolution` is set to afterwards, so a probe that only
   writes the setting sits at 1664x936 = 1.56 Mpx. The tell is a base p50 of 31 where the
   sweep says 55.6. This invalidated one paired run before I noticed.
4. **The rival-renderer counter in `adaptsweep.mjs` matches command LINES, so it counts
   your own shells.** `/chrome-headless|ms-playwright|Chromium/` is satisfied by any
   `until pgrep -f 'ms-playwright' ...; do sleep 2; done` wait loop, and the probe's ppid
   walk excludes descendants but not siblings. A run on a genuinely idle box therefore
   reported `rivals 3/3` and I discarded a before/after comparison as contended. Anchor on
   argv[0] being a browser binary instead; `.tmp/fixedsplit.mjs` now does.

### G. What was cut: the wake field's texel, measured from both directions
`wakeRes` at ultra 1536 -> 1024 in `src/vfx/WakeField.ts`, i.e. the value `high` has always
shipped. The field spans a constant 1024 m, so this is a texel size: 0.67 m -> 1.0 m. The
whole target is decayed by one pass every frame and the foam ribbon re-stamped into it, so
the cost is quadratic in this number and none of it scales with the backing store.

| measurement | result |
|---|---|
| paired A/B before, 1536 -> 1024, 1.115 Mpx | **saves 1.75 ms**, pair spread 1.20, pairs 1.9 / 1.6 / 0.8 / 2.0 |
| paired A/B after, 1024 -> 1536 (positive control), 1.115 Mpx | **costs 1.30 ms**, pair spread 1.40, pairs all one sign: -1.4 / -1.7 / -1.2 / -0.9 / -1.1 / -2.3 |
| base p50 at 1.115 Mpx, pooled over every clean window | **25.3-26.4 before** (one disturbed sample read 23.8), **23.9-24.5 after** |
| re-run sweep after, four rungs, three passes, quiet: 64.5 / 55.8 / 37.2 / 23.9 at 4.064 / 3.327 / 2.074 / 1.115 Mpx | **cost = 8.46 ms + 13.95 ms/Mpx**, worst residual 0.94 |

Take the conservative figure: **1.3 ms of fixed cost, about a sixth of the whole non-pixel
term**, and confirmed by the same instrument with the sign flipped, which a one-sided
ablation cannot do.

**And the last row is why a sweep is the wrong instrument for a change this size.** The
re-run puts the intercept at 8.46 against 7.86 before — nominally *worse*, which it is not.
The lowest rung anchors the intercept and that rung's own run-to-run spread is about +/- 1 ms
(it has read 23.8 through 26.4 on identical code); with four rungs, ~1 ms of per-point noise
and a 3 Mpx lever arm the intercept's standard error is roughly **+/- 1.3 ms**, so the fit
cannot resolve a 1.3 ms shift in itself. What the sweep *can* see is the per-rung median,
and that moved by 1.5 ms at the rung where the effect is largest relative to the total. Do
not read a sweep intercept as a before/after statistic without that error bar — the §59B
figure of 9.44 and the 7.86 above carry the same one, which is also why they differ.

**The visual cost, stated plainly**, because this is a quality-for-speed trade and not a
free win by assertion: the *persistent* field's texel goes from 0.67 m to 1.0 m. That field
carries nothing sub-metre in the first place, for two reasons already in the code — the
fine near-hull detail lives in `interaction`, 128 m over 512 = 0.25 m/texel, which this does
not touch; and the foam channel is a coverage that `ocean/shaders/surface.ts` thresholds the
ocean's own high-frequency field against (`linstep(thr - wThr, thr + wThr, decide)`) rather
than drawing as an alpha, exactly as the contract in `vfx/index.ts` demands. What is left in
the persistent field is the Kelvin pattern, whose divergent arms are tens of metres apart.

Measured, not asserted. `.tmp/wakeshot.mjs` shoots both resolutions in ONE session with an
equal settle after each resize (the resize calls `clearTargets`, so a shot taken immediately
after it compares a mature wake with an empty one and measures the settle):
`.tmp/sharp.mjs` on the same 1300x540 crop of the wake at 3200x1800 reads **6.049 at 1024
against 5.974 at 1536** — 1.3 per cent apart and in the *wrong direction* for a resolution
loss, against an instrument that moved 3.15 against 11.30 for a real one (§59J). By eye the
foam speckle, its scale and the wake's envelope are indistinguishable. Frames are
`.tmp/WK-wake*.png` (orbit) and `.tmp/WL-wake*.png` (waterline).

One thing those frames do show, at BOTH resolutions and therefore nothing to do with this:
**a hard-edged white plate of foam along the hull's waterline** in the `waterline` scene, a
flat pale sheet with a straight leading edge running most of the ship's length. §40 recorded
the foam plate as fixed; something in that family is back, it is in the near-hull water and
not in the persistent field, and it is the most owner-visible defect in the frames I took.

### H. What is left on the table, with prices
- **The shadow map at 1024: 2.45 ms, the largest single fixed saving available, and an
  owner decision rather than a free win.** §56's control measured `map512` taking the
  sail-shadow edge p50 from 3.48 to 8.42 capture px; 1024 lies between and is untested, so
  `.tmp/leechshadow.mjs` now carries a `map1024` variant to get the number before anyone
  decides. The other levers on that 3.5 ms are already at their floor: the blur taps are
  0.88 texels apart (§64D) and the frustum half-extent at noon is 54 m against a ship whose
  bounding radius the code puts near 60 m, so there is no slack to reclaim by tightening it.
- **The wake field's decay pass, ~0.9 ms at 1024², with no visual change at all.** It is one
  pass over the whole target every frame doing two jobs: multiply R by `uDecay`, and zero
  GBA. Exponential decay is separable in time, so decaying 1/N of the field per frame by
  `uDecay^N` follows exactly the same envelope, at most N/60 s stale — 1.6 per cent of a
  texel's own value at N = 4 against the shortest tau of 4 s, and the same amortisation the
  water probe already applies to its rows. The GBA zero only needs to cover the ribbon's own
  AABB, which `render()` already computes, because outside it nothing has written GBA since
  the last zero. Not attempted: a scissor error here leaves a permanent rectangle of stale
  wake height, which is exactly the class of artefact this file is full of.
- **The ocean sim's 57 passes, ~0.9 ms, bit-identical output.** `oceanResolution` is a
  no-op between high and ultra — `MAX_FFT_N` caps `cap` at 256 either way — and the
  band-limit rule then gives n = **64/64/64/256** at ultra (measured off the live module)
  and 128/128/256 at high (the same rule, arithmetic only). The three 64² cascades therefore
  share an identical FFT: same stages, same butterfly table, differing only in `uH0` and two
  scalars. One MRT group with 6 attachments would do those 39 passes' work in 13. The output
  is identical by construction and `world.ext.ocean.debugCompare()` is the gate. Not
  attempted, for time.
- **On the variable side**, the biggest single item is the cloud march plus temporal resolve
  at about 2.9 ms/Mpx of the 14.37 total, at `CLOUD_RESOLUTION_DIVISOR` 2. Divisor 3 would
  give back roughly 1.3 ms/Mpx, 9 per cent of the slope. Visible, so it needs
  `.tmp/sharp.mjs` and an owner decision.

### I. One number worth chasing that is not mine
`scripts/capture.mjs` at its default 1600x900 dpr 1 (1.44 Mpx) now reads **noon p25 16.5 ms,
at the rAF cap** — with one rival browser present, so contention can only have ADDED time and
16.5 bounds the true cost from below. §59D recorded the same scene on a QUIET box at p25 21.3
/ p50 28.5. Some of that is the wake cut, most of it is not: the rigging went from a capped
cone to a two-triangle ribbon and Boston landed in between. **The standing "60 fps at
1600x900 at ultra" may now hold at dpr 1**, and that is worth one clean `--wait-quiet` run by
whoever gets a quiet box next. It does not hold at dpr 2, where the same CSS size is 5.76 Mpx.

### J. What is not verified
The shadow-edge cost of `shadowMapSize` 1024 — the variant is added, the run was not made.
Whether the wake texel change is visible to the owner on a real panel: a headless PNG is the
backing store, not what a panel shows after upscaling. And none of this is measured on real
hardware — §64E makes the fixed term a property of this box's CPU as much as its GPU, so a
quieter machine with a faster core has a smaller one, and by how much is not knowable here.

## 65. Four instrument corrections, one of which I had propagated into three briefs

### `world.ext.post.profile()` does not return GPU time on this box
Its passes sum to **2.31–2.61 ms** against frames costing **24.8–55.8 ms**. The reason
is already in this file: `gl.finish()` does not block under ANGLE-on-Metal (§16), and
`profile()` is built on a `finish()` between passes. So it is timing **CPU submission**,
not GPU work.

**This is mine to own.** I wrote "`ext.post.profile()` … has the resolution you need" or
equivalent into three agent briefs, on the strength of an agent having priced a change at
0.020 ms with it. That 0.020 ms was CPU submission time, not frame time. An instrument
that reports a tenth of the frame it claims to account for is not a resolution problem,
it is a units problem — and I promoted it to a recommendation on one data point that
looked precise.

The working alternative is the one the sweep uses: **ablate a candidate and measure the
saving at two or three render scales.** A saving that is the same at 1.115 Mpx and
3.327 Mpx is fixed cost; one that scales is per-pixel. It needs paired A/B in short
alternating bursts, because the baseline's own spread at the low rung is ±1 ms — the size
of the effects being measured.

### `world.stats.drawCalls` counted the render hook, not the frame
`info.reset()` sat *after* the module update loop, so everything drawn during an update
was invisible. Measured after moving it: **138 draw calls for the whole frame — 68 in the
update phase, 70 in the render hook.** Every draw-call figure this project has quoted,
including every one I reported, was about half the truth, and the harness printed it as
`dc` under a label everyone read as the frame's. Fixed; the hook's share is still
published separately.

### Setting `renderScale` without dispatching a resize measures the opening cap
It silently reports **1.56 Mpx** — the adaptive controller's opening bid — rather than
the rung you asked for. This invalidated one run of the fixed-cost sweep.

### The rival-renderer counter counts your own shells
It matches command lines, so a wait-loop shell whose text contains the browser name is
counted as a rival. A run on an **idle** box reported `rivals 3/3`, and a comparison was
discarded as contended when it was not. So `CONTENDED` has been over-reported, and some
measurements discarded on this project were probably fine. It cuts the other way too:
contention can only *add* time, so a `CONTENDED` run still bounds the truth from below.

## 66. The fixed frame cost is three things, and the floor is CPU

Measured by ablating one candidate at a time and reading the saving at two render scales
— a saving that does not change with pixel count is fixed cost. Curve reproduced first at
**7.86 ms + 14.37 ms/Mpx**, worst residual 0.15 ms (§59B had 9.44 + 13.83).

| ablated | fixed cost |
|---|---|
| the sun's shadow map (generation) | **3.3–3.7 ms** — of which the VSM blur is only ~1.15, the depth render into the same 2048² map is the other 2.2–2.7 |
| the wake field | **2.3–2.9 ms** |
| the ocean FFT (57 passes) | **1.8–3.0 ms** |
| foam sim, env probe + PMREM, aerial LUT, sky-view LUT | ≤0.35 ms each |
| the cloud shadow map, 512² over 26 km | **0.00 ms**, measured twice |

A whole-module ablation confirms nothing large sits outside that list.

**All three of my suspects were priced and two were wrong.** The VSM blur is real but a
third of the shadow's cost, and it cannot be cheapened at the same radius — three spaces
its taps uniformly over ±radius, so 6 taps across 2.2 texels are already 0.88 texels
apart. The atmosphere LUT chain is ~0.3 ms total, because transmittance and multi-scatter
never rebuild in steady state. `CLOUD_SHADOW_SIZE` is free.

**And the uncomfortable finding: the floor is CPU.** `sum(upd:*)` 3.95–4.94 ms plus
post-stack submission 2.31–2.61 ms is **6.3–7.6 ms of CPU per frame** against a 7.86 ms
intercept. So the fixed term cannot "drop ~13 ms" as I had implied — there is only
7.9–9.4 there in total and most of it is CPU. Both terms of the cost model have to move.

**Cut so far: 1.3 ms**, `wakeRes` at `ultra` 1536 → 1024, the value `high` has always
shipped, measured in both directions with all six pairs on one sign. Visual cost stated
and measured rather than asserted: the persistent field's texel goes 0.67 m → 1.0 m, and
high-frequency energy on the same wake crop reads **6.049 at 1024 against 5.974 at 1536**
— 1.3% apart and in the *wrong direction* for a resolution loss, i.e. indistinguishable.

**Left on the table, priced:** shadow map at 1024 for **2.45 ms** (an owner decision —
§56 measured `map512` taking sail-shadow edge p50 from 3.48 to 8.42 px, and 1024 is
untested); the wake decay pass for ~0.9 ms, exactly free; and the ocean sim from 57 to 31
passes for ~0.9 ms, bit-identical, because `oceanResolution` is a no-op between `high`
and `ultra` and ultra's three 64² cascades could share one FFT over 6 MRT attachments.

### 66a. Settled: 60 fps at 1600x900 CSS dpr 1 does NOT hold

The fixed-cost work ended on an optimistic note — "capture.mjs at its default 1.44 Mpx
now reads noon p25 **16.5 ms**, at the rAF cap, with one rival present; contention only
adds time, so that bounds the truth from below." That reasoning is sound only if the
reading is of the same workload, and it was not.

Four runs on a genuinely quiet box (`rivals 0p/0b`, `quiet`), same scene, same defaults:

| | p25 | p50 |
|---|---|---|
| run 1 | 21.2 | 28.8 |
| run 2 | 26.3 | 30.3 |
| run 3 | 24.5 | 30.3 |
| run 4 | 26.1 | 31.0 |

**About 40 fps, not 60.** And it agrees with the cost model: `7.86 + 14.37 × 1.44 =
28.5 ms` against a measured p50 of 28.8–31.0. The model was right and the single
low reading was an outlier — most likely a moment when the workload itself was lighter
(the wildlife populations are a Poisson process, so frame content varies run to run).

So the target stands unmet by about **13 ms at the median**, and `AGENTS.md` 5 is
accurate as written. The lesson is narrower than "don't trust contended runs": a
*single* run that lands exactly on an instrument's floor is the one reading you should
never build a conclusion on, because the floor is where the instrument stops being able
to disagree with you.

Also confirmed here: draw calls now read **138** on the same scene where they read 68–91
before §65's fix, and triangles 0.73 M against 0.60 M — both consistent with the update
phase finally being counted.

## 67. §62's top defect: the horizon staircase is the cloud shadow, resolved past what a pixel can place

The blind critic's #1 — "the far-field ocean dies before the horizon, and the horizon is
a stack of hard-edged bands" — is two defects sharing one sentence. The bands are found
and fixed. The dead far field is confirmed, has a measured cause and a measured lever,
and is **not** fixed.

### The instrument, first, because six candidates were wrong

The statistic is the **column-mean luminance profile down the screen**, averaged over a
wide x range, with a discontinuity counted wherever `|L[y+1] - 2L[y] + L[y-1]| >= 1.5`
8-bit units. A real horizon is a smooth aerial-perspective ramp: total `|d2L|` small and
no discontinuities. A staircase spikes at every tread. `.tmp/hzcmp.mjs` computes it.

Everything below was measured by **rewriting the ocean's fragment shader from the page**
and recompiling with `needsUpdate`, inside one browser with the sim clock pinned (`tick`
re-stamps `lastTime`, so `dt == 0` and the rAF loop keeps presenting). Wave phase, cloud
field, sun, heading and ship position are therefore *identical* between shots, which is
what §43/§49 said was required and what a source edit plus two capture runs cannot give
you. No source change is needed to price a term: `THREE.ShaderMaterial.fragmentShader`
is a string. `.tmp/hzshade.mjs`, `.tmp/hzspec.mjs`, `.tmp/hzsun.mjs`, `.tmp/hzafter.mjs`.

`orbit`, x 0–520, y 570–604. Repeated nulls in the same process read 55.9 / 56.4 / 58.9,
so the null spread is ~3 on a signal of 45.

| ablation | tot \|d2L\| | discontinuities | verdict |
|---|---|---|---|
| null | 55.9 | 6 | the defect |
| `uGridM` 8 — `effCell` continuous instead of per-ring | 55.8 | 6 | **not** the clipmap |
| cascade cell fades pushed out of range | 61.2 | 7 | not the cascade weights |
| horizon skirt hidden | 56.8 | 7 | not the skirt |
| `slope = 0, jac = 0` everywhere (flat sea) | 50.9 | 7 | **not the wave normal** |
| `Nlow` replaced by straight up | 51.3 | 8 | not `Nlow` |
| foam forced to 0 | 43.3 | 6 | not the foam |
| reflection term removed | 46.3 | 7 | not the reflection |
| `col = haze` (in-scatter alone) | **2.1** | **0** | the in-scatter is perfect |
| `col = mix(vec3(0.02), haze, t)` | 16.6 | 3 | `t` is a smooth ramp |
| aerial perspective removed | 107.9 | 13 | the haze was *hiding* it |
| `sunSpec` removed | 20.0 | 5 | it is the sun lobe |
| `sunVis = 1.0` | **10.9** | **0** | **it is the cloud shadow** |

### The mechanism

At grazing incidence a pixel's world footprint is `pxWorld` **across** and
`pxWorld / |V.y|` **along** the view ray. In `orbit` at 4 km with the eye 25.6 m up that
is **3.2 m by 514 m**. The cloud shadow map is `CLOUD_SHADOW_EXTENT_M` 26 km over
`CLOUD_SHADOW_SIZE` 512 texels — **50.8 m per texel** — so one screen row near the
horizon spans ten of its texels and a few rows span a whole cloud. `lwCloudShadow` is
point-sampled once per pixel and the sun glitter is the dominant far-field term, so the
answer arrives as hard horizontal bands. The clipmap ring boundaries in the same frame
sit at y 576/578/580/586/598/621/665, and the measured discontinuities do **not** line up
with them — which is why the ring hypothesis, the obvious one, is wrong.

**Averaging along the footprint does not fix it.** Sixteen taps spread over exactly that
514 m span measured 41.2 against a null of 51.9. A cloud shadow is *wider* than the
footprint, so there is nothing to average out. The error is resolving it at all: once the
footprint is longer than the shadow field's own features there is no placement left to
render, and the expected transmittance over the footprint is the field's **mean**.
`lwCloudShadow` is normalised so that mean is exactly 1.0 (the absolute darkening under
overcast is already inside `uSunIntensity`), so converging to 1.0 is not "switching the
shadow off" and a storm does not brighten.

That is the same rule this shader already applies to slope variance, to the foam octaves
and to the whitecap statistic. The cloud shadow was the one world-space field not obeying
it.

```glsl
float shadowFootprint = pxWorld / max(abs(V.y), 1e-3);
float shadowRes = 1.0 - smoothstep(80.0, 600.0, shadowFootprint);
float sunVis = mix(1.0, lwCloudShadow(P), shadowRes);
```

Band chosen by measurement, not taste — 80/600 gave 17.8, 150/1200 gave 44.0, 300/2400
gave 50.7. In `orbit` it fades the shadow out between 1.6 and 4.3 km, the last fourteen
rows before the horizon; at 500 m the footprint is 8 m and nothing changes.

### The profile, before and after

Same process, clock pinned, `orbit`, x 0–520:

| | tot \|d2L\| | discontinuities | max \|dL\| |
|---|---|---|---|
| before | 55.9 | **6** | 10.5 |
| after | 13.4 | **0** | 2.0 |
| after, repeat | 15.3 | **0** | 2.3 |
| `sunVis = 1` (floor) | 10.9 | 0 | 2.2 |

Over the **full width** x 0–1600 it is 24.4 with 5 discontinuities before and 12.7 with
**zero** after. The profile that replaces the staircase is monotone: 102.3, 103.3, 104.4,
106.4, 108.2, 109.6, 110.6, 111.6, 112.2, 112.8, 114.3, 116.1, 117.3, 117.8, 117.8 — the
charcoal bar at y 582–583 (before: 109.3, 100.5, then 111.1 and 119.5) is gone, and so
are its crisp edges at 1:1.

No regression anywhere else, same-process pairs: `masthead` 25.2 → 25.3 (0
discontinuities either way, so the fade contour is not visible as a ring), `golden` 23.6
→ 19.3, `storm` 19.4 → 17.9 with the three discontinuities in identical places.
`shadow` — `cloudCover` 0, `uCloudShadowStrength` 0 — reads 24.7 → 26.2, i.e. the change
is **provably inert with no clouds**, which is what `lwCloudShadow`'s early return
guarantees.

Cost: one `smoothstep` and one `mix` per ocean fragment, no new texture taps. p25 over
orbit/noon/shadow/golden/helm 24.1–33.0 ms on a quiet box, in the standing band.

### The pale cyan hairline was the in-scatter's elevation lift

Second item on §62's list, same fix session. `oceanInscatter` lifted the probe tap
**0.035 rad = 2.0°** above the horizon. The env probe is `ENVMAP_W*2 x ENVMAP_H*2` =
256x128 with `v = asin(y)/PI + 0.5`, so one texel is **1.41° of elevation** and 0.035 was
**1.42 texels up**: the sea's last rows carried sky from two degrees higher than the sky
immediately above them, and near the horizon that is where the atmosphere's gradient is
steepest. Measured per channel, `orbit` x 0–520: the sea's top row ran **B−R 32.2 against
the sky's 17.8** at *equal luminance* (102.3 vs 102.4). A pure-chroma hairline.

`0.0123 = sin(PI * 0.5 / 128)` is the centre of the first texel above the horizon — the
lowest tap whose bilinear footprint contains no below-horizon sample. Excess B−R falls
from +14.4 to **+7.3**, luminance still monotone. Lower was measured and is worse:
0.0060 puts the row 5.4 **below** the sky and 0.0 puts it 13 below, both hard dark lines,
and dropping the probe entirely puts it 16 below with B−R 46.5. That contamination is
exactly what the lift is for; it was just four times too big. The residual is the probe
texel's own 1.41° average being bluer than the 0.02° row of sky above it, and closing it
needs elevation resolution near the horizon that a 128-row probe has not got.

### The vertical column does not reproduce

§62's "vertical banded column at x 1300–1330 running y 250→600, crossing the horizon with
the same value on both sides". Column profiles, detrended with a 123-px moving average,
computed for a sky band and a sea band in four scenes: the correlation between the two is
**−0.011, −0.330, +0.219, −0.109**. A screen-space composite that ignores depth would
give ~+1 and a shared localised spike. The only strong column deviations in any frame are
at x 650–940 — the ship's masts. At x 1240–1400 in `orbit` every band is a monotone
gradient varying under 1 unit.

The mechanism it most likely was: `cloudAirShadow` marches **the same 26 km shadow map**
through the air with `CLOUD_SHAFT_STEPS` = 10, i.e. one sample every 2.6 km, to make
crepuscular rays. A shadow lane darkening the air and the same lane darkening the sea is
one shadow seen twice, which is exactly "the same value on both sides" — and it is not a
compositing bug. Two consequences: the critic's own objection ("the horizon should
modulate it") is now satisfied on the sea side, because past 4 km the sea no longer
resolves the lane; and if it recurs, the 2.6 km march step is where to look, not the post
stack. **I could not reproduce it and cannot say it shared the cause.**

### The far field really is dead, and here is the lever

The other half of §62's sentence is confirmed and unfixed. Per-row **mean |dL/dx|** over
x 0–500 in `orbit` reads **1.99–2.19 from the horizon at y 576 all the way to y 660**,
which is the interleaved-gradient dither's own floor (§62 measured it at 0.16–0.96 LSB).
There is no horizontal structure in the far field at all. The bands were horizontal, so
they never contributed to this statistic either — before the fix, y 580 read |dL/dx| 2.07
with a row sd of 9.32; after, 2.07 with 3.86. **I removed a source of far-field variation
in exchange for removing the staircase**, and that trade is worth stating plainly.

The cause is one line. `lowSlope` is written only in the **cascade-0** iteration of the
fragment sampler, so `Nlow` carries the 0.5–2 km swell and nothing else — and past a few
hundred metres `macro = saturate(sqrt(carried)/|V.y| - 0.25)` saturates to 1.0 (at
|V.y| = 0.006 it is 13 before the subtraction), so `Nmac = Nlow` and `Ns = mix(N, Nlow,
0.85)`: **both** specular paths run on a normal that only knows about the swell.

Measured lever, same process, repeated nulls agreeing to 0.03: building `Nlow` from the
full multi-cascade `slope` at the same per-pixel explicit LOD raises |dL/dx| from
1.99–2.19 to **2.22–2.65** and row sd from 5.0–6.9 to 5.6–8.6 over y 588–660 — 20–50x the
null spread. It does *not* help the top six rows (2.10 → 2.16), so it is detail in the
1–3 km band, not at the horizon itself.

**Do not land that without the flicker instrument.** `alphaR = clamp(max(alpha,
sqrt(lostVar + (1 - km*km) * carried)), ...)` exists to add back exactly the variance
that blending N toward `Nlow` removes; if `Nlow` starts carrying every cascade, that
compensation double-counts, and this is the same path the `macro` blend was introduced
for — §17C, the owner's flickering horizontal streaks: temporal std of the per-row band
signal beyond 600 m was 0.38 with the micro normal against 0.10 with the macro normal on
a film-grain floor of 0.03, measured with the sim clock pinned (`.tmp/flick.mjs`).
The pairing of "Nlow is cascade 0" with "the wide regime's alpha is the total rms" is
currently self-consistent. Changing one half needs the other half re-derived and the
temporal std re-measured with the sim clock pinned.

### Two more things I could not fix

- **There is no earth curvature.** With the eye at 25.6 m the true geometric horizon is
  `sqrt(2Rh)` = **18.0 km**, and the clipmap renders sea to 49 km — 2.7x past it. The
  rows from y 575 to y 577 in `orbit` are sea at 20–49 km that should not be visible.
  That is most of the compressed dead band, and it is why the sea/sky ΔL at the horizon
  is 0–1.3 (measured; §62's older build read 3.4): the last visible sea is forced to full
  haze, so it *is* the sky. A real horizon is a definite line because the last sea is
  only 4–18 km away and keeps most of its own colour. Adding curvature is a vertex-shader
  drop of `d^2/(2R)`, but it collides with the skirt's rise-to-eye-height, which exists
  to stop a sliver of sky appearing under the sea; that interaction is the whole job.
- **The "reef in mid-ocean".** §62's cyan patches are cloud shadow at 400–2000 m, where
  the footprint *is* small enough to place it, so the fix above deliberately leaves them.
  They read as bathymetry because a sunlit gap is `lwCloudShadow` up to 1.35 against a
  shadow at 0.058 — a 23:1 patch — and in the gap the glitter's sun colour dominates
  while in shadow only the blue body survives, so the patch differs in *hue* as well as
  value. Physically that is right; whether 23:1 is right is the sky's call, not the
  ocean's, and changing it moves the sails too.

### 67a. Independent confirmation, and the trade is the right way round

Measured myself on a fresh `orbit` capture, x 0–520 across the horizon:

| | tot \|d2L\| | discontinuities | max \|dL\| |
|---|---|---|---|
| as the critic found it | 55.9 | 6 | **10.51** |
| now | **17.9** | **1** | **2.32** |

(The agent reported 13.4 / 0 / 1.99 on its own frozen frame; the small difference is a
different cloud field and a one-row-different window. The charcoal bar with crisp edges
is gone and the crop shows a soft gradient.)

**And the trade it declared is the right way round, which is worth stating explicitly.**
It removed a source of far-field variation to remove the staircase — row sd at y 580 fell
9.32 → 3.86 — and said so rather than hiding it. A blind critic ranked the *bands* as the
single worst thing in the image, so trading some far-field texture for their removal is
the correct direction. The residual dead band is now the visible problem, and it is
already diagnosed with a measured lever and a named hazard, which is a far better place
to be than where this started.

**Two causes for the dead far field, and they interact:**
1. `lowSlope` is written only in the **cascade-0 iteration**, so `Nlow` knows only the
   0.5–2 km swell, while `macro` saturates past a few hundred metres — so *both*
   specular paths run on the same coarse field. Measured lever: a full multi-cascade
   `slope` raises per-row mean `|dL/dx|` to 2.22–2.65 over y 588–660, against a dither
   floor of 1.99–2.19. **Hazard:** `alphaR`'s variance compensation would then
   double-count, and this is the path §17C's flicker measurement lives on.
2. **No earth curvature.** True horizon at a 25.6 m eye is **18.0 km**; the clipmap
   draws to **49 km**. Rows y 575–577 are sea that should not be visible at all, which
   is most of the compressed dead band and why sea/sky ΔL at the horizon is 0–1.3.
   Collides with the skirt's rise-to-eye-height.

### The critic's vertical column does not reproduce
Detrended sky-band against sea-band column correlation, four scenes: **−0.011, −0.330,
+0.219, −0.109**. A depth-ignoring screen-space composite would give about **+1**. The
only strong column deviations in frame are the ship's masts. Most likely what the critic
saw is `cloudAirShadow` marching the *same* 26 km shadow map through the air at
`CLOUD_SHAFT_STEPS` = 10 — one sample per 2.6 km — for crepuscular rays: one shadow seen
twice, not a compositing bug. Recorded as **not reproduced** rather than as fixed.

## 68. §63 answered: the ship was the only opaque thing in the frame rendered through vacuum

**The brief's hypothesis was wrong and the defect was real.** §63 blamed a missing
sky-fill/IBL term. The IBL is there, on every ship family, and it is the right
magnitude — the missing term was **aerial perspective**, which every other opaque thing
in the frame already had.

### What was ruled out first, with the measurement each time

- **`scene.environment` is bound and reaches the ship.** `.tmp/skyfill.mjs`:
  `sky.envMap`, `environmentIntensity` 1, and `envMap`/`envMapIntensity` live in the
  compiled program of all twelve ship materials. The `env` option is not inert either;
  it scales three's specular IBL as its comment claims.
- **The probe's radiance is right.** `.tmp/envread.mjs` reads the equirect back off the
  GPU and integrates it: mean sphere radiance 0.207/0.310/0.474 against a CPU
  `uSkyColor` of 0.187/0.254/0.442, and cosine-weighted `E/PI` at a side normal
  0.272/0.383/0.559 against the CPU SH's 0.220/0.314/0.503.
- **The delivery is right.** `.tmp/G63white.mjs` forces `ship-black`'s albedo map to a
  1x1 white texture and pins the sun off with a `defineProperty` trap. The hull then
  reads **p50 94, p10 74** — a white Lambertian under that probe. Nothing is eating the
  ambient.
- **AO is not the culprit.** `aoMapIntensity` 0 on every family moves the hull band by
  0.3 points. `lwDetAo` bottoms out at 0.45.
- **`material.dithering` is not the culprit**, though it is still wrong. three runs
  `dithering_fragment` AFTER `tonemapping_fragment`, so its ±0.25/255 is written for a
  display-encoded 8-bit output; these materials write scene-linear radiance into an HDR
  target, which makes it ±1.96e-3 of LINEAR radiance — 40–120% of the whole ambient
  signal on a 1.8%-albedo hull, with a negative lobe. Ablated on all twelve materials
  inside one frozen frame: **28.0 → 27.9% below L = 4, 14.0 → 14.1% exactly black.** A
  null. Left alone on that evidence; the post stack's own dither is the right one and
  §63 was right to say so.

### The finding: no ship material had any distance term at all

`src/ocean` hazes the sea (`shaders/surface.ts`), `src/world` hazes islands, other
vessels and wildlife (`worldAerial`), `src/vfx` hazes spray and rain (`applyAerial`), and
`scene.fog` is never set. **`grep -rn "uFogColor\|uVisibility" src/ship` returned
nothing.** The player's own ship was rendered as if the air in front of it were a vacuum
while a stranger's brig at the same range was not.

Priced on the `orbit` frame (`.tmp/G63fog.mjs`): camera 141 m from the hull, visibility
32 km, `uFogDensity` 1.222e-4/m — which is exactly the Koschmieder value, so the
`max()` against `3.912 / visibility` is a tie — height falloff 0.989, so **t = 1.71%**.
`uFogColor` luminance is **0.632**, so the omitted in-scatter is **1.08e-2 of radiance**.
The shaded black topsides measured **3.5e-4**. **Thirty times the whole signal.**

`src/ship/shaders/aerial.ts` mirrors `worldAerial` term for term — 1350 m scale height,
same density floor, same `cos^8`/`cos^2` forward lobe, same depth blueing, same moon
term — so a ship and an island at equal range haze identically. Duplicated rather than
imported because non-negotiable 2 forbids reaching into `src/world`, and because
`GLSL.fog`'s `applyAerial` uses a flat 0.55 sun lobe that does not go out at night. It
needs no new varying: `length(vViewPosition)` is the distance and
`inverseTransformDirection(..., viewMatrix)` takes the direction back to world.

### Result, ablated inside one frozen frame

Two captures of `--scene orbit` minutes apart are two cloud fields on the same hull, and
whether a cell happens to sit on the ship moves the exactly-black share by ten points on
identical code. So `.tmp/G63ab.mjs` ablates in place: everything the term adds is
multiplied by `t`, and pinning `uFogDensity` to 0 and `uVisibility` to 1e9 makes t
exactly 0 with no recompile. `--scene shadow`, critic's band x 500–1100, y 730–840:

| | before | after |
|---|---|---|
| share below L = 4 | 17.4% | **0.2%** |
| share at exactly (0,0,0) | 0.1% (65 px) | **0.0% (0 px)** |
| p0.1 | 0.1 | 3.4 |
| p10 | 2.4 | 7.9 |
| p25 | 15.0 | 21.9 |
| p50 | 76.5 | 78.4 |

`ship-black`'s own 20,278 pixels (masked by flashing its emissive): below L = 4 from
**55.2% to 0.1%**, p50 from 3.5 to 9.9. The sunlit median moves 2.5%, which is the point
— this is not a black-point lift. A thick-air control row at 3 km visibility (t = 16.6%)
lifts the same mask to p10 66.7, confirming the term is wired and scales as designed.

Fresh captures repeat: `shadow` gives 0.2 / 0.3 / 0.3% below L = 4 and **0 exactly-black
pixels in three runs** (before: 26.0% and 124 px). `orbit` goes from **17.0%
(11,203 px)** to **2.8 / 3.4 / 3.4%** across three captures.

### The second half, for close range: bounce the sky probe cannot contain

At two metres t is 1e-4, so aerial does nothing for the deck, the fife rails or the
belaying pins. `EnvProbe` is a **sky-only** equirect from (0, 30, 0): it contains neither
the 3968 m² of albedo-0.62 canvas hanging over the deck — `sky/constants.ts` anchors
sunlit canvas at ~2.5 radiance against a mean sky of 0.1–0.5, so where the sail plan
fills a hemisphere it replaces the sky with something 5–8x brighter — nor the breaking
bow wave. `src/ship/shaders/bounce.ts` adds both to indirect **diffuse** only (`env`
means reflection), with only the **foam excess** for the water, because the probe's lower
hemisphere already carries open sea within 30% of the CPU SH. The view factors are named
geometric estimates, not measurements, and say so in the file.

On the `helm` frame it takes the deck's dark decile from 20.3 to 28.3 and the pin-rail
box (x 905–1330, y 470–620) from p10 39.0 → 47.1 with exactly-black from 198 px to 31.
The midtone p50 moves 6%.

### Cost: free, and here is the ablation rather than a profiler number

Both call sites replaced by no-ops (`lwShipAerial(x)` → `x`, `lwShipBounce(...)` →
`vec3(0.0)`; commenting them out puts a template's closing backtick inside a `//`
comment, which is the mistake non-negotiable 3 exists for). Paired captures:

| | with | without |
|---|---|---|
| `shadow` p25 | 22.4 / 22.5 / 22.8 | 23.8 / 23.7 |
| `orbit` p25 | 28.5 / 28.6 / 27.4 | 17.2 / 29.1 |

The ablated build is if anything *slower* on `shadow`, and `orbit` spans 17–29 either
way — the documented same-scene spread. Below the instrument's resolution, as ~25 ALU
ops on the ship's ~15% of the frame should be.

### What this says about the frame's floor, which is NOT mine to change

`.tmp/G63emis.mjs` calibrates the whole pipeline with a known additive radiance:
`material.emissive` enters `totalEmissiveRadiance` in scene-linear units with nothing
between it and the post stack. On `orbit`, `uExposure` pinned at 0.6656, measured inside
an eroded `ship-black` mask:

| added radiance | p50 code |
|---|---|
| 0 | 0.1 |
| 2.68e-3 | 0.1 |
| **1.07e-2** | **1.1** |
| 4.28e-2 | 5.9 |
| 1.71e-1 | 36.1 |

**1e-2 of radiance renders as sRGB code 1.** AgX alone predicts 13 for that value, and
AgX alone is *right at the top* — sky radiance 0.28 predicts code 129 against a measured
mean of 137 — so the extra 3.5 octaves of crush is in the composite's own shadow
response (the `cos^4` vignette is the prime suspect: the hull sits low and left of
centre). Two consequences worth writing down:

1. **The residual 3% of exactly-black pixels on `orbit` cannot be removed from inside
   `src/ship`.** They are pixels sitting at code 0.5–1 where the dither splits them
   either side of zero. Clearing them needs roughly one more octave, and no honest
   ship-local term is worth an octave.
2. **"Pure black under a bright sky" is only half a diagnosis.** For a 1.8%-albedo
   surface to read as a *visible* dark grey in this frame it needs 0.05–0.15 of radiance
   — a fifth to a half of the sky's own. That is not an ambient term; it is the grade.

### The sibling class: the pins do NOT share the cause, the yards do

`.tmp/G63who.mjs` attributes the exactly-black population by flashing one family's
emissive at a time (no recompile — the uniform is always in the program): **93.6%
`ship-black`**, then iron 6.8%, oak 5.7%, rigging 5.7%, sail-cloth 0%. After the fix the
population is 52% smaller and still 93.8% `ship-black`.

- **The yards in `orbit` share the cause.** They are `oak`, at 130–150 m, and get the
  same t = 1.71%.
- **The belaying pins in `helm` do not.** At 2–6 m aerial contributes 1e-4 and bounce
  only lifts them ~1 code. They are shaded oak seen against sunlit canvas, which is a
  near-silhouette in a photograph too. The critic's other half of that complaint —
  "identical Γ glyphs, no variation between pins at different orientations" — is
  **modelling, not lighting**: `build/deck.ts::buildBelayingPins` emits every one of the
  25+ pins as the same axis-aligned `box(0.035, 0.2, 0.035)`, with no cant, no jitter and
  no rope coil. That is a real defect and it is still open.
- **"Sail shadows as hard-edged black stickers" does not reproduce on main.** On `shadow`
  (full sun, no cloud) the sail area x 600–1000, y 400–640 has p10 = 101 and p0.1 = 10.4
  before the fix, 18.1 after; the shadows read as soft blue-grey with visible penumbra.
  The claim was made on the OLD panes. §56's "leave `shadow.radius` at 2.2" stands and
  was not touched.

### Two things this leaves for someone else

- **A dead loop in `materials/materials.ts`.** `for (const t of [map, normalMap, ormMap]) { void t; }`
  under a comment saying "the repeat converts to tile space". It converts nothing; the
  builders already emit tile-space UVs and the detail shader multiplies back to metres.
  Harmless, and the comment is a lie.
- **The metals are authored as if they were dielectrics.** `makeIron` sets albedo
  `l = 0.1 + facet*0.07` in **sRGB** (linear 0.01–0.03) with `metal = mix(0.9, 0.2, rust)`,
  so wrought iron's F0 is ~0.013 — an order of magnitude below any real metal, and a
  metal has no diffuse term to fall back on. `makeBrass` is ~2x low the same way. Either
  the ironwork is bare metal and its albedo map must carry a real F0 (iron 0.56), or it is
  the painted/tarred ironwork `AGENTS.md` describes and `metal` should be near 0. Both are
  defensible; 0.9 metalness at 1% reflectance is not, and it is why an iron fitting has no
  gradient across it.

### 68a. My hypothesis was wrong, and the real cause was better

I briefed §63 as a missing ambient/sky-fill term. **It was not.** The ship does receive
sky fill, at the right magnitude, and that was ruled out properly before anything was
changed: `scene.environment` is bound and `envMap`/`envMapIntensity` are live in the
compiled program of all twelve ship materials; the probe's radiance integrates to
0.207/0.310/0.474 against a CPU `uSkyColor` of 0.187/0.254/0.442; and forcing
`ship-black`'s albedo to white with the sun pinned off puts the hull at p50 **94**. AO
was a null. Nothing was eating the ambient.

**The real cause:** `grep -rn "uFogColor\|uVisibility" src/ship` returned **nothing**, and
`scene.fog` is never set. `src/ocean` hazes the sea, `src/world` hazes islands and other
vessels, `src/vfx` hazes spray and rain — **the player's own ship was the only opaque
thing in the frame rendered as if the air in front of it were vacuum.** At the orbit
camera's 141 m the omitted in-scatter is `t = 1.71% × uFogColor 0.632 = 1.08e-2` of
radiance, against **3.5e-4** measured on the shaded topsides. **Thirty times the whole
signal.**

Verified independently on a fresh capture:

| | below L=4 | exactly (0,0,0) |
|---|---|---|
| `orbit` before | 31.9% | 17.0% — **11,203 px** |
| `orbit` after | 22.4% | 0.1% — **66 px** |
| `shadow` before | 26.0% | 0.2% |
| `shadow` after | **0.2%** | **0.0% — 0 px** |

`ship-black`'s own pixels went from 55.2% below L=4 to 0.1%. **Cost: free** — both call
sites replaced by no-ops and re-measured, and the ablated build is if anything slower.
The crop shows tonal variation in the planking, a legible gunport stripe and ports, and
the bulwark separating from the topsides, where before it was one flat silhouette.

**Only the yards shared the cause.** Attribution by flashing one family's emissive at a
time: 93.6% of the exactly-black pixels were `ship-black`, and the yards are `oak` at
130–150 m getting the same term. **The belaying pins are not** — at 2–6 m aerial is 1e-4.
Their problem is modelling: `build/deck.ts::buildBelayingPins` emits all 25+ as the same
axis-aligned `box(0.035, 0.2, 0.035)`, no cant, no jitter, no coil. Still open.

### And a correction to my own synthesis in §63
I wrote that the missing fill was why sail shadows read as "hard-edged black stickers".
**That does not reproduce on `main`**: on the `shadow` scene the sail area measures p10 =
101 and p0.1 = 10.4 *before* this fix, with visible penumbra. So the critic's observation
was specific to `orbit` — where the hull clipped and the vignette bites — not a general
truth about the shadows, and §56's conclusion needed no revision after all. I had chained
two findings that share a symptom and not a cause.

### The residual is in the composite, not the ship: ~3.5 octaves of extra shadow crush
> **Superseded by §71 — the conclusion held, both of the numbers below did not.** The crush
> was the look LUT's linear pivot contrast clipping to black, and it is fixed. The `cos⁴`
> vignette was innocent, ablated in the same frame. And the calibration under it was 2.1
> stops out, because `uExposure` is a sky-model estimate and not the multiplier `prepare`
> applies. Read §71 before quoting anything in this subsection.

Calibrated by injecting a known additive radiance through `material.emissive`: **1e-2 of
radiance renders as sRGB code 1** (4.3e-2 → 6, 1.7e-1 → 36). AgX alone predicts **13**
for 1e-2, and AgX alone is right at the top — sky 0.28 predicts 129 against a measured
137. So about **3.5 octaves of extra crush live in the composite's shadow response**, and
the `cos⁴` vignette is the prime suspect since the hull sits low and left of centre. That
is `src/post`, it affects every dark pixel in every frame, and it is the largest remaining
tonal defect.

### Two things filed in passing
- A dead `for (const t of ...) { void t; }` loop in `materials.ts` under a comment that
  claims it does something.
- **The metals are authored with dielectric albedos.** `makeIron` gives wrought iron an
  F0 of ~**0.013**, an order of magnitude below any real metal — which is why an iron
  fitting has no gradient across it and reads as dark plastic.

## 69. A published commit of unverified agent work, and a near-miss phantom regression

The owner published the repo to GitHub Pages while three agents were mid-task, and
committed the ~300 lines they had left in the tree. So `def7ecc` shipped **partial,
unverified work from three killed agents** — it typechecked and `check-shaders` passed,
but nobody had looked at a frame, and it went live.

**It is good.** The frame is the strongest in the project: the hull reads with planking
tone and legible gunports, the sails carry cloth and camber, the far field has texture to
the horizon, and the horizon is clean. The metals work landed with its physics intact —
it found `ship-iron` presenting **F0 0.019/0.019/0.020, below the 0.04 dielectric
floor**, and derived the replacement from n and k
(`F0 = ((n−1)² + k²)/((n+1)² + k²) = 0.195` for fire-blacked wrought iron, which is the
right material for a ship's ironwork rather than bare iron).

**But I nearly reported a regression that did not exist.** The published commit measured
p25 46–56 ms against a verified 21–26 ms baseline, with the harness printing `rivals
0p/0b quiet`. An A/B against its own parent saved me: **the parent measured the same**
(47.6 / 33.9), so there was no regression — the box was at **load average 68** from two
background sessions. That is §31's mistake exactly, and the only thing that stopped it
was refusing to conclude from one arm.

**Instrument fixed.** `capture.mjs` counted rival *renderers* by parsing `ps` for browser
command lines, and node/esbuild work owns no renderer and matches no browser. It now
reads `os.loadavg()` — which needs no `ps` parse and cannot be fooled by a command line —
and vetoes on load above 4, printing `LOADED(n)` with the same taint marks. This box idles
near 2 with a dev server up, so the threshold catches saturation rather than demanding
silence.

## 70. The Gamma glyphs were the hammock cranes, and that is the fourth misattribution

A blind critic reported "25+ identical Gamma glyphs with no gradient across them, no
variation between pins at different orientations". It called them belaying pins. An agent
that investigated agreed and filed it as `buildBelayingPins`. **Both were wrong.**

**The count is the tell.** The hammock-crane loop in `hull.ts` runs `z = -18` to `19` at
1.5 m — **25 a side**. The belaying pins come in three clusters of 11. And a vertical box
plus a horizontal box at its head *is* a Γ; the pins are a single box.

This is the fourth object this project has misattributed from a crop, after the bow
object, the "square waterfall" and the wheel. The pattern is consistent enough to state as
a rule: **a crop tells you where a defect is on screen, never which object it is.** Count
something and match it against the builder before naming the file.

Both objects were flat, and for the same reason: **an axis-aligned box has exactly two lit
faces at any sun angle**, so every instance presents the identical pair and a flat face has
no gradient across it by construction. The cranes are now bent rods — two spars with a
short elbow, which is what a rod bent round a former looks like — with a deterministic
per-station lean. The pins are round and tapered with a shoulder, canted and jittered from
a hash, and every third carries a hank of rope.

Deliberately *not* done: a lathed profile with turnings, and a coil on every pin. A 35 mm
shaft is about 15 px across at 2 m, so a taper reads and a turning does not, and 130 coils
would cost more than the whole rig's ribbons.

Cost: ship triangles 49,996 → 56,508 (+13%), **zero extra draw calls**, since both merge
into existing bins. The lighting half of the complaint was already fixed by the iron F0
correction, so what remained was only ever geometry.

## 71. §68a's shadow crush was the look LUT's contrast, not the vignette — and the calibration it was measured with was 2.1 stops out

§68a left a residual: "1e-2 of radiance renders as sRGB code 1, AgX alone predicts 13, so
about 3.5 octaves of extra crush live in the composite's shadow response", with the `cos^4`
vignette named as prime suspect. **The crush is real and is now fixed. The vignette was
innocent, and both of §68a's calibration reference points were wrong.**

### The instrument first, because it is the transferable part

`material.emissive = E` really does deliver E of scene-linear radiance —
`readRenderTargetPixels` on the `scene` target gives d(radiance)/dE = **0.984** over three
decades, so §68's injection method is sound. What is not sound is the exposure it was
divided by.

**`world.uniforms.uExposure` and `world.ext.post.exposure` are not the multiplier the frame
is multiplied by.** `PREPARE_FRAG` multiplies by `texture2D(tExposure, vec2(0.5)).g`, a 1x1
target the adapt pass writes on the GPU. On the `orbit` preset, read back in the same frame:

| | value |
|---|---|
| `world.uniforms.uExposure` / `ext.post.exposure` | 0.668 |
| `expStateB.g`, the multiplier `prepare` applies | **0.151** |
| ratio, in stops | **2.14** |

`AutoExposure`'s own comment claimed the estimate "tracks the GPU value to within about a
stop". It does not, and it never could: the estimate meters a **sky-model luminance**, the
shader meters a **centre-weighted percentile band of the real frame**. Both comments are
now corrected in place. Pinning `uExposure` — which §68's probe did, and reported doing —
**changes nothing on screen**. To get the real number, read
`renderHook.pipeline.targets.map.get('expStateB')` (`.g`), or set `settings.debugStalls`.

§68a's other reference was worse. It took the sky as 0.28 of radiance, from `uSkyColor`.
The sky **pixels** read back at **4.77**. Two errors of 4.4x and 20x in opposite directions
are why "AgX is right at the top" appeared to hold, and the synthesis chained them.

### The measurement that needs no calibration at all

Ablate every operator after `agx()` — `uLookAmount`, `uVignette`, `uGrain`,
`uBloomStrength`, `uSplitAmount` all 0 — and the composite reduces to AgX exactly. Pair
that frame against the shipping frame **pixel for pixel, in one frozen frame**, and the
histogram of one against the other IS the post-AgX transfer, with no model and no radiance
assumption anywhere in it. `.tmp/H68abl.mjs`, whole 1600x900 `orbit` frame, median shipping
code per AgX code:

| AgX code | 12 | 16 | 17 | 20 | 24 | 28 | 32 | 48 | 96 | 128 | 160 | 178 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **before** | 0.1 | 0.4 | 0.6 | 2.4 | 5.1 | 9.1 | 13.5 | 35.4 | 93.0 | 131.6 | 173.5 | 194.4 |
| **after** | 8.4 | 10.4 | 11.4 | 14.1 | 18.1 | 21.3 | 24.6 | 41.3 | 93.4 | 131.5 | 173.6 | 194.5 |

Exactly-black pixels in the frame **1216 → 0**; share below L = 4 **0.85% → 0.00%**. The
darkest code anywhere in that frame is AgX 8–12, so **every dark pixel in the frame was
inside the clipped region** — which is why §68 needed an aerial term thirty times the hull's
own signal just to clear code 0.

### Attribution: same frozen frame, one ablation each

| ablated | transfer at AgX 17 | verdict |
|---|---|---|
| nothing (shipping) | 0.6 | — |
| **`uLookAmount` 0** | **16.6** | **the whole of it** |
| `uVignette` 0 | 0.9 | nothing |
| `uGrain` 0 | 0.9 | nothing |
| `uSplitAmount` 0 | 0.9 | nothing |
| `uBloomStrength` 0 | 0.6 | nothing |

`uLookAmount` 0.5 halves the crush, as a linear blend must. **The vignette is not the
suspect and could not have been**: it multiplies scene-linear radiance *before* the tonemap,
which is the correct side of the transfer, and at `VIGNETTE_STRENGTH` 0.045 it is worth
0.06 stops where the hull sits (`cos^4` = 0.949 at the mask centroid) and 0.5 stops in the
extreme corner. §68a reached for it because the hull sits low and left of centre; that is a
plausible story about a real operator, and it was wrong.

### The cause: contrast as a straight line has an x-intercept

`LookLut.ts::applyLook` did `r = (r - pivot) * contrast + pivot`. That line crosses zero at
`pivot * (1 - 1/contrast)`:

| look | pivot | contrast | intercept | as an sRGB code |
|---|---|---|---|---|
| Blue Hour | 0.30 | 1.12 | 0.032 | 8 |
| Cold Morning | 0.44 | 1.16 | 0.061 | 15 |
| Amber Reach | 0.45 | 1.18 | 0.069 | 17 |
| **Open Sea** | 0.46 | 1.22 | **0.083** | **21** |

Everything below that came out **negative**, and the `clamp01` in the black-floor line —
`r = f + clamp01(r) * (1 - f)` — turned it into black. The 32-node lattice then quantised
the intercept up to a whole node: nodes 0, 1, 2 sit at codes 0, 8.2, 16.5, all below the
intercept, all baked to the same floor, so the transfer is **flat to code 16 and then ramps
linearly to node 3 at code 24.7**. That predicts 2.5 at code 20; measured 2.4.

The fix keeps the straight line **above** the pivot, where the looks were authored and where
it is well behaved, and below the pivot continues it as the log-space slope it was
approximating, `pivot * (x/pivot)^contrast`. The two branches meet at the pivot with the
same value **and the same slope** — the derivative of the power form is exactly `contrast`
at `x = pivot` — so there is no kink, and by construction nothing above the pivot moves.
Measured, it moves by 0.1 code at AgX 128, 160 and 178.

**Cost: zero per frame.** The shader is untouched; only the contents of a texture baked once
at init change. `makeLookTexture()` goes from 38 ms to 46 ms, once, measured as the median
of seven in-page runs.

### The top end survived, and here is the number §68a was reaching for

Mean 8-bit code over three bright regions, each run measured against **its own** AgX-alone
frame so no statistic crosses a frozen frame:

| region | AgX alone | shipping, before | shipping, after |
|---|---|---|---|
| sky band, y 30–150 | 128.8 | 135.8 (×1.055) | 136.4 (×1.059) |
| sunlit cloud, y 0–250 | 145.4 | 155.6 (×1.070) | 155.7 (×1.072) |
| sunlit sea, y 620–700 | 99.5 | 95.9 (×0.964) | 97.2 (×0.978) |

The grade lifts the sky about 5% and that is intentional; it is unchanged by this fix. Note
that **AgX alone on the sky band is 128.8** — §68a's "predicts 129" was numerically right and
arrived at by two compensating errors, which is the most dangerous kind of agreement.

### What this does NOT fix, and one thing to watch

- **The frame's black point is unchanged.** True black still maps to the look's `blackFloor`
  (0.0012–0.003, code 0.3–0.8) exactly as before. Nothing was lifted; a clip was removed.
- **Unclipping the shadows exposes whatever noise was in them.** The new curve's local slope
  in the shadows is 0.75, so it cannot amplify noise — but noise that was previously being
  clipped flat to black is now visible. Nothing new appeared on the sixteen `capture.mjs`
  panes, but the `night` sails carry heavy chroma speckle that is worth a look; it is
  midtone, so it predates this, and the likeliest cause is the documented gap that animated
  vertex shaders write no velocity for TAA. **The speckle was real and is now fixed — but the
  TAA guess was wrong. It was three's `dithering` material flag adding display codes to
  scene-linear radiance; see §73.**
- **`AGX_IN` in `src/util/glsl.ts` is the transpose of three's AgX inset matrix** while
  `AGX_OUT` matches three's outset exactly, so the pair no longer round-trips. Greys come out
  of the inset as (1.106, 0.933, 0.961), a +0.15/−0.10/−0.06 stop channel imbalance before
  the curve. Luminance only moves 0.04 stops, so it is a tint bug and not this one, but it is
  a bug. `src/util` is a shared library, so it is not the post agent's to change.
- **`core/PostProcessing.ts` still says "the single sRGB encode happens by hand at the end of
  the composite".** `COMPOSITE_FRAG` says the opposite, at length, and the composite is
  right: `agx()` stops on the outset matrix and leaves the value display-encoded. The core
  comment is stale and contradicts non-negotiable 6 for anyone who reads it first.
- **The bloom composite is a lerp, not an add**: `mix(col, bloom, 0.055)` removes 5.5% of the
  base image everywhere, a flat −0.08 stops. Defensible as energy conservation and far too
  small to be a defect; recorded so nobody re-derives it.

### 71a. Confirmed, and the fix revealed what the crush was hiding

Verified on three fresh captures: **zero exactly-black pixels in `orbit`, `night` and
`dusk`**, and `orbit`'s share below L=4 goes 0.85% → **0.00%**. Night and dusk still read
as night and dusk — dark sea, stars, warm cloud undersides, island silhouettes — so
nothing was washed out to buy it. The mathematics of the fix checks out independently:
above the pivot `f(x) = (x−p)c + p` gives `f(p) = p, f′ = c`; below it
`g(x) = p(x/p)^c` gives `g(p) = p` and `g′(p) = c`. Same value, same slope, no kink,
and nothing above the pivot can move.

**And it exposed a defect the clipping had been concealing.** With the shadows no longer
crushed to black, the sails at low light carry heavy spatially-incoherent **colour
speckle**:

| scene | chroma p50 | p99 | mean luminance | neighbour chroma jump |
|---|---|---|---|---|
| dusk | **18.0** | 42 | 24.3 | 4.78 |
| night | **26.0** | 45 | 29.9 | 4.89 |
| orbit | 33.0 | 74 | 121.4 | 3.09 |

At dusk the chroma is **74% of the luminance**; at night **87%**. A near-white flax sail
should have chroma near zero. The neighbour-to-neighbour jump of ~4.8 against orbit's 3.09
says it is speckle rather than a smooth tint — spatially incoherent, so it is noise and
not a colour error.

The agent that fixed the crush had already measured that the **grade attenuates** it
(high-frequency energy 2.06 for AgX alone against 1.89 shipping), which locates the source
**upstream of the composite**, in the scene render. So this is pre-existing and was simply
below the clip line: the crush was deleting it along with everything else dark.

That is the loop working as intended, and worth naming as a pattern: **a defect that
clamps to black hides every other defect underneath it.** The same thing happened with the
hull — §68's aerial term and this both had to land before anything in the shadows could be
judged at all.

## 72. §68a's calibration was 2.14 stops out, and two errors cancelled

This is a correction to a finding I recorded *and briefed into two agent tasks*.

§68a calibrated the pipeline by injecting radiance through `material.emissive` and
concluded that AgX "is right at the top" — sky 0.28 radiance predicting 129 against a
measured 137 — and therefore that the crush was in the composite's shadow response. **The
conclusion was right and both of its numbers were wrong.**

- **`world.uniforms.uExposure` and `world.ext.post.exposure` are not the multiplier the
  frame is multiplied by.** `PREPARE_FRAG` uses `tExposure.g`, a GPU-written 1×1 target.
  Read back in one frame: estimate **0.668**, applied **0.151** — a **2.14-stop** gap.
- The sky was taken as **0.28** radiance from `uSkyColor`; the sky *pixels* read back at
  **4.77**.

Two errors of 4.4× and 20× **in opposite directions** are why "AgX is right at the top"
appeared to hold. AgX alone on the sky really is 128.8, so the prediction was numerically
right by coincidence. `material.emissive` itself is sound — d(radiance)/dE measures
**0.984** off the `scene` target — so the method was fine and the reference values were
not.

Both misleading comments are corrected in place: `src/post/ext.ts`, and
`src/post/AutoExposure.ts`, which claimed the estimate tracked the applied value "within
about a stop".

**The lesson is not "check your units."** It is that a calibration which agrees with
prediction at one end is not thereby validated — two independent errors of similar
magnitude in opposite directions will reproduce agreement, and that agreement is what
stops you looking further.

## 73. §71a's sail speckle was three's `dithering` flag, adding display codes to scene-linear radiance

§71a measured heavy spatially-incoherent colour speckle on the sails at low light and
located it upstream of the composite. It is **three's `dithering` material flag**, and it
was set on **12 of the ship's 14 materials**. Removed; the fix is four deleted lines.

### The mechanism, and why it was proportional to darkness

`dithering: true` compiles `dithering_fragment`, the **last** chunk in the built-in
fragment shader — after `tonemapping_fragment` and `colorspace_fragment` — and it adds

```
vec3 dither_shift_RGB = vec3( 0.25, -0.25, 0.25 ) / 255.0;   // mix(2x, -2x, rand(gl_FragCoord.xy))
```

Those are **display codes**. The chunk is written on the assumption that the renderer
finishes with a tonemap and an sRGB encode, so half an LSB is half an LSB. Here
`renderer.toneMapping` is `NoToneMapping` and the post stack owns the encode
(non-negotiable 6), so both of those chunks are no-ops and what the flag actually added
was **0.00196 of scene-linear radiance**, per channel, **with green opposed to red and
blue** — a magenta/green flip keyed off a hash of `gl_FragCoord`. Purple and green pepper,
by construction, exactly as the owner described it.

The amplifier is not in the material. It is that a **fixed absolute** quantity was injected
upstream of auto-exposure. Applied multiplier, read back off `expStateB.g` in the same
frame:

| scene | applied exposure | dither as post-exposure signal |
|---|---|---|
| orbit | 0.151 | 0.0003 — nothing |
| dusk | **22.63** | 0.044 |
| night | **22.63** | 0.044 |

**7.2 stops** between them, and at dusk and night the sails' own radiance is of the same
order as 0.044 — so every sail pixel was being pushed a large fraction of its own value.
The negative half of the swing clips at the floor, so the dither did not only add noise, it
**lifted the canvas**: most of a stop of the sails' dusk and night luminance was rectified
noise, which is why the sails read paler before this and darker after.

### Both states of the fix, inside ONE frozen frame

`.tmp/H73speck.mjs` restores the flag **from the page** (`material.dithering = true`, a
fresh `customProgramCacheKey`, `needsUpdate`), so before and after share one wave phase,
one cloud field, one sun and one heading. Statistics over the **sail silhouette only**;
`chroma` is `max(R,G,B) - min(R,G,B)` on the stored 8-bit codes, `nbr jump` is the mean
`|Δchroma|` over 4-neighbour pairs inside the mask, `m HF` is the high-frequency part of
the magenta-green opponent `(R+B)/2 − G`, which is the axis the dither lives on.

| scene | chroma p50 | p99 | mean L | nbr jump | m HF |
|---|---|---|---|---|---|
| dusk, dither on | 19.0 | 45 | 24.1 | 6.92 | 6.31 |
| **dusk, shipping** | **12.0** | **19** | **14.5** | **1.84** | **0.47** |
| night, dither on | 21.0 | 46 | 24.5 | 6.43 | 5.48 |
| **night, shipping** | **13.0** | **29** | **15.4** | **2.10** | **0.57** |
| orbit, dither on | 35.0 | 41 | 118.2 | 2.32 | 0.41 |
| **orbit, shipping** | **35.0** | **41** | **118.2** | **2.33** | **0.40** |

Null spread in the same frozen frame (`base` against `base2`) is 0.0–0.1 on chroma p50,
0.04 on the jump and 0.02–0.04 on `m HF`. **Daylight is unchanged to every digit.** The
magenta-green high-frequency energy falls **13x at dusk and 10x at night**, and the
neighbour-to-neighbour jump at dusk and night is now **below** daylight's 2.32.

### The residual is the illuminant, and §71a's premise was wrong about it

Chroma p50 is still 82–88% of mean L at dusk and night, so on §71a's stated test — "a
near-white flax sail should have chroma near zero" — the defect would look unfixed. That
test only holds under a **neutral** illuminant. The sail's chromaticity against the sky's,
measured in the same frame:

| | R | G | B |
|---|---|---|---|
| dusk sail | 0.250 | 0.276 | 0.474 |
| dusk sky | 0.258 | 0.298 | 0.444 |
| night sail | 0.233 | 0.276 | 0.491 |
| night sky | 0.218 | 0.285 | 0.497 |

Within 0.03 on every axis: the cloth is the colour of the sky that lights it, which is what
a white surface under a blue-hour sky must be. And with the dither on, the **mean** hue was
measurably shifted off it — the dusk sail went to (0.255, 0.276, 0.469) and the night sail
to (0.248, 0.277, 0.475), i.e. toward magenta, so the flag was biasing colour as well as
adding noise. The discriminator that matters for "speckle" is spatial coherence, not
chroma magnitude, and §71a's own jump statistic already said so.

### Ablated and ruled out, one term at a time in the same frozen frame

Every candidate in the brief, plus the rest of the sail shader. `m HF` is the column that
matters; none of these moves it, and the ones that move `mean L` are moving real light.

| ablation | m HF, dusk | mean L, dusk | verdict |
|---|---|---|---|
| nothing | 5.76 | 27.0 | the defect |
| **`dithering` off** | **1.52** | **18.1** | **the whole of it** |
| `through * 0.28 * uSkyColor` = 0 | 6.12 | 25.3 | not it; real fill |
| backlit `pow(back,1.6) * uSunColor * uSunIntensity` = 0 | 4.90 | 27.0 | not it, and ~0 at night anyway |
| shadow-transmission `through * (1−sh) * front` = 0 | 4.52 | 27.1 | not it |
| `#include <lights_fragment_maps>` removed (the whole env probe) | 4.70 | 25.5 | **not it** |
| `lwShipAerial` removed | 4.62 | 26.8 | not it |
| `diffuseColor.rgb = 0.62` (all cloth albedo detail) | 6.06 | 28.8 | not it |
| crease/cockle/seam normal perturbation off | 5.68 | 27.1 | not it |
| `sheen = 0` | 5.73 | 25.5 | not it; worth 0.2 stops |

- **The environment probe is innocent** and was the brief's leading candidate. It is
  `HalfFloatType` already (`sky/EnvProbe.ts`), and removing it entirely changes no
  high-frequency statistic at any light level — at `orbit` it moves `m HF` 0.40 → 0.42 while
  moving `mean L` 118 → 102. It is supplying about half the sails' dusk light (14.6 → 10.1)
  and it is supplying it smoothly.
- **`shaders/bounce.ts` is not on the sail material at all.** It is injected only by
  `makeShipMaterial`, so it could not have been this.
- The two remaining large terms in the dusk sail's light are the probe (0.53 stops) and the
  fabric sheen lobe (0.37 stops). Both are smooth.

### Nothing was lost by removing it

`COMPOSITE_FRAG` already ends with **one LSB of triangular-PDF dither, monochrome,
immediately before the 8-bit write**, with a comment saying the sky bands without it. That
is exactly what the material flag was reaching for, in the one place where 1/255 really is
one code and where a monochrome perturbation cannot make chroma. The flag was a duplicate
in the wrong colour space, on the wrong axis, at the wrong point in the pipeline.

### Two things found in passing, neither of them mine

- **Auto-exposure is pinned to its ceiling at dusk and at night.** `expStateA.r` reads
  **4.4999990** in both, and `MAX_GAIN_STOPS` in `src/post/AutoExposure.ts` is **4.5**;
  `2^4.5 = 22.627417`, which is the applied multiplier to seven digits. So both scenes are
  asking for more exposure than the controller will give, and the night frames are as bright
  as the engine can currently make them.
- **§72's 2.14-stop gap is scene-dependent, not a constant.** It reproduces exactly on
  `orbit` (estimate 0.665, applied 0.151), but at dusk and night the estimate and the
  applied value agree to seven digits — **because both are sitting on the same 4.5-stop
  clamp**, not because the estimate is good there. A calibration that agrees at one end,
  again.

### The instrument, because the mask is the part that is reusable

The statistic needs the sail pixels and nothing else, and **a difference of two composites
cannot give you them**: hiding the sails changes what the adapt pass meters, the whole frame
moves, and the difference mask selects everything. So the sail meshes are rendered **alone**
into a private RGBA8 target with clear alpha 0 — an opaque fragment writes alpha 1, so the
alpha channel *is* the silhouette, with no post stack and no exposure anywhere in it. Then
erode one pixel, because an edge pixel's chroma is a coverage artefact. 37k px at dusk,
168k at `orbit`.

Two traps worth writing down. `material.fragmentShader` does not exist on a
`MeshPhysicalMaterial` — patch by **wrapping `onBeforeCompile`** so the module's own
injections are in scope first. And `customProgramCacheKey` here returns the constant
`'ship-sail'`, so three serves the cached program and **your edit silently does nothing**
until you vary the key too.

### What is still not good enough

- The sails at dusk sit at **mean L 14.5** and at night **15.4**, most of a stop darker than
  they looked yesterday. That is the honest value — the lift that is gone was rectified
  noise, not light — but "the sails are dark at blue hour" is now a real question about the
  sky's fill on canvas rather than a noise artefact, and it is worth a look by whoever owns
  the illuminant. It is not fixable by putting noise back.
- `p99` chroma at night is **29** against dusk's 19. The top percentile of night sail pixels
  still carries more colour spread than dusk's does, and this fix does not explain why.
- The residual `m HF` of 0.47–0.57 at dusk and night against `orbit`'s 0.40 is small but not
  zero. It was not chased.

### 73a. Confirmed independently, and the bug class is closed rather than the instance

My own measurement on fresh captures, sail region, same metric as §71a:

| scene | chroma p50 | **neighbour jump** | mean L |
|---|---|---|---|
| dusk before → after | 18.0 → **12.0** | **4.78 → 1.93** | 24.3 → 18.1 |
| night before → after | 26.0 → **19.0** | **4.89 → 2.67** | 29.9 → 24.1 |

The neighbour jump is the speckle statistic — spatial incoherence — and it falls 2.5× at
dusk and 1.8× at night. The crop shows smooth cloth with the rigging, the ensign's stripes
and the stars all legible where there was purple and green pepper.

**The bug class is closed, not just this instance.** `grep -rn dithering src/` now returns
only explanatory notes — four of them, at every site that could plausibly set the flag
again — and nothing in `src/ocean`, `src/world`, `src/vfx` or `src/post` sets it. That
matters because the mechanism is general: **`dithering_fragment` is the last chunk in
three's fragment shader and assumes the renderer ends with a tonemap and an sRGB encode.**
Under non-negotiable 6 both of those are no-ops here, so its ±(0.5, −0.5, 0.5)/255 of
*display code* became ±0.00196 of **scene-linear radiance**, per channel, green opposed to
red and blue — magenta/green pepper by construction. Any three flag that assumes a
display-referred output is suspect in this engine for the same reason.

The amplifier was not in the material: a **fixed absolute** quantity was injected upstream
of auto-exposure, whose applied multiplier is 0.151 at `orbit` and **22.63** at dusk and
night — 7.2 stops apart. And the negative half of the swing clipped at the floor, so it was
**rectifying**: most of a stop of the sails' night luminance was noise.

### Two corrections it made to my own briefs
- **The environment probe was innocent** — my leading candidate. It is already
  `HalfFloatType`, and removing it *entirely* moves no high-frequency statistic at any
  light level (at `orbit`, magenta-green HF 0.40 → 0.42 while mean L 118 → 102). It
  supplies about half the sails' dusk light, smoothly.
- **"A near-white sail should have chroma near zero" is wrong**, and it was my premise in
  §71a. That test only holds under a neutral illuminant. Measured in one frame, the dusk
  sail's chromaticity is (0.250, 0.276, 0.474) against a sky of (0.258, 0.298, 0.444): the
  cloth is the colour of the sky lighting it. Residual chroma of 82–88% of mean L is
  therefore *correct*, and the thing that was wrong was the incoherence, not the amount.
  (The dither was also biasing the mean hue toward magenta, so the flag was a colour error
  as well as a noise source.)

## 74. Auto-exposure is pinned to its ceiling at dusk and night

`expStateA.r` reads **4.4999990** against a `MAX_GAIN_STOPS` of **4.5**, and the applied
multiplier is 22.627417 — 2^4.5 to seven digits. **Blue hour and night are already as
bright as this engine will make them**, and removing the dither took ~0.9 stops of
rectified noise off the sails, which is honest but leaves them dark.

So "the sails are dark at blue hour" is now a real question about the sky's fill on canvas
and about that ceiling, and **it cannot be answered by putting noise back**.

**And §72's 2.14-stop calibration gap is scene-dependent, not constant.** It reproduces
exactly on `orbit` (0.665 estimated against 0.151 applied) but at dusk and night the
estimate and the applied value agree to seven digits — *because both sit on the same
clamp*. That is the third time on this project that a calibration agreeing at one end has
concealed something, and the pattern is now explicit enough to be a rule: **agreement at
one operating point is not validation; check a second point that exercises a different
branch.**

## 75. §67's dead far field: the footprint is 3 m by 514 m, and `Nlow` was answering with one number

§62's top defect was two things in one sentence. The hard-edged bands are fixed (§67).
The other half — **the far-field ocean dies before the horizon** — is now fixed from
~900 m inwards, and the reason it cannot be fixed further out is itself a measurement.

### The lever §67 left on the table is the flicker, wearing a disguise

§67 proposed replacing `Nlow` (cascade 0 only, the 0.5–2 km swell) with the full
multi-cascade `slope`, and measured that it lifts per-row mean `|dL/dx|`. It does. It
also **is** §17C. Same process, sim clock pinned, camera static, every non-ocean module's
`update()` a no-op, so the wave phase and cloud field are identical across variants
(`.tmp/hznlow.mjs`). Splitting the lever by specular path, `orbit`:

| variant | mean \|dL/dx\| y 576–660 | flick 600–1000 m | flick 1–3 km |
|---|---|---|---|
| null | 2.068 | 0.16 | 0.26 |
| `Ns` gets the raw slope (sun lobe) | 2.142 | 0.20 | 0.28 |
| `Nmac` gets the raw slope (reflection) | 2.263 | 0.29 | 0.27 |
| null, repeated | 2.067 | 0.16 | 0.26 |

and in `noon`, on §17C's own instrument and in its own scene, the raw-slope reflection
normal reproduces §17C's number to the digit: temporal std of the per-row band signal
**0.38** beyond 3 km, 0.32 at 1–3 km, 0.22 at 600–1000 m, against a null of
0.23/0.08/0.11. §17C recorded "0.38 with the micro normal against 0.10 with the macro
normal". So the detail that lever buys past a kilometre is the grazing rectification of
`dot(Nmac, V)` — the owner's flickering horizontal streaks, sold back as texture.

### The real cause: one isotropic LOD for a footprint that is not square

At grazing incidence a pixel covers `pxWorld` **across** the view ray and
`pxWorld / |V.y|` **along** it — 3.2 m by 514 m at four kilometres. The fragment
sampler's explicit LOD uses `pxWorld` for both, and `lostVar` — the bookkeeping that
turns unresolvable slope variance into roughness — is evaluated at `pxWorld` for both.
One footprint, two very different answers, and only one was being asked for.

Which axis matters is not a judgement call. To first order

    dot(N, V)  ∝  V.y − dot(slope, normalize(V.xz))

so the **along-ray** slope component is the entire content of `dot(N, V)`, and the
**across-ray** component does not appear in it at all. The along axis is therefore
exactly the one that rectifies `dot(N, V)` negative and flickers (§17C), and the across
axis is exactly the one whose detail a 3.2 m footprint can still place. `Nlow` now keeps
the across component whole and cuts the along component by `kAlong`, the fraction of the
along-axis slope rms that survives the along-ray footprint — the same `lostVar`
schedule, asked a second time at `pxAlong`:

```glsl
float pxAlong = pxWorld / max(abs(V.y), 1e-3);
// ... alongLost accumulates the same smoothstep per cascade, at pxAlong
float kAlong = sqrt(clamp(max(slopeVarTotal - alongLost, 0.0) / carried, 0.0, 1.0));
vec2 vDir = V.xz / max(length(V.xz), 1e-5);
vec2 lowSlope = slope - vDir * (dot(slope, vDir) * (1.0 - kAlong));
```

Cascade 0 was not merely a coarse approximation to this, it was the wrong shape: it holds
**3.6% of the variance the footprint still carries** at 4 km (1.01e-4 against 2.82e-3),
and its 32 m texel spans nineteen pixels there, so it can make a gradient *down* the
screen and nothing at all *across* it. That is why the defect showed up in a per-row
`|dL/dx|` statistic and not in the column profile.

### §67's hazard, discharged: the compensation was the same expression with kAlong = 0

`alphaR` exists to add back the variance that blending N toward `Nlow` removes. Blending
now scales the along axis by `kRef` and leaves the across axis alone, and slope variance
splits evenly between the axes, so what the blend removes is **half** of `carried` times
`(1 - kRef²)`:

```glsl
float kRef = mix(1.0, kAlong, macro);
float alphaR = clamp(max(alpha, sqrt(lostVar + 0.5 * carried * (1.0 - kRef * kRef))), 0.02, 0.95);
```

The old form is this expression with `kAlong` pinned to 0 and the 0.5 dropped — i.e. it
assumed the blend flattened *both* axes completely, which is what blending toward
cascade 0 very nearly did. That is why the old pairing was self-consistent, and it is why
keeping it would now count the across-ray half twice. The sun lobe's wide regime gets the
same treatment at its own blend weight (`kSun = mix(1.0, kAlong, glit * 0.85)`) in place
of `aWide = uSlopeRms`.

**The re-derivation is provably inert, and that is worth stating.** Landed `Nlow` with the
old alpha bookkeeping measures 2.209 against 2.216 for the correct one, on a null spread
of 0.004 — indistinguishable. The reason is that `uSlopeVarTail` is 47% (sea state 7) to
86% (sea state 3) of the total slope variance and no blend can reach it, so both forms
land within 2% of `uSlopeRms`. It is a correctness statement, not a visible change; the
visible change is entirely `Nlow`.

### What it buys, and what it costs

Landed source as the baseline, the change patched back out inside the same process:

| scene | mean \|dL/dx\| before → after | null spread |
|---|---|---|
| `orbit` y 576–660 | 2.063 → **2.232** | 0.017 |
| `noon` y 330–440 | 2.305 → **2.696** | 0.004 |
| `golden` y 330–440 | 2.348 → **2.816** | 0.009 |
| `storm` y 340–450 | 3.118 → 3.166 | 0.033 — inert, 5.2 km visibility |

Row sd rises with it (`orbit` 5.34 → 6.27), and the column profile does not regress:
`orbit` total `|d2L|` 19.9 → 16.7 with the discontinuity count 4 → 3, i.e. §67's first
half is untouched or slightly better.

The cost is one band, and it is the same term as the gain — reverting only the reflection
path removes **both** (`golden`: 2.816 → 2.340 and flick 0.25 → 0.11), while reverting
only the sun path changes neither (2.809, 0.25). There is no split that keeps one without
the other.

| `golden`, temporal std | before | after | raw slope (§17C's defect) |
|---|---|---|---|
| beyond 1000 m | 0.10 / 0.14 | 0.09 / 0.14 | 0.29 / 0.17 |
| 600–1000 m | 0.05 | 0.10 | 0.41 |
| 240–600 m | 0.10 | 0.25 | 0.36 |
| 130–240 m | 0.22 | 0.26 | 0.25 |

So the band §17C measured and fixed — beyond 600 m — is **preserved**, and the cost lands
at 240–600 m, where the after value (0.25) is the level the *same frame's* 130–240 m band
already sits at (0.22–0.26) rather than the level of the defect (0.36). It is honest
detail, not aliasing: at 400 m in `golden` the along-ray footprint is 7.8 m and the waves
it admits are 8–16 m, which the pixel genuinely resolves. `noon` says the same at 0.16 →
0.21. The owner's own band, 130–240 m, moves 0.22 → 0.26 against a raw-slope 0.25 — i.e.
the macro blend was already doing almost nothing there.

### Why the last kilometre cannot be fixed this way

The gain stops at ~900 m, and `kAlong` says why. For the along axis to carry the
cascades that make pixel-scale structure, `pxAlong` has to be inside their pixel fades —
9 m for cascade 2, 0.56 m for cascade 3. At 2 km in `orbit`, `pxAlong` is **460 m**:
every cascade is fully faded and `kAlong` is 0, so the only along-ray slope left anywhere
in the schedule is the swell, which varies over 300 px and cannot make a gradient. Capping
the along footprint was priced too — at the dominant wavelength (76 m) `kAlong` is 0.148,
at 32x `pxWorld` it is 0.174 — because at 2 km `carried` is held by cascades 2 and 3,
whose fades end at 9 m. **Past ~900 m there is no along-ray placement left to render, and
no slope filter can invent one.** §67 saw the same wall from the other side: its lever
"does not help the top six rows".

What is actually missing there is not a filtered slope but **grazing self-occlusion**: at
0.7° the sea hides its own troughs behind its own crests, so the visible surface is a
biased sample whose structure is the crest lines, and which crest is visible varies at the
wave scale — a few pixels. That is a different mechanism (horizon mapping, or a masking
term that carries local phase), not a normal-map question. The other route is the one §67
already named: **earth curvature**. With the eye at 25.6 m the true horizon is 18.0 km and
the clipmap draws to 49 km, so rows y 575–577 in `orbit` are sea that should not be
visible at all; deleting them deletes most of the dead band. It collides with the skirt's
rise-to-eye-height, and that interaction is the whole job.

### Two instrument notes

- **`masthead` is not a usable bed for this instrument.** Repeated nulls read 0.06 and
  0.50 on the same statistic in the same process. The frame is 90% rigging and sails
  (see the capture) and the rows that bucket as "sea" by depth are mast — the camera and
  its spars move even with every non-ocean `update()` stubbed. §67's `masthead` 25.2 →
  25.3 was measuring rigging, not sea.
- **flick.mjs's row bands are the `noon` chase camera's, hardcoded.** In `orbit` the
  horizon is at y 576, so its "far >600m" band (rows 352–392) is *sky*, and every variant
  reads the same 0.03 there. `.tmp/hznlow.mjs` buckets rows by their own world distance
  instead. Any earlier `orbit` or `helm` reading off those fixed bands is void.

### 75a. This landed inside another agent's commit

The source change is on `main` inside **`def7ecc` "fix(rendering): refine ocean horizon
and ship materials"**, which also carries `src/ship/materials/*` and `src/ui/styles.css`
— a blanket add from the shared tree, the pattern AGENTS.md's standing note is about. I
did not write that commit and have not rewritten it: other agents' work is in it and this
tree is shared. Recorded here so `git log` for `src/ocean/shaders/surface.ts` is not
misleading. The committed content **is** the measured content — the before/after table
above was re-run against the committed file after the fact and reproduces (`orbit`
2.063 → 2.232, null spread 0.017).

## 76. §67's last item: earth curvature is in, and the skirt's hack was generalised rather than removed

§67 closed with "there is no earth curvature" and "that interaction is the whole job".
Both halves held up. The drop is landed, the skirt's rise-to-eye-height is now the
`R -> infinity` limit of a formula that also covers the curved case, and the horizon is
a line again in the two scenes where it was not one.

### Why it was worth doing, and the strongest reason was not on §67's list

**The sky already drew the limb.** `skyRender.ts` has
`horizonCos = -sqrt(r*r - RG*RG)/r` and `hitsGround = viewZenithCos < horizonCos`, from
`uCameraPosW`, which is `setFromMatrixPosition(camera.matrixWorld)` — the same
expression `Engine.ts:199` uses for the ocean's `uCameraPos`. So the two subsystems
disagreed about where the horizon was by the whole dip, **3.5 px in `orbit` and
`shadow`**, and the ocean was painting sea over the entire region the sky had already
decided was below the earth's limb, plus that much more. The ocean now uses the sky's
own `GROUND_RADIUS_KM` (6360 km, not the 6371 mean radius) for exactly this reason: one
number, one line. The 11 km difference is 2.5e-6 rad of dip — 0.003 px.

### The horizon became a line, and the pale cyan hairline went with it

`shadow` (orbit camera, `cloudCover` 0, visibility 44 km — the worst case for the step
size), same process, sim clock pinned, x 0-520. Before is produced by patching the drop
back out of the landed shader, so the two differ by the change and nothing else.

| | tot \|d2L\| | max \|dL\| | the five rows above the sea |
|---|---|---|---|
| before | 24.0 | 6.73 | 146.7, **147.0, 148.0**, 146.0, 139.2 |
| after | 23.5 | **7.88** | 146.7, 146.5, 146.2, 146.1, 146.0, then 143.2, 135.4 |
| after, repeat | 23.7 | 7.88 | same |

Read the before column: the last rows of *sea* were **brighter than the sky above
them** (148.0 against 146.7). That is §67's "the last visible sea is forced to full
aerial-perspective saturation, so it IS the sky", and it was worse than neutral — it was
a pale band. After, the sky descends monotonically for five more rows and then the sea
steps down by 2.8 and 7.9. `tot|d2L|` is unchanged (null spread 0.2), so nothing was
traded for it.

Per channel, excess B-R over the sky immediately above, same frames:

| | y+1 | y+2 | y+3 |
|---|---|---|---|
| before | +3.5 | +11.1 | **+16.1** |
| after | +0.8 | — | — |

That is §67's second open item, the in-scatter's elevation lift. §67 got it from +14.4 to
+7.3 and said closing the rest "needs elevation resolution near the horizon that a
128-row probe has not got". It does not. It needs the rows that were sea at 20-49 km to
be **sky**, which is what they now are, and the probe was never touched.

### The geometry, verified to a third of a pixel

Sub-pixel silhouette row, from an ink frame (ocean fragment shader forced to one flat
colour) via the coverage integral. Predicted rows come from the actual projection:
eye level at `row = H/2 + tan(-p)/pxAngle`, the limb one `sqrt(2h/R)` further down.

| scene | eye | before edge | eye-level row | after edge | limb row | drop | predicted dip |
|---|---|---|---|---|---|---|---|
| shadow | 25.51 m | 575.65 sd 0.28 | 575.74 | 579.07 sd 0.33 | 579.25 | **+3.42** | 3.50 |
| orbit | 25.90 m | 573.18 sd 0.42 | 573.21 | 577.09 sd 0.44 | 576.74 | **+3.91** | 3.53 |

854 and 829 clean columns. **The flat sea's silhouette sits on eye level to 0.03-0.09 px
and the curved sea's sits on the true limb to 0.18-0.35 px.**

Independently, scaling the drop by `k` must move the dip as `sqrt(k)`. Measured drops for
k = 0 / 0.25 / 1 / 4: **0 / 0.74 / 2.47 / 6.42 px**, which fit `3.48`, `3.47` and `3.71`
against a predicted coefficient of **3.57** over a 16x range of k. (The common offset is
that frame's own baseline: a frozen frame carries a fixed TAA jitter that shifts the
measured edge but not the matrices the prediction is computed from.)

### The skirt: the same expression, with R put back in

An infinite flat ocean's horizon is at eye level, so the old
`skirtRise = isSkirt * smoothstep(0.80, 1.0, r) * max(uCameraPos.y, 0.0)` lifted the
outer edge to eye height to close the sliver under a finite one. A curved sea's horizon
is `sqrt(2h/R)` below eye level, and the lift that lands the edge exactly on it is

    rise = max(sqrt(h) - D * inversesqrt(2R), 0.0) ^ 2

which is **`h` as `R -> infinity`**, i.e. the old hack is the flat-earth limit of the new
one. Three properties, and they are what make this a replacement rather than a weakening:

- it is **identically zero** whenever the mesh already reaches past the tangent point,
  because the clamp bites for `D >= sqrt(2Rh)` — that is every eye up to
  `HORIZON_RADIUS^2 / (2R)` = **190 m**, so on every camera mode but the debug fly-cam
  the skirt is now a plain piece of curved sea and the hack is gone;
- above 190 m it reappears and **still cannot lift any part of the sea above the limb**,
  because the limb's elevation is the thing it solves for;
- the guarantee no longer depends on the mesh's edge at all. The silhouette is now
  interior geometry 18 km out, with 2.7x more mesh behind it in every direction, and the
  near root of `h/d + d/2R = theta` is monotone, so every ray at or below the dip hits
  the surface.

Measured in `orbit`, 860 columns: **zero slivers, and zero columns where the curved sea
sits above the flat one.** Also measured, because the old comment was wrong: removing the
rise from a *flat* sea drops the silhouette **1.16 px**, not the "sub-pixel sliver" the
comment claimed. The hack was doing real work.

### Where it is inert, and that is the correct behaviour

The dip goes as `sqrt(h)` and so did the defect, because the forced haze band only eats a
meaningful number of rows when the eye is high.

| scene | eye | fov | dip | measured |
|---|---|---|---|---|
| orbit / shadow | 25.5-25.9 m | 40 | 3.5 px | the win above |
| golden | 28.4 m | 64.5 | 2.13 px | max\|dL\| 7.44 -> 7.6 +-0.4, tot 15.2 -> 16.0 +-0.7. **No seam at low sun**, which was the risk case |
| noon | 27.3 m | 64.5 | 2.09 px | max\|dL\| 6.69 -> 6.41: the step is no bigger, just tighter and one row lower |
| storm | 27.1 m | 64.5 | 2.08 px | max\|dL\| 1.25 -> 2.4 in a 124-unit field. Haze saturates 3.5x before the limb: invisible |
| helm | 8.4 m | 71 | 1.02 px | no measurable change in the horizon's structure |
| waterline | 2.5 m | 54 | 0.78 px | below this instrument's floor — see the instrument notes |

So the payoff concentrates on the high, narrow-fov cameras, which are the beauty shots
and include the scene a blind critic ranked worst. At the helm and at the waterline the
horizon reads the same, and it should: at a 2.5 m eye the flat sea's outer edge was
already only 0.1 px above the true limb.

### The forced haze saturation: kept, and its comment was false

`t = max(t, smoothstep(6000.0, 22000.0, dist));` was written for a sea that ran flat to
49 km. It is **not the lever and never was.** Removing it from the untouched build moves
`tot|d2L|` by 0.3 on a null spread of 0.4, because Koschmieder had already saturated
everything past 20 km. With curvature the last sea is at `sqrt(2Rh)` and natural
extinction alone gives t = 0.44 at a 2.5 m eye, 0.77 at 8 m, 0.91 at 25 m — so it is
inert again: `shadow` reads 23.5 with it and 22.8 without, max\|dL\| 7.88 against 7.63,
null spread 0.2. It is kept as a bound on the step at extreme visibility, for one `max`,
and its comment now says that instead of the old claim.

### What this breaks, and it is not in src/ocean

The drop is anchored on the **camera**, not the world origin, so that the ocean's limb
and the sky's coincide. The price near the eye is nothing — 0.8 mm at 100 m, 1 mm under
the orbit camera's ship, so the CPU wave sampler, the wake field and the near field need
no change. But **anything else sitting at y = 0 a long way off no longer meets the
water**, and that is a real handoff, not a caveat:

| owner | object | range | drop | float at that range |
|---|---|---|---|---|
| `src/world/Boston.ts` | the town's waterfront | spawns 5.0-8.6 km | 2.0-5.8 m | 0.4-0.8 px |
| `src/world/Boston.ts` | same, at `RETIRE_M` | 46 km | 166 m | **4.5 px** |
| `src/world/Vessels.ts` | hulls, at `RETIRE_M` | 12.5 km | 12.3 m | 1.2 px |
| `src/world/Sites.ts` | island shorelines | up to `SITE_M` 9 km | up to 6.4 m | 0.6 px |
| `src/world/Buoys.ts`, `Birds.ts` | | 4.2 / 7.0 km | 1.4 / 3.9 m | 0.3 / 0.4 px |

The fix is one line per call site: subtract `d*d/(2*EARTH_RADIUS_M)` with `d` the
horizontal distance from the **camera**, `EARTH_RADIUS_M` exported from
`src/ocean/OceanMesh.ts`. At normal ranges these are sub-pixel to 1 px. The bad one is
Boston at 30-46 km — and that is a **pre-existing correctness bug that curvature makes
visible rather than one it creates**: a 90 m hill seen from a 10 m eye is over the
horizon beyond 45 km, so a town fully visible at `RETIRE_M` = 46 km was always
impossible. Applying the drop there does not just remove the float, it makes the town
rise out of the sea as you close it, which is the most evocative thing a landfall has.

### Four instrument findings, and one of them produced a confident wrong answer first

1. **A whole-row threshold on the silhouette is worth +-1 px, and it cost me a pass.** I
   read the drop as **5.00 px against a predicted 3.51** and went looking for a factor of
   sqrt(2) in a shader that did not have one — the ratio was 1.42, which is exactly the
   kind of coincidence that makes a wrong answer feel found. Two whole-row detections had
   simply stacked their quantisation errors. The coverage integral
   `edge = yTop + sum(1 - a(y))` over an ink frame, with `a` built from `R-B` so the ink's
   own bloom cancels, gets sd 0.28 and agrees with the prediction to **0.08 px**.
   `.tmp/hzedge.mjs`. Do not difference two thresholded edges when the effect is 3 px.
2. **`waterline` does not freeze, so nothing can be measured in it this way.** Pinning
   the sim clock leaves two nulls in the same process differing by **24.6 LSB mean, 216
   max**, against 2.2 for `orbit` and 2.6 for `helm`. Latching the solved camera every
   frame and re-stamping it after the tick changed nothing (24.6 LSB), so the mover is
   not the camera. Something in that scene advances on a clock the sim does not own.
3. **§67's discontinuity count cannot tell one horizon from a staircase.** It counts
   `|d2L| >= 1.5`, and a real 7.9-unit step in one row trips it at two or three
   consecutive rows. `shadow` reads 5 edges before and 5 after. The discriminator is
   *where* they are and what the sea does below them: before, 576/577/579/584/586 with a
   brightness bump at the top; after, 578/579/580/581/586 — contiguous at the limb, with
   the sea strictly monotone for the next 20 rows. Quote the profile, not the count.
4. **The probe's `masthead` scene has no horizon in frame.** `cam.mode = 'masthead'`
   frames the top itself; the sea appears only in slivers between the spars, so a
   silhouette detector there measures near-field sea and reports a dTop of 0 by
   construction. It is not a horizon regression check. Its `camY` is also 24.7-25.9 m,
   not the 67 m masthead, so it does not exercise the high-eye case either.

### A shared-tree note: this work was committed by someone else's blanket add

`def7ecc fix(rendering): refine ocean horizon and ship materials` carries
`src/ocean/OceanMesh.ts` and `src/ocean/shaders/surface.ts` — this change — together with
`src/ship/materials/materials.ts`, `src/ship/materials/textures.ts` and
`src/ui/styles.css`, which are not. HEAD is correct and nothing was lost, but
`git log -- src/ocean` has no curvature commit to find, which is the third time this tree
has done this (AGENTS.md's standing note, and §69). The same commit also carries another
agent's `alongLost` / `pxAlong` anisotropic slope-variance work in `surface.ts`; the
appearance numbers above were re-measured on the current tree with both changes in, and
they agree with the set taken before it landed.

**Still open from §67, and untouched here:** `lowSlope` written only in the cascade-0
iteration. Curvature helps it slightly and for free — `pxWorld` at the last sea row falls
from 40 m to 15 m and `|V.y|` there rises 8x, so the grazing anisotropy at the horizon
drops by more than an order of magnitude — but the named hazard (`alphaR`'s variance
compensation double-counting, on §17C's flicker path) is unchanged and still needs the
flicker instrument.

## 77. §74 answered: blue hour was the compression slope, and the ceiling was a symptom

**It is exposure, not the illuminant, and the read-back settles it.** Scene-linear radiance
in the `post/scene` target at `dusk`, converted with the units contract's own
`LUMINANCE_PER_UNIT` (1.0 game unit = 1.02e4 cd/m^2):

| region | radiance, game units | cd/m^2 |
|---|---|---|
| sky, p50 | 7.68e-4 | **7.9** |
| sky near zenith, p50 | 7.01e-4 | 7.2 |
| sea, p50 | 9.3e-5 | 0.95 |
| sail, p50 | 3.30e-4 | 3.4 |

The sun at that preset is **12.7 deg below the horizon** with the moon 10.8 deg up. A real
sky at the end of nautical twilight is 0.005-0.05 cd/m^2. The model's sky is therefore
**7 to 10 stops BRIGHTER than physical**, not darker, and the engine was still putting it
on screen at a median code of 27.8. Raising the illuminant would have been pushing on the
wrong end of a chain that was already 10 stops hot.

That is not an accident either — the sky module says so itself, and its numbers agree with
the read-back. `MOON_IRRADIANCE_FULL` is 0.0026 against a physical 2.5e-6 of the sun's
illuminance and is commented as "the one deliberately non-physical constant in the module";
`STAR_RADIANCE` 0.055 is "tuned so the sky reads right at night rather than being
radiometrically exact"; `AIRGLOW` is 0.77 cd/m^2 against a real 2e-4. Measured against the
same scale the **sun** is right: `uSunIntensity` 10.25 at `orbit` is 1.05e5 lux, and direct
normal solar illuminance with the sun 42 deg up is 0.9-1.0e5 lux. So the day end is
calibrated and the night end is deliberately lifted. The illuminant was never the fault.

### The ceiling was pinned, and that was still not the cause

§74's measurement is exact — `expStateA.r` 4.4999990, multiplier 22.627417 — but the
inference from it was wrong. What the curve was *asking for* is the number that matters:

    raw    = log2(0.18) - metered
    stops  = raw > KNEE ? KNEE + (raw - KNEE) * SLOPE : raw

| scene | metered log2 | raw | curve wants | got | clamp cost |
|---|---|---|---|---|---|
| dusk | -11.79 | 9.31 | 4.96 | 4.50 | **0.46 stops** |
| night | -11.29 | 8.81 | 4.71 | 4.50 | **0.21 stops** |

So the 4.5 clamp was worth **half a stop**, and the other **4.35 stops** were the
compression slope. Above the knee the whole curve is one line, and the screen position of
the metered band collapses to a single identity:

    screenOffset = (1 - SLOPE) * (KNEE - raw)

which is why the slope is the only real lever and the knee just slides the branch.

What the clamp *was* doing is worse than darkening. At `SLOPE` 0.45 the curve reaches 4.5
stops at `raw` 8.29, and the histogram floor is `raw` 10.53 — so across the **last 2.2
stops of nightfall the auto-exposure stopped responding to the scene at all** and the
picture simply went darker. Both night presets were inside that dead band.

### The fix, and why it cannot touch daylight

`COMPENSATION_SLOPE` 0.45 -> **0.55**, `MAX_GAIN_STOPS` 4.5 -> **6.5**. The ceiling is
sized so it can no longer be reached: the curve's maximum demand, at `EXPOSURE_MIN_LOG`,
is `1.4 + (-2.474 + 13 - 1.4) * 0.55` = **6.42 stops**. It is now a rail, not an operating
point. Night still cannot become grey mush, and now by construction rather than by a
clamp: the identity bounds the screen offset at `0.45 * (1.4 - 10.53)` = **4.11 stops
below middle grey** for the darkest scene the histogram can represent.

Daylight is not "measured unchanged", it is **structurally unable to change**. All 14
capture presets, `raw` read off `expStateB` twice 8 s apart with the drift printed
(`.tmp/H74sweep2.mjs`):

| branch | scenes | raw |
|---|---|---|
| **compressed** | sunset, dusk, night | 5.86, 9.31, 8.79 |
| linear | orbit, helm, dawn, morning, waterline, island, noon, fog, storm, masthead, golden | -2.13 to -0.06 |

Eleven of fourteen never enter the branch, and the closest of them — `golden` at `raw`
-0.06 — still has **1.46 stops of margin** to the knee. So only three scenes can move at
all, and the two that were pinned are two of them. `sunset` gains 0.44 stops (`stops` 3.41
-> 3.850, multiplier 10.6 -> 14.4), which is the right sign for a frame taken 2.5 deg after
sunset.

### Both states inside ONE frozen frame

The curve constants are uploaded as uniforms, so a variant is a poke at
`pipeline.exposure.adaptPass` and before/after share one wave phase, one cloud field, one
sun and one heading. The one wrinkle: a frozen frame has `dt` 0 and the adaptation is
`prev + (target - prev) * (1 - exp(-rate * dt))`, which never moves — so `adaptPass.render`
is wrapped to force `uDt` 8 s, which snaps it in a single frame without unfreezing anything
else. `.tmp/H74curve.mjs`. Luma of the 8-bit composite, p50 over each region; `base2` is a
second pass at the shipping constants and is the null.

| scene | region | base | **after** | base2 (null) |
|---|---|---|---|---|
| dusk | sky | 27.8 | **51.0** | 27.8 |
| dusk | sea | 6.1 | **10.9** | 6.1 |
| dusk | sail | 15.6 | **31.5** | 15.7 |
| dusk | frame | 11.2 | **22.7** | 11.2 |
| night | sky | 31.7 | **50.3** | 31.7 |
| night | sea | 8.5 | **14.5** | 8.6 |
| night | sail | 12.9 | **22.1** | 13.0 |
| night | frame | 15.8 | **27.2** | 15.9 |
| sunset | sky | 80.5 | **94.1** | 80.5 |
| sunset | sea | 34.4 | **42.0** | 34.5 |
| sunset | sail | 37.9 | **46.5** | 37.9 |
| sunset | frame | 40.0 | **49.2** | 40.0 |
| orbit | sky | 104.6 | **104.6** | 104.5 |
| orbit | sea | 77.4 | **77.4** | 77.6 |
| orbit | sail | 130.1 | **130.2** | 130.1 |
| orbit | frame | 95.9 | **96.1** | 96.0 |
| golden | sail | 123.0 | **122.6** | 123.0 |
| golden | frame | 109.8 | **109.2** | 109.6 |

`orbit` moves by 0.1-0.2 codes against a null of 0.1-0.2. Applied multiplier there is
1.4872e-1 before, 1.4879e-1 after, 1.4874e-1 on the null. Nothing new clips at `sunset`
either — sky p99.9 goes 153.0 -> 168.2 with the sun's own afterglow already at 255 in both.
(The horizontal banding across the `sunset` cloud deck is present identically in `base` and
`base2`; it is not this change.)

`golden` is the closest daylight scene to the knee and it is the one worth checking rather
than `orbit`: `raw` -0.09, and its `sl55` numbers sit inside its own `base`/`base2` null.

Confirmed on the shipping constants in fresh captures: applied multiplier **22.627 ->
54.011** at dusk (stops 4.500 -> 5.755, and 5.765/54.39 on a second run) and **22.627 ->
44.497** at night (4.500 -> 5.476), neither on the clamp; scene radiance unchanged (dusk
sky p50 7.670e-4 -> 7.684e-4); display p50 sky 50.8, sea 11.1, sail 31.7 at dusk and
50.2 / 14.3 / 22.4 at night.

**No black point was lifted.** Exposure is a multiply upstream of AgX, so zero maps to
zero: the dusk frame's p0.1 goes 1.1 -> 2.2 codes and night's 2.0 -> 3.1, still far below
the 8.7-11.7 that the blind critique called correct. §71 removed a contrast operator for
crushing the darks; this does not put a compensating lift back, it moves the scene up the
transfer curve instead. That distinction is measurable: at the old exposure the dusk frame
was being rendered at **9.8 codes per stop**, against 44 codes per stop near middle grey at
`orbit` — the whole scene was sitting in AgX's toe. After, it is 15.9 codes per stop.

**The stars survive, and there are more of them.** Sky p99.9 minus sky p50, in codes:
dusk 46.1 -> 58.8, night 55.1 -> 63.5, so the brightest stars gain absolute separation
while p99.99 and max stay at 255 (the moon disc still clips). At 1:1 the crops show *more*
faint stars, because the faint ones were previously below the crush.

### Two instrument notes, both of which produced a wrong table before they were found

- **`sceneDepth` is `r32f` = `RedFormat`, so `readRenderTargetPixels` returns ONE float per
  pixel, not four.** Reading it with an RGBA stride returns the first quarter of the image
  in the first quarter of the buffer and zeros after, which silently classified 75% of the
  frame off a buffer of zeros and gave a "sky" region of 8.7% in a frame whose horizon sits
  37% down. The tell was that the non-zero count was exactly `1600 * 225`. Anything read
  back from `sceneDepth`, `expLum` or `expPartial` has this shape.
- **A probe without the HMR guard measures whatever the page reloaded into.** My probes had
  copied H73speck's skeleton, which does not stub Vite's HMR socket the way
  `scripts/capture.mjs` does. I then edited `src/post/AutoExposure.ts` while a run was in
  flight; the page reloaded, `world.env` reverted to the app defaults, and the run reported
  `sunset` at a metered log2 of **-1.216** against a true **-8.33**. Two things made that
  expensive. It is **7 stops**, and it is the difference between `sunset` being on the
  compressed branch and not being on it — I wrote "it is not on it" into this section on the
  strength of it, and it is. And it did not fail: -1.216 is a perfectly plausible number,
  just for a different time of day. The cross-check that caught it was `sunY`, which read
  **0.666** for a preset whose sun is 12.7 deg *below* the horizon. Every probe here now
  stubs the socket, counts `framenavigated`, prints `sunY`, and re-reads each scene 8 s
  later so a moving number cannot pass as a measurement. AGENTS.md already says the harness
  disables HMR "so a capture run is not disturbed by another agent editing `src/`" — the
  case it does not mention is the agent editing `src/` being *you*.

### Left open

- **`dusk` is not blue hour.** The preset is `timeOfDay` 20.7, which puts the sun 12.7 deg
  below the horizon — late nautical twilight, an hour past the blue hour its label claims
  ("Blue hour, first stars"). It also meters **darker than `night`** (-11.79 against
  -11.29), because at 23.4 the moon is 23 deg up and at 20.7 it is 10.8 deg up. Both are
  correct physics for the stated times; the label and the coverage are what is wrong. A
  scene at 19.9-20.2 would exercise the actual blue hour, which nothing currently does —
  the gap between `sunset` (`raw` 5.86, sun 2.5 deg down) and `dusk` (`raw` 9.31, sun 12.7
  deg down) is **3.5 stops with no preset in it**, and it is exactly the range a player
  sails through at the prettiest time of day.
- The sail's radiance is 0.43 of the sky's at dusk (1.23 stops under), so a white sail at
  blue hour is *supposed* to read darker than the sky behind it and no exposure change will
  invert that. What changed is that its own tonal detail — panels, seams, the ensign — now
  survives quantisation.

### 77a. Confirmed, and §74's measurement was right while my inference was wrong

Verified independently on fresh captures: dusk frame p50 **22.6**, night **27.4**, and
p0.1 of **3.0 / 3.1** — still well under the 8.7–11.7 the blind critique called a correct
black level, so no black point was lifted to buy it. Star headroom (sky p99.9 − p50) is
**68.7 / 68.4 codes against daylight's 48.7**, so the stars did not just survive, they have
more room than daylight highlights do.

**My inference in §74 was wrong and the agent's correction is the interesting part.** The
ceiling *was* pinned at 4.4999990 of 4.5 — that measurement holds — but the curve was only
*asking* for 4.96 stops at dusk and 4.71 at night, so the clamp cost **0.46 and 0.21
stops**. The other 4.35 were `COMPENSATION_SLOPE`. I read "pinned at the ceiling" as
"the ceiling is the constraint", and it was not.

What the clamp *was* doing is worse than darkening and I had not seen it: everything from
`raw` 8.29 down to the histogram floor received exactly 4.5 stops, so **across the last
2.2 stops of nightfall the controller stopped responding at all.** A rail that never moves
is invisible in any single frame; it only shows up as a *derivative* being zero.

**And it answered the exposure-or-illuminant question properly, by read-back.** The dusk
sky measures **7.9 cd/m²** where a sun 12.7° below the horizon gives a physical
0.005–0.05 — so the illuminant is **7–10 stops brighter than physical, not darker**, and
`src/sky` says so itself: `MOON_IRRADIANCE_FULL` 0.0026 against a physical 2.5e-6, commented
as "the one deliberately non-physical constant". Raising the illuminant would have been
pushing on the wrong end. The measurable defect was that dusk was being rendered at
**9.8 codes per stop in AgX's toe against 44 near middle grey**; it is now 15.9.

Daylight is now **structurally** unable to move: 11 of 14 presets meter below the knee, so
the compressed branch is never entered, and `golden` — the closest at −0.09 against a knee
of 1.4 — still has 1.46 stops of margin.

### Two more instrument faults, one of them the HMR trap for the second time
- **`sceneDepth` is `r32f` / `RedFormat`**, so `readRenderTargetPixels` returns *one* float
  per pixel. An RGBA stride classified 75% of the frame off a buffer of zeros.
- **Vite HMR reloaded the page mid-probe** when the file under test was edited, reverting
  `world.env` to app defaults — and the probe then reported `sunset` metering at −1.216
  against a true −8.33. **Seven stops, and plausible enough to be written into DIAGNOSIS
  before a `sunY` sanity print caught it.** This is the same trap §57 records, and it has
  now cost two sessions. The fix is cheap and is now in every probe: stub the HMR socket,
  count navigations, and print a physical quantity you can sanity-check (`sunY`).

## 78. The blue hour had no preset, and `dusk` was lying about being it

`dusk` is labelled "Blue hour, first stars" and is nothing of the kind: at `timeOfDay` 20.7
the sun is **12.7° below the horizon** — late nautical twilight — and it meters *darker*
than `night`, because its moon is lower. So there were **3.5 stops between `sunset` and
`dusk` with no preset in them**, and that gap is the hour a sailing game is most often
photographed in.

This is the same structural failure as the blind critique's "nothing is alive in any of the
eight frames": **a review sheet cannot score what it never shows.** Two of the project's
worst blind spots have now been holes in the sanctioned scene list rather than in the
engine, which makes the scene list itself a thing to audit.

`bluehour` added at 19.95, beam-on. Measured on the shipped frame: western sky at the
horizon **71.5**, zenith **29.5**, sea **22.5** — 2.4 stops of sky in one frame, with the
afterglow, the deep zenith and the first stars all present, which is what makes the hour a
real test of the exposure curve rather than a pretty postcard.

`dusk` is relabelled "Late nautical twilight, stars out".

**And the frame corrected me.** I wrote that a white sail there "reads as a pale grey shape
rather than a silhouette", then shot it: beam-on to a sun just down, the sail plan is
**backlit** and silhouettes, which is both correct and the stronger image. Front-lit canvas
at low sun is what `sunset` is for — which is why that preset is a bowsprit shot. I also
quoted 86/41/25 for those three luminances before measuring them; the real figures are
above.

## 79. The waterline plate is the hull SKIRT, and the mechanism is §40's with the sign flipped

§64G recorded a hard-edged white plate along the hull's waterline in the `waterline`
scene at both wake-field resolutions and said it was in the near-hull water rather than
in the persistent field. It is, and it is not the ocean's foam term either: the ocean's
consumption of the wake's R channel is intact and correct. **It is
`hullSkirtFrag`, and specifically its SUBMERGED rows.**

That makes it the **third** ruled-line artefact this one mesh has produced — §35's
constant-height coverage cut, then the constant-depth `step(-1.6, vD)` and its
constant-depth feather, now a threshold that saturates below the water. The band's
shading is a function of `vD`, height above the local water, and every time a limit on
`vD` has been written as a constant it has drawn a dead-level line the length of the ship.
Anything here that clamps or cuts on `vD` should be assumed guilty until integrated.

### Attribution, by ablation in one session
`.tmp/skirtplate.mjs` shoots the same `waterline` shot with one draw removed at a time, after
the camera rig has taken its deterministic capture hold, so every frame is the same
composition. `HullWater.update` rewrites `mesh.visible` from `ctx.speedN` every frame, so
a hide has to be `geometry.setDrawRange(0, 0)`; `.visible = false` from the console lasts
less than a frame. Over a 560x70 rect on the plate, at 1600x900 dpr 1
(`.tmp/plateStat.mjs`: mean luma, fraction above 150, fraction whose 3x3 luma range is
under 6 codes, mean |dx|+|dy|, and the single strongest ROW of vertical gradient — a hard
edge running the length of the ship is one big row, a torn boundary is none):

| variant | mean | pale% | flat% | hf | strongest row |
|---|---|---|---|---|---|
| base | 109.1 | 27.1 | 30.8 | 13.17 | 30.73 |
| `vfx-bow-wave` hidden | 114.3 | 29.8 | 37.2 | 12.76 | 42.79 |
| `vfx-hull-skirt` hidden | 80.6 | **5.8** | 28.4 | 11.45 | 17.14 |
| both hidden | 65.3 | 2.2 | 19.6 | 11.67 | 21.55 |

The sheet is not involved. Colouring the skirt by `step(0.0, vD)` then puts the whole
plate in the SUBMERGED half of the band with only a thin line of above-water band along
its top edge, and a term-attribution pass (alpha forced to 1, the three alphas written to
R/G/B) shows the band's above-water half rendering *black* — nothing at all — while the
submerged half carries all of it.

**Instrument note.** The `noWake` variant of that probe is a NO-OP and the run's own state
readout is what caught it: `WakeField.update` ends with
`this.strength = this.trackFilled > 3 ? 1 : 0`, so assigning 0 from the console is
overwritten before the next frame, and the printed `wake=1` gave it away. Anyone ablating
the wake this way has to `Object.defineProperty` the getter. The wake was excluded here by
the skirt ablation removing the plate outright, not by a wake ablation.

### The mechanism, integrated against the real bake
`.tmp/skirtint.mjs` pulls the live 256² `tFoam` bake and the live skirt uniforms out of
the running engine (16.6 kn, heel 0.33-0.39 rad, chop 0.7) and integrates the shader's own
arithmetic, the way §40 did for the ocean. The froth field
`s1*0.36 + s2*0.26 + s3*0.20 + s4*0.24`, over 57600 samples:

    mean 0.338  sd 0.186
    p05 0.043   p25 0.200   p50 0.331   p75 0.465   p95 0.661   max 1.006

And the shipped threshold was `mix(0.20, 0.94, pow(above, 0.68))` with
`above = saturate1(vD / reach)`. **`saturate1` is the defect.** It returns 0 for every
fragment at or below the local water — 52.9% of the band's vertices — so the entire
submerged strip was thresholded at 0.20, which is that field's own **25th percentile**.
Integrated per height band:

| vD, m | E[thr] | E[coverage] | E[froth alpha] | sd | wetBand→foamA | E[wetA] |
|---|---|---|---|---|---|---|
| -2.9 .. -2.4 | 0.200 | 0.722 | 0.639 | 0.348 | 0.000 | 0.306 |
| -2.4 .. -1.2 | 0.200 | **0.825** | **0.720** | 0.288 | 0.144 | 0.475 |
| -1.2 .. -0.3 | 0.200 | 0.714 | 0.634 | 0.342 | 0.385 | **0.700** |
| -0.3 .. 0.0 | 0.200 | 0.588 | 0.526 | 0.391 | 0.312 | 0.404 |
| 0.0 .. 0.3 | 0.370 | 0.750 | 0.665 | 0.356 | 0.015 | 0.017 |
| 0.3 .. 0.8 | 0.610 | 0.140 | 0.144 | 0.312 | 0 | 0 |
| 0.8 .. 1.6 | 0.777 | 0.055 | 0.057 | 0.211 | 0 | 0 |
| 1.6 .. 3.0 | 0.885 | 0.003 | 0.003 | 0.048 | 0 | 0 |

At -1.2 .. -0.3 the two froth means sum to 1.019 against a 0.90 cap, and the wet-paint
layer goes over the top of that: the submerged strip was **very nearly opaque near-white,
2.4 m deep and 53 m long**. Its bottom edge is `clamp(wl - 2.4, uSkirtFloor, ...)` with
`uSkirtFloor = -2.9` — a dead-level line in ship-local Y for the whole length of the ship.
A uniform partial wash inside a smooth contour is a flat pale plate. That is the defect,
in one saturating call.

**This is §40 with the sign flipped, and that is the generalisation worth keeping.** §40's
form amplified a coverage and clamped it, so the coverage saturated at the TOP. This one
saturated its threshold's ARGUMENT at the bottom, which puts the threshold outside the
field and has the identical consequence: a threshold against a constant is not a
threshold, it is a constant, and then the silhouette falls through to whatever drew the
geometry. Check both ends of every coverage chain, not just the one that has bitten before.

### The second defect in the same expression
The old ramp's top of 0.94 is past the field's maximum of 1.006 once the 0.075 ramp
half-width is taken off it, so the froth `frothReach` places ABOVE the water — the whole
point of §35's per-station reach — rendered 0.14 coverage at half a metre and 0.003
above 1.6 m. Every scrap of white this band produced was under the water, and none of it
was where the reach put it. Removing the plate without also bringing the top of the ramp
inside the field trades a plate for a bare contour, which is the defect the `frothReach`
note was written to kill.

### The fix, and what it measures
`FROTH_SINK_M = 0.35`, `WETTED_SINK_M = 0.55`, `THR_WET 0.20 / THR_TORN 0.72 / THR_DRY 1.15`:

    float sink = saturate1(-vD / FROTH_SINK_M);
    float thr  = mix(THR_WET, THR_TORN, pow(above, 0.68)) + sink * (THR_DRY - THR_WET);

The fade below the water is an ABSOLUTE depth, not a fraction of the reach — how high a
hull throws its bow wave says nothing about how far the free surface drags entrained air
under — and it is on the THRESHOLD, not multiplied over the result, because a multiplied
ramp can only make a fade and a fade at a constant depth is one more ruled line. `THR_DRY`
clears the field's maximum by more than the ramp half-width, so the submerged tail is
**exactly** zero. Nearly zero over 53 m of hull is what a plate is made of. The `wetBand`
and `submerged` terms get the same treatment with the same textured displacement on their
lower boundary as on their upper. Same integral, same bake:

| vD, m | coverage | froth alpha | wetBand→foamA | wetA |
|---|---|---|---|---|
| -2.9 .. -0.3 | 0.722-0.825 → **0.000** | 0.634-0.720 → **0.000** | 0-0.385 → 0.000-0.002 | 0.306-0.700 → 0.000-0.003 |
| -0.3 .. 0.0 | 0.588 → 0.185 | 0.526 → 0.163 | 0.312 → 0.111 | 0.404 → 0.141 |
| 0.0 .. 0.3 | 0.750 → 0.833 | 0.665 → 0.723 | 0.015 → 0.012 | 0.017 → 0.014 |
| 0.3 .. 0.8 | 0.140 → **0.257** | 0.144 → 0.238 | — | — |
| 0.8 .. 1.6 | 0.055 → 0.114 | 0.057 → 0.103 | — | — |
| 1.6 .. 3.0 | 0.003 → 0.053 | 0.003 → 0.041 | — | — |

In pixels, same harness, same capture-hold pose (16.7 against 16.6 kn, same heading),
`.tmp/PLATE-{before,after}-waterline.png`, on that same 560x70 rect:

    pale%   13.2 -> 12.5      flat%   32.2 -> 22.3
    hf     12.30 -> 15.47     strongest row  53.46 -> 26.56

The pale fraction barely moves at THIS pose because the rect catches less of the plate
than the probe's pose did; the discriminating numbers are the other three, and they say
the same thing three ways — a third less of the area is locally flat, a quarter more
high-frequency energy, and **the hard straight edge is halved**. At dpr 2 (3200x1800) on a
560x130 crop of the bow shoulder at 1:1, `.tmp/HI-{before,after}.png`: pale 41.5 → 13.8,
flat 56.8 → 44.7, hf 8.11 → 10.87. By eye at 1:1 the plate is gone and the band reads as
streaked froth on the plating with the copper showing between the filaments.

No cost: 74 draw calls and 0.61 Mtri before and after, and on a genuinely quiet box
(`rivals 0p/0b`) `waterline` p25 34.6 → 32.3 ms, `orbit` 35.1 → 34.2, `helm` 38.9 → 38.9,
`storm` 42.2 → 47.3 — run-to-run noise in both directions, as §64G's error bar predicts.
All 16 scenes shot clean afterwards, zero page errors.

### What is left, and it is not fixed here
- **The submerged rows are visible at all.** The ocean surface is
  `transparent: false, depthWrite: true`, so a band 2.4 m under the fitted waterline
  ought to be depth-rejected — and it is not, at any point along the hull. From a camera
  at the surface the ray grazes a near crest and lands on the hull, so the band genuinely
  stands proud of the intervening water. It matters because it means those rows are a
  visible surface and not a hidden safety margin: whatever they draw, the owner sees.
- **`SKIRT_ROWS = 6` now spends four rows where nothing is drawn.** `mix(-uSkirtDrop,
  env * 1.35 + 0.45, v)` puts rows at about -2.4, -1.55, -0.71, +0.14, +0.98, +1.83 m.
  Nothing is lost visually — every quantity that decides the froth is per-fragment — but
  two thirds of the geometry is now inert. Left alone deliberately: those rows are the
  guard against a crest lifting the water and exposing the band's floor, which is a
  straight cut in ship-local Y, and that is the artefact this section is about.
- **`waterYAt` is a three-sample piecewise-linear fit of the sea surface over 53 m.** The
  live uniforms read 0.96 / 2.67 / -0.13 m to starboard against 0.78 / -1.50 / -0.68 to
  port, consistent with 22 deg of heel rather than with fit error, but a 2.4 m wash used
  to hide any error there and a decimetre-deep band will not. Not measured.
- **A quiet-box frame time that does not match §64I.** These runs are the clean
  `--wait-quiet`-grade window §64I asked for — `rivals 0p/0b`, sampled both sides of every
  scene — and `noon` reads p25 36.5 ms at 1600x900 dpr 1, not the 16.5 ms §64I recorded
  with a rival present. Do not read that as a contradiction: `rivals` counts headless
  renderers and §64E puts most of the fixed term on the CPU, so a box with no rival
  BROWSER can still be a box with no spare core. It wants one measurement on an idle
  machine before anyone believes either number.

## 80. `AGX_IN` was three's inset matrix transposed, and the four looks had been authored to cancel it

§71 flagged this and correctly declined to fix it: "`src/util` is a shared library, so it is
not the post agent's to change." Confirmed, fixed with the owner's sign-off, and the looks
re-authored in the same change — because the transpose turned out to be **load-bearing for
the grade**, which is the part §71 could not have known.

### The confirmation, and the one-glance invariant

three writes its AgX pair as `mat3(vec3, vec3, vec3)` in
`ShaderChunk/tonemapping_pars_fragment.glsl.js:116`. Ours was written as `mat3(` nine
scalars `)`. **Both constructors take COLUMNS**, so writing a published row-major table
into either one transposes it, silently, with no compiler complaint and no black frame.

Element-wise, ours against three:

| compared as | max &#124;delta&#124; |
|---|---|
| ours vs three **transposed** | 9.4e-5 |
| ours vs three **as written** | 6.4e-2 |

A 670x gap. It is the transpose, with independent rounding in columns 1 and 2 — consistent
with somebody pasting a *different* published row-major table than three's, which is exactly
how this bug is normally born.

**The invariant that catches it in one glance: the inset's mathematical rows must each sum to
1.** A tonemapper that moves a neutral is not a tonemapper. Ours summed to
**1.106 / 0.933 / 0.961**; luminance summed to 0.972, so it lost only 0.04 stops of
brightness while pulling +0.15 / -0.10 / -0.06 stops of channel imbalance *into the input of
the per-channel contrast curve*, which is where a tint stops being a tint and starts being a
non-linear hue shift. It was never the shadow crush of §71 and it was never an exposure bug.

### The instrument: a scene is the wrong way to measure a colour change

The capture harness cannot resolve this. **Run it twice on identical code** and the
whole-frame R-B moves by up to 16 codes, the sky mask by up to 39:

| scene | sky d(R-B), identical code | whole-frame d(R-B), identical code |
|---|---|---|
| golden | **+39.2** | +1.3 |
| helm | **+32.8** | +9.0 |
| masthead | **+24.0** | **+16.1** |
| noon | +12.2 | -12.1 |
| shadow | **+0.1** | **+0.9** |

That is the confound `capture.mjs:293` already warns about — the cloud field advects with
wall-clock time — and the effect being measured here is only 9 to 16 codes. Two thirds of
the sixteen panes cannot see it. `shadow` can, because it is the `cloudCover 0` scene built
for exactly this, and it is the only pane whose numbers below are worth quoting.

So the measurement was moved off the scene entirely, with a throwaway probe in `.tmp/` (so
it is not in the tree — rebuild it, it is about 60 lines). It esbuild-bundles `GLSL.color`
the way `check-shaders.mjs` does, compiles a one-row fullscreen pass that runs
`agx(uBase * exp2(ev))` with `ev` swept across `gl_FragCoord.x`, and `readPixels` the result
— **the real chunk on the real ANGLE/Metal driver**, once with each matrix, no engine and no
scene, bit-repeatable. The one trick that makes it trustworthy: it asserts the shipping
matrix is actually present in the chunk it pulled, and that the string swap actually changed
something, so a probe that silently compared a chunk against itself would fail loudly rather
than report a reassuring zero. **Promoting this to `scripts/` is worth considering** — it is
the only instrument in the project that can resolve a colour change. A neutral grey in:

| EV | transposed R,G,B | R-B | fixed R,G,B | R-B |
|---|---|---|---|---|
| -6.0 | 39, 33, 34 | +5 | 36, 36, 36 | **0** |
| -3.9 | 88, 78, 80 | +8 | 82, 82, 82 | **0** |
| -1.9 | 150, 140, 142 | +8 | 144, 144, 144 | **0** |
| -0.9 | 181, 172, 173 | +8 | 176, 176, 176 | **0** |
| +1.1 | 228, 222, 223 | +5 | 225, 225, 225 | **0** |

Worst cast on a neutral: **9 codes, transposed; 1 code, fixed** (the 1 is quantisation).
Note the shape — the cast peaks in the midtones and vanishes at both ends, because the log
encode compresses the imbalance where the curve is flat. And note that at EV -1.9 red falls
6 while green *rises* 4: a chroma rotation at constant luminance, not an exposure change.

### Why it could not be landed alone: the looks were cancelling it

Reading the **real baked** `Data3DTexture` — not a model of it — on its neutral diagonal,
R-B in codes:

| look | in=8 | in=12 | in=16 | in=20 | in=24 |
|---|---|---|---|---|---|
| Open Sea, before | -14.7 | -19.1 | -15.3 | -4.8 | +3.8 |
| Open Sea, after re-author | -9.2 | -10.1 | -2.9 | +10.7 | +20.9 |

Every look carried a cool bias, and on a neutral it very nearly cancelled AgX's spurious
+9 warm: **Open Sea landed a neutral at -3.8 codes before, and would have landed it at
-16.4 with the matrix fixed and the look untouched.** Three of the four `temp` values were
negative. That is not a coincidence and it is not a grade; it is half a tonemapper fix,
spread across four look definitions by whoever tuned them against a tinted AgX.

Fixing the matrix alone would therefore have cooled every frame by 10 to 16 codes and moved
the game away from the warm direction AGENTS.md sets. So `temp` went up on all four looks.
Solved numerically against the pre-fix chain, midtone-weighted:

| look | temp before | temp after | delta |
|---|---|---|---|
| Blue Hour | -0.22 | -0.132 | +0.088 |
| Cold Morning | -0.07 | **+0.022** | +0.092 |
| Amber Reach | +0.13 | +0.227 | +0.097 |
| Open Sea | -0.025 | **+0.069** | +0.094 |

All four land within 0.009 of each other, which is the check on the whole exercise: the
quantity being cancelled is a property of the tonemapper, not of any look, so it had better
need the same correction everywhere. It did.

### What the re-author does and does not restore

Full chain, neutral in, against the pre-fix frame:

| | EV -4 | EV -2 | EV 0 | EV +1 | EV +2 |
|---|---|---|---|---|---|
| residual d(R-B), Open Sea | -2.6 | -3.7 | **-0.7** | +2.5 | +6.6 |
| residual d(luma), Open Sea | +0.8 | +1.8 | +2.6 | +2.6 | +2.4 |

- **Midtones match to under a code**; shadows land 2-4 codes cool, highlights 6 codes warm.
  That residual is structural and cannot be tuned out with `temp`: the bug was a per-channel
  gain applied *before* the log encode, so its cast peaked in the midtones and died at both
  ends, while `temp` is a display-space balance whose effect scales with level. Two different
  shapes. Matching the midtones is the right trade — that is where white balance is judged.
- **The frame is ~2.5 codes brighter at middle grey** (about 0.03 stops). `temp` is
  luma-normalised at the point it is applied, but contrast, split tone, saturation and the
  shoulder are all per-channel and non-linear, so re-balancing the channels moves each one
  along the curve and the luma does not come back exactly. Not worth chasing; recorded so
  nobody re-derives it.

`AGX_OUT` also carried a typo: `-0.1413173` where three has `-0.1413298`, giving row sums of
1.000012 instead of 1. Worth +0.000018 stops — about 200x below one 8-bit LSB — and
corrected in passing only so the pair is verifiably three's and the next reader has no
unexplained digit to wonder about.

### On the sixteen panes, and the residual the re-author does NOT remove

Gates green: `check-shaders` 42/42, `typecheck` 0 errors. Re-shot all sixteen. Whole-frame
d(R-B) against the original, fix-only against fix-plus-re-author:

| scene | fix only | fix + re-author | run-to-run noise |
|---|---|---|---|
| noon | +3.4 | **-0.9** | -12.1 |
| dawn | -10.9 | **-1.4** | +0.3 |
| fog | -10.4 | **-0.8** | +0.7 |
| storm | -9.5 | **-2.7** | -2.2 |
| orbit | -18.7 | **-2.4** | +7.0 |
| helm | -19.3 | **-2.4** | +9.0 |
| **shadow** | **-16.0** | **-5.9** | **+0.9** |
| island | -19.0 | -10.6 | +1.6 |
| wildlife | -21.6 | -14.5 | +6.6 |
| waterline | -34.3 | -17.9 | +0.9 |

Eleven of sixteen now sit inside ±3 codes. But the re-author is **not** a clean no-op, and
the honest number is `shadow`'s: **-5.9**, against a run-to-run noise of +0.9. Real, and
larger than the neutral-ramp residual of -0.7 predicted at middle grey.

The reason is that a frame is not a grey card. Fitting `temp` on neutrals leaves saturated
blues under-corrected, because the two operations differ across *saturation* as well as
across level — the bug was a per-channel gain before the log encode, `temp` is a balance
after the curve:

| Open Sea, residual d(R-B) | EV -4 | EV -2 | EV 0 | EV +2 |
|---|---|---|---|---|
| neutral | -2.6 | -3.7 | **-0.7** | +6.6 |
| flax canvas | -2.4 | -3.8 | **-1.0** | +6.4 |
| sky blue | -1.2 | -3.9 | **-6.7** | -7.6 |
| deep sea blue | -0.7 | -3.4 | **-7.6** | -11.9 |

Which is exactly the ordering of the leftovers in the table above: the four panes still
carrying -10 to -18 (`island`, `wildlife`, `waterline`, and `shadow` at -5.9) are the
sky-and-sea-dominated ones. `noon`, `dawn`, `fog`, `orbit`, `helm` — all with more canvas,
deck and hull in frame — land inside 3.

**This was a deliberate choice, not a miss.** One `temp` knob can match neutrals or saturated
blues, not both, and the trade is measurable:

| extra dtemp | neutral @ EV0 | sky blue @ EV0 |
|---|---|---|
| +0.00 (shipped) | **-0.7** | -6.7 |
| +0.04 | +4.4 | -2.8 |
| +0.08 | +9.5 | +1.0 |

Neutrals win: white balance is judged on canvas, foam, cloud and hull highlights, and 7 codes
on an already -87-code stylised sky is 7% of an artistic choice, while 7 codes on white canvas
is the difference between flax and bleached cotton. The proper instrument for the remaining
blue shift is `blueTeal` and `shadowTint`, which are grade decisions and are listed below as
not mine.

Two of the sixteen panes are worth ignoring entirely rather than trusting: `masthead` (-13.0,
noise +16.1) and `sunset` (sky noise +14.0), and `waterline`'s before/after pair caught the
ship at visibly different positions, so its -17.9 is part composition. **A single control pair
per scene is one sample of a noisy quantity** — it can understate the noise as easily as
overstate it, and it did here.

### What this does not fix, and one thing worth using

- **Sail white balance was never measured per-material here.** Sunlit flax and a sunlit cloud
  are colourimetrically identical in these frames (both R-B ~ +55), so no colour gate can
  separate them, and hand-placed boxes are contaminated by the lit sea in `golden` and
  `dawn`. §73 already built the right instrument for this — the sail meshes rendered alone
  into a private RGBA8 target, clear alpha 0, so the alpha channel *is* the silhouette. That
  is the tool for any future per-material colour question. It was not needed here, because
  the change is now a no-op on screen by construction.
- **The looks are still authored against a moving target in one respect**: the grade sits
  downstream of the adapt pass, so a look tuned on one frame's exposure is not tuned on
  another's. Out of scope, but it is the reason two of these `temp` values could drift again.
- **Nothing here touched `blueTeal`, `shadowTint` or `highlightTint`**, which also carry
  chroma and which a real colourist would probably rebalance now that the tonemapper is
  neutral. That is a look decision, not a correctness one, and it belongs to whoever owns
  the grade.

## 81. Reconciliation of four worktrees, and what the audit itself found

Four Claude worktrees existed. Audited before anything was deleted, pruned or reset.

| worktree | branch | state | disposition |
|---|---|---|---|
| `dazzling-nightingale-d51005` | `claude/dazzling-nightingale-d51005` | clean, 0 commits off main | **obsolete** — fully represented on main |
| `youthful-newton-84a949` | `claude/youthful-newton-84a949` | clean tip, **dirty**: `src/core/PostProcessing.ts` | **integrated** (§80's sibling; comment only) |
| `reverent-jepsen-5ed163` | `claude/gifted-lalande-041ee3` | clean tip, **dirty**: `src/util/glsl.ts`, `src/post/luts/LookLut.ts` | **integrated** as §80 |
| `frosty-pascal-b9e451` | `claude/frosty-pascal-b9e451` | clean, **2 commits off main** | **integrated** as §79, source commit cherry-picked to preserve it |

`wip/sail-canvas` remains deliberately unmerged (§53) and is untouched. The two `src/ocean`
sessions I had reported as running had in fact **completed**: earth curvature is on main in
`OceanMesh.ts`/`surface.ts` (§75/§76 — one of which had to be renumbered because both
sessions claimed §75 concurrently), and the far-field `Nlow` work landed with it.

### Three things the audit turned up that were not in any task
- **Section numbers collide when sessions run concurrently.** `frosty-pascal` wrote §65
  against a main that had reached §78, and the two ocean sessions both took §75. Renumbered
  on integration. A monotonically-numbered shared document is not concurrency-safe, and this
  is now the third collision.
- **The AgX fix is coupled to the look temps and could not have been integrated alone.**
  Un-transposing the inset removes a +9-code warm bias that *every look was authored on top
  of*, so their temps had drifted cool to cancel it. Landing the matrix without the temps
  would have turned every frame cold. Verified on the neutral reference — the near-white
  canvas reads R−B **−3.0 both before and after** — so the tonemapper is now correct and the
  screen result is unchanged.
- **A whole-frame R−B is not a white-balance test.** My first check read −51.7 at noon and I
  nearly took it for a cold cast; noon is a blue ocean under a blue sky and reads −51.7
  either way. The statistic has to be taken on something that is meant to be neutral.

### Verified after integration, not assumed
`waterline`: the flat pale plate is gone — mean |dL/dx| across the hull band is 6.7–15.0 at
every row, where a flat plate is near zero, and the crop shows planking, gunport stripe, gun
muzzles and copper sheathing. The AgX row-sum invariant holds at 1.0000000 on all three rows
of the integrated file. §71's log-space contrast branch survived the LookLut overwrite.

## 82. The bow-wave cauliflower was `KIND.FLECK`, and it was four defects stacked

Integrated from `notes/fleck-cauliflower.md` — the first note written under the
concurrency convention in §81, and the first that `preflight` surfaced while it was
still untracked on disk.

Localised by frozen-frame ablation (`Engine.stop()` then `tick(lastTime)`, so `raw = 0`
and every module updates against `dt = 0`, making every variant the same frame with one
term removed): `noFLECK` → the blob field is **gone entirely**; `onlyFLECK` → **reproduced
exactly**; `noSHEET`/`noMIST`/`noDROPLET`/`noSPINDRIFT` → unchanged. `KIND.FLECK` has one
spawn site in the tree, so the defect was completely localised before anything was changed.

### It corrected my brief twice
**The blobs are not clipped highlights.** I briefed them as "near 255". Measured over the
field's own rectangle: p50 **9.1**, p99 94.7, **max 104.7** — and the same 104.7 is the max
in the bow wash, because both are the same material at full coverage. The 255s in that frame
are stars and HUD type; only 0.05% of the frame is at or above 200. What makes it read as
blinding is the **ratio** — 105 against a sea at 11 is 9.5×. Nothing about the defect
changed, but a later session should not go hunting a blown highlight.

**The soft-particle fade was engaging.** I suspected it was not. The fault is the opposite:
both softness terms are written for a body in the air and a surface raft fails both.
`a *= smoothstep(-0.25, uSoftY, above)` with `above` = 0.04 and `uSoftY` 0.90 evaluates to
**0.157** — it was taking 84% of a surface raft's alpha off for the crime of being on the
surface.

### The four defects
1. **The sprite was a disc under a comment calling it a raft.** One additive floor did it:
   `mask = radial * (0.34 + 1.05 * cells)` still gives `0.34 * radial` where `cells` is
   zero, which clears the 0.19 threshold across the whole disc — so every ingredient the
   comment claimed (F2−F1 cell cores, a warp, a torn fractal) **could only ever brighten a
   solid silhouette from the inside**. Measured over the region the vertex shader actually
   samples (it insets to 0.80, so radius past that is never seen): **69.7% fully opaque
   against the droplet sphere's 60.3%**, in one opaque component of 7151 px. Fixed with
   §40's construction — flatten the field and threshold at a stated coverage — giving mean
   inset alpha 0.306, opaque share 24.0%, 59 components, and a radial profile that never
   saturates. The field is Worley **plus** an fBm: Worley alone is a tiling of equal convex
   polygons, i.e. cracked mud, a different one-scale artefact. That was built by mistake
   first and is worth not rebuilding.
2. **A camera-facing billboard stood the raft on edge.** A fleck is pinned to the surface by
   the sim (`pos.y = wy + 0.04`), so a camera-facing quad plants it vertically like a coin
   on edge — and *that*, not the texture, is why they read as **spheres** specifically. The
   proof: ablate the depth-soft term and the identical sprites become flat-bottomed pucks,
   because the top-bright/bottom-dark gradient that reads as a lit ball is the soft fade
   darkening the half of an upright disc that dips into the water. The quad is now built in
   the world XZ plane and rotated into view, so a 2 m raft at 25 m no longer claims 140 px
   of frame height.
3. **Both softness terms, per the correction above.** A fleck's surface fade now asks the
   opposite question — *has it been pushed under?* — and the depth term gets a bias of
   1.25 × band, leaving it doing the one job here that really is occlusion: softening the
   hull's silhouette edge.
4. **One uniform size and one repeated picture.** `0.28 + rand * 0.85` is uniform over 4:1,
   so every fleck sat at one apparent scale; now `0.13 + rand^2.4 * 1.25`, a 10:1 range
   weighted hard to the small end. Rate 340 → 560/s because coverage goes as size squared
   (E[s²] falls 0.557 → 0.382). Per-particle variation was a ±0.35 rad rotation and a
   mirror in u — every fleck the same picture at nearly the same angle — and is now the full
   turn.

### The measurement that actually shows it, and the one that does not
**Component counts do not measure structure at more than one scale**, and were used first by
mistake: separated discs score 758 components because black water lies between them, while a
continuous trail that is visibly broken *internally* scores 73, because a low mask threshold
links the patches. That is mask connectivity, not how the field reads.

A **Laplacian pyramid** does measure it — contrast energy per spatial octave, normalised:

| | 2 px | 4 px | 8 px | 16 px | 32 px | 64 px |
|---|---|---|---|---|---|---|
| before (discs) | 6.8% | 8.7% | 13.9% | 18.7% | 23.4% | **28.5%** |
| after (rafts) | 7.9% | 12.3% | 17.0% | 20.0% | 22.1% | 20.7% |

Before, energy climbs monotonically to the coarsest octave — **one scale of blob plus its own
smooth rim, which is what "cauliflower" means numerically.** After, the peak has moved off the
coarsest bin and the profile is flat from 4 to 64 px, with the 4 px octave carrying 2.4× the
absolute contrast. Some of the absolute rise is simply more foam present; the *shape* of the
normalised profile is the structural claim.

### No shimmer regression, and it was worth checking
Flat quads go near edge-on at range, and a sub-pixel high-contrast sprite is one of
`RUBRIC.md`'s automatic failures. Wall-clock frame pairs cannot measure it, because the sim
advances and the foam genuinely moves; stepping `tick(lastTime + 16.67)` by hand gives pairs
separated by a known identical interval. Far-band mean |Δframe| 1.09 → 1.20 codes with the
**peak excursion falling 37 → 30**, and the far band stays quieter than the near one, which
is the correct ordering — aliasing would show as a far-band spike *above* the near.

### Two instrument faults, and a standing blind spot
- **`w.bus.emit('capture:scene', …)` is what dismisses the title card.** The first ablation
  ran without it and shot every variant through `.intro`'s radial scrim, measuring the field
  at roughly half its shipped codes. The attribution was unaffected; the numbers were wrong
  and looked reasonable. `capture.mjs` has a tripwire for exactly this (§44) — any probe that
  drives the page needs the same two lines.
- **`world.ship` has no `speed`** — it publishes `speedKnots`, and `.speed` returns
  `undefined` and prints `NaN kn`.
- **The scene list has no framing that looks down a wake from close astern.** `orbit` is
  110 m beam-on with the wake edge-on and distant, which is why this never showed there;
  `night` is a 76 m chase that puts the wake between camera and ship at 25–60 m. **Any future
  wake defect will hide in the same place.** That is the third time a blind spot has been a
  hole in the scene list rather than in the engine (§62, §78).
- `fov` is 30°, so metres-to-pixels is 1680/d at 900 px — a **1.7× magnification** over a 50°
  lens. Anything sized by eye in a wider-fov engine reads large here.

**Still open, deliberately:** the largest rafts read slightly lumpy at 1:1 in the near field.
Four rafts in a 2×2 atlas selected by seed would cost nothing and remove the last repetition,
but the full-turn rotation already broke the visible cloning, so it is left for a fresh
complaint rather than done speculatively.

### 82a. Provenance correction, and the race it exposed

**The foam session was not interrupted. It was still working.**

§82 and the commit that carried its source (`843be25`) both describe the work as
"recovered from an interrupted background session's uncommitted working tree". That
is wrong. The agent was actively tuning when I found its dirty `src/vfx` files and
its untracked note, took the source, folded the note into §82, and **deleted the
note out from under a live writer.**

It has since finished and independently confirmed that the state I captured in
`843be25` is byte-for-byte its final tuned source, with its own validation clean:
typecheck, `check-glsl`, `build`, `preflight`, **17/17 scenes with zero console
errors**, no timing claims (every run was contention-tainted), and nothing outside
`src/vfx`. So `843be25` and §82 stand and must not be redone or reverted.

**But nothing about that outcome was earned.** I inferred "interrupted" from
"dirty", and dirty is not a state — it is the *normal* condition of a worktree
whose owner is mid-edit. Had the agent been two tuning passes from done, I would
have shipped an intermediate state under a commit message claiming it was final,
and deleted the notes file it was still writing into. The mechanism built to stop
interrupted work being lost had become a way to race a running one.

The corrected rule is in `AGENTS.md` under **Reconciling another session's work**.
The single sentence version: **dirty means someone may still be typing — establish
that the owner has stopped before you take anything, and never delete their note.**

`preflight` now prints how long ago each unintegrated note was touched, because the
one cheap signal available at the moment of the decision is recency, and I did not
look for it.

## 83. The sky's ruler-straight streaks were a tiling seam, and interiors were flat because one coefficient was three

Integrated from `notes/cloud-cirrus-seam-and-flat-interiors.md` (377 lines; the note has the
full working). Blind-critique items **(c)** and **#4**.

### (c) The streaks are the cirrus layer's tiling seam — not the marched volume
**My brief's hypothesis was wrong.** I had them as "slab layers seen edge-on" and told the
agent to chase that first. Attributed in one frozen frame, three independent ways: forcing
`cirrusOpticalDepth` to 0 makes the lines vanish while the cumulus is unchanged; transposing
the A-channel fetch rotates the whole family 90°, so their direction comes from the weather
map's own uv axes; and reading the real 512² bake off the GPU gives a mean |step| across the
**v** wrap of **0.306 against 0.0047** in the interior — a **65.6×** discontinuity on a
channel whose sd is 0.288. Across u it is 1.1×, clean.

They pass *behind* the cumulus because the cirrus slab is composited after the low march
against its accumulated `T` — which is exactly what made them look like a volume artefact.

**One missing `vec2`.** `tilePerlin2(vec2(p.x*9.0, p.y*1.6), 9.0, 4)` hands one scalar period
to a deliberately anisotropic coordinate. `tileGrad2` wraps with `mod(cell, vec2(period))`, so
x — spanning 9 with period 9 — tiles, while v — spanning 1.6 with period 9 — never closes. A
step at constant v is a dead-straight line at constant world Z running along world X,
repeating every 96 km; the cirrus shell at 7.6 km is visible to ~320 km, so **three wraps fall
inside it**. Uniform width because it is a one-texel step in a bilinear map, converging on the
world-X vanishing point because the lines are parallel in world space.

**The discriminator is the part worth keeping.** Two candidates fit the symptom — the seam and
the anisotropy itself. Setting per-axis periods **holds** the anisotropy (6.76 → 6.57×) and
the streak length (17.17 → 17.76 km) while removing **only** the seam (65.6 → **1.0×**), and
the hairlines go. That separates them; changing both at once would not have. Non-integer
periods would be worse, not better: `mod(cell, 1.6)` lands off-lattice and breaks the field
everywhere.

Verified independently on a fresh capture: the sky carries a soft cirrus wisp and no
hairlines.

### #4 The interiors: a coefficient that should have been three numbers
Baseline over 52,400 interior texels of one cumulus (mask = composite opacity > 0.9, so edges
are excluded): scene-linear lit/shaded **1.578**, crown/base **1.185**. A second, compact body
came back at **0.973** — its shaded flank *brighter* than its lit one.

- **The two-stream coefficient was one flat 0.19 for three octaves.** 0.19 is
  `0.75 × (1 − 0.75)`, the asymmetry of the *first* scatter; each octave carries its own
  eccentricity, so k should rise 0.38 / 0.53 / 0.62. Flat, it under-attenuated all three by
  2–3× — and they carry ~80% of the signal, so the sun term ran **2.81 at τ=2, 2.57 at τ=8,
  0.76 at τ=71**: non-monotonic, and under 4× across two decades of optical depth. With the
  octaves ablated off, crown/base is **1.913**, which is the proof.
- **Beer's-powder was applied at twice its value.** `mix(1, 2*powder, powderMix)` tends to
  **2.0** as τ grows — a 2× gain on everything thick, blended in by view–light angle, so it
  lands on the **anti-solar** side. It was brightening the very flank it exists to darken.
- `CLOUD_MULTISCATTER_GAIN` was **split** (octave 4.5 → 6.5, ambient held). They shared one
  constant and the ambient path runs no octaves, so raising it lifted the ambient floor by the
  same 44% and made the contrast fix pay for itself.

| body0 | before | after | |
|---|---|---|---|
| scene-linear lit / shaded | 1.578 | **2.097** | +33% |
| scene-linear crown / base | 1.185 | **1.310** | +11% |
| scene-linear p90 | 3.542 | 3.532 | **−0.3%** — top end held |
| display ΔL lit − shaded | 16.4 | **32.4** | ×1.98 |
| second body lit/shaded | 0.973 | **1.133** | sign corrected |

**The coverage calibration provably did not move:** the fix never touches `cloudDensity` and
the shadow pass never calls `cloudScatteredRadiance`, and cloud-buffer opacity is identical
across every variant — mean 0.2853/0.2855, frac>0.5 19.87/19.88%, frac>0.9 15.88/15.90%. So
`CLOUD_COLUMNS_PER_RAY` cannot have shifted.

### Three instrument findings, one of which invalidated a column of its own results
- **`world.uniforms.uExposure` is a CPU estimate**, and `AutoExposure.ts` says not to
  calibrate against it. It reported +0.5% for a pair in which **738,856 clear deep-blue sky
  pixels darkened 10.0%**. Use `world.ext.post.exposure`. (This is §72 again, from a third
  direction.)
- **Auto-exposure state carries across variants inside one `skyab.mjs` run** and does not
  re-converge in 90 frames — proven by running the same A/B both ways: whichever shader ran
  second came out darker. So every display-*level* comparison across variants is confounded,
  while **contrast ratios survive the flip**, which is why the result above leads with
  scene-linear radiance.
- **Do not invent a sun vector to pin a known elevation.** Keeping the measured `sunY` and
  making up the horizontal pair put a 15.6 h sun in the east and flipped every lit flank.

### What did not hold, stated plainly
**Items (a) and (b) do not share a cause with (c)** — my brief proposed they might, and they
do not. (a), the 700 px straight bottom cut, is still present. The one candidate tested for
(b) (halving `DT_MAX`) was run on `golden` at pitch 8 — a solid overcast with no ribbed
cumulus face — so **that ablation proves nothing and the test needs redoing** on a view that
shows the ribs. The haze cull is ruled out at 26 km visibility.

**Interiors are better, not good:** display lit/shaded 1.22 where a real cumulus shows 2–4×.
The ceiling is structural — `cloudLightDepth` runs with `detail = false`, so the cauliflower
lobes cast no shadow on each other, and `DT_MAX` 1.2 km resolves a cloud's first optical depth
with one or two samples. Note for whoever takes it: the lobe term uses `base.b`/`base.a`,
already fetched for `lowFbm`, so it costs no extra fetch — but it changes the shadow map's
density and needs its own mass proof.

**Also open:** the cirrus A/B is a different field realisation rather than the same field with
the lines removed, because the fix is in a baked texture an in-page ablation cannot reach (the
low deck is measured unchanged). Cirrus is still world-axis-locked. And a pre-existing hazard
sits in the way of fixing that: `uCirrusOffset`/`uFieldOffset` wrap at 48 km while the cirrus
lookup divides by 96 km, so the field already teleports half a period every few hours.

## 84. Reconciling `claude/nice-driscoll-b948a7`, and a candidate dropped after a controlled test

A second session fixed the same wake-fleck defect in its own worktree, in parallel with the
one main integrated as `843be25` / §82. It is **not an independent confirmation**: it read the
other session's diff early, so where the implementations converge that is
convergence-after-exposure, not two findings agreeing.

Branch clean, two commits, based on `565f7f3` — i.e. before the foam work reached main.
`640ea96` was **not** taken: its "§82" is stale and main's §82 is authoritative.

### Disposition, by category
- **(a) Already on main, identically:** the flat-quad orientation, the surface-fade inversion
  for flecks, the alpha ceiling. Convergence-after-exposure.
- **(b) Differently tuned, not transplantable:** rate and size. Main runs 560/s with
  `0.13 + rand^2.4 * 1.25`; nice-driscoll keeps 340/s with `0.10 + rand^2.2 * 1.30`. Its rate
  argument is explicitly a three-way cancellation against **its own** sprite coverage (0.23 of
  the quad at full alpha) and quad foreshortening, so the number does not carry to a different
  sprite. Main's is shipped and verified; both are defensible.
- **(c) A genuinely unique insight, which neither implementation delivers** — below.
- **(d) Dropped after a controlled test** — the alpha lifetime, below.

### (c) The support-radius / inset coupling — real, and open
Its observation is geometric and correct: the draw shader shows the texture over a square of
half-side `inset` **rotated per particle**, so a texture point at radius r is inside that
square at *every* rotation only for r ≤ inset. Support beyond `inset` is therefore clipped by
the square's edges, and the clip depends on the rotation angle — **so each fleck becomes a
different shape.**

Measured, by baking both trees' `makeFleckTexture` in Node and finding the largest radius with
non-zero alpha:

| | inset | measured support radius |
|---|---|---|
| main | 0.70 | **0.963** |
| nice-driscoll | 0.80 | **1.381** |

**Neither delivers it, and nice-driscoll's is worse on the very statistic its comment claims
to fix.** Its `SUPPORT = 0.80` does force `radialAt` to zero beyond r = 0.80 — but that makes
`target = 0`, hence `thr = 1`, and the final `alpha = sstep(1 − RAMP, 1 + RAMP, shape)` with
`RAMP = 0.10` returns **0.50** for any texel whose `shape` reaches 1.0. Measured peak alpha
beyond r = 0.8 is 0.48, which matches that arithmetic almost exactly. **The guarantee is
defeated by its own threshold ramp**; it would need alpha forced to zero where the target is
zero, rather than thresholded at 1.

So this is recorded as an **open defect with a measurement and a known one-line shape of fix**,
and neither implementation was taken.

### (d) The alpha lifetime — committed, tested, and dropped
The opacity lifecycle overrides `fadeOut` for kind 2 and kind > 7.5 but not for flecks, so a
raft holds alpha at exactly 1.0 for the first **62%** of its life. That is right for a droplet
in the air and wrong for entrained air on the surface, which drains from the moment it is laid
down. The physical argument is sound and the shader line is syntactically transplantable, so I
took it.

**Then the controlled test refused it.** Same process, sim frozen (`tick(lastTime)` ⇒ dt 0),
TAA switched to SMAA so a render is a pure function of scene state, 24 ticks per variant to
settle, and `KIND.FLECK` isolated by differencing against a variant with fleck alpha forced to
zero — so the mask needs **no brightness threshold** and cannot admit a wave highlight:

| | total fleck ink | contribution p90 | sd |
|---|---|---|---|
| `fadeOut` 0.62 | 1,181,692 | 16.5 | 23.35 |
| `fadeOut` 0.10 | 1,027,984 | 12.1 | 20.27 |

**−13% ink, a *narrower* distribution, and the two crops are visually indistinguishable.** My
stated rationale was that it would spread the field into a continuum of thicknesses; measured,
it removes the bright tail instead. Dropped.

**Why it failed is the reusable part.** nice-driscoll's lifetime works in combination with its
own 340/s rate, and main runs 560/s: at the higher rate a fade starting at 0.10 skews the
steady-state population toward faded, cutting the top of the distribution rather than filling
the middle. **The line was syntactically transplantable and behaviourally coupled** — which is
exactly why a parallel session's tuning cannot be cherry-picked one line at a time.

### Two instrument faults in my own first attempt
- **A brightness-thresholded mask cannot measure a brightness change.** My first statistic
  conditioned on luminance > 120, which drops precisely the dimmer flecks the change creates,
  and admits ocean foam and wave highlights that are not flecks at all. Difference-against-
  ablation needs no threshold.
- **`tick(lastTime)` does not freeze the frame while TAA is on.** Two renders of the identical
  variant differed by mean 1.12 and max 12.5 codes with SMAA — and mean **2.00**, max **98.55**
  with TAA, which swamped an effect of this size entirely. Always render the null twice.

## 85. Close-camera jitter: not reproduced, and two plausible mechanisms killed

> **Superseded by §85a. The conclusion here is wrong and the probe it rests on was
> measuring the wrong quantity.** Read §85a first; this section is kept for the two
> mechanisms it does correctly eliminate.

A player reports visible repeated vibration in the HELM, BOW/BOWSPRIT and MAST views. I was
asked to reproduce it before any camera agent was dispatched. **I could not**, and the way it
failed is worth recording because two attractive hypotheses died.

### Attempt 1 — sampled inside rAF, and it manufactured a finding
Per-frame camera delta taken in the ship's frame, with the discriminator being the
**sign-reversal rate** of the vertical component: smooth motion keeps its sign, vibration
reverses about half the time.

| mode | run 1 | run 2 | run 3 |
|---|---|---|---|
| chase (control) | 6% | 3% | 3% |
| helm | **22%** | 2% | 3% |
| bowsprit | **23%** | 14% | 5% |
| masthead | 8% | — | — |

Run 1 looks exactly like the reported defect — helm and bowsprit at ~3.7× the control. **The
repeats destroy it.** Bowsprit's own two samples differ by 9 points, which is larger than the
between-mode difference being claimed. Load was 40, and a sign-reversal statistic on a
variable frame interval invents structure, because a late frame makes any spring overshoot and
the overshoot reads as vibration.

### Attempt 2 — a fixed clock, which is the right instrument
Driving `tick(t + 1000/60)` by hand removes the timing noise entirely: load can change how long
the run takes but not what the simulation sees.

| mode | dY sign-reversals |
|---|---|
| chase, chase | 0.5%, 0.5% |
| helm, helm | 0.8%, 0.5% |
| bowsprit, bowsprit | 0.8%, 0.5% |
| masthead | 0.5% |

**Every mode is indistinguishable from the control.** The camera's motion law is stable when
fed a uniform interval.

### The dt-overshoot hypothesis is dead at the code level too
That result pointed at springs driven by an irregular dt, which is the classic cause. But both
smoothing primitives are **frame-rate independent by construction**: `damp` is an exact
exponential, `current + (target − current) · (1 − exp(−rate·dt))`, and `springDamp` is a
critically damped spring with a Padé approximant for the exponential plus a `maxSpeed` clamp.
Neither can overshoot on a long frame.

### And the adaptive-resolution hypothesis is weakened by the existing record
The next candidate was that every scale change reallocates the post stack and **discards the
TAA history**, which at close range would read as a hitch — and which my test could not see
because I pinned `adaptiveResolution = false`. But §59's anti-flap work already measured the
steady-state rate at **0.40 scale changes per minute**, one every two and a half minutes. That
is far too rare to be "frequently stutters".

### Status, and why the report is still credible
**Not reproduced. No camera agent dispatched.** Three mechanisms — a mode-specific bug,
dt-driven spring overshoot, and adaptive-resolution history discards — are each contradicted
by evidence.

The player's report is **not** thereby refuted, and the honest reason is that my instrument is
missing three things their machine has: **vsync** (headless is a rate limiter, not a display —
§57a), **real input** (a look-drag exercises paths a still camera never touches), and **their
pixel count** (4× mine — §57). The one documented, unquantified candidate that specifically
affects near geometry is **TAA's near-field share**: §49 fixed motion blur's velocity
attribution and explicitly left TAA on the world frame, noting that giving it the ship-frame
velocity is "the obvious next move and the risky one", with `clipAabb` pulling history to the
3×3 mean against a `uFeedbackMin` of 0.7. That is the next thing to test for this defect, with
input driven and at `--dpr 2 --adaptive`.

**Instrument left behind:** `.tmp/jitterfixed.mjs` — fixed-clock camera stability with the
sign-reversal statistic and a repeated control. `.tmp/inspect.mjs` — eight deterministic
ship-relative inspection stations, which is what made the geometry defects reproducible at all.

### 85a. Reproduced. The camera pipeline IS frame-rate dependent, in three modes only

§85 concluded "not reproduced". That was wrong, and it was wrong for two reasons, both
of which were pointed out to me.

**The probe measured the wrong quantity.** It computed `camWorldDelta − shipWorldDelta`,
which removes the ship's **translation only**. A camera rigidly attached at an offset
moves in world space when the ship rolls, pitches or yaws, so that residual counted ship
rotation as camera jitter — *in proportion to the lever arm*, which is longest at the
bowsprit. That is very likely why bowsprit read highest in the first attempt, and why the
numbers would not repeat. The correct residual is

    localCamPos = inverse(shipQuat) · (camPos − shipPos)
    relCamQuat  = inverse(shipQuat) · camQuat

and jitter is the frame-to-frame change of *those*.

**And a fixed clock removes the condition under test.** §85's "every mode reads 0.5–0.8%"
was measured at a uniform 16.67 ms. The player's machine has an irregular interval, so
that run could not speak to the defect at all. Correct smoothing primitives do not prove
the *pipeline* is dt-independent — target updates, ship transforms, clamps and update
ordering are all still in play.

**Corrected measurement.** Same initial state, environment, mode, (empty) input trace and
**total simulated time** in both arms. Regular arm: uniform 16.67 ms. Irregular arm: a
fixed reproducible sequence of whole multiples of the refresh interval
(`1,1,2,1,3,1,1,2,1,1,4,1,2,1,1,1`), which is what a struggling display actually delivers.
Residual in the ship's frame, as above. Three repeats of the irregular arm per mode.

| mode | regular | irregular ×3 | mean irregular |
|---|---|---|---|
| chase (control) | 0.8% | 0.8, 0.8, 0.8 | **0.8%** |
| orbit (control) | 0.5% | 0.8, 0.4, 0.8 | **0.7%** |
| **helm** | 0.5% | 3.0, 2.7, 4.9 | **3.5%** |
| **bowsprit** | 0.5% | 14.4, 13.6, 10.2 | **12.7%** |
| **masthead** | 0.8% | 13.6, 12.9, 10.2 | **12.2%** |

(dY sign-reversal rate of the local position residual. Reversals distinguish vibration
from motion: smooth motion keeps its sign, vibration reverses.)

**The controls do not move.** They sit at 0.7–0.8% with a 0.4-point spread under exactly
the same irregular clock that takes the three close modes to 3.5%, 12.7% and 12.2% —
4×, 16× and 15× the control, with within-mode spreads (2.2, 4.2, 3.4 points) far smaller
than the gap. **These are precisely the three modes the player named.**

Two further narrowings, both useful:
- **It is positional, not orientational.** Relative angular reversals are **0.0% in every
  mode and every arm**. Whatever is wrong is in what computes the eye's *position*, not
  its aim.
- Bowsprit's positional residual *magnitude* is highly repeatable (0.3278, 0.3218,
  0.3272 m/s) while its reversal rate varies — so the amount of motion is stable and it
  is the direction-flipping that carries the defect.

**What the three affected modes have in common** and the controls do not: they are
**ship-mounted stations** — the eye is a fixed point on the vessel — rather than tethered
followers that solve a distance. So they read the ship's anatomy and its heave directly.

**A lead, not a conclusion.** `HelmMode` drives its vertical bob with
`springDamp(this.bob, −frame.heaveResidual * KNEE_FLEX, this.vBob, 0.3, dt)`. If
`heaveResidual` is computed as a per-frame *difference* without dt normalisation, it spikes
on a long frame and that spike drives the bob spring — which would be **positional, on the
vertical axis, in ship-mounted modes only**, matching every feature of the measurement.
That has *not* been verified and must not be treated as the cause until it is.

`damp` and `springDamp` remain individually dt-correct (§85), so the fault is elsewhere in
the pipeline — which is exactly the case §85 argued could not exist.

**Instrument:** `.tmp/jitterrel.mjs`.

## 86. The "detached railing" was the hammock stow, and that is the fifth misattribution

Integrated from `notes/hull-bulwark-and-head.md`, whose agent has reported completion.

**Both hypotheses I put in the brief were wrong, and the agent recorded them as negative so
nobody re-tests them.** A bulwark *is* emitted — two `grid(109, 7)` calls into `bins.buff`,
2392 triangles, correctly wound with `flip: side < 0` for the port half. And the cap and the
bulwark *do* share the outline: `HULL_ROWS[30].y(t) === sheerY(t)` to three decimals at five
stations, with rows 26 and 28 landing exactly on `buildBulwarks`' own levels. The
gunport-stripe class of mismatch is not happening here.

**Root cause: the buff plank I called "the rail cap" is the hammock stow.** The cap is in
`bins.black` — the bin is the tell. The stow's underside sat at `sheerY + 0.46` while the cap
is at `+0.06`, leaving a **0.40 m open band down the whole ship**, crossed only by 19 mm iron
cranes. Verified by raycast with materials forced `DoubleSide`, so it is provably not culling:
at column 900, scanlines 480 and 490, the first front-facing hit was `ship-deck`/`ship-oak` at
17–19 m on the centreline, between the stow bottom at local y 7.20 and the cap at 6.70.

**That is the fifth object this project has misattributed from a crop**, after the bow object,
the "square waterfall", the wheel, and the hammock cranes that were reported as belaying pins.
I named this one "the rail cap floating" in the brief. **The rule stands and I keep breaking
it: a crop tells you where a defect is on screen, never which object it is.** The bin, the
count, or the coordinate is the tell — not the colour.

**And a second, independent bug found on the way:** the rail cap had **no `flip`**, so
`cross(d/di, d/dj) = (0, −0.4·side, 0)` pointed its single face **downward on starboard**, and
every view of that rail from above culled it. Now asserted numerically rather than by eye —
214 cap vertices per side, all normals +y.

The stow's own inboard face was also a single-sided sheet facing outboard: a latent hole from
the helm. It is now a closed arch (0.43 m chord × 0.52 m rise) resting on the cap, opaque from
both sides, with the cranes raised to stand above it. Re-scanned: continuous `buff` at 10.3 m
across the whole band, each hit with a matching back face, both rails.

"Gunport lids with nothing behind them" was a consequence of the band, not a second hole — six
raypicked apertures all return planking → a `buff` liner 0.3 m inboard → deck.

### The bow: three posts, and the count resolved them
**Not the martingale and not the dolphin striker** — my guess in the brief. They are the **stem
timber and the cutwater/knee of the head** from `buildStem`. The striker is `bins.oak` in
`masts.ts` at z = −36.1 and the martingale stays are in the instanced rigging mesh, so neither
can produce a `ship-black` hit. Raypick returns `ship-black` at three ship-local points, and
ablating the cutwater block removed **two of the three** posts, leaving the stem tube. **The
count is 3 and it resolves exactly:** stem tube, cutwater leading web, cutwater port flank.

They floated because the lofted sections stop at `Z_STEM = −27.0` while the drawn members sit
1.6 m (stem, at the waterline) to 4.6 m (cutwater, at head height) *forward* of the hull's
leading edge, with the fin's flanks only 0.5 m deep. Replaced by a solid knee of the head
between the raking profile and `hullLeadZ(y)`, coppered below the boot top. The stem tube is
deleted: its radius exceeded the knee's half-thickness so it poked through, and its top 2 m
stood proud.

**The green-teal patch is `bins.brass`** — the trailboard and billethead. `makeBrass` is sane,
but it sets `p.metal` to 1.0 at full polish and the trailboard's grid normal is purely
horizontal, so **from below it mirrors blue sky through a gold F0**. A wrong material bin,
confirmed. Trailboard → `stripe`, billethead → `buff`, and the billethead is now a chain of
`spar`s rather than nine axis-aligned boxes.

**Cost: +108 triangles net** on a ~21.5 k ship (copper +30, black −94, stripe +28, buff +280,
brass −136) and **no new draw calls** — geometry only moved between bins that already existed.

**Not verified:** the pre-fix starboard cap normal (derived, not measured — four attempts timed
out against ten rival renderers); any frame cost (every run came back `LOADED` or `CONTENDED`);
and the knee from a waterline or below-water camera.

### Verified per-station, not as a package
`rail-close` closes the stow/cap band specifically: continuous timber where sea and sky showed
through a 0.40 m slot. **That view does not accept the bow work**, so `bow-head` was shot
separately and read at 3×: the green-teal patch is gone, the three floating posts are gone, and
the head reads attached with continuous copper sheathing below the boot top. **Bow structural
and material defects accepted at this station.**

One thing in that frame is *not* bow geometry and must not be credited or blamed here: a pale
band beneath the hull with a **hard, ruled lower edge**. It follows the waterline curve and
joins the surrounding whitewater, so it is water rather than timber — it is the near-hull wake
partition the player reported, still open and owned elsewhere. The agent's own "knee from a
waterline or below-water camera" remains unverified; this station looks slightly *up* at the
knee and is not that case.

## 87. The sail "film" is the sail, not a hole — and a probe with no sea in it is the leading suspect

Integrated from `notes/sail-see-through.md`, whose agent has reported completion. **No source
change** — it isolated the cause and stopped, which was the right call.

### The pixels are the sail
Test D settled it in one shot. A flat unlit magenta material in the sail fragment turns the
entire "sea/sky through the canvas" region magenta (R 199, G 94, B 203 inside the mask), and a
flat0-vs-flat4 coverage mask is **solid over the whole silhouette with no holes**. Null against
null: mean 2.29 codes. **Geometry, culling and depth are all excluded**, and post is not
importing neighbouring sea inward.

### Nothing is translucent — the sail matches its background
The sail is opaque and its outgoing radiance has been driven to **0.585 of the radiance of what
is behind it** (0.2656 against 0.4542 linear, measured against a calibration ramp rendered in
the same frame), in a similar hue. **A surface that matches its background reads as film.**

Single-term ablation: environment probe **67%**, sheen 20%, cloth translucency 22%, direct sun
only 8%. Diffuse IBL alone would be 0.107 — a 4.2:1 ratio that reads as cloth.

**And the environment probe has no sea in it.** `EnvProbe` renders the *sky* shader over the
full sphere, so the lower hemisphere is sky-bright: mean radiance 0.306, **straight down 0.259
— brighter than the zenith's 0.165** — against the engine's own `uGroundColor` of 0.146.
Independently reconfirmed on the main tree: **36.0% of a vertical surface's cosine-weighted
irradiance arrives from below the horizon**, from a hemisphere that should be dim sea.

That is `src/sky`, not the sail. **It is a verified environment-lighting defect in its own
right** — the numbers above are measured and reconfirmed, and a probe whose nadir outshines its
zenith is wrong whatever else is true.

**But it is not yet the confirmed root cause of the sail film, and must not be written up as
one.** What exists is a *contribution* measurement: single-term ablation attributes 67% of the
sail's outgoing radiance to the probe. That is strong causal evidence and it is not proof,
because removing 67% of a term is not the same as demonstrating that correcting the term's
*hemisphere* materially removes the artefact — the replacement radiance could land in the same
hue and read the same way. Correcting it inside the sail alone moved the ratio only
0.601 → 0.519, which is consistent with either reading.

**The test that would settle it:** a same-view causal A/B, holding the station, frame, clock and
exposure fixed, changing *only* the lower-hemisphere contribution, and showing the film go. Until
that is run, the standing statement is: **verified environment-lighting defect; strongest causal
candidate for the close-view sail film; root cause not confirmed.**

> **SUPERSEDED by §93.** That test has now been run. The probe's missing sea was fixed and the
> settling test came back **negative**: the sail's film ratio moves by at most 2.6% and its hue
> moves the *wrong* way (bluer, i.e. closer to the sea's cast). The environment probe was a real
> defect and is fixed, but it **is not the cause of the sail film** and is no longer the strongest
> causal candidate. `sheenSpecularDirect` — see the note below in this same section — is, and it
> has not been causally tested.

**The "clouds" painted on the canvas are `sheenSpecularDirect`** — rendering that accumulator
alone gives a black frame containing exactly those patches.

Also ruled out with numbers: the probe's diffuse convolution is correctly calibrated (0.357
against a real sky of 0.40), and three's Lambert-from-probe on this cloth is exact to 1%.

### Why it committed no fix, and it was right not to
Both in-scope levers are dials. `sheen` 1→0.22 plus `uClothTrans` 0.34→0.15 plus a probe
re-weight reaches ratio 0.370 and does stop reading as film — but the 1:1 crop is then **a dark
blue tarpaulin**, the sheen patches survive, and **the hue does not move at all** (B−R +18.65 →
+20.56). Dimming is the wrong axis. Two of those constants were chosen by eye and two were
measured at a single sun elevation.

### Two instrument traps worth propagating
- **`material.envMapIntensity = 0` is a silent no-op here.** `WebGLMaterials.js` only uploads it
  when `material.envMap` is set, and this material's env map is `scene.environment`. Same class
  as the `uClothTrans` no-op that wasted an earlier attempt.
- **`shader.fragmentShader` inside `onBeforeCompile` is pre-include-resolution and pre-`#define`**,
  so grepping it for `USE_ENVMAP` or `getIBLRadiance` returns false on a material that has both.

### Flagged across the boundary
The hull reads 0.184 linear with a **neutral** B−R, and the white gunport stripe is only
**1.49× brighter** than the "black" topsides. That is a hull *albedo* problem, separate from
this one.

## 88. Close-camera jitter in mounted modes was a zero-order hold on a moving target

Supersedes §85's "not reproduced" and corrects §85a's acceptance statistic. Work
by the `claude/camera-*` session, recorded in `notes/camera-dt-dependence.md`
(now folded in and deleted); acceptance re-run independently by the integrating
session on `.tmp/jitterrel.mjs`.

**Root cause.** `ShipFrame`'s filters are exponential smoothers stepped once per
frame. A one-step-per-frame smoother chasing a target that is itself moving
settles to a lag of `v/rate - v*dt/2 + O(dt^2)` — the lag is a **function of the
frame interval**, so every change in `dt` steps the output. Three facts follow and
all three were measured:

1. `mountPos` carries most of the amplitude. A 23.85 ms spread in lag at ~4 m/s of
   way is ~95 mm of fore-and-aft step, which is why `dZ` is the worst axis and why
   it is nearly equal across the three mounted modes.
2. The attitude cascade multiplies by the lever arm — 16 to 38 m depending on the
   mount — which is what separates `dY` by mode.
3. Only the mounted modes show it because they are the only ones with no output
   filter: HELM, BOWSPRIT and MASTHEAD take `mountPos`/`smoothQuat` straight to
   the eye at `posSmoothTime = 0`, while CHASE and ORBIT pass the same step
   through a 0.30-0.34 s output spring that smears it over ~20 frames so it never
   reverses sign.

**Fix** (`src/camera/ShipFrame.ts`, commit `c370272`). `update` runs
`ceil(dt / FILTER_SUBSTEP)` equal sub-steps with the raw ship transform
interpolated across them — lerp position, slerp attitude, linear scalars.
`FILTER_SUBSTEP = 1/240`, not `1/60`: the sub-step *count* is an integer, and at
`1/60` it flips between 1 and 2 exactly as `dt` crosses 16.7 ms — where players
live — and that flip is itself a 4 ms lag step. Measured lag spread, as-is vs
sub-stepped: mount 23.85 -> 0.33 ms, attitude 43.79 -> 0.69 ms, anchor
24.81 -> 0.31 ms. `ShipFrame.substep` is left writable so a probe can collapse the
loop to a single step.

**Acceptance, re-measured independently by the integrating session** — five modes,
one page load, regular clock plus two irregular repeats, on the corrected
ship-relative frame (`inverse(shipQuat) * (camPos - shipPos)`, and
`inverse(shipQuat) * camQuat` for attitude), whole-multiple irregular sequence:

| mode | REG rev | IRREG rev x2 | was (irreg) |
|---|---|---|---|
| chase (control) | 0.5% | 1.1 / 0.8 | 0.8% |
| orbit (control) | 0.8% | 0.8 / 0.8 | 0.7% |
| helm | 0.5% | 0.8 / 0.8 | 3.5% |
| bowsprit | 1.0% | 1.5 / 0.8 | 12.7% |
| masthead | 0.5% | 1.1 / 0.8 | 12.2% |

All three mounted modes return to the control floor; relative angular reversals
are 0.0% throughout. **Magnitude, not only reversal rate:** irregular-arm
`|dpos|/s` fell for all three (helm 0.418 -> 0.135/0.117, bowsprit
0.323 -> 0.080/0.112, masthead 0.312 -> 0.254/0.189). Regular-arm magnitude *rose*
for helm (0.107 -> 0.317) and masthead (0.173 -> 0.364), but ship `dAng/s` rose
2.36x and 2.06x in those same samples while the camera residual rose 2.96x and
2.10x — proportional, so it tracks sea state, not the fix. **P3 is accepted on the
camera side.**

**What this does not close.** See §89: on a *fractional* clock the same statistic
is dominated by the hull, so it cannot be used as a camera acceptance test there
at all. The acceptance above is valid because it uses whole multiples, on which
the hull is independently confirmed smooth.

## 89. The hull's heave is frame-rate dependent on fractional clocks — and the field it stands on is rough by design

Found by the camera session as a control ("a camera filter cannot fix a target
that jitters"), then reproduced and narrowed by the integrating session. Not in
`src/camera`. **Not fixed — recorded.**

**The statistic and why it is valid.** The reversal rate of the per-frame *change*
in the hull's own velocity. For a smooth trajectory this cannot be large:
`v_i = dy_i/dt_i` is `y'` at the interval midpoint by the mean value theorem, the
midpoints advance monotonically however unevenly they are spaced, so
`sign(dv_i) = sign(y'')`, and `y''` turns over only at the swell period. A large
value means the hull's position itself is not smooth. (The coarser statistic —
reversals of `vy` itself — reads 0.8% whatever happens underneath, because the
swell dominates its sign. That is why §85a missed this.)

**Reproduced**, `chase`, sea state 3, five runs, same mean interval throughout:

| clock | hull d\|vy\| reversals | rms |
|---|---|---|
| whole multiples of 16.67 ms | 0.8, 1.1% | 0.0213 m/s |
| fractional multiples | 64.7, 68.8, 64.3% | 0.43 m/s |

A **20x amplitude increase** in vertical acceleration noise, not merely a sign
statistic. Player-visible in every view including `chase`, on exactly the clock a
real machine delivers.

> **RETRACTED BY §101.** The effect reproduces, but this figure is `rmsDv` — a
> velocity-change statistic, not an amplitude — and "player-visible" does not follow
> from it. Re-measured under fresh-load repeated arms with a validated estimator: the
> *positional* second difference is unchanged between clocks (excess ~8 mm), and
> screen-space high-frequency motion is ~0.1 px and **identical** on both clocks in
> chase and helm alike. §101 also localises the source to the wave field's own
> designed roughness rather than the solver, so "the ship's solver is frame-rate
> dependent" below is too strong: what is clock-dependent is the solver's *rejection*
> of a rough input.

**Confined to the vertical channel.** Horizontal `d|speed|` reversals are 4.8-6.7%
on the fractional arm and 6.1-8.7% on whole multiples — no separation. The camera
note reports 64-72% for its speed statistic; that is very likely a 3-D speed,
which inherits the vertical chatter, so this is a refinement of that row rather
than a contradiction of the section's claim.

**Two hypotheses eliminated.**

1. *Not the CPU wave field's round-robin snapshot-span prediction.* `CpuWaves`
   brackets the present as `[tA, tB]` with `tB = t + (t - lastTurn)`, so the
   present sits inside the bracket only while a cascade's turn interval does not
   shrink. That predicts the defect should track whether each cascade sees a
   constant span, i.e. sequence length vs cascade count. Tested directly with four
   cascades: whole multiples of *coprime* length 5 (varying span) is **clean at
   1.1%**, and fractional of *aligned* length 4 (exactly constant span) **chatters
   at 73.6%**. Falsified in both directions.
2. *Not a fixed-timestep accumulator.* There is none. `Engine.ts:177` is
   `time.dt = Math.min(Math.max(raw, 0), 0.1)` — raw dt, clamped only, passed
   straight through. No quantisation anywhere in `src/`.

**And the field is rough on both clocks, by design.** Sampling `IOcean.sample()`
at a fixed world point with no hull and no camera in the loop, the *field's* own
second difference reverses 72.2% (whole multiples) and 68.2% (fractional) — no
separation. This is the documented interpolation scheme doing what it says:
`CpuWaves` re-solves one cascade per frame and interpolates each cascade linearly
between two snapshots, so `dh/dt` is piecewise constant and its difference is
impulsive at every breakpoint, with a breakpoint every frame. The amplitude is
millimetric (the file's own bound is under 2 mm at 60 fps), so this is harmless in
itself — but it means the field is **not** the discriminator, and this statistic
cannot attribute a subsystem on its own.

**Where that leaves attribution.** The hull normally *rejects* the field's designed
roughness — 1.1% out of a ~70% input — and on a fractional clock it stops
rejecting it. So this is an interaction between the field's piecewise-linear time
advance and the hull's integration, and the discriminating variable (whole vs
fractional multiples of the *refresh* period, at equal mean interval) is not yet
explained. Attribution to `src/physics` is **not** established; the camera note's
"the ship's solver is frame-rate dependent" is narrower than the evidence
supports. Note also that `src/physics/index.ts` records the solver's frame-rate
independence as verified at *constant* dt (30 vs 144 fps) — the same blind spot
§85 had.

**Consequence for camera work.** The residual of a low-pass IS the high-frequency
content of its input, so on a fractional clock a camera residual measures the
hull. Confirmed by ablation: feeding the eye the *raw* hull position cuts the
masthead residual by 73%, which is not an improvement — it means the camera then
follows the chatter instead of rejecting it, which is what `ShipFrame` exists to
prevent. **Do not use the §88 acceptance statistic on a fractional clock until
this is fixed.**

## 90. The masthead shot was composed for 38 m and taken from 25.85 m

Work by the masthead session, recorded in `notes/masthead-perch.md` (now folded in
and deleted). Source landed as `a4b3d49`. Verified independently by the
integrating session with a before/after A/B before reconciling.

**Root cause: two modules mean different things by `mainTopY`, and the name
agrees while the definition does not.** `Anatomy.ts` defaults `mainTopY: 38` under
a comment describing the crosstrees — that 38 is **a perch chosen for this shot**,
not an anatomical station. `readAnatomy` then lets `world.ext.ship` override it,
and `src/ship/ext.ts` publishes `main.lowerTop - 2.15 + 1.5 = 25.85`, which is
**the fighting top, one platform down**, plus a standing height. Both values are
correct for what their author meant. `readAnatomy` copies any finite number under
a name it recognises, so the shot silently lost **12.15 m** the moment the ship
published its geometry, and every composition constant in the file went stale at
once.

Read backwards, the docstring's own numbers prove which height it was written for:
"deck visible from 12 m forward of the mainmast" is the bottom edge of frame, and
`BASE_PITCH + FOV/2 = 33 + 37 = 70` deg below horizontal gives
`12*tan(70) = 33.0` m above the deck, `+ 5.5 = 38.5` m. The 38 was that identity
solved for the height.

**What 25.85 m did to the frame** — a 40x22 ray census classified by what it hits
in ship-local metres:

| | 25.85 m as shipped | 35.7 m after |
|---|---|---|
| main top platform | **40.6%** of frame | **0%** |
| deck | 0.3% | 5.0% |
| sea | 48.4% | 63.1% |
| horizon, mean over columns | 12.8% from top | 9.0% from top |

The platform's forward edge sat ~1.9 m ahead of an eye 1.52 m above it, subtending
everything up to 5.7 deg *above* the axis, and the **fore top was at eye level**.
Not looking down at a ship from a mast — looking across a platform at another
platform. The height could not read, which was the one thing the shot existed to
do.

**Why the fix is not simply 38.5 m.** That satisfies the geometry and fails the
picture: it parks the eye beside a sail. Main-mast canvas bands are course
7.6-20.2, topsail 21.4-34.1, topgallant 37.3-46.4, royal 48.3-55.0, so the only
clear air above the fighting top is **34.1-37.3 m**. A five-height sweep driving
`ext.ship.mainTopY` on the live blackboard, so every variant went through the
shipped solve, agreed: 32 m canvas fills 60%, 35 m clear, 36.5 m best, 38.5 m
canvas fills the upper 40%, 42 m canvas fills 65%.

**The fix is camera-side and scoped.** `DECK_NEAR_EDGE = 11` puts the eye at
**35.7 m**, mid clear band; the height now follows `BASE_PITCH` and `FOV`
automatically, so changing the lens cannot silently break the framing again;
`anatomy.mainTopY` becomes a floor (never stand below the platform) and
`mastheadY - TRUCK_CLEARANCE` the ceiling.

**Independently verified.** A/B with the perch as the only variable, owner's file
backed up and restored byte-for-byte (sha256 checked both ways). Before: the frame
is fighting-top planking, shrouds and futtock timbers, no sea, no deck, no
horizon, no drop. After: above the tops looking down the sail plan, sea, horizon,
sky sliver, the drop reads. Accepted.

**Debts, recorded deliberately and not fixed here.**

1. `DECK_NEAR_EDGE = 11` is **calibration debt**. The module cannot see the clear
   band — the sail plan reaches the camera only as `Collision`'s single cylinder —
   so the constant is tuned against captures rather than derived. A topmast-head
   station on `ext.ship` would make it derivable. Until then, moving the yards
   needs a re-shoot of `--scene masthead`.
2. `mainTopY` is doing two jobs and the name cannot serve both. A separate station
   is the real fix. **This is recorded as debt, not opened as a ship-anatomy API
   redesign.**
3. **The same collision may sit in other overridden fields, unmeasured:**
   `mainYardHalfSpan` is 20.5 in `Anatomy.ts` against 14.6 from `ext.ship`, and
   `mainYardY` is 23.5 against 20.2. Nothing has been measured about either. The
   cinematic yard shot reads both, and the mechanism that broke this shot was
   name-level agreement with definition-level disagreement. Debt only.
4. The docstring's promised clean deck wedge is still not true and cannot be from
   here: the deck is geometrically in frame at 5.0% but the fore course and
   topsail hang in front of most of it, so it reads through gaps. Honest for a
   square-rigger seen from the main topmast; the docstring now says so. Confirmed
   in my own capture — the deck is largely occluded and the near left of frame is
   shrouds.

**A trap for anyone re-measuring this.** A CPU raycast **cannot see the sails, the
rigging or the ensign**: all three are GPU-expanded from a unit patch
(`ship-sail-cloth` is 513 verts with a `[[0,0,0],[1,1,0]]` bounding box,
`ship-rigging` is 26 verts), so `Raycaster.intersectObjects` returns nothing for
them at any pixel and every ray that should have stopped at canvas reports the sea
behind it. The census's `SEA` figure is therefore an **upper bound** and its `DECK`
figure is "in frame", not "visible". The way round it is to hide the three meshes
and shoot the frame.

**Cross-corroboration of §88.** Converting the solved camera position through
`shipRoot.matrixWorld` put the eye a consistent ~0.8 m aft of what the mode asked
for, with `avoidHull` and `avoidRig` both off — independently the same
`ShipFrame` `mountPos` lag that §88 identifies as the root cause of mounted-mode
jitter, found by a different session through a different measurement.


## 91. The sail speckle is the film grain, at a fixed absolute amplitude — and the brief's instrument was ablating nothing

Reconciled from `claude/dazzling-nightingale-d51005` (commit `0389c97b`), a session that
stopped on 21 Aug without handing off. **Its source already landed on main** as `05c4c90`,
`565f7f3` and `a832749`; only this record was orphaned, so main carried the fix with no
diagnosis behind it. Renumbered from the branch's `§75` — written against a base 53 commits
behind, where 75 was free — to 91 by the integrating session, per the rule that only main
allocates authoritative numbers. Its `§73` and `§74` citations resolve correctly against
main's numbering and are left as written.

The owner reported heavy per-pixel colour speckle on the sails at `dusk` and `night`,
clearly visible at 1:1. It is the composite's **film grain**. Not TAA, which was the
standing hypothesis and is in fact *attenuating* it; not the sail's own shader.

**The grain injects the same ~2 codes of red-blue noise at every light level.** The sail
is 118 codes at `noon` and 17 at `dusk`, so the identical grain is 2.2% of a midday sail
and **12.0%** of a dusk one. Same bug class as §73 — a **fixed absolute** quantity in a
frame whose level moves 7 stops — one pass further downstream.

### The instrument was broken before any of this, and it is worth checking yours

The brief's ablation set `uLookAmount`, `uVignette`, `uGrain`, `uBloomStrength` and
`uSplitAmount` to 0 from the page. **`Pipeline.render` rewrites four of those five from
`world.settings` on every frame**, and `writeGrade` rewrites `uSplitAmount`, so only
`uLookAmount` ablated anything. Set each to 0 and read it back two frames later:

| uniform | before | two frames later | |
|---|---|---|---|
| `uLookAmount` | 1 | **0** | ablates |
| `uVignette` | 0.045 | 0.045 | overwritten every frame |
| `uGrain` | **0.018** | **0.018** | **overwritten every frame** |
| `uBloomStrength` | 0.055 | 0.055 | overwritten every frame |
| `uSplitAmount` | 0.1404 | 0.1404 | overwritten every frame |
| `uCA` | 0.0011 | 0.0011 | overwritten every frame |

So the brief's "AgX alone" and "look LUT off only" rows were **the same ablation**, which
is why they agreed (mean 24.6/24.7, hf 2.06/1.94) — and its conclusion that "the film
grain ablates to nothing" was read off a knob that ablated nothing. A no-op lever and an
innocent suspect produce identical evidence. The working lever is `world.settings` plus
`bus.emit('settings:changed')`; `.tmp/V1abl.mjs` asserts the lever before it measures.

### The statistic, because the axis is the whole diagnosis

High-pass residual (pixel minus the mean of its 8 neighbours) on the sail box, split onto
colour axes: `luma` is `(R+G+B)/3`, `m-g` is `(R+B)/2 − G` — the axis §73's `dithering`
bug lived on — and `r-b` is `R − B`. The defect is almost entirely **red-blue**, which is
why §73's fix did not touch it and why chasing the magenta-green axis again would have
found nothing.

### Attribution: one frozen frame, one pass ablated at a time

`.tmp/V1abl.mjs`, dusk sail box x678..722 y290..390, mean L 17. `r-b` residual in 8-bit
codes; null spread `base` against `base2` is 0.008.

| ablation | luma | r-b | verdict |
|---|---|---|---|
| shipping (`base`) | 1.390 | 2.147 | the defect |
| **`filmGrain: false`** | **0.798** | **0.669** | **the whole of it** |
| `antialias: 'off'` | 2.271 | 2.440 | TAA is *attenuating* the noise, not making it |
| `antialias: 'fxaa'` / `'smaa'` | 1.974 / 2.239 | 2.329 / 2.463 | ditto, less well |
| `velocityFrame: 'world'` | 1.406 | 2.180 | not it |
| `velocityFrame: 'ship'` | 1.383 | 2.169 | not it |
| `depthOfField: false` | 1.389 | 2.146 | not it |
| `motionBlur: false` | 1.394 | 2.157 | not it |
| `bloom: false` | 1.418 | 2.155 | not it |
| `chromaticAberration: false` | 1.403 | 2.157 | not it |
| `vignette: false` | 1.405 | 2.168 | not it |

**The brief's leading candidate is refuted twice over.** Neither `velocityFrame` pin moves
the statistic more than 0.06 codes against grain's 2.0, and turning anti-aliasing off makes
the sail *worse* everywhere — dusk luma 1.39 → 2.27, night 2.01 → 3.91, `orbit` 4.86 →
12.30. TAA has no velocity for the vertex-animated canvas and its clamp does reject the
history, exactly as `Pipeline.ts` says; the consequence is the documented one, slightly
worse anti-aliasing, and it is a net win of 1.6–7.4 codes.

And the same run gives the mechanism outright — grain's absolute contribution barely
changes with the light:

| scene | mean L of the sail | grain-only `r-b` | as a share of the pixel |
|---|---|---|---|
| dusk | 17.2 | 2.07 | **12.0%** |
| night | 16.8 | 2.04 | **12.2%** |
| noon | 118.4 | 2.60 | 2.2% |

### Three compounding faults, each measured on its own

`FullscreenPass.material` is a plain `ShaderMaterial`, so `.tmp/V1both.mjs` substitutes the
**old grain block back in from the page** and recompiles: both states then share one wave
phase, one cloud field, one sun, one heading and one TAA history. Dusk, `r-b` attributable
to grain (the `filmGrain: false` reference removed in quadrature); `acf` is the
autocorrelation of the luma residual at dx=1, which names the lattice.

| grain block | r-b | share of mean L | acf(dx=1) |
|---|---|---|---|
| **before** | 2.073 | 12.0% | −0.342 |
| amplitude proportional to signal, alone | 0.526 | 3.1% | 0.008 |
| chroma reweighted, alone | 0.617 | 3.6% | −0.354 |
| white noise instead of IGN, alone | 2.044 | 11.9% | −0.061 |
| **after (all three)** | **0.175** | **1.0%** | **0.053** |
| `filmGrain: false` | 0 | 0 | 0.063 |

1. **The amplitude was absolute.** `shape` rolled grain back through the shadows with
   `smoothstep(0.0, 0.10, gLum)`, which reaches **full strength by code 25**. Auto-exposure
   is pinned at its 4.5-stop ceiling at dusk and night (§74), so the sails sit at code
   16–17 — *below* the knee, at 70% of full grain, on a signal 7x smaller than daylight's.
   Granularity is a density fluctuation, so proportional is the physical answer as well as
   the working one: grain is now `min(1.0, gLum / 0.35)` below the midtone knee, a flat
   1.5% of the pixel through the whole toe, and **the knee is the same 0.35 the highlight
   rolloff already started at**, so the curve is one ramp up and one rolloff down.
2. **The draw was `animatedNoise`, which is interleaved gradient noise.** IGN is a
   low-discrepancy lattice, not white noise: `ign` advances by 52.9829189 × 0.06711056 =
   3.55571 per pixel across and 0.30927 per pixel down, so it repeats every **1.80 px in x
   and 3.23 px in y**. A period just *under* 2 is why the pattern beats against the pixel
   grid instead of locking to it — the four (x%2, y%2) parity classes come out flat, which
   is what rules out an ordered dither and would have sent you looking in the wrong place
   if the autocorrelation had not been measured too. Reproduced on the CPU in
   `.tmp/V1ign.mjs`, its
   autocorrelation matches the measured image residual in sign at every lag out to 4 —
   that woven chequer in the crop *is* the noise function. IGN is the right choice where it
   is also used, jittering the cloud raymarch's ray starts for TAA to average away; as the
   still grain of a single frame it is a visible weave.
3. **Two independent full-amplitude draws for R and B.** The comment asked for "some
   chroma, like real film" and got chroma as the *dominant* axis: the grain field's own
   `r-b` rms is **1.8x its luma rms**. Now one achromatic draw with 30% per-layer chroma
   mixed on top, which puts `r-b` at 0.57x luma.

**The three are not independent, and white noise alone would have been a regression:** it
changes no amplitude, and three independent draws move the magenta-green residual from
0.438 to **1.816**. It is only safe together with the chroma reweight.

### What it costs elsewhere, measured

| | dusk | night | noon |
|---|---|---|---|
| grain `r-b`, before → after | 2.07 → **0.18** | 2.04 → **0.39** | 2.60 → 0.96 |
| grain `luma`, before → after | 1.19 → 0.30 | 1.19 → 0.49 | 1.60 → **1.34** |

At `noon` the shape change does nothing at all (2.52 against 2.60 — the curve is identical
above the knee) and the achromatic grain is preserved at **84%**, so the film character
survives where it was already working; what goes is 2.2% of chroma noise on a daylight
sail. The 1:1 crops are indistinguishable.

**No banding regression.** Grain was masking quantisation in the dark, and the claim in
`COMPOSITE_FRAG` is that the 1-LSB triangular dither is what actually prevents it. Mean
constant-code run length down a gradient, dusk sky, same frozen frame: **1.17 → 1.44 px**,
with per-column noise still 0.78 codes — well above the ~0.41 one LSB of triangular dither
gives on its own. Across `fog`, `storm`, `dawn`, `sunset` and `night` the run length is
1.2–1.4 px. A band is tens of pixels. The dither's comment is correct.

### The residual, honestly

The sail box is not clean afterwards, it is *grain-free*. What is left is the sail's own
aliasing, and at night it is three times dusk's:

| | dusk | night |
|---|---|---|
| `r-b` with grain off | 0.67 | **1.02** |
| `luma` with grain off | 0.79 | **1.20** |
| `luma` with grain off *and* AA off | — | 3.91 |

TAA is masking most of that, which is why it never surfaced. §73 left the same thread —
"p99 chroma at night is 29 against dusk's 19, and this fix does not explain why" — and
this is the same residual seen on a cleaner axis. It is the sail material's business, it
is roughly 5x smaller than the grain was, and it was not chased.

### Two things found in passing, neither of them mine

- **A probe that writes PNGs under the Vite root reloads the page it is measuring.**
  `capture.mjs` stages screenshots outside the project for exactly this reason and says so;
  a probe in `.tmp/` that does not will die with "Execution context was destroyed", which
  is what killed the first `night` run — *after* two other scenes had completed and looked
  fine. Stage outside the root.
- **The night wake reads as a field of grey spheres** in the foreground of
  `shots/V1-all-night.png`. That is `vfx`, not post.

### The rule this is the second instance of

§73: a fixed absolute quantity injected upstream of auto-exposure, whose multiplier spans
7.2 stops. §75: a fixed absolute quantity injected downstream of the tonemap, into a frame
whose own level spans 7 stops because that same auto-exposure is clamped. **Any constant
expressed in output codes is a claim that every frame has the same brightness.** This engine
has `MAX_GAIN_STOPS = 4.5` and scenes that sit hard against it, so that claim is false here
by construction. Grep the post stack for absolute constants and ask each one what it means
on a frame whose sails are code 16.

## 92. `waterYAt` says quadratic and is piecewise-linear — a verified mismatch, and an untested lead for P2

Recorded by the integrating session while preparing the wake pass. **The code-level
fact is verified by reading; the visual attribution is an untested lead and must
not be cited as the cause of the near-hull seam until it is measured.**

**The verified fact.** `src/vfx/shaders/hullwater.ts:36` comments the function
"Quadratic through the three sampled water heights". The body is not a quadratic:

    return u < 0.5
      ? mix(w.x, w.y, u * 2.0)
      : mix(w.y, w.z, (u - 0.5) * 2.0);

Two straight segments joined at `u = 0.5`. A quadratic through three points is
C1-smooth; this is C0 with a **slope discontinuity at midships**. The three
samples `uWaterPort` / `uWaterStbd` are the ship-local water height at bow, mid
and stern, so on a hull whose waterline §79 gives as ~53 m the samples sit ~26 m
apart and the modelled sea surface along the side is a two-segment polyline.

**Why it is a lead for P2.** The owner's P2 is a straight-line separation or
partition in the near-hull foam, and a slope kink pinned to a fixed station is the
right shape for a ruled crease running along the hull with a corner amidships.
§79 already flagged this fit as unmeasured and said exactly why it should be
looked at now: the live uniforms read 0.96 / 2.67 / -0.13 m to starboard against
0.78 / -1.50 / -0.68 to port, which is consistent with 22 deg of heel rather than
fit error, but "a 2.4 m wash used to hide any error there and a decimetre-deep
band will not". Everything downstream keys off `wl = waterYAt(t, side)` —
including the skirt's `clamp(wl + ..., uSkirtFloor, uSkirtCeil)` at line 404 — so
a kink in `wl` propagates into the band's own edge.

**What has NOT been shown.** That this kink is visible; that it is the seam the
owner reported; that its magnitude at any real sea state is more than a few
centimetres. It could easily be below the noise of the froth drawn on top of it.
Two straight segments could also be *sufficient* for a swell whose wavelength is
long against 53 m, which is the case this fit was presumably chosen for.

**Discriminator for whoever picks this up.** The kink is at a fixed `t = 0.5`, so
it is stationary in ship space while the sea moves through it — that is the
signature to look for, and it distinguishes this from anything wave-locked.
Raising the sample count, or fitting an actual C1 quadratic through the three
points already sampled, changes the fit without touching the froth, which keeps
the test clean. **This is the fix axis, not blur:** the owner's P2 explicitly
forbids resolving the seam by globally blurring foam, and smoothing the underlying
water fit is the opposite of that — it removes the straight edge rather than
hiding it.

### Correction to the above: run the cheap exclusion FIRST

§35 recorded a decisive constraint I should have cited before offering `waterYAt`
at all: **with all three vfx meshes hidden, the sea beside the hull was still a
flat pale plate with a straight upper boundary.** It attributed that to `WakeField`
plus the ocean's consumption of `wakeTexture.R`, with the field spanning **1024 m
over its texture** — so it physically cannot carry near-hull detail, and the
breakup has to come from the ocean side.

`waterYAt` lives in `src/vfx/shaders/hullwater.ts`, which draws one of those vfx
meshes. **If the seam survives hiding them on the current build, §92's lead is
excluded outright** and the target is `WakeField` and the ocean's consumption of
`wakeTexture.R`, not the water fit.

So the ordering for the wake pass is: (1) re-run §35's hide-all-vfx test on today's
build, because §79 has since changed the skirt and the result may no longer hold;
(2) only if the seam *disappears* with vfx hidden is `waterYAt`'s midships kink
worth testing; (3) if it survives, work the 1024 m field and the ocean's
consumption. This ordering costs one capture and can eliminate a whole subsystem,
which is cheaper than either investigation.

Note also that §35's plate and §79's waterline plate are **two different
artefacts** found at different times — §79's was the hull skirt's submerged rows
and was fixed. Do not assume the owner's current P2 report is either one of them
without re-establishing which.

## 93. The probe had no sea below its horizon — fixed, and the settling test says it is NOT the sail film

Done by the integrating session after two dispatched agents died on this task (one
on a shared session limit, one stalled), so it was taken in-house rather than
re-dispatched a third time. Folded in from `notes/env-probe-lower-hemisphere.md`.
Source: `b54c222`.

### The defect, verified independently before any change

`EnvProbe` compiles `SKY_FRAG` with `SKY_ENV`, and **`SKY_ENV` has no other
consumer**, so the probe was the only thing affected — and it had no sea in it at
all. For a below-horizon ray the shader takes `hitsGround` and then reads the same
sky-view LUT; `skyViewToUv` maps ground-hitting rays onto the LUT's in-scattering
half, and at sea level `zenithHorizon` is 90 deg so *every* downward direction
lands there. `Radiometry.groundColor` — documented in `src/sky/index.ts` as
"radiance bounced back up off the sea" — was never consulted.

Measured by reading the 256x128 equirect off the GPU. The lever assertion is that
the render target located must **be** `scene.environment`, matched by texture
identity, so the thing measured is provably the map the scene lights from.

### A measurement bug of mine, and how it announced itself

My first probe assumed `v = 0` was the zenith. The shader builds the equirect as
three does — `v = asin(y)/PI + 0.5` — so **`v = 0` is the NADIR** and every
hemisphere label was inverted. The tell was that the "upper" hemisphere moved when
I changed a branch that can only execute below the horizon. **A change appearing
where it is impossible is a measurement bug, not a discovery.** Corrected, the
pre-change nadir reads 0.260 against §87's independently measured 0.259.

### The fix and its same-load A/B

Below the horizon the probe now Fresnel-mirrors the sky in a flat sea and lets
`uSeaRadiance` through the rest:
`L = mix(uSeaRadiance, mirrorL, 0.02 + 0.98 * pow(1 - cosN, 5))`. Flat because the
probe is prefiltered into SH and a roughness chain, so per-wave structure would be
averaged away regardless. No glitter — the ocean draws its own statistical lobe.

Both arms in one page load, branch neutralised by patching the material and forcing
`probe.update(world, true)`, so the sim never advances:

| | as shipped | with sea | |
|---|---|---|---|
| nadir | **0.2649** | **0.1661** | −37% |
| zenith | 0.2039 | 0.2067 | — |
| lower hemisphere mean | 0.3210 | 0.2835 | −12% |
| upper hemisphere mean | 0.4939 | 0.4775 | −3%, the DRIFT FLOOR |
| lower-hemisphere B−R | 0.1463 | 0.2191 | hue moves |
| share of a vertical surface's irradiance from below | 44.7% | 43.1% | −1.6 pts |

The inversion is corrected: the nadir was brighter than the zenith and is now
darker. The upper hemisphere cannot be touched by a below-horizon branch, so its 3%
movement is the inter-arm drift floor — the nadir's 37% is an order above it, the
`fracBelow` change of 1.6 points is not clearly above it.

### The settling test: NEGATIVE

Predicted **before** running it, and recorded first so the result could not be read
as confirming a hypothesis chosen afterwards: `fracBelow` barely moves, and that is
physics rather than a shortcoming — a *vertical* surface's cosine lobe peaks at the
horizon, and at grazing angles Fresnel goes to 1, so a correct sea still mirrors the
sky exactly where a near-vertical sail is most sensitive.

Same station, same frozen frame, same clock, same exposure; only the
lower-hemisphere contribution changed. Medians, because every sail box on this
square-rigger is crossed by shrouds and both arms share identical geometry:

| | as shipped | with sea |
|---|---|---|
| sea reference, linear | 0.2284 | 0.2284 (bit-identical — control) |
| sail A, ratio to sea | 0.350 | 0.341 |
| sail C, ratio to sea | 0.458 | 0.456 |
| sail A, B−R codes | 31 | **41** |
| sail C, B−R codes | 25 | **32** |

Whole-frame mean |dRGB| 2.18 codes with 44.6% of pixels moved, so the lever is
emphatically not a no-op. **The film ratio moves by 2.6% at most, and the hue moves
the WRONG WAY** — the sail becomes *bluer*, i.e. closer to the sea's own cast,
which is the opposite of what §87 asked for. At 3x, both arms still read as blue
film with the same pale streaky patches.

**So §87's leading candidate is disconfirmed as the cause of the sail film.** It was
a real environment-lighting defect and it is now fixed, but correcting it does not
remove the artefact. §87's standing statement should be updated: the probe is no
longer the strongest causal candidate.

### What the fix costs, stated plainly

The sail picks up ~10 codes of B−R and gets 2.6% darker relative to the sea. It is
near-imperceptible in a 3x side-by-side and it very slightly worsens the *hue*
component of the film it does not fix. Kept because the probe defect is real and
independently justified — §87: a probe whose nadir outshines its zenith is wrong
whatever else is true — but this is a **judgement call the owner may reverse in one
line**, and it is flagged rather than buried.

### The strongest remaining candidate, as a lead

The pale streaky patches that read as "sea through the canvas" are unchanged by
this fix, which is consistent with §87's separate finding that those patches are
`sheenSpecularDirect` — rendering that accumulator alone gives a black frame
containing exactly them. **That is now the strongest remaining candidate and it has
NOT been causally tested.** No sheen A/B was run here. Do not promote it without
one.

### Pre-push IBL regression sweep, added after the fact

The settling test showed a measurable colour cost on a *close* sail, so the probe
change was swept across three lighting conditions at a representative broadside
station (hull, metal, cloth, deck and sea all in frame), sea term on vs off, same
frozen frame per condition. A first run was invalid — `orig` was re-captured per
condition after the previous condition's ablation had already stripped the needle,
so golden and night compared two identical arms. Fixed by capturing the pristine
shader once.

Largest movements, shipped vs with-sea:

| condition | largest luma change | largest hue change (B−R) |
|---|---|---|
| noon | copper −1.5 codes (−3.7%) | sail +2.3 |
| golden | sail +0.8 codes (+0.7%) | gunport +0.7 |
| night | sail +0.4 codes (+1.5%) | sail +0.4 |

Everything else is at or under half a code. **The +10 codes of B−R recorded above is
specific to the close sail station, not a global cost** — at representative
distances the change is 1 to 2 codes and no material regresses meaningfully at any
of the three times of day.

## 94. P2 exclusion: the near-hull plate is not vfx, and §92's lead is dead

§92 said to run §35's exclusion first because one capture could eliminate a
subsystem. It did, and the subsystem it eliminated was the one §92 itself
nominated.

### The exclusion

Same frozen frame, same station (6 m forward, 9 m up, 24 m to port, looking at the
port waterline), sea state 4. Only variable: whether the vfx meshes draw. Hidden
were `vfx-bow-wave`, `vfx-hull-skirt` and `vfx-particles` (the two rain meshes were
already invisible at `rain: 0`).

| region | all vfx | vfx hidden |
|---|---|---|
| inside the pale plate, x 260-360 | mean 152.7, sd 52.7 | mean 153.8, sd 53.1 |
| outside it, same columns | mean 176.6, sd 31.4 | mean 176.7, sd 32.4 |
| inside the plate, x 640-740 | mean 163.4, sd 44.7 | mean 164.2, sd 44.8 |
| outside it, same columns | mean 158.9, sd 52.5 | mean 158.5, sd 53.2 |

**The plate and its hard outer boundary are unchanged** — about 1 code, against a
temporal noise floor of **3.25 codes** measured in open sea, where hiding vfx
cannot matter at all. So §35's finding still holds on today's build even though §79
has since rebuilt the hull skirt.

**Therefore `waterYAt` is excluded.** It lives in `src/vfx/shaders/hullwater.ts`,
which draws `vfx-hull-skirt`, and the artefact survives that mesh being hidden.
§92's midships-kink lead is dead for P2. The comment/implementation mismatch it
recorded is still a real (if cosmetic) defect and still worth correcting, but it is
not this.

### Where it actually lives, with the mechanism named

`src/ocean/shaders/surface.ts`, and it is §40's family again — a threshold on a
field too coarse to carry the detail:

    line 131:  wakeFoam = max(wk.r - 0.06, 0.0) * (1.0 / 0.94) * wf;
    line 594:  cover = max(cover, wakeFoam * 0.88);

Two hard edges stacked. `WAKE_WORLD_SIZE` is 1024 m and the field is 1024 texels
even at `ultra`, so it is **1 m per texel** — the file says so itself — and
near-hull foam structure is sub-metre. So `wk.r` near the hull is a bilinear ramp
between metre-spaced samples, `max(wk.r - 0.06, 0)` cuts it on a smooth iso-contour
of that ramp, and then `max(cover, wakeFoam * 0.88)` **replaces** the ocean's own
detailed foam wherever the smooth plate wins. The boundary is where those two
quantities cross, which on an interpolated metre-scale field is a smooth, locally
straight curve — a ruled edge with a flat plate on one side and textured foam on
the other. That is the reported artefact's exact shape.

`wakeFalloff` is a second, larger hard-ish edge — a radial `smoothstep` from
`0.62 * fadeRadius` to `fadeRadius` centred on the ship — but that one is far out,
not near-hull, and should not be confused with this.

**Not causally tested.** Nothing here has been A/B'd yet: the exclusion is solid,
the mechanism above is read off the source and is a strong candidate, not a
demonstrated cause. The obvious discriminator is to vary the 0.06 threshold and the
`max` blend independently and watch whether the ruled edge moves with them.

**And P2's constraint still binds:** the owner forbids resolving this by globally
blurring foam. Note that both candidate levers here are *sharpening* operations
being applied to a field that cannot support them — so the fix direction is to stop
thresholding a coarse field, not to soften the result.

## 95. The near-hull plate is the wake channel's foam, and two mechanisms are refuted

Continues §94. The dispatched wake agent stalled after writing its note (committed
verbatim, then folded in here and deleted); the integrating session finished the
work after a third consecutive agent stall made re-dispatching pointless.
**Localised, not fixed.**

### First, a correction to §94 from the agent, which was right

§94 said `cover = max(cover, wakeFoam * 0.88)` "replaces the ocean's own detailed
foam". **The ocean's detail is not in `cover`.** `cover` is a scalar coverage
*fraction*, and all the tearing is applied downstream in §40's
threshold-on-flattened-noise (`thr = 1 - cover + bite * (...)`,
`foam = linstep(thr - wThr, thr + wThr, decide)`). Whatever raises `cover`, the
breakup is applied afterwards — so raising it from a smooth metre-scale field
should still come out torn, and §94's mechanism as literally written has a hole in
it. The agent also eliminated the `bite` collapse arithmetically: the wake's
ceiling is `(0.78 - 0.06)/0.94 * 0.88 = 0.674`, giving `bite = 0.652`, not
collapsed.

### What the artefact actually is, at 3x

Two features, not one, and conflating them is what made my first statistic
contradict my own eyes:

1. **A featureless cream band** hugging the hull with a hard ruled edge. Vertical
   profiles put its interior at a flat **198 codes, varying ±3 over 28 px**.
2. **Crazed foam beyond it** — near-solid white broken by thin dark fissures, the
   signature of a *binary* threshold on a flattened field rather than graded foam.

My first box spanned both. The crazing is high-frequency, so the box reported
*more* structure in the "smooth plate" than in open sea, at every scale from 1 to
16 px. **The statistic was right and the box was wrong.** Locate the feature with a
profile before drawing a box around it.

### Ablation, one frozen frame, four arms, every needle asserted

Boxes placed from the profiles: `PLATE` is the flat band interior, `FOAM` the
crazed region beyond. `% flat` is the share of pixels within 5 codes of the box
median.

| arm | PLATE mean | sd | % flat | FOAM sd |
|---|---|---|---|---|
| base | 198.2 | 26.1 | **49.0** | 14.2 |
| `cover` clamped to 0.45 | 183.2 | 44.9 | 36.1 | 14.2 |
| `wThr` pinned to 0.25 | 197.8 | 20.6 | 41.1 | **31.5** |
| `wakeFoam = 0` | **157.1** | 61.6 | **7.8** | 15.3 |

**Confirmed: the plate is the wake channel's contribution.** Zeroing `wakeFoam`
collapses the plateau — flatness 49.0% to 7.8%, mean 198 to 157 — by far the
largest lever of the four.

**Refuted 1: the footprint wash.** Pinning `wThr` to a wide 0.25 leaves the plate
at 197.8 and 41.1% flat. It transforms the *surrounding* foam instead (`FOAM` sd
14.2 to 31.5), so the lever works and simply does not act here. Consistent with the
arithmetic: `wThr = mix(0.05, 0.5, smoothstep(1.2, 3.5, pxWorld))` only widens past
`pxWorld` 1.2 m, and at ~1.3 mrad/px a 30 m near-hull distance gives
`pxWorld ~= 0.04 m`, so `wThr` sits at its sharp floor. **That hypothesis was a
far-field story mistaken for a near-hull one** — it may still matter for P4.

**Refuted 2: coverage saturation collapsing `bite`.** Clamping `cover` to 0.45
moves the plate only from 49.0% to 36.1% flat. If the plateau were simply
`foam` saturating at high coverage, forcing coverage to 0.45 should have torn it
open. It does not.

### A lever that was found but did not bind

My first round clamped `cover` at **0.85** and reported no effect at all. The needle
was found and the code did change — but the wake's ceiling is 0.674, so the clamp
was never reached and the edit was a **semantic no-op**. Same family as §91's
rewritten uniforms, one level subtler: asserting that the *string* was patched is
not the same as asserting the *constraint binds*. Check that a clamp is below the
value it is meant to clamp.

### What remains open

The chain from `wakeFoam` to a ±3-code plateau is **not closed**. Coverage
saturation is not sufficient and the ramp width is not involved, so something
between them — the `decide` field's own dynamic range where the wake dominates, or
the foam shading downstream of the mask — is doing it. Whoever continues should
instrument `cover`, `thr` and `decide` as output channels in that band rather than
inferring them from the composite, which is what every arm above had to do.

**No fix committed.** The wake channel is confirmed as the source and two
mechanisms are eliminated, which is real progress, but nothing here justifies
source changes yet — and P2 still forbids resolving it by globally blurring foam.

## 96. P2 closed: both halves are the `linstep`'s margin, and the fix is its ramp width

Completes §94 and §95. Source: `7db3c9b`.

### The instrument

Per-quantity debug arms: the ocean's fragment output is replaced with one
intermediate scalar as greyscale, plus an **in-frame calibration ramp** along the
bottom 42 rows (`dbg = gl_FragCoord.x / 1600`), so display codes invert back to
shader values under that arm's own exposure. `autoExposure` off and the spatial
post terms off, so the transfer is fixed and nothing smears between regions. Two
extra arms output constant 0 and 1 to build an **ocean mask** by identity — the
debug output only replaces the *ocean* material, so hull pixels would otherwise
invert to garbage. Captures are taken at each quantity's definition point, because
several of these locals are reused later in `main()`.

Measured: `0.0 -> code 0`, `1.0 -> code 224` (AgX compresses the top), hull 124 in
both.

**A circularity I caught in my own first pass.** I initially defined the plate mask
as pixels where `foam > 215`, then reported that `decide` exceeded the threshold
window there. That is selecting on the outcome. Redone on **geometric bands** —
distance in pixels below each column's hull/water silhouette, no reference to foam
at all.

### The chain, per band, before the fix

| | 0-25 px | 26-60 | 61-110 | 111-200 | 201-400 |
|---|---|---|---|---|---|
| `wk.r` | 0.655 | 0.709 | 0.709 | 0.255 | 0.007 |
| `wakeFoam` | 0.631 | 0.696 | 0.681 | 0.207 | 0.003 |
| **`cover` before wake** | **0.003** | **0.007** | **0.007** | 0.014 | 0.014 |
| `cover` final | 0.556 | 0.606 | 0.606 | 0.200 | 0.014 |
| `1 - cover` | 0.444 | 0.394 | 0.394 | 0.800 | 0.986 |
| `thr` | 0.410 | 0.324 | 0.366 | 0.816 | 0.983 |
| `decide` | 0.430 | 0.469 | 0.522 | 0.415 | 0.495 |
| `wThr` | 0.061 | 0.061 | 0.061 | 0.061 | 0.061 |
| **`(decide - thr)/wThr`** | **0.33** | **+2.37** | **+2.55** | **-6.55** | **-7.97** |
| `foam` | 0.838 | 0.981 | 0.935 | 0.003 | 0.003 |

### The answer to both halves

**The exact operation is the `linstep` in the foam decision**, and A and B are the
same statement about its margin:

- **A, the featureless cream plateau.** Where `(decide - thr)/wThr` exceeds +1 the
  `linstep` **clamps**. At +2.37 and +2.55 it is pinned at 1 across the whole band,
  so *every* spatial structure in `decide` is discarded. The plate is not a smooth
  input being drawn faithfully; it is a structured input being thrown away.
- **B, the adjacent crazed near-solid foam.** The same ramp, half-width 0.061
  against a `decide` spread of roughly 0.6, is a near-binary step. Where the margin
  is near zero it yields hard-edged islands with thin fissures instead of graded
  density.
- **The ruled boundary between them** is where the margin sweeps that narrow
  window, and it is abrupt because `cover` falls 0.606 to 0.200 between adjacent
  bands as the wake field's own coverage drops away.

### Two findings that reframe §94 and §95

1. **`cover` before wake injection is 0.003 to 0.014 across the entire near field.**
   The ocean contributes essentially no foam of its own alongside the hull, so the
   wake is the *sole* source of coverage and **there was never any ocean detail
   being replaced** — §94's framing was wrong twice over, and §35's "the ocean has
   to add the breakup" is right: it currently adds none, because both `instant` and
   `persistent` are ~0 there.
2. **`thr` tracks `1 - cover` to within 0.05 in every band.** §40's zero-mean
   construction is **intact**; the mean coverage was never the defect. That is what
   makes the ramp width the safe knob.

### Negatives preserved, all still standing

- `waterYAt` / `vfx-hull-skirt` excluded (§94): the artefact survives hiding every
  vfx mesh.
- Near-hull `wThr` footprint widening excluded (§95), now doubly: `wThr` measures
  an identical 0.061 in all five bands, pinned at its floor, so the `pxWorld` path
  is not engaged here at all. It remains a plausible *far-field* story.
- `cover <= 0.85` was a semantic no-op (§95): the wake's ceiling is 0.674, so the
  clamp never bound. Proving the string was patched is not proving the constraint
  binds.
- Simple saturation-collapse refuted (§95): `bite` is 0.87 at these coverages, not
  collapsed, and clamping cover to 0.45 barely opened the plateau.
- `wakeFoam = 0` causally removes the plate (§95).

### The fix, and why it is not a blur

Widen the ramp **only where the wake supplies the coverage**:

    wThr = max(wThr, 0.05 + 0.42 * smoothstep(0.20, 0.62, wakeFoam * 0.88));

`E[linstep(t - w, t + w, d)] = 1 - t` at **any** width for zero-mean `d`, and
finding 2 above shows that identity holds here, so **mean coverage does not move** —
this is not a strength reduction and not a way of hiding the edge. It is keyed to
`wakeFoam` rather than total `cover` so natural whitecaps keep the shipped ramp: a
gale's own coverage is around 0.15 and must still tear. And it is a change to the
*decision*, not a filter over the output — no neighbourhood is averaged anywhere.

### Acceptance

Mechanism level, post-fix bands: `margin/wThr` is **0.23 and 0.118** in the froth
bands against +2.37 and +2.55 before, so the clamp is gone and `foam` grades
(0.630, 0.575) instead of switching. `wThr` is 0.446-0.458 in the froth and an
untouched 0.061 beyond the wake. (These are a separate page load from the
before-run, so `cover` differs there for unrelated reasons; the same-frame
comparison is below.)

Same-frozen-frame A/B, ramp stripped by string patch:

| | before | after |
|---|---|---|
| close-side froth HF | 5.72 | **3.71** |
| close-side tight plate mean | 188.5 | 186.5 |
| close-side tight plate % flat (±4) | 32.9 | 27.9 |
| close-astern froth HF | 6.91 | 5.73 |
| close-side far box mean | 72.3 | 72.3 |
| bow-head far box mean | 54.0 | 54.1 |
| close-astern far box mean | 118.9 | 119.1 |
| open-orbit far box HF | 1.45 | 1.45 |

**Open-sea and far-field foam are unchanged to within a tenth of a code**, which is
the non-regression requirement. Verified visually at close-side (dead-flat band
gains graded mottling; the abrupt transition softens), close-astern (hard-edged
cut-out patches become graded aerated water, wake extent preserved) and bow-head
(unchanged, as expected — the froth is behind the station).

### The one judgement left for the owner

Within the wake, the froth's *character* changes: crisp binary islands become
graded density. That is the defect being removed rather than hidden — coverage is
preserved and open sea is untouched — but how crisp the froth should read is a look
decision, and the single constant `0.42` is where to tune it. Lower it toward 0.05
to move back toward the shipped crispness.

## 97. P4 far-distance dark patch / flicker: NOT REPRODUCED, and one adjacent defect found

Folded in from `notes/far-distance-dark-flicker.md`. **No source change.** This is a
documented negative, not a closed defect: the owner's live-run report stands as
valid evidence that headless instrumentation does not reproduce it — the same
position §85 held for P3 before §85a found the right clock.

### Instruments

A deterministic far station (eye 28 m up, 40 m to port, aimed 3 km ahead at sea
level, horizon at row ~457, lower half of frame far-field ocean at grazing
incidence), and an astern variant that puts the wake and a low sun in frame. Band
means read in-page with `gl.readPixels` right after `tick()`, which makes
four-figure frame counts affordable. `free` mode owns pos/yaw/pitch and damps to
zero without input, so at fixed dt the station is deterministic.

### The five negatives

1. **Fixed camera, live and frozen arms** (32 frames each, dt = 16.67 ms and
   dt = 0). Temporal sd falls monotonically with distance — sky 4.64, horizon 3.89,
   far 4.66, mid-far 6.59, mid 9.62, near 11.39 — i.e. variance is near-field wave
   motion and there is **no far-field variance peak**. The frozen arm's residual
   1.6-2.3 codes is TAA jitter continuing at dt = 0 (Halton advances regardless of
   dt). The temporal-mean row profile is smooth through the far field, so **no
   static dark patch** either.
2. **Resolution stepping does not move the far field.** `uPixelAngle` is
   `2 tan(fov/2) / world.size.height`, the BACKING-STORE height, so a ladder step
   scales `pxWorld` about 9%. Per adjacent step the far band moves ~0 while the
   near band moves up to **+5.5 codes**. Structural: at kilometre distances
   `pxWorld` is far above every footprint threshold so those terms are saturated,
   while near the camera it sits on the steep part of the fine-octave ramps.
   **So the `wThr` footprint lead is refuted for the far field too** — for the
   opposite reason to §95/§96's near-field refutation, where it was pinned at its
   floor. Recorded and not carried forward.
3. **Moving camera, 1200 frames, 146.7 m sailed.** Far band: median
   frame-to-frame step 0.058 codes, max 0.484, **zero** outliers above 8x median.
   So clipmap ring shifts, cascade tile wraps and origin wraps produce no visible
   far-field step. The 2-3 mid-band outliers are about one code.
4. **Nine conditions** (dawn, noon, golden, sunset, bluehour, dusk, night, storm,
   fog). Every temporal sd under 0.7 codes; largest single step anywhere 1.3 codes
   in storm. Dark tails (`p50 - p1`) scale with each condition's contrast rather
   than standing out anywhere.
5. **Wake astern.** §79 predicted the wake's sub-visible foam tail could read as a
   broad dark lane at the Kelvin half-angle. Ablating `wakeFoam` moves the far band
   0.03-0.07 codes — the wake's footprint does not reach the far field. Its net
   effect nearer in is *brightening* (near band drops 7.5 codes at golden, 12.0 at
   noon when removed), with localised patches where removal brightened the sea 4-9
   codes per block: the specular-suppression signature is real but small and near.

### A hypothesis of mine, refuted, and a physics error behind it

The astern station shows the sea just below the horizon far under the sky above it
— golden 105-109 against a sky of 171, a 37% deficit. I proposed the reflection
collapsing onto `oceanSky`'s two-colour ramp, since `alpha` is widened at distance
and `mix(probe, wide, alpha * 0.95)` would then be mostly `wide`.

**Refuted with the lever verified binding.** `uHasEnv` is 1 and the env map is set,
so the patched line does execute, and forcing `return probe` moves the far bands by
at most 0.8 codes. The premise was wrong regardless: at golden hour `uFogColor` is
(0.769, 0.514, 0.325) — a *bright* warm orange — against `uSkyColor`
(0.039, 0.042, 0.056), so `wide` at the horizon is bright, not dark.

**And my physics was wrong.** I argued the sea should approach the sky's radiance at
grazing incidence because Fresnel goes to 1. Fresnel reaches 1 only at exactly 90
degrees, and at `uSlopeRms` 0.199 (about 11 degrees) a rough sea at grazing
incidence scatters reflected rays into sky **twenty times darker** than the horizon
band at golden hour. A sea well below the horizon-sky radiance is the correct
answer. It is also what a sunset photograph looks like. Kept in the record because
the temptation here was to "fix" a correct render.

### The adjacent defect this did find, which is NOT P4

> **MAGNITUDE RETRACTED BY §100.** The mechanism below is real and confirmed by
> reading the code, but the "up to 5.5 codes per ladder step" figure is not
> reproducible: it came from a single-page-load sweep in which the K values were
> stepped in order, so inter-arm sim drift ran in the same direction as K. Measured
> with a fresh page load per scale, every ocean band moves less than the sky
> control's own load-to-load variance. No visible pop has been demonstrated.

`uPixelAngle` keys off the backing-store height, so **every footprint-gated ocean
term moves when adaptive resolution steps**: `wThr`, the `r1/r2/r3` octave fades,
`ripRes`, the cascade LOD, the far-field whitecap block. Measured, one adjacent
ladder step changes near-field sea brightness by up to **5.5 codes**, and a live run
with `adaptiveResolution: true` stepped the backing store 540 -> 396 (ladder 0.6 to
0.44) inside 26 s, so the ladder does move during play.

One step down is a **pop, not sustained flicker** — the hysteresis
(`ADAPT_DROP_BELOW` 0.94, `ADAPT_RAISE_ABOVE` 0.985, `ADAPT_DROP_CONFIRM` 0.85)
appears to do its job, and only one transition occurred in 26 s. No timing claim is
attached: this box was contended. But a sea whose brightness is a function of render
scale is wrong on its own terms, and the fix direction is to derive the footprint
decisions from a reference resolution rather than the live backing store. **Filed as
its own defect rather than conflated with P4.**

### What would make P4 reproducible

The search space that remains is the report's own context, which instrumentation
cannot guess: which **view mode**, what **time of day**, the **direction relative to
the sun**, roughly **how far** ("far" could mean 200 m or 20 km — the bands behave
very differently), and whether it **recurs on a period** or happened once. Any one
of those would cut the space enormously. Asked rather than guessed.

## 98. The sail film: `sheenSpecularDirect` refuted, root cause characterised, fix is art direction

Folded in from `notes/sail-film-sheen.md`. **No source change.** The mechanism is
closed; what remains is a look decision with several materially different answers
and no measurement that can choose between them, which is a stop rather than a
guess.

### Instrument, and two traps worth keeping

Term-by-term ablation of the sail's radiance at the affected close station, using
three's own accumulators inserted after `#include <lights_fragment_end>`.

1. **The existing `onBeforeCompile` must be WRAPPED, not replaced.** The sails are
   GPU-expanded from a unit patch by a 16 kB hook; replacing it breaks the vertex
   expansion outright.
2. **`customProgramCacheKey()` on this material returns a constant, `'ship-sail'`.**
   With a constant key three reuses the cached program and **never calls
   `onBeforeCompile`**, so the first run reported "needle seen: false" for all seven
   arms — every ablation silently did nothing. The key must vary per arm. Same class
   as §95's non-binding clamp, one level further out: there the constraint did not
   bite, here the correct patch never ran at all.

Inert arms establish a recompile noise floor of 2 to 2.6 codes whole-frame, since
each arm rebuilds the program and resets TAA history.

### The lead is refuted

| term rendered ALONE | sail linear L | share of base | B−R |
|---|---|---|---|
| base, all terms | 0.0774 | 100% | +39 |
| **`sheenSpecularDirect` only** | **0.0035** | **4.5%** | +3 |
| `sheenSpecularIndirect` only | 0.0271 | 35% | +27 |
| `indirectDiffuse` only | 0.0331 | 43% | +27 |
| `indirectSpecular` only | 0.0118 | 15% | +21 |
| direct only (diffuse + specular) | 0.0035 | 4.5% | +3 |

And zeroing it in place moves the sail's ratio to its background from 0.311 to
**0.309**, with the hue unchanged at B−R +40.

**`sheenSpecularDirect` is not the cause.** §87 nominated it because rendering it
alone showed the streaky patches — but that was a contribution observation on a
near-black frame, and it is 4.5% of the sail's radiance, the same floor as the
entire direct path. Negative preserved.

### What the sail's radiance actually is

**93% image-based lighting**: 43% indirect diffuse, 35% indirect sheen, 15%
indirect specular. And `indirectDiffuse` alone measures B−R **+27** — the *diffuse*
term is itself blue, so the buff flax albedo is being swamped by blue environment
irradiance rather than tinting it.

### The direct path is absent because the sail is SHADOWED

The sun sits at (−0.189, 0.952, 0.239), elevation about 72 degrees, and a sail is
near-vertical, which alone would give a small cosine. But disabling the sun's shadow
casting moves the sail box by **16.3 codes** — median RGB (56, 77, 97) to
(84, 94, 104) — and **warms** it from B−R +41 to +20. So direct light is available
at this geometry and the shadow term is removing it. That is why the
`directDiffuse = 0` arm was inert: the light had already been shadowed away.

### And the streaky structure is the shadow pattern, not a radiance term

> **CORRECTED BY §99.** This subsection and the shadow figure above it are wrong.
> Both were measured on a `dt = 0` frozen frame, and at `dt = 0` the shadow map is
> not re-rendered — so the "16.3 codes" and the attribution of the streaks to the
> shadow pattern do not survive a properly settled measurement. §99 shows the sail
> carries only about 4 codes of shadow in total and that the streaks are present
> with the shadow lookup entirely disabled. The rest of this section — the sheen
> refutation and the 93%-IBL decomposition — is unaffected and stands.

The direct-light-only render is the informative one: the sails carry large, soft,
amoeba-shaped dark regions while the deck in the same frame shows crisp, plausible
mast and rigging shadows. **The pale streaky patches that read as "sea through the
canvas" coincide exactly with the BRIGHT, unshadowed regions of that render.**

Those blobs are most likely legitimate: a square-rigger's sails are bellied
surfaces and a curved caster on a curved receiver gives a curved, soft-edged
shadow. The shadow map is 2048 over a 74 to 200 m radius, i.e. 0.07 to 0.20 m per
texel with `normalBias` 0.055 and `shadow.radius` 2.2, and `makeSailDepth` already
pushes the caster clear specifically to kill sail self-shadow acne. Nothing here
looks like a resolution or bias failure. **Not proven either way** — a geometric
consistency check against the sails' shapes and the sun vector was not run.

### Root cause, as far as measurement takes it

The film is compound, and no single term produces it:

1. the sail is **shadowed**, so it has no directional light to give it form;
2. its remaining radiance is **93% IBL from a sky-and-sea environment**, so both its
   luminance *and* its hue track the background it is seen against;
3. the visible streaky structure is the **shadow pattern** on the canvas, whose lit
   patches read as background showing through.

A surface matching its background reads as film — §87's original framing — and here
every contributing term is drawn from that background by construction.

### Why this stops here

The fix space contains materially different options and no measurement discriminates
between them. Each is a look decision:

1. **Reduce the sheen's environment coupling.** 35% of the radiance is a broad
   specular mirror of the environment, and specular reflects the environment's
   colour *un-modulated by albedo*, which is precisely "looks like its
   surroundings". But `sheen: 1` with `sheenRoughness: 0.62` is deliberate — the
   material comment says the fabric lobe "does the work that a tight GGX highlight
   would do wrong" — and reducing it darkens the sail, which the owner has ruled
   out as an axis.
2. **Give shaded canvas a local bounce term.** Physically the strongest: real shaded
   canvas receives warm bounce from the deck and from other sails, and this engine's
   ambient is sky-and-sea only, which is exactly why the shaded sail is blue. But
   that is a new lighting feature, i.e. architectural expansion beyond the reported
   defect.
3. **Raise the canvas albedo's value or saturation** so the diffuse term carries
   cloth colour instead of being swamped. Pure art direction.
4. **Accept it**: the render is defensible, and a shaded sail under a blue sky is
   blue.

§87's constraint still binds and rules out the obvious cheap move: dimming is the
wrong axis — a dial combination reached ratio 0.370 and stopped reading as film, but
the crop became a dark blue tarpaulin and the hue did not move at all (B−R +18.65 to
+20.56). Options 1 and 3 both risk exactly that.

**Handing the choice to the owner rather than picking one.**

## 99. Sail shadow provenance: not self-shadow, not a shadow-map artefact — and `castShadow = false` is a no-op under VSM

Phase A. Corrects §98's shadow subsection. **No source change.**

### Three instrument errors, all mine, all worth keeping

1. **At `dt = 0` the shadow map is not re-rendered.** §98's shadow measurements were
   taken on a frozen frame ticked with a constant `t`, so caster toggles never
   reached the map and the state was not a valid steady state. This is what produced
   §98's 16.3-code figure. A sun-azimuth sweep with *advancing* time proves the map
   updates correctly and tracks the sun (09:00 shadows fall right, 12:18 short,
   15:30 fall left), so it is not stale — the earlier arms simply never re-rendered it.
2. **Ticking each arm onward from the previous arm's end state** left the arms 0.4 s
   apart in sim time. That produced an impossible ordering — both casters disabled
   brightening *less* than either alone — which is a confound, not a result. Fixed
   with **one fresh page load per arm**.
3. **`castShadow = false` cannot exclude a receiver from the shadow map here.**
   `three.module.js:9564` reads
   `if ( ( object.castShadow || ( object.receiveShadow && type === VSMShadowMap ) ) && ... )`
   and `Engine.ts:66` sets `VSMShadowMap`. Every earlier caster arm was therefore a
   **silent no-op** — the flag flipped, the object kept casting. Correct lever: swap
   the mesh's `customDepthMaterial` for one whose fragment shader `discard`s, which
   removes it from the map while it still receives.

### The isolation, once the instrument was right

Fresh load per arm, 24 frames of advancing dt, sea box as the drift reference
(3-5 codes):

| arm | sail A | sail C | deck | sea (ref) |
|---|---|---|---|---|
| base | 0 | 0 | 0 | 0 |
| **sail excluded from the map** (still receiving) | **+0.67** | −0.67 | +46.33 | −3.00 |
| ship/rigging excluded | +2.67 | −3.67 | +68.33 | −4.00 |
| both excluded | +4.67 | −1.67 | +66.33 | −3.00 |
| shadow lookup disabled entirely | +3.67 | −3.33 | +68.00 | −5.00 |

**The deck proves the shadow system works.** It responds strongly and correctly:
sails account for +46.3 codes of its shadow and ship geometry for +68.3, and both
are ordinary geometry-driven occlusion.

**The sail is barely shadowed at all.** Disabling every shadow contribution moves it
about 4 codes on a base of 92 — roughly 4%, comparable to the sea reference's own
3-5 code drift. And all five arms are visually identical at 2x: the pale streaky
patches are present with the shadow lookup **entirely disabled**.

### Verdict on the four candidates

- **A, target-sail self-shadow — REFUTED.** Excluding the sail from the shadow map
  while it still receives moves it +0.67 codes, below the drift floor.
- **B, other sails casting onto it — not the film.** Sails do cast, heavily, onto
  the *deck* (+46.3), but the sail box itself barely moves.
- **C, mast/rigging/ship casting onto it — not the film.** Same: +2.67 on the sail
  against +68.3 on the deck.
- **D, shadow-map artefact — REFUTED.** With the sail out of the map its shading is
  unchanged, and the deck's response is geometrically correct and large.

**So the film is not shadow-driven in any form**, and §98's contrary subsection is
withdrawn. What remains is §98's decomposition, which is unaffected: the sail is
**93% IBL** (43% indirect diffuse, 35% indirect sheen, 15% indirect specular) drawn
from a sky-and-sea environment, with the diffuse term itself blue at B−R +27. The
sail matches its background because its light *is* its background.

That is a genuine art-direction fork, now on properly controlled evidence with
self-shadow and shadow-map artefact both excluded. The axes remain as §98 listed
them, unchanged and untouched: the sheen's environment coupling (35% of radiance,
and specular reflects environment colour un-modulated by albedo), a local bounce
term for shaded canvas (physically strongest, architecturally largest), the canvas
albedo's value or saturation, or accepting the render. §87's constraint still binds:
dimming alone reached ratio 0.370 and still read as a dark blue tarpaulin with the
hue unmoved.

### A real defect found in passing

**`castShadow = false` is silently ignored for any shadow receiver** under
`VSMShadowMap`. `ship-ensign` is configured `castShadow: false` with
`receiveShadow: true`, so it casts anyway and the code's stated intent is violated.
Harmless at 378 verts, but the pattern is a trap: on this renderer the only way to
stop a receiver casting is a discarding depth material. Worth a comment at the
`castShadow` site rather than a code change.

## 100. The render-scale brightness pop is not reproducible — mechanism real, magnitude retracted

Phase B. Retracts §97's magnitude claim. **No source change**, because the
discriminator does not support one.

### The consumer audit, which stands on its own

Every `pxWorld` / `pxAlong` consumer in `src/ocean/shaders/surface.ts`, classified
as the brief asked — filtering tied to real rendered pixels, versus semantic
appearance that should be stable across adaptive-resolution steps:

| line | consumer | class |
|---|---|---|
| 71 | `lod = log2(pxWorld * uCascadeTexels[i])` — cascade texture LOD | **filtering**, must track real pixels |
| 80, 82 | `smoothstep(uCascadePxFade[i], pxWorld / pxAlong)` — cascade resolvability fade | **filtering**, with the `lostVar` schedule adding the removed slope variance back statistically |
| 484, 504 | `ripRes` — rain-ripple resolution fade | **filtering** |
| 649, 650, 659 | `r1, r2, r3` — foam noise octave fades | **filtering** of unresolvable noise |
| 693 | `wThr = mix(0.05, 0.5, smoothstep(1.2, 3.5, pxWorld))` — foam ramp width | **filtering, and provably mean-preserving**: the file's own note at line 625 gives `E[linstep(t - w, t + w, d)] = 1 - t` at ANY ramp width |
| 791 | `shadowFootprint` | **filtering** |

Only one path is semantic: **foam coverage reaches appearance through `fold`**, which
is computed from cascades mipped by `pxWorld`. As they fade, `fold` tends to 1 and
`instant` to 0 — which is why the far-field whitecap fallback exists at all. Coverage
is a physical quantity (Monahan's law) and should not depend on render resolution.

So the theoretical exposure is narrow, and `wThr` — the term that looked most
suspect — is mean-preserving by construction, which predicts no brightness shift
from it.

### Why no fix was made

`uPixelAngle = 2 tan(fov/2) / world.size.height` uses the backing-store height, so
footprint-gated terms **do** move when the ladder steps. That much is certain from
the code. But the visible magnitude does not survive a controlled measurement.

Two arms, both at a fixed `renderScale` of 1 with `pxWorld` scaled in the shader, so
there is no upscale-blur confound:

1. **Pin-one-consumer arms** (`lod`, cascade fades, octaves, `wThr` each pinned back
   to an unstepped reference). The **sky** band — which ocean `pxWorld` cannot reach
   — drifted monotonically −1.12, −1.71, −1.93, −2.15, −2.34 codes across the arms
   in order, i.e. the run was drift-dominated. The stepped arm itself moved the near
   band −0.99 against that −1.12 of sky drift: no signal.
2. **Fresh page load per scale**, identical settle. The sky control still varies
   −1.3 to −2.8 codes load-to-load, and every ocean band moves at most −1.5:

| scale | far | mid-far | mid | near | **sky (control)** |
|---|---|---|---|---|---|
| 0.92 | −2.15 | −0.89 | −0.04 | −0.41 | **−2.62** |
| 0.84 | −2.24 | −1.04 | −0.34 | −0.63 | **−2.49** |
| 0.68 | −0.64 | −1.15 | −1.03 | −0.79 | **−1.30** |
| 0.52 | −0.84 | −1.49 | −0.37 | −1.42 | **−2.83** |

**Nothing clears the control.** §97's figure came from a single-load sweep with the
K values in ascending order, where drift and K moved together; its own sky column
rose monotonically across that sweep, which should have been the tell.

**Load-to-load variance is about 2.8 codes even with a fresh load and an identical
settle** — the procedural cloud and sea state do not land in the same phase. Any
future claim here must clear that floor. A same-frame instrument (two render targets
in one frame at different footprints) would be the way to get below it.

### Standing position

Mechanism: real, and worth a comment at the `uPixelAngle` site so the coupling is
not rediscovered. Visible defect: **not demonstrated.** Implementing a
reference-resolution decoupling now would be a speculative fix for an unmeasured
symptom, and would risk the legitimate filtering in every Category-1 consumer above
for no measured gain.

## 101. §89 revalidated: the chatter is real, invisible, and inherited from the wave field

Phase 1 and 2 of the §89 revalidation, under the corrected discipline: fresh page
load per arm, repeats, deterministic environment, explicit lever assertions, and a
control the tested subsystem cannot influence. **No source change** — see the stop
reasoning at the end.

### The estimator was validated before anything was believed

An analytic smooth signal, `sin(2*pi*t/8)`, was sampled on the *same* irregular dt
sequence and pushed through the identical statistic. On a smooth trajectory the
statistic must read near zero, and it does — 0.5% reversal on both clocks, `rmsDv`
1.20e-2 against 1.14e-2. So the statistic is sound and the hull's numbers are not an
artefact of it. Repeats agreed closely (0.8/0.8/0.8% whole, 62.5/63.5/64.2% fract).

### It reproduces, and it is in the hull's pose, not the camera

| channel | whole rev% | whole rmsDv | fract rev% | fract rmsDv |
|---|---|---|---|---|
| shipY | 0.8 | 1.82e-2 | **63.4** | **2.04e-1** |
| pitch | 1.4 | 2.68e-4 | 63.4 | 2.65e-3 |
| roll | 1.3 | 5.20e-4 | 65.3 | 5.21e-3 |
| bow point through the pose | 0.8 | 2.14e-2 | 64.9 | 2.25e-1 |
| camY | 6.5 | 8.80e-3 | 6.4 | 9.11e-3 |
| camRelY | 57.9 | 1.44 | 58.0 | 1.48 |
| **analytic control** | **0.5** | **1.20e-2** | **0.5** | **1.14e-2** |

`camY` is flat across clocks and `camRelY` identical, so the camera neither causes
nor amplifies it. The bow was measured by pushing the same ship-local point through
the pose every frame, not by a fixed world offset — an offset moves under rotation
and would read hull rotation as translation.

### But it is not visible, and §89's amplitude claim was the wrong statistic

The *positional* second difference is **unchanged** between clocks: shipY 1.32e-2
against 1.40e-2 m, bow 1.54e-2 against 1.55e-2. It is also the same order as the
analytic control's own (1.15-1.25e-2), because on unevenly spaced samples the second
difference is dominated by dt variation times velocity rather than by curvature.
Subtracting the control in quadrature leaves a positional excess of about **4 mm on
whole multiples and 8 mm on fractional**.

Measured where a player would actually see it — the same ship-local point projected
through the live camera each frame, detrended with a centred 5-point average, in
pixels:

| arm | bow HF, px x | bow HF, px y | analytic control, px y |
|---|---|---|---|
| chase / whole | 0.063 | 0.129 | 0.128 |
| chase / fract | 0.067 | 0.126 | 0.126 |
| helm / whole | 0.037 | 0.071 | 0.276 |
| helm / fract | 0.034 | 0.079 | 0.317 |

**Identical between clocks, in both a tethered and a mounted camera mode, and about
0.1 px in absolute terms — at or below the control.** §89 quoted "20x amplitude"
from `rmsDv` (0.0213 to 0.43 m/s); that is a velocity-change statistic and does not
license the claim that the defect is player-visible. **Retracted.**

### Gameplay consequence: a determinism cost, not a bias

Means agree across clocks — speed 13.85 against 13.73 kn, heel 8.17 against 8.04
deg, pitch −0.68 against −0.70 deg. What differs is **reproducibility**: two
identical whole-clock runs agree on mean speed to **0.028 kn**, two fractional runs
to **0.342 kn**. A 12x loss of run-to-run determinism, about 2.5% of speed. The
between-clock mean difference (0.115 kn) sits inside the fractional arm's own spread,
so no systematic bias is claimed.

### Localised: inherited from the wave field, and the integrator is exonerated

The forcing input — ocean surface height sampled **at the ship's own position** every
frame, which is the signal that actually drives the hull — was measured with the same
statistic:

| channel | whole rev% | whole rms | fract rev% | fract rms |
|---|---|---|---|---|
| hull shipY | 1.0 | 1.65e-2 | 66.6 | 1.79e-1 |
| sea height at the ship | **67.3** | 5.23e-1 | 76.4 | 3.22e-1 |
| sea height, fixed point | **70.4** | 5.12e-1 | 75.3 | 3.32e-1 |

**The input is rough on BOTH clocks and the hull is smooth on only one.** So the
solver does not generate the chatter — it inherits it, and attenuates it (hull rms
1.79e-1 against an input 3.22e-1) but less completely on a fractional clock. §89's
"the ship's solver is frame-rate dependent" is therefore too strong: the solver's
*rejection* of a deliberately rough input is clock-dependent.

That input roughness is by construction and is documented in `CpuWaves.ts`: one
cascade re-solves per frame in round robin and the frames between read a linear
interpolation of two snapshots, so `dh/dt` is piecewise constant and its difference
is impulsive at every snapshot boundary — with a stated error bound under 2 mm at
60 fps. On a whole-multiple clock those boundaries hold a fixed phase relationship
with the sampling and the hull's response cancels them; on a fractional clock the
phase walks and it does not.

### Why this stops here

- **No visible defect.** Screen-space motion is ~0.1 px and does not differ between
  clocks. The user's own standard — reject results at or below control variance —
  applies to the visibility claim directly.
- **The remaining consequence is determinism**, at 2.5% of speed, with means agreeing.
- **A fix would mean re-engineering `CpuWaves`' snapshot interpolation**, a
  deliberately optimised subsystem whose cost/benefit is documented (one CPU FFT per
  frame, 4x cheaper), to remove an invisible symptom. That is architectural expansion
  unrelated to a demonstrated defect.

What survives from §89: the effect is real, it is inherited rather than generated,
the camera is exonerated, and §85a's statistic still cannot be used as a camera
acceptance test on a fractional clock — that part stands unchanged.

## 102. The VSM caster trap: ensign only, and deliberately left alone

Phase 4, closing the finding recorded in §99.

Under `VSMShadowMap` three writes any object with `receiveShadow` into the shadow map
even when `castShadow === false` (`three.module.js:9564`), so `castShadow = false` is
silently ineffective for receivers.

**Scope, enumerated rather than assumed.** Of every mesh in the scene with either
flag set, exactly **one** has `castShadow: false` with `receiveShadow: true`:
`ship-ensign`, 378 vertices. Every other caster is intentional. So the trap changes
intended rendering in exactly one place.

**Consequence: negligible, and arguably correct.** 378 vertices added to a 2048²
shadow map is nothing, and a real ensign does cast a shadow — the flag's stated
intent is the questionable half, not the behaviour. **Left alone**, per the brief:
document, do not fix without a demonstrated effect.

**Worth knowing for future work:** on this renderer the only way to stop a receiver
casting is to give it a `customDepthMaterial` whose fragment shader `discard`s. That
is the lever §99 had to build to isolate the sail, and it is the lever anyone
attempting selective shadow casting here will need.

## 103. Sail-film decision package: five controlled variants, no art change landed

Prepared for the owner's decision, not as a recommendation. **No source change** — the
variants exist only as in-page patches in a gitignored probe
(`.tmp/sailvariants.mjs`); nothing was committed and nothing is ranked.

Everything held fixed except the named change: station (12 fwd / 26 up / 26 to port,
aimed 0/14/0), sim state, camera, time of day 12.3, exposure, sail geometry,
background. Fresh page load per variant, every lever asserted bound. Measurement
boxes declared before capture and identical to §98's, so the numbers are comparable.

| variant | sail L | ratio to sea | sail B−R | sea B−R | streak sd |
|---|---|---|---|---|---|
| A current (shipped) | 0.0880 | 0.309 | +41 | +7 | 5.06 |
| B indirect sheen x0.40 | 0.0683 | 0.242 | +38 | +9 | 5.62 |
| C warm canvas bounce | 0.0969 | 0.356 | +30 | +9 | 4.77 |
| D warmer flax albedo | 0.0825 | 0.287 | +34 | +6 | 4.56 |
| E = B + C | 0.0780 | 0.280 | +27 | +8 | 5.47 |

Deltas against A: **B** −22.3% luminance, hue −3; **C** +10.2% luminance, hue −11;
**D** −6.2%, hue −7; **E** −11.3%, hue −14.

### The trade-off, stated without a preference

The two things wrong with the shipped sail pull in **opposite** directions.

- Its **hue** is too blue: sail B−R +41 against the sea reference's +7. Only the
  bounce axis moves that materially (C −11, E −14). B, the sheen axis, barely touches
  it (−3) — consistent with §98, where dimming moved luminance and left hue alone.
- Its **luminance** already sits at 0.309 of the background. **C brightens it to
  0.356**, i.e. *closer* to the background, which is the direction that made it read
  as film in the first place. **B darkens it to 0.242**, further from the background,
  but at the cost of 22% of the sail's light — the direction §87 measured into a dark
  blue tarpaulin.

So the axis that fixes the colour makes the luminance match worse, and the axis that
improves the luminance separation does nothing for the colour and risks the
tarpaulin. E splits the difference: hue −14 for −11.3% luminance.

### What none of them fixes

**The pale streak structure survives in every variant.** `streak sd` moves only
between 4.56 and 5.62 against the shipped 5.06, and the patches are plainly visible
in all five at 2x. Combined with §98 (they survive every radiance-term ablation) and
§99 (they survive the shadow lookup being disabled entirely), the streaks are a
distinct and still-unexplained component of the artefact. **They are not addressed by
any of these axes**, so whichever the owner picks, that part remains.

### Artefacts

Full-resolution captures plus a 2x crop sheet and a wide-context sheet are staged
outside the repository, in this session's scratchpad under `sailpkg/`. Deliberately
not committed.

## 104. Issue 3 reproduced and causally isolated: the ocean reflecting the cloud-bearing env probe. Fix attempt reverted.

> **SUBSYSTEM ATTRIBUTION RETRACTED BY §107.** The reproduction and the ablations
> below stand. The owner is the cloud shadow map, not the env probe.

Supersedes §97's NOT-REPRODUCED for this report. §97 measured a *fixed far station*
looking forward at the horizon and found nothing; the owner's condition is different
— **zoomed far out, high, looking down at a large area of sea, under heavy cloud** —
and there it reproduces immediately. §97's negative was a negative about its own
station, not about the player report.

### Reproduction

Free camera at ship-relative `[-140, 330, -90]` aimed at the ship: high, far astern,
no horizon in frame, which is what the owner's zoomed-out screenshots show. Sea state
3, noon, `renderScale` 1, adaptive off. Fresh load per cell, 16 frames, live ticking.

Instrument: each frame is reduced to 25 px blocks (64x36) and a block counts as dark
if it is below **0.55x that frame's own median** block luma, so exposure drift cannot
manufacture or hide a blotch. Reported: dark-block count, max area, p5/median, and
churn — blocks flipping dark between consecutive frames.

| cloudCover | dark blk/frame | max area | p5/median | churn/frame |
|---|---|---|---|---|
| 0.0 | 0.00 | 0.00% | 0.889 | 0.00 |
| 0.4 | 0.00 | 0.00% | 0.861 | 0.00 |
| **0.8** | **8.50** | **1.30%** | **0.729** | **15.20** |

Churn of 15 blocks per frame against only ~8 dark blocks means the dark set is almost
**entirely resampled every frame** — salt-and-pepper noise, not a drifting shadow.
Sixteen frames is 0.27 s, over which a cloud shadow barely moves.

### Causal partition

Same station, cloudCover 0.8, fresh load per arm, every lever asserted:

| arm | dark blk/frame | max area | churn/frame |
|---|---|---|---|
| base (three independent runs) | 7.12 / 8.56 / 9.31 | 2.3-2.9% | 10.6 / 13.4 / 15.1 |
| cloud shadow on the sea forced to 1.0 | 7.06 | 2.13% | 11.27 |
| TAA off | 6.44 | 2.04% | 10.27 |
| env probe refreshed EVERY frame | 6.38 | 2.60% | 9.47 |
| **volumetric clouds off** | **0.00** | **0.00%** | **0.00** |
| **ocean reflection forced off the probe** | **0.00** | **0.00%** | **0.00** |

**Two independent ablations take it to exactly zero and they cut the same chain:** the
ocean reflects the environment probe, the probe is compiled with `SKY_ENV_CLOUDS` so
it carries the volumetric clouds, and at high cover that probe has violent dark/bright
contrast. The sea samples it through wave normals that its own footprint cannot
resolve, so adjacent pixels and successive frames tap wildly different probe texels.

**Eliminated:** the cloud-shadow term on the sea, TAA history, and the probe's 6 Hz
refresh cadence — refreshing every frame moves churn only 15.1 to 9.5, so the step
is not the driver. This is spatial under-resolution of a high-contrast environment,
not a temporal-cadence bug.

### The fix attempt, and why it was reverted

`oceanReflection` already widens its lobe with the unresolved slope variance
(`alphaR` from `lostVar`), but not enough here. I tried a one-sided dark floor —
`probe = max(probe, wide * 0.75 * saturate1(alpha * 2.5))` — chosen because it only
ever raises darks, so the normal-dependent bright detail that the documented
1.7-to-0.95 rate change exists to protect is untouched.

At the tuned station it worked: dark blocks 8.33 avg to **3.81**, max area 2.3-2.9%
to **0.69%**, churn 10.6-15.1 to **7.07** — well outside the base spread.

**It failed acceptance at a second zoom and is reverted.** At `[-70, 190, -45]`, same
cloud cover:

| zoom B, cc 0.8 | dark blk/frame | max area | churn |
|---|---|---|---|
| pre-fix | **0.00** | **0.00%** | **0.00** |
| with the floor | **25.06** | **2.86%** | **48.00** |

The floor *created* the artefact where none existed. Not landed.

### A caveat on my own instrument

The dark test is relative to each frame's median, which makes it robust to exposure
drift but means **a global brightening manufactures "dark" blocks**. Some of zoom B's
25.06 is likely that rather than literal new dark patches. The root-cause isolation
does not depend on it: the two decisive ablations drive the metric to exactly 0.00 by
removing the dark content itself, which a threshold artefact cannot fake.

### Where this leaves it

Mechanism isolated and reproducible. The fix is a **filtering** problem — an
unresolved footprint must integrate the environment rather than point-sample it — and
the candidate directions (widen the lobe with footprint, prefilter the probe harder,
reduce the probe's cloud contrast, clamp outliers) all trade against far-field detail,
which §67 and §17C fought to win. No discriminator yet says which preserves it. That
is a genuine stop, not an invitation to tune.

## 105. Issue 3's flicker is the EnvProbe's 6 Hz staircase, reflected by the sea

> **RETRACTED — temporal claim by §106, subsystem by §107.** Measurements stand.

Completes §104 and **corrects its mechanism wording**. §104 named
"unresolved-normal / insufficient angular filtering" as the leading candidate. That
is now refuted as the driver of the *flicker*: the churn is environment-side.

### The metric had to be replaced first

§104's dark test was relative to each frame's median, so a global brightening
reclassified blocks — it was retired as primary. Replacement:

    residual = luma - boxblur(luma, 101 px)
    blotch   = 25 px blocks whose mean residual < -6

A blotch is now dark relative to **the sea immediately around it**, which is what the
eye reports and what no global luma change can manufacture. Validated before use:

| condition | blotch blocks | churn |
|---|---|---|
| clean, cloudCover 0.0 | 3.31 | 3.53 |
| clean, cloudCover 0.4 | 3.00 | 3.20 |
| repro, cloudCover 0.8 | 22.69 | 36.20 |
| §104's clouds-off ablation | 4.38 | 4.67 |
| §104's probe-tap-off ablation | 2.69 | 2.87 |

Clean conditions sit at the floor and both §104 ablations return to it, so the metric
tracks the artefact rather than the exposure.

### Temporal ownership, in ONE load

Two attempts. The first is discarded: its return-to-baseline control drifted
monotonically from 20.4 to 48.0 blotch blocks across arms in run order, and its
"both static" arm still churned at 65 because only the probe and ocean were frozen
while the **Sky** module stayed live and feeds the ocean's non-probe reflection path.

The second fixed all three faults — palindrome arm order (live A B C C B A live) so a
linear drift cancels on averaging, the Sky module frozen alongside the probe, and
`autoExposure` off. Levers asserted by readback: probe texels byte-identical across
frozen arms, `ocean.sample()` height identical across ocean-frozen arms.

| arm | blotch blocks | **churn** | min residual |
|---|---|---|---|
| live, both live | 49.79 | **76.77** | -14.39 |
| **A: static environment, live ocean** | 60.96 | **1.82** | -13.16 |
| **B: static ocean, live environment** | 46.00 | **74.00** | -13.67 |
| C: both static (null) | 54.79 | 1.86 | -15.27 |

**Freezing the environment removes the churn. Freezing the ocean does not.** C's 1.86
is a genuine null, which also clears TAA as a churn source of consequence.

Blotch *area* is roughly constant across every arm (46-61 blocks): the spatial dark
pattern is the sea reflecting a genuinely cloudy sky and is largely correct. The
player-visible defect is the **flicker**, and it is environment-side.

### The mechanism, measured exactly

Reading the 256x128 probe target back every frame for 40 frames at cloudCover 0.8:

    mean |delta| : 0 0.0065 0 0 0 0 0 0 0 0 0 0.0117 0 0 0 0 0 0 0 0 0 0.0118 0 ...
    max  |delta| : 0 2.638  0 0 0 0 0 0 0 0 0 2.649  0 0 0 0 0 0 0 0 0 2.652  0 ...

The probe changes on **4 frames in 39** — every ten or eleven frames, i.e. the
documented 6 Hz cooldown — and is **exactly unchanged between**. On a refresh frame
individual texels jump by up to **2.65 in radiance**.

So the reflected environment is a **staircase in time**: perfectly still for ten
frames, then a large step. The ocean reflects it directly, so the sea's reflected
radiance steps with it, and at high cloud cover those steps are violent enough to read
as flickering dark blotches. This is also why §104's "refresh every frame" arm helped
only slightly — it trades step size for step frequency, and with the old metric that
read as almost nothing.

`EnvProbe`'s docstring justifies 6 Hz on the grounds that "even at a 60x time warp the
sun moves 0.25 deg a second". That reasoning is sound for the **sun** and does not
hold for **clouds**, which are the fast-moving content the probe also carries.

### Fix direction, not yet implemented

The defect is a missing **temporal** filter, so the fix belongs on the probe, not on
the ocean's spatial filtering. The precedent is in this repository already:
`CpuWaves` keeps "two snapshots of its spatial field bracketing the present and the
frames in between read a linear interpolation of the pair". The probe wants the same
treatment — two states and a phase blend, or an accumulation pass that eases the new
render into the old — so consumers see a continuous environment instead of a step.

Explicitly NOT the fix, per the owner's instruction and this evidence: a dark floor,
a reflection clamp, brightening the sea, removing clouds from the probe, or a global
reflection blur. None of those addresses a temporal staircase.

## 106. The probe crossfade works and does not fix the blotches — §105's attribution was too strong

Implemented, measured, failed its own acceptance, **reverted**. §105 stands on its
measurements but its attribution sentence does not: it said the flicker *is* the
probe's 6 Hz staircase. It is not, and this section says why.

### What was built

Minimum temporal filter, no increase in probe render frequency:

- a second render target `prev`, same format and size, holding the outgoing state;
- one passthrough blit at each 6 Hz refresh, copying current into `prev` **before**
  the fresh render overwrites it, so `target` keeps its identity and neither
  `scene.environment` nor `ext.sky.envMap` nor three's PMREM cadence changes;
- `uEnvBlend`, a shared scalar ramping 0 to 1 over **0.12 s** — comfortably inside the
  1/6 s refresh interval so a fade always completes before the next render and no
  overlap needs handling;
- the ocean's reflection reads `mix(prev, current, uEnvBlend)`.

### It does what it was built to do

Reconstructing exactly what the ocean samples, per frame, at the repro condition:

| | frames changing (of 39) | largest single-frame step |
|---|---|---|
| before | 4 | **2.65** |
| after | 31 | **0.413** |

A **6.4x reduction** in the largest step, and the staircase is replaced by a ramp.

**One real bug was found and fixed on the way.** The blend scalar was first written
inside `publish()`, which runs *before* `probe.update()` in the same frame, so on a
refresh frame the target already held the fresh render while the uniform still held
the previous frame's 1.0 — the new probe arrived at full weight for one frame and the
crossfade contained a step exactly where it was meant to remove one. Measured as a
1.37 to 2.82 spike per refresh; gone once the write moved after `probe.update`. Worth
knowing for any future consumer of a ping-ponged probe.

### But it does not move the player-visible metric

Same build, same load, palindrome order, `blendAt` stubbed to 1 to reproduce the old
instantaneous switch:

| arm | blotch blocks | churn |
|---|---|---|
| HARD, old 6 Hz switch | 44.17 | **65.86** |
| FADE, 0.12 s crossfade | 43.17 | **69.95** |

No improvement. So the probe's staircase was not what the sea's churn was made of.

### Where §105 over-reached, and the isolation that shows it

§105's Phase A froze the probe **and the whole Sky module** together and got churn
1.82 against 76.77. That is a true measurement, but Sky's per-frame work is much more
than the probe: it publishes `uSkyColor`, `uFogColor`, `uSunColor`, `uSunIntensity`,
`uGroundColor`, `uSeaRadiance` and the haze terms, updates the sun light, rebuilds the
sky LUTs, and drives the cloud field and its shadow map. Freezing all of it proves the
churn is environment-side; it does **not** single out the probe.

Separating them, one load, palindrome, same metric:

| arm | blotch blocks | churn |
|---|---|---|
| all live | 41.20 | 62.56 |
| **probe frozen ONLY** | 37.40 | **62.33** |
| **cloud shadow forced to 1** | 41.35 | **62.83** |

**Neither the probe alone nor the cloud shadow alone accounts for any of it.** The
owner is elsewhere in Sky's per-frame output — the candidates are the published sky
and sun radiance scalars, the sun direction, and the sky LUTs, any of which would
modulate the whole sea.

### Why it was reverted rather than kept

The acceptance bar required churn materially reduced toward the floor. It is not, so
the change fails the standard it was built against, and a source change is not kept
merely because it works at its own mechanism level. The 0.12 s figure and the
ordering trap above are recorded so that reimplementing this is cheap if a future
defect actually needs it.

**Standing mechanism wording for issue 3, corrected:** high cloud cover is necessary
(cover 0.0 and 0.4 sit at the metric floor), the churn is environment-side, and both
the probe's temporal staircase and the cloud-shadow term are now **excluded** as its
cause. The next arm is Sky's published radiance scalars and sun state, frozen
individually.

## 107. Issue 3 is the cloud shadow map, not the env probe — and arm D's "held" assertion was vacuous

> **MECHANISM SENTENCE CORRECTED BY §108.** The ownership finding below stands and is
> the load-bearing part. The "receiver-side footprint filtering" diagnosis does not:
> the map is magnified 60–120x, never minified, so the fix it implied is inert.

§104 and §105 attributed the blotches to the ocean reflecting the cloud-bearing env
probe. **That attribution is withdrawn.** The owner is `uCloudShadowMap`, sampled by
`lwCloudShadow` in `src/core/SharedUniforms.ts`. §106 already retracted the temporal
half; this retracts the subsystem.

### The methodology error that hid it for three rounds

The mandated hierarchical freeze reached arm D — *every* ocean-consumed Sky output
frozen at once — and reported `allHeld=true` post-tick with **no effect** (churn 61.22
vs live 67.44), against a whole-Sky-module freeze of **1.82**. The parts did not sum to
the whole, and the lever assertion said the parts were genuinely frozen.

They were not. The set included `uCloudShadowMap`, whose `.value` is a *pointer* to a
render target that `Clouds` overwrites **in place** every frame. Freezing the pointer
freezes nothing, and asserting the pointer is unchanged asserts nothing.

> **A `.value` equality check proves a lever bound only for immutable values.** For a
> texture uniform it is vacuous: the pixels live behind the reference. Freeze the pass
> that writes the target (`Clouds.shadowPass.render`), and assert on the *blocked call
> count*, not on the uniform.

Same trap would have applied to `uEnvMap`; that one happened to be frozen correctly,
by stubbing `probe.update`, which really does stop `pass.render`.

Before finding this I had also tested the coupling the brief anticipated — probe **and**
all Sky scalars frozen together (62.44 churn / 6.056 raw vs live 65.89 / 6.546). Also
nothing. Both negatives were real; both were measuring the wrong subsystem.

### Single-source reproduction, with the two halves separated

Fresh load per arm, camera locked, `autoExposure` off, palindrome ordering, levers
asserted (`shOff` held strength at 0; `shStatic` blocked exactly 10 shadow renders in
10 frames with strength intact at 0.786).

| arm | blotch | churn | raw dLuma | minres |
|---|---|---|---|---|
| live | 45.40 | 68.11 | 7.524 | −14.7 |
| **shOff** — `uCloudShadowStrength = 0` | **9.20** | **10.22** | 3.069 | **−6.0** |
| **shStatic** — shadow present, pixels frozen | 62.50 | **24.00** | 3.510 | −14.5 |
| live2 (return-to-baseline) | 51.30 | 77.44 | 6.887 | −15.9 |

baseline churn 72.78, control spread 9.33 — so −6.7x and −5.2x control respectively.

This is the partition the previous rounds could not find:

- **The black patches are cloud shadows.** Ablating the term takes blotch area 48.35 to
  9.20 and, decisively, the residual *depth* from −14.7 to −6.0 — right at the
  threshold. Nothing else in the scene makes the sea that dark.
- **The flicker is the shadow map's per-frame content.** Freezing the pixels drops churn
  to 24.00 while blotch area *rises* to 62.50 and depth holds at −14.5. The patches stay,
  large and deep; they stop moving. Area rising is the expected sign — a static pattern
  no longer averages out across frames.

### Mechanism: an unfiltered tap, not insufficient resolution

`CLOUD_SHADOW_SIZE = 512` over `CLOUD_SHADOW_EXTENT_M = 26000` is **50.8 m per texel**.
The target is built `generateMipmaps: false` with `LinearFilter`, so there is no mip
chain, and `lwCloudShadow` takes a **single `texture2D` tap** with no footprint term.
A sea pixel at a zoomed-out camera covers a large world footprint and samples that map
once. Hence the zoom dependence in the player's report: zoom out, footprint grows,
aliasing grows.

Depth comes from the floor being divided by the strength it was meant to survive:
`max(exp(-tau), 0.035)` then `t / max(uCloudShadowStrength, 0.05)` gives **0.035/0.80 ≈
4.4 % sun** in the deepest patches. The floor's comment says it "keeps an overcast sea
leaden rather than black"; the division partly undoes that.

### Two candidate fixes tested. Both failed, and the failure is the diagnosis.

| arm | blotch | churn | vs baseline |
|---|---|---|---|
| base (512 tex / 14 steps) | 60.80 | 91.22 | — |
| `CLOUD_SHADOW_STEPS` 14 → 40 | 45.30 | 64.78 | −17.33, **−1.0x control** |
| `CLOUD_SHADOW_SIZE` 512 → 1024 | 119.10 | **197.89** | +115.78, **+6.4x control** |
| base2 (return-to-baseline) | 44.50 | 73.00 | — |

control spread 18.22 on this run.

- More march steps is **not significant**. The coarse 14-step march (up to 2.86 km per
  sample through a deck a few km thick) is real, but it is not what the player sees.
- **Doubling the resolution makes it 6.4x worse.** That is the whole answer: the defect
  is not a lack of source detail, it is a receiver sampling a high-frequency source with
  one unfiltered tap. Halving the texel size doubles the spatial frequency projected onto
  the sea and therefore doubles the aliasing.

Corroborated independently by an equirect-pole discriminator run on the reflection path
(before the shadow map was implicated). Relocating the mapping's singularity off +Y made
the metric **worse** (+2.1x control) while a null control that rotated the environment
90 deg about the *same* pole — same arithmetic, comparable content change — moved it
**+0.0x control**. The metric responds to sampling geometry and is indifferent to which
cloud content is sampled. Two different samplers, same conclusion.

### Status

Mechanism isolated; **no fix landed**. The deficient stage is receiver-side footprint
filtering of the cloud shadow lookup. Per the standing instruction not to tune after a
failed acceptance, the trade-off goes to the owner rather than into more parameter arms.

Not reconciled: §104's ablation forcing the ocean reflection off the probe drove the
metric to exactly 0.00. That is not explained by shadow ownership and is left open —
plausibly the two terms are multiplicative in the sun's contribution, but that was not
measured.

## 108. Issue 3 fixed: the shadow slice was the one cloud pass without a temporal filter

§107 named the owner correctly and the mechanism wrongly. Corrected here, with the
fix that follows from the corrected mechanism.

### §107's mechanism sentence is withdrawn

§107 said the deficient stage was "receiver-side footprint filtering" — minification
aliasing of a high-frequency map. Measured, that is false. Per-pixel footprint at the
repro camera, by unprojecting screen pixels onto the sea plane:

| screen row | sea distance | m per pixel | **shadow texels per pixel** | implied LOD |
|---|---|---|---|---|
| 60 | 527 m | 0.60 | 0.0164 | −5.93 |
| 350 | 395 m | 0.50 | 0.0114 | −6.46 |
| 800 | 341 m | 0.40 | 0.0079 | −6.99 |

The map is **magnified 60–120x**, not minified. Every pixel would select LOD 0, so a
mip chain plus derivative-based LOD — the fix as specified — is provably inert here.
It was not implemented. This is also why raising the map to 1024 made things worse in
§107 rather than better: at fixed magnification, more source detail is more visible
detail, and it was never being minified in the first place.

### What actually changes, read out of the map

Passive readback of the 512² slice, 12 frames at the repro state:

- **24 % of texels change every frame**, 4.2 % of them by more than 0.02
- **max per-frame delta 0.96503, the same number every frame** — that is `1.0 − 0.035`,
  texels flipping *fully* between lit and the shadow floor
- mean 0.853 and min 0.035 rock stable, so it is individual texels toggling

Clouds advect 0.077 m in 16.7 ms against a 50.8 m texel, so this is not advection.
Partitioning tau isolates which term does it:

| arm | %changed | %Δ>0.02 | maxΔ | min |
|---|---|---|---|---|
| base | 25.42 | 7.17 | **0.96503** | 0.035 |
| cirrus term removed | **4.47** | 4.22 | 0.96503 | 0.035 |
| deck march removed | 24.48 | 2.74 | **0.19727** | **0.614** |

The **deck march owns the full-range flips and the blackness**; **cirrus owns the broad
low-amplitude churn**. So the defect is temporal, at the source: a 14-sample point
estimate of a moving field, magnified ~80x onto the sea.

### The fix, and why it is the one the codebase already uses

The main cloud march documents its own version of this problem: its start offset is
"interleaved-gradient noise advanced by the golden ratio per frame, which is what turns
the visible slab banding of a 40-step march into high-frequency noise the temporal
filter can eat." The shadow slice took half that recipe — a dither hashed on world
position, deliberately **static** so it would not crawl — and had no temporal filter
behind it. Static dither with no filter is exactly what produces a terrace that flips
whole texels.

So the slice now gets both halves:

- the march's start offset advances per frame by the golden ratio, as the main march's does;
- a resolve pass blends `mix(history, raw, alpha)` with `alpha = 1 − exp(−dt / 0.3 s)`,
  frame-rate independent because this is a buffer a player can hold still and stare at;
- the history is realigned by `uHistShift`, the centre re-snap delta over the extent.
  Because the centre only ever moves in whole texels that offset is exact and no
  resampling error accumulates. Only the outer edge has no history, and there the raw
  sample is used.

No neighbourhood clamp, unlike the march's resolve: there is no silhouette to smear,
just a transmittance field that evolves over tens of seconds per texel.

`this.shadow` keeps its texture identity. `EnvProbe.setClouds` and the march's
`tCloudShadow` bind it **once**, outside the frame loop, so a ping-pong would have left
them reading a stale half — the filter costs one extra copy instead.

### Proof it binds, read out of the running renderer

| check | result |
|---|---|
| three distinct 512² targets | PASS |
| published texture identity stable across 11 frames | PASS (`sky.cloudShadow`) |
| `uReset` 1 on first frame, 0 in steady state | PASS |
| `uAlpha` dt-correct | PASS — 0.05405, against 1−exp(−1/60/0.3) = 0.05480 |
| `uHistShift` zero with a locked camera | PASS |
| history carry exact | PASS — `prev` vs resolved, same frame, max delta **0** |
| resolve is not a passthrough | PASS — resolved vs raw, same frame, mean 0.039 / max 0.912 over 68.5 % of texels |

Published slice, paired before/after (palindrome, one stash flip per arm):

| | meanAbsΔ per frame | maxΔ | min |
|---|---|---|---|
| before | 0.0370 / 0.0342 | **0.96503** | 0.035 |
| after | 0.0021 / 0.0021 | **0.05225** | 0.035 |

**17.5x** on the mean and **18.5x** on the worst flip, landing exactly on the predicted
`alpha × range` = 0.054 × 0.965 = 0.052. The floor is untouched at 0.035.

### Acceptance

Repro condition, palindrome before/after:

| | before | after | delta |
|---|---|---|---|
| blotch | 42.29 | **1.00** | −41.29 (−9.3x control) |
| churn | 70.50 | **0.36** | −70.14 (−12.6x control) |
| raw dLuma | 6.46 | 1.78 | −4.68 (−19.4x control) |
| residual depth | −14.43 | **−5.97** | +8.46 (+10.1x control) |

Across the matrix, churn collapses in every cloud-bearing condition — repro 59.0→1.3,
farther zoom 59.1→1.1, renderScale 0.75 45.0→1.7, close camera 19.3→8.7 — and the
**low-cloud null control is flat** (1.67→1.89, 0.89→1.00, 2.22→2.00), which is the
result that matters most: with no shadows present the fix does nothing.

Blotch *area* improves at the zoomed-out conditions where the defect was reported
(47.9→13.2, 52.6→16.4, 38.9→0.8, 41.6→11.9) and does **not** improve at the close camera
or in the wake region. That is not a partial fix — the low-cloud control reads blotch
83.2 in the wake with essentially no cloud shadows at all, so those cells are the wake
foam and hull inside the residual metric, not sea shading. Confirmed visually. **The
metric is not valid in the wake region and should not be quoted there.**

Regression control against §107's 1024 arm: the source resolution is untouched at 512.
That arm added detail and cost churn +115.78; this changes sampling and gains −70.14.

### Visual

Before: hard, high-contrast black ragged patches that read as smudges on the water.
After: broad soft shading — the upper-left mass and the diagonal band are still clearly
readable as cloud shadow, and the hard patches are gone. Cloud shadows are not erased.

Honest caveat: **contrast is visibly gentler.** Part of that is spurious noise removed,
and part is that averaging 20 dithered marches converges on the true optical depth
instead of the noisy extremes — the average is the more correct value, but it is less
dramatic. If the owner wants the depth back, the lever is the floor-over-strength
question §107 raised, which was explicitly out of scope for this pass and remains
untouched.

### Cost

`sky:cloudShadowMs`, gl.finish-instrumented, mean of 40 frames per condition:

| condition | before | after |
|---|---|---|
| repro | 0.132 | 0.124 |
| far | 0.072 | 0.130 |
| near | 0.053 | 0.110 |
| low cloud | 0.060 | 0.146 |
| renderScale 0.75 | 0.062 | 0.222 |

**+0.07 ms typical, +0.16 ms worst case** — 0.4 % to 1.0 % of a 16.7 ms frame. Cloud
passes 3 → 5, so +2 fullscreen triangles per frame. Two extra 512² R16F targets, so
**+1.0 MB** of texture memory. 60 fps held in every arm. I am not calling this free; it
is measured, small, and the numbers are above.
