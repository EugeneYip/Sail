import type { Module } from '../types';
import { HUD } from './HUD';

/** Owned by the UI agent. Add internal modules here, in update order. */
export function createUiModules(): Module[] {
  return [new HUD()];
}
