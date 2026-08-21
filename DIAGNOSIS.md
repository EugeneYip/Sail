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
