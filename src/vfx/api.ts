import type * as THREE from 'three';

/**
 * The contract published on `world.ext.vfx`. Allocated once in `VFX.init` and
 * never replaced — consumers may cache the reference, and every texture,
 * matrix and vector is mutated in place.
 *
 * See the header of `src/vfx/index.ts` for the channel layout and the exact
 * sampling convention. Read it before wiring this into the ocean shader.
 */
export interface VfxExt {
  /* ---- persistent world-space wake field ---- */

  /**
   * RGBA16F, `RepeatWrapping`, linear filtered.
   *   R = foam coverage 0..1   (persistent; decays with a wind-dependent tau)
   *   G = surface elevation, metres, signed (~ -0.6 .. +0.6)
   *   B = d(elevation)/dx, world X
   *   A = d(elevation)/dz, world Z
   */
  wakeTexture: THREE.Texture;
  /** `uv = fract((wakeMatrix * vec3(worldX, worldZ, 1.0)).xy)`. */
  wakeMatrix: THREE.Matrix3;
  /** Metres spanned by the whole wake texture. */
  wakeWorldSize: number;
  /**
   * Global multiplier for the whole field, 0..1. 0 means there is nothing in the
   * buffer yet (before the ship has laid any track) and the consumer may skip
   * the taps entirely. Read it every frame; it is a plain number, not a box.
   */
  wakeStrength: number;
  /**
   * World XZ of the newest end of the track (the bow). Mutated in place.
   *
   * REQUIRED FOR CORRECTNESS, not a convenience. The buffer is a torus, so a
   * point further than `wakeWorldSize` from the track aliases onto it and will
   * sample somebody else's wake — and because the trail is up to ~520 m long and
   * the ribbon up to ~480 m wide, the footprint genuinely does wrap onto the
   * opposite edge of the texture. Fade your contribution out with distance from
   * this point, e.g.
   *
   *     float w = 1.0 - smoothstep(fadeRadius * 0.72, fadeRadius,
   *                                distance(worldPos.xz, centre));
   *
   * Without that fade you get a hard stripe of wake on open water half a
   * kilometre away from the ship.
   */
  centre: THREE.Vector2;
  /** Metres from `centre` beyond which the field must be faded to zero. */
  fadeRadius: number;

  /* ---- fine, single-frame interaction field ---- */

  /**
   * RGBA16F, `ClampToEdgeWrapping`. Same channel layout as `wakeTexture`, but
   * cleared and redrawn every frame from the live ripple pool (rain rings,
   * splashes, cannon shot, bow slams).
   */
  interactionTexture: THREE.Texture;
  /** `uv = (interactionMatrix * vec3(worldX, worldZ, 1.0)).xy`, NOT wrapped. */
  interactionMatrix: THREE.Matrix3;
  interactionWorldSize: number;

  /* ---- injection API ---- */

  /** Permanent additive foam patch in the wake field. `soft` 0 = hard, 1 = feathered. */
  addFoam(x: number, z: number, radius: number, strength: number, soft?: number): void;
  /**
   * Expanding ring ripple in the interaction field.
   * `kind` 0 = raindrop, 1 = heavy impact.
   */
  addRipple(
    x: number,
    z: number,
    strength: number,
    radius: number,
    wavelength: number,
    kind?: number,
  ): void;

  /** Bumped whenever a texture object is reallocated (quality change). */
  version: number;
}

/** Payload of the `vfx:lightning` bus event. */
export interface LightningEvent {
  /** Metres from the camera to the strike. */
  distance: number;
  /** Peak flash intensity, 0..1, already attenuated by distance. */
  intensity: number;
  /** Seconds until the thunder should be heard: `distance / 343`. */
  delay: number;
  /** Number of return strokes in this strike, 1..4. */
  strokes: number;
}
