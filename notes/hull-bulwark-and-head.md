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
