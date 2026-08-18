import * as THREE from 'three';
import {
  AERIAL_MAX_KM,
  AERIAL_SIZE,
  AERIAL_SLICES,
  MULTISCATTER_SIZE,
  SKYVIEW_H,
  SKYVIEW_W,
  TRANSMITTANCE_H,
  TRANSMITTANCE_W,
} from './constants';
import { SkyPass, makeLut } from './Pass';
import { AERIAL_FRAG, MULTISCATTER_FRAG, SKYVIEW_FRAG, TRANSMITTANCE_FRAG } from './shaders/lutPasses';

/**
 * The four-LUT atmosphere chain from Hillaire 2020.
 *
 *   transmittance  256x64    baked on a turbidity change   (0.15 ms, measured)
 *   multi-scatter  32x32     baked on a turbidity change   (staged, next frame)
 *   sky view       192x108   every frame                   (0.08 ms, measured)
 *   aerial froxels 32x32x16  every 4th frame, 16 draws     (1.2 ms, measured)
 *
 * The two bakes are staged over consecutive frames so a weather transition never
 * shows up as a hitch. Slice count and refresh rate for the froxel volume are
 * the sky module's largest single cost; the reasoning is on AERIAL_SLICES in
 * constants.ts and AERIAL_PERIOD in Sky.ts.
 */
export class AtmosphereLuts {
  readonly transmittance = makeLut(TRANSMITTANCE_W, TRANSMITTANCE_H);
  readonly multiScatter = makeLut(MULTISCATTER_SIZE, MULTISCATTER_SIZE);
  readonly skyView = makeLut(SKYVIEW_W, SKYVIEW_H);
  readonly aerial: THREE.WebGL3DRenderTarget;

  private transPass: SkyPass;
  private msPass: SkyPass;
  private skyViewPass: SkyPass;
  private aerialPass: SkyPass;

  private bakedMieMul = -1;
  /** 0 = idle, 1 = transmittance queued, 2 = multi-scatter queued. */
  private bakeStage = 0;
  private pendingMieMul = 1;

  constructor(cloudShadowFallback: THREE.Texture) {
    this.aerial = new THREE.WebGL3DRenderTarget(AERIAL_SIZE, AERIAL_SIZE, AERIAL_SLICES, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.LinearSRGBColorSpace,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    this.aerial.texture.wrapR = THREE.ClampToEdgeWrapping;

    this.transPass = new SkyPass(TRANSMITTANCE_FRAG, { uMieMul: { value: 1 } });
    this.msPass = new SkyPass(MULTISCATTER_FRAG, {
      tTransmittance: { value: this.transmittance.texture },
      uMieMul: { value: 1 },
    });
    this.skyViewPass = new SkyPass(SKYVIEW_FRAG, {
      tTransmittance: { value: this.transmittance.texture },
      tMultiScatter: { value: this.multiScatter.texture },
      uSunIrradiance: { value: new THREE.Vector3(1, 1, 1) },
      uSunZenithCos: { value: 0.5 },
      uCameraAltKm: { value: 0.01 },
      uMieMul: { value: 1 },
    });
    this.aerialPass = new SkyPass(AERIAL_FRAG, {
      tTransmittance: { value: this.transmittance.texture },
      tMultiScatter: { value: this.multiScatter.texture },
      tCloudShadow: { value: cloudShadowFallback },
      uCloudShadowMatrix: { value: new THREE.Matrix4() },
      uRayMatrix: { value: new THREE.Matrix4() },
      uCameraPosW: { value: new THREE.Vector3() },
      uSunDirection: { value: new THREE.Vector3(0, 1, 0) },
      uSunIrradiance: { value: new THREE.Vector3(1, 1, 1) },
      uCloudShadowAmount: { value: 0 },
      uSliceIndex: { value: 0 },
      uMieMul: { value: 1 },
    });
  }

  /** Queue a rebake if the aerosol column changed materially. */
  requestBake(mieMul: number, force = false): void {
    if (!force && Math.abs(mieMul - this.bakedMieMul) < 0.02) return;
    this.pendingMieMul = mieMul;
    this.bakeStage = 1;
  }

  get baking(): boolean {
    return this.bakeStage !== 0;
  }

  /** Advance the staged bake by one step. Call once per frame. */
  stepBake(renderer: THREE.WebGLRenderer): void {
    if (this.bakeStage === 0) return;
    if (this.bakeStage === 1) {
      this.transPass.uniforms.uMieMul.value = this.pendingMieMul;
      this.transPass.render(renderer, this.transmittance);
      this.bakeStage = 2;
      return;
    }
    this.msPass.uniforms.uMieMul.value = this.pendingMieMul;
    this.msPass.render(renderer, this.multiScatter);
    this.bakedMieMul = this.pendingMieMul;
    this.bakeStage = 0;
  }

  /** Bake everything synchronously — used once during init. */
  bakeNow(renderer: THREE.WebGLRenderer, mieMul: number): void {
    this.requestBake(mieMul, true);
    this.stepBake(renderer);
    this.stepBake(renderer);
  }

  updateSkyView(
    renderer: THREE.WebGLRenderer,
    sunZenithCos: number,
    cameraAltKm: number,
    sunIrradiance: THREE.Vector3,
    mieMul: number,
  ): void {
    const u = this.skyViewPass.uniforms;
    u.uSunZenithCos.value = sunZenithCos;
    u.uCameraAltKm.value = cameraAltKm;
    (u.uSunIrradiance.value as THREE.Vector3).copy(sunIrradiance);
    u.uMieMul.value = mieMul;
    this.skyViewPass.render(renderer, this.skyView);
  }

  updateAerial(
    renderer: THREE.WebGLRenderer,
    rayMatrix: THREE.Matrix4,
    cameraPos: THREE.Vector3,
    sunDirection: THREE.Vector3,
    sunIrradiance: THREE.Vector3,
    cloudShadow: THREE.Texture,
    cloudShadowMatrix: THREE.Matrix4,
    cloudShadowAmount: number,
    mieMul: number,
  ): void {
    const u = this.aerialPass.uniforms;
    (u.uRayMatrix.value as THREE.Matrix4).copy(rayMatrix);
    (u.uCameraPosW.value as THREE.Vector3).copy(cameraPos);
    (u.uSunDirection.value as THREE.Vector3).copy(sunDirection);
    (u.uSunIrradiance.value as THREE.Vector3).copy(sunIrradiance);
    (u.uCloudShadowMatrix.value as THREE.Matrix4).copy(cloudShadowMatrix);
    u.tCloudShadow.value = cloudShadow;
    u.uCloudShadowAmount.value = cloudShadowAmount;
    u.uMieMul.value = mieMul;
    for (let i = 0; i < AERIAL_SLICES; i++) {
      u.uSliceIndex.value = i;
      this.aerialPass.render(renderer, this.aerial as unknown as THREE.WebGLRenderTarget, i);
    }
  }

  get aerialMaxDistanceM(): number {
    return AERIAL_MAX_KM * 1000;
  }

  dispose(): void {
    this.transmittance.dispose();
    this.multiScatter.dispose();
    this.skyView.dispose();
    this.aerial.dispose();
    this.transPass.dispose();
    this.msPass.dispose();
    this.skyViewPass.dispose();
    this.aerialPass.dispose();
  }
}
