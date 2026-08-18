import * as THREE from 'three';
import type { Module, World } from '../types';
import { AtmosphereLuts } from './AtmosphereLuts';
import { AIRGLOW, KOSCHMIEDER, M_TO_KM, RADIANCE_SCALE, SOLAR_IRRADIANCE } from './constants';
import { EnvProbe } from './EnvProbe';
import { Radiometry } from './Radiometry';
import { Sidereal } from './Sidereal';
import { createSkyUniforms, SkyRender, type SkyUniforms } from './SkyRender';
import { SunLight } from './SunLight';
import { bakeMoonAlbedo, makeStarRamp, makeWhitePixel } from './Textures';

/** Shape of `world.ext.sky`. Documented in full in `src/sky/index.ts`. */
export interface SkyHandshake {
  envMap: THREE.Texture;
  irradianceSH: Float32Array;
  transmittanceLUT: THREE.Texture;
  aerialLUT: THREE.Texture;
  aerialMatrix: THREE.Matrix4;
  aerialMaxDistance: number;
  cloudShadowMap: THREE.Texture;
  cloudShadowMatrix: THREE.Matrix4;
  cloudShadowStrength: number;
  sunLuminance: number;
  skyLuminance: number;
  zenithColor: THREE.Color;
  horizonColor: THREE.Color;
}

/**
 * Physically based atmosphere, sun, moon, stars and key light.
 *
 * Runs Hillaire's four-LUT model on the GPU for what you see, and a compact CPU
 * mirror of the same medium for what the rest of the game needs as numbers.
 * Both read the identical scattering constants, so the directional light can
 * never disagree with the sky it is standing under.
 */
export class Sky implements Module {
  readonly name = 'sky';

  private uniforms!: SkyUniforms;
  private luts!: AtmosphereLuts;
  private render!: SkyRender;
  private probe!: EnvProbe;
  private light = new SunLight();
  private radiometry = new Radiometry();
  private sidereal = new Sidereal();

  private moonAlbedo!: THREE.WebGLRenderTarget;
  private starRamp!: THREE.DataTexture;
  private whitePixel!: THREE.DataTexture;

  private handshake!: SkyHandshake;
  private aerialMatrix = new THREE.Matrix4();
  private cloudShadowMatrix = new THREE.Matrix4();

  private camPos = new THREE.Vector3();
  private scratch = new THREE.Vector3();
  private passCount = 0;

  init(world: World): void {
    const renderer = world.renderer;
    // The placeholder painted a flat colour here; the sky mesh owns it now.
    world.scene.background = null;

    this.whitePixel = makeWhitePixel();
    this.moonAlbedo = bakeMoonAlbedo(renderer);
    this.starRamp = makeStarRamp();

    this.uniforms = createSkyUniforms();
    this.uniforms.tStarRamp.value = this.starRamp;
    this.uniforms.tMoonAlbedo.value = this.moonAlbedo.texture;
    (this.uniforms.uAirglow.value as THREE.Vector3).copy(AIRGLOW);

    this.luts = new AtmosphereLuts(this.whitePixel);
    this.uniforms.tTransmittance.value = this.luts.transmittance.texture;
    this.uniforms.tSkyView.value = this.luts.skyView.texture;

    this.radiometry.init();
    this.luts.bakeNow(renderer, this.radiometry.mieMul);

    this.render = new SkyRender(this.uniforms, {});
    world.scene.add(this.render.mesh);

    this.probe = new EnvProbe(this.uniforms);
    this.probe.attach(world);

    this.light.init(world);

    this.handshake = {
      envMap: this.probe.target.texture,
      irradianceSH: this.radiometry.sh,
      transmittanceLUT: this.luts.transmittance.texture,
      aerialLUT: this.luts.aerial.texture,
      aerialMatrix: this.aerialMatrix,
      aerialMaxDistance: this.luts.aerialMaxDistanceM,
      cloudShadowMap: this.whitePixel,
      cloudShadowMatrix: this.cloudShadowMatrix,
      cloudShadowStrength: 0,
      sunLuminance: 0,
      skyLuminance: 0,
      zenithColor: this.radiometry.zenithColor,
      horizonColor: this.radiometry.horizonColor,
    };
    world.ext.sky = this.handshake;

    // One warm-up so the very first frame is lit, not black.
    this.camPos.setFromMatrixPosition(world.camera.matrixWorld);
    for (let i = 0; i < 5; i++) this.radiometry.update(world.env, Math.max(0, this.camPos.y) * M_TO_KM);
    this.publish(world);
    this.updateLuts(world);
    this.probe.update(world, true);
  }

  applySettings(world: World): void {
    this.light.applySettings(world);
    this.probe.update(world, true);
  }

  update(world: World): void {
    this.passCount = 0;
    const env = world.env;
    this.camPos.setFromMatrixPosition(world.camera.matrixWorld);
    const camAltKm = Math.max(0, this.camPos.y) * M_TO_KM;

    this.radiometry.update(env, camAltKm);
    this.sidereal.update(env.latitude, env.dayOfYear, env.sunDirection);

    this.publish(world);
    this.light.update(world, this.radiometry);
    this.updateLuts(world);
    if (this.probe.update(world)) this.passCount++;

    world.stats['sky:passes'] = this.passCount;
    world.stats['sky:mie'] = this.radiometry.mieMul;
    world.stats['sky:zenithLum'] = this.radiometry.zenithLuminance;
  }

  /* ---------------------------------------------------------------- *
   *  GPU LUTs
   * ---------------------------------------------------------------- */

  private updateLuts(world: World): void {
    const renderer = world.renderer;
    const env = world.env;
    const mie = this.radiometry.mieMul;

    this.luts.requestBake(mie);
    if (this.luts.baking) {
      this.luts.stepBake(renderer);
      this.passCount++;
    }

    this.scratch.copy(SOLAR_IRRADIANCE).multiplyScalar(RADIANCE_SCALE);
    const camAltKm = Math.max(0, this.camPos.y) * M_TO_KM;
    this.luts.updateSkyView(renderer, env.sunDirection.y, camAltKm, this.scratch, mie);
    this.passCount++;

    // Aerial perspective is published for other subsystems rather than used
    // here, so it runs at half rate and not at all on the low tier.
    if (world.settings.quality !== 'low' && (world.time.frame & 1) === 0) {
      this.aerialMatrix.multiplyMatrices(
        world.camera.matrixWorld,
        world.camera.projectionMatrixInverse,
      );
      this.luts.updateAerial(
        renderer,
        this.aerialMatrix,
        this.camPos,
        env.sunDirection,
        this.scratch,
        this.handshake.cloudShadowMap,
        this.cloudShadowMatrix,
        this.handshake.cloudShadowStrength,
        mie,
      );
      this.passCount += 32;
    }
  }

  /* ---------------------------------------------------------------- *
   *  Blackboard + uniforms
   * ---------------------------------------------------------------- */

  private publish(world: World): void {
    const env = world.env;
    const u = world.uniforms;
    const rad = this.radiometry;

    env.sunColor.copy(rad.sunColor);
    env.sunIntensity = rad.sunIntensity;

    u.uSunDirection.value.copy(env.sunDirection);
    u.uSunColor.value.copy(rad.sunColor);
    u.uSunIntensity.value = rad.sunIntensity;
    u.uMoonDirection.value.copy(env.moonDirection);
    u.uMoonColor.value.copy(rad.moonColor);
    u.uMoonIntensity.value = rad.moonIntensity;
    u.uSkyColor.value.copy(rad.skyColor);
    u.uGroundColor.value.copy(rad.groundColor);
    u.uFogColor.value.copy(rad.fogColor);
    u.uVisibility.value = env.visibility;
    u.uFogDensity.value = KOSCHMIEDER / Math.max(1, env.visibility);

    const su = this.uniforms;
    (su.uSunDirection.value as THREE.Vector3).copy(env.sunDirection);
    (su.uMoonDirection.value as THREE.Vector3).copy(env.moonDirection);
    (su.uCelestialPole.value as THREE.Vector3).copy(this.sidereal.pole);
    (su.uStarMatrix.value as THREE.Matrix3).copy(this.sidereal.matrix);
    rad.sunDiscRadiance(su.uSunDiscRadiance.value as THREE.Vector3);
    (su.uMoonDiscRadiance.value as THREE.Vector3).copy(rad.moonDiscRadiance);
    (su.uMoonEarthshine.value as THREE.Vector3).copy(rad.moonEarthshine);
    (su.uMoonGlow.value as THREE.Vector3).copy(rad.moonGlow);
    su.uStarBrightness.value = rad.starBrightness;
    su.uMilkyWay.value = rad.milkyWayBrightness;
    su.uMieMul.value = rad.mieMul;
    su.uSkyTime.value = world.time.elapsed;

    this.handshake.sunLuminance = rad.sunLuminance;
    this.handshake.skyLuminance = rad.skyLuminance;
  }

  dispose(): void {
    this.render.dispose();
    this.probe.dispose();
    this.luts.dispose();
    this.light.dispose();
    this.moonAlbedo.dispose();
    this.starRamp.dispose();
    this.whitePixel.dispose();
  }
}
