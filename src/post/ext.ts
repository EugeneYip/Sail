import type * as THREE from 'three';

/**
 * Published on `world.ext.post`. Allocated once and mutated in place, so a
 * consumer may cache the reference.
 *
 * `depthTexture` is a standalone R32F COPY of the scene depth attachment:
 * non-linear window-space depth over `near`..`far`, sampled as `.r` exactly
 * like a DepthTexture. It is deliberately not the attachment itself — a
 * material that samples the live attachment while the scene is rendering forms
 * a framebuffer feedback loop and the draw is dropped by the driver. The copy
 * holds LAST frame's depth for the whole of the current frame, including inside
 * the scene pass, so soft particles and screen-space refraction can bind it
 * once at init and never think about it again.
 */
export interface PostExt {
  depthTexture: THREE.Texture | null;
  near: number;
  far: number;
  /** Exposure multiplier currently applied to the scene. */
  exposure: number;
  /** Sub-pixel jitter baked into the projection matrix this frame, NDC. */
  jitter: THREE.Vector2;
  /** Throw away TAA history on the next frame. Call after a teleport or cut. */
  resetHistory(): void;
  /**
   * Serialising per-pass GPU timing. Costs a `finish()` between every pass, so
   * never call it in normal play. Resolves with mean ms per pass.
   */
  profile(frames?: number): Promise<Record<string, number>>;
  /** Render-target footprint, MB, largest first. */
  vram(): { total: number; targets: { key: string; w: number; h: number; kind: string; mb: number }[] };
}
