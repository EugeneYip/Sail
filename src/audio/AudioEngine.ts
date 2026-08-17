import type { Module, World } from '../types';

/** PLACEHOLDER — replaced by the procedural audio bed. */
export class AudioEngine implements Module {
  readonly name = 'audio';
  init(_world: World): void {}
  update(_world: World): void {}
}
