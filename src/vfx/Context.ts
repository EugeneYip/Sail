import * as THREE from 'three';
import type { QualityTier, World } from '../types';
import { clamp01, smoothstep } from '../util/math';

/**
 * Per-frame derived state shared by every VFX subsystem, plus the null-checked
 * handles other agents may or may not have published yet.
 *
 * Nothing here allocates after construction.
 */

/** Shape we hope the ship agent publishes on `world.ext.ship`. All optional. */
export interface ShipExt {
  /** Ship-local position of the stem head at the design waterline. */
  bowLocal?: THREE.Vector3;
  /** Ship-local position of the transom at the waterline. */
  sternLocal?: THREE.Vector3;
  /** Ship-local funnel / galley stack mouth. */
  funnelLocal?: THREE.Vector3;
  /** Deck height above the waterline, metres. */
  deckHeight?: number;
  /**
   * Waterline half-beam as a function of `t` (0 = stem, 1 = transom), metres.
   * If absent we use an analytic frigate section.
   */
  halfBeamAt?(t: number): number;
  /** Ship-local gun muzzle positions, port and starboard. */
  gunPortsLocal?: THREE.Vector3[];
  gunStarboardLocal?: THREE.Vector3[];
  /** Deck-level anatomy the rain uses to place splashes and rigging drips. */
  deckY?: number;
  bulwarkY?: number;
  mainMastZ?: number;
  mainYardY?: number;
  mainYardHalfSpan?: number;
  mastheadY?: number;
}

/** Shape we hope the ocean agent publishes on `world.ext.ocean`. All optional. */
export interface OceanExt {
  /** True if the ocean already draws a sun glitter path; we then skip ours. */
  hasSunGlitter?: boolean;
  foamTexture?: THREE.Texture;
  displacementTexture?: THREE.Texture;
  cascadeScales?: number[];
}

/**
 * Shape the post agent publishes on `world.ext.post`. All optional here so we
 * degrade gracefully if it is ever absent.
 *
 * `depthTexture` is a standalone R32F COPY of the scene depth attachment
 * (post's `sceneDepth` target), holding LAST frame's depth for the whole of the
 * current frame. Sampling it during the scene pass is safe — sampling the live
 * attachment is not, and used to make the driver silently drop every particle
 * draw. Values are non-linear window-space depth over `near`..`far`, read as
 * `.r`, exactly like a `DepthTexture`.
 */
export interface PostExt {
  depthTexture?: THREE.Texture | null;
  /** Camera near/far actually used for the depth encode. */
  near?: number;
  far?: number;
}

/** Design constants for the Constitution's wetted form, used as a fallback. */
export const HULL = {
  /** Waterline length. Slightly shorter than the gun-deck LOA. */
  lwl: 47.5,
  /** Freeboard at the waist, metres above the design waterline. */
  freeboard: 5.4,
  /** Bulwark rail height above the waterline amidships. */
  railHeight: 7.6,
};

/**
 * Analytic waterline half-beam of a fine-bowed frigate. `t` runs 0 (stem) to
 * 1 (transom). Hollow forward, full amidships, a broad but tucked-in transom.
 */
export function frigateHalfBeam(t: number, beam: number): number {
  const u = clamp01(t);
  const fwd = Math.pow(Math.sin(Math.PI * Math.pow(u, 0.58)), 0.62);
  const transom = 0.42 + 0.58 * smoothstep(1.0, 0.72, u);
  return (beam * 0.5) * fwd * transom;
}

/**
 * Waterline half-beam lookup table.
 *
 * `ctx.halfBeam(t)` is called once per bow-spray particle — several hundred
 * times a frame. The ship agent's `ext.halfBeamAt` builds a whole hull section
 * (two Float32Array(88)s, a control-point array and a closure) on every call,
 * which cost ~9.7 ms/frame of `upd:vfx` and was the dominant source of GC
 * pressure in the module. Bake it once into a table and lerp instead.
 */
const HB_LUT_N = 96;

export interface VfxCtx {
  world: World;
  dt: number;
  /** Speed over ground, m/s. */
  speed: number;
  /** Speed normalised against the hull speed (1.34*sqrt(Lwl_ft) ~= 13 kn). */
  speedN: number;
  heel: number;
  /** Signed lee side: +1 when the starboard rail is down (heel > 0). */
  leeSide: number;
  rudder: number;
  /** Low-passed bow slam magnitude, m/s^2, always >= 0. */
  slam: number;

  /** World-space ship basis (unit). `fwd` points at the bow (ship local -Z). */
  fwd: THREE.Vector3;
  right: THREE.Vector3;
  up: THREE.Vector3;
  bow: THREE.Vector3;
  stern: THREE.Vector3;

  /** Direction the air travels, unit, XZ. */
  windDir: THREE.Vector3;
  /** Wind speed including gust, m/s. */
  windSpeed: number;
  /** Air velocity, m/s, as a vector. */
  windVel: THREE.Vector3;

  rain: number;
  wetness: number;
  /** Particle budget multiplier from settings + quality. */
  density: number;
  tier: QualityTier;

  shipExt: ShipExt | null;
  oceanExt: OceanExt | null;
  postExt: PostExt | null;

  /** Ship-local -> world, refreshed from `shipRoot` so we inherit smoothing. */
  shipMatrix: THREE.Matrix4;

  /** Baked waterline half-beam table, `HB_LUT_N + 1` samples over t = 0..1. */
  hbLut: Float32Array;
  /** Identity of the function the table was baked from, so we can rebake. */
  hbSource: unknown;

  /** Waterline half-beam at `t` (0 = stem, 1 = transom), metres. Allocation free. */
  halfBeam(t: number): number;
  /** Ship-local point -> world, written into `out`. */
  toWorld(local: THREE.Vector3, out: THREE.Vector3): THREE.Vector3;
}

const HULL_SPEED_MS = 6.7; // 13 kn

export function createCtx(world: World): VfxCtx {
  const ctx: VfxCtx = {
    world,
    dt: 0,
    speed: 0,
    speedN: 0,
    heel: 0,
    leeSide: 1,
    rudder: 0,
    slam: 0,
    fwd: new THREE.Vector3(0, 0, -1),
    right: new THREE.Vector3(1, 0, 0),
    up: new THREE.Vector3(0, 1, 0),
    bow: new THREE.Vector3(),
    stern: new THREE.Vector3(),
    windDir: new THREE.Vector3(1, 0, 0),
    windSpeed: 0,
    windVel: new THREE.Vector3(),
    rain: 0,
    wetness: 0,
    density: 1,
    tier: 'high',
    shipExt: null,
    oceanExt: null,
    postExt: null,
    shipMatrix: new THREE.Matrix4(),
    hbLut: new Float32Array(HB_LUT_N + 1),
    hbSource: undefined,
    halfBeam(t: number) {
      const f = t <= 0 ? 0 : t >= 1 ? HB_LUT_N : t * HB_LUT_N;
      const i = f | 0;
      const u = f - i;
      const lut = this.hbLut;
      return lut[i] + (lut[i + 1 < lut.length ? i + 1 : i] - lut[i]) * u;
    },
    toWorld(local: THREE.Vector3, out: THREE.Vector3) {
      return out.copy(local).applyMatrix4(this.shipMatrix);
    },
  };
  ctx.shipExt = (world.ext.ship as ShipExt | undefined) ?? null;
  bakeHalfBeam(ctx);
  return ctx;
}

const _bowLocal = new THREE.Vector3();
const _sternLocal = new THREE.Vector3();

/**
 * Rebake the half-beam table. Called only when the ship agent's published
 * function (or the fallback's beam) actually changes, i.e. once.
 */
function bakeHalfBeam(ctx: VfxCtx): void {
  const fn = ctx.shipExt?.halfBeamAt;
  const beam = ctx.world.ship.beam;
  const key = fn ?? beam;
  if (ctx.hbSource === key) return;
  ctx.hbSource = key;
  for (let i = 0; i <= HB_LUT_N; i++) {
    const t = i / HB_LUT_N;
    ctx.hbLut[i] = fn ? fn(t) : frigateHalfBeam(t, beam);
  }
}

export function updateCtx(ctx: VfxCtx): void {
  const world = ctx.world;
  const { ship, env, time, settings } = world;

  ctx.dt = time.dt;
  ctx.speed = ship.velocity.length();
  ctx.speedN = clamp01(ctx.speed / HULL_SPEED_MS);
  ctx.heel = ship.heel;
  ctx.leeSide = ship.heel >= 0 ? 1 : -1;
  ctx.rudder = ship.rudder;

  // bowSlam is signed vertical acceleration; only downward-then-arrested
  // motion throws water, and it needs a short tail so the sheet has body.
  const slamNow = Math.max(0, Math.abs(ship.bowSlam));
  ctx.slam = Math.max(slamNow, ctx.slam * Math.exp(-time.dt * 5.5));

  // Read the ship's visual transform, not the physics state, so VFX inherit
  // whatever smoothing the ship module applies.
  world.shipRoot.updateWorldMatrix(true, false);
  ctx.shipMatrix.copy(world.shipRoot.matrixWorld);

  ctx.right.set(1, 0, 0).transformDirection(ctx.shipMatrix);
  ctx.up.set(0, 1, 0).transformDirection(ctx.shipMatrix);
  ctx.fwd.set(0, 0, -1).transformDirection(ctx.shipMatrix);

  const ext = ctx.shipExt;
  if (ext?.bowLocal) _bowLocal.copy(ext.bowLocal);
  else _bowLocal.set(0, 0.4, -HULL.lwl * 0.5);
  if (ext?.sternLocal) _sternLocal.copy(ext.sternLocal);
  else _sternLocal.set(0, 0.3, HULL.lwl * 0.5);
  ctx.toWorld(_bowLocal, ctx.bow);
  ctx.toWorld(_sternLocal, ctx.stern);

  ctx.windSpeed = env.windSpeed * env.gust;
  ctx.windDir.copy(env.windVector);
  ctx.windVel.copy(ctx.windDir).multiplyScalar(ctx.windSpeed);

  ctx.rain = clamp01(env.rain);
  ctx.wetness = clamp01(world.uniforms.uWetness.value as number);
  ctx.tier = settings.quality;
  ctx.density = Math.max(0.15, settings.particleDensity);

  ctx.shipExt = (world.ext.ship as ShipExt | undefined) ?? null;
  ctx.oceanExt = (world.ext.ocean as OceanExt | undefined) ?? null;
  ctx.postExt = (world.ext.post as PostExt | undefined) ?? null;
  bakeHalfBeam(ctx);
}
