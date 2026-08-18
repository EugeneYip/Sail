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
 *   ShipDynamics.ts the substepped 6-DOF solver, controls, state publishing
 *
 * PUBLISHED — `world.ext.physics`, see `PhysicsExt` in ShipDynamics.ts.
 * Diagnostics plus the deterministic-stepping hooks scripts/physics-test.mjs
 * drives. Nothing in the game reads it.
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
 * If you are resuming: run `node scripts/physics-test.mjs` first. If it passes,
 * the solver is intact and whatever you are chasing is elsewhere. Use
 * `--quick` while iterating; the full run uses 240 s settles per data point.
 */
export function createPhysicsModules(): Module[] {
  return [new ShipDynamics()];
}
