import * as THREE from 'three';
import type { QualityTier, World } from '../types';
import { clamp01, damp, smoothstep } from '../util/math';
import type { VfxCtx } from './Context';
import type { Particles } from './Particles';
import { KIND } from './shaders/particles';
import { lensFrag, lensVert, rainFrag, rainVert } from './shaders/rain';
import type { VfxTextures } from './textures';
import type { WakeField } from './WakeField';
import type { WaterProbe } from './WaterProbe';

/**
 * Rain: falling streaks, the rings they punch in the sea, deck splashes,
 * drips shed off the rigging, and water on the lens.
 *
 * Two draw calls total — one instanced streak draw and one camera-locked quad
 * — plus emission into the shared particle pool for splashes and drips.
 */

/** Terminal velocity of a 2 mm drop, m/s. */
const FALL_SPEED = 8.4;
/** Far-layer box. Big enough to hide the wrap, small enough to stay dense. */
const BOX = new THREE.Vector3(38, 32, 38);

function streakCount(q: QualityTier): number {
  switch (q) {
    case 'low':
      return 1400;
    case 'medium':
      return 3000;
    case 'high':
      return 5200;
    default:
      return 8200;
  }
}

const _vel = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _local = new THREE.Vector3();
const _sun = new THREE.Vector3();

function wrap(v: number, m: number): number {
  return ((v % m) + m) % m;
}

export class Rain {
  private mesh!: THREE.Mesh;
  private geo!: THREE.InstancedBufferGeometry;
  private mat!: THREE.RawShaderMaterial;
  private maxStreaks = 0;

  private lens!: THREE.Mesh;
  private lensMat!: THREE.RawShaderMaterial;
  private lensAmount = 0;
  private lensDrift = new THREE.Vector2();
  private lastCamQuat = new THREE.Quaternion();

  private phase = new THREE.Vector3();
  private accRipple = 0;
  private accDeck = 0;
  private accDrip = 0;
  private accSplash = 0;

  init(world: World, tex: VfxTextures): void {
    this.maxStreaks = streakCount(world.settings.quality);

    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute(
      'position',
      new THREE.BufferAttribute(
        new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
        3,
      ),
    );
    geo.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));
    const seeds = new Float32Array(this.maxStreaks * 4);
    for (let i = 0; i < this.maxStreaks; i++) {
      seeds[i * 4] = Math.random();
      seeds[i * 4 + 1] = Math.random();
      seeds[i * 4 + 2] = Math.random();
      seeds[i * 4 + 3] = Math.random();
    }
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
    geo.instanceCount = 0;
    this.geo = geo;

    this.mat = new THREE.RawShaderMaterial({
      uniforms: {
        ...world.uniforms,
        tStreak: { value: tex.streak },
        uBox: { value: BOX.clone() },
        uOffset: { value: new THREE.Vector3() },
        uOffsetNear: { value: new THREE.Vector3() },
        uVel: { value: new THREE.Vector3(0, -FALL_SPEED, 0) },
        uShear: { value: 0.012 },
        uWidth: { value: 0.011 },
        // Shutter time. Deliberately NOT called uExposure — that name belongs to
        // the shared uniform block spread in above, and shadowing it here both
        // redeclared the GLSL uniform and stole the post stack's exposure.
        uShutter: { value: 0.085 },
        uNearFrac: { value: 0.035 },
        uIntensity: { value: 0 },
      },
      vertexShader: rainVert,
      fragmentShader: rainFrag,
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

    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 22;
    this.mesh.name = 'vfx-rain';
    world.scene.add(this.mesh);

    /* ---- water on the lens ---- */
    const quad = new THREE.BufferGeometry();
    quad.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
    );
    this.lensMat = new THREE.RawShaderMaterial({
      uniforms: {
        ...world.uniforms,
        uIntensity: { value: 0 },
        uAspect: { value: new THREE.Vector2(1.78, 1) },
        uDrift: { value: new THREE.Vector2() },
        uSunUv: { value: new THREE.Vector2(-1, -1) },
        uSeed: { value: 3.7 },
      },
      vertexShader: lensVert,
      fragmentShader: lensFrag,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendEquationAlpha: THREE.AddEquation,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    this.lens = new THREE.Mesh(quad, this.lensMat);
    this.lens.frustumCulled = false;
    this.lens.renderOrder = 60;
    this.lens.name = 'vfx-lens-rain';
    world.scene.add(this.lens);
  }

  update(ctx: VfxCtx, p: Particles, probe: WaterProbe, wake: WakeField): void {
    const world = ctx.world;
    const rain = ctx.rain;
    // Rate integration is clamped so a slow frame under-emits instead of asking
    // for proportionally more particles and making itself slower still.
    const dt = Math.min(ctx.dt, 1 / 30);

    this.streaks(ctx, rain, ctx.dt);
    this.lensWater(ctx, rain, ctx.dt);
    if (rain < 0.02) return;

    this.seaRings(ctx, wake, probe, dt);
    if (p.available) {
      this.deckSplashes(ctx, p, dt);
      this.riggingDrips(ctx, p, dt);
      this.seaSplashParticles(ctx, p, probe, dt);
    }
    void world;
  }

  /* ----------------------------------------------------------------- *
   *  Falling streaks
   * ----------------------------------------------------------------- */

  private streaks(ctx: VfxCtx, rain: number, dt: number): void {
    const u = this.mat.uniforms;
    const vis = rain > 0.015;
    this.mesh.visible = vis;
    if (!vis) {
      this.geo.instanceCount = 0;
      return;
    }

    // Terminal velocity plus the wind, which is what tilts the whole curtain.
    _vel.copy(ctx.windDir).multiplyScalar(ctx.windSpeed * 0.82);
    _vel.y = -FALL_SPEED * (0.85 + 0.35 * rain);
    (u.uVel.value as THREE.Vector3).copy(_vel);

    // Pre-wrapped so the shader's own mod() never sees a large number.
    this.phase.addScaledVector(_vel, dt);
    this.phase.set(wrap(this.phase.x, 1e6), wrap(this.phase.y, 1e6), wrap(this.phase.z, 1e6));
    const off = u.uOffset.value as THREE.Vector3;
    off.set(wrap(this.phase.x, BOX.x), wrap(this.phase.y, BOX.y), wrap(this.phase.z, BOX.z));
    const offN = u.uOffsetNear.value as THREE.Vector3;
    offN.set(wrap(this.phase.x, 3.2), wrap(this.phase.y, 2.6), wrap(this.phase.z, 3.2));

    u.uShear.value = 0.004 + 0.012 * clamp01(ctx.windSpeed / 22);
    u.uShutter.value = 0.075 + 0.05 * rain;
    u.uIntensity.value = Math.pow(rain, 0.75);
    u.uWidth.value = 0.009 + 0.006 * rain;

    const want = Math.round(this.maxStreaks * Math.pow(rain, 0.6) * Math.min(1, ctx.density + 0.25));
    this.geo.instanceCount = Math.min(this.maxStreaks, want);
  }

  /* ----------------------------------------------------------------- *
   *  Water on the lens
   * ----------------------------------------------------------------- */

  private lensWater(ctx: VfxCtx, rain: number, dt: number): void {
    const world = ctx.world;
    // Rain wets the lens; so does heavy spray, but only in the exposed
    // camera positions. Slew slowly — the glass takes time to clear.
    const spray = clamp01(ctx.speedN * 1.4) * clamp01((ctx.windSpeed - 13) / 12);
    const target = smoothstep(0.42, 0.92, rain) * 0.85 + spray * 0.35;
    this.lensAmount = damp(this.lensAmount, Math.min(target, 1), 0.55, dt);

    const vis = this.lensAmount > 0.008;
    this.lens.visible = vis;
    if (!vis) return;

    // Beads are shed sideways by camera rotation and sag under gravity.
    const q = world.camera.quaternion;
    const dyaw = q.y - this.lastCamQuat.y;
    const dpitch = q.x - this.lastCamQuat.x;
    this.lastCamQuat.copy(q);
    this.lensDrift.x = damp(this.lensDrift.x - dyaw * 2.4, 0, 1.6, dt);
    this.lensDrift.y = damp(this.lensDrift.y + dpitch * 2.4, 0, 1.6, dt) - dt * 0.012;

    const u = this.lensMat.uniforms;
    u.uIntensity.value = this.lensAmount;
    (u.uAspect.value as THREE.Vector2).set(world.camera.aspect * 1.1, 1.1);
    (u.uDrift.value as THREE.Vector2).copy(this.lensDrift);

    // Project the sun so the beads catch a real highlight.
    _sun.copy(world.env.sunDirection).multiplyScalar(4000).add(world.camera.position);
    _sun.project(world.camera);
    const uv = u.uSunUv.value as THREE.Vector2;
    if (_sun.z < 1 && Math.abs(_sun.x) < 1.6 && Math.abs(_sun.y) < 1.6) {
      uv.set(_sun.x * 0.5 + 0.5, _sun.y * 0.5 + 0.5);
    } else uv.set(-1, -1);
  }

  /* ----------------------------------------------------------------- *
   *  What the rain does when it lands
   * ----------------------------------------------------------------- */

  /** Ring ripples in the fine interaction field, for the ocean to composite. */
  private seaRings(ctx: VfxCtx, wake: WakeField, probe: WaterProbe, dt: number): void {
    this.accRipple += 78 * ctx.rain * ctx.rain * dt;
    const n = Math.floor(this.accRipple);
    this.accRipple -= n;
    const cam = ctx.world.camera.position;
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * Math.PI * 2;
      const r = Math.pow(Math.random(), 0.5) * 46;
      const x = cam.x + Math.cos(ang) * r;
      const z = cam.z + Math.sin(ang) * r;
      wake.addRipple(x, z, 0.09 + Math.random() * 0.1, 2.6, 0.55, 0);
    }
    void probe;
  }

  /** The bright vertical pin of water a raindrop kicks back off the sea. */
  private seaSplashParticles(ctx: VfxCtx, p: Particles, probe: WaterProbe, dt: number): void {
    this.accSplash += 900 * ctx.rain * ctx.rain * ctx.density * dt;
    const n = Math.floor(this.accSplash);
    this.accSplash -= n;
    const cam = ctx.world.camera.position;
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * Math.PI * 2;
      const r = 2 + Math.pow(Math.random(), 0.55) * 34;
      const x = cam.x + Math.cos(ang) * r;
      const z = cam.z + Math.sin(ang) * r;
      const y = probe.heightAt(x, z);
      p.spawn(
        x, y + 0.05, z,
        (Math.random() - 0.5) * 1.1, 1.4 + Math.random() * 2.2, (Math.random() - 0.5) * 1.1,
        0.24 + Math.random() * 0.22,
        0.020 + Math.random() * 0.035,
        KIND.DROPLET, 0.35,
      );
    }
  }

  private deckSplashes(ctx: VfxCtx, p: Particles, dt: number): void {
    const deck = ctx.shipExt?.deckHeight ?? ctx.shipExt?.deckY ?? 5.8;
    this.accDeck += 420 * ctx.rain * ctx.rain * ctx.density * dt;
    const n = Math.floor(this.accDeck);
    this.accDeck -= n;
    for (let i = 0; i < n; i++) {
      _local.set(
        (Math.random() * 2 - 1) * 5.6,
        deck + 0.06,
        -20 + Math.random() * 44,
      );
      ctx.toWorld(_local, _a);
      const ang = Math.random() * Math.PI * 2;
      const out = 0.5 + Math.random() * 1.7;
      _b.copy(ctx.right).multiplyScalar(Math.cos(ang) * out);
      _b.addScaledVector(ctx.fwd, Math.sin(ang) * out);
      _b.y += 1.0 + Math.random() * 1.9;
      p.spawn(
        _a.x, _a.y, _a.z, _b.x, _b.y, _b.z,
        0.28 + Math.random() * 0.24,
        0.016 + Math.random() * 0.03,
        KIND.DROPLET, 0.3,
      );
    }
  }

  /** Water running off the yards and shrouds, shed in fat slow drops. */
  private riggingDrips(ctx: VfxCtx, p: Particles, dt: number): void {
    const ext = ctx.shipExt;
    const yardY = ext?.mainYardY ?? 24;
    const half = ext?.mainYardHalfSpan ?? 16;
    const mastZ = ext?.mainMastZ ?? 0;
    this.accDrip += 130 * ctx.rain * ctx.density * dt;
    const n = Math.floor(this.accDrip);
    this.accDrip -= n;
    for (let i = 0; i < n; i++) {
      // Spread over the three masts' yard tiers, favouring the lower ones.
      const tier = Math.floor(Math.random() * 3);
      const y = yardY * (0.62 + tier * 0.42) * (0.55 + Math.random() * 0.5);
      const z = mastZ + (Math.random() - 0.5) * 44;
      const x = (Math.random() * 2 - 1) * half * (1 - tier * 0.22);
      _local.set(x, y, z);
      ctx.toWorld(_local, _a);
      _b.copy(ctx.windVel).multiplyScalar(0.25);
      _b.y -= 0.6 + Math.random();
      p.spawn(
        _a.x, _a.y, _a.z, _b.x, _b.y, _b.z,
        1.6 + Math.random() * 1.4,
        0.035 + Math.random() * 0.05,
        KIND.DROPLET, 0.55,
      );
    }
  }

  applySettings(world: World, tex: VfxTextures): void {
    if (streakCount(world.settings.quality) === this.maxStreaks) return;
    this.dispose();
    this.init(world, tex);
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
    this.mesh.removeFromParent();
    this.lens.geometry.dispose();
    this.lensMat.dispose();
    this.lens.removeFromParent();
  }
}
