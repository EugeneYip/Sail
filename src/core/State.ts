import * as THREE from 'three';
import type { Environment, SailState, ShipState } from '../types';

export function createEnvironment(): Environment {
  const env: Environment = {
    windBearing: THREE.MathUtils.degToRad(300),
    windSpeed: 8.5,
    windVector: new THREE.Vector3(),
    gust: 1,
    beaufort: 4,

    seaState: 3,
    waveHeight: 1.2,
    swellBearing: THREE.MathUtils.degToRad(300),
    choppiness: 0.55,

    timeOfDay: 8.4,
    dayOfYear: 172,
    latitude: 38,
    sunDirection: new THREE.Vector3(0.3, 0.45, -0.84).normalize(),
    moonDirection: new THREE.Vector3(-0.3, -0.45, 0.84).normalize(),
    sunColor: new THREE.Color(1.0, 0.94, 0.86),
    sunIntensity: 10,
    moonIntensity: 0,
    moonPhase: 0.62,

    turbidity: 2.6,
    cloudCover: 0.42,
    cloudType: 0.65,
    rain: 0,
    visibility: 26000,

    weatherLabel: 'Fair — moderate breeze',
  };
  updateWindVector(env);
  return env;
}

/** Derive the travel-direction unit vector from the meteorological bearing. */
export function updateWindVector(env: Environment): void {
  // Wind FROM bearing b blows TOWARD b + PI.
  const t = env.windBearing + Math.PI;
  env.windVector.set(Math.sin(t), 0, -Math.cos(t)).normalize();
}

/** Beaufort force from wind speed in m/s (standard scale boundaries). */
const BEAUFORT_LIMITS = [0.3, 1.6, 3.4, 5.5, 8.0, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7];
export function beaufortFromSpeed(ms: number): number {
  for (let i = 0; i < BEAUFORT_LIMITS.length; i++) if (ms < BEAUFORT_LIMITS[i]) return i;
  return 12;
}

/**
 * USS Constitution — a 44-gun heavy frigate. Real figures:
 *   LOA (incl. bowsprit) 62 m, hull 53.3 m, beam 13.3 m, draught 6.4 m,
 *   displacement 2200 tonnes, ~3968 m^2 of sail on three masts.
 *
 * Sail plan below is the historical one, fore to aft, low to high.
 */
export function createShipState(): ShipState {
  const sails: SailState[] = [
    // Bowsprit / headsails (triangular).
    sail('flying-jib', 'Flying Jib', 3, 3, 78, true),
    sail('outer-jib', 'Outer Jib', 3, 2, 118, true),
    sail('inner-jib', 'Inner Jib', 3, 1, 128, true),
    sail('fore-staysail', 'Fore Staysail', 3, 0, 112, true),
    // Fore mast (square).
    sail('fore-course', 'Fore Course', 0, 0, 310, false),
    sail('fore-topsail', 'Fore Topsail', 0, 1, 300, false),
    sail('fore-topgallant', 'Fore Topgallant', 0, 2, 150, false),
    sail('fore-royal', 'Fore Royal', 0, 3, 84, false),
    // Main mast (square) — the tallest.
    sail('main-course', 'Main Course', 1, 0, 390, false),
    sail('main-topsail', 'Main Topsail', 1, 1, 372, false),
    sail('main-topgallant', 'Main Topgallant', 1, 2, 188, false),
    sail('main-royal', 'Main Royal', 1, 3, 104, false),
    // Mizzen (square topsails + a fore-and-aft spanker).
    sail('mizzen-topsail', 'Mizzen Topsail', 2, 1, 232, false),
    sail('mizzen-topgallant', 'Mizzen Topgallant', 2, 2, 120, false),
    sail('mizzen-royal', 'Mizzen Royal', 2, 3, 66, false),
    sail('spanker', 'Spanker', 2, 0, 244, true),
  ];

  const state: ShipState = {
    position: new THREE.Vector3(0, 0, 0),
    quaternion: new THREE.Quaternion(),
    velocity: new THREE.Vector3(),
    angularVelocity: new THREE.Vector3(),

    speedKnots: 0,
    heading: 0,
    heel: 0,
    pitch: 0,
    leeway: 0,

    apparentWindAngle: 0,
    apparentWindSpeed: 0,
    pointOfSail: 'becalmed',
    inIrons: false,

    rudder: 0,
    rudderTarget: 0,

    sails,
    sailArea: 0,

    bowSlam: 0,
    mass: 2200_000,
    loa: 53.3,
    beam: 13.3,
    draught: 6.4,
  };
  return state;
}

function sail(
  id: string,
  name: string,
  mast: number,
  tier: number,
  area: number,
  triangular: boolean,
): SailState {
  return {
    id,
    name,
    mast,
    tier,
    set: 1,
    brace: 0,
    area,
    luff: 0,
    force: 0,
    camber: 0.35,
    triangular,
  };
}
