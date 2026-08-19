import type { Module } from '../types';
import { ShipDynamics } from './ShipDynamics';

/**
 * Physics. Owned by the physics agent.
 *
 * ShipDynamics is a single module by design: buoyancy, aero and hydro forces
 * all have to be summed into one wrench before a single integration step, so
 * splitting them across `Module`s would mean either three integrations per
 * frame or a shared mutable wrench on the blackboard. The pieces live in
 * separate files instead:
 *
 *   constants.ts    every physical figure, with its provenance
 *   Hull.ts         parametric hull -> 140 panels, mass properties, measured
 *                   hydrostatics (GM, GZ curve, roll period)
 *   Wrench.ts       force/torque accumulator + pose, allocation-free
 *   Body.ts         pose algebra: Rodrigues integration, heel/pitch/heading
 *   Hydro.ts        panel pressure integral, resistance, leeway, rudder, damping
 *   Rig.ts          rig geometry + thin-membrane aerofoil curves, luff, trim
 *   Aero.ts         per-sail aerodynamics, boundary layer, blanketing
 *   Trim.ts         the watch on deck: how much canvas, where the yards go
 *   Assist.ts       the arcade handling layer: two forces, five relaxed hull
 *                   coefficients, faster hands. ON by default.
 *   ShipDynamics.ts the substepped 6-DOF solver, controls, state publishing
 *
 * PUBLISHED — `world.ext.physics`, see `PhysicsExt` in ShipDynamics.ts.
 * Diagnostics plus the deterministic-stepping hooks scripts/physics-test.mjs
 * drives.
 *
 * FOR THE UI AGENT — the handling mode and everything you need to show it:
 *
 *   world.settings.assist        boolean, DEFAULT TRUE. This is the toggle.
 *                                Own it from the UI side; write it whenever you
 *                                like and the solver picks it up on the next
 *                                frame, at any speed, without a hitch. `false`
 *                                is Pro mode: the measured ship, 12.8 kn, 69 deg
 *                                off the wind, in irons if you point higher.
 *   world.settings.hudMode       'minimal' | 'pro', yours entirely; physics
 *                                never reads it. Mirror it onto `assist` if you
 *                                want one switch to drive both.
 *   world.ext.physics.assist     the same flag read back off the solver, and
 *                                writable — the setter also writes
 *                                `world.settings.assist`, so both ends agree
 *                                whichever one you poke.
 *   world.ext.physics.throttle   0..1, canvas the player has ORDERED. This is
 *                                what the up/down arrows move and the only
 *                                sail-handling number a minimal HUD needs; the
 *                                watch does the rest. `world.ship.sailArea` is
 *                                the m^2 actually drawing if you want that too.
 *   .assistTopKnots              the assist speed ceiling in knots, for a
 *                                speed dial that should not end at hull speed.
 *   .assistDrive / .assistTurn   the assist force and moment applied last
 *                                substep, N and N*m, both 0 in Pro. Debug only.
 *
 * `world.ship` is unchanged and is still the right place for a HUD to read
 * speedKnots, heading, heel, pitch, rudder, pointOfSail, inIrons and sailArea.
 * `inIrons` is simply never true in assist, because the condition cannot arise.
 *
 * MEASURED — `node scripts/physics-test.mjs`, all green. 10 m/s true wind, flat
 * sea, full press of sail unless stated:
 *
 *   TWA     50    60    65    70    80    90   110   140   175
 *   knots  irons irons irons  5.5   7.8   9.5  10.9  10.1   6.1
 *   heel     -     -     -   11.4  12.2  12.3   8.8   1.1   0.7
 *   leeway   -     -     -    8.7   4.8   3.1   1.6   0.3   0.1
 *
 *   closest track she can make good        69-76 deg off the true wind
 *   top speed, any wind up to 34 m/s       12.8 kn (13.4 kn surfing in a gale)
 *   speed gained from 10 -> 34 m/s wind    +2.0 kn — the wall is real
 *   free-decay roll period                 9.3 s, 8 cycles from 20 deg
 *   roll decrement                         0.59 per cycle, lightly damped
 *   heel at 5 sails, 8/13/18/24 m/s        2.8 / 7.2 / 13.1 / 18.3 deg
 *   canvas she carries at 34 m/s           700 m^2, storm canvas, 12.8 kn
 *   30 fps vs 144 fps after 150 s          0.007 kn, 0.001 deg apart
 *   10 simulated minutes of gale           no NaN, peak heel 39 deg
 *   peak bow acceleration, storm sea       5-8 m/s^2 (VFX triggers at 5.4)
 *   solver cost                            0.09-0.16 ms per 60 fps frame
 *
 * PROGRESS
 *   Session 4 — solver landed and verified.
 *     Hull/Rig/Aero/Hydro were already built and are reused. Added Body.ts,
 *     Trim.ts, the real ShipDynamics.ts and scripts/physics-test.mjs. Four
 *     things had to change in the existing files, all of them bugs:
 *       - constants.ts never exported four constants Hydro.ts imported.
 *       - Hydro's scratch WaveSample used plain objects, so `IOcean.sample`
 *         threw on `normal.set` the first time the real ocean was queried.
 *       - Hydro applied the world-vertical buoyancy using a COLUMN of the pose
 *         matrix where it needed a ROW. That mirrors the force athwartships and
 *         adds ~4x spurious roll stiffness: the roll period measured 3.9 s.
 *       - `RigAero` computed `sail.luff` but never let it affect the force, so
 *         a shivering sail still drove the ship and she pointed like a sloop.
 *     Fixing the roll bug invalidated the tuning of everything the small heel
 *     had been masking, so YAW_FROM_HEEL, CY_LIFT, CLR_DRIFT_SHIFT, the roll
 *     damping and the sail drag were all re-measured against the test.
 *
 * ASSIST — `node scripts/assist-test.mjs`, the playability suite. Same solver,
 * same stepper, `px.assist = true`. 10 m/s true wind, flat sea, full press:
 *
 *   TWA       0    20    45    70    90   120   150   180
 *   knots  7.34  8.14 10.70 13.66 15.07 15.72 15.00 14.30
 *   VMG    7.33  7.61  7.34  4.51 -0.01 -7.76 -13.0 -14.3
 *
 * A broad reach is still her best point of sail and beating is still less than
 * half of it, so the point of sail still matters to the player — but TWA 0 makes
 * 7.3 kn instead of stopping dead, which is the no-go zone gone. She is never
 * flagged `inIrons` in assist, because the condition cannot arise.
 *
 * Playability, measured: 90 per cent of cruising speed in 11.2 s (Pro takes
 * 179 s), a steady turn of 4.6 deg/s against Pro's 0.41, 90 deg of heading in
 * 22.9 s against Pro's 73, 85 per cent of her speed kept through 90 deg of
 * bearing away, a radius of 1.7 ship lengths, and 90 deg of turn available in
 * 30 s from a dead stop under bare poles — Pro cannot turn at all there. In a
 * flat calm she still ghosts at 4.95 kn. Roll period is 9.31 s in BOTH modes, to
 * two decimal places: the assist changes what she will do, never what she weighs.
 *
 * DRIVEN, not just measured — `.tmp/drive.mjs` puts real arrow keys into the live
 * page and samples every rendered frame, which is the only way to see the two
 * defects below. On a live 1.8 m sea in 10 m/s of wind, from bare poles and a
 * standstill: 5 kn at 5.2 s, 10 kn at 9.9 s, 90 per cent of 13.9 kn at 13.8 s,
 * with one press of the up arrow and no other input. Hard a-port: the wheel is
 * hard over 1.2 s after the key goes down, 1 deg/s of yaw at 1.7 s, 90 deg of
 * heading at 23.9 s, a steady 4.7 deg/s, a radius of 1.9 lengths, and 14.2 ->
 * 11.4 -> 12.8 kn through it. Let go and she steadies on the new course with
 * under 2 deg/s of residual swing. Held dead upwind she sits at TWA -10..9 doing
 * 5.9-7.3 kn indefinitely, never in irons, never below 5.9 kn. A storm sea gives
 * heel -27..+22 deg, pitch -8..+6 deg, heave -6.2..+5.9 m and a 9.6 s roll: she
 * still weighs 2200 tonnes. Pro, driven with the same keys in the same weather,
 * never reaches 5 kn in 30 s (top 1.7) and turns 1 deg in 25 s of hard over.
 *
 * The two suites cannot both be right about the same numbers, and that is
 * deliberate: `physics-test.mjs` measures Pro, `assist-test.mjs` measures the
 * default. `px.reset()` always lands in Pro, so the Pro suite never has to know
 * the assist exists.
 *
 * TWO DEFECTS THAT ONLY DRIVING FOUND, and they were masking each other:
 *
 *   1. THE WATCH STRUCK THE RIG ON EVERY TURN. `Trim`'s second reefing rule
 *      shortens sail when the rudder is held past 70 per cent of hard over, on
 *      the reasoning that a pinned rudder means the after sails are overpowering
 *      the helm. But in assist the player turns by HOLDING the arrow key, so the
 *      rudder sits at hard over for the whole turn: 25 s on the helm took her
 *      from 16 sails to storm canvas, cost 5.5 kn, and then wanted 100 s at
 *      RESET_RATE to shake out again. Fixed by gating the rule on whether she is
 *      actually answering — a signed, low-passed yaw rate. Pro's 0.41 deg/s with
 *      the wheel hard over is still "will not steer" and still reefs; the
 *      assist's 4.6 deg/s is a player turning. Fixing it also bought 15 points of
 *      speed kept through a turn (70 -> 85 per cent) and lifted the slowest
 *      moment of a hard circle from 5.8 to 7.0 kn.
 *
 *   2. `input.sailTrim` NEVER REACHED ZERO. It is an exponential approach, so one
 *      second after the up arrow comes up it is 3.6e-6, after six seconds 1.4e-40,
 *      and it then sits on the smallest denormal for the rest of the session.
 *      `Trim.update` read `cmd !== 0` as "the player has a hand on the throttle"
 *      and pinned the reef cap wide open, so after any press of the up arrow the
 *      watch could not shorten sail at all. That is what hid defect 1 from the
 *      driving trace: the throttle residual had disabled the reefing that would
 *      otherwise have wrecked the turn. Fixed at the root in `input/Input.ts`
 *      (`approach()` now snaps its last 1e-4) with a deadband in `Trim` as well,
 *      so nothing here depends on another module's epsilon.
 *
 * Neither suite could see either one: both drive `w.input.steer` and
 * `w.input.sailTrim` directly, so neither ever exercised the input smoothing, and
 * neither watched `px.sailLevel` during a turn. `assist-test.mjs` now asserts
 * that 30 s of hard-over helm leaves the rig standing.
 *
 * TEST ISOLATION — two defects were found here, both in the HARNESS, neither in
 * the solver. Do not re-chase them:
 *
 *   1. RIG STATE SURVIVED A RESET. `px.reset()` restored the pose but not the
 *      yards, so a case inherited the braces the previous case left. The 30-vs-
 *      144 fps determinism case therefore compared a run that started from a
 *      stale rig against one that started from a correctly trimmed one, and read
 *      as a frame-rate bug. It was not: with the same dt run twice back to back
 *      the two runs disagreed just as much. Fixed by `SailTrim.reset()`, called
 *      from `ShipDynamics.reset()`, which braces every yard to the trim the
 *      current apparent wind calls for. `run()` is now a pure function of
 *      (pose, rig, weather, dt) — the same dt twice is bit-identical, and 30 vs
 *      144 fps agree to 0.0001 kn. Frame-rate independence was never broken.
 *
 *   2. THE GALE CASE MEASURED THE SEA, NOT THE SHIP. `run()` steps the solver but
 *      never ticks the ocean, so a 600 s gale sails one frozen wave snapshot, and
 *      which snapshot you get depends on how long the preceding tests took. With
 *      the ship held bit-identical, peak heel spans 30-62 deg and peak speed
 *      11.5-16.5 kn across snapshots; two back-to-back runs of the suite gave
 *      62.1 deg (fail) and 31.2 deg (pass) off one commit. The harness now
 *      samples five phases and asserts on the median with a loose bound on the
 *      worst draw. The sim clock is not reachable from a test — `Ocean.cpu` is
 *      private and neither `IOcean` nor `world.ext.ocean` exposes it — so this
 *      cannot be fixed properly without a small addition to `src/ocean`.
 *
 * If you are resuming: run `node scripts/physics-test.mjs` first. If it passes,
 * the solver is intact and whatever you are chasing is elsewhere. Use
 * `--quick` while iterating; the full run uses 240 s settles per data point.
 */
export function createPhysicsModules(): Module[] {
  return [new ShipDynamics()];
}
