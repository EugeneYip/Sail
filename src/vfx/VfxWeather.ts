import type { Module, World } from '../types';
import { Ordnance } from './Ordnance';
import { Rain } from './Rain';
import type { VfxShared } from './shared';

/**
 * The airborne half of the VFX stack: rain, lens water, powder smoke and the
 * great guns.
 *
 * Runs immediately after `VFX`, reads the context it prepared, and owns the
 * final `particles.end()` so every emitter in the stack contributes to the
 * same pool before it is stepped on the GPU.
 */
export class VfxWeather implements Module {
  readonly name = 'vfx:weather';

  private s: VfxShared;
  private ordnance = new Ordnance();
  private rain = new Rain();
  /**
   * Tracks whether `rain` owns GPU resources. Deliberately not `s.ready`:
   * `VFX.dispose()` clears that flag and modules are walked in registration
   * order, so keying teardown off it would silently leak the rain meshes.
   */
  private inited = false;

  constructor(shared: VfxShared) {
    this.s = shared;
  }

  init(world: World): void {
    // `VFX` is registered first, so its `init` has already built the shared
    // textures and context this depends on.
    if (!this.s.ready) return;
    this.rain.init(world, this.s.tex);
    this.inited = true;
  }

  update(world: World): void {
    const s = this.s;
    if (!s.ready) return;
    const ctx = s.ctx;
    const st = world.settings.debug ? world.stats : null;
    let t = st ? performance.now() : 0;
    let n = 0;

    this.rain.update(ctx, s.particles, s.probe, s.wake);
    if (st) { n = performance.now(); st['vfx:rain'] = n - t; t = n; }

    this.ordnance.update(ctx, s.particles, s.probe, s.wake);
    if (st) { n = performance.now(); st['vfx:ord'] = n - t; t = n; }

    s.particles.end(ctx, s.probe);
    if (st) { n = performance.now(); st['vfx:pool'] = n - t; }
  }

  applySettings(world: World): void {
    if (!this.inited) return;
    this.rain.applySettings(world, this.s.tex);
  }

  dispose(): void {
    if (!this.inited) return;
    this.rain.dispose();
    this.inited = false;
  }
}
