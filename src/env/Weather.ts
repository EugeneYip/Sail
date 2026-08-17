import * as THREE from 'three';
import type { Module, World } from '../types';
import { beaufortFromSpeed, updateWindVector } from '../core/State';

/**
 * PLACEHOLDER — replaced by the full weather/time-of-day director.
 * Already does enough to keep sun direction and wind coherent.
 */
export class WeatherSystem implements Module {
  readonly name = 'weather';

  init(): void {}

  update(world: World): void {
    const env = world.env;
    const dt = world.time.dt;

    env.timeOfDay = (env.timeOfDay + (dt / 60) * 0.25) % 24;

    // Solar position for latitude/day-of-year.
    const decl = 23.44 * Math.PI / 180 * Math.sin((2 * Math.PI * (env.dayOfYear - 81)) / 365);
    const hourAngle = ((env.timeOfDay - 12) / 12) * Math.PI;
    const lat = (env.latitude * Math.PI) / 180;
    const alt = Math.asin(
      Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(hourAngle),
    );
    const az = Math.atan2(
      -Math.sin(hourAngle) * Math.cos(decl),
      Math.cos(lat) * Math.sin(decl) - Math.sin(lat) * Math.cos(decl) * Math.cos(hourAngle),
    );
    env.sunDirection
      .set(Math.sin(az) * Math.cos(alt), Math.sin(alt), -Math.cos(az) * Math.cos(alt))
      .normalize();
    env.moonDirection.copy(env.sunDirection).negate();

    env.gust = 1 + Math.sin(world.time.elapsed * 0.31) * 0.09 + Math.sin(world.time.elapsed * 0.077) * 0.06;
    env.beaufort = beaufortFromSpeed(env.windSpeed);
    updateWindVector(env);

    const u = world.uniforms;
    u.uSunDirection.value.copy(env.sunDirection);
    u.uWind.value.copy(env.windVector);
    u.uWindSpeed.value = env.windSpeed * env.gust;
    u.uSunIntensity.value = Math.max(0, env.sunDirection.y) * 14;
    u.uVisibility.value = env.visibility;
    u.uWetness.value = THREE.MathUtils.lerp(u.uWetness.value, env.rain, dt * 0.25);
  }
}
