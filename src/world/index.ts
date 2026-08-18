/**
 * Land. Owned by the world agent.
 *
 * PROGRESS
 *   step 1 — streaming islands wired: gen.worker -> HeightField -> instanced
 *            CDLOD terrain + shore shell. `capture:focusIsland` drops a
 *            deterministic volcanic island 2.9 km off the bow.
 *   step 2 — deterministic 9 km site lattice with hysteresis, droplet erosion +
 *            D8 flow accumulation in the worker, archetype blending.
 *   step 3 — shoreline: wet-sand band, shallow-water absorption, refracted
 *            seabed with caustics, windward breaker line, aerial perspective.
 *   step 4 — foliage (`Props.ts`) and landmarks (`Landmarks.ts`).
 *
 * `world.ext.world` is documented in `api.ts` (`WorldExt`).
 */

import type { Module } from '../types';
import { WorldSystem } from './WorldSystem';

export function createWorldModules(): Module[] {
  return [new WorldSystem()];
}
