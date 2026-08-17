import type { Module } from '../types';
import { UiLayer } from './UiLayer';

/** Owned by the UI agent. Add internal modules here, in update order. */
export function createUiModules(): Module[] {
  return [new UiLayer()];
}
