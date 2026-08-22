# Camera position jitter under an irregular clock, in ship-mounted modes

Running log. Task: DIAGNOSIS §85a — the camera pipeline is frame-rate dependent
for `helm`, `bowsprit` and `masthead` but not for the tethered `chase`/`orbit`
controls. §85a localised it to what computes the eye's **position** (relative
angular reversals are 0.0% everywhere). Instrument: `.tmp/jitterrel.mjs`.

Baseline to beat (from §85a, dY sign-reversal rate of the ship-frame position
residual):

| mode | regular | irregular x3 | mean |
|---|---|---|---|
| chase (control) | 0.8% | 0.8, 0.8, 0.8 | 0.8% |
| orbit (control) | 0.5% | 0.8, 0.4, 0.8 | 0.7% |
| helm | 0.5% | 3.0, 2.7, 4.9 | 3.5% |
| bowsprit | 0.5% | 14.4, 13.6, 10.2 | 12.7% |
| masthead | 0.8% | 13.6, 12.9, 10.2 | 12.2% |

## Log

- Read AGENTS.md, DIAGNOSIS §85/§85a. Note created before any source reading.

### Instrument

`.tmp/jitter2.mjs` extends `.tmp/jitterrel.mjs` with three things the ablation
needs: **both arms** in one job, Vite's HMR socket killed (six agents edit this
tree; a reload mid-run silently resets the sim), and **runtime per-term ablation**
of the ship-frame pipeline by wrapping `ShipFrame.update` from the page — the
filter's own state is saved and restored around each frame, so ablating what the
*camera* sees does not also change the filter's trajectory. One process, one page
load and one settle serve every cell, which is the only way to avoid comparing
two captures taken minutes apart (see §43, §49).

It also reports dX and dZ reversals, not only dY.

### Baseline reproduced, and dY was the least of it

`node .tmp/jitter2.mjs --abl=none --reps=3`, one page load, `n` ~400 (regular)
/ ~265 (irregular):

| mode | arm | dY rev | dX rev | dZ rev | \|dpos\|/s |
|---|---|---|---|---|---|
| chase | reg | 0.8, 0.5, 0.5 | 1.0, 0.8, 0.5 | 0.5, 0.8, 0.8 | 0.9-1.5 |
| chase | irr | 1.1, 0.8, 0.8 | 0.8, 0.8, 1.1 | **3.4, 3.8, 3.8** | 1.0-1.4 |
| orbit | reg | 0.5, 0.5, 0.8 | 0.8, 0.8, 0.8 | 1.0, 0.5, 1.0 | 2.7-7.9 |
| orbit | irr | 1.1, 1.1, 0.8 | 0.4, 1.1, 0.8 | **4.6, 4.6, 5.7** | 1.1-5.4 |
| helm | reg | 0.8, 1.0, 0.8 | 0.5, 1.0, 0.8 | 0.8, 0.8, 1.3 | 0.06-0.23 |
| helm | irr | **3.0, 2.3, 6.1** | **9.8, 10.6, 9.5** | **26.1, 25.0, 25.0** | 0.33-0.40 |
| bowsprit | reg | 0.5, 0.5, 0.8 | 0.8, 1.5, 0.5 | 1.5, 1.3, 0.8 | 0.07-0.11 |
| bowsprit | irr | **13.3, 13.6, 13.7** | **7.6, 10.2, 9.5** | **25.0, 25.4, 25.1** | 0.29-0.30 |
| masthead | reg | 0.8, 0.8, 0.8 | 0.8, 0.5, 0.8 | 1.0, 0.8, 0.5 | 0.07-0.20 |
| masthead | irr | **13.7, 14.4, 7.2** | **12.2, 9.9, 12.5** | **25.9-33.8** | 0.30-0.42 |

dY means: chase 0.9, orbit 1.0, helm 3.8, bowsprit 13.5, masthead 11.8 — §85a's
table within its own spread. Relative angular reversals 0.0% in all 30 runs, as
§85a found.

Two things this adds:
- **The worst axis is ship-local Z (fore-and-aft), at 25-34%**, five to eight
  times the dY figure §85a quoted. dX is 8-13%. So the vibration is a
  three-axis positional wobble, not a vertical bob.
- The controls are not perfectly clean either: their dZ goes from 0.5-1.0%
  regular to 3.4-5.7% irregular. Same mechanism, one order of magnitude down.

### The `heaveResidual` lead is dead at the code level before any measurement

`grep` for `heaveResidual` outside `ShipFrame.ts`: exactly one reader, the bob
spring in `modes/Helm.ts`. **`bowsprit` and `masthead` never touch it** — and
those two are the WORST two modes (13.5% and 11.8% dY), while `helm`, the only
mode that reads it, is the mildest at 3.8%. A term absent from the two worst
cases cannot be the cause of them. It is ablated anyway below.

What bowsprit and masthead have in common is the whole of their eye solve:

    localToWorld(frame, L.x, L.y, L.z, eye)   // = frame.smoothQuat * L + frame.mountPos

and nothing else. `avoidHull`/`avoidRig` are false, `waterClearance` is -50 so
the surface clamp never fires, `posSmoothTime` is 0 so the rig's final filter is
a copy. `masthead` has no per-mode state at all. So for masthead the camera
position **is** `smoothQuat * L + mountPos`, exactly, and that expression alone
scores 11.8%. Two candidate terms, and they are the only two.

### The mechanism, derived: a zero-order hold on a MOVING target

`damp` and `springDamp` are exact for a target that is **constant over the
step**. Every filter in `ShipFrame` tracks a target that is *moving* — the hull's
attitude, its origin, its heading. For a moving target the closed form is no
longer exact, and the steady-state **lag depends on dt**.

For a first-order smoother of rate `r` tracking a ramp of rate `v` with a
zero-order hold, the steady-state error is

    e* = v * dt * e^(-r dt) / (1 - e^(-r dt))  ~=  v/r - v*dt/2 + O(dt^2)

so the lag shrinks by `v*dt/2` as the step lengthens. It is exact only in the
limit dt -> 0. `.tmp/zoherr.mjs` drives the real primitives to steady state on a
unit ramp and measures it (lag in ms of target motion):

| filter, as used in ShipFrame | 1x | 2x | 3x | 4x | 1x->4x |
|---|---|---|---|---|---|
| `mountPos` spring 0.11 | 101.79 | 93.14 | 85.08 | 77.95 | **-23.85** |
| `heaveLow` spring 0.75 | 742.48 | 734.64 | 726.53 | 718.21 | -24.27 |
| `anchor` spring 0.55 | 542.42 | 534.43 | 526.13 | 517.61 | -24.81 |
| `heading` spring 0.50 | 492.40 | 484.35 | 475.99 | 467.42 | -24.98 |
| **`smoothQuat` cascade r=9** | 205.97 | 190.55 | 175.96 | 162.18 | **-43.79** |
| `heel`/`pitch` damp r=6.3 | 150.54 | 142.65 | 135.04 | 127.72 | -22.82 |

Every channel loses ~25 ms of lag between a 1-frame and a 4-frame step — which
is exactly the half-step `(66.7 - 16.7)/2 = 25 ms` the expansion predicts, and
it is the same for every rate because the term is `v*dt/2`, independent of `r`.

**The attitude cascade loses 43.8 ms, nearly double**, because it is two stages
and stage 2 samples stage 1 *after* stage 1 has already advanced this frame. Two
half-steps, plus a feedthrough that grows with dt: the immediate share of a fresh
raw attitude is `k^2`, which is 1.9% at one frame and **20.3% at four**. So the
cascade's bandwidth is itself a function of the frame interval.

The consequence for a **mounted** camera, whose eye is `smoothQuat * L +
mountPos`:

    lever arm     1 deg/s     3 deg/s     6 deg/s   of hull rotation
    helm 16.4 m   12.5 mm     37.6 mm     75.2 mm
    jibboom 32 m  24.5 mm     73.4 mm    146.7 mm
    main top 38 m 29.1 mm     87.4 mm    174.7 mm

plus ~12 mm from `mountPos` at 0.5 m/s of heave. Every time the clock steps from
one refresh interval to four the eye lurches that far **toward** the true pose,
and on the next short frame it lurches back. A square wave keyed to the frame
interval — "visible repeated vibration".

This also explains why the two tethered controls barely move under the same
clock. They place the eye from `frame.anchor` and the heading basis, with no
lever arm through the attitude quaternion, so they get one half-step instead of
two and no 32-38 m multiplier; and their *genuine* relative motion is 1.0-1.5 m/s
against a mounted camera's 0.07-0.20 m/s, so the same artefact is 15x smaller
relative to the signal it is competing with. A reversal-rate statistic is a
signal-to-noise measure, and a bolted-down camera is the quiet channel where a
small artefact shows.

### And why only the mounted modes: they are the only ones with no output filter

`CameraSolve.posSmoothTime` is the rig's final second-order filter on the solved
eye. Grepping the modes:

    Chase.ts     posSmoothTime = 0.34
    Orbit.ts     posSmoothTime = 0.30
    Cinematic    0.4 - 0.75 (0 for the one hard-mounted shot)
    Helm / Bowsprit / Masthead   0 (the CameraSolve default)

and `CameraSolve` says why: *"Zero for anything bolted to the ship — a deck
camera that lags its mount reads as the deck sliding under your feet."* That is
correct as a composition rule and it is also the reason these three modes are the
ones the player named. A lag STEP arriving at the eye is smeared over ~20 frames
by a 0.3 s spring and never reverses sign; arriving unfiltered it is a
frame-to-frame square wave.

So the pipeline is dt-dependent for every mode. Only the three with no output
filter show it.

### Ablation, one term at a time, irregular arm, one page load

`node .tmp/jitter2.mjs --abl=none,heave,attitude,mount,both --modes=chase,helm,bowsprit,masthead --arms=irr --reps=3`.
Each ablation replaces what the CAMERA sees with the raw hull value while the
filter keeps its own trajectory. dY / dX / dZ reversal %, and the residual
magnitude:

| ablation | mode | dY | dX | dZ | \|dpos\|/s |
|---|---|---|---|---|---|
| none | chase | 0.9 | 0.8-2.7 | 5.7-7.6 | 1.1-1.5 |
| none | helm | 3.8 | 5.3-8.4 | 25-27 | 0.36-0.46 |
| none | bowsprit | 11.5 | 12.2-13.3 | 25-28 | 0.32-0.38 |
| none | masthead | 10.9 | 8.3-14.4 | 27-30 | 0.33-0.37 |
| `heaveResidual := 0` | helm | **11.6** | 12.1-13.6 | 25-28 | 0.31-0.34 |
| `heaveResidual := 0` | bowsprit | 15.5 | 11.4-13.6 | 25-26 | 0.31 |
| `heaveResidual := 0` | masthead | 13.0 | 7.2-16.0 | 25-27 | 0.32-0.34 |
| `smoothQuat := rigidQuat` | helm | 3.0 | 9.9-11.4 | 25.1 | 0.31-0.33 |
| `smoothQuat := rigidQuat` | bowsprit | 11.8 | 9.9-11.4 | 25.1 | 0.28-0.32 |
| `smoothQuat := rigidQuat` | masthead | 11.0 | 10.3-15.2 | 25.1 | 0.30-0.32 |
| `mountPos := rigidPos` | helm | 4.2 | 12.2 | **12.2** | **0.062** |

Three results, and the first two are the ones that matter:

**1. The `heaveResidual` lead is not merely absent, it is BACKWARDS.** Zeroing it
takes helm from 3.8% to **11.6%** — up to the level of the other two mounted
modes. The knee-flex bob was *masking* the defect: it adds genuine smooth
vertical travel to helm's residual, and a sign-reversal statistic is a
signal-to-noise measure, so the extra smooth signal was holding helm's dY down.
That is the whole of why helm read 3.5% in §85a while bowsprit and masthead read
12%. **Lead killed, and the direction of its effect recorded so nobody chases it
again.**

**2. Ablating the attitude cascade alone changes nothing** — bowsprit 11.5 ->
11.8, masthead 10.9 -> 11.0, dZ pinned at 25.1%. So the two-stage cascade, for
all that it has the worst lag spread (43.8 ms), is not the dominant carrier.

**3. Ablating `mountPos` collapses the residual MAGNITUDE**, helm 0.36-0.46 ->
0.062 m/s — an 83% cut, back to the regular arm's own 0.06-0.23 m/s. Its dZ
halves, 25 -> 12%. So `mountPos`'s dt-dependent lag against the ship's forward
speed is where most of the *motion* is: 23.85 ms of lag spread at ~4 m/s of hull
speed is 95 mm of fore-and-aft step, which is why **ship-local Z is the worst
axis and reads the same 25% in all three mounted modes** — `mountPos` has no
lever arm, so it hits all three equally. dY is where the lever arm shows, and dY
is the axis that separates them.

Note what ablating a term does to the *rate* as opposed to the magnitude: with
`mountPos` raw, helm's dX rate goes UP (5-8% -> 12%) while its magnitude falls
83%, because the attitude term is now the whole of a much smaller signal. **The
reversal rate is a ratio.** Any fix therefore has to remove the dt-dependence of
BOTH terms; removing one only re-weights the statistic.

### Root cause

Three facts compose into it:

1. Every filter in `ShipFrame` is a zero-order-hold discretisation tracking a
   target that moves, so its lag is `v/rate - v*dt/2 + O(dt^2)` — a function of
   the frame interval. The attitude cascade pays the half-step twice.
2. Under an irregular clock the lag therefore steps up and down frame by frame.
   `mountPos` carries most of the amplitude (23.85 ms of lag spread against the
   hull's ~4 m/s of way = ~95 mm of fore-and-aft step, hence dZ being the worst
   axis and equal across all three mounted modes); the attitude cascade carries
   the rest, multiplied by a 16-38 m lever arm, hence dY separating the modes by
   lever arm.
3. The three ship-mounted modes take `mountPos` and `smoothQuat` straight to the
   eye with `posSmoothTime = 0`, on purpose. The two tethered controls pass the
   same steps through a 0.30-0.34 s output spring, which smears each step over
   ~20 frames so it never reverses sign.

None of this is a defect in `damp` or `springDamp`, and none of it is
`heaveResidual`. It is the pipeline feeding a correct primitive a target that
jumped, exactly as §85a suspected the shape of.

### Fix: sub-step the ship-frame filters

`src/camera/ShipFrame.ts` only. `update` now runs `ceil(dt / FILTER_SUBSTEP)`
equal sub-steps with the raw ship transform interpolated across them (`lerp` for
position, `slerp` for attitude, linear for the scalar channels), so a 66.7 ms
frame produces what four 16.7 ms frames would have produced. The primitives are
untouched.

`FILTER_SUBSTEP = 1/240` and not `1/60`, because the sub-step COUNT is an
integer: at 1/60 the count flips between one and two exactly as dt crosses
16.7 ms, which is where players live, and that flip is itself a 4 ms lag step.
`.tmp/zohfix.mjs` scores the candidates on lag spread across dt from 1 to 4
refresh intervals *including fractional ones*:

| | mount 0.11 | attitude cascade | anchor 0.55 |
|---|---|---|---|
| as-is | 23.85 ms | 43.79 ms | 24.81 ms |
| midpoint target | 1.48 | 6.21 | 0.39 |
| sub-step 1/120 | 1.26 | 2.50 | 1.16 |
| **sub-step 1/240** | **0.33** | **0.69** | **0.31** |

`ShipFrame.substep` is a writable field rather than a constant so a probe can set
it huge, collapse the loop to one step of the whole frame, and measure before and
after in the same page load.

### The decisive ablation: both terms raw, and the mounted mode is clean

| ablation | mode | dY | dX | dZ | \|dpos\|/s |
|---|---|---|---|---|---|
| none | helm | 3.0, 5.3, 3.0 | 5.3-8.4 | 25-27 | 0.36-0.46 |
| `mountPos` AND `smoothQuat` raw | helm | **0.8, 0.8, 0.8** | **0.8** | **1.1-1.5** | 0.064-0.087 |
| `mountPos` AND `smoothQuat` raw | chase | 0.8, 0.8, 1.1 | 0.8-1.1 | 1.5-6.1 | 0.79-2.97 |
| `mountPos` AND `smoothQuat` raw | bowsprit | 60.2 | 67.8 | 64.0 | **0.00000** |

Helm falls to **0.8% on all three axes** — the controls' floor — with the same
irregular clock, the same environment and the same empty input trace. So the
whole of §85a's defect is carried by those two terms and nothing else in the
pipeline: not collision (off in these modes), not the water clamp
(`waterClearance = -50`), not update ordering, not the anatomy, not the rig's
output filter (zero here), not `heaveResidual`.

`bowsprit` in the same cell is the instrument's own warning label. Its eye is
*exactly* `smoothQuat * L + mountPos` and nothing else, so with both terms raw it
is perfectly rigid: `|dpos|/s` is **0.00000** and the reversal rate reads 60-68%,
which is what a sign statistic does to pure rounding noise. **A reversal rate is
meaningless without its magnitude.** Helm reads 0.8% in the same cell only
because its bob and sway still supply real motion.

### Commit hygiene: I made the mistake AGENTS.md warns about

`12991da`, labelled `docs(camera):`, also carries the first 150 lines of the
`ShipFrame` sub-stepping implementation. Cause: `git add src/camera/ShipFrame.ts`
earlier in the session left the path staged, and a later bare `git commit` for
the note swept it in. The remainder landed properly in `c370272`
`fix(camera): ...`, so **anyone bisecting this fix has to include `12991da`.**
Not rewritten: `main` has several sessions committing to it concurrently
(`fc15f7b`, `206218a` land between my own), and rewriting a shared tip to tidy a
label is a worse trade than the label. Every commit here now passes an explicit
`--` pathspec.

### Operational note for whoever runs this next

`.tmp/jitterrel.mjs` and the first version of `.tmp/jitter2.mjs` waited 120 s for
`window.__leeward`. On a box with five other agents rendering, boot at 1600x900
exceeded that and the job died with a bare `TimeoutError` after fifteen minutes of
apparently-running silence. Raised to 420 s. A smoke test at 400x300 booted fine
in the same minute, so a short boot timeout will mislead you about whether the
page is broken.

Also, right now the page throws `TypeError: Cannot read properties of null
(reading 'flip')` from `MeshBuilder.grid` via `buildBulwarks` in
`src/ship/build/hull.ts` — a ship session's uncommitted work in progress, and the
reason `npm run typecheck` currently reports one error, in that file only. It
breaks the bulwark GEOMETRY, not `world.ship.position/quaternion`, so the jitter
statistic is unaffected; but it does explain the black block in a bowsprit
screenshot taken tonight.
