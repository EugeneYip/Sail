# §89 hull heave chatter: revalidation from scratch

§89's numbers are treated here as LEADS, not evidence. Today produced four
instrument failures — `dt = 0` suppressing shadow-map refresh, sequential arms
drifting in sim time, `castShadow = false` being a semantic no-op under VSM, and the
adaptive-resolution 5.5-code result vanishing under fresh-load controls (§100). §89's
60% figure was measured in a single-load sweep, which is exactly the pattern that
failed twice.

## What must be separated, and not inferred from one another

- **A. physical ship pose** — `ship.position.y`, and pitch/roll from the quaternion.
- **B. rendered hull motion in world space** — the SAME ship-local point pushed
  through the ship pose every frame. Not a fixed world offset: an offset moves under
  rotation and would read hull rotation as translation.
- **C. camera-relative hull motion** — `inverse(camQuat) * (hullWorld - camPos)`.
- **D. camera motion itself.**

## Controls

1. **An analytic smooth signal sampled on the same dt sequence.** `sin(2*pi*t/8)`
   pushed through the identical statistic. A second-difference reversal statistic on
   a smooth trajectory must read near zero; if it does not, the statistic is broken
   rather than the hull. This is free and it bounds the estimator itself.
2. **Load-to-load variance.** §100 measured about 2.8 codes of variance between
   fresh loads with an identical settle, because the procedural cloud and sea state
   do not land in the same phase. The equivalent floor must be established here
   before any hull number is believed.

## Statistic

Reversal rate of the per-frame change in velocity, as §89 used — but reported
alongside **absolute amplitude in metres and m/s**, because a sign statistic cannot
say whether anything is visible. §89 quoted 20x amplitude; that is the claim that
actually matters and it needs re-measuring.

## Method

Fresh page load per arm, identical settle, deterministic env, fixed camera station,
and the dt sequence applied by explicit `eng.tick(t)` stepping. Repeats per arm so
load-to-load variance is measured rather than assumed.

## Log

(append-only, newest last)

### Reproduced, with the estimator validated

Fresh load per arm, 3 repeats each, chase camera, sea state 3. Repeats agreed
closely (shipY reversal 0.8/0.8/0.8% whole, 62.5/63.5/64.2% fract), so load-to-load
variance is small for this statistic.

| channel | whole rev% | whole rmsDv | whole rmsD2 | fract rev% | fract rmsDv | fract rmsD2 |
|---|---|---|---|---|---|---|
| shipY | 0.8 | 1.82e-2 | 1.32e-2 | **63.4** | **2.04e-1** | 1.40e-2 |
| pitch | 1.4 | 2.68e-4 | 1.95e-4 | 63.4 | 2.65e-3 | 1.81e-4 |
| roll | 1.3 | 5.20e-4 | 3.66e-4 | 65.3 | 5.21e-3 | 3.56e-4 |
| bowY (local point through the pose) | 0.8 | 2.14e-2 | 1.54e-2 | 64.9 | 2.25e-1 | 1.55e-2 |
| camRelY | 57.9 | 1.44 | 3.87e-2 | 58.0 | 1.48 | 4.01e-2 |
| camY | 6.5 | 8.80e-3 | 7.10e-3 | 6.4 | 9.11e-3 | 6.84e-3 |
| **analytic CONTROL** | **0.5** | **1.20e-2** | 1.25e-2 | **0.5** | **1.14e-2** | 1.15e-2 |

**The control validates the statistic.** On a smooth analytic signal sampled on the
same irregular clock, neither the reversal rate nor `rmsDv` rises (0.5% both, 1.20e-2
to 1.14e-2). On the hull both explode. So §89's effect is real and is not an artefact
of the estimator.

**It is in the hull's own pose, not the camera.** Channels A and B (shipY, pitch,
roll, and a ship-local point pushed through the pose) all move together; `camY` is
flat across clocks (6.5% / 6.4%, rmsDv 8.8e-3 / 9.1e-3) and `camRelY` is identical
on both clocks, so the camera neither causes nor amplifies it.

### But the positional amplitude is millimetric

`rmsD2` — the second difference of POSITION, in metres — is 1.32e-2 whole against
1.40e-2 fract for shipY, and 1.54e-2 against 1.55e-2 for the bow. Essentially
unchanged. The analytic control's own `rmsD2` is 1.15-1.25e-2, i.e. the same order:
on unevenly spaced samples the plain second difference is dominated by the dt
variation times velocity, not by curvature, which is exactly why the control is
needed to read it.

Subtracting the control in quadrature, the hull's positional excess is about
**4 mm on the whole clock and 8 mm on the fractional one**.

**§89 quoted "20x amplitude" from `rmsDv` (0.0213 to 0.43 m/s) and called the defect
player-visible in every view. `rmsDv` is a velocity-change statistic; it is not an
amplitude.** Whether 8 mm of positional excess is visible is a separate question and
is measured next, in pixels.
