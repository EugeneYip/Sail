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

### CORRECTION: that reference was built in a state with no defect in it

The stage-isolation arms above must be discarded, and here is the check that caught
it. Two dark-block definitions were compared on the same capture:

- **median-relative** (below 0.55x the frame's own median) — the proxy that
  reproduced the player artefact: **0 blocks** in the far-sea mask.
- **reference-residual** (below -6 after removing the global offset): 13 blocks, all
  in one cluster at pixel y 75-175, x ~1450-1600, the top-right corner.

**Overlap: zero.** And the residual set's absolute luma is 64.1 against a frame
median of 68.1 — four codes below the median, not a dark blotch. It is a
resolution-dependent corner difference.

**Cause of the error:** I swapped the settle from a 14-15 s wall-clock wait to 600
fixed ticks in order to make cross-load state deterministic. That changed the state
enough that **the artefact is not present in it at all**. So the supersampled
reference, the cross-load floor and all three stage arms were measured on a clean
scene, which is exactly why none of them moved: there was nothing to move.

That also explains the otherwise-odd result that widening alpha 2.5x made the
*reference* error worse (3.577, LF correlation 0.956 to 0.922) while doing nothing
for a blotch that was not there.

**What survives:** nothing from the stage isolation. The reproduction from §104
stands (wall-clock settle, cloudCover 0.8, 8.5 dark blocks, churn 15.2) as does its
causal partition, because those were measured in a state that contained the defect
and were driven to exactly zero by two independent ablations.

**Lesson to carry:** determinism and reproduction can be in tension. Verify the
defect is still present in the state you made deterministic BEFORE measuring anything
against it. A floor and a reference are worthless if the artefact left the scene.

### Issue 3 BLOCKED: the artefact's severity is unstable across loads

Take three used the wall-clock settle that reproduced in §104, at the identical
station and cloudCover 0.8, and built the reference from a separate load at
4800x2700. The result does not answer the reference question:

| arm | dark blk/frame | max area | churn/frame | pixel HF |
|---|---|---|---|---|
| normal 1600x900 | 1.94 | 2.40% | 2.20 | 1.399 |
| supersampled 3x, downsampled | 2.69 | 1.74% | 4.07 | 1.620 |

Two problems. **The normal arm barely reproduced** — 1.94 dark blocks against
7.12 / 8.56 / 9.31 / 8.50 measured at the same station, cover and settle earlier. And
**the supersampled arm is not better**: more dark blocks, more churn, more pixel HF.

So severity at this condition ranges from about **1.9 to 9.3 dark blocks between
loads**, which is as large as any effect I have been trying to measure. A two-arm
comparison cannot resolve a fix against that, and neither the earlier
"supersampling removes it" reading (measured in a state that turned out to contain no
defect at all) nor this one can be trusted.

**What still stands, and why.** §104's causal partition: in runs where base measured
7-9 dark blocks, two independent ablations — volumetric clouds off, and the ocean's
reflection forced off the probe — drove the metric to **exactly 0.00 with 0.00
churn**. An exact zero cannot arise from load-to-load luck when the base is 7-9, so
the chain (cloud content in the probe -> ocean reflection -> dark blocks) holds. Also
still standing: the cloud-shadow term, TAA, and the probe's 6 Hz cadence were each
eliminated, and the one-sided dark floor was rejected for creating the artefact at a
second zoom.

**What is not established:** the magnitude, whether supersampling removes it, and
which filtering stage is deficient. The mechanism wording stays where the owner put
it: *unresolved-normal / insufficient angular filtering is the strongest candidate,
not isolated from probe-resolution or reflection-filtering effects.*

**The blocker, precisely.** Before any fix can be evaluated, the repro needs to be
made *stable*, not just present. The fixed-tick settle removed the artefact entirely,
so some state that the wall-clock settle reaches and the tick settle does not is what
determines severity — cloud field maturity and probe contents are the obvious
candidates. Finding and pinning that variable is the next piece of work, and it must
come before another reference or another fix attempt. Guessing past it is how the
last two attempts were wasted.

### Issue 3 PHASE A: the churn is ENVIRONMENT-side, not the ocean's normals

A new brightness-invariant metric replaces the median-relative one: residual =
luma - boxblur(luma, 101 px), then blocks below -6 of that residual, so a blotch is
dark relative to *the sea around it* and no global brightness shift can manufacture
one. Validated before use: clean cloudCover 0.0 and 0.4 give 3.3 and 3.0 blocks with
churn 3.5 and 3.2, the cloudCover 0.8 repro gives 22.7 blocks with churn 36.2, and
both §104 ablations return to floor (clouds off 4.4, probe tap off 2.7).

**Attempt one failed and is discarded**: the return-to-baseline control went 20.4 to
48.0 blocks monotonically across arms in order, and "both static" still churned at 65
because only the probe and ocean were frozen while the Sky module stayed live and
feeds the ocean's non-probe path.

**Attempt two** fixed both: palindrome order (live A B C C B A live) so linear drift
cancels on averaging, the Sky module frozen alongside the probe, autoExposure off.
Every lever asserted by readback — probe texels identical across frozen arms, wave
height identical across ocean-frozen arms.

| arm | blotch blocks | **churn** | min residual |
|---|---|---|---|
| live, both live | 49.79 | **76.77** | -14.39 |
| **A static ENV / live ocean** | 60.96 | **1.82** | -13.16 |
| **B static ocean / live ENV** | 46.00 | **74.00** | -13.67 |
| C both static (null) | 54.79 | 1.86 | -15.27 |

**Freezing the environment removes the churn; freezing the ocean does not.** 76.8 to
1.82 against 76.8 to 74.0. And C's 1.86 is a genuine null, so the frozen scene is
stable and **TAA is not a churn source of consequence**.

**This reverses my earlier hypothesis.** The temporal defect is NOT unresolved wave
normals sampling a static environment — it is the environment itself changing. The
ocean's spatial filtering is not the churn owner and should not be touched for it.

Note also that blotch *area* is roughly constant across every arm (46-61 blocks). The
spatial dark pattern is the sea reflecting a genuinely cloudy sky, which is largely
correct; the player-visible defect is the **flicker**, and that is environment-side.

Per the owner's decision tree this sends the work to EnvProbe / cloud temporal
filtering, and explicitly away from dark floors, reflection clamps, sea brightening,
removing clouds from the probe, and global reflection blur.

### Issue 3 SOLVED (mechanism): the cloud shadow map, sampled with one unfiltered tap

Full record in DIAGNOSIS §107. What matters for the running log:

**I was wrong three times in a row about the subsystem**, and the reason was one
instrument error, not three. The mandated freeze partition kept reporting "lever bound,
no effect" for the sky→ocean data path, including arm D which froze *every* ocean-consumed
Sky output simultaneously and asserted them held. `uCloudShadowMap` is a **texture**
uniform: its `.value` is a pointer to a render target that `Clouds` overwrites in place
every frame. Holding the pointer freezes nothing, and asserting the pointer is unchanged
asserts nothing. Every "excluded the cloud-shadow term" step in this file that froze the
strength scalar and the matrix but not the *pixels* was therefore invalid.

Rule added: **a `.value` equality check proves a lever bound only for immutable values.**
For a texture, stub the pass that writes the target and assert on blocked call count.

Freezing `Clouds.shadowPass.render` (10 blocked renders in 10 frames, strength intact)
and separately ablating the term gave the partition every previous round had missed:

- shadow **ablated**: blotch 48.35 → 9.20, churn 72.78 → 10.22, residual depth −14.7 → −6.0
- shadow **present but frozen**: churn 72.78 → 24.00, blotch *rises* to 62.50, depth −14.5

So the black patches *are* cloud shadows, and the flicker *is* that map's per-frame content.
Both halves of the player's "black flickering blotches" land on one input.

**The two obvious fixes both failed, and that is the diagnosis.** More march steps: not
significant (−1.0x control). Doubling the shadow map to 1024: **6.4x worse** (churn 91 → 198).
The map is 512 texels over 26 km = 50.8 m/texel, built `generateMipmaps: false`, and
`lwCloudShadow` takes a single `texture2D` with no footprint term — so the deficient stage
is receiver-side filtering, and adding source detail adds aliasing. That also explains the
zoom dependence the player reported: zoom out, the per-pixel world footprint grows.

An independent equirect-pole discriminator on the reflection path agrees: moving the
mapping's singularity made things worse (+2.1x control) while a null control that rotated
the environment 90 deg about the same pole moved nothing (+0.0x). The metric tracks
sampling geometry and ignores which cloud content is sampled.

No fix landed. Standing instruction after a failed acceptance is to stop rather than tune,
so the resolution-vs-cost trade-off goes to the owner.

### Issue 3 CLOSED: the shadow slice had a static dither and no temporal filter

DIAGNOSIS §108. §107's *owner* was right; §107's *mechanism* was wrong, and I caught it
only because the brief demanded runtime proof that the fix binds before implementing it.

I measured the per-pixel shadow-map footprint before writing any code: **0.008–0.016
texels per pixel, implied LOD −6 to −7.** The map is magnified 60–120x. A mip chain with
derivative LOD — the specified fix — would have selected level 0 at every pixel and done
nothing. Implementing it would have been busywork that measured as a null and taught me
nothing. That is also the real reason §107's 1024 arm backfired: at fixed magnification,
more source detail is just more visible detail.

So I read the map back instead of theorising. 24 % of texels change every frame, and the
worst change is 0.96503 — exactly `1.0 − 0.035` — the same number every single frame,
i.e. texels flipping *fully* between lit and the floor. Clouds move 0.077 m in a frame
against a 50.8 m texel, so it is not advection. Partitioning tau: the **deck march** owns
the full-range flips and the blackness (maxΔ 0.965→0.197, floor 0.035→0.614 without it);
**cirrus** owns the broad low-amplitude churn (25.4 %→4.5 % of texels).

The fix was already in the codebase, applied to a different pass. The main cloud march
advances its dither per frame *and* has a temporal resolve, and its comment explains why
the two go together. The shadow slice had the dither hashed on world position — static on
purpose, so it would not crawl — and no filter behind it. Static dither with no filter is
precisely a terrace that flips whole texels. It now gets both halves, with the history
realigned by the centre re-snap delta (exact, since the centre only moves in whole texels).

Result: published slice per-frame meanAbsΔ 0.0370 → 0.0021, worst flip 0.96503 → 0.05225,
landing on the predicted alpha×range. On screen at the repro state: blotch 42.29 → 1.00,
churn 70.50 → 0.36, depth −14.43 → −5.97. Churn collapses at every zoom and render scale,
and the low-cloud null control is flat — with no shadows, the fix does nothing.

Two honest notes. **Contrast is gentler**, partly noise removed and partly because 20
averaged dithered marches converge on the true optical depth rather than the noisy
extremes; the floor-over-strength question is the lever if the owner wants depth back, and
it stayed out of scope. And **the residual metric is invalid in the wake region** — the
low-cloud control reads blotch 83.2 there with no shadows present, so that is wake foam
inside the metric, not a defect. I am not claiming an improvement in cells I cannot measure.

Cost measured, not assumed: +0.07 ms typical, +0.16 ms worst, 3→5 cloud passes, +1.0 MB.

### Boston: diagnosed, not fixed. The root cause is a missing definition.

DIAGNOSIS §109. Reproduced at `?showcase=boston` and measured, not eyeballed.

The headline is that **there is no navigable-water definition anywhere in the project** —
no harbour carve, no shoreline contour, no water polygon. So the brief's "agreement between
visual terrain and navigable-water coordinates" has nothing to compare against, and every
other defect follows from it: nothing keeps the town out of the water because nothing says
where the water is.

Measured on the committed mesh: 152 vertices at *exactly* y = 0, 13.6 % within ±2 m of it,
**26.5 % inside y ∈ [−5, +5]**. The town is placed with no y offset, so local y is world y.

Four concrete defects:
1. `landHeight`'s `shore = clamp((z+60)/150, 0, 1)` makes height exactly 0 for all z ≤ −60,
   and the grid starts at z = −135 — a 2600 × 75 m dead-flat plate at mean sea level in pale
   beach colour. The pale plane the player is sailing *on* is this, not glare.
2. Long Wharf is a 500 m slab at y ∈ [0, 4.8]; the quays are y ∈ [0, 4.0] on that plate.
3. Island base rings are only 3 m down, against metres of wave.
4. `b.tube(rows, false)` leaves the terrain a **hollow shell** — no side walls, no back, no
   bottom — and with `DoubleSide` the interior renders as a black void with buildings
   floating in it. That is the player's "camera inside terrain" frame, captured.

Floating origin is the one item that checks out: forced 4 km rebase moved rendered x by
exactly −4000.00 with absolute position stable to < 0.01 m. Not a defect.

Fix direction (not started): let landHeight go negative seaward of a declared shoreline so
the surface crosses y = 0 on a line; stand wharves on footings below the trough; drop island
bases below the wave band; close the shell. All of it wants the missing navigable-water
region defined first.

### Boston topology FIXED — and the normals were inside out all along

DIAGNOSIS §110. The topology went the way §109 predicted: a shoreline curve with a 220.9 m
throw instead of a straight rectangle edge; height signed about that curve so the surface
crosses sea level on ONE row instead of a 2600 × 75 m plate; a footprint mask taking the
ends and the back down to the shelf so there are no straight side or back walls; the
boundary ring walled to −52 and capped, so the land is watertight instead of a shell; Long
Wharf lifted onto piles with its deck at y ∈ [3.2, 5.2] and abutted into the shore; the
quays turned into a segmented seawall straddling the contour; islands based at −18 and held
off the fairway. And the thing that never existed — a declared navigable corridor — now
does, Boston-specific and not a navigation framework.

Measured on the committed mesh: height **exactly 0** at all 400 contour samples, max terrain
height in the corridor **−34.00 m**, zero solid intruders and zero moored hulls in the
fairway, floating origin still exact to the centimetre across a 4 km rebase.

**The surprise.** `finish()` takes face normals as (b−a)×(c−a), and under that order the
land's rows, the islands' rings and `BOX_FACES` were ALL wound to give inward/downward
normals. Measured: 0 of 1764 land vertices pointed up (mean −0.9909); 0 of 426 island
vertices; and a seawall's top face at a known y = 3.6 carried normal.y = −1 on all four
vertices. The town's shader is a bare `normalize(vNormal)` that only flips for cloth, so
Boston was lit as though every surface faced away from the sun — which is most of what the
player was calling giant dark terrain slabs. Reversed, all three now measure up.

Scope held deliberately: `box()` is reached only by Boston (the ship has its own
MeshBuilder), so that fix is contained. `tube`, `cyl` and `rope` in wgeom share the same
inverted convention and are ALSO reached by vesselGeom, Buoys and creatureGeom — left
untouched, Boston's two tube uses fixed at the call site instead.

Bounding the claim: what is PROVEN is the Boston land, island and box cases. Whether the
vessels, buoys and creatures are actually mis-lit is a **strong cross-system lead, not a
confirmed world-wide defect** — no representative consumer of tube/cyl/rope has been
inspected yet, and a call site could reverse deliberately or an nfix entry could already
correct it. No global flip without a per-consumer audit and a broad visual regression.

Two honest notes. Vertex counts near sea level are not acceptance — 26 % of the mesh is
within ±5 m either way because 168 moored hulls float there and a beach is supposed to be
shallow; my first instrument reported "no change" and was measuring the fleet. And the
buildings still read dark, but that is albedo seen side-on, not normals.


### Boston status

**Boston topology engineering-accepted; deployed/player acceptance pending.** Frozen at the
committed state. No facade polish, decorative windows, city beautification or collision
physics in this or any following pass until player acceptance comes back.

### Issue 2: owner CLOSED (HullWater's transom pad). Exact operation NOT closed.

DIAGNOSIS §111.

**Why dt = 0 never worked.** It did freeze the wake — measured, WakeField 0 % of texels
changed per frame, FoamSim 0 % after two settle frames. What it never froze was the image:
`time.frame++` runs regardless of dt, so TAA's Halton jitter (`frame % SEQUENCE_LENGTH`)
re-jitters, film grain re-dithers ~90 % of pixels by 1–2 codes, the cloud march re-marches on
`frame % 64`, and a 1-LSB output dither fires. Every earlier screen-space instrument was
reading those and concluding the wake was alive. The freeze that actually works: dt = 0, TAA
off, grain off, bloom/DoF/AE off, clouds off, three settle frames — asserted on the buffers
AND the framebuffer (static to ±3 codes).

**Owner.** Ablation masks under that freeze, with particles held off in every arm so the
control is clean: null control **8 px (0.0006 %)**; hiding HullWater's `sheet` masks
**26,903 px** and removes the plate and its ruler-straight edge; hiding the `skirt` masks
**7 px**; hiding particles leaves the plate and edge intact. So it is the **sheet's transom
pad**, 9.5 m astern on a 47.5 m Lwl. Ablation beats colour ID here precisely because AgX
cannot corrupt a difference mask.

**What is not closed, and why.** The `rawA` debug render shows the pad as a hard-edged quad
with non-zero alpha at its boundary, and the alpha line has two structures that could rule the
edge — the `0.30 +` floor on vThick, and the `* 1.75` gain against the `min(.., 0.95)` cap,
whose saturation contour is a line of constant distance astern. I could not separate them:
three attempts encoded the value in colour channels and read it back from the COMPOSITED
framebuffer, and AgX plus the look LUT wrecked all three. Same trap as the old ID-colour pass.

Rule for next time: **never read numeric fields out of a tonemapped framebuffer** — sample a
pre-tonemap target or write a dedicated debug target. No fix landed, because the two
candidates imply different fixes and the brief requires closure first.

### Issue 2 CLOSED: the ruled partition was the transom pad's alpha CLAMP

DIAGNOSIS §112. §111 had the owner right and the mechanism wrong.

The instrument that worked reads the post stack's own `post/scene` target — rgba16f,
NoColorSpace, before exposure/AgX/LUT/bloom — with the sheet on NoBlending and alpha = 42 as
a sentinel. It round-trips 0.0, 1.0 and 0.5 **exactly**. Two traps had to be closed first:
particles blend additively over the pad (they lifted a "1.0" arm to 1.0635 and moved the
sentinel), and separate page loads leave the ship in different states so scalars from
different loads are not pixel-joinable — the fragmentShader is swapped in-page instead.

**The pad's fade was fine all along.** At the trailing boundary `edge` = 0.0003 and alpha =
0.0002. What the scalars actually showed is a **saturated plateau in the MIDDLE of the pad**:
~50 % of fragments between 3.3 m and 4.3 m astern sitting exactly on the 0.95 cap. The
visible ruled line is the cap's iso-contour, and since `edge` varies almost only with aft
distance, that contour is a line of constant distance astern.

Two arms settled it: gating the thickness floor so it can reach zero left the plateau and its
aft boundary *exactly* where they were (vT 0.50, gradient slightly worse); removing the clamp
eliminated the plateau entirely. **Saturation-dominant.** Fix is a soft knee — below 0.55
untouched, above it asymptotes to the same 0.95 — because a plain hyperbola halved the pad's
opacity. Result: % at cap 8.05 → 0.00, plateau gone, mean alpha 0.263 → 0.272 (mass kept),
trailing-edge alpha still ~2e-4 (no new gap).

One honest note: I also ran a screen-space "coherent row step" metric across six views and it
moved both ways (+45 %, −22 %). That is the fresh-load brightness measurement already known to
be swamped by wake-state variance — I re-created a known-bad instrument and am not counting it.
Acceptance rests on the in-load pre-tonemap scalars plus inspection, including bow and beam
stations since the alpha line is shared with the bow sheet.

### Issue 4B IDENTIFIED: the flat blades are the open gunport lids

DIAGNOSIS §113. Not fixed — the correction is an authenticity call and was not authorised.

The row of evenly spaced flat grey slabs standing straight out of the hull side, one per open
port, square-ended, are the gunport lids. `const ang = p.open ? 1.32 : 0.03;` — and 1.32 rad
is 75.6°, which for a lid hinged at the head leaves it 14° BELOW horizontal, i.e. a shelf
projecting from the ship's side with its maximum silhouette broadside to the eye. Confirmed by
isolation: rebuilding at 0.55 rad rotates the same slabs down against the hull.

1.32 is close to the worst value available. The sweep runs 0 = closed over the port, ~pi/2 =
horizontal shelf, ~2.4-2.8 = lying back against the side, which is where a triced-up lid
actually sits. The section's comment records that the SIGN of this rotation was fixed once
(it used to swing them inboard); the magnitude was never revisited.

Issue 4A is untouched and unchanged: rope ribbons are square-ended by construction and that
stays deliberate. **The blades are not ropes** — so both halves of Issue 4 are now attributed
and neither calls for a global rope taper.

### Issue 4B CLOSED: gunport lids 1.32 -> 2.2 rad

DIAGNOSIS §114. Bounded sweep of 1.32 / 1.9 / 2.2 / 2.5 at one ship state, five views plus a
close looking-down station.

The useful finding is why the middle candidate fails. The lid's face normal starts horizontal
and points straight UP at 90 deg, so shelf-ness goes as sin(ang) and is **symmetric about
90 deg**: 1.32 gives 0.969 and 1.9 gives 0.946 — practically identical. 1.9 only looks better
from a deck-level camera because the plate tilts away; from anything elevated it still shows
almost its whole face, and the looking-down captures confirm it. 2.2 (0.808) folds the lids
back against the side; 2.5 (0.599) removes the shelf but starts reading as large dark panels
on the planking. So 2.2 — the smallest that actually works.

Judged from the level broadside alone, 1.9 would have passed. It does not. Worth remembering
for any future "rotate it a bit further" fix: check the quantity that governs the silhouette,
not the one view where it happens to hide.

Angle only; lid geometry and thickness untouched. No penetration, and 54 deg of clearance off
the topsides so no z-fighting.
