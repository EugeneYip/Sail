import type { Module } from '../types';
import { Ship } from './Ship';

/** Owned by the ship agent. Add internal modules here, in update order. */
export function createShipModules(): Module[] {
  return [new Ship()];
}
