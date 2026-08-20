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
  `ERROR:`/`Material Name:` in console) and the only source of frames.

**Known open, roughly in priority order.**
1. **Hard rectangular shadow blocks on the sails.** 5.2–5.6% of sail pixels, stable
   across two captures 15 hours apart, so **not** a regression. The weakest thing in
   the frame. Spans `src/sky` (shadow map) and `src/ship` (sail depth material) —
   the boundary is why it stalled before, so give it one owner.
2. **Cumulus render as flat-topped mesas, and the cause is diagnosed.** 77–80% of
   cloud mass sits below `h`=0.6 because at `cloudType` 0.75 the stratocumulus term
   of `heightGradient` is identically zero above `h`=0.68. Redistributing mass upward
   must hold **total** mass constant or it walks the `CLOUD_COLUMNS_PER_RAY = 4.1`
   coverage calibration backwards.
3. **Framing.** The chase camera does not adapt to a phone aspect ratio — at 390×844
   the ship fills the left half with the bow cut off, and directive 4 makes that a
   real target. The `helm` view contains no identifiable ship's wheel and keeps the
   horizon only in the left third.
4. **Frame pacing.** ~19–31 ms p25 against a 16.6 ms target, but the *minimum* is
   5.9–9.6 ms with 14–35% of frames inside one vsync — the engine can render the
   frame and something intermittently prevents it. `dt` values are exact multiples of
   16.67 ms: vsync beat aliasing. **There is no code regression** (§31 retracts an
   earlier claim of one).
5. **Vessels read thinly inside 200 m** — 12 px of freeboard at working range, so the
   gunport stripe is invisible and the shrouds are sub-pixel. Fine for the intended
   range, not for a close pass.
6. **Boston is a town on a headland, not recognisably Boston** until ~2 km.
7. The `reefed` trim is the worst state for line piercings (92), dominated by
   buntlines and leechlines crossing the furled bundle. Pre-existing.
8. Near geometry is smeared while distant geometry is sharp — a TAA history problem
   on **near** surfaces. The shrouds moiré.
9. No gull perches on a yard: `src/ship` would need to publish yard-arm anchors on
   the blackboard, and guessing coordinates would put a gull inside a sail.

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
