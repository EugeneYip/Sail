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
 *    ...then FADE IT OUT with distance from `centre` (world XZ of the bow) using
 *    `fadeRadius` (600 m). This is not optional polish — see the `fract` note.
 *
 *      float w = wakeStrength * (1.0 - smoothstep(fadeRadius * 0.72, fadeRadius,
 *                                distance(worldPos.xz, centre)));
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
 *    Foam (R) is persistent: decayed each frame with a tau of 9 s in calm air
 *    down to 4 s in a gale, and topped up with a MAX blend so it saturates
 *    rather than running away.
 *
 *    R IS A COVERAGE FRACTION, NOT AN ALPHA, and that is a contract change worth
 *    reading. It is capped at 0.92, never 1.0. A consumer must treat the value as
 *    the fraction of a pixel that aerated water covers and threshold its OWN
 *    high-frequency field against it — the ocean surface does
 *    `linstep(1 - c - w, 1 - c + w, flattenedNoise)` — because this field spans
 *    1024 m over its texture and therefore carries nothing finer than a metre.
 *    It physically cannot supply near-hull detail; the consumer has to add it.
 *    Amplifying the value and clamping it, which is what the ocean used to do,
 *    turns a coverage of 0.18 into a mean alpha of 0.31 spread over the whole
 *    footprint, and a uniform partial wash bounded by a smooth contour is a flat
 *    pale plate. Elevation and slope (GBA)
 *    are zeroed and fully re-rendered each frame from the ship's track, because
 *    the Kelvin pattern is stationary in the ship's frame — that is what keeps
 *    it crisp and lets it curve correctly through a turn.
 *
 *    RANGES, measured, so a consumer can size its own response:
 *      R  0 .. 0.78   peak only in the froth band hugging the topsides
 *      G  -0.7 .. +0.1 m   and windowed to a few transverse wavelengths astern,
 *                     because a coherent signal further out is not resolved by a
 *                     clipmap ring and point-samples into a hard straight groove
 *      BA -0.3 .. 0.3 slope, same window as G
 *    Beyond roughly 3 lambda astern only R is non-zero: the persistent trail is
 *    a COVERAGE signal, not geometry.
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
 * `world.bus` events actually emitted:
 *   `vfx:cannon`     `{ side, guns }`  — a broadside has begun to roll off.
 *   `vfx:shotSplash` `{ x, z }`        — a round shot has landed.
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
 * funnel smoke; cannon. Particles are depth-soft against arbitrary geometry
 * whenever `world.ext.post.depthTexture` is present — re-latched every frame in
 * `Particles.end`, so a resize or a late-initialising post stack is picked up
 * without a restart.
 *
 * Known gaps:
 *  - **No lightning.** `shaders/rain.ts` carries finished bolt and cloud-glow
 *    shaders and `api.ts` declares a `LightningEvent`, but nothing drives them
 *    and NOTHING EMITS `vfx:lightning`. `src/audio/AudioEngine.ts` already
 *    listens for that event, so thunder is wired to a signal that never fires.
 *  - Rain is a world-space curtain around the camera; it is not occluded by the
 *    sails, so it draws through the rig.
 */
export function createVfxModules(): Module[] {
  const shared = createShared();
  return [new VFX(shared), new VfxWeather(shared)];
}
