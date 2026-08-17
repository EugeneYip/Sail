import type { Module, World } from '../types';

/** PLACEHOLDER — replaced by wake, spray, rain, mist, birds. */
export class VFX implements Module {
  readonly name = 'vfx';
  init(_world: World): void {}
  update(_world: World): void {}
}
