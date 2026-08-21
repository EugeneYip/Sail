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
  /**
   * CPU **estimate** of the exposure multiplier, from the sky model — NOT the
   * number the frame was multiplied by. `PREPARE_FRAG` multiplies by
   * `tExposure.g`, a 1x1 target the adapt pass writes on the GPU from a
   * centre-weighted histogram of the actual frame, and the two are further apart
   * than `AutoExposure`'s comment used to claim: measured on the `orbit` preset,
   * this field read 0.668 while the applied multiplier was **0.151** — 2.14
   * stops. Nothing visual depends on this field; it is for the HUD.
   *
   * A probe that needs the real multiplier must read the GPU state, e.g.
   * `renderHook.pipeline.targets.map.get('expStateB')` via
   * `readRenderTargetPixels` (`.g`), or set `settings.debugStalls`. Pinning
   * `world.uniforms.uExposure` pins the estimate and changes nothing on screen.
   * Calibrating a transfer curve against this field is what put DIAGNOSIS §68a's
   * shadow-crush figure out by 2.1 stops and its sky reference out by 20x.
   */
  exposure: number;
  /** Sub-pixel jitter baked into the projection matrix this frame, NDC. */
  jitter: THREE.Vector2;
  /** Throw away TAA history on the next frame. Call after a teleport or cut. */
  resetHistory(): void;
  /**
   * Reference frame the velocity buffer reprojects in. `perPixel` is the
   * shipping behaviour and the only correct one — see `VELOCITY_FRAG`. The two
   * globals exist because the per-pixel result was established by A/B against
   * them, and a claim about the near field that cannot be re-measured is not
   * worth much. Flipping this is also the rollback lever if the classifier ever
   * misbehaves on new geometry.
   */
  velocityFrame: 'perPixel' | 'world' | 'ship';
  /**
   * Whether the near depth-of-field field fades in over the same CoC ramp the
   * far field uses. False restores the old step at 1.2 px of circle of
   * confusion — see `DOF_RAMP_GLSL`. Same purpose as `velocityFrame`: the change
   * was established by A/B against the old behaviour, and both are looks
   * someone may want to compare again. Toggling recompiles one pass.
   */
  dofNearRamp: boolean;
  /**
   * Serialising per-pass GPU timing. Costs a `finish()` between every pass, so
   * never call it in normal play. Resolves with mean ms per pass.
   */
  profile(frames?: number): Promise<Record<string, number>>;
  /** Render-target footprint, MB, largest first. */
  vram(): { total: number; targets: { key: string; w: number; h: number; kind: string; mb: number }[] };
}
