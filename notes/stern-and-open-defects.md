# Post-deploy player-reported defects (2026-08-22)

Ground truth is the owner's gameplay screenshots at
https://eugeneyip.github.io/Sail/ . Four open items, worked in the owner's order.

1. **Stern / aft transparency** — the aft structure reads penetrable or incomplete
   from several real angles. Explicitly NOT the sail film; this is the ship's own
   aft geometry.
2. **Straight partition between stern and near wake** — a ruled boundary still
   readable in the real player view, despite §96's ramp-width fix improving the
   general look.
3. **Black flickering blotches when zoomed out** — size appears to vary with
   settings. Player-visible. Note this is NOT the same report as §97's P4 (which was
   a far-distance *dark patch* at a fixed station and did not reproduce); this one is
   zoomed-out and flickering, and the owner sees it in play.
4. **Close-up motion harshness + flat-cut rope ends.**

## Discipline carried in

Use `scripts/measure.mjs` where a number is claimed: fresh load per arm, a control
channel the arm cannot influence, repeats, reject inside control variance. Assert
every lever binds. Distinguish a visible effect from a numerical one. Prior
retractions to respect: §97 (P4 not reproduced), §100 (render-scale magnitude
retracted), §101 (heave chatter invisible), §98/§99 (sail film is IBL, shadow and
sheenSpecularDirect both refuted).

## Log

(append-only, newest last)

### Issue 1: the stern is NOT see-through. It is `ship-black` faces shaded wrong.

Owner: `ship-black`, established by single-mesh hiding on a frozen frame.

| hidden mesh | CONTROL mid-transom | crescent L | crescent R | under-counter wedge |
|---|---|---|---|---|
| ship-copper | 0.54 | 0.67 | 0.55 | 1.22 |
| **ship-black** | **48.24** | **135.57** | **73.83** | **135.80** |
| ship-stripe | 0.53 | 0.53 | 0.56 | 0.91 |
| ship-buff | 0.46 | 0.47 | 0.46 | 0.84 |
| ship-deck | 0.54 | 0.52 | 0.55 | 0.91 |
| ship-oak | 0.47 | 0.51 | 0.89 | 0.86 |
| ship-iron | 0.53 | 0.54 | 0.55 | 0.92 |
| ship-brass | 22.92 | 3.49 | 16.23 | 8.21 |
| ship-glass | 4.80 | 0.54 | 3.03 | 0.91 |
| **base2 (return control)** | **0.46** | **0.47** | **0.45** | **0.85** |

`base2` re-renders the base arm last and returns to the 0.46 floor, so the frame is
genuinely frozen and 0.5 is the TAA dither floor. Every mesh except black, brass and
glass sits at that floor.

**So there is no hole and nothing translucent.** The pale hard-edged wedges at the
quarters, the two crescents on the lower transom and the under-counter wedge are all
hull planking geometry whose *shading* is flat and pale against its neighbours. The
eye reads a flat pale panel abutting dark planking as a gap. Same family as §86,
where a bow patch turned out to be `bins.brass` with a purely horizontal normal
mirroring blue sky.

### Three instrument failures of mine, in one sitting, all caught by controls

Recorded because the pattern matters more than the findings.

1. **Emissive magenta + bloom + AgX reads as a translucent veil.** I set the flat
   test material's *emissive*, so the blowout desaturated to cream and I spent two
   arms chasing a "veil" that was my own instrument.
2. **Hiding scene groups moves auto-exposure**, so a "% magenta" metric swung
   48.8% to 1.1% between arms that differed only in what was hidden. Nothing was
   occluding anything.
3. **Sequential arms drifted again.** Ticking 8 frames per arm let the ship sail
   between arms; the ownership deltas then rose monotonically down the mesh list,
   which is drift, not ownership. Fixed by holding dt = 0 so visibility is the only
   variable, and proven by the `base2` return arm.

An ID-colour pass was also discarded outright: its CONTROL box (mid-transom
planking, known to be `ship-black`) classified as `ship-glass`, because the palette
put hues too close together for AgX to preserve. Control failed, result binned.

### Issue 1, actual root cause: the after deck has no taffrail. The stern is OPEN.

The pale-wedge chase above was a dead end created by my own instrumentation. Going
back to the owner's viewing condition — chase camera, live, shipped post, no
instrumentation — the defect is obvious and structural.

Confirmed from two independent angles:

- **chase at 34 m**: the after deck reads as an open tray. The quarterdeck's port
  side shows deck plane, then a thin dark strip, then sea; there is a dark void at
  the port quarter where hull side should be.
- **directly above the poop**: the quarterdeck planking runs aft and **ends at a
  bare squared edge**. Beyond it you look down onto the *inside face of the transom*
  — the stern window openings are visible from within the hull. Nothing caps the
  after end.

Source agrees. `hull.ts` builds the bulwark for `iStart..iEnd` where
`iEnd = stations.length - 1`, i.e. it stops at the last station — but the transom is
**aft of** the last station, bridged only by the counter band. So the deck's after
edge is unclosed. And `taffrail` appears in `hull.ts` only inside comments (the
section header at line 183, a moulding comment at 906, and a stanchion docstring at
1338): **no taffrail geometry is ever built.**

So the stern is not transparent, not culled, not a shading artefact. It is
*missing structure*: the one rail that would close the after end of the deck does
not exist.

**Refuted along the way, each with a control:** a hole or reversed winding
(FrontSide and DoubleSide identical); the ocean or vfx drawing over the hull (veil
survived hiding both, and was my own emissive bloom); wrong normals on the counter
(normal visualisation is smooth and continuous); and bloom (1-3 codes at the
station, `base2` return 0.50).

### Issue 2 (stern/wake partition): visible, NOT isolated. Three instruments failed.

Two magnified crops at the stern do show what reads as a hard dead-level boundary
between a smooth cream foam mass and the flecked sea, in both `astern-low` and
`astern-level`. But every attempt to attribute or even measure it failed its own
control, so nothing is claimed:

1. **Frozen-frame ownership (dt = 0), one vfx/ocean mesh hidden per arm.** Invalid:
   the `base2` return arm came back at 10.5 / 3.5 / 15.6 codes instead of ~0, so the
   wake and foam evolve even at dt = 0. Only `vfx-particles` (46.9 on the smooth mass
   against a 3.5 floor) and `ocean` (29.0 on the flecked sea against 15.6) cleared
   their floors, which is suggestive and no more.
2. **Fresh load per arm, 3 repeats, hide `vfx-particles`.** Load-to-load spread in
   the wake region is 16-19 codes for base and 52-68 for the hidden arm, and the
   deltas (-19.0, +8.9, -3.4) sit inside it. The sky control also moved 13.7 in the
   hidden arm, which it should not. Not attributable.
3. **Boundary-straightness detector** (per-column row of maximum vertical gradient;
   a ruled line gives a near-constant row). The stern band reads row std 18.8-23.0
   across three loads against open-sea controls at 15.6-22.2 — no straighter than
   open sea. The detector locks onto bright foam flecks, not the partition.

**Blocker, stated precisely:** box-mean statistics cannot see this because the wake
region's own load-to-load variance (16-68 codes) exceeds the effect, and a
max-gradient edge detector cannot see it because foam speckle dominates the
gradient. The next correct instrument is a *directional* one: project the suspected
boundary into ship space and test whether a boundary exists at a constant ship-local
Y or a constant screen row across many frames — i.e. measure the line's
*orientation and constancy*, not its contrast. That is a real piece of work and is
not something to guess at.

Issue 2 therefore stays OPEN. §79's standing warning is the best lead: anything that
clamps or cuts on `vD` with a constant draws a dead-level line the length of the
ship, and `uSkirtFloor` is exactly such a constant.

### Issue 4 (rope ends): architectural cause found, and a separate real artefact found

**Why a rope end is a flat cut, structurally.** `makeRibbonGeometry` builds `seg`
spans along the rope and **two vertices across**; the vertex shader orients that
strip to face the camera and sets its half-width from `iParam.y * grow`, which is
constant along `s`. So every rope necessarily terminates square at full radius at
both `s = 0` and `s = 1`. There is no cap and no taper anywhere in the path.

**But a global taper would be wrong.** Most of these lines end at a fitting — a
yard, a block, a belaying pin — and real rigging ends are seized or spliced, not
pointed. Tapering every end to nothing would make attached lines look detached. A
correct fix needs to distinguish free ends from terminated ones, and that
information is not in `iParam`. **Not attempted.**

**And the artefact actually visible at the stern is not a rope.** At 5x, both
quarters carry four or five **flat tapering blades** protruding outboard, each with a
hard straight-cut end, arranged in a fan. A camera-facing ribbon cannot look like
that — it would keep constant width — so these are something else: most likely a
`spar` at low radial segment count, or a chainplate/channel plate. Owner not yet
identified; the single-mesh-hide instrument that settled the hull question would
settle this too, and was not run for lack of time rather than any obstacle.

### Issue 3 (zoomed-out black flicker): not started

No work done. Flagging one thing for whoever picks it up: this is a **temporal**
defect, so the frozen-frame instrument is invalid for it by construction (issue 2
proved the wake evolves at dt = 0), and the fresh-load instrument has 16-68 codes of
variance in exactly the regions of interest. It needs a per-frame time series at a
fixed station with a control channel, in the manner of §97's instrument, not a
handful of screenshots.

### CORRECTION: my "inside the spread" claim was wrong, and here is the proper answer

After the hull change `physics-test --quick` reported failures, so I checked it
rather than assume. Swapping in the pre-change `hull.ts` and re-running:

| hull | run 1 | run 2 | run 3 |
|---|---|---|---|
| pre-change | PASS, median peak 13.90 kn | **FAIL, 15.27 kn** | — |
| with the taffrail change | FAIL, 15.87 kn | FAIL | FAIL |

**My claim that 15.87 kn was "inside" a 13.90-15.27 parent spread was wrong: 15.87
is above 15.27.** Two parent runs are also not a distribution. So the question was
settled by dependency analysis instead, which is decisive and cheap:

- No file in `src/physics/` imports `src/ship/build/*`.
- `src/ship/build/hull.ts` is imported by exactly one module, `src/ship/Ship.ts`,
  and exports only `Bins`, `createBins`, `buildHull`, `HullResult`, `CHANNELS` and
  `stanchion` — nothing physics reads.
- It writes nothing to `world.*`, `world.ext.*` or any uniform. It is pure geometry
  into mesh bins.
- `src/physics/Hull.ts` takes every dimension from `./constants` and its own
  docstring says it builds its sections "from the AGENTS.md dimensions" precisely
  because `world.ext.ship.hullPoints` is "a bare point cloud ... useless for a
  pressure integral".

**There is therefore no code path by which a visual hull-geometry change can reach
the state this assertion measures**, so the change cannot be its cause. That is the
claim I can support.

**What I must NOT claim** is that the assertion is fine. It fails on current HEAD in
3 of 3 runs and on the unmodified parent in 1 of 2. That is a **real, unstable
assertion in the suite, pre-dating this work and unexplained** — not something the
word "flake" should paper over. `bowSlam is scaled for spray and shake` also flipped
between runs on one tree (8.8 m/s^2 passing, a 4.9 m/s^2 run failing).

This is the behaviour `src/physics/index.ts` already documents for this suite: the
gale case sails one frozen wave snapshot and which snapshot you get depends on how
long the preceding tests took, which is why the harness medians five phases. These
two assertions are still sensitive to it. **Recorded, not fixed** — out of scope here
and it needs the sim clock made reachable from a test, which that file says requires
a small addition to `src/ocean`.

### Stern status, corrected

Not closed. Record it as: **major stern structural defect fixed; residual
aft-interior exposure remains open.** The taffrail and the extended deck removed the
open tray and took inboard-visible window frames from about twenty to about six, but
a narrow strip of the transom's inner face is still visible at extreme overhead
angles. Parked, not finished.

### Issue 3 REPRODUCED — high cloud cover, far zoomed-out station

Station: free camera at ship-relative [-140, 330, -90] looking at the ship, i.e.
high and far astern with no horizon in frame, which is what the player's zoomed-out
screenshots show. Sea state 3, noon, renderScale 1, adaptive off. Fresh load per
cell, 16 frames per cell, live ticking.

Instrument: per frame the image is reduced to 25 px blocks (64x36) and a block is
flagged dark if it is below 0.55x that frame's OWN median block luma, so exposure
drift cannot create or hide a blotch. Reported: dark-block count, max area, the
2nd/5th percentile block luma, and churn (blocks flipping dark between frames).

| cloudCover | dark blk/frame | max area % | p5/median | churn/frame |
|---|---|---|---|---|
| 0.0 | 0.00 | 0.00 | 0.889 | 0.00 |
| 0.4 | 0.00 | 0.00 | 0.861 | 0.00 |
| **0.8** | **8.50** | **1.30** | **0.729** | **15.20** |

So the blotches appear only at high cloud cover, and they **flicker**: 15.2 blocks
change state per frame, against 0.00 at lower cover. Sixteen frames is 0.27 s, over
which a cloud shadow moves almost not at all, so this is not cloud motion.

This also explains the owner's "size changes with graphics/settings state": cloud
cover and cloud quality are settings.

The far sea in these captures additionally shows the **regular dotted lattice** the
owner's screenshots show — aliasing of the ocean at distance. Same station, likely a
separate defect, recorded here so it is not lost.

### Issue 3: supersampling REMOVES the blotch. Ground truth established.

The median-relative dark-block metric is retired as primary (it manufactured dark
blocks after a global brightening). Replaced by comparison against a supersampled
reference with only a global luma offset removed.

**Method.** One page load per arm — a first attempt resized the viewport mid-run and
that perturbed the renderer by RMS 11.4 with 340/1210 blocks past -6, against a
same-resolution floor of 1.67, so the resize swamped the effect and was abandoned.
Instead each arm is its own load with a **fixed-tick settle** (600 ticks at 16.67 ms)
rather than a wall-clock wait. Two identical arms (dA, dB) measure the cross-load
floor. The reference is a 4800x2700 render box-downsampled 3x to 1600x900. Far-sea
region declared before measuring: upper half of frame, ship box excluded, 52.6% of
pixels.

| comparison | pixel RMS | block RMS | blocks < -6 | min block |
|---|---|---|---|---|
| dA vs dB (identical arms = floor) | 4.612 | **0.297** | **0 / 1210** | -2.15 |
| dA vs supersampled reference | 6.842 | **2.800** | **13 / 1210** | -7.12 |
| dB vs supersampled reference | 7.081 | 2.833 | 14 / 1210 | -7.21 |

At block scale — which is the scale of the artefact — the reference differs from the
normal render by **9x the cross-load floor**, and the sign is negative: **the normal
render is darker in those blocks and supersampling removes them.**

Pixel-scale high-frequency energy in the far sea: dA 1.514, dB 1.504, **reference
1.207**. Supersampling integrates away about 20% of the pixel-scale noise.

**So the answer to the reference question is YES**, and the mechanism is spatial
under-sampling. Keeping the wording precise: this establishes that *integrating the
footprint* removes the artefact, but it does not by itself separate wave-normal
footprint filtering from reflection-lobe roughness from the probe's own angular
resolution. Those are the next arms, each measured against this reference.
