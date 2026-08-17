import type { Module } from '../types';
import { Sky } from './Sky';

/** Owned by the sky agent. Add internal modules here, in update order. */
export function createSkyModules(): Module[] {
  return [new Sky()];
}
