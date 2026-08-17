import * as THREE from 'three';
import type { SimView } from './Sim';

/**
 * Where sounds live on the ship, in ship-local metres (+X starboard, +Y up,
 * -Z forward). Scaled to the real Constitution: 53.3 m hull, 67 m mainmast.
 */
export const ANCHOR = {
  bow: [0, 1.5, -25] as const,
  bowsprit: [0, 5, -34] as const,
  deck: [0, 4.5, -2] as const,
  wheel: [0, 4.8, 15] as const,
  stern: [0, 3.5, 24] as const,
  belfry: [1.2, 6.5, -13] as const,
  mastFore: [0, 33, -13] as const,
  mastMain: [0, 40, 1] as const,
  mastMizzen: [0, 29, 14] as const,
  wake: [0, 0.2, 42] as const,
  hullPort: [-6.6, 0.5, -6] as const,
  hullStbd: [6.6, 0.5, -6] as const,
};

const scratch = new THREE.Vector3();

/**
 * Ship-local -> world. Returns a shared scratch vector: read it immediately,
 * never store it.
 */
export function toWorld(sim: SimView, x: number, y: number, z: number): THREE.Vector3 {
  return scratch.set(x, y, z).applyQuaternion(sim.shipQuat).add(sim.shipPos);
}

export function anchorWorld(sim: SimView, a: readonly [number, number, number]): THREE.Vector3 {
  return toWorld(sim, a[0], a[1], a[2]);
}
