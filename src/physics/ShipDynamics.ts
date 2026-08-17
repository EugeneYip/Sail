import * as THREE from 'three';
import type { Module, World } from '../types';
import { createWaveSample } from '../ocean/Ocean';

/** PLACEHOLDER — replaced by full 6-DOF buoyancy + aero/hydrodynamics. */
export class ShipDynamics implements Module {
  readonly name = 'physics';
  private sample = createWaveSample();

  init(): void {}

  update(world: World): void {
    const { ship, env, input, time } = world;
    const dt = time.dt;
    if (dt <= 0) return;

    ship.rudderTarget = input.steer * 0.6;
    ship.rudder += (ship.rudderTarget - ship.rudder) * Math.min(1, dt * 2.2);

    ship.heading -= ship.rudder * 0.22 * dt * Math.min(1, ship.speedKnots / 4);
    const fwd = new THREE.Vector3(Math.sin(ship.heading), 0, -Math.cos(ship.heading));

    // Crude thrust from the wind so there is motion to look at.
    const rel = Math.cos(ship.heading - (env.windBearing + Math.PI));
    const target = THREE.MathUtils.clamp(env.windSpeed * 0.42 * (0.35 + 0.65 * Math.abs(rel)), 0, 7);
    const speed = ship.velocity.length();
    const newSpeed = speed + (target - speed) * Math.min(1, dt * 0.25);
    ship.velocity.copy(fwd).multiplyScalar(newSpeed);
    ship.position.addScaledVector(ship.velocity, dt);

    const ocean = world.ocean;
    if (ocean) {
      ocean.sample(ship.position.x, ship.position.z, this.sample);
      ship.position.y = this.sample.height;
    }

    ship.heel = -Math.sin(ship.heading - env.windBearing) * 0.14;
    ship.pitch = Math.sin(time.elapsed * 0.7) * 0.02;
    ship.speedKnots = newSpeed * 1.94384;

    const e = new THREE.Euler(ship.pitch, ship.heading, ship.heel, 'YXZ');
    ship.quaternion.setFromEuler(e);

    ship.apparentWindSpeed = env.windSpeed;
    ship.apparentWindAngle = wrapPi(env.windBearing + Math.PI - ship.heading);
  }
}

function wrapPi(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}
