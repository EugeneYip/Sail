/**
 * Owned by the ship agent.
 *
 * PROGRESS
 *   [x] hull lofted from dims.ts, three masts, yards, tops, head spars
 *   [x] standing + running rigging, ratlines — one instanced draw call
 *   [ ] sails
 *   [ ] guns, boats, figurehead, flags
 *
 * PUBLISHED — `world.ext.ship`, see `ext.ts` for the full documented shape.
 * Allocated once in `init`, never replaced, every vector mutated in place, all
 * in ship-local metres (+X starboard, +Y up, -Z forward, y = 0 at the LWL):
 *
 *   root            THREE.Object3D   the geometry group inside world.shipRoot
 *   mastTops        Vector3[]        fighting-top platform centres, fore->mizzen
 *   mastTrucks      Vector3[]        the very top of each mast
 *   deckAnchors     Record<string, Vector3>   helm, wheel, binnacle, capstan, bow, waist
 *   bowPosition     Vector3          stem head at the waterline
 *   sternPosition   Vector3          transom at the waterline
 *   hullPoints      Vector3[]        wetted-surface samples for buoyancy
 *   sailMeshes      Mesh[]           one per drawn sail
 *   + the flat numeric camera anatomy (deckY, helmZ, mainTopY, mastheadY, ...)
 *     that `camera/Anatomy.ts` copies, and the vfx spawn frame
 *     (bowLocal, sternLocal, halfBeamAt, gunPortsLocal, gunStarboardLocal).
 */

import type { Module } from '../types';
import { Ship } from './Ship';

export function createShipModules(): Module[] {
  return [new Ship()];
}
