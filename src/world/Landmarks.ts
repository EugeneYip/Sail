import type { World } from '../types';
import type { WorldLandmark } from './api';
import type { Island } from './Island';
import type { WorldResources } from './Resources';

/** Lighthouses, villages, forts, ruins, wrecks. */
export class WorldLandmarks {
  readonly list: WorldLandmark[] = [];
  private resources: WorldResources;

  constructor(resources: WorldResources) {
    this.resources = resources;
  }

  update(_world: World, _islands: Map<number, Island>, _camX: number, _camZ: number): void {}
  release(_island: Island): void {}
  dispose(): void {
    void this.resources;
  }
}
