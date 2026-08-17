import type { Module } from '../types';
import { Ocean } from './Ocean';

/** Owned by the ocean agent. Add internal modules here, in update order. */
export function createOceanModules(): Module[] {
  return [new Ocean()];
}
