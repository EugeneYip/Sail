# Handover — Leeward

For anyone picking this up cold: a different Claude session, a GPT account, or a
human. Read this, then `AGENTS.md` (the build contract), then `DIAGNOSIS.md` (the
measured defect list). Those three are the whole institutional memory.

## What this is

An endless procedural sailing game in the browser. You helm the USS Constitution
(1797 frigate) on an open ocean. The reference bar is **slowroads.io or better**:
calm, endlessly beautiful, somewhere you just want to sit.

**Everything is generated in code** — hull, rigging, sails, ocean, sky, clouds,
textures, audio. No downloaded assets of any kind. That constraint is deliberate
and has paid off: the shipped bundle is ~400 KB gzipped for a game carrying an FFT
ocean, a four-LUT atmosphere and a full square-rig.

Stack: Three.js 0.185 + Vite + TypeScript. WebGL2. Target 60 fps at 1600x900 on an
Apple M2 at the `ultra` tier.

## Where things are

```
src/types/index.ts     THE CONTRACT — read in full before touching anything
src/core/              Engine, render hook, shared uniforms, settings
src/{ocean,sky,ship,physics,vfx,world,camera,ui,audio,env,post,input}/
scripts/capture.mjs    headless multi-scene screenshotter + perf harness
scripts/check-glsl.mjs GLSL lint (see "the recurring bug" below)
scripts/physics-test.mjs, assist-test.mjs   asserted physics behaviour
.tmp/                  throwaway diagnostic probes (gitignored)
```

**Architecture in one paragraph.** The engine owns a mutable blackboard (`World`).
Subsystems are `Module`s: constructed with no arguments, `init(world)` once, then
`update(world)` every frame in a fixed order. **Modules never import each other's
concrete classes** — they communicate only through the blackboard, with
`world.ext.<subsystem>` as the namespaced handoff for richer objects. That is what
let a dozen subsystems be built in parallel by separate agents.

## How this project is worked

Fan out one agent per directory, strictly one owner per directory at a time.
Concurrency is the whole point but it has two hard rules learned the hard way:

- **Commit each agent's output the moment it reports.** Uncommitted work in this
  shared tree has been destroyed twice — once by `git checkout <sha> -- src/` during
  a bisect, once swept into the wrong commit by `git add -A`. Both are now banned in
  `AGENTS.md`. Stage explicit paths.
- **Wire first, then deepen.** An early wave of ten agents wrote ~29k lines of good
  component code and every one was interrupted before connecting its entry class —
  the app typechecked, booted, and rendered placeholders. Tell agents to make the
  subsystem *render* before improving it.

## The single most important lesson

**Ten measurement bugs.** Every one produced a confident, plausible, wrong number,
and they cost more dispatch cycles than any code defect. Full list in
`DIAGNOSIS.md` §25 and §39, but the pattern:

| instrument | lied by |
|---|---|
| the screenshot harness | reloading the page between scenes, so every shot after the first was of an unsettled engine |
| a crop tool | mixing CSS-percentage and pixel coordinates |
| a foam probe | reading a HalfFloat target into a `Float32Array`, which returns **all zeros without throwing** |
| `settings.debug` | enabling a 117–370 ms synchronous readback, so the profiler faked a "shared stall" across four subsystems |
| a framing probe | measuring a merged batch's bounding box beside the lens, where tiny depth yields a colossal NDC |
| load average | being a CPU metric that **cannot see GPU contention** — a 6 ms frame measured as 50 ms |

Rules that follow, and they are cheap:
- If a measurement says *exactly* zero or *exactly* empty, suspect the instrument.
- Assert your ablation actually applied. A silent no-op replace is how you "verify" a
  fix that never ran.
- Never trust one run of anything with a periodic or drifting component.
- Two-sided bands, not one-sided sign checks.
- Check whether enabling the instrumentation changes what you are measuring.
- **On ANGLE-on-Metal, `gl.finish()` and `EXT_disjoint_timer_query` are unusable.**
  Use the slope method and frame-period percentiles (`DIAGNOSIS.md` §16).

Corollary: **`npm run typecheck` passing does not mean the shaders compile.** Only a
runtime compile catches a redefinition, an undeclared varying, or anything on an
alternate material path. Always parse the capture console log for `ERROR:` and
`Material Name:`.

## The recurring build-breaker

A backtick inside a comment in **GLSL template text** closes the template early, and
TypeScript then reports a cascade of syntax errors dozens of lines from the cause. It
broke the build four times. `scripts/check-glsl.mjs` now catches it with a small
lexer — it has to be a lexer, because inside a `${ ... }` interpolation you are back
in TypeScript and backticks there are harmless.

## Owner's design direction (overrides earlier assumptions)

1. **Playability beats realism.** The measured 6-DOF solver is **Pro mode**; the
   default is an assist *layer* over the same solver — never a second physics model.
2. **Minimal default UI**, arrow keys only, automatic sail trim. The full instrument
   HUD moves behind a `PRO` toggle.
3. **A richer world**: marine life, varied passing vessels, a distant Boston harbour.
4. **Ships as a static GitHub Pages game.** Touch and small viewports are real targets.
5. **Audio must be comfortable before clever** — a calm sea bed first; cut anything
   that cannot be made clean rather than defend it.

## State as of 2026-08-20

**Working and verified.** Sails, hull, rig, full sail plan. GPU FFT ocean with a
geometry clipmap. Four-LUT atmosphere with volumetric clouds. 6-DOF physics with
32 + 45 passing assertions (roll period 9.31 s, hull speed 12.83 kn, 30-vs-144 fps
agreement within 0.007 kn). Assist mode (turn 4.62 deg/s vs Pro's 0.40, never in
irons) with Pro provably bit-identical. Minimal UI. Kelvin wake, hull spray. Ensign
at the spanker gaff, 15 stars and 15 stripes, verified by dumping the texture.

Direction 3 landed: seabirds, dolphins, humpbacks, three procedural vessel classes
sailing real polars, Boston harbour, channel buoys. 8 draw calls and 23,954
triangles for all of it, `upd:wildlife` 0.1–0.2 ms, frame cost within noise. All
appearances are a true Poisson process, so nothing falls into a rhythm.

Closed since the last handover: the shroud/course piercings (55 → 19 live, 1206 →
331 across nine trim states, by contact-aware shaping rather than a camber clamp);
the near-field foam plate (the coverage function literally could not produce foam —
now a histogram-flattened field thresholded with `linstep`); `cloudLightDepth`
dither; the bowsprit "overshoot", which was a units confusion in `AGENTS.md` rather
than a defect; and the audio scheduling-lead claim, which **does not reproduce on
this box** (see `DIAGNOSIS.md` §41 — only *negative* lead steps).

**Three checkers now exist, and it is worth knowing what each can and cannot see.**
- `npm run typecheck` — `check-glsl` then `tsc`. Fast, no browser.
- `npm run check-shaders` — compiles **and links** 42 fullscreen-pass programs in
  `src/sky` and `src/post` against the real driver in 1.5 s, no dev server. Catches
  bad swizzles and varying mismatches, which the other two cannot see. **Does not
  cover material shaders** (`ocean/surface`, `ship/{parts,sail,line}`, `vfx`,
  `world`) — those need a real engine boot.
- `node scripts/capture.mjs` — the only instrument for material shaders (zero
  `ERROR:`/`Material Name:` in console) and the only source of frames. **Its p25
  varies 13–14 ms run-to-run on byte-identical code**, so a single-run timing
  difference under ~14 ms means nothing; use a paired multi-sample run or
  `ext.post.profile()`. For pixel statistics prefer **`--scene shadow`**, which runs
  at cloudCover 0 and is six times more repeatable (p10 spread 1.4 sRGB vs 9.0)
  because the cloud field no longer advects between runs — drifting cloud shadow has
  invalidated two measurements here.
- `npm run preflight` gates on the GLSL parse now, so it will refuse a tree that will
  not build. It deliberately does **not** run `tsc` (24 s), and says so.

**One trap worth knowing before you measure anything about shadows.**
`castShadow = false` is a **no-op under VSM** for any object that also *receives*
shadow — `WebGLShadowMap.js:515` reads
`object.castShadow || (object.receiveShadow && type === VSMShadowMap)`. The sails
receive, so removing them from the shadow map that way does nothing, and the
experiment returns a convincing null. Two agents walked into this.

**Known open, roughly in priority order.**
1. ~~**The "stutter" is a 4× pixel overload**~~ — **CLOSED, on main** (§57, §59). It was
   never a stutter: on a Retina panel the backing store is 3200×1800 = 5.76 Mpx against
   the 1.44 Mpx every measurement here used. `capture.mjs --dpr 2 --adaptive` reproduces
   the owner's condition; pinning stays the default because an adaptive controller makes
   two runs incomparable.
   The control law now lives in `src/core/AdaptiveResolution.ts` as a **pure function of
   frame periods**, because a vsync-driven controller cannot be tested by rendering here:
   this headless Chromium is a 60 Hz **rate limiter**, `period ≈ max(16.67, cost)`, where a
   panel gives `ceil(cost/16.67)·16.67`. `.tmp/adaptsim.mjs` **imports that module** and
   drives it with a measured fixed-scale sweep, quantised as a display would; it agrees
   with a brute-force search of the ladder in nine machine/panel/target combinations,
   including two this box cannot produce at all.
   Two things to carry forward. **Frame cost is `9.44 ms + 13.83 ms/Mpx` of backing store
   and does not depend on the panel's dpr** — so the old law's 0.62 floor was a clamp that
   happened to be right at dpr 1 (0.55 Mpx) and unreachable at dpr 2 (2.21 Mpx = 36 ms),
   and the "regression" that kept the fix off a branch was a unit error. And **57% of a
   16.67 ms budget is spent before the first pixel**, so resolution can only ever attack
   the rest: `capture.mjs` on a quiet box reads noon **p50 28.5 ms at dpr 1 scale 1**, so
   the "60 fps at 1600×900 at ultra" bar is not met by the engine at either dpr. That is
   the next performance item, and it is not a controller problem.
   Still open, and stated plainly: **the steady state cannot be verified on real
   hardware from here.** The simulation's jitter model is this box's, with other agents in
   it. And whether `maxPixelRatio: 2` should mean 2× device pixels at all is a visual
   judgement nobody has made — §59H has the argument and the numbers.
2. ~~**Sail shadow edge hardness.**~~ **CLOSED — the edges are already the right
   width** (§56). The sun subtends 0.53°, so the true penumbra for the 10–40 m
   caster separations on this rig is 1.6–6.5 px at 17.5 px/m; measured p25 2.5,
   p50 3.5, p75 6.2 px. That *is* the physical band, and softening further costs
   legibility — at `shadow.radius` 4 the crosstrees stop being readable in their own
   shadow. **Leave it at 2.2.** Shadow-interior mottle is flat at 0.024 across a 56×
   radius range, so the residual "blotchy" reading is the **cloth, not the shadow**.
   The free-leech hypothesis is dead and its branch retired: a directional light has
   no source area, so the caster's silhouette sets *where* an edge falls, never how
   wide it is. It also cost +6 piercings in live trim, almost all `lift`.
3. ~~TAA near-field~~ and ~~near-DoF ramp~~ — **both CLOSED** (§58). The velocity
   reference frame is now chosen **per pixel** (a global flag was the wrong shape: the
   ocean and sky share the buffer and need the world frame), and the near DoF fades in
   over the same CoC ramp the far field uses. The DoF lead had measured as a null
   because the step sits at 1.49 m at the helm where the nearest deck pixel is 2.6 m —
   the scene it was tested in could not contain the thing being tested.
5. ~~Vessels read thinly inside 200 m~~ — **largely CLOSED** (§61). The fix was
   temporal, not ink: frame-to-frame change at 554 m went from 45% of the box shifting
   more than 12 sRGB to 8.7%, with nothing moving but the camera. Triangles went *down*
   (23,954 → 22,188) while detail went up, because a rope ribbon is 2 triangles where a
   capped cone was 16. **Residual:** yards are still opaque cylinders and go sub-pixel
   past ~400 m — same defect, unfixed, and it needs a fifth `aAux` channel for a rope's
   pivot. No ratlines, because they cross their own shrouds at the same depth and would
   z-fight.
6. ~~Boston is not recognisably Boston~~ — **largely CLOSED** (§61). Her 2600 m long
   axis subtended **one pixel at 8 km**: `place()` yawed her a quarter turn, so the
   900 m depth axis spread across the frame while the length ran away. Frontage 1 px →
   235 px. **Residual:** at 8 km the dome reads and the three humps are present but the
   shoulders are subtle; the mast thicket registers as texture rather than as masts, and
   Old North is structurally right but not legible as an individual. All four read at
   4.2 km. And from landward the town loses up to 54% of its waterline ink (§60) — real
   but mild, and the test could not separate depth order from aspect.
7. **The `reefed` trim is the worst state for line piercings** (92), dominated by
   buntlines and leechlines crossing the furled bundle. Pre-existing.
8. **From the helm the wheel's two discs overlap nearly along their own axis**, so it
   reads as spokes and handles rather than obviously a wheel. Framing, not geometry.
9. **No gull perches on a yard**: `src/ship` would need to publish yard-arm anchors on
   the blackboard, and guessing coordinates would put a gull inside a sail.

**Branches that are not on main, deliberately.**
- `wip/sail-canvas` — a first attempt at the cloth that traded isotropic popcorn for a
  hard sawtooth chevron. Superseded on main by a version measured at the generator
  (relief slope 48.4° → 4.9°, anisotropy 0.48 → 0.09, dominant wavelength landing on
  the 610 mm bolt), but its diagnosis is worth reading.
- `wip/free-leech` — **retired.** Disproven in §56 with a physics argument, so leaving
  it would only cost someone a session.
- `wip/adaptive-resolution` — **superseded and mergeable-into-nothing.** Its boot fix (an
  opening cap of 2 Mpx, a boot grace in milliseconds) is on main; its steady state was
  measured against the old law in the wrong units. Keep it only for the commit message,
  which is an honest record of a half-fix.

**The rule these branches encode:** a stopped agent's work being green (`tsc` 0,
`check-glsl` clean) is not the same as being right. Main stays publishable, so a change
that trades one defect for another goes on a branch with the diagnosis written down.

**Open question for the owner.** `KN` and `PRO` are the weakest HUD marks (ink
221/237 against 255 for `MINIMAL`/`NNE`), because K, N, P, R and O at 9 px are
diagonals and curves that never reach full pixel coverage. The fix is 10 px caps,
which changes a look the owner has already approved — so it is a question.

**Licence is still unchosen.** `preflight` warns about it. It is deliberately the
owner's call.

## Deployment

`npm run build` produces a self-contained `dist/`. `.github/workflows/pages.yml`
builds and deploys on push to `main`; enable it under Settings → Pages → Source:
GitHub Actions. No secrets needed. **A licence has not been chosen** — pick one
before publishing.

## Reference-frame caveat

There are **no slowroads.io frames on disk**. The site sits behind a
bot-verification challenge, which we do not bypass. `RUBRIC.md` is the standard
instead: eight weighted axes plus automatic failures. It carries an explicit
anti-grade-inflation instruction, because a critic who scores everything 8 makes the
whole exercise useless.
