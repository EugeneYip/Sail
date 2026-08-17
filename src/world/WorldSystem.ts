import type { Module, World } from '../types';

/** PLACEHOLDER — replaced by procedural islands, terrain, props, wildlife. */
export class WorldSystem implements Module {
  readonly name = 'world';
  init(_world: World): void {}
  update(_world: World): void {}
}
