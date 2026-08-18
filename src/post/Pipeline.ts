import * as THREE from 'three';
import type { QualityTier, World } from '../types';
import { clamp01 } from '../util/math';
import { AntiAliasing } from './Aa';
import { AutoExposure } from './AutoExposure';
import { BloomChain } from './Bloom';
import { DepthOfField } from './Dof';
import { FullscreenPass } from './FullscreenPass';
import { Jitter } from './Jitter';
import { MotionBlur } from './MotionBlur';
import { Profiler } from './Profiler';
import { Targets } from './Targets';
import type { PostExt } from './ext';
import { LOOKS, makeLookTexture, resolveLookBlend } from './luts/LookLut';
import { makeBlackTexture, makeLensDirtTexture } from './luts/LensDirt';
import { COMPOSITE_FRAG } from './shaders/composite';
import { PREPARE_FRAG } from './shaders/prepare';
import { UNDERWATER_FRAG } from './shaders/underwater';
import { VELOCITY_FRAG } from './shaders/velocity';

/* ------------------------------------------------------------------ *
 *  Look constants. Everything here is deliberately understated; the
 *  reference is slowroads, which grades almost invisibly.
 * ------------------------------------------------------------------ */

const BLOOM_STRENGTH = 0.055;
const BLOOM_RADIUS = 1.15;
const DIRT_STRENGTH = 1.5;
const CA_STRENGTH = 0.0011; // ~1.3 px of channel split at the corner
const VIGNETTE_STRENGTH = 0.045;
const GRAIN_STRENGTH = 0.018;
/** Radiance ceiling in exposed units. +6 stops over white. */
const FIREFLY_CLAMP = 64;

interface QualityBudget {
  dofTaps: number;
  mbTaps: number;
}

const BUDGET: Record<QualityTier, QualityBudget> = {
  low: { dofTaps: 8, mbTaps: 6 },
  medium: { dofTaps: 12, mbTaps: 8 },
  high: { dofTaps: 16, mbTaps: 10 },
  ultra: { dofTaps: 22, mbTaps: 12 },
};

/**
 * The whole post chain.
 *
 * ```
 *  scene (rgba16f + depth32f)
 *    -> prepare        exposure, NaN/firefly clamp
 *    -> velocity       depth reprojection, rg16f, jitter-free screen space
 *    -> AA             taa (+RCAS) | smaa | fxaa | off
 *    -> depth of field half-res gather, near + far
 *    -> motion blur    tile-max dilated, capped at one tile
 *    -> underwater     conditional
 *    -> bloom          6-level progressive pyramid
 *    -> composite      CA, dirt, vignette, AgX, look LUT, grade, grain, dither
 *    -> default framebuffer, sRGB 8-bit
 * ```
 *
 * ## What other subsystems have to do
 *
 * **Jitter.** With `antialias: 'taa'` the projection matrix is offset by up to
 * half a pixel while the scene renders. It is applied here, after every
 * module's `update()`, and removed before this method returns, so nothing that
 * reads `camera.projectionMatrix` outside a shader is affected. Anything that
 * reprojects *inside* the scene pass — the sky's cloud temporal accumulation,
 * an SSR history buffer — must subtract `uniforms.uJitter` (NDC) from the
 * current NDC before reprojecting, and add nothing when it is (0,0). It is
 * zeroed whenever TAA is off, so the subtraction is always safe.
 *
 * **Velocity.** Reprojection only: `worldFromDepth` of the current frame,
 * projected by the previous frame's unjittered view-projection. That is exact
 * for the camera and for anything rigid, and *wrong* for anything displaced in
 * its vertex shader — the FFT ocean surface, billowing canvas, flags, spray.
 * Those report the velocity of the static point they happen to occupy. The
 * consequences are chosen rather than accidental:
 *
 *   - TAA rejects the history instead of smearing it, because the YCoCg
 *     variance clip sees the disagreement. The ocean therefore anti-aliases a
 *     little worse than the rigging does, and does not ghost.
 *   - Motion blur under-blurs a wave crest sliding under a static camera. At
 *     0.35 shutter and 2 m/s of orbital velocity that is under a pixel, so it
 *     is invisible; it would matter for a fast-moving object, and there are
 *     none.
 *
 * Fixing it properly needs an MRT velocity output from the ocean and sail
 * materials, which is a change in someone else's directory.
 */
export class Pipeline {
  private targets = new Targets();
  private profiler = new Profiler();
  private jitter = new Jitter();
  private exposure = new AutoExposure(this.targets);
  private aa = new AntiAliasing(this.targets);
  private bloom = new BloomChain(this.targets);
  private dof = new DepthOfField(this.targets);
  private motionBlur = new MotionBlur(this.targets);

  private prepare: FullscreenPass;
  private velocity: FullscreenPass;
  private composite: FullscreenPass;
  private underwater: FullscreenPass | null = null;

  private lookTex: THREE.Data3DTexture;
  private dirtTex: THREE.DataTexture;
  private blackTex: THREE.DataTexture;

  private width = 1;
  private height = 1;
  private allocated = false;

  /* scratch — never allocate in render() */
  private curViewProj = new THREE.Matrix4();
  private prevViewProj = new THREE.Matrix4();
  private invViewProj = new THREE.Matrix4();
  private prevCamPos = new THREE.Vector3();
  private lookBlend = { a: 0, b: 0, mix: 0 };
  private scatterColor = new THREE.Color();
  private hasPrevFrame = false;

  private profileFrames = 0;
  private profileResolve: ((r: Record<string, number>) => void) | null = null;

  readonly ext: PostExt;

  constructor(world: World) {
    this.lookTex = makeLookTexture();
    this.dirtTex = makeLensDirtTexture();
    this.blackTex = makeBlackTexture();
    this.profiler.attach(world.renderer);

    this.prepare = new FullscreenPass('prepare', PREPARE_FRAG, {
      tScene: { value: null },
      uExposure: { value: 1 },
      uClampMax: { value: FIREFLY_CLAMP },
    });

    this.velocity = new FullscreenPass('velocity', VELOCITY_FRAG, {
      tDepth: { value: null },
      uInvViewProj: { value: new THREE.Matrix4() },
      uPrevViewProj: { value: new THREE.Matrix4() },
      uCamPos: { value: new THREE.Vector3() },
      uPrevCamPos: { value: new THREE.Vector3() },
      uJitter: { value: new THREE.Vector2() },
    });

    this.composite = new FullscreenPass('composite', COMPOSITE_FRAG, {
      tColor: { value: null },
      tBloom: { value: this.blackTex },
      tDirt: { value: this.dirtTex },
      tLook: { value: this.lookTex },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uTime: { value: 0 },
      uFrame: { value: 0 },
      uAspect: { value: 1 },
      uBloomStrength: { value: BLOOM_STRENGTH },
      uDirtStrength: { value: DIRT_STRENGTH },
      uCA: { value: CA_STRENGTH },
      uVignette: { value: VIGNETTE_STRENGTH },
      uGrain: { value: GRAIN_STRENGTH },
      uLookBlend: { value: new THREE.Vector3(0, 0, 0) },
      uLookAmount: { value: 1 },
      uLift: { value: new THREE.Vector3(0, 0, 0) },
      uGamma: { value: new THREE.Vector3(1, 1, 1) },
      uGain: { value: new THREE.Vector3(1, 1, 1) },
      uSplitShadow: { value: new THREE.Vector3(0.955, 0.99, 1.07) },
      uSplitHighlight: { value: new THREE.Vector3(1.055, 1.005, 0.95) },
      uSplitAmount: { value: 0.34 },
      uSaturation: { value: 1 },
    });

    this.ext = {
      depthTexture: null,
      near: world.camera.near,
      far: world.camera.far,
      exposure: 1,
      jitter: this.jitter.ndc,
      resetHistory: () => {
        this.aa.reset = true;
        this.hasPrevFrame = false;
      },
      profile: (frames = 90) => this.startProfile(frames),
      vram: () => ({ total: this.targets.bytes() / 1048576, targets: this.targets.breakdown() }),
    };
    world.ext.post = this.ext;
  }

  /* ------------------------------------------------------------------ *
   *  allocation
   * ------------------------------------------------------------------ */

  resize(world: World): void {
    const w = Math.max(1, world.size.width);
    const h = Math.max(1, world.size.height);
    const s = world.settings;
    const sizeChanged = w !== this.width || h !== this.height;
    this.width = w;
    this.height = h;

    this.targets.get('scene', w, h, 'rgba16f', { depth: true });
    this.targets.get('work0', w, h, 'rgba16f');
    this.targets.get('work1', w, h, 'rgba16f');

    this.aa.setMode(s.antialias);
    this.aa.resize(w, h);

    const wantVelocity = this.aa.needsVelocity || s.motionBlur;
    if (wantVelocity) this.targets.get('velocity', w, h, 'rg16f', { nearest: true });
    else this.targets.release('velocity');

    if (s.bloom) this.bloom.resize(w, h);
    else this.bloom.release();

    if (s.depthOfField) this.dof.resize(w, h);
    else this.dof.release();

    if (s.motionBlur) this.motionBlur.resize(w, h);
    else this.motionBlur.release();

    const scene = this.targets.get('scene', w, h, 'rgba16f', { depth: true });
    this.ext.depthTexture = scene.depthTexture ?? null;
    this.ext.near = world.camera.near;
    this.ext.far = world.camera.far;

    (this.composite.uniforms.uResolution.value as THREE.Vector2).set(w, h);
    this.composite.uniforms.uAspect.value = w / h;

    if (sizeChanged) this.hasPrevFrame = false;
    this.allocated = true;
  }

  /* ------------------------------------------------------------------ *
   *  frame
   * ------------------------------------------------------------------ */

  render(world: World): void {
    if (!this.allocated) this.resize(world);
    const r = world.renderer;
    const s = world.settings;
    const cam = world.camera;
    const budget = BUDGET[s.quality] ?? BUDGET.high;
    const prof = this.profiler;
    prof.enabled = s.debug || this.profileFrames > 0;

    const camExt = world.ext.camera as
      | { cut?: boolean; underwater?: number }
      | undefined;
    if (camExt?.cut) {
      this.aa.reset = true;
      this.hasPrevFrame = false;
    }

    // 1. exposure for this frame, from the most recent completed readback
    this.exposure.update(world);
    this.ext.exposure = this.exposure.exposure;

    // 2. scene
    const scene = this.targets.get('scene', this.width, this.height, 'rgba16f', { depth: true });
    const taaActive = s.antialias === 'taa';
    this.jitter.advance(world.time.frame, this.width, this.height, taaActive);
    (world.uniforms.uJitter.value as THREE.Vector2).copy(this.jitter.ndc);
    this.jitter.apply(cam);

    prof.begin('scene');
    r.setRenderTarget(scene);
    r.clear(true, true, true);
    r.render(world.scene, cam);
    prof.end();

    this.jitter.remove(cam);

    // Unjittered matrices, for velocity and for next frame's reprojection.
    this.curViewProj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.invViewProj.copy(this.curViewProj).invert();

    // 3. metering runs on pre-exposure radiance, so it cannot feed back
    if (s.autoExposure) {
      prof.begin('exposure');
      this.exposure.meter(world, scene);
      prof.end();
    }

    // 4. exposure + firefly clamp
    let cur = this.targets.get('work0', this.width, this.height, 'rgba16f');
    let alt = this.targets.get('work1', this.width, this.height, 'rgba16f');
    prof.begin('prepare');
    this.prepare.uniforms.tScene.value = scene.texture;
    this.prepare.uniforms.uExposure.value = this.exposure.exposure;
    this.prepare.render(r, cur);
    prof.end();
    let curTex: THREE.Texture = cur.texture;

    const depthTex = scene.depthTexture ?? null;

    // 5. velocity
    const wantVelocity = (this.aa.needsVelocity || s.motionBlur) && depthTex !== null;
    let velocityTex: THREE.Texture | null = null;
    if (wantVelocity) {
      const vel = this.targets.get('velocity', this.width, this.height, 'rg16f', { nearest: true });
      const u = this.velocity.uniforms;
      u.tDepth.value = depthTex;
      (u.uInvViewProj.value as THREE.Matrix4).copy(this.invViewProj);
      (u.uPrevViewProj.value as THREE.Matrix4).copy(
        this.hasPrevFrame ? this.prevViewProj : this.curViewProj,
      );
      (u.uCamPos.value as THREE.Vector3).setFromMatrixPosition(cam.matrixWorld);
      (u.uPrevCamPos.value as THREE.Vector3).copy(
        this.hasPrevFrame ? this.prevCamPos : (u.uCamPos.value as THREE.Vector3),
      );
      (u.uJitter.value as THREE.Vector2).copy(this.jitter.ndc);
      prof.begin('velocity');
      this.velocity.render(r, vel);
      prof.end();
      velocityTex = vel.texture;
    }

    // 6. anti-aliasing
    prof.begin(`aa:${s.antialias}`);
    const historyScale =
      this.exposure.previous > 1e-6 ? this.exposure.exposure / this.exposure.previous : 1;
    const aaTex = this.aa.render(
      r,
      s,
      curTex,
      depthTex,
      velocityTex,
      alt,
      this.jitter.pixels,
      historyScale,
    );
    prof.end();
    if (aaTex !== curTex) {
      const t = cur;
      cur = alt;
      alt = t;
      curTex = aaTex;
    }

    // 7. depth of field
    if (s.depthOfField && depthTex) {
      prof.begin('dof');
      const wrote = this.dof.render(r, world, curTex, depthTex, alt, budget.dofTaps);
      prof.end();
      if (wrote) {
        const t = cur;
        cur = alt;
        alt = t;
        curTex = cur.texture;
      }
    }

    // 8. motion blur
    if (s.motionBlur && velocityTex && depthTex && this.hasPrevFrame) {
      prof.begin('motionBlur');
      this.motionBlur.render(
        r,
        curTex,
        velocityTex,
        depthTex,
        cam.near,
        cam.far,
        alt,
        budget.mbTaps,
        world.time.frame % 1024,
      );
      prof.end();
      const t = cur;
      cur = alt;
      alt = t;
      curTex = cur.texture;
    }

    // 9. underwater
    const submerged = clamp01(camExt?.underwater ?? 0);
    if (submerged > 0.001 && depthTex) {
      prof.begin('underwater');
      this.renderUnderwater(world, curTex, depthTex, alt, submerged);
      prof.end();
      const t = cur;
      cur = alt;
      alt = t;
      curTex = cur.texture;
    }

    // 10. bloom
    if (s.bloom) {
      prof.begin('bloom');
      this.bloom.render(r, curTex, BLOOM_RADIUS);
      prof.end();
    }

    // 11. composite
    prof.begin('composite');
    this.writeGrade(world);
    const cu = this.composite.uniforms;
    cu.tColor.value = curTex;
    cu.tBloom.value = s.bloom && this.bloom.texture ? this.bloom.texture : this.blackTex;
    cu.uBloomStrength.value = s.bloom ? BLOOM_STRENGTH : 0;
    cu.uDirtStrength.value = s.lensDirt ? DIRT_STRENGTH : 0;
    cu.uCA.value = s.chromaticAberration ? CA_STRENGTH : 0;
    cu.uVignette.value = s.vignette ? VIGNETTE_STRENGTH : 0;
    cu.uGrain.value = s.filmGrain ? GRAIN_STRENGTH : 0;
    cu.uTime.value = world.time.elapsed;
    cu.uFrame.value = world.time.frame % 1024;
    this.composite.render(r, null);
    prof.end();

    // 12. carry state
    this.prevViewProj.copy(this.curViewProj);
    this.prevCamPos.setFromMatrixPosition(cam.matrixWorld);
    this.hasPrevFrame = true;

    prof.writeStats(world.stats);
    this.tickProfile();
  }

  /* ------------------------------------------------------------------ *
   *  grade
   * ------------------------------------------------------------------ */

  /**
   * Time of day picks the look LUT pair; weather trims on top of it. The trim
   * is deliberately tiny — the LUTs already carry the character, and stacking a
   * second strong grade on them is how a scene ends up looking like a filter.
   */
  private writeGrade(world: World): void {
    const env = world.env;
    resolveLookBlend(env.sunDirection.y, this.lookBlend);
    (this.composite.uniforms.uLookBlend.value as THREE.Vector3).set(
      Math.min(this.lookBlend.a, LOOKS.length - 1),
      Math.min(this.lookBlend.b, LOOKS.length - 1),
      this.lookBlend.mix,
    );

    // Haze lifts the black point and pulls saturation: that is what scattered
    // light physically does to a frame, and it keeps fog from looking like a
    // grey card with a boat on it.
    const haze = clamp01(1 - env.visibility / 20000) * 0.7 + clamp01(env.rain) * 0.3;
    const lift = haze * 0.012;
    (this.composite.uniforms.uLift.value as THREE.Vector3).setScalar(lift);
    (this.composite.uniforms.uGain.value as THREE.Vector3).setScalar(1 - lift * 0.8);
    this.composite.uniforms.uSaturation.value = 1 - haze * 0.16;
    // Overcast light is already neutral; splitting it further reads as a filter.
    this.composite.uniforms.uSplitAmount.value = 0.34 * (1 - clamp01(env.cloudCover) * 0.35);
  }

  private renderUnderwater(
    world: World,
    source: THREE.Texture,
    depth: THREE.Texture,
    dst: THREE.WebGLRenderTarget,
    amount: number,
  ): void {
    const p = this.getUnderwater();
    const u = p.uniforms;
    u.tColor.value = source;
    u.tDepth.value = depth;
    (u.uTexelSize.value as THREE.Vector2).set(1 / this.width, 1 / this.height);
    (u.uDepthRange.value as THREE.Vector2).set(world.camera.near, world.camera.far);
    u.uAmount.value = amount;
    u.uTime.value = world.time.elapsed;
    u.uAspect.value = this.width / this.height;
    // The medium is lit by whatever is above it, and it is already in exposed
    // units because everything downstream of `prepare` is.
    this.scatterColor.copy(world.uniforms.uSkyColor.value).multiplyScalar(0.22 * this.exposure.exposure);
    this.scatterColor.r *= 0.35;
    this.scatterColor.g *= 0.85;
    (u.uScatter.value as THREE.Vector3).set(
      this.scatterColor.r,
      this.scatterColor.g,
      this.scatterColor.b,
    );
    p.render(world.renderer, dst);
  }

  private getUnderwater(): FullscreenPass {
    if (!this.underwater) {
      this.underwater = new FullscreenPass('underwater', UNDERWATER_FRAG, {
        tColor: { value: null },
        tDepth: { value: null },
        uTexelSize: { value: new THREE.Vector2() },
        uDepthRange: { value: new THREE.Vector2(0.25, 60000) },
        uAmount: { value: 0 },
        uTime: { value: 0 },
        uAspect: { value: 1.777 },
        // Clear ocean water, 1/m. Red is gone at ~8 m, blue survives to ~120 m.
        uAbsorb: { value: new THREE.Vector3(0.36, 0.075, 0.028) },
        uScatter: { value: new THREE.Vector3(0.02, 0.06, 0.08) },
        uDistort: { value: 3.5 },
        uBlur: { value: 2.6 },
      });
    }
    return this.underwater;
  }

  /* ------------------------------------------------------------------ *
   *  profiling
   * ------------------------------------------------------------------ */

  private startProfile(frames: number): Promise<Record<string, number>> {
    this.profiler.reset();
    this.profiler.enabled = true;
    this.profiler.syncMode = true;
    this.profileFrames = frames;
    return new Promise((resolve) => {
      this.profileResolve = resolve;
    });
  }

  private tickProfile(): void {
    if (this.profileFrames <= 0) return;
    if (--this.profileFrames > 0) return;
    const report = this.profiler.report();
    this.profiler.enabled = false;
    this.profiler.syncMode = false;
    const done = this.profileResolve;
    this.profileResolve = null;
    done?.(report);
  }

  dispose(): void {
    this.targets.dispose();
    this.prepare.dispose();
    this.velocity.dispose();
    this.composite.dispose();
    this.underwater?.dispose();
    this.exposure.dispose();
    this.aa.dispose();
    this.bloom.dispose();
    this.dof.dispose();
    this.motionBlur.dispose();
    this.lookTex.dispose();
    this.dirtTex.dispose();
    this.blackTex.dispose();
  }
}
