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
