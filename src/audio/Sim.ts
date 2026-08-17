import * as THREE from 'three';
import type { CameraModeName, World } from '../types';

/**
 * The audio graph never sees `World`. It is driven by this flat snapshot, which
 * means the whole rig can also be built inside an `OfflineAudioContext` and fed
 * synthetic values — that is how `scripts/audio-test.mjs` gets deterministic,
 * device-independent numbers out of it.
 */
export interface SimSail {
  id: string;
  mast: number;
  tier: number;
  set: number;
  brace: number;
  area: number;
  luff: number;
  force: number;
  triangular: boolean;
}

export interface SimView {
  dt: number;
  elapsed: number;

  /** True wind at 10 m, m/s, gust already applied. */
  windSpeed: number;
  gust: number;
  /** Apparent wind over the deck, m/s. */
  apparentWind: number;
  beaufort: number;

  seaState: number;
  waveHeight: number;
  choppiness: number;

  rain: number;
  cloudCover: number;
  timeOfDay: number;
  /** sunDirection.y — negative at night. */
  sunAltitude: number;
  visibility: number;

  speedKnots: number;
  heel: number;
  pitch: number;
  /** rad/s about the fore-aft axis. */
  rollRate: number;
  pitchRate: number;
  yawRate: number;
  /** m/s vertical, and its derivative m/s^2. */
  heaveRate: number;
  heaveAccel: number;
  bowSlam: number;
  rudder: number;
  /** rad/s of wheel movement. */
  rudderRate: number;

  sails: SimSail[];
  /** m^2 of canvas actually drawing, and m^2 flogging. */
  drawArea: number;
  luffArea: number;
  /** Σ|Δset|/s and Σ|Δbrace|/s across the rig — drives rope + block sounds. */
  setRate: number;
  braceRate: number;
  inIrons: boolean;

  camMode: CameraModeName;
  /** Camera → ship centre, metres. */
  camDistance: number;
  camHeight: number;
  /**
   * 0 = tucked behind the bulwarks, 1 = out on the masthead in the airflow.
   * Scales wind buffeting and rigging song against hull-borne sound.
   */
  exposure: number;

  shipPos: THREE.Vector3;
  shipQuat: THREE.Quaternion;
  listenerPos: THREE.Vector3;
  listenerFwd: THREE.Vector3;
  listenerUp: THREE.Vector3;

  /** Metres to the nearest land, Infinity offshore. */
  landDistance: number;

  masterVolume: number;
  musicVolume: number;
  /** 'low' | 'medium' tier — halves voice counts and drops the cliff reverb. */
  lowQuality: boolean;
}

export function createSimView(): SimView {
  return {
    dt: 1 / 60,
    elapsed: 0,
    windSpeed: 8.5,
    gust: 1,
    apparentWind: 8.5,
    beaufort: 4,
    seaState: 3,
    waveHeight: 1.2,
    choppiness: 0.55,
    rain: 0,
    cloudCover: 0.4,
    timeOfDay: 12,
    sunAltitude: 0.6,
    visibility: 26000,
    speedKnots: 0,
    heel: 0,
    pitch: 0,
    rollRate: 0,
    pitchRate: 0,
    yawRate: 0,
    heaveRate: 0,
    heaveAccel: 0,
    bowSlam: 0,
    rudder: 0,
    rudderRate: 0,
    sails: [],
    drawArea: 0,
    luffArea: 0,
    setRate: 0,
    braceRate: 0,
    inIrons: false,
    camMode: 'chase',
    camDistance: 74,
    camHeight: 20,
    exposure: 0.5,
    shipPos: new THREE.Vector3(),
    shipQuat: new THREE.Quaternion(),
    listenerPos: new THREE.Vector3(0, 20, 74),
    listenerFwd: new THREE.Vector3(0, 0, -1),
    listenerUp: new THREE.Vector3(0, 1, 0),
    landDistance: Infinity,
    masterVolume: 0.8,
    musicVolume: 0.45,
    lowQuality: false,
  };
}

/** How exposed to the airflow each camera position is. */
const EXPOSURE_BY_MODE: Record<CameraModeName, number> = {
  helm: 0.22,
  chase: 0.55,
  bowsprit: 0.78,
  masthead: 1,
  orbit: 0.5,
  cinematic: 0.45,
  free: 0.6,
};

/**
 * Differentiators for quantities the physics module does not publish rates for.
 * Kept as a separate object so the offline rig can reuse the same code path.
 */
export class SimTracker {
  private prevY = NaN;
  private prevHeave = 0;
  private prevHeel = 0;
  private prevPitch = 0;
  private prevHeading = 0;
  private prevRudder = 0;
  private prevSet = new Map<string, number>();
  private prevBrace = new Map<string, number>();
  private fwd = new THREE.Vector3();
  private stbd = new THREE.Vector3();
  private mat = new THREE.Matrix4();
  private vA = new THREE.Vector3();

  update(world: World, sim: SimView): void {
    const { env, ship, cam, settings, time } = world;
    const dt = Math.max(1e-4, time.dt);

    sim.dt = time.dt;
    sim.elapsed = time.elapsed;

    sim.windSpeed = Math.max(0, env.windSpeed * env.gust);
    sim.gust = env.gust;
    sim.beaufort = env.beaufort;
    sim.apparentWind = ship.apparentWindSpeed > 0.01 ? ship.apparentWindSpeed * env.gust : sim.windSpeed;

    sim.seaState = env.seaState;
    sim.waveHeight = env.waveHeight;
    sim.choppiness = env.choppiness;

    sim.rain = env.rain;
    sim.cloudCover = env.cloudCover;
    sim.timeOfDay = env.timeOfDay;
    sim.sunAltitude = env.sunDirection.y;
    sim.visibility = env.visibility;

    sim.speedKnots = Math.max(0, ship.speedKnots);
    sim.heel = ship.heel;
    sim.pitch = ship.pitch;
    sim.rudder = ship.rudder;
    sim.inIrons = ship.inIrons;

    // Rates: prefer the solver's angular velocity, fall back to differentiating
    // the angles so this still works against a placeholder physics module.
    this.fwd.set(Math.sin(ship.heading), 0, -Math.cos(ship.heading));
    this.stbd.set(Math.cos(ship.heading), 0, Math.sin(ship.heading));
    const av = ship.angularVelocity;
    const rollAv = Math.abs(av.dot(this.fwd));
    const pitchAv = Math.abs(av.dot(this.stbd));
    sim.rollRate = Math.max(rollAv, Math.abs(ship.heel - this.prevHeel) / dt);
    sim.pitchRate = Math.max(pitchAv, Math.abs(ship.pitch - this.prevPitch) / dt);
    sim.yawRate = Math.max(Math.abs(av.y), Math.abs(wrapPi(ship.heading - this.prevHeading)) / dt);
    this.prevHeel = ship.heel;
    this.prevPitch = ship.pitch;
    this.prevHeading = ship.heading;

    // Heave. A floating-origin shift or a teleport must not read as a slam.
    const y = ship.position.y;
    let heave = 0;
    if (Number.isFinite(this.prevY) && Math.abs(y - this.prevY) < 5) heave = (y - this.prevY) / dt;
    this.prevY = y;
    sim.heaveAccel = (heave - this.prevHeave) / dt;
    this.prevHeave = heave;
    sim.heaveRate = heave;
    sim.bowSlam = Math.abs(ship.bowSlam);

    sim.rudderRate = Math.abs(ship.rudder - this.prevRudder) / dt;
    this.prevRudder = ship.rudder;

    // Rig loading.
    sim.sails = ship.sails as SimSail[];
    let draw = 0;
    let luff = 0;
    let setRate = 0;
    let braceRate = 0;
    for (const s of ship.sails) {
      const area = s.area * clamp01(s.set);
      const l = clamp01(s.luff);
      draw += area * (1 - l);
      luff += area * l;
      const ps = this.prevSet.get(s.id);
      if (ps !== undefined) setRate += Math.abs(s.set - ps) / dt;
      this.prevSet.set(s.id, s.set);
      const pb = this.prevBrace.get(s.id);
      if (pb !== undefined) braceRate += Math.abs(s.brace - pb) / dt;
      this.prevBrace.set(s.id, s.brace);
    }
    sim.drawArea = draw;
    sim.luffArea = luff;
    sim.setRate = setRate;
    sim.braceRate = braceRate;

    sim.camMode = cam.mode;
    sim.shipPos.copy(world.shipRoot.position.lengthSq() > 0 ? world.shipRoot.position : ship.position);
    sim.shipQuat.copy(ship.quaternion);

    this.mat.copy(world.camera.matrixWorld);
    sim.listenerPos.setFromMatrixPosition(this.mat);
    // Column 2 of the view matrix is +Z (backwards) in three's convention.
    const e = this.mat.elements;
    sim.listenerFwd.set(-e[8], -e[9], -e[10]).normalize();
    sim.listenerUp.set(e[4], e[5], e[6]).normalize();

    sim.camDistance = sim.listenerPos.distanceTo(sim.shipPos);
    sim.camHeight = sim.listenerPos.y;
    const mastheadish = clamp01((sim.camHeight - 12) / 40);
    sim.exposure = THREE.MathUtils.clamp(
      EXPOSURE_BY_MODE[cam.mode] * 0.7 + mastheadish * 0.45,
      0,
      1,
    );

    sim.landDistance = readLandDistance(world.ext, this.vA.copy(sim.shipPos));

    sim.masterVolume = clamp01(settings.masterVolume);
    sim.musicVolume = clamp01(settings.musicVolume);
    sim.lowQuality = settings.quality === 'low' || settings.quality === 'medium';
  }
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function wrapPi(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/**
 * `world.ext.world.nearestLand` is published by the world module, whose shape is
 * not pinned by the contract yet. Accept a number, a `{ distance }`, or a
 * `{ position, radius }` and otherwise assume open ocean.
 */
function readLandDistance(ext: Record<string, unknown>, shipPos: THREE.Vector3): number {
  const w = ext.world as { nearestLand?: unknown } | undefined;
  const nl = w?.nearestLand;
  if (nl == null) return Infinity;
  if (typeof nl === 'number') return Number.isFinite(nl) ? nl : Infinity;
  if (typeof nl !== 'object') return Infinity;
  const o = nl as Record<string, unknown>;
  for (const key of ['distance', 'dist', 'range']) {
    const v = o[key];
    if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, v);
  }
  const p = (o.position ?? o.center ?? o.pos) as { x?: number; y?: number; z?: number } | undefined;
  if (p && typeof p.x === 'number' && typeof p.z === 'number') {
    const dx = p.x - shipPos.x;
    const dz = p.z - shipPos.z;
    const r = typeof o.radius === 'number' ? o.radius : 0;
    return Math.max(0, Math.hypot(dx, dz) - r);
  }
  return Infinity;
}
