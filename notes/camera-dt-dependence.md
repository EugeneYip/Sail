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
