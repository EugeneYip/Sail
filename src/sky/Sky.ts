import * as THREE from 'three';
import type { Module, QualityTier, World } from '../types';
import { AtmosphereLuts } from './AtmosphereLuts';
import { AERIAL_SLICES, AIRGLOW, KOSCHMIEDER, M_TO_KM } from './constants';

/**
 * Frames between full rebuilds of the aerial-perspective froxel volume. 0 skips
 * it entirely. It is a smooth, purely atmospheric field over tens of kilometres,
 * so 15 Hz is indistinguishable from per-frame even while the camera turns.
 */
const AERIAL_PERIOD: Record<QualityTier, number> = {
  low: 0,
  medium: 8,
  high: 4,
  ultra: 4,
};
import { Clouds } from './Clouds';
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
  private clouds!: Clouds;
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
  private passCount = 0;
  /** WebGL2 context, only for the serialising debug timer. */
  private gl: WebGL2RenderingContext | null = null;
  private timing = false;
  private mark = 0;

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

    this.clouds = new Clouds(this.uniforms);
    this.clouds.field.update(world.env, world.origin, 1 / 60);
    this.clouds.bake(world);

    this.render = new SkyRender(this.uniforms, {});
    this.render.setDefine('SKY_CLOUDS', world.settings.volumetricClouds);
    // The cloud passes run from HERE, inside the main scene render, because this
    // is the only point in the frame with the final camera: the rig updates
    // after the sky module, so anything latched in update() is a frame stale and
    // the clouds visibly swim behind the ship.
    this.render.onDraw = (camera, renderer2) => {
      this.clouds.render(world, camera, renderer2);
      this.render.material.uniforms.tClouds.value = this.clouds.texture;
    };
    world.scene.add(this.render.mesh);

    this.probe = new EnvProbe(this.uniforms);
    this.probe.setClouds(this.clouds.shadowTexture, this.clouds.shadowMatrix);
    this.probe.setEnabled(world.settings.volumetricClouds);
    this.probe.attach(world);

    this.light.init(world);

    this.handshake = {
      envMap: this.probe.target.texture,
      irradianceSH: this.radiometry.sh,
      transmittanceLUT: this.luts.transmittance.texture,
      aerialLUT: this.luts.aerial.texture,
      aerialMatrix: this.aerialMatrix,
      aerialMaxDistance: this.luts.aerialMaxDistanceM,
      cloudShadowMap: this.clouds.shadowTexture,
      cloudShadowMatrix: this.clouds.shadowMatrix,
      cloudShadowStrength: 0,
      sunLuminance: 0,
      skyLuminance: 0,
      zenithColor: this.radiometry.zenithColor,
      horizonColor: this.radiometry.horizonColor,
    };
    world.ext.sky = this.handshake;

    // One warm-up so the very first frame is lit, not black.
    this.camPos.setFromMatrixPosition(world.camera.matrixWorld);
    for (let i = 0; i < 5; i++) {
      this.radiometry.update(world.env, Math.max(0, this.camPos.y) * M_TO_KM, this.clouds.field);
    }
    this.publish(world);
    this.updateLuts(world);
    this.probe.update(world, true);
  }

  applySettings(world: World): void {
    this.light.applySettings(world);
    this.clouds.applySettings(world);
    this.render.setDefine('SKY_CLOUDS', world.settings.volumetricClouds);
    this.probe.setEnabled(world.settings.volumetricClouds);
    this.probe.setClouds(this.clouds.shadowTexture, this.clouds.shadowMatrix);
    this.handshake.cloudShadowMap = this.clouds.shadowTexture;
    this.probe.update(world, true);
  }

  update(world: World): void {
    this.passCount = 0;
    const env = world.env;
    this.camPos.setFromMatrixPosition(world.camera.matrixWorld);
    const camAltKm = Math.max(0, this.camPos.y) * M_TO_KM;
    this.timing = world.settings.debug;

    // CPU-only, so no finish(): a serialising timer here would just charge the
    // sky for whatever the ocean and the ship left in the queue.
    const cpu0 = this.timing ? performance.now() : 0;
    this.clouds.update(world);
    this.radiometry.update(env, camAltKm, this.clouds.field);
    this.sidereal.update(env.latitude, env.dayOfYear, env.sunDirection);
    if (this.timing) world.stats['sky:cpuMs'] = performance.now() - cpu0;

    this.publish(world);
    this.light.update(world, this.radiometry);
    this.updateLuts(world);
    this.begin();
    if (this.probe.update(world)) this.passCount++;
    this.end(world, 'sky:probeMs');

    world.stats['sky:passes'] = this.passCount;
    world.stats['sky:mie'] = this.radiometry.mieMul;
    world.stats['sky:zenithLum'] = this.radiometry.zenithLuminance;
    world.stats['sky:cloudBeamT'] = this.clouds.field.beamTransmittance;
  }

  /* ---------------------------------------------------------------- *
   *  Timing. Serialising, so it is debug-only: a finish() between two
   *  GPU passes is the only way to attribute cost without
   *  EXT_disjoint_timer_query, which Chrome does not expose to pages.
   * ---------------------------------------------------------------- */

  private begin(): void {
    if (this.timing) this.mark = performance.now();
  }

  private end(world: World, key: string): void {
    if (!this.timing) return;
    this.gl ??= world.renderer.getContext() as WebGL2RenderingContext;
    this.gl.finish();
    const dt = performance.now() - this.mark;
    const prev = world.stats[key] ?? dt;
    world.stats[key] = prev + (dt - prev) * 0.1;
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
      this.begin();
      this.luts.stepBake(renderer);
      this.end(world, 'sky:bakeMs');
      this.passCount++;
    }

    // Game units, from the one place that owns the conversion. This is what
    // puts the rendered sky on the same scale as `uSkyColor` and `uSunIntensity`.
    const solar = this.radiometry.solarIrradiance;
    const camAltKm = Math.max(0, this.camPos.y) * M_TO_KM;
    this.begin();
    this.luts.updateSkyView(renderer, env.sunDirection.y, camAltKm, solar, mie);
    this.end(world, 'sky:skyViewMs');
    this.passCount++;

    // AERIAL PERSPECTIVE. One draw per froxel slice — WebGL2 has no layered
    // rendering, so the slice count IS the draw count, and at 32 slices this
    // pass alone was 32 of the module's 34 passes and the most expensive thing
    // in the sky by an order of magnitude. Two things make that affordable:
    // AERIAL_SLICES is 16 (the volume maps LINEARLY over 32 km, so slices are
    // 2 km apart and the field is smooth at that scale), and the whole volume
    // is refreshed at once every Nth frame rather than continuously. Refreshing
    // it whole matters: `aerialMatrix` is published with it, so a consumer
    // reprojects into the frustum the volume was actually built for and a stale
    // volume is merely late, not wrong.
    const period = AERIAL_PERIOD[world.settings.quality] ?? 4;
    if (period > 0 && world.time.frame % period === 0) {
      this.aerialMatrix.multiplyMatrices(
        world.camera.matrixWorld,
        world.camera.projectionMatrixInverse,
      );
      this.begin();
      // FULL strength, unlike the published `cloudShadowStrength`: the froxel
      // march's own sun is the unattenuated top-of-atmosphere value, so it wants
      // the raw map. This is where god rays come from — a froxel in shadow stops
      // glowing, and the lit air between shadows reads as a shaft.
      this.luts.updateAerial(
        renderer,
        this.aerialMatrix,
        this.camPos,
        env.sunDirection,
        solar,
        this.clouds.shadowTexture,
        this.clouds.shadowMatrix,
        world.settings.volumetricClouds && env.cloudCover > 0.02 ? 1 : 0,
        mie,
      );
      this.end(world, 'sky:aerialMs');
      this.passCount += AERIAL_SLICES;
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

    (su.uCloudLightDir.value as THREE.Vector3).copy(rad.cloudLightDir);
    (su.uCloudLightIrradiance.value as THREE.Vector3).copy(rad.cloudLightIrradiance);
    (su.uCloudAmbientTop.value as THREE.Vector3).copy(rad.cloudAmbientTop);
    (su.uCloudAmbientBottom.value as THREE.Vector3).copy(rad.cloudAmbientBottom);

    this.handshake.sunLuminance = rad.sunLuminance;
    this.handshake.skyLuminance = rad.skyLuminance;
    // The map carries the deck's spatial VARIATION; `uSunIntensity` already
    // carries its mean. Publishing the strength AS the mean transmittance is
    // what keeps `beamT * mix(1, T, strength)` from counting the deck twice: at
    // solid overcast the mean has done the work and the strength tapers with it,
    // while at broken cover it is near 1 and shadows land at full contrast.
    const clouded = world.settings.volumetricClouds && env.cloudCover > 0.02;
    this.handshake.cloudShadowMap = this.clouds.shadowTexture;
    this.handshake.cloudShadowStrength = clouded ? this.clouds.field.beamTransmittance : 0;
  }

  dispose(): void {
    this.render.dispose();
    this.probe.dispose();
    this.clouds.dispose();
    this.luts.dispose();
    this.light.dispose();
    this.moonAlbedo.dispose();
    this.starRamp.dispose();
    this.whitePixel.dispose();
  }
}
