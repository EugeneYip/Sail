import * as THREE from 'three';
import type { World } from '../types';
import { clamp01 } from '../util/math';
import type { VfxCtx } from './Context';
import { HULL } from './Context';
import {
  rippleFrag,
  rippleVert,
  wakeDecayFrag,
  wakeRibbonFrag,
  wakeRibbonVert,
  wakeStampFrag,
  wakeStampVert,
} from './shaders/wake';

/** Metres across the whole wake texture. Constant across quality tiers. */
export const WAKE_WORLD_SIZE = 1024;
/** Arc length of the track we keep, metres. Must stay well under WAKE_WORLD_SIZE. */
const TRACK_LENGTH = 520;
/**
 * Radius, metres, beyond which a consumer MUST fade the field to zero. Set just
 * inside the track length: past this there is nothing real in the buffer, and
 * because the buffer is a torus a further tap wraps onto the near-field wake.
 */
export const WAKE_FADE_RADIUS = 600;
const TRACK_SPACING = 2.5;
const TRACK_ROWS = Math.round(TRACK_LENGTH / TRACK_SPACING); // 208
const RIB_VERTS = 41;
/** Seconds for a stationary ship's wake to fade out. */
const WAKE_LIFE = 62;

const INTERACTION_WORLD_SIZE = 128;
const MAX_RIPPLES = 384;
const MAX_STAMPS = 128;

/**
 * Edge length of the persistent field, per tier. The field always spans
 * `WAKE_WORLD_SIZE`, so this is really a texel size: 1024 is 1 m/texel.
 *
 * ULTRA IS 1024, NOT 1536, AND THAT IS A MEASURED TRADE. The whole target is
 * decayed by one pass every frame and the foam ribbon is re-stamped into it, so
 * the cost is quadratic in this number and **none of it scales with the backing
 * store**. Paired A/B at 1600x900 dpr 2, ultra, noon, on a quiet box
 * (`.tmp/fixedsplit.mjs --only wake1024,wake768,wake512 --paired 4`) puts
 * 1536 -> 1024 at **1.75 ms of FIXED frame cost** — 22 per cent of the whole
 * 7.9 ms non-pixel term the engine pays before a pixel of the main render, and
 * the second largest single item in it after the sun's shadow map. 768 and 512
 * buy only 0.45 ms more between them, so 1024 is the knee of the curve.
 *
 * What it costs is the texel of the PERSISTENT field only, 0.67 m -> 1.0 m, and
 * that field carries nothing sub-metre in the first place. Two reasons, both
 * already in the code:
 *   - the fine near-hull detail is not here. It is in `interaction`, 128 m over
 *     `interactionRes` = 0.25 m/texel, which this does not touch.
 *   - the foam channel is a COVERAGE, and `ocean/shaders/surface.ts` thresholds
 *     the ocean's own high-frequency field against it
 *     ('linstep(thr - wThr, thr + wThr, decide)') rather than drawing it as an
 *     alpha, exactly as the contract in `index.ts` demands. The wake's texel
 *     therefore sets the envelope, never the edge.
 * What is left in the persistent field is the Kelvin pattern, whose divergent
 * arms are tens of metres apart, and `high` has always shipped 1024. See
 * DIAGNOSIS 64 for the whole fixed/variable split this came out of, and for the
 * measured null: the same 1300x540 wake crop reads a high-frequency energy of
 * 6.049 at 1024 against 5.974 at 1536, 1.3 per cent apart and in the wrong
 * direction for a resolution loss.
 */
function wakeRes(quality: string): number {
  switch (quality) {
    case 'low':
      return 512;
    case 'medium':
      return 768;
    default:
      return 1024;
  }
}

const _v2 = new THREE.Vector2();
const _clearColor = new THREE.Color();

/**
 * The wake field. Everything the ocean needs to deform and foam its surface
 * where the ship has been.
 *
 * Design notes:
 *  - The buffer is a torus in *true voyage* space, so it never resamples itself
 *    and is immune to floating-origin jumps. The anchor only moves in whole
 *    multiples of WAKE_WORLD_SIZE, which leaves fract() unchanged.
 *  - Foam is persistent (decayed each frame, topped up by the ribbon with a MAX
 *    blend so it saturates at 1 instead of running away).
 *  - Height and slope are *not* accumulated: the coherent Kelvin pattern is
 *    stationary in the ship's frame, so it is zeroed and re-rendered every
 *    frame from the track ribbon. That is what keeps it crisp and lets it
 *    curve with the ship's actual path.
 */
export class WakeField {
  target!: THREE.WebGLRenderTarget;
  interaction!: THREE.WebGLRenderTarget;

  /**
   * Global multiplier the consumer should apply to the whole field. 1 while the
   * ship is making way; ramped down when the wake is not worth compositing so
   * the ocean can skip the taps entirely.
   */
  strength = 0;

  readonly matrix = new THREE.Matrix3();
  readonly interactionMatrix = new THREE.Matrix3();
  readonly anchor = new THREE.Vector2();
  /** World XZ of the newest track sample. Published so consumers can fade by distance. */
  readonly centre = new THREE.Vector2();
  readonly interactionCentre = new THREE.Vector2();
  readonly interactionWorldSize = INTERACTION_WORLD_SIZE;

  private res = 1024;
  private interactionRes = 512;

  private scene = new THREE.Scene();
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  private quad!: THREE.Mesh;
  private decayMat!: THREE.RawShaderMaterial;

  private ribbon!: THREE.Mesh;
  private ribbonFoamMat!: THREE.RawShaderMaterial;
  private ribbonHeightMat!: THREE.RawShaderMaterial;

  private stampMesh!: THREE.Mesh;
  private stampGeo!: THREE.InstancedBufferGeometry;
  private stampCentre!: THREE.InstancedBufferAttribute;
  private stampShape!: THREE.InstancedBufferAttribute;
  private stampCount = 0;

  private rippleMesh!: THREE.Mesh;
  private rippleGeo!: THREE.InstancedBufferGeometry;
  private rippleAttr!: THREE.InstancedBufferAttribute;
  private rippleParam!: THREE.InstancedBufferAttribute;
  private rippleHead = 0;
  private rippleLive = 0;

  private trackTex!: THREE.DataTexture;
  private trackData!: Float32Array;
  private trackHead = 0;
  private trackFilled = 0;
  private sNow = 0;
  private lastSampleX = 0;
  private lastSampleZ = 0;
  private lastHeading = 0;
  private lastOrigin = new THREE.Vector3();

  private aabb = new THREE.Box2();
  private foamTex!: THREE.Texture;

  init(world: World, foamTex: THREE.Texture): void {
    this.foamTex = foamTex;
    this.res = wakeRes(world.settings.quality);
    this.interactionRes = world.settings.quality === 'low' || world.settings.quality === 'medium' ? 256 : 512;

    this.target = this.makeTarget(this.res, THREE.RepeatWrapping);
    this.interaction = this.makeTarget(this.interactionRes, THREE.ClampToEdgeWrapping);

    this.buildQuad();
    this.buildRibbon();
    this.buildStamps();
    this.buildRipples();

    this.anchor.set(world.ship.position.x, world.ship.position.z);
    this.lastSampleX = world.ship.position.x;
    this.lastSampleZ = world.ship.position.z;
    this.lastOrigin.copy(world.origin);
    this.resetTrack(world);
    this.clearTargets(world);
  }

  private makeTarget(res: number, wrap: THREE.Wrapping): THREE.WebGLRenderTarget {
    const rt = new THREE.WebGLRenderTarget(res, res, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      depthBuffer: false,
      stencilBuffer: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: wrap,
      wrapT: wrap,
      generateMipmaps: false,
      colorSpace: THREE.NoColorSpace,
    });
    return rt;
  }

  private buildQuad(): void {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
    );
    this.decayMat = new THREE.RawShaderMaterial({
      uniforms: { uDecay: { value: 0.99 } },
      vertexShader: `precision highp float; attribute vec3 position; void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: wakeDecayFrag,
      depthTest: false,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.ZeroFactor,
      blendDst: THREE.SrcColorFactor,
      blendEquationAlpha: THREE.AddEquation,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.SrcAlphaFactor,
    });
    this.quad = new THREE.Mesh(geo, this.decayMat);
    this.quad.frustumCulled = false;
  }

  private buildRibbon(): void {
    const rows = TRACK_ROWS;
    const lat = RIB_VERTS;
    const verts = (rows + 1) * lat;
    // `position` carries (trackRow, lateralParam, 0) — no real vertex position
    // exists on the CPU side; the vertex shader builds it from the track texture.
    const pos = new Float32Array(verts * 3);
    let p = 0;
    for (let r = 0; r <= rows; r++) {
      for (let l = 0; l < lat; l++) {
        pos[p++] = r;
        pos[p++] = (l / (lat - 1)) * 2 - 1;
        pos[p++] = 0;
      }
    }
    const idx = new Uint32Array(rows * (lat - 1) * 6);
    let q = 0;
    for (let r = 0; r < rows; r++) {
      for (let l = 0; l < lat - 1; l++) {
        const a = r * lat + l;
        const b = a + 1;
        const c = a + lat;
        const d = c + 1;
        idx[q++] = a;
        idx[q++] = c;
        idx[q++] = b;
        idx[q++] = b;
        idx[q++] = c;
        idx[q++] = d;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));

    this.trackData = new Float32Array(TRACK_ROWS * 3 * 4);
    this.trackTex = new THREE.DataTexture(
      this.trackData,
      TRACK_ROWS,
      3,
      THREE.RGBAFormat,
      THREE.FloatType,
    );
    this.trackTex.minFilter = this.trackTex.magFilter = THREE.NearestFilter;
    this.trackTex.wrapS = this.trackTex.wrapT = THREE.ClampToEdgeWrapping;
    this.trackTex.colorSpace = THREE.NoColorSpace;
    this.trackTex.needsUpdate = true;

    const shared = () => ({
      tTrack: { value: this.trackTex },
      tFoam: { value: this.foamTex },
      uRows: { value: TRACK_ROWS },
      uHead: { value: 0 },
      uSNow: { value: 0 },
      uMaxXi: { value: TRACK_LENGTH },
      uAnchor: { value: this.anchor },
      uWakeSize: { value: WAKE_WORLD_SIZE },
      uUvOffset: { value: new THREE.Vector2() },
      uTime: { value: 0 },
      uDt: { value: 1 / 60 },
      uLwl: { value: HULL.lwl },
      uBeam: { value: 13.3 },
      uAmp: { value: 0.3 },
      uSrcDepth: { value: 2.4 },
      uCoreLen: { value: 140 },
      uSpeedN: { value: 0 },
      uChop: { value: 0.5 },
      uWakeLife: { value: WAKE_LIFE },
    });

    this.ribbonFoamMat = new THREE.RawShaderMaterial({
      defines: { WAKE_PASS_FOAM: '' },
      uniforms: shared(),
      vertexShader: wakeRibbonVert,
      fragmentShader: wakeRibbonFrag,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendEquation: THREE.MaxEquation,
      blendEquationAlpha: THREE.MaxEquation,
    });
    this.ribbonHeightMat = new THREE.RawShaderMaterial({
      uniforms: shared(),
      vertexShader: wakeRibbonVert,
      fragmentShader: wakeRibbonFrag,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendEquationAlpha: THREE.AddEquation,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneFactor,
    });
    // The two passes share every uniform object except the output mode, so one
    // write per frame updates both.
    this.ribbonHeightMat.uniforms = this.ribbonFoamMat.uniforms;

    this.ribbon = new THREE.Mesh(geo, this.ribbonFoamMat);
    this.ribbon.frustumCulled = false;
  }

  private quadInstanced(): THREE.InstancedBufferGeometry {
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute(
      'position',
      new THREE.BufferAttribute(
        new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
        3,
      ),
    );
    geo.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));
    geo.instanceCount = 0;
    return geo;
  }

  private buildStamps(): void {
    this.stampGeo = this.quadInstanced();
    this.stampCentre = new THREE.InstancedBufferAttribute(new Float32Array(MAX_STAMPS * 4), 4);
    this.stampShape = new THREE.InstancedBufferAttribute(new Float32Array(MAX_STAMPS * 2), 2);
    this.stampCentre.setUsage(THREE.DynamicDrawUsage);
    this.stampShape.setUsage(THREE.DynamicDrawUsage);
    this.stampGeo.setAttribute('aCentre', this.stampCentre);
    this.stampGeo.setAttribute('aShape', this.stampShape);
    const mat = new THREE.RawShaderMaterial({
      uniforms: {
        tFoam: { value: this.foamTex },
        uAnchor: { value: this.anchor },
        uWakeSize: { value: WAKE_WORLD_SIZE },
        uUvOffset: { value: new THREE.Vector2() },
      },
      vertexShader: wakeStampVert,
      fragmentShader: wakeStampFrag,
      depthTest: false,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendEquationAlpha: THREE.AddEquation,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneFactor,
    });
    this.stampMesh = new THREE.Mesh(this.stampGeo, mat);
    this.stampMesh.frustumCulled = false;
  }

  private buildRipples(): void {
    this.rippleGeo = this.quadInstanced();
    this.rippleAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_RIPPLES * 4), 4);
    this.rippleParam = new THREE.InstancedBufferAttribute(new Float32Array(MAX_RIPPLES * 4), 4);
    this.rippleAttr.setUsage(THREE.DynamicDrawUsage);
    this.rippleParam.setUsage(THREE.DynamicDrawUsage);
    this.rippleGeo.setAttribute('aRipple', this.rippleAttr);
    this.rippleGeo.setAttribute('aParams', this.rippleParam);
    const mat = new THREE.RawShaderMaterial({
      uniforms: {
        uOrigin: { value: this.interactionCentre },
        uSize: { value: INTERACTION_WORLD_SIZE },
      },
      vertexShader: rippleVert,
      fragmentShader: rippleFrag,
      depthTest: false,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendEquationAlpha: THREE.AddEquation,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneFactor,
    });
    this.rippleMesh = new THREE.Mesh(this.rippleGeo, mat);
    this.rippleMesh.frustumCulled = false;
  }

  /* ----------------------------------------------------------------- *
   *  Public injection API
   * ----------------------------------------------------------------- */

  /** One-shot additive foam patch in the persistent field. */
  addFoam(x: number, z: number, radius: number, strength: number, soft = 0.5): void {
    if (this.stampCount >= MAX_STAMPS) return;
    const i = this.stampCount++;
    const c = this.stampCentre.array as Float32Array;
    const s = this.stampShape.array as Float32Array;
    c[i * 4] = x;
    c[i * 4 + 1] = z;
    c[i * 4 + 2] = radius;
    c[i * 4 + 3] = strength;
    s[i * 2] = soft;
    s[i * 2 + 1] = Math.random() * 10;
  }

  /**
   * An expanding ring ripple in the fine interaction field.
   * `kind` 0 = rain drop, 1 = heavy impact (splash, cannon shot, spray sheet).
   */
  addRipple(x: number, z: number, strength: number, radius: number, wavelength: number, kind = 0): void {
    const i = this.rippleHead;
    this.rippleHead = (this.rippleHead + 1) % MAX_RIPPLES;
    this.rippleLive = Math.min(this.rippleLive + 1, MAX_RIPPLES);
    const a = this.rippleAttr.array as Float32Array;
    const p = this.rippleParam.array as Float32Array;
    a[i * 4] = x;
    a[i * 4 + 1] = z;
    a[i * 4 + 2] = 0;
    a[i * 4 + 3] = strength;
    p[i * 4] = radius;
    p[i * 4 + 1] = wavelength;
    p[i * 4 + 2] = kind;
    p[i * 4 + 3] = Math.random();
  }

  /* ----------------------------------------------------------------- *
   *  Frame
   * ----------------------------------------------------------------- */

  private resetTrack(world: World): void {
    const x = world.ship.position.x;
    const z = world.ship.position.z;
    for (let i = 0; i < TRACK_ROWS; i++) {
      this.writeRow(i, x, z, 0, 0, 0, -1, 0, 120, 0, 0, 0);
    }
    this.trackFilled = 0;
    this.trackTex.needsUpdate = true;
  }

  private writeRow(
    i: number,
    x: number,
    z: number,
    sLaid: number,
    speed: number,
    tanX: number,
    tanZ: number,
    heel: number,
    maxHalf: number,
    rudder: number,
    valid: number,
    age: number,
  ): void {
    const d = this.trackData;
    const r0 = i * 4;
    const r1 = (TRACK_ROWS + i) * 4;
    const r2 = (TRACK_ROWS * 2 + i) * 4;
    d[r0] = x;
    d[r0 + 1] = z;
    d[r0 + 2] = sLaid;
    d[r0 + 3] = speed;
    d[r1] = tanX;
    d[r1 + 1] = tanZ;
    d[r1 + 2] = heel;
    d[r1 + 3] = maxHalf;
    d[r2] = rudder;
    d[r2 + 1] = valid;
    d[r2 + 2] = age;
    d[r2 + 3] = 0;
  }

  update(ctx: VfxCtx): void {
    const world = ctx.world;
    const dt = ctx.dt;

    // --- floating origin: rendered-world coordinates all shift by -delta.
    const dox = world.origin.x - this.lastOrigin.x;
    const doz = world.origin.z - this.lastOrigin.z;
    if (dox !== 0 || doz !== 0) {
      this.shiftWorld(-dox, -doz);
      this.lastOrigin.copy(world.origin);
    }

    this.advanceTrack(ctx);
    this.ageRipples(dt);

    // --- anchor moves only in whole texture periods, so fract() is invariant.
    const bx = ctx.bow.x;
    const bz = ctx.bow.z;
    this.centre.set(bx, bz);
    this.anchor.x += WAKE_WORLD_SIZE * Math.floor((bx - this.anchor.x) / WAKE_WORLD_SIZE);
    this.anchor.y += WAKE_WORLD_SIZE * Math.floor((bz - this.anchor.y) / WAKE_WORLD_SIZE);
    const inv = 1 / WAKE_WORLD_SIZE;
    this.matrix.set(inv, 0, -this.anchor.x * inv, 0, inv, -this.anchor.y * inv, 0, 0, 1);

    // --- interaction window follows the camera, snapped to whole texels.
    const camPos = world.camera.position;
    const step = INTERACTION_WORLD_SIZE / this.interactionRes;
    this.interactionCentre.set(
      Math.floor((camPos.x - INTERACTION_WORLD_SIZE * 0.5) / step) * step,
      Math.floor((camPos.z - INTERACTION_WORLD_SIZE * 0.5) / step) * step,
    );
    const iinv = 1 / INTERACTION_WORLD_SIZE;
    this.interactionMatrix.set(
      iinv, 0, -this.interactionCentre.x * iinv,
      0, iinv, -this.interactionCentre.y * iinv,
      0, 0, 1,
    );

    this.writeUniforms(ctx);
    this.render(ctx);
  }

  private shiftWorld(dx: number, dz: number): void {
    this.anchor.x += dx;
    this.anchor.y += dz;
    const d = this.trackData;
    for (let i = 0; i < TRACK_ROWS; i++) {
      d[i * 4] += dx;
      d[i * 4 + 1] += dz;
    }
    this.trackTex.needsUpdate = true;
    const a = this.rippleAttr.array as Float32Array;
    for (let i = 0; i < MAX_RIPPLES; i++) {
      a[i * 4] += dx;
      a[i * 4 + 1] += dz;
    }
    this.rippleAttr.needsUpdate = true;
    this.lastSampleX += dx;
    this.lastSampleZ += dz;
  }

  /** Push new track samples every TRACK_SPACING metres of bow travel. */
  private advanceTrack(ctx: VfxCtx): void {
    const bx = ctx.bow.x;
    const bz = ctx.bow.z;
    const dt = ctx.dt;
    const d = this.trackData;

    // Age every live row so a stopped ship's wake still dissipates.
    for (let i = 0; i < TRACK_ROWS; i++) {
      const r2 = (TRACK_ROWS * 2 + i) * 4;
      if (d[r2 + 1] > 0) d[r2 + 2] += dt;
    }

    let moved = Math.hypot(bx - this.lastSampleX, bz - this.lastSampleZ);
    let guard = 0;
    while (moved >= TRACK_SPACING && guard++ < 8) {
      const f = TRACK_SPACING / moved;
      const nx = this.lastSampleX + (bx - this.lastSampleX) * f;
      const nz = this.lastSampleZ + (bz - this.lastSampleZ) * f;
      const tanX = (nx - this.lastSampleX) / TRACK_SPACING;
      const tanZ = (nz - this.lastSampleZ) / TRACK_SPACING;
      const heading = Math.atan2(tanX, tanZ);
      let dHead = heading - this.lastHeading;
      while (dHead > Math.PI) dHead -= Math.PI * 2;
      while (dHead < -Math.PI) dHead += Math.PI * 2;
      this.lastHeading = heading;
      // Curvature limits how wide the rib may be before neighbouring ribs
      // cross over on the inside of a turn.
      const kappa = Math.abs(dHead) / TRACK_SPACING;
      const maxHalf = Math.min(240, 0.8 / Math.max(kappa, 3e-3));

      this.sNow += TRACK_SPACING;
      this.trackHead = (this.trackHead + 1) % TRACK_ROWS;
      this.trackFilled = Math.min(this.trackFilled + 1, TRACK_ROWS);
      this.writeRow(
        this.trackHead,
        nx,
        nz,
        this.sNow,
        Math.max(ctx.speed, 1.0),
        tanX,
        tanZ,
        ctx.heel,
        maxHalf,
        ctx.rudder,
        1,
        0,
      );

      this.lastSampleX = nx;
      this.lastSampleZ = nz;
      moved = Math.hypot(bx - this.lastSampleX, bz - this.lastSampleZ);
    }
    this.trackTex.needsUpdate = true;
  }

  private ageRipples(dt: number): void {
    if (this.rippleLive === 0) return;
    const a = this.rippleAttr.array as Float32Array;
    const p = this.rippleParam.array as Float32Array;
    let live = 0;
    for (let i = 0; i < MAX_RIPPLES; i++) {
      if (a[i * 4 + 3] <= 0) continue;
      a[i * 4 + 2] += dt;
      // Ripples are analytic in age; retire them once the envelope is spent.
      if (a[i * 4 + 2] > 2.6) {
        a[i * 4 + 3] = 0;
        p[i * 4] = 0;
      } else live++;
    }
    this.rippleLive = live;
    this.rippleAttr.needsUpdate = true;
    this.rippleParam.needsUpdate = true;
  }

  private writeUniforms(ctx: VfxCtx): void {
    const u = this.ribbonFoamMat.uniforms;
    const world = ctx.world;
    const speedN = ctx.speedN;

    u.uHead.value = this.trackHead;
    u.uSNow.value = this.sNow;
    u.uTime.value = world.time.elapsed;
    u.uDt.value = ctx.dt;
    u.uBeam.value = world.ship.beam;
    u.uSpeedN.value = speedN;
    u.uChop.value = world.env.choppiness;
    // Wave-making amplitude climbs steeply with Froude number, then the wake
    // stops growing once the hull is at its own hull speed.
    u.uAmp.value = 0.62 * Math.pow(speedN, 1.55);
    u.uSrcDepth.value = world.ship.draught * 0.38;
    u.uCoreLen.value = THREE.MathUtils.lerp(60, 250, speedN) * THREE.MathUtils.lerp(1, 0.7, world.env.choppiness);

    // Foam persistence, e-folding seconds. Torn apart faster in a gale.
    //
    // THIS IS THE LENGTH OF THE WHITE PART OF THE WAKE, and it was the single
    // biggest reason the sea read as snow. The channel is MAX-blended into a
    // persistent buffer, so every world point the froth band swept over holds its
    // peak value until this decay eats it. The ocean's compositing goes visibly
    // white above about 0.20, and the peak written here is 0.78, so the white
    // trail runs for 1.34 * tau seconds of steaming — at tau = 22 s and 11 kn
    // that was 165 m of unbroken white water, a wake wider and longer than the
    // ship and brighter than the sails. Real white water astern of a frigate is
    // spent inside a ship length or two; what carries on is a slick and the
    // divergent arms, which the ribbon redraws every frame and does not need
    // persistence for. 9 s gives about 65 m at cruising speed.
    const tau = THREE.MathUtils.lerp(9, 4, clamp01(world.env.windSpeed / 24));
    this.decayMat.uniforms.uDecay.value = Math.exp(-ctx.dt / tau);

    // Published to the consumer. Non-zero while there is anything in the buffer
    // worth sampling: the ribbon may have stopped drawing but the persistent
    // foam channel still takes some 15 s to decay away.
    this.strength = this.trackFilled > 3 ? 1 : 0;
  }

  /** Integer wake-cell offsets the ribbon has to be drawn at to tile the torus. */
  private ribbonAabb(): THREE.Box2 {
    const d = this.trackData;
    const box = this.aabb;
    box.makeEmpty();
    for (let i = 0; i < TRACK_ROWS; i++) {
      const r2 = (TRACK_ROWS * 2 + i) * 4;
      if (d[r2 + 1] <= 0) continue;
      const r0 = i * 4;
      const r1 = (TRACK_ROWS + i) * 4;
      const xi = Math.max(this.sNow - d[r0 + 2], 0);
      // Must match `halfW` in wakeRibbonVert.
      const half = Math.min(10 + 0.62 * xi, d[r1 + 3]);
      _v2.set(d[r0] - half, d[r0 + 1] - half);
      box.expandByPoint(_v2);
      _v2.set(d[r0] + half, d[r0 + 1] + half);
      box.expandByPoint(_v2);
    }
    if (box.isEmpty()) {
      _v2.copy(this.anchor);
      box.setFromCenterAndSize(_v2, _v2.set(1, 1));
    }
    return box;
  }

  private render(ctx: VfxCtx): void {
    const r = ctx.world.renderer;
    const prevTarget = r.getRenderTarget();

    // --- persistent field: decay, event stamps, then the ribbon.
    r.setRenderTarget(this.target);
    this.scene.clear();

    this.quad.material = this.decayMat;
    this.scene.add(this.quad);
    r.render(this.scene, this.cam);
    this.scene.remove(this.quad);

    const box = this.ribbonAabb();
    const inv = 1 / WAKE_WORLD_SIZE;
    const u0 = Math.floor((box.min.x - this.anchor.x) * inv);
    const u1 = Math.floor((box.max.x - this.anchor.x) * inv);
    const v0 = Math.floor((box.min.y - this.anchor.y) * inv);
    const v1 = Math.floor((box.max.y - this.anchor.y) * inv);
    const cu1 = Math.min(u1, u0 + 1);
    const cv1 = Math.min(v1, v0 + 1);

    if (this.stampCount > 0) {
      this.stampGeo.instanceCount = this.stampCount;
      this.stampCentre.needsUpdate = true;
      this.stampShape.needsUpdate = true;
      const su = (this.stampMesh.material as THREE.RawShaderMaterial).uniforms.uUvOffset
        .value as THREE.Vector2;
      this.scene.add(this.stampMesh);
      for (let cu = u0; cu <= cu1; cu++) {
        for (let cv = v0; cv <= cv1; cv++) {
          su.set(-cu, -cv);
          r.render(this.scene, this.cam);
        }
      }
      this.scene.remove(this.stampMesh);
      this.stampCount = 0;
    }

    if (this.trackFilled > 3 && ctx.speedN > 0.005) {
      const ru = this.ribbonFoamMat.uniforms.uUvOffset.value as THREE.Vector2;
      this.scene.add(this.ribbon);
      for (let pass = 0; pass < 2; pass++) {
        this.ribbon.material = pass === 0 ? this.ribbonFoamMat : this.ribbonHeightMat;
        for (let cu = u0; cu <= cu1; cu++) {
          for (let cv = v0; cv <= cv1; cv++) {
            ru.set(-cu, -cv);
            r.render(this.scene, this.cam);
          }
        }
      }
      this.scene.remove(this.ribbon);
    }

    // --- interaction field: fully rebuilt from the analytic ripple pool.
    r.setRenderTarget(this.interaction);
    const prevClear = r.getClearColor(_clearColor);
    const prevAlpha = r.getClearAlpha();
    r.setClearColor(0x000000, 0);
    r.clear(true, false, false);
    if (this.rippleLive > 0) {
      this.rippleGeo.instanceCount = MAX_RIPPLES;
      this.scene.add(this.rippleMesh);
      r.render(this.scene, this.cam);
      this.scene.remove(this.rippleMesh);
    }
    r.setClearColor(prevClear, prevAlpha);

    r.setRenderTarget(prevTarget);
  }

  private clearTargets(world: World): void {
    const r = world.renderer;
    const prev = r.getRenderTarget();
    const prevClear = r.getClearColor(_clearColor);
    const prevAlpha = r.getClearAlpha();
    r.setClearColor(0x000000, 0);
    for (const t of [this.target, this.interaction]) {
      r.setRenderTarget(t);
      r.clear(true, false, false);
    }
    r.setClearColor(prevClear, prevAlpha);
    r.setRenderTarget(prev);
  }

  applySettings(world: World): void {
    const res = wakeRes(world.settings.quality);
    if (res !== this.res) {
      this.res = res;
      this.target.setSize(res, res);
      this.clearTargets(world);
    }
  }

  dispose(): void {
    this.target.dispose();
    this.interaction.dispose();
    this.trackTex.dispose();
    this.ribbon.geometry.dispose();
    this.ribbonFoamMat.dispose();
    this.ribbonHeightMat.dispose();
    this.decayMat.dispose();
    this.quad.geometry.dispose();
    this.stampGeo.dispose();
    (this.stampMesh.material as THREE.Material).dispose();
    this.rippleGeo.dispose();
    (this.rippleMesh.material as THREE.Material).dispose();
  }
}
