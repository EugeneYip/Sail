import type * as THREE from 'three';

/**
 * Published on `world.ext.post`. Allocated once and mutated in place, so a
 * consumer may cache the reference.
 *
 * `depthTexture` is the scene depth attachment: DEPTH_COMPONENT32F, non-linear,
 * over `near`..`far`. It is valid from the moment the scene pass finishes until
 * the next frame's scene pass begins — i.e. any module reading it during its
 * own `update()` sees last frame's depth, which is what a screen-space effect
 * wants anyway.
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
