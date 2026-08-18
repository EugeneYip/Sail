import type { Module } from '../types';
import { Ocean } from './Ocean';

/**
 * Owned by the ocean agent. Add internal modules here, in update order.
 *
 * STATUS
 * Wired and rendering: N band-limited FFT cascades (GPU) + a CPU mirror of the
 * same modes for physics + a persistent advected foam buffer, drawn through one
 * camera-centred geometry clipmap. `Ocean` is the only module — the sim is
 * cheap enough that splitting it across the update order would only add
 * ordering hazards.
 *
 * Published on `world.ext.ocean` (see `OceanExt` in `Ocean.ts`).
 * Not yet consumed, because nothing publishes them yet:
 *   `world.ext.vfx`  — wake texture, handled defensively in `Ocean.updateWake`
 *   `world.ext.post` — a depth texture, which is what SSR needs
 */
export function createOceanModules(): Module[] {
  return [new Ocean()];
}
