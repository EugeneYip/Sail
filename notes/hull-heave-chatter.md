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
