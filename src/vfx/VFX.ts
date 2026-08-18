import type { Module, QualityTier, World } from '../types';
import type { VfxExt } from './api';
import { createCtx, updateCtx } from './Context';
import { HullWater } from './HullWater';
import { Particles } from './Particles';
import type { VfxShared } from './shared';
import { Spray } from './Spray';
import { createVfxTextures } from './textures';
import { WAKE_FADE_RADIUS, WAKE_WORLD_SIZE, WakeField } from './WakeField';
import { WaterProbe } from './WaterProbe';

/** Probe grid resolution per tier. Each cell costs one `ocean.sampleHeight`. */
function probeRes(q: QualityTier): number {
  return q === 'low' ? 24 : q === 'medium' ? 32 : q === 'high' ? 40 : 48;
}
const PROBE_WORLD_SIZE = 210;

/**
 * The water half of the VFX stack: the persistent world-space wake field, the
 * hull's own bow / quarter / transom water, and every spray particle.
 *
 * Runs first among the vfx modules and refreshes the shared context the later
 * ones read.
 */
export class VFX implements Module {
  readonly name = 'vfx';

  private s: VfxShared;
  private spray = new Spray();
  private ext!: VfxExt;

  constructor(shared: VfxShared) {
    this.s = shared;
  }

  init(world: World): void {
    const s = this.s;
    s.tex = createVfxTextures();
    s.ctx = createCtx(world);
    s.probe = new WaterProbe(probeRes(world.settings.quality), PROBE_WORLD_SIZE);
    s.wake = new WakeField();
    s.hull = new HullWater();
    s.particles = new Particles();

    s.probe.update(world);
    s.wake.init(world, s.tex.foam);
    s.hull.init(world, s.tex.foam);
    s.particles.init(world, s.tex, s.probe);

    const wake = s.wake;
    this.ext = {
      wakeTexture: wake.target.texture,
      wakeMatrix: wake.matrix,
      wakeWorldSize: WAKE_WORLD_SIZE,
      wakeStrength: 0,
      centre: wake.centre,
      fadeRadius: WAKE_FADE_RADIUS,
      interactionTexture: wake.interaction.texture,
      interactionMatrix: wake.interactionMatrix,
      interactionWorldSize: wake.interactionWorldSize,
      addFoam: (x, z, r, str, soft) => wake.addFoam(x, z, r, str, soft),
      addRipple: (x, z, str, r, wl, kind) => wake.addRipple(x, z, str, r, wl, kind),
      version: 1,
    };
    world.ext.vfx = this.ext;
    s.ready = true;
  }

  update(world: World): void {
    const s = this.s;
    if (!s.ready) return;
    const ctx = s.ctx;
    // Sub-attribution, debug only. Written explicitly rather than through a
    // closure because `update` must not allocate.
    const st = world.settings.debug ? world.stats : null;
    let t = st ? performance.now() : 0;
    let n = 0;

    updateCtx(ctx);
    s.probe.update(world);
    if (st) { n = performance.now(); st['vfx:probe'] = n - t; t = n; }

    s.wake.update(ctx);
    this.ext.wakeStrength = s.wake.strength;
    if (st) { n = performance.now(); st['vfx:wake'] = n - t; t = n; }

    s.hull.update(ctx, s.probe);
    if (st) { n = performance.now(); st['vfx:hull'] = n - t; t = n; }

    s.particles.begin(ctx);
    this.spray.update(ctx, s.particles, s.probe, s.wake);
    if (st) { n = performance.now(); st['vfx:spray'] = n - t; }
    // `end` is deferred to the last vfx module so rain, smoke and ordnance can
    // all emit into the same pool before it is stepped.
  }

  applySettings(world: World): void {
    const s = this.s;
    if (!s.ready) return;
    s.wake.applySettings(world);
    s.hull.applySettings();
    s.particles.applySettings(world, s.tex, s.probe);
    this.ext.wakeTexture = s.wake.target.texture;
    this.ext.interactionTexture = s.wake.interaction.texture;
    this.ext.version++;
  }

  dispose(): void {
    const s = this.s;
    if (!s.ready) return;
    s.particles.dispose();
    s.hull.dispose();
    s.wake.dispose();
    s.probe.dispose();
    s.tex.dispose();
    s.ready = false;
  }
}
