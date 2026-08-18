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

  update(world: World): void {
    const s = this.s;
    if (!s.ready) return;
    const ctx = s.ctx;
    const st = world.settings.debug ? world.stats : null;
    let t = st ? performance.now() : 0;
    let n = 0;

    this.ordnance.update(ctx, s.particles, s.probe, s.wake);
    if (st) { n = performance.now(); st['vfx:ord'] = n - t; t = n; }

    s.particles.end(ctx, s.probe);
    if (st) { n = performance.now(); st['vfx:pool'] = n - t; }
  }

  applySettings(_world: World): void {}

  dispose(): void {}
}
