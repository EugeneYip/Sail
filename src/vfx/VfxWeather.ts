import type { Module, World } from '../types';
import { Ordnance } from './Ordnance';
import type { VfxShared } from './shared';

/**
 * The airborne half of the VFX stack: rain, lightning, lens water, powder
 * smoke and the great guns.
 *
 * Runs immediately after `VFX`, reads the context it prepared, and owns the
 * final `particles.end()` so every emitter in the stack contributes to the
 * same pool before it is stepped on the GPU.
 */
export class VfxWeather implements Module {
  readonly name = 'vfx:weather';

  private s: VfxShared;
  private ordnance = new Ordnance();

  constructor(shared: VfxShared) {
    this.s = shared;
  }

  init(_world: World): void {}

  update(_world: World): void {
    const s = this.s;
    if (!s.ready) return;
    const ctx = s.ctx;

    this.ordnance.update(ctx, s.particles, s.probe, s.wake);

    s.particles.end(ctx, s.probe);
  }

  applySettings(_world: World): void {}

  dispose(): void {}
}
