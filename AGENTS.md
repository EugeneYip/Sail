# Leeward — build contract

A tall-ship sailing game. The bar is **slowroads.io or better**: a calm,
endlessly beautiful procedural world you just want to sit in. We are sailing
the USS Constitution instead of driving.

Read `src/types/index.ts` in full before writing anything. It is the contract.

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
5. **60 fps at 1600x900 on an M2 at `ultra`.** The capture harness prints fps
   and draw calls for every scene. If you regress fps below 60, fix it.
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
cd tallship
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
horizon that reads as a hard seam, placeholder geometry, sub-60fps). Most frames
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
| Length overall w/ bowsprit | 62 m |
| Beam | 13.3 m |
| Draught | 6.4 m |
| Displacement | 2200 t |
| Mainmast height above waterline | 67 m |
| Foremast / mizzen | 60 m / 52 m |
| Total sail area | ~3968 m² |
| Top speed | 13 kn |
| Hull planking | white oak, black paint above the wale, white gunport stripe |
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
