/**
 * Shared contracts for every subsystem.
 *
 * ARCHITECTURE CONTRACT — read before touching any module.
 *
 * The engine owns a single mutable blackboard (`World`). Subsystems are
 * `Module`s: they are constructed with no arguments, receive `init(world)` once,
 * then `update(world)` every frame in registration order. Modules communicate
 * ONLY through the blackboard — never by importing each other's concrete
 * classes. This is what lets subsystems be developed independently.
 *
 * Update order is fixed in `Engine.ts`:
 *   input -> environment/weather -> ocean sim -> physics -> ship visuals
 *   -> sky -> world/props -> vfx -> camera -> audio -> ui
 */

import type * as THREE from 'three';

/* ------------------------------------------------------------------ *
 *  Time
 * ------------------------------------------------------------------ */

export interface FrameTime {
  /** Clamped wall-clock delta, seconds. Never > 0.1, never < 0. */
  dt: number;
  /** Unclamped raw delta, seconds. For perf measurement only. */
  rawDt: number;
  /** Seconds since engine start (sum of clamped dt). */
  elapsed: number;
  /** Monotonically increasing frame counter. */
  frame: number;
  /** Smoothed frames-per-second. */
  fps: number;
}

/* ------------------------------------------------------------------ *
 *  Environment — wind, sea state, sky. Written by WeatherSystem.
 * ------------------------------------------------------------------ */

export interface Environment {
  /**
   * TRUE wind. Meteorological convention: the compass bearing the wind blows
   * FROM, in radians. 0 = from the north (world -Z), PI/2 = from the east
   * (world +X). Use `windVector` when you need a direction of travel.
   */
  windBearing: number;
  /** True wind speed at 10 m reference height, m/s. */
  windSpeed: number;
  /** Unit vector the air actually MOVES toward, XZ plane. Derived. */
  windVector: THREE.Vector3;
  /** Instantaneous gust multiplier applied on top of windSpeed, ~0.8..1.4. */
  gust: number;
  /** Beaufort force 0..12, derived from windSpeed. */
  beaufort: number;

  /** Douglas sea state 0..9, derived from wind + fetch history. */
  seaState: number;
  /** Significant wave height Hs, metres. */
  waveHeight: number;
  /** Dominant swell bearing (from), radians. Lags windBearing. */
  swellBearing: number;
  /** How choppy vs. swelly, 0 = long clean swell, 1 = short steep chop. */
  choppiness: number;

  /** Hours, 0..24, fractional. */
  timeOfDay: number;
  /** Day of year 0..365, drives solar declination. */
  dayOfYear: number;
  /** Observer latitude, degrees. Drives sun arc. */
  latitude: number;
  /** Unit vector pointing from the world TOWARD the sun. */
  sunDirection: THREE.Vector3;
  /** Unit vector pointing from the world TOWARD the moon. */
  moonDirection: THREE.Vector3;
  /** Linear RGB radiance of direct sunlight, pre-exposure. */
  sunColor: THREE.Color;
  /** Scalar illuminance multiplier for the sun, already includes horizon dip. */
  sunIntensity: number;
  /** Moon illuminance, 0 at new moon. */
  moonIntensity: number;
  /** 0..1 phase, 0 = new, 0.5 = full. */
  moonPhase: number;

  /** Atmospheric turbidity / haze, 1 = pristine, 10 = industrial murk. */
  turbidity: number;
  /** Fractional cloud cover 0..1. */
  cloudCover: number;
  /** Cumulus vs. stratus mix, 0 = flat stratus, 1 = towering cumulus. */
  cloudType: number;
  /** Rain intensity 0..1. */
  rain: number;
  /** Distance-fog scale, metres of visibility. */
  visibility: number;

  /** Named preset currently blending in, for UI display. */
  weatherLabel: string;
}

/* ------------------------------------------------------------------ *
 *  Ocean — implemented by the FFT ocean, consumed by physics + vfx.
 * ------------------------------------------------------------------ */

export interface WaveSample {
  /** World-space vertical displacement at the query point, metres. */
  height: number;
  /** Horizontal (choppy) displacement, metres. */
  dx: number;
  dz: number;
  /** Surface normal, unit length, +Y up. */
  normal: THREE.Vector3;
  /** Orbital velocity of the water at the surface, m/s. */
  velocity: THREE.Vector3;
}

export interface IOcean {
  /**
   * Sample the wave field at a world XZ position. MUST be cheap enough to call
   * a few hundred times per frame — physics uses it for hull integration.
   * `out` is written in place and returned.
   */
  sample(x: number, z: number, out: WaveSample): WaveSample;
  /** Height only — the fast path. */
  sampleHeight(x: number, z: number): number;
  /** Mean sea level in world units (always 0, but read it, don't assume). */
  readonly seaLevel: number;
  /** Register a moving foam/wake source. Returns a handle for updates. */
  addFoamSource?(source: FoamSource): void;
}

export interface FoamSource {
  position: THREE.Vector3;
  radius: number;
  strength: number;
}

/* ------------------------------------------------------------------ *
 *  Ship — rigid body state + rig trim. Written by physics, read by visuals.
 * ------------------------------------------------------------------ */

/** One controllable sail on the rig. */
export interface SailState {
  id: string;
  /** Human label, e.g. "Main Topsail". */
  name: string;
  /** Which mast: 0 = fore, 1 = main, 2 = mizzen, 3 = bowsprit/jibs. */
  mast: number;
  /** Height tier: 0 = course, 1 = topsail, 2 = topgallant, 3 = royal. */
  tier: number;
  /** 0 = fully furled, 1 = fully set. Player controlled via reef/set. */
  set: number;
  /** Yard rotation about the mast, radians. 0 = square (perpendicular to keel). */
  brace: number;
  /** Sail area when fully set, m^2. */
  area: number;
  /** 0 = drawing cleanly, 1 = fully luffing/shivering. Written by physics. */
  luff: number;
  /** Aerodynamic force magnitude currently generated, newtons. */
  force: number;
  /** Signed camber the cloth should adopt, drives the billow shader. */
  camber: number;
  /** True for triangular staysails/jibs, false for square sails. */
  triangular: boolean;
}

export interface ShipState {
  /** World position of the hull origin (waterline amidships). */
  position: THREE.Vector3;
  /** Orientation. Ship local axes: +X starboard, +Y up, -Z forward (bow). */
  quaternion: THREE.Quaternion;
  /** Linear velocity, world space, m/s. */
  velocity: THREE.Vector3;
  /** Angular velocity, world space, rad/s. */
  angularVelocity: THREE.Vector3;

  /** Speed over ground in knots — the number the HUD shows. */
  speedKnots: number;
  /** Compass heading of the bow, radians, 0 = north. */
  heading: number;
  /** Heel (roll) angle, radians. Positive = starboard rail down. */
  heel: number;
  /** Pitch angle, radians. Positive = bow up. */
  pitch: number;
  /** Sideways slip angle between heading and course, radians. */
  leeway: number;

  /** Apparent wind bearing relative to the bow, radians, [-PI, PI]. */
  apparentWindAngle: number;
  /** Apparent wind speed, m/s. */
  apparentWindSpeed: number;
  /** Point of sail label for the HUD: "close hauled", "beam reach", ... */
  pointOfSail: string;
  /** True when head-to-wind and sails cannot draw. */
  inIrons: boolean;

  /** Rudder angle, radians. Positive = turn to starboard. */
  rudder: number;
  /** Target rudder from input, smoothed into `rudder`. */
  rudderTarget: number;

  sails: SailState[];
  /** Total drawing sail area, m^2. */
  sailArea: number;

  /** Vertical acceleration at the bow — drives spray + camera shake. */
  bowSlam: number;
  /** Displacement, kg. Constant unless cargo changes. */
  mass: number;
  /** Length overall, metres. */
  loa: number;
  /** Beam, metres. */
  beam: number;
  /** Draught, metres. */
  draught: number;
}

/* ------------------------------------------------------------------ *
 *  Input
 * ------------------------------------------------------------------ */

export interface InputState {
  /** -1 = hard a-port, +1 = hard a-starboard. */
  steer: number;
  /** +1 = set more sail, -1 = take in sail. */
  sailTrim: number;
  /** +1 = brace yards to starboard, -1 = to port. */
  brace: number;
  /** Cycles camera mode when latched. */
  cameraNext: boolean;
  /** Free-look delta since last frame, radians. */
  lookYaw: number;
  lookPitch: number;
  /** Mouse wheel zoom delta. */
  zoom: number;
  /** True while any UI panel has focus — modules should ignore game input. */
  uiFocus: boolean;
  /** Held keys, lowercase. */
  keys: Set<string>;
  pressed(code: string): boolean;
  /** True only on the frame the key went down. */
  justPressed(code: string): boolean;
}

/* ------------------------------------------------------------------ *
 *  Quality settings
 * ------------------------------------------------------------------ */

export type QualityTier = 'low' | 'medium' | 'high' | 'ultra';

export interface Settings {
  quality: QualityTier;
  /** Device pixel ratio cap. */
  maxPixelRatio: number;
  /** Internal render scale multiplier, 0.25..1.0 — adaptive. See `core/AdaptiveResolution`. */
  renderScale: number;
  /** FFT cascade resolution, 128 | 256 | 512. */
  oceanResolution: number;
  /** Number of FFT cascades, 2..4. */
  oceanCascades: number;
  /** Shadow map size per cascade. */
  shadowMapSize: number;
  /** Number of CSM cascades. */
  shadowCascades: number;
  volumetricClouds: boolean;
  /** Raymarch step count for clouds. */
  cloudSteps: number;
  screenSpaceReflections: boolean;
  bloom: boolean;
  depthOfField: boolean;
  motionBlur: boolean;
  filmGrain: boolean;
  chromaticAberration: boolean;
  lensDirt: boolean;
  vignette: boolean;
  antialias: 'off' | 'fxaa' | 'smaa' | 'taa';
  /** Foliage / prop density multiplier. */
  propDensity: number;
  /** Spray + wake particle budget multiplier. */
  particleDensity: number;
  fov: number;
  /** Exposure in EV stops applied on top of auto-exposure. */
  exposureBias: number;
  autoExposure: boolean;
  masterVolume: number;
  musicVolume: number;
  /** When true, the adaptive resolution controller is active. */
  adaptiveResolution: boolean;
  targetFps: number;
  showHud: boolean;
  /** Debug overlays, and the CPU-only counters (`upd:*`) that feed them. */
  debug: boolean;
  /**
   * Instrumentation that PERTURBS the frame it measures. Off by default and
   * deliberately separate from `debug`, because it used to ride on it:
   * `settings.debug` also armed a `readRenderTargetPixels` in AutoExposure and
   * a `gl.finish()` between every sky pass. Measured in one page, `storm`:
   *
   * | | max frame | frames >100 ms per 400 |
   * |---|---|---|
   * | `debug: false` | 82-89 ms | **0** |
   * | `debug: true` (old behaviour) | 281-309 ms | 7-8 |
   *
   * That is the whole of the "shared 50-155 ms stall across ocean/vfx/sky/
   * weather" recorded in DIAGNOSIS §16 — one instrument, not four bugs. Turn
   * this on only to read an exact GPU-side value, and never believe a frame
   * percentile taken while it is on. Optional so an older persisted blob loads.
   */
  debugStalls?: boolean;
  /**
   * How much of the ship the player is asked to run.
   *
   * `minimal` (the default) is the arrow-keys-and-nothing-else mode: speed and
   * heading only, sail trim handled for you. `pro` is the full instrument set
   * and the bare solver. Optional so a settings blob persisted by an older
   * build still loads, and so the handling layer can own its own assist flag —
   * `src/ui/mode.ts` mirrors the two at runtime.
   */
  hudMode?: 'minimal' | 'pro';
  /**
   * Arcade handling assist. ON by default; this is the flag `src/ui/mode.ts`
   * probes for, and `minimal` HUD mode means this is true.
   *
   * TRUE  — quicker acceleration, a speed ceiling above what the hull can
   *         physically reach, a much tighter turn that answers even when slow,
   *         no no-go zone, and fully automatic sail trim, so the arrow keys are
   *         the whole control scheme. Implemented as two extra forces and five
   *         relaxed hull coefficients over the SAME 6-DOF solver — see
   *         `src/physics/Assist.ts`.
   * FALSE — Pro mode: the measured ship. 12.8 kn, 69 deg off the wind, in irons
   *         if you point higher, and the yards are your problem.
   *
   * Flip it any time, in flight, from either end: `world.settings.assist` or
   * `world.ext.physics.assist` (the latter writes the former).
   */
  assist: boolean;
}

/* ------------------------------------------------------------------ *
 *  Camera
 * ------------------------------------------------------------------ */

export type CameraModeName =
  | 'chase'
  | 'helm'
  | 'bowsprit'
  | 'masthead'
  | 'orbit'
  | 'cinematic'
  | 'free';

export interface CameraRigState {
  mode: CameraModeName;
  /** Distance behind the ship for chase mode. */
  distance: number;
  /** Extra shake amplitude requested by other systems this frame, 0..1. */
  shake: number;
  /** Focus distance for DoF, metres. Written by the rig, read by post. */
  focusDistance: number;
  /** Aperture f-number for DoF. */
  aperture: number;
  /** Set true to suppress player camera control (cutscenes). */
  locked: boolean;
}

/* ------------------------------------------------------------------ *
 *  The blackboard
 * ------------------------------------------------------------------ */

export interface World {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** Canvas backing store size in device pixels (after renderScale). */
  size: { width: number; height: number; dpr: number };

  time: FrameTime;
  env: Environment;
  ship: ShipState;
  input: InputState;
  settings: Settings;
  cam: CameraRigState;

  /** Set by the ocean module during init. Physics asserts it is present. */
  ocean: IOcean | null;

  /**
   * The ship's visual root. Physics writes ShipState; the ship module copies
   * it onto this Object3D. Other modules (camera, vfx) read the matrix here so
   * they inherit any visual smoothing.
   */
  shipRoot: THREE.Object3D;

  /**
   * Floating-origin offset. The ship stays near the world origin; this
   * accumulates how far we have actually sailed so shaders can use absolute
   * coordinates without precision loss. Add this to a world position to get
   * true voyage coordinates.
   */
  origin: THREE.Vector3;

  /** Simple pub/sub for cross-module notifications. */
  bus: EventBus;
  /** Perf counters, written by the engine, read by the debug HUD. */
  stats: Record<string, number>;
  /** Uniform block shared by every custom material — see core/SharedUniforms. */
  uniforms: SharedUniforms;

  /**
   * Namespaced escape hatch for handles one subsystem must publish to another
   * without a typed field — e.g. the sky publishing its irradiance probe for
   * the ocean, or the world publishing island colliders for physics.
   *
   * Convention: key by subsystem name (`ext.sky`, `ext.world`), document the
   * shape in your own module, and null-check on read. Anything that proves
   * load-bearing gets promoted to a real field on `World` during integration.
   */
  ext: Record<string, unknown>;
}

export interface SharedUniforms {
  uTime: { value: number };
  uDt: { value: number };
  /** Sun direction, world space, toward the sun. */
  uSunDirection: { value: THREE.Vector3 };
  uSunColor: { value: THREE.Color };
  uSunIntensity: { value: number };
  uMoonDirection: { value: THREE.Vector3 };
  uMoonColor: { value: THREE.Color };
  uMoonIntensity: { value: number };
  /** Ambient sky irradiance (zenith) and ground bounce. */
  uSkyColor: { value: THREE.Color };
  uGroundColor: { value: THREE.Color };
  /** Fog: inscatter colour and visibility distance. */
  uFogColor: { value: THREE.Color };
  uFogDensity: { value: number };
  uVisibility: { value: number };
  /** Camera world position (redundant with the matrix, but handy). */
  uCameraPos: { value: THREE.Vector3 };
  /** Floating-origin offset for absolute-coordinate noise. */
  uOrigin: { value: THREE.Vector3 };
  /** Wind for foliage / flag / rigging sway. */
  uWind: { value: THREE.Vector3 };
  uWindSpeed: { value: number };
  /** Current exposure so forward materials can pre-scale if needed. */
  uExposure: { value: number };
  /** Rain wetness 0..1 for material response. */
  uWetness: { value: number };
  [key: string]: { value: unknown };
}

export interface EventBus {
  on(event: string, fn: (payload?: unknown) => void): () => void;
  off(event: string, fn: (payload?: unknown) => void): void;
  emit(event: string, payload?: unknown): void;
}

/* ------------------------------------------------------------------ *
 *  Module lifecycle
 * ------------------------------------------------------------------ */

export interface Module {
  /** Stable identifier, used for perf attribution and debug toggles. */
  readonly name: string;
  /** Called once, in registration order, before the first frame. */
  init(world: World): void | Promise<void>;
  /** Called every frame. */
  update(world: World): void;
  /** Called after the canvas resizes. */
  resize?(world: World): void;
  /** Called when quality settings change. */
  applySettings?(world: World): void;
  /** Free GPU resources. */
  dispose?(): void;
}
