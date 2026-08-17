import type { Module } from '../types';
import { AudioEngine } from './AudioEngine';

/** Owned by the audio agent. Add internal modules here, in update order. */
export function createAudioModules(): Module[] {
  return [new AudioEngine()];
}
