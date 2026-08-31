# Leeward — build contract

A tall-ship sailing game. The bar is **slowroads.io or better**: a calm,
endlessly beautiful procedural world you just want to sit in. We are sailing
the USS Constitution instead of driving.

Read `src/types/index.ts` in full before writing anything. It is the contract.

**Starting cold, with no conversation history?** Read `AI_HANDOFF.md` first — it
carries the *current* operational state (what is deployed, what is open, which
worktrees may be live, which instruments are known invalid) and a first-start
procedure. This file is the permanent engineering contract; `AI_HANDOFF.md` is
where things stand today; `DIAGNOSIS.md` is why. Then read `src/types/index.ts`.

## Design direction — playability first (set by the owner 2026-08-18)

These override earlier assumptions where they conflict. Read them before you
optimise for realism.

**1. Handling feel beats physical realism.** The game is about going wherever you
want and seeing beautiful things on the way. Movement must feel responsive and
consequential. The realistic 6-DOF solver is NOT to be deleted — it is measured,
asserted and good — but it becomes **Pro mode**. The DEFAULT is an assist layer on
top of it:
- meaningfully quicker acceleration and a higher sense of speed
- a much tighter, more responsive turn
- a forgiving or absent no-go zone; never leave the player stuck in irons by
  default, and never let them sit becalmed with nothing to do
- the assist must be a layer over the solver (extra forces / relaxed limits),
  not a second physics model, so Pro mode stays exactly what it is today

**2. A simple default UI.** A new player should sit down and drive with the
**arrow keys** and nothing else. The current full instrument HUD — compass ribbon,
wind rose, sail plan, inclinometer, chart, watch bells — is excellent, but it
becomes **Pro mode**. The default is minimal: speed, heading, and little else.
Sail trim should be automatic in the default mode. Make the toggle discoverable
but unobtrusive.

**3. A richer world, a finer ship.** The ship model needs more refinement — it is
the thing on screen constantly. The world needs more to sail toward: islands,
marine life appearing occasionally (whales, dolphins, seabirds, fish), other
vessels of varied types crossing, and at appropriate moments a distant landmark
such as Boston harbour on the horizon. The point is that something interesting
keeps appearing over the horizon.

**5. Audio must be comfortable before it is clever.** The owner reports the
current audio produces **chains of noise, popping and distortion**. The direction
is: a calm, pleasant **sea** bed first — waves and water are the point. Everything
else (rigging, creaking, blocks, bells, crew) is subordinate and quiet, and any
element that cannot be made clean should be **cut rather than defended**. If music
is present it should be ocean-flavoured, sparse and unobtrusive. An elaborate
synthesis model that clicks is worse than a simple one that soothes.

**4. It ships as a browser game on GitHub Pages.** Keep the build a pure static
bundle: `base: './'` (already set), no server dependency, no runtime asset
fetches. Watch bundle size and cold-load time, and keep `npm run build` green.
Consider touch/pointer input and smaller viewports as real targets.

## Measuring anything on this box

`scripts/capture.mjs` now **refuses to print an unflagged frame time when another
headless renderer is running**, because several agents capture concurrently and
**load average is a CPU run-queue metric that cannot see GPU contention** — a run
once reported "load 1.9" while measuring a 50 ms frame the engine renders in 6 ms.
If you see `!! rival renderer(s) — TIMINGS INVALID`, the numbers are noise. State
readouts (`world.ship.*`, `world.stats`) are unaffected; only timings are.

**Never bisect with `git checkout <sha> -- src/` here.** Other agents hold
uncommitted work in the same tree and that command destroys it. Use a `git
worktree` with its own dev server.

**Never `git add -A` in this tree.** Stage explicit paths. A blanket add swept a
ship agent's uncommitted `Parts.ts`, `ensign.ts` and 159 lines of `hull.ts` into a
commit whose message was about the sky — the work survived but is filed under the
wrong change, and a blanket add is one keystroke away from committing another
agent's half-finished state as if it were reviewed.

**Commit source and docs separately.** A commit labelled `docs:` that also carries
source changes makes `git log` useless for bisecting, and has already sent one
investigation to an empty window.

## Recording a diagnosis when you are not the integrating session

**If you are a background or worktree agent, write your findings to
`notes/<topic>.md` and do not touch `DIAGNOSIS.md`.** Use a plain descriptive
heading and do not number your own sections.

**Cite existing sections freely** — `as §40 already proved`, `see §71` — that is
what they are for. What fails is a heading that *is numbered*: `## 82. Title` or
`### §82 Title`. The discriminator is heading position, not the section sign.

Only the integrating session on `main` assigns numbers, and it does so at the
moment of integration. The reason is that the highest number an agent can see is
the one that was free when its worktree was created, not the one free when its
work lands — that has collided three times, including two sessions both taking
§75 and one writing §65 against a main that had reached §78.

`notes/README.md` has the full rationale. `preflight` lists any unintegrated
notes, so a paused session's findings are visible rather than lost.

**Existing numbered sections are authoritative and are not renumbered** to tidy
duplicates. §36, §40, §46 and §60 each appear twice from earlier collisions;
they stay, because a stable reference someone has already cited is worth more
than a tidy sequence.

## Reconciling another session's work

**Before creating or trusting any worktree, verify which repository you are in.
All three, every time:**

```bash
git rev-parse --show-toplevel     # where this checkout actually is
git rev-parse --git-common-dir    # `.git` = standalone clone; a path elsewhere = linked worktree
git remote -v                     # must be github.com/EugeneYip/Sail
```

**A directory name or path is not evidence of repository ownership.** Nested and
stray repositories happen — a home-level `.git` at `/Users/eugene` once made every
directory under it look like part of a repository it had nothing to do with, so a
worktree created "in Sail" could have been anchored somewhere else entirely. The
git facts are the only answer that means anything; the path you typed is not.

Each command answers a different question, which is why one is not enough. The
toplevel says *where* you are. `--git-common-dir` says *what* you are — it resolves
to the same place as `--git-dir` in a standalone clone, and points back at the parent
repository in a linked worktree, so it is the check that stops you committing into
someone else's worktree believing it is the main checkout. `git remote -v` says
*whose* repository it is; a clone with a valid-looking layout and the wrong origin is
not this project. `node scripts/ai-context.mjs` prints all three and flags the
failure cases, including the retired-but-still-valid legacy checkout.

Do **not** turn any of this into a check on the absolute path. The canonical location
has already moved twice; a legitimate clone may live anywhere. Identity is the remote
plus the git facts, not the directory.

Two corollaries:

- **Never hardcode a worktree directory name.** They are generated, they tell a
  later reader nothing, and one of them (`reverent-jepsen-5ed163`) was checked out on
  a branch of an entirely different name (`claude/gifted-lalande-041ee3`). That pair
  is a **historical example from the legacy Desktop checkout** (`AI_HANDOFF.md` §5a),
  **not a worktree registered in the canonical repository** — which is itself the
  point: a name in a document is never evidence a worktree exists. Resolve branch and
  HEAD from git, per worktree, every time.
- **A task can run in a worktree this repository cannot see** — another machine, or
  an ephemeral environment. Absence from `git worktree list` is not evidence that a
  dispatched task failed, and it is not evidence its work is recoverable from here
  either. Report it as external/unknown rather than reconstructing it.

**Dirty is not a state. It is the normal condition of a worktree whose owner is
mid-edit.** Uncommitted files and an untracked note mean *someone may still be
typing*, not that a session died. Treat them as live until you have evidence
otherwise.

This is not hypothetical: an integrator once read a foam session's dirty
`src/vfx` files and untracked note as an interruption, committed the source,
folded the note into `DIAGNOSIS.md` and deleted the note — while the agent was
still tuning. It happened to match that agent's final state byte-for-byte, and
nothing about that was earned. See §82a.

Before you consume source, integrate a note, or delete a note that belongs to
another session:

1. **Establish the owner's state** — active, completed, paused on a limit, or
   dead. A completion report, a task notification, or the owner saying so all
   count. A file's mtime is a hint, not evidence; `preflight` prints how long ago
   each note was touched precisely because that is the one cheap signal at the
   moment of decision.
2. **If it may still be active, take nothing.** Do not stage its files, do not
   fold its note, do not delete its note.
3. **Integrate only after explicit completion or handoff**, or once the session is
   confirmed stopped.
4. **If an emergency forces you to snapshot live work** — an imminent push, a
   machine you are about to lose — copy it forward without deleting or rewriting
   the owner's working state, and say in the commit message that it is a snapshot
   of work in progress rather than a finished result.
5. **If you integrated early and the owner later finishes**, compare its final
   state against `main` byte-for-byte and reconcile the delta before calling the
   task closed. Do not assume your snapshot was the end of it.

The `notes/` convention exists to stop interrupted work being lost. It must not
become a way to race a writer who has not finished.

## Keeping the repo publishable

`npm run preflight` must stay green — it also runs in CI before any deploy. It
fails on tracked scratch files, captures, credentials, oversized assets, missing
docs, HTML missing its crawler/share metadata, and a `vite` `base` that is not
`'./'`. If you add a probe, put it in `.tmp/` (gitignored). If you add an asset,
keep it small and say why it is not procedural.

`index.html` carries the SEO and share metadata. Two standing notes: webfonts load
**non-blocking** on purpose (a render-blocking third-party stylesheet was costing
first paint, leaking every visitor's IP and breaking offline) and there is
deliberately **no canonical tag** until the deploy URL is known.

## Non-negotiables

1. **Modules talk only through the blackboard.** Never import another
   subsystem's concrete class. Read/write `World` (see `src/types/index.ts`).
   The only exception is `src/util/*` and `src/core/SharedUniforms.ts`, which
   are shared libraries.
2. **Own your directory, touch nothing else.** Other agents are editing other
   directories at the same time. If you need a change outside your directory,
   say so in your final report instead of making it. The two exceptions:
   - You may add a `{ value: ... }` entry to `createSharedUniforms()` if you
     also add the matching declaration to `SHARED_UNIFORM_DECL`.
   - You may add a field to your own slice of a `World` interface in
     `src/types/index.ts` — append only, never reorder or delete.
3. **`npm run typecheck` must pass** before you report done. Zero errors. It runs
   `scripts/check-glsl.mjs` first, which catches the mistake that has broken this
   build more than any other:

   **Never put a backtick inside a comment in GLSL template text.** In the text
   portion of a template literal `//` is not a comment, it is literal characters,
   so a backtick closes the template early and TypeScript reports a cascade of
   syntax errors dozens of lines from the real cause. Use 'single quotes' for code
   spans in shader comments. (Inside a `${ ... }` interpolation you are back in
   TypeScript and backticks in comments are fine.)
4. **Zero console errors or WebGL warnings** in `node scripts/capture.mjs`.
5. **60 fps at 1600x900 CSS on an M2 at `ultra`** — and read the rest of this,
   because the target is **currently unmet** and the units are the reason it
   hid for so long.

   "1600x900" is **CSS pixels**. The backing store is
   `min(devicePixelRatio, maxPixelRatio) * renderScale * cssSize`, so on a
   Retina panel at `renderScale` 1 the engine is really drawing **3200x1800 =
   5.76 Mpx**, four times what `capture.mjs` measures by default (`--dpr 1`).
   Always say which you mean. Use `--dpr 2 --adaptive` to reproduce a player's
   machine.

   Measured, and it is a straight line across 14 rungs at both ratios:

       cost = 9.44 ms + 13.83 ms/Mpx     (worst residual 1.1 ms)

   So **9.44 ms of a 16.67 ms budget is spent before a single pixel** of the
   main render, 1.44 Mpx costs 29.4 ms, and 60 fps needs the frame down to
   0.52 Mpx — which is exactly where the adaptive controller settles. **The
   controller is correct; the budget is the problem.** The panel's dpr has no
   effect on cost at equal backing store.

   Two consequences for you. A sub-60 reading is **not evidence you broke
   something** — do not spend a session hunting a regression that is the
   standing state of the engine. And if you do regress fps, fix it; but quote
   the pixel count with the number.

   **How to price a change, and what not to use.** Do NOT use
   `world.ext.post.profile()` for frame cost: it is built on a `gl.finish()`
   between passes, `finish()` does not block under ANGLE-on-Metal, and its
   passes sum to 2.31–2.61 ms against frames costing 24.8–55.8 — so it reports
   **CPU submission**, not GPU time. An earlier version of this file effectively
   recommended it; that was wrong.

   What works: **ablate one candidate and measure the saving at two or three
   render scales.** A saving that is the same at 1.115 and 3.327 Mpx is fixed
   cost; one that scales with pixels is not. Use paired A/B in short alternating
   bursts, because the baseline's own spread at the low rung is ±1 ms, the size
   of the effects. The fixed term is only 7.9–9.4 ms in total and **6.3–7.6 ms
   of it is CPU**, so both terms of the model have to move — see
   `DIAGNOSIS.md` §66 for the per-pass split and what is still on the table.
6. **Scene-linear radiance everywhere.** Materials output linear values; the
   post stack owns tonemapping and the sRGB encode. Never call
   `convertSRGBToLinear` on a value that is already linear, and always call it
   on a hex colour you typed by eye.
7. **No new npm dependencies.** `three` only. Everything is procedural — no
   downloaded textures, models, HDRIs or audio files. This is deliberate: the
   whole game must be a few hundred KB.
8. **Respect `world.settings`.** Honour the quality tier and implement
   `applySettings` if your cost depends on a setting.
9. **Frame-rate independence.** Use `damp()` from `src/util/math.ts`, never a
   raw `lerp(a, b, 0.1)`. Physics must be stable from 30 to 240 fps.
10. **Floating origin.** The ship never wanders far from the world origin;
    `world.origin` accumulates true voyage distance. Use
    `uniforms.uOrigin` when a shader needs absolute coordinates.

## Verifying your work

Dev server is already running on <http://127.0.0.1:5178>. It hot-reloads.

```bash
cd leeward
npm run typecheck
node scripts/capture.mjs --out shots/<yourname> --scene all --settle 6
```

The harness stages PNGs outside the Vite root and disables HMR, so a capture run
is not disturbed by another agent editing `src/`, and it exits non-zero if the
page navigated unexpectedly. Wall-clock fps is NOT trustworthy while other
agents are running — use the `upd:<module>` values in `world.stats` instead.

Then **`Read` the PNGs you just wrote** and judge them yourself, harshly, before
reporting done. Scenes available: `dawn morning noon golden sunset dusk night
storm fog helm masthead orbit waterline island`.

**Grade yourself against `RUBRIC.md`.** It has eight weighted axes and a list of
automatic failures (water tiling, LOD popping, sky banding, TAA ghosting, a
horizon that reads as a hard seam, placeholder geometry). **Performance is NOT one
of them** — `RUBRIC.md` removed it deliberately, because at the standing cost model
a sub-60 criterion caps every frame at 4 and destroys the exercise. An earlier
revision of this list said `sub-60fps`; that was wrong. Most frames
honestly score 4-6; reserve 8+ for a frame a stranger could not distinguish from
a commercial release.

There are no slowroads.io reference frames on disk — the site is behind a
bot-verification challenge we do not bypass, so the rubric is the standard.
`DIAGNOSIS.md` carries the current measured defect list; read it before you
start and trust its numbers over your own guesses.

## Coordinate + unit conventions

- **World**: metres. +Y is up. Sea level is `y = 0`.
- **Ship local**: +X starboard, +Y up, **−Z forward (bow)**. This matches
  three's camera convention so `Object3D.lookAt` behaves.
- **Bearings**: radians, meteorological. 0 = north = world −Z. +90° = east =
  world +X. `env.windBearing` is where the wind comes **from**;
  `env.windVector` is where the air **goes**.
- **Speed**: m/s internally, knots only in the HUD (`toKnots()`).
- **Angles**: radians internally, degrees only in the HUD.

## Ship reference — USS Constitution

44-gun heavy frigate, launched 1797. Use these numbers, they are real:

| | |
|---|---|
| Hull length (gun deck) | 53.3 m |
| Length overall, transom to bowsprit **cap** | 62 m |
| Length transom to flying-jibboom tip | ~71 m |
| Sparred length (spanker boom overhangs the transom by 11 m) | ~82 m |
| Beam | 13.3 m |
| Draught | 6.4 m |
| Displacement | 2200 t |
| Mainmast height above waterline | 67 m |
| Foremast / mizzen | 60 m / 52 m |
| Total sail area | ~3968 m² |
| Top speed | 13 kn |
| Hull planking | white oak, black paint above the wale, white gunport stripe |

**Three different lengths, and I conflated them.** "62 m" is the figure usually
printed as *length overall*, and it measures to the **bowsprit cap** — not to the
tip of the flying jibboom, and not to the aftermost spar. Taking it as
taffrail-to-tip deletes the jibboom, flying jibboom, martingale and three of four
headsail tacks; a ship agent measured the cap already sitting at 62.44 m and was
right to refuse the "overshoot". And the **aftermost spar is not on the bow at all**
— the spanker boom overhangs the transom by about 11 m. Say which length you mean.
| Below waterline | copper sheathing (Paul Revere's), oxidised green-brown |
| Masts | three, square-rigged, plus a fore-and-aft spanker |

Colour scheme: black hull, a single white/buff stripe along the gunport line,
ochre-buff inboard bulwarks, natural oiled deck planking, black ironwork,
tarred (near-black) standing rigging, pale manila running rigging, off-white
weathered flax canvas sails.

## Style

- Match the surrounding code: no comment noise, no `// Step 1:` narration.
  Comment the *why* of anything non-obvious (a magic constant, a physical
  approximation, a workaround) and nothing else.
- Named constants for physical quantities, with units in the name or a comment.
- Small files over one huge one. Put shaders in `shaders/` next to their module
  as `.ts` files exporting template-literal strings, composed from
  `src/util/glsl.ts` snippets.
- `THREE.MathUtils` and `src/util/math.ts` before rolling your own.
- Dispose GPU resources in `dispose()`.

## Performance rules that actually matter here

- Instance everything repeated (rigging lines, ratlines, cannons, foliage,
  wave particles). `InstancedMesh` or a single merged `BufferGeometry`.
- One material per visual family; vary with instance attributes, not clones.
- Never allocate in `update()`. Hoist scratch `Vector3`/`Quaternion`/`Matrix4`
  to module fields. This is the single most common cause of GC hitches.
- Sort your own transparency where it matters; three's painter sort is per
  object, not per triangle.
- `frustumCulled = false` only for things that genuinely fill the screen
  (ocean, sky).
- Prefer a texture LUT baked once at init over per-frame math in a shader.

## Measuring anything: use the harness

`scripts/measure.mjs` (`npm run measure-selftest` proves it works). Use it for any
A/B, ablation or parameter sweep instead of hand-rolling a probe.

**Setup, on a fresh machine or a cleared cache:** the harness drives Playwright, and
Playwright's browser binaries are **machine-local cache state, not repository state** —
they live outside the checkout (on macOS, `~/Library/Caches/ms-playwright`) and no amount
of cloning, copying or moving the repository brings them along. `npm ci` installs the
Playwright *package*, not the browsers. Run the install step once before any capture or
measurement workflow:

```bash
npx playwright install
```

Five conclusions on this project were retracted because of instrument mistakes, not
bad reasoning. The harness closes those specific traps:

- **One fresh page load per arm.** Sharing a load lets simulation state drift between
  arms, and in an ascending sweep the drift runs *with* the parameter. This produced
  the largest single false positive.
- **A control channel is mandatory** — something the arm cannot possibly influence.
  When the control moves as much as the result, the result is noise. This is what
  caught every retraction.
- **Deltas inside control variance are REJECTED, not reported.** The floor comes from
  repeat-to-repeat spread converted to sigma, at 3 sigma on a difference of means. A
  range of two repeats is not a noise floor.
- **Assert the lever BINDS.** A patched string is not a bound lever. Real examples
  here: a clamp set above the value it clamped, a uniform rewritten from settings
  every frame, `castShadow = false` (three ignores it for receivers under
  `VSMShadowMap`), and a `customProgramCacheKey` returning a constant so
  `onBeforeCompile` was never called.
- **`dt = 0` does not freeze the renderer, it starves it.** Shadow maps and other
  refresh-on-tick subsystems stop updating, so you measure a stale state. The harness
  warns.
- **Declare sample regions in the config, before measuring.** Defining a mask from
  the quantity under test guarantees the finding.
- **Both mean and median, always.** Choosing after seeing the data is how a mean
  invariant got read as a median.
- **PIN the weather; assigning to `world.env` does not hold it.** A weather
  simulation keeps driving `world.env`, so `Object.assign(world.env, {...})` is a
  suggestion, not a condition. Measured: `windSpeed 41, seaState 0, waveHeight 0.0`
  drifted to wave 2.38 / sea 4.90 / wind 27.3 within **six seconds** and wave 2.94 /
  wind 15.2 by seventeen. Four arms of one investigation were run on a condition that
  never existed. Reproduce a player's sliders the way the UI does:

  ```js
  for (const [k, v] of Object.entries(cond)) world.ext.env.pin(k, v);
  ```

  then **settle, read back, assert the pinned values, and only then measure.** The
  order matters: an assertion before the settle proves nothing.

  Consequence for old results: no historical experiment that depended on an *absolute*
  unpinned weather condition may be treated as evidence that the condition existed.
  Same-load *relative* comparisons stay valid — every arm drifted together — unless the
  conclusion itself depended on the absolute weather state.

If a result contradicts physics, or arms order impossibly, suspect the instrument
before believing the discovery.
