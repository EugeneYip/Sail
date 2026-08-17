import type { Module } from '../types';
import { WeatherSystem } from './Weather';

/** Owned by the weather/time-of-day agent. Add internal modules in update order. */
export function createEnvModules(): Module[] {
  return [new WeatherSystem()];
}
