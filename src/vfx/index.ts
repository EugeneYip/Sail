import type { Module } from '../types';
import { createShared } from './shared';
import { VFX } from './VFX';
import { VfxWeather } from './VfxWeather';

/**
 * Owned by the vfx agent.
 *
 * ==================================================================
 *  `world.ext.vfx` — the wake contract. See `src/vfx/api.ts` for the
 *  TypeScript shape; this is the part a shader author needs.
 * ==================================================================
 *
 * Two render targets are published, both RGBA16F, both with the SAME channel
 * layout:
 *
 *      R = foam coverage, 0..1
 *      G = surface elevation, metres, signed
 *      B = d(elevation)/dx   (world +X)
 *      A = d(elevation)/dz   (world +Z)
 *
 * so the perturbed normal is `normalize(vec3(-B, 1.0, -A))` and the extra
 * vertical displacement to add to the ocean surface is `G`.
 *
 * 1. `wakeTexture` / `wakeMatrix` / `wakeWorldSize` — the persistent field.
 *
 *      vec2 uv = fract((wakeMatrix * vec3(worldPos.xz, 1.0)).xy);
 *      vec4 w  = texture2D(wakeTexture, uv);
 *
 *    NOTE THE `fract`. The texture is a torus in world space: `wakeMatrix` maps
 *    world XZ to texture space with an anchor that only ever moves in whole
 *    multiples of `wakeWorldSize` (1024 m), so the mapping is invariant, the
 *    buffer is never resampled, and a floating-origin shift costs nothing. It
 *    also means a point more than 1024 m from the ship aliases onto the wake —
 *    fade the contribution out well before then (the wake itself is only ~520 m
 *    long, so a `smoothstep` on distance-to-ship, or simply on foam strength,
 *    is enough).
 *
 *    Foam (R) is persistent: decayed each frame with a tau of 22 s in calm air
 *    down to 6.5 s in a gale, and topped up with a MAX blend so it saturates
 *    rather than running away. Elevation and slope (GBA) are zeroed and fully
 *    re-rendered each frame from the ship's track, because the Kelvin pattern
 *    is stationary in the ship's frame — that is what keeps it crisp and lets
 *    it curve correctly through a turn.
 *
 * 2. `interactionTexture` / `interactionMatrix` / `interactionWorldSize` — a
 *    fine 128 m window centred on the camera, cleared and redrawn every frame
 *    from the live ripple pool (rain rings, splashes, bow slams, cannon shot).
 *
 *      vec2 uv = (interactionMatrix * vec3(worldPos.xz, 1.0)).xy;   // no fract
 *      vec4 k  = texture2D(interactionTexture, uv);                 // 0 outside
 *
 * Both matrices are `THREE.Matrix3` objects allocated once and mutated in
 * place, so a material may bind them as a uniform value and never touch them
 * again. `version` bumps if a texture object is ever reallocated (quality
 * change) — re-read `wakeTexture` / `interactionTexture` when it does.
 *
 * Anyone may also inject into the field: `addFoam(x, z, radius, strength)` and
 * `addRipple(x, z, strength, radius, wavelength, kind)`.
 *
 * ==================================================================
 *  Other published signals
 * ==================================================================
 *
 * `world.bus` event `vfx:lightning`, payload `{ distance, intensity, delay,
 * strokes }` — emitted on every strike. `delay` is seconds until the thunder
 * should be heard (`distance / 343`).
 *
 * Keys: `z` fires the port broadside, `x` the starboard broadside.
 *
 * ==================================================================
 *  Progress
 * ==================================================================
 *
 * Done: world-space Kelvin wake field + publication; bow / quarter / transom
 * water and the wetted-hull skirt; GPU particle pool (2 passes + 1 draw) with
 * bow spray, slam bursts, stern wash, wake flecks, spindrift and trough mist;
 * rain streaks, ring ripples, deck splashes, rigging drips and lens rain;
 * lightning (scene flash + forked bolt + cloud glow); funnel smoke; cannon.
 *
 * Known gaps: particles are soft against the water surface and the near plane
 * analytically, but NOT against arbitrary geometry — the post agent does not
 * publish a depth texture yet. The code path exists behind the `VFX_DEPTH_SOFT`
 * define in `shaders/particles.ts`; enable it by publishing
 * `world.ext.post = { depthTexture, near, far }`.
 */
export function createVfxModules(): Module[] {
  const shared = createShared();
  return [new VFX(shared), new VfxWeather(shared)];
}
