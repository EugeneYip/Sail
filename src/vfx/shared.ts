import type { VfxCtx } from './Context';
import type { HullWater } from './HullWater';
import type { Particles } from './Particles';
import type { VfxTextures } from './textures';
import type { WakeField } from './WakeField';
import type { WaterProbe } from './WaterProbe';

/**
 * State the vfx modules share. `VFX` builds it in `init` and refreshes `ctx`
 * at the top of every frame; the later vfx modules read it. Everything here is
 * internal to `src/vfx` — the outside world sees only `world.ext.vfx`.
 */
export interface VfxShared {
  ready: boolean;
  ctx: VfxCtx;
  tex: VfxTextures;
  probe: WaterProbe;
  wake: WakeField;
  hull: HullWater;
  particles: Particles;
}

/** Uninitialised placeholder; `VFX.init` fills every field before first use. */
export function createShared(): VfxShared {
  return { ready: false } as unknown as VfxShared;
}
