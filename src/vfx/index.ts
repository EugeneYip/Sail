import type { Module } from '../types';
import { VFX } from './VFX';

/** Owned by the vfx agent. Add internal modules here, in update order. */
export function createVfxModules(): Module[] {
  return [new VFX()];
}
