# Hull bulwark gap and bow head defects

Running log. Appended as work proceeds so nothing is lost to an interrupted run.
Scope: `src/ship/build/hull.ts`, `src/ship/build/deck.ts`.

## Session start

- Task: two reported defects.
  1. `rail-close` station (4 m fwd, 8.5 m up, 13 m to port, aimed aft): buff rail
     cap reads as a floating plank with sea and sky visible between it and the
     hull side. Gun-port lids hang on the outside of a hull with nothing behind
     them at the top. Deck planking visible further inboard.
  2. `bow-head` station (46 m fwd, 4 m up, 7 m to port): green-teal patch where
     the bowsprit meets the hull; dark posts hanging below the bow into the water.
- Repro harness: `node .tmp/inspect.mjs rail-close,bow-head,port-side,stbd-side`.
- No findings yet.

## Instruments built

Two new probes in `.tmp/` (gitignored), both driven off the same fixed
ship-relative stations as `.tmp/inspect.mjs`:

- `.tmp/hullprobe.mjs` — imports `/src/ship/build/hull.ts` through Vite in the
  page, monkeypatches `MeshBuilder.prototype.grid/box/spar/...`, and prints a
  per-call triangle inventory per bin plus a table of `dims.ts` values. This is
  how "is a bulwark emitted at all, and with how many faces" gets answered by
  measurement.
- `.tmp/ablate.mjs` — at a station, replaces every `ship-*` material with a flat
  `MeshBasicMaterial` in a fixed palette (`id` pass), optionally `DoubleSide`
  (`idd`), or hides/isolates/double-sides one bin.
- `.tmp/raypick.mjs` — raycasts named screen pixels (or a `scanY:x,y0,y1,step`
  column) against every `ship-*` mesh with materials forced `DoubleSide`, and
  prints every hit with distance, front/back facing and **ship-local**
  coordinates. This is the one that settled defect 1.

Note for whoever reuses these: `rig.setMode('free')` must be called **before**
`free.pos/yaw/pitch` are written, or the mode re-derives the eye on entry and
the station is silently ignored. My first ablation run framed the ship from
40 m away for exactly this reason.

## Measured facts about the bulwark (defect 1)

Two of the checks the task asked for come back **negative** — these are not the
cause, and are recorded so nobody re-tests them:

1. **A bulwark is emitted, with 2392 triangles.** `hullprobe` shows the `buff`
   bin receives two `grid(109, 7)` calls at 1196 triangles each — one per side.
   Total `buff` bin is 4536 tris (bulwark 2392 + hammock roll 500 + gun-deck
   inner shell 468 + the rest).
2. **The rail cap and the bulwark do come off the same outline.** Measured at
   t = 0.1/0.3/0.5/0.7/0.9: `HULL_ROWS[30].y(t)` (the top outer planking row)
   equals `sheerY(t)` to 3 dp at every station, and `HULL_ROWS[26]`/`[28]`
   (`ROW_SPAR_SILL`/`ROW_SPAR_HEAD`) equal `sheerY(t) - 1.15` / `sheerY(t) -
   0.42`, which are exactly `buildBulwarks`' `levels[2]` and `levels[4]`. So the
   §-style "feature specified at 0.44 but outline only has vertices at
   1.00/0.72/0.30/0.00" mismatch is **not** happening here. The outer planking
   reaches the sheer; there is a real 0.3 m `BULWARK_THICK` between the outer
   planking and the inner liner.
3. Winding is right on the bulwark liner: raw `cross(d/di, d/dj)` is inboard on
   starboard and outboard on port, and `flip: side < 0` corrects the port half,
   so the liner faces the deck on both sides. Verified by raycast facing flags.

### The actual root cause of defect 1

`raypick.mjs rail-close scanY:900,420,640,10`, screen column x = 900, top to
bottom (ship-local coordinates; `sheerY` is about 6.66 m at this z):

    ( 900, 470)  ship-buff  d=10.11  local=[-5.88, 7.20, 3.06]   <- roll, bottom
    ( 900, 480)  ship-oak   d=19.25  local=[ 0.55, 5.79, 9.40]   <- MISS. deck, centreline, 19 m
    ( 900, 490)  ship-oak   d=16.94  local=[-1.08, 5.90, 7.76]   <- MISS
    ( 900, 500)  ship-black d=10.82  local=[-5.40, 6.70, 3.48]   <- rail cap, sheer + 0.04

At those two scanlines the ray's first hit is 17-19 m away on the centreline —
with materials forced `DoubleSide`, so this is not a culling artefact. There is
genuinely **nothing** at the port rail across that band.

The band is `buildBulwarks`' hammock netting. The roll is a half-tube placed at
`y + 0.46 + (1 - cos a) * 0.33` where `y = sheerY(t)`, so its underside is
**0.46 m above the sheer**, while the rail cap sits at `sheerY(t) + 0.06`. The
only thing crossing the 0.40 m between them is the iron cranes, at 0.019 m
radius on a 1.5 m pitch.

So the "buff rail cap floating with sea and sky behind it" is **the hammock
roll, not the rail cap** — and the rail cap is in `bins.black`, not `bins.buff`,
which is the tell. Real hammock netting is a *net* stretched between the cranes
with hammocks stowed in it, closing that band; here the band is empty air.

### Second, separate finding: the rail cap is inside-out to starboard

The cap is `black.grid(n, 2, ...)` with **no `flip` option**. Its `d/dj` runs
inboard, so `cross(d/di, d/dj) = (0, -0.4 * side, 0)`: the single face points
**up on port and down on starboard**. Every view of the starboard rail from
above sees the cap's back face and it is culled. Needs `flip: side > 0` (same
convention as the outer planking).

## Defect 2 — what the bow objects actually are

Both symptoms raypick to a **bin**, which is the whole diagnosis:

**The green-teal patch is `ship-brass`.** `raypick.mjs bow-head` on three pixels
inside the patch returns first-front-hit `ship-brass` at ship-local
(-0.67, 6.58, -29.83), (0.00, 6.68, -31.31) and (-1.28, 6.40, -27.71). That is
`buildStem`'s **trailboard** (`bins.brass.grid(8, 2, ...)`, z -25.5 to -30.9,
y 5.5 to ~7.0) and the **billethead** (nine `bins.brass.box` calls spiralled
about z = -31.5, y = 6.35).

It is not an uninitialised channel and not a bad vertex colour. `makeBrass` is
sane — `F0_BRASS = [0.91, 0.78, 0.42]`, a warm gold — but it sets
`p.metal = mix(1.0, 0.45, tarnish)`, so the trailboard is a **mirror**. Its
`grid` normal is purely horizontal (`cross` gives `(-dz*0.8, 0, dx*0.8)`, zero
y), the camera at this station is below and forward of it, so the reflected ray
goes up into the sky: blue sky radiance through a gold F0 = **green-teal**. The
stern-gallery gilt, same bin, reads a muted olive at 34 m for the same reason
(`ps-stern` crop). A trailboard is a carved *painted wooden* panel — this is the
"wrong material bin" hypothesis, confirmed.

**The dark posts are the stem timber and the knee of the head — not the
martingale, not the dolphin striker.** Evidence, in order:

- `raypick.mjs bow-head` on four post pixels returns `ship-black` at ship-local
  (0.04, 4.34, -31.37), (-0.30, 2.37, -28.68), (-0.18, 0.98, -29.51),
  (0.35, 0.74, -28.23). All near the centreline, all forward of `Z_STEM`
  (-27.0). The dolphin striker is `bins.oak` in `masts.ts` hanging off the
  bowsprit cap at z = -36.1, and the martingale stays are in the instanced
  `ship-rigging` mesh (24 tris). Neither can produce a `ship-black` hit.
- Source ablation: wrapping `buildStem`'s cutwater block in a `globalThis`
  flag and re-shooting the station (`.tmp/flagshot.mjs bow-head noCW
  __noCutwater`) removes **two of the three** posts. The remaining one is the
  stem tube. **The count is 3 and it resolves exactly: stem tube, cutwater
  leading web, cutwater port flank.** The two starboard flanks are occluded.

### Why they read as detached stakes — measured

The lofted hull's leading edge, as a function of height, is where `keelY(t)`
reaches that height, and at and above `keelY(0) = 2.55` it is the plumb face at
`Z_STEM = -27.0`:

    y = -5.6  ->  z = -20.1      y = 0.0  ->  z = -25.9
    y = -3.0  ->  z = -24.0      y = 2.55 ->  z = -27.0  (and -27.0 above that)

The drawn stem's after surface (path centre minus radius) and the cutwater's
leading edge sit forward of that by:

    y = 0.0   stem aft face -27.50 vs hull -25.9   ->  1.6 m of nothing
    y = 2.4   stem aft face -28.11 vs hull -27.0   ->  1.1 m
    y = 6.2   stem aft face -28.65 vs hull -27.0   ->  1.7 m
    y = 5.9   cutwater edge -31.60 vs hull -27.0   ->  4.6 m

and the cutwater's flanks are only 0.5 m deep (`z + 0.5` at `jj === 0`), so
nothing bridges the space. The stem, the cutwater and the head rails are three
free-standing members hanging in front of a bow that stops at z = -27.0. There
is also no cap on the hull's blunt forward face (station 0 is a 0.6 m wide open
end from y = 2.55 to 8.35).

The real ship has a **knee of the head**: one built-up solid timber filling
exactly that wedge. That is the fix, not moving the posts.

## What was changed

All in `src/ship/build/hull.ts`. `deck.ts` needed nothing.

**`buildBulwarks`**

- The rail cap now passes `{ flip: side > 0 }`. Asserted directly rather than by
  eye: `.tmp/capnormal.mjs` walks the black bin's vertices, selects every one on
  the cap plane `sheerY(t) + 0.06`, and reports the sign of its normal's y by
  side. After: **214 vertices a side, all ny approx +0.99, zero pointing down.**
  The BEFORE number is derivation only — the algebra is unambiguous (the option
  was simply absent and `d/dj` runs inboard) but four attempts to re-run the
  probe against the reverted file timed out waiting for the engine to boot while
  ten rival headless renderers were on the box. Recorded as not verified.
- The hammock stow sits **on** the cap instead of 0.46 m above it, and its
  section is a closed arch (`grid(26, 7)`, 0.43 m chord by 0.52 m rise) from the
  cap's inboard edge over the crown to just outboard of it, so it is opaque from
  the deck as well as from outboard. The old half-tube's inboard face was a
  single-sided sheet facing outboard — a culled hole seen from the helm.
- The cranes now stand 0.66-0.74 m above the cap instead of 0.34-0.39 m above
  the sheer, so a crane is taller than the stow it retains. No triangle change:
  still two `spar` calls each.

Re-scanned with `raypick.mjs rail-close scanY:900,420,640,10`. The two scanlines
that used to fall through to the centreline now read:

    ( 900, 470)  ship-buff  d=10.38  local=[-5.69, 7.16, 3.24]
    ( 900, 480)  ship-buff  d=10.31  local=[-5.74, 7.04, 3.17]
    ( 900, 490)  ship-buff  d=10.27  local=[-5.77, 6.91, 3.12]
    ( 900, 500)  ship-buff  d=10.26  local=[-5.79, 6.79, 3.09]
    ( 900, 510)  ship-black d=10.43  local=[-5.67, 6.63, 3.19]

— continuous surface at the near rail from the stow crown down onto the cap and
the topside, and every hit now lists a matching back face, so the section is
closed. Same check on the starboard rail (`stbd-rail`, added to the probes)
gives the mirror result.

Side effect worth knowing: the top of the rail assembly DROPPED, from
`sheer + 1.12` to `sheer + 0.59` for the stow and `sheer + 0.82` for the crane
heads. `Anatomy.bulwarkY` is `sheerMid + 0.8` ≈ 7.44, so the helm's sightline
over its own rail improves rather than regresses. Nothing outside `src/ship` was
touched.

**`buildStem`**

- The cutwater is replaced by a **knee of the head**: a solid wedge between the
  raking forward profile and `hullLeadZ(y)`, the hull's own leading edge
  (bisection on `keelY` below the forefoot, `Z_STEM` at and above it). The
  profile's foot now lands on the forefoot at y = -5.0 instead of floating
  3 m forward of it.
- Added the **stem rabbet face**: station 0 was a 0.6 m wide open end from the
  forefoot to the sheer, so from dead ahead you looked into the hull.
- The trailboard moved `brass` -> `stripe`, the billethead `brass` -> `buff` at
  ochre 0xd7ab52. Both were metals reflecting sky through a gold F0.

## Triangle and draw-call cost

Measured with `.tmp/hullprobe.mjs`, before -> after, per bin:

    copper  5664 -> 5694   (+30)   the knee below the boot top
    black   9166 -> 9072   (-94)   knee above it, plus the rabbet cap, LESS the
                                   whole stem tube and the old cutwater fin
    stripe   996 -> 1024   (+28)   trailboard in
    buff    4536 -> 4816  (+280)   stow +100, billethead as spars +180
    brass   1048 ->  912  (-136)   trailboard and billethead out
                                   ------
                            +108 triangles net, on a ship of about 21.5 k

**No new draw calls.** Geometry only moved between bins that already existed,
and all nine still have triangles, so `addBins`' `triangleCount === 0` skip
never fires and the budget in `Ship.ts`'s header is intact. `capture.mjs --scene
noon` reports 159 draw calls / 0.77 Mtri with **no `ERROR:` and no
`Material Name:` lines** — zero console errors, no material shader failed to
compile. (It read 158 before the change; the scene's draw count moves by one or
two between frames of a sailing ship as things enter and leave the shadow
frustum, so do not read that as a new mesh — the mesh list is still the same
nine plus rigging, sails and ensign.) Frame times came back marked
(`LOADED(25.4)` then `CONTENDED 10p/2b`) and are therefore not quoted.
`npm run typecheck` is clean and `npm run preflight` is push-ready.

## Reported symptoms that turned out not to be geometry

"Gun-port lids hang on the outside of a hull with nothing behind it at the top"
is a **consequence of the rail band, not a second hole.** Raypicked six lid and
aperture pixels at `rail-close`: every one returns the outer planking or the
lid's ironwork, then the `buff` port liner 0.3-0.36 m inboard, then the deck —
e.g. (875, 592) gives `black` (-6.57, 6.01), `black` (-6.16, 5.85), `iron`
(-5.77, 5.70), `buff` (-5.58, 5.62), `deck` (-4.73, 5.30). The apertures are
lined. What was missing was 0.40 m of substance immediately above them, which is
why the row of lids read as hung on nothing.

## What I could not verify

- The pre-fix starboard rail-cap normal, as above: derived, not measured.
- Frame cost. Every timing this session came back flagged by `capture.mjs`
  (`LOADED(25.4)`, then `CONTENDED 10p/2b`). +108 triangles on 21.5 k cannot
  plausibly matter, but it is not measured. AGENTS.md 5 applies.
- Whether the new knee of the head reads well from a waterline or below-water
  camera. It was judged at `bow-head`, `bow-ahead` and `port-side` only.
- The stow now reads as a smooth continuous fender at 34 m. Real hammock nettings
  sag between cranes; a scallop would break it up, but the stow's 1.48 m sample
  pitch is within a hair of the cranes' 1.5 m so any per-station modulation
  aliases against them. Left alone deliberately — it would need more rows.
- The brass material itself is untouched. It is not broken, but any large
  flat-normal surface put in that bin will mirror the sky and go green. The
  stern-gallery gilt is small strips and reads as muted olive rather than teal;
  if that is ever called a defect the answer is the same one applied here.
