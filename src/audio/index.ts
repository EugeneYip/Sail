/**
 * Owned by the audio agent. Add internal modules here, in update order.
 *
 * Everything is synthesised at runtime — there is not one audio file in the
 * build. Four noise beds and four impulse responses are generated into
 * `AudioBuffer`s at start-up (`Buffers.ts`) and every sound in the game is
 * filtering, enveloping and resonance applied to those.
 *
 * Layout:
 *   AudioEngine  the `Module`. Owns the context, autoplay, visibility, and
 *                publishes `world.ext.audio` (see `AudioExt`).
 *   Sim          flattens `World` into a `SimView` snapshot. The graph never
 *                sees `World`, which is what lets the probe rebuild it offline.
 *   Rig          assembles the whole graph against any `BaseAudioContext`.
 *   Buses        per-source -> family -> master, the output ceiling, and the
 *                three procedural reverb spaces.
 *   Voices       pooled one-shots. Nothing allocates a node after `Rig.build`.
 *   Sea Wind Rig(ging) ShipSounds Weather Wildlife Music Bell
 *                the sound families, each driven from the `SimView`.
 *   Probe        offline render + FFT analysis for scripts/audio-test.mjs.
 *
 * STATUS: complete and wired. Sea, wind, rigging worklet, hull, ship, weather,
 * wildlife, music and bell all run off the blackboard. Verified by
 * `node scripts/audio-test.mjs`. Known gaps are listed at the end of that file.
 */

import type { Module } from '../types';
import { AudioEngine } from './AudioEngine';

export function createAudioModules(): Module[] {
  return [new AudioEngine()];
}

export type { AudioExt, AudioStatus, CensusResult } from './AudioEngine';
export type { ProbeOptions, ProbeResult } from './Probe';
