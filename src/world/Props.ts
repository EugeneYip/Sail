import type { World } from '../types';
import type { Island } from './Island';
import type { WorldResources } from './Resources';

/** Instanced vegetation. Filled in by the foliage pass; see `Foliage.ts`. */
export class WorldProps {
  liveInstances = 0;
  private resources: WorldResources;

  constructor(resources: WorldResources) {
    this.resources = resources;
  }

  warm(_world: World): void {}
  applySettings(_world: World): void {}
  update(_world: World, _islands: Map<number, Island>, _camX: number, _camZ: number, _budgetMs: number): void {}
  release(_island: Island): void {}
  dispose(): void {
    void this.resources;
  }
}
