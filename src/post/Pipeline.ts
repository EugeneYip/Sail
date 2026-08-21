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
import { DEPTH_COPY_FRAG, PREPARE_FRAG } from './shaders/prepare';
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
const SPLIT_TONE_AMOUNT = 0.16;
/** Radiance ceiling in exposed units. +6 stops over white. */
const FIREFLY_CLAMP = 64;

/* ------------------------------------------------------------------ *
 *  Ship-frame classifier for the velocity buffer. See VELOCITY_FRAG.
 * ------------------------------------------------------------------ */

/**
 * Metres of slack on the ship's geometric envelope, and the asymmetry is the
 * reason for the number: the rigging and the sails are drawn from instance
 * attributes and displaced in the vertex shader, so their CPU-side bounding
 * boxes are unit templates and the envelope we can actually measure is the
 * spars'. Canvas billows a metre or two outside the yard it hangs from and the
 * ensign streams aft of its staff. 3 m covers that, and over-claiming is the
 * cheap direction: a false "ship" costs a couple of pixels of velocity error on
 * water, a false "world" costs 95 px on the deck.
 */
const SHIP_BOX_PAD_M = 3;
/**
 * Half-width of the band around world sea level in which a point outside the
 * hull's waterline footprint is treated as water rather than as ship. Wide
 * enough for a storm crest relative to a heaving hull; narrow enough that no
 * part of the rig ever falls inside it.
 */
const SEA_BAND_M = 4;
/**
 * Frames between rebuilds of the envelope. The hull is static geometry, so this
 * only has to catch a rebuilt or re-tiered ship; every-frame would be a traverse
 * of the whole ship for nothing.
 */
const SHIP_BOX_REFRESH_FRAMES = 120;

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
 * projected by the previous frame's unjittered view-projection — with the
 * reference frame of that reprojection chosen *per pixel* between the world's
 * and the ship's, because the eye is bolted to a moving ship and the two answers
 * differ by 95 px at 0.8 m. See `VELOCITY_FRAG` for the classifier and step 5
 * for why one buffer serves both consumers.
 *
 * Within a frame it is still *wrong* for anything displaced in its vertex shader
 * — the FFT ocean surface, billowing canvas, flags, spray. Those report the
 * velocity of the point they happen to occupy. The consequences are chosen
 * rather than accidental:
 *
 *   - TAA rejects the history instead of smearing it, because the YCoCg
 *     variance clip sees the disagreement. The ocean therefore anti-aliases a
 *     little worse than the rigging does, and does not ghost. That holds because
 *     the orbital error is under a pixel; do not generalise it. The variance clip
 *     only protects you where the neighbourhood DISAGREES, and on a self-similar
 *     surface a badly displaced history lands on plausible content, passes the
 *     clip and blends in as a streak — which is exactly what the deck did when
 *     its velocity was 95 px wrong.
 *   - Motion blur under-blurs a wave crest sliding under a static camera. At
 *     0.35 shutter and 2 m/s of orbital velocity that is under a pixel, so it
 *     is invisible; it would matter for a fast-moving object, and there are
 *     none.
 *
 * Fixing the vertex-displacement case properly needs an MRT velocity output from
 * the ocean and sail materials, which is a change in someone else's directory.
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
  private depthCopy: FullscreenPass;
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
  private curShip = new THREE.Matrix4();
  private prevShip = new THREE.Matrix4();
  private worldToShip = new THREE.Matrix4();
  private shipDelta = new THREE.Matrix4();
  private shipViewProj = new THREE.Matrix4();
  private shipBox = new THREE.Box3();
  private shipBoxPart = new THREE.Box3();
  private shipWaterlineBox = new THREE.Box3();
  private shipBoxMat = new THREE.Matrix4();
  private shipBoxFrame = -1e9;
  private unitScale = new THREE.Vector3(1, 1, 1);
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
      tExposure: { value: null },
      uClampMax: { value: FIREFLY_CLAMP },
    });

    this.depthCopy = new FullscreenPass('depthCopy', DEPTH_COPY_FRAG, {
      tDepth: { value: null },
    });

    this.velocity = new FullscreenPass('velocity', VELOCITY_FRAG, {
      tDepth: { value: null },
      uInvViewProj: { value: new THREE.Matrix4() },
      uPrevViewProj: { value: new THREE.Matrix4() },
      uShipViewProj: { value: new THREE.Matrix4() },
      uWorldToShip: { value: new THREE.Matrix4() },
      uShipBoxMin: { value: new THREE.Vector3(-1, -1, -1) },
      uShipBoxMax: { value: new THREE.Vector3(1, 1, 1) },
      uShipWaterline: { value: new THREE.Vector4(-1, -1, 1, 1) },
      uSeaBand: { value: SEA_BAND_M },
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
      // The look LUTs carry their own split tone. This is the second one, and
      // two stacked split tones is exactly how a frame starts reading as a
      // filter, so it is a whisper on top of the grade, not a partner to it.
      uSplitAmount: { value: SPLIT_TONE_AMOUNT },
      uSaturation: { value: 1 },
    });

    this.ext = {
      depthTexture: null,
      near: world.camera.near,
      far: world.camera.far,
      exposure: 1,
      jitter: this.jitter.ndc,
      velocityFrame: 'perPixel',
      dofNearRamp: true,
      resetHistory: () => {
        this.aa.reset = true;
        this.hasPrevFrame = false;
        this.exposure.invalidate();
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

    // Published handle is the standalone copy, never the live attachment — see
    // DEPTH_COPY_FRAG for why. Kept non-null across a resize so a consumer that
    // latched it at init does not have to re-read it.
    this.ext.depthTexture = this.targets.get('sceneDepth', w, h, 'r32f', {
      nearest: true,
    }).texture;
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

    /*
     * Raw handle for the render-correctness probes, GATED. This used to be set
     * unconditionally in the constructor, which shipped every internal render
     * target and pass of the post stack on `globalThis` in a production build.
     *
     * It cannot be gated in the constructor: settings arrive after boot, so a
     * construction-time check would be false for every probe and the handle
     * would never appear. Gating here instead costs one comparison a frame and
     * tracks the setting live.
     *
     * WHAT THIS BREAKS: the fifteen `.tmp/*.mjs` probes that reach for
     * `window.__rcPipe` must now set `world.settings.debug = true` and let one
     * frame pass first. `.tmp/bench.mjs`, `slope.mjs`, `gpubudget.mjs`,
     * `stall.mjs`, `expcost.mjs`, `exptime.mjs`, `aetest.mjs`, `final.mjs`,
     * `floor.mjs`, `gap.mjs`, `wallab.mjs`, `storm.mjs`, `stormbudget.mjs`,
     * `fbudget.mjs`, `gpuab.mjs`. Note DIAGNOSIS 25 #5: `settings.debug` also
     * arms a synchronous readback costing 117-370 ms every 60 frames, so any
     * probe that wants the handle AND a timing must read `ext.post.profile()`
     * rather than wall-clock frame periods.
     */
    const g = globalThis as unknown as Record<string, unknown>;
    if (s.debug) g.__rcPipe = this;
    else if (g.__rcPipe === this) delete g.__rcPipe;

    const camExt = world.ext.camera as
      | { cut?: boolean; underwater?: number }
      | undefined;
    if (camExt?.cut) {
      this.aa.reset = true;
      this.hasPrevFrame = false;
    }

    // 1. CPU-side exposure ESTIMATE, for the HUD and for probes. The value the
    // frame is actually graded with lives in a 1x1 texture on the GPU and is
    // never read back — see AutoExposure.
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

    // 2b. depth out of the attachment and into a plain texture, so scene-pass
    // consumers (soft particles, refraction) can sample it next frame without
    // forming a framebuffer feedback loop. Cheap enough not to gate.
    if (scene.depthTexture) {
      const depthCopy = this.targets.get('sceneDepth', this.width, this.height, 'r32f', {
        nearest: true,
      });
      prof.begin('depthCopy');
      this.depthCopy.uniforms.tDepth.value = scene.depthTexture;
      this.depthCopy.render(r, depthCopy);
      prof.end();
      this.ext.depthTexture = depthCopy.texture;
    }

    // Unjittered matrices, for velocity and for next frame's reprojection.
    this.curViewProj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.invViewProj.copy(this.curViewProj).invert();

    // 3. metering runs on pre-exposure radiance, so it cannot feed back. The
    // adapt pass inside run() must precede prepare, which samples what it writes.
    prof.begin('exposure');
    this.exposure.run(world, scene);
    prof.end();
    const exposureTex = this.exposure.texture;

    // 4. exposure + firefly clamp
    let cur = this.targets.get('work0', this.width, this.height, 'rgba16f');
    let alt = this.targets.get('work1', this.width, this.height, 'rgba16f');
    prof.begin('prepare');
    this.prepare.uniforms.tScene.value = scene.texture;
    this.prepare.uniforms.tExposure.value = exposureTex;
    this.prepare.render(r, cur);
    prof.end();
    let curTex: THREE.Texture = cur.texture;

    const depthTex = scene.depthTexture ?? null;

    /*
     * 5. velocity — ONE buffer, with the reference frame chosen per pixel.
     *
     * TAA and motion blur used to want different answers here and the buffer was
     * written twice: world reprojection for TAA, the ship's frame for motion
     * blur. That was two half-right answers. Reprojection asks where a pixel's
     * material point was last frame, and world-static content and
     * ship-rigid content have genuinely different answers — but they are
     * different PIXELS, so one buffer can carry both. `VELOCITY_FRAG` classifies
     * them against the ship's geometric envelope; both consumers now read a
     * buffer that is right everywhere, and the second full-screen write is gone.
     *
     * `uShipViewProj` composes the previous view-projection with
     * `prevShip * curShip^-1`, which sends a point rigid with the ship to where
     * that material point was on the previous frame's screen.
     */
    this.curShip.compose(world.ship.position, world.ship.quaternion, this.unitScale);
    this.worldToShip.copy(this.curShip).invert();
    const velRt =
      (this.aa.needsVelocity || s.motionBlur) && depthTex !== null
        ? this.targets.get('velocity', this.width, this.height, 'rg16f', { nearest: true })
        : null;
    let velocityTex: THREE.Texture | null = null;
    if (velRt && depthTex) {
      this.updateShipEnvelope(world);
      const u = this.velocity.uniforms;
      u.tDepth.value = depthTex;
      (u.uInvViewProj.value as THREE.Matrix4).copy(this.invViewProj);
      (u.uCamPos.value as THREE.Vector3).setFromMatrixPosition(cam.matrixWorld);
      (u.uJitter.value as THREE.Vector2).copy(this.jitter.ndc);
      (u.uWorldToShip.value as THREE.Matrix4).copy(this.worldToShip);
      this.shipDelta.copy(this.worldToShip).premultiply(this.prevShip);
      this.shipViewProj.multiplyMatrices(
        this.hasPrevFrame ? this.prevViewProj : this.curViewProj,
        this.shipDelta,
      );
      (u.uPrevViewProj.value as THREE.Matrix4).copy(
        this.hasPrevFrame ? this.prevViewProj : this.curViewProj,
      );
      (u.uShipViewProj.value as THREE.Matrix4).copy(
        this.hasPrevFrame ? this.shipViewProj : this.curViewProj,
      );
      (u.uPrevCamPos.value as THREE.Vector3).copy(
        this.hasPrevFrame ? this.prevCamPos : (u.uCamPos.value as THREE.Vector3),
      );
      prof.begin('velocity');
      this.velocity.render(r, velRt);
      prof.end();
      velocityTex = velRt.texture;
    }

    // 6. anti-aliasing
    prof.begin(`aa:${s.antialias}`);
    const aaTex = this.aa.render(
      r,
      s,
      curTex,
      depthTex,
      velocityTex,
      alt,
      this.jitter.pixels,
      exposureTex,
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
      const wrote = this.dof.render(
        r,
        world,
        curTex,
        depthTex,
        alt,
        budget.dofTaps,
        this.ext.dofNearRamp,
      );
      prof.end();
      if (wrote) {
        const t = cur;
        cur = alt;
        alt = t;
        curTex = cur.texture;
      }
    }

    // 8. motion blur — reads the same per-pixel buffer TAA does; see step 5.
    if (s.motionBlur && velRt && velocityTex && depthTex && this.hasPrevFrame) {
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
        world.time.dt,
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
      this.renderUnderwater(world, curTex, depthTex, alt, submerged, exposureTex);
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
    this.prevShip.copy(this.curShip);
    this.hasPrevFrame = true;

    prof.writeStats(world.stats);
    this.tickProfile();
  }

  /**
   * The ship's geometric envelope in ship-local metres, for the velocity pass's
   * per-pixel reference-frame decision.
   *
   * Two boxes come out of one traverse. The **envelope** is everything under
   * `world.shipRoot`; that is the volume in which a pixel may be ship. The
   * **waterline** box is the union of only those parts that reach below the
   * design waterline — the copper, the topsides, the keel — which is a
   * data-driven way of asking "how wide and how long is the hull where it meets
   * the sea", with no knowledge of the ship module's dimension tables. Together
   * they say: inside the envelope is ship, except at sea level outside the
   * hull's own footprint, which is water.
   *
   * Read off the blackboard (`world.shipRoot`), so no subsystem is imported. The
   * rigging, sails and ensign draw from instance attributes and are displaced in
   * the vertex shader, so their CPU bounding boxes are unit templates and
   * contribute nothing — the measurable envelope is the hull's and the spars',
   * which is why `SHIP_BOX_PAD_M` exists.
   */
  private updateShipEnvelope(world: World): void {
    const frame = world.time.frame;
    if (frame - this.shipBoxFrame >= SHIP_BOX_REFRESH_FRAMES) {
      this.shipBoxFrame = frame;
      this.shipBox.makeEmpty();
      this.shipWaterlineBox.makeEmpty();
      world.shipRoot.traverse((o) => {
        const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
        if (!g) return;
        if (!g.boundingBox) g.computeBoundingBox();
        if (!g.boundingBox) return;
        this.shipBoxPart.copy(g.boundingBox);
        this.shipBoxPart.applyMatrix4(
          this.shipBoxMat.multiplyMatrices(this.worldToShip, o.matrixWorld),
        );
        this.shipBox.union(this.shipBoxPart);
        if (this.shipBoxPart.min.y < 0) this.shipWaterlineBox.union(this.shipBoxPart);
      });
      if (!this.shipBox.isEmpty()) {
        this.shipBox.expandByScalar(SHIP_BOX_PAD_M);
        this.shipWaterlineBox.expandByScalar(SHIP_BOX_PAD_M);
      }
    }

    // Written every frame, not just on a rebuild, so the ext override takes
    // effect on the next frame rather than at the next rebuild.
    const u = this.velocity.uniforms;
    const min = u.uShipBoxMin.value as THREE.Vector3;
    const max = u.uShipBoxMax.value as THREE.Vector3;
    const mode = this.ext.velocityFrame;
    if (mode === 'world' || this.shipBox.isEmpty()) {
      // An inverted box is never entered, so every pixel takes world.
      min.setScalar(1e30);
      max.setScalar(-1e30);
      u.uSeaBand.value = 0;
    } else if (mode === 'ship') {
      min.setScalar(-1e30);
      max.setScalar(1e30);
      u.uSeaBand.value = 0;
    } else {
      min.copy(this.shipBox.min);
      max.copy(this.shipBox.max);
      // No part of the hull reaching the waterline means there is no footprint
      // to protect and the sea-level exception could only misfire.
      u.uSeaBand.value = this.shipWaterlineBox.isEmpty() ? 0 : SEA_BAND_M;
      (u.uShipWaterline.value as THREE.Vector4).set(
        this.shipWaterlineBox.min.x,
        this.shipWaterlineBox.min.z,
        this.shipWaterlineBox.max.x,
        this.shipWaterlineBox.max.z,
      );
    }
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
    this.composite.uniforms.uSplitAmount.value =
      SPLIT_TONE_AMOUNT * (1 - clamp01(env.cloudCover) * 0.35);
  }

  private renderUnderwater(
    world: World,
    source: THREE.Texture,
    depth: THREE.Texture,
    dst: THREE.WebGLRenderTarget,
    amount: number,
    exposureTex: THREE.Texture,
  ): void {
    const p = this.getUnderwater();
    const u = p.uniforms;
    u.tColor.value = source;
    u.tDepth.value = depth;
    u.tExposure.value = exposureTex;
    (u.uTexelSize.value as THREE.Vector2).set(1 / this.width, 1 / this.height);
    (u.uDepthRange.value as THREE.Vector2).set(world.camera.near, world.camera.far);
    u.uAmount.value = amount;
    u.uTime.value = world.time.elapsed;
    u.uAspect.value = this.width / this.height;
    // The medium is lit by whatever is above it. Left in scene-linear radiance;
    // the shader brings it into exposed units from the adaptation texture.
    this.scatterColor.copy(world.uniforms.uSkyColor.value).multiplyScalar(0.22);
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
        tExposure: { value: null },
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
    this.depthCopy.dispose();
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
