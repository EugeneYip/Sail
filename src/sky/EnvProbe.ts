import * as THREE from 'three';
import type { World } from '../types';
import { ENVMAP_H, ENVMAP_W } from './constants';
import { SkyPass } from './Pass';
import { SKY_FRAG } from './shaders/skyRender';
import type { SkyUniforms } from './SkyRender';

/**
 * Image-based lighting for everything the sun does not light directly.
 *
 * The sky is re-rendered as a 256x128 equirect and handed to `scene.environment`.
 * three's own cube-UV cache then PMREMs it — flagging `needsPMREMUpdate` is what
 * makes it re-filter — so we get correctly roughness-prefiltered IBL without
 * owning a PMREM chain or leaking a render target per refresh.
 *
 * The probe deliberately omits the sun disc: the directional light already
 * carries the sun, and leaving a 1e5 pixel in the environment would double-count
 * it and blow out every specular highlight on the ship.
 *
 * Refreshes are throttled and additionally skipped when the sky has not
 * materially changed. Even at a 60x time warp the sun moves 0.25 deg a second,
 * so 6 Hz is indistinguishable from per-frame.
 */
export class EnvProbe {
  readonly target: THREE.WebGLRenderTarget;
  private pass: SkyPass;
  private cooldown = 0;
  private lastSunY = -99;
  private lastCover = -99;
  private lastMie = -99;

  constructor(shared: SkyUniforms) {
    this.target = new THREE.WebGLRenderTarget(ENVMAP_W * 2, ENVMAP_H * 2, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.LinearSRGBColorSpace,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    this.target.texture.mapping = THREE.EquirectangularReflectionMapping;
    this.target.texture.name = 'sky.envMap';

    this.pass = new SkyPass(
      SKY_FRAG,
      {
        ...shared,
        uRayMatrix: { value: new THREE.Matrix4() },
        uCameraPosW: { value: new THREE.Vector3() },
        uPixelAngle: { value: 0.02 },
      },
      { SKY_EQUIRECT: '1', SKY_ENV: '1' },
    );
  }

  attach(world: World): void {
    world.scene.environment = this.target.texture;
    world.scene.environmentIntensity = 1;
  }

  /** @returns true if the probe was re-rendered this frame. */
  update(world: World, force = false): boolean {
    const env = world.env;
    const mie = (this.pass.uniforms.uMieMul.value as number) ?? 1;
    this.cooldown -= world.time.dt;

    const moved =
      Math.abs(env.sunDirection.y - this.lastSunY) > 0.004 ||
      Math.abs(env.cloudCover - this.lastCover) > 0.02 ||
      Math.abs(mie - this.lastMie) > 0.03;
    if (!force && (this.cooldown > 0 || !moved)) return false;

    this.cooldown = 1 / 6;
    this.lastSunY = env.sunDirection.y;
    this.lastCover = env.cloudCover;
    this.lastMie = mie;

    (this.pass.uniforms.uCameraPosW.value as THREE.Vector3).set(0, 30, 0);
    this.pass.render(world.renderer, this.target);
    this.target.texture.needsPMREMUpdate = true;
    return true;
  }

  dispose(): void {
    this.target.dispose();
    this.pass.dispose();
  }
}
