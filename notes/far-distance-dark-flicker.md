# Far-distance dark patch / flicker (owner P4)

Scope: diagnosis first. No source change until a discriminator isolates a cause.

## The question, kept in three parts deliberately

The owner reports a dark patch and/or flicker at far distance. Before anything
else, establish which of these it is:

- **A. a static dark spatial patch** — dark in a temporal mean, LOW temporal
  variance;
- **B. temporal flicker** — HIGH temporal variance, not necessarily dark on
  average;
- **C. both** — dark in the mean AND high variance.

**A dark static feature must not be called flicker without temporal evidence.**
That is the whole reason this note starts with an instrument rather than a
screenshot.

## Candidate systems, to be separated rather than guessed

far-field ocean / wake · `pxWorld` / footprint-dependent foam · LOD / clipmap
transitions · normal or reflection instability · z-fighting · shadowing ·
exposure / temporal post · TAA history · cloud/ocean interaction.

**One lead, explicitly only a lead.** §95 and §96 refuted the `wThr` footprint
widening as a cause of the NEAR-hull plate, and measured `wThr` pinned at its 0.05
floor in every near band. But `wThr = mix(0.05, 0.5, smoothstep(1.2, 3.5, pxWorld))`
is *designed* to widen at large `pxWorld`, and §96's own ablation showed that
pinning it wide transformed the surrounding foam (`FOAM` sd 14.2 -> 31.5). So it
becomes plausible again at kilometre distances. **The near-field negative must not
be inverted into a far-field conclusion** — it says nothing about the far field
either way.

Related prior art to check before re-deriving: §75 (`§67`'s dead far field, "the
footprint is 3 m by 514 m and `Nlow` was answering with one number"), §76 (earth
curvature and the skirt's hack), and the far-field whitecap block in
`surface.ts` that exists because "past a few hundred metres a full gale rendered
with no whitecaps at all".

## Instrument traps already paid for on this project

1. **Assert the lever binds, not just that the string was patched.** §95's
   `cover <= 0.85` edit compiled and changed nothing because the value never
   reached 0.85.
2. **Do not select on the outcome.** §96's first mask keyed on `foam` itself and
   then "discovered" that foam saturates there.
3. **Establish a noise floor in a control region** that the change cannot reach.
   Two frozen frames of open sea still differed by 3.25 codes from temporal
   residue.
4. **A change appearing where it is impossible is a measurement bug.** An inverted
   equirect convention cost a rebuild in §93.
5. The debug-output trick only replaces the material it is applied to; every other
   object still renders normally and will invert to garbage.
6. Stage screenshots outside the Vite root, or the probe reloads the page it is
   measuring.

## Instrument

`.tmp/fartemporal.mjs` — deterministic far station: eye 28 m up, 40 m to port,
aimed 3 km ahead at sea level, so the horizon sits at row ~457 and the lower half
of frame is far-field ocean at grazing incidence. `free` mode owns pos/yaw/pitch
and damps to zero without input, so at a fixed dt the station is deterministic.
Two arms, 32 frames each, 60 settle frames on the arm's own clock first:

- **live** dt = 16.67 ms — the sim advances, so anything that moves, moves;
- **frozen** dt = 0 — the sim cannot advance, so only the renderer's own temporal
  state (TAA history, exposure) can change anything.

Per-pixel temporal mean and sd, banded by image row (row maps to distance here).

`.tmp/pxstep.mjs` — scales `pxWorld` in the shader by K at a fixed renderScale of
1, isolating the footprint *decisions* from the upscale blur a real scale change
would also bring. `uPixelAngle` is rewritten every frame in `Ocean.update`, so
setting that uniform from the page would have been a no-op.

## Log

(append-only, newest last)

### Finding 1: at a fixed camera, neither A nor B reproduces

| band | live mean | live sd | frozen mean | frozen sd |
|---|---|---|---|---|
| sky, rows 300-440 | 151.3 | 4.64 | 151.5 | 1.14 |
| horizon, 440-470 | 134.8 | 3.89 | 134.9 | 1.43 |
| far sea, 470-520 | 105.1 | 4.66 | 104.8 | 2.09 |
| mid-far, 520-620 | 109.1 | 6.59 | 108.6 | 2.18 |
| mid, 620-760 | 98.5 | 9.62 | 97.3 | 2.26 |
| near, 760-899 | 90.0 | 11.39 | 93.2 | 2.06 |

**Temporal variance falls monotonically with distance** — it is largest in the near
field, which is just wave motion. There is no far-field variance peak, so **no
flicker at this station**. The top 32 px blocks by sd are all in the near/mid sea
in both arms.

And no static dark patch either: the temporal-mean row profile is smooth through
the far field (104-106 just below the horizon, rising gently to 111 by row 570,
falling to 101 by row 690). No anomalous band.

The frozen arm's residual sd of 1.6 to 2.3 codes is TAA jitter continuing at dt = 0
(the Halton sequence advances regardless of dt); top blocks there are only sd 4-5.

### Finding 2: resolution stepping moves the NEAR field, not the far field

`uPixelAngle = 2 tan(fov/2) / world.size.height` uses the BACKING-STORE height, so
every ladder step of `SCALE_LADDER = [1, 0.92, 0.84, 0.76, ...]` scales `pxWorld`
by about 9%. Effect of ONE adjacent ladder step, in codes:

| step | far sea | mid-far | mid | near | sky |
|---|---|---|---|---|---|
| 1.00 -> 0.92 | -1.62 | -0.55 | -0.73 | **+1.08** | +0.27 |
| 0.92 -> 0.84 | -0.16 | +0.02 | -1.16 | **+5.17** | +0.63 |
| 0.84 -> 0.76 | +0.33 | -0.63 | -1.39 | **+5.46** | +0.88 |
| 0.76 -> 0.68 | +0.07 | -0.71 | -1.29 | **+2.34** | +0.57 |

**The far field is insensitive and the near field is not.** The reason is
structural: at kilometre distances `pxWorld` is far above every footprint threshold
so those terms are saturated and a further increase does nothing, while near the
camera `pxWorld` sits on the steep part of the fine-octave ramps (`r3` fades over
0.016 to 0.080 m) where a 9% move matters.

**So the `wThr` footprint lead is refuted for the far field too**, for a different
reason than in the near field: there it was pinned at its floor, here the ramps are
saturated at their ceiling. Recorded as a negative, not carried forward.

**But this is a real defect in its own right, in the near field:** one adaptive
resolution ladder step changes near-field sea brightness by up to 5.5 codes, and
the ladder moves during play. That is a visible brightness pop, and it is NOT the
owner's P4. Filed separately rather than conflated with it.

### The gap this leaves, and the next discriminator

Both arms above hold the camera fixed, so **any motion-induced transition is
invisible to them** — geometry clipmap ring shifts, cascade tile wraps, and the
floating-origin wrap all happen because the ship moves. A one-frame discontinuity
at an origin wrap would read exactly as a recurring flicker and would be
undetectable at a fixed station.

Next: sail normally and log the far-field's *spatially averaged* luma per frame
over several hundred frames, then look for step discontinuities against the smooth
trend, and correlate any with origin/cascade wrap events.

### Finding 3: not reproduced with a MOVING camera either

`.tmp/farmoving.mjs` — same station but re-placed ship-relative every frame so the
camera sails with her, 1200 frames at a fixed 16.67 ms, band means read in-page
with `gl.readPixels` right after `tick()` (cheap enough for four-figure frame
counts). Ship covered 146.7 m, which crosses several fine-cascade tiles.

| band | median frame-to-frame step | max | outliers >8x median |
|---|---|---|---|
| far | 0.058 codes | 0.484 | **0** |
| mid-far | 0.103 | 1.141 | 2 |
| mid | 0.082 | 0.919 | 3 |
| near | 0.063 | 0.278 | 0 |
| sky | 0.022 | 0.218 | 0 |

The far band has **no** discontinuities at all over 147 m of sailing, and the
handful of mid/mid-far outliers are about one code — below visibility. So clipmap
ring shifts, cascade tile wraps and origin wraps are not producing a visible
far-field step at these conditions.

**Three negatives now, all at noon/clear.** The remaining variable I have not
swept is the CONDITION: a dark far patch is much more plausible where the
atmosphere is doing work — low sun, heavy turbidity, short visibility — and §74
records auto-exposure pinned at its ceiling at dusk and night, which changes what a
fixed radiance looks like. §35 also noted the horizon once "read as a seam: the sea
was hazed and the sky was not". Sweeping conditions next.
