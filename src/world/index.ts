import type { Module } from '../types';
import { WorldSystem } from './WorldSystem';

/** Owned by the world agent. Add internal modules here, in update order. */
export function createWorldModules(): Module[] {
  return [new WorldSystem()];
}
