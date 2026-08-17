import type { Module } from '../types';
import { ShipDynamics } from './ShipDynamics';

/** Owned by the physics agent. Add internal modules here, in update order. */
export function createPhysicsModules(): Module[] {
  return [new ShipDynamics()];
}
