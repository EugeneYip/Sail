import * as THREE from 'three';
import type { QualityTier, World } from '../types';
import type { PostExt, VfxCtx } from './Context';
import {
  drawFrag,
  drawVert,
  emitFrag,
  emitVert,
  killFrag,
  simFrag,
  simVert,
} from './shaders/particles';
import type { VfxTextures } from './textures';
import type { WaterProbe } from './WaterProbe';

/**
 * One GPU-simulated particle pool for the whole VFX stack.
 *
 * Two passes plus one draw, regardless of how many particles are alive:
 *   1. sim   — fullscreen MRT step of position / velocity / parameters
 *   2. emit  — a `THREE.Points` draw of this frame's new particles into the
 *              same MRT, one point per particle, straight at its texel
 *   3. draw  — one instanced quad draw of the whole pool; dead slots emit a
 *              degenerate triangle in the vertex shader and cost nothing.
 *
 * Emitters (spray, rain, smoke, ordnance) only ever call `spawn()`, which
 * writes into preallocated scratch arrays. Nothing here allocates per frame.
 */

/** Texture edge length per quality tier; capacity is the square of this. */
function poolSize(q: QualityTier): number {
  switch (q) {
    case 'low':
      return 96; // 9.2k
    case 'medium':
      return 144; // 20.7k
    case 'high':
      return 200; // 40k
    default:
      return 248; // 61.5k
  }
}

/** Hard ceiling on particles born in a single frame. */
const MAX_EMIT = 2048;

/** Attribute names re-uploaded after emission. Hoisted: `end` must not allocate. */
const EMIT_ATTRS = ['position', 'aPos', 'aVel', 'aPar'] as const;

const _shift = new THREE.Vector3();

export class Particles {
  capacity = 0;
  /** Slots actually simulated and drawn, after `settings.particleDensity`. */
  active = 0;
  /** New particles this frame — read by the debug HUD. */
  emitted = 0;

  private texSize = 0;
  private rts: THREE.WebGLRenderTarget[] = [];
  private read = 0;

  private simScene = new THREE.Scene();
  private emitScene = new THREE.Scene();
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  private simMat!: THREE.RawShaderMaterial;
  private killMat!: THREE.RawShaderMaterial;
  private simQuad!: THREE.Mesh;

  private emitGeo!: THREE.BufferGeometry;
  private emitPoints!: THREE.Points;
  private ePos!: Float32Array;
  private eVel!: Float32Array;
  private ePar!: Float32Array;
  private eDst!: Float32Array;
  private head = 0;

  private drawMat!: THREE.RawShaderMaterial;
  private drawMesh!: THREE.Mesh;
  private drawGeo!: THREE.InstancedBufferGeometry;

  private lastOrigin = new THREE.Vector3();
  private supported = true;
  /** Whether the draw material is currently compiled with depth softness. */
  private depthSoft = false;

  init(world: World, tex: VfxTextures, probe: WaterProbe): void {
    this.supported = world.renderer.extensions.has('EXT_color_buffer_float');
    if (!this.supported) return;

    this.texSize = poolSize(world.settings.quality);
    this.capacity = this.texSize * this.texSize;
    this.active = this.capacity;
    this.lastOrigin.copy(world.origin);

    this.rts = [this.makeState(), this.makeState()];

    const tri = new THREE.BufferGeometry();
    tri.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
    );

    this.simMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        tPos: { value: null },
        tVel: { value: null },
        tPar: { value: null },
        tProbe: { value: probe.texture },
        uProbeMat: { value: probe.matrix },
        uDt: { value: 1 / 60 },
        uTime: { value: 0 },
        uAir: { value: new THREE.Vector3() },
        uTurb: { value: 0 },
        uShift: { value: new THREE.Vector3() },
      },
      vertexShader: simVert,
      fragmentShader: simFrag,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
    this.killMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: simVert,
      fragmentShader: killFrag,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
    this.simQuad = new THREE.Mesh(tri, this.simMat);
    this.simQuad.frustumCulled = false;
    this.simScene.add(this.simQuad);

    this.buildEmitter();
    this.buildDraw(world, tex, probe);
    this.clearPool(world);
  }

  private makeState(): THREE.WebGLRenderTarget {
    const rt = new THREE.WebGLRenderTarget(this.texSize, this.texSize, {
      count: 3,
      type: THREE.FloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
      colorSpace: THREE.NoColorSpace,
    });
    return rt;
  }

  private buildEmitter(): void {
    this.ePos = new Float32Array(MAX_EMIT * 3);
    this.eVel = new Float32Array(MAX_EMIT * 4);
    this.ePar = new Float32Array(MAX_EMIT * 4);
    this.eDst = new Float32Array(MAX_EMIT * 3);

    this.emitGeo = new THREE.BufferGeometry();
    const dst = new THREE.BufferAttribute(this.eDst, 3);
    const pos = new THREE.BufferAttribute(this.ePos, 3);
    const vel = new THREE.BufferAttribute(this.eVel, 4);
    const par = new THREE.BufferAttribute(this.ePar, 4);
    for (const a of [dst, pos, vel, par]) a.setUsage(THREE.DynamicDrawUsage);
    this.emitGeo.setAttribute('position', dst);
    this.emitGeo.setAttribute('aPos', pos);
    this.emitGeo.setAttribute('aVel', vel);
    this.emitGeo.setAttribute('aPar', par);
    this.emitGeo.setDrawRange(0, 0);
    this.emitGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 4);

    const mat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: emitVert,
      fragmentShader: emitFrag,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
    this.emitPoints = new THREE.Points(this.emitGeo, mat);
    this.emitPoints.frustumCulled = false;
    this.emitScene.add(this.emitPoints);
  }

  private buildDraw(world: World, tex: VfxTextures, probe: WaterProbe): void {
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute(
      'position',
      new THREE.BufferAttribute(
        new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
        3,
      ),
    );
    geo.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));
    const ids = new Float32Array(this.capacity);
    for (let i = 0; i < this.capacity; i++) ids[i] = i;
    geo.setAttribute('aId', new THREE.InstancedBufferAttribute(ids, 1));
    geo.instanceCount = this.capacity;
    this.drawGeo = geo;

    const post = world.ext.post as PostExt | undefined;
    const depth = post?.depthTexture ?? null;
    this.depthSoft = !!depth;

    this.drawMat = new THREE.RawShaderMaterial({
      defines: this.depthSoft ? { VFX_DEPTH_SOFT: '' } : {},
      uniforms: {
        ...world.uniforms,
        tPos: { value: null },
        tVel: { value: null },
        tPar: { value: null },
        tProbe: { value: probe.texture },
        uProbeMat: { value: probe.matrix },
        tDroplet: { value: tex.droplet },
        tMist: { value: tex.mist },
        tFleck: { value: tex.fleck },
        tSmoke: { value: tex.smoke },
        tDepth: { value: depth },
        uInvRes: { value: new THREE.Vector2(1, 1) },
        uNearFar: { value: new THREE.Vector2(post?.near ?? 0.25, post?.far ?? 60000) },
        uTexSize: { value: this.texSize },
        uStretch: { value: 0.02 },
        uSoftY: { value: 0.9 },
        uOpacity: { value: 1 },
      },
      vertexShader: drawVert,
      fragmentShader: drawFrag,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendEquationAlpha: THREE.AddEquation,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });

    this.drawMesh = new THREE.Mesh(geo, this.drawMat);
    this.drawMesh.frustumCulled = false;
    this.drawMesh.renderOrder = 20;
    this.drawMesh.name = 'vfx-particles';
    world.scene.add(this.drawMesh);
  }

  private clearPool(world: World): void {
    const r = world.renderer;
    const prev = r.getRenderTarget();
    this.simQuad.material = this.killMat;
    for (const rt of this.rts) {
      r.setRenderTarget(rt);
      r.render(this.simScene, this.cam);
    }
    this.simQuad.material = this.simMat;
    r.setRenderTarget(prev);
  }

  /* ----------------------------------------------------------------- *
   *  Emission
   * ----------------------------------------------------------------- */

  /**
   * Queue one particle. `drag` is the inverse aerodynamic response time: 0.4
   * for a fat droplet, 6 for atomised mist that goes straight to wind speed.
   * Returns false when the frame's emission budget is spent.
   */
  spawn(
    px: number, py: number, pz: number,
    vx: number, vy: number, vz: number,
    life: number, size: number, kind: number, drag: number,
  ): boolean {
    if (!this.supported || this.emitted >= MAX_EMIT || this.active === 0) return false;
    const i = this.emitted++;
    const slot = this.head;
    this.head = (this.head + 1) % this.active;

    const col = slot % this.texSize;
    const row = (slot - col) / this.texSize;
    this.eDst[i * 3] = ((col + 0.5) / this.texSize) * 2 - 1;
    this.eDst[i * 3 + 1] = ((row + 0.5) / this.texSize) * 2 - 1;
    this.eDst[i * 3 + 2] = 0;

    this.ePos[i * 3] = px;
    this.ePos[i * 3 + 1] = py;
    this.ePos[i * 3 + 2] = pz;
    this.eVel[i * 4] = vx;
    this.eVel[i * 4 + 1] = vy;
    this.eVel[i * 4 + 2] = vz;
    this.eVel[i * 4 + 3] = life;
    this.ePar[i * 4] = size;
    this.ePar[i * 4 + 1] = kind;
    this.ePar[i * 4 + 2] = Math.random();
    this.ePar[i * 4 + 3] = drag;
    return true;
  }

  get available(): boolean {
    return this.supported;
  }

  /**
   * Emission slots left this frame. Emitters must clamp their loop counts to
   * this — a rejected `spawn()` still costs all the CPU that produced its
   * arguments, and in a gale the raw rates ask for several times MAX_EMIT.
   */
  get room(): number {
    return this.supported ? MAX_EMIT - this.emitted : 0;
  }

  /* ----------------------------------------------------------------- *
   *  Frame
   * ----------------------------------------------------------------- */

  /** Called before the emitters run. */
  begin(ctx: VfxCtx): void {
    if (!this.supported) return;
    this.emitted = 0;
    const want = Math.max(1, Math.round(this.capacity * Math.min(1, ctx.density)));
    if (want !== this.active) {
      this.active = want;
      this.head = this.head % want;
      this.drawGeo.instanceCount = want;
    }
  }

  /** Called after every emitter has run. */
  end(ctx: VfxCtx, probe: WaterProbe): void {
    if (!this.supported) return;
    const world = ctx.world;
    const r = world.renderer;

    _shift.copy(world.origin).sub(this.lastOrigin).multiplyScalar(-1);
    this.lastOrigin.copy(world.origin);

    const su = this.simMat.uniforms;
    su.uDt.value = Math.min(ctx.dt, 1 / 24);
    su.uTime.value = world.time.elapsed;
    (su.uAir.value as THREE.Vector3).copy(ctx.windVel);
    (su.uShift.value as THREE.Vector3).copy(_shift);
    su.uTurb.value = 0.25 + ctx.windSpeed * 0.16;
    su.tProbe.value = probe.texture;
    su.uProbeMat.value = probe.matrix;

    const src = this.rts[this.read];
    const dst = this.rts[1 - this.read];
    su.tPos.value = src.textures[0];
    su.tVel.value = src.textures[1];
    su.tPar.value = src.textures[2];

    const prev = r.getRenderTarget();
    r.setRenderTarget(dst);
    r.render(this.simScene, this.cam);

    if (this.emitted > 0) {
      this.emitGeo.setDrawRange(0, this.emitted);
      for (let i = 0; i < EMIT_ATTRS.length; i++) {
        const a = this.emitGeo.getAttribute(EMIT_ATTRS[i]) as THREE.BufferAttribute;
        // Only the slice actually written this frame goes over the bus; the
        // pool arrays are MAX_EMIT long and a full re-upload is ~114 kB/frame.
        a.clearUpdateRanges();
        a.addUpdateRange(0, this.emitted * a.itemSize);
        a.needsUpdate = true;
      }
      r.render(this.emitScene, this.cam);
    }
    r.setRenderTarget(prev);
    this.read = 1 - this.read;

    const du = this.drawMat.uniforms;
    du.tPos.value = dst.textures[0];
    du.tVel.value = dst.textures[1];
    du.tPar.value = dst.textures[2];
    du.tProbe.value = probe.texture;
    du.uProbeMat.value = probe.matrix;
    // Motion stretch in view-space metres per (m/s); long exposure in the
    // dark, short in bright sun, which is also what a real shutter does.
    du.uStretch.value = 0.028;
    du.uSoftY.value = 0.75 + ctx.world.env.waveHeight * 0.14;
    (du.uInvRes.value as THREE.Vector2).set(1 / world.size.width, 1 / world.size.height);

    // The post stack publishes its depth copy only once it has allocated, and
    // reallocates it on a resize, so re-latch every frame rather than at init.
    const post = ctx.postExt;
    const depth = post?.depthTexture ?? null;
    du.tDepth.value = depth;
    (du.uNearFar.value as THREE.Vector2).set(post?.near ?? 0.25, post?.far ?? 60000);
    if (!!depth !== this.depthSoft) {
      this.depthSoft = !!depth;
      if (this.depthSoft) this.drawMat.defines.VFX_DEPTH_SOFT = '';
      else delete this.drawMat.defines.VFX_DEPTH_SOFT;
      this.drawMat.needsUpdate = true;
    }
  }

  applySettings(world: World, tex: VfxTextures, probe: WaterProbe): void {
    if (!this.supported) return;
    const size = poolSize(world.settings.quality);
    if (size === this.texSize) return;
    this.dispose();
    this.simScene.clear();
    this.emitScene.clear();
    this.init(world, tex, probe);
  }

  dispose(): void {
    if (!this.supported) return;
    for (const rt of this.rts) rt.dispose();
    this.rts.length = 0;
    this.simMat.dispose();
    this.killMat.dispose();
    this.simQuad.geometry.dispose();
    this.emitGeo.dispose();
    (this.emitPoints.material as THREE.Material).dispose();
    this.drawGeo.dispose();
    this.drawMat.dispose();
    this.drawMesh.removeFromParent();
  }
}
