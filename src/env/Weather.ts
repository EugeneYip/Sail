import * as THREE from 'three';
import type { Environment, Module, World } from '../types';
import { beaufortFromSpeed, updateWindVector } from '../core/State';
import { DEG, RAD, TAU, clamp01, damp, kelvinToColor, makeRng, smoothstep, wrapTau } from '../util/math';
import { computeCelestial, createCelestial } from './Celestial';
import { FogField } from './FogField';
import {
  VISIBILITY_MAX,
  VISIBILITY_MIN,
  betaFromVisibility,
  fogBeta,
  rainBeta,
  visibilityFromBeta,
} from './Optics';
import {
  DEFAULT_PRESET_ID,
  PRESETS,
  PRESET_IDS,
  type WeatherPreset,
  isFrontal,
  pickSuccessor,
  presetById,
  presetDistance,
} from './Presets';
import { SeaState, douglasFromHs } from './SeaState';
import { DEFAULT_DAY_LENGTH_MINUTES, TimeWarp } from './TimeWarp';
import { GUST_MAX, GUST_MIN, WindField } from './WindField';

/* ------------------------------------------------------------------ *
 *  Pins
 * ------------------------------------------------------------------ */

/**
 * Fields the UI or the capture harness may force. All are `Environment` fields
 * except `fog`, which is the director's internal fog-bank occupancy (0..1) and is
 * exposed because forcing a dense bank is genuinely useful.
 */
export const PINNABLE = [
  'windSpeed',
  'windBearing',
  'gust',
  'waveHeight',
  'seaState',
  'swellBearing',
  'choppiness',
  'cloudCover',
  'cloudType',
  'rain',
  'turbidity',
  'visibility',
  'timeOfDay',
  'dayOfYear',
  'latitude',
  'moonPhase',
  'fog',
] as const;
export type PinnableField = (typeof PINNABLE)[number];

const P_WIND_SPEED = 0;
const P_WIND_BEARING = 1;
const P_GUST = 2;
const P_WAVE_HEIGHT = 3;
const P_SEA_STATE = 4;
const P_SWELL_BEARING = 5;
const P_CHOPPINESS = 6;
const P_CLOUD_COVER = 7;
const P_CLOUD_TYPE = 8;
const P_RAIN = 9;
const P_TURBIDITY = 10;
const P_VISIBILITY = 11;
const P_TIME_OF_DAY = 12;
const P_DAY_OF_YEAR = 13;
const P_LATITUDE = 14;
const P_MOON_PHASE = 15;
const P_FOG = 16;

const PIN_INDEX: Record<string, number> = {};
for (let i = 0; i < PINNABLE.length; i++) PIN_INDEX[PINNABLE[i]] = i;

/* ------------------------------------------------------------------ *
 *  Time constants
 * ------------------------------------------------------------------ */

/** Simulated seconds. The wind LEADS every other change. */
const TAU_WIND_S = 14 * 60;
/** Two-stage cascade: cloud thickens after the wind, 63% at ~24 min. */
const TAU_CLOUD_S = 11 * 60;
const TAU_TYPE_S = 12 * 60;
/** Three-stage cascade rising: rain arrives LAST, 63% at ~32 min. */
const TAU_RAIN_UP_S = 9 * 60;
/** ...and stops first, in ~10 min. */
const TAU_RAIN_DOWN_S = 2.5 * 60;
const TAU_TURB_S = 26 * 60;
const TAU_VIS_S = 18 * 60;
const TAU_FOG_S = 34 * 60;
const TAU_WET_UP_S = 100;
const TAU_WET_DRY_S = 1200;

const DAYS_PER_YEAR = 365;

/**
 * Softened lunar opposition surge. The real relation is steeper (a half moon is
 * only ~9% as bright as a full one, i.e. an exponent near 3.4); we pull it back
 * so that half-lit nights are still worth sailing.
 */
const MOON_OPPOSITION_EXP = 2.6;

/** Scene-linear scalar for the sun at the zenith through clean air. */
const SUN_TOP_INTENSITY = 13.5;

/** A new label must be 20% closer than the incumbent before it takes over. */
const LABEL_HYSTERESIS = 0.8;

const SQUALL_RAIN_BOOST = 0.3;

/* ------------------------------------------------------------------ *
 *  Published control surface
 * ------------------------------------------------------------------ */

/** Extra state the director publishes that has no `Environment` field. */
export interface EnvDetail {
  /** Hs of the wind-driven chop alone, metres. */
  windSea: number;
  /** Hs of the old swell alone, metres. `sqrt(windSea^2+swell^2) == waveHeight`. */
  swell: number;
  /** Bearing the chop runs from — lags `windBearing` by ~12 simulated minutes. */
  windSeaBearing: number;
  /** 0..1, how crossed the sea is. 1 = equal trains 90 degrees apart. */
  crossSea: number;
  /** Illuminated fraction of the lunar disc, 0..1 (NOT the same as moonPhase). */
  moonIlluminated: number;
  sunAltitude: number;
  moonAltitude: number;
  /** Equation of time, minutes. */
  equationOfTime: number;
  /** Fog-bank occupancy at the ship, 0..1. */
  fog: number;
  /** 0..1 squall envelope. */
  squall: number;
  /** Simulated seconds elapsing per real second right now (includes the warp). */
  simRate: number;
  /** Current warp slowness factor; > 1 means we are lingering. */
  warp: number;
  /** Preset the state machine is aiming at (may differ from `weatherLabel`). */
  targetPreset: string;
  /** Simulated hours until the next weather transition. */
  dwellHours: number;
  /** Material wetness 0..1, mirrors `uniforms.uWetness`. */
  wetness: number;
}

/**
 * `world.ext.env` — the director's control surface.
 *
 *   setPreset(id, immediate?)  blend to a named condition. `immediate` snaps
 *                              every integrator so the state is stable at once.
 *                              Returns false for an unknown id.
 *   pin(field, value)          force a field. The integrators keep running from
 *                              the forced value but never write over it.
 *   unpin(field)               release one field, or 'all'.
 *   pinned()                   currently pinned field names.
 *   presets                    the preset ids, in order.
 *   presetLabels               id -> human label.
 *   dayLengthMinutes           read/write. Real minutes per 24 h cycle (24 = 60x).
 *   timeWarp                   read/write. false gives a linear clock.
 *   pause(bool) / paused       freeze the clock and all weather evolution.
 *   skipHours(h)               fast-forward, integrating properly as it goes.
 *   reseed()                   adopt whatever is currently in `env`. Called for
 *                              you on `capture:scene`, and on any external write.
 *   fogDensityAt(x, z)         the spatial fog field at an absolute voyage
 *                              position, 0..1 — for a real volumetric fog bank.
 *   detail                     see `EnvDetail`. Mutated in place; do not cache.
 */
export interface EnvControl {
  setPreset(name: string, immediate?: boolean): boolean;
  pin(field: PinnableField | string, value: number): void;
  unpin(field: PinnableField | string): void;
  pinned(): string[];
  readonly presets: string[];
  readonly presetLabels: Record<string, string>;
  dayLengthMinutes: number;
  timeWarp: boolean;
  pause(p: boolean): void;
  readonly paused: boolean;
  skipHours(h: number): void;
  reseed(): void;
  fogDensityAt(x: number, z: number): number;
  readonly detail: EnvDetail;
}

/* ------------------------------------------------------------------ *
 *  The director
 * ------------------------------------------------------------------ */

export class WeatherSystem implements Module {
  readonly name = 'weather';

  private world!: World;

  /** Continuous days since the Celestial epoch. Integer part = day, fraction = time. */
  private absDays = 0;
  private paused = false;
  private readonly warp = new TimeWarp();
  private readonly cel = createCelestial();
  /** >= 0 forces the lunar phase and moves the moon to match. */
  private phaseForce = -1;

  private preset: WeatherPreset = presetById(DEFAULT_PRESET_ID) ?? PRESETS[0];
  private labelPreset: WeatherPreset = this.preset;
  private dwellSeconds = 0;
  /** True while the harness or the UI is driving; suppresses state transitions. */
  private frozen = false;

  private readonly wind = new WindField();
  private readonly sea = new SeaState();
  private readonly fogField = new FogField();

  private lagWind = 0;
  private cloudA = 0;
  private cloudB = 0;
  private typeA = 0;
  private typeB = 0;
  private rainA = 0;
  private rainB = 0;
  private rainC = 0;
  private lagTurb = 2.4;
  private visBeta = betaFromVisibility(30000);
  private lagFog = 0;
  private fogAmount = 0;
  private wetness = 0;

  private readonly rng = makeRng(0x5ea51de);

  private pinMask = 0;
  private readonly pinValues = new Float64Array(PINNABLE.length);
  /** What we wrote last frame; anything that differs was written by someone else. */
  private readonly shadow = new Float64Array(PINNABLE.length);
  private shadowValid = false;

  private nonFiniteHits = 0;

  private readonly detail: EnvDetail = {
    windSea: 0,
    swell: 0,
    windSeaBearing: 0,
    crossSea: 0,
    moonIlluminated: 0,
    sunAltitude: 0,
    moonAltitude: 0,
    equationOfTime: 0,
    fog: 0,
    squall: 0,
    simRate: 0,
    warp: 1,
    targetPreset: DEFAULT_PRESET_ID,
    dwellHours: 0,
    wetness: 0,
  };

  /* ---------------------------------------------------------------- */

  init(world: World): void {
    this.world = world;
    const env = world.env;

    // Adopt whatever `createEnvironment` (or a save) set up, then start from the
    // preset that best describes it so nothing jerks on the first frame.
    this.absDays = env.dayOfYear + env.timeOfDay / 24;
    this.preset = this.nearestPreset(env);
    this.labelPreset = this.preset;
    this.detail.targetPreset = this.preset.id;
    this.dwellSeconds = this.rollDwell(this.preset);
    this.wind.reset(env.windBearing);
    this.sea.reset(env.waveHeight, env.swellBearing);
    this.reseedFromEnv(env);
    this.warp.calibrate(this.absDays, env.latitude);

    world.bus.on('capture:scene', (payload) => this.onCaptureScene(payload));

    const self = this;
    const labels: Record<string, string> = {};
    for (const p of PRESETS) labels[p.id] = p.label;

    const control: EnvControl = {
      setPreset: (name: string, immediate = false) => this.setPreset(name, immediate),
      pin: (field: string, value: number) => this.pin(field, value),
      unpin: (field: string) => this.unpin(field),
      pinned: () => {
        const out: string[] = [];
        for (let i = 0; i < PINNABLE.length; i++) {
          if (this.pinMask & (1 << i)) out.push(PINNABLE[i]);
        }
        return out;
      },
      presets: PRESET_IDS.slice(),
      presetLabels: labels,
      get dayLengthMinutes() {
        return self.warp.dayLengthMinutes;
      },
      set dayLengthMinutes(v: number) {
        if (Number.isFinite(v)) self.warp.dayLengthMinutes = Math.max(0.05, v);
      },
      get timeWarp() {
        return self.warp.enabled;
      },
      set timeWarp(v: boolean) {
        self.warp.enabled = !!v;
      },
      pause: (p: boolean) => {
        this.paused = !!p;
      },
      get paused() {
        return self.paused;
      },
      skipHours: (h: number) => this.skipHours(h),
      reseed: () => this.reseedFromEnv(world.env),
      fogDensityAt: (x: number, z: number) => this.lagFog * this.fogField.at(x, z),
      detail: this.detail,
    };
    world.ext.env = control;
  }

  /* ---------------------------------------------------------------- *
   *  Frame
   * ---------------------------------------------------------------- */

  update(world: World): void {
    const env = world.env;
    const dt = world.time.dt;

    this.adoptExternalWrites(env);
    this.syncPinnedIntegrators(env);

    // --- clock. `timeOfDay` advances at a rate that lingers near the horizon;
    // TimeWarp normalises it so a full cycle still takes dayLengthMinutes.
    this.warp.calibrate(this.absDays, env.latitude);
    const warpSlowness = this.warp.slowness(this.cel.sunAltitude);
    const hoursPerSecond = this.paused ? 0 : this.warp.rate(this.cel.sunAltitude);
    const simDt = hoursPerSecond * 3600 * dt;
    if (!(this.pinMask & (1 << P_TIME_OF_DAY)) && !this.paused) {
      this.absDays += hoursPerSecond * dt * (1 / 24) * 3600 * (1 / 3600) * 24 * (1 / 24);
      // (kept explicit above for clarity of units; see below for the real step)
      this.absDays = this.absDays; // no-op guard, real advance happens next line
    }
    void 0;

    this.detail.simRate = this.paused ? 0 : hoursPerSecond * 3600;
    this.detail.warp = warpSlowness;

    this.tick(env, this.paused ? 0 : dt, simDt);
    this.publishUniforms(world);
    this.snapshot(env);
  }

  /**
   * One integration step. `dt` is real seconds (gusts, squalls, fog advection),
   * `simDt` is simulated seconds (everything else). Called once per frame, and
   * repeatedly by `skipHours`.
   */
  private tick(env: Environment, dt: number, simDt: number): void {
    // --- clock
    if (!(this.pinMask & (1 << P_TIME_OF_DAY))) {
      this.absDays += simDt / 86400;
    }
    const dayFloor = Math.floor(this.absDays);
    const timeOfDay = (this.absDays - dayFloor) * 24;
    const dayOfYear = ((dayFloor % DAYS_PER_YEAR) + DAYS_PER_YEAR) % DAYS_PER_YEAR;
    this.put(env, P_TIME_OF_DAY, timeOfDay);
    this.put(env, P_DAY_OF_YEAR, dayOfYear);
    this.put(env, P_LATITUDE, env.latitude);

    // --- sun and moon
    const phaseForce = this.pinMask & (1 << P_MOON_PHASE) ? this.pinValues[P_MOON_PHASE] : this.phaseForce;
    computeCelestial(this.absDays, env.timeOfDay, env.latitude, phaseForce, this.cel);
    const cel = this.cel;

    const sunCos = Math.cos(cel.sunAltitude);
    env.sunDirection.set(
      Math.sin(cel.sunAzimuth) * sunCos,
      Math.sin(cel.sunAltitude),
      -Math.cos(cel.sunAzimuth) * sunCos,
    );
    const moonCos = Math.cos(cel.moonAltitude);
    env.moonDirection.set(
      Math.sin(cel.moonAzimuth) * moonCos,
      Math.sin(cel.moonAltitude),
      -Math.cos(cel.moonAzimuth) * moonCos,
    );
    this.put(env, P_MOON_PHASE, cel.phase);

    // --- weather state machine
    const hemisphere = env.latitude >= 0 ? 1 : -1;
    this.dwellSeconds -= simDt;
    if (!this.frozen && this.dwellSeconds <= 0) {
      const next = pickSuccessor(this.preset, this.rng());
      this.wind.shift(isFrontal(this.preset, next), hemisphere, this.rng);
      this.preset = next;
      this.dwellSeconds = this.rollDwell(next);
      this.detail.targetPreset = next.id;
    }
    const preset = this.preset;
    this.detail.dwellHours = Math.max(0, this.dwellSeconds) / 3600;

    // --- wind: mean speed leads everything else
    if (simDt > 0) this.lagWind = damp(this.lagWind, preset.windSpeed, 1 / TAU_WIND_S, simDt);
    // Light air is shifty, a gale is steady.
    const wanderDeg = THREE.MathUtils.clamp(14 - 0.35 * this.lagWind, 3.5, 14);
    this.wind.update(
      dt,
      simDt,
      preset.gustiness,
      preset.squallsPerMinute,
      wanderDeg,
      hemisphere,
      (this.pinMask & (1 << P_WIND_BEARING)) !== 0,
      this.rng,
    );
    this.put(env, P_WIND_SPEED, this.lagWind);
    this.put(env, P_WIND_BEARING, this.wind.bearing);
    this.put(env, P_GUST, this.wind.gust);
    env.beaufort = beaufortFromSpeed(env.windSpeed);
    this.detail.squall = this.wind.squallEnvelope;

    // --- sea: lags the wind by design. See SeaState for the numbers.
    this.sea.update(
      simDt,
      env.windSpeed,
      env.windBearing,
      (this.pinMask & (1 << P_WAVE_HEIGHT)) !== 0,
      (this.pinMask & (1 << P_SWELL_BEARING)) !== 0,
    );
    this.put(env, P_WAVE_HEIGHT, this.sea.height);
    this.put(env, P_SEA_STATE, douglasFromHs(env.waveHeight));
    this.put(env, P_SWELL_BEARING, this.sea.swellBearing);
    this.put(env, P_CHOPPINESS, this.sea.choppiness);
    this.detail.windSea = this.sea.windSea;
    this.detail.swell = this.sea.swell;
    this.detail.windSeaBearing = this.sea.windSeaBearing;
    this.detail.crossSea = this.sea.crossSea;

    // --- cloud: two-stage, so it thickens after the wind rather than with it
    if (simDt > 0) {
      const kC = 1 - Math.exp(-simDt / TAU_CLOUD_S);
      this.cloudA += (preset.cloudCover - this.cloudA) * kC;
      this.cloudB += (this.cloudA - this.cloudB) * kC;
      const kT = 1 - Math.exp(-simDt / TAU_TYPE_S);
      this.typeA += (preset.cloudType - this.typeA) * kT;
      this.typeB += (this.typeA - this.typeB) * kT;

      // --- rain: three-stage rising (arrives last), single-speed falling
      const rising = preset.rain > this.rainC;
      const kR = 1 - Math.exp(-simDt / (rising ? TAU_RAIN_UP_S : TAU_RAIN_DOWN_S));
      this.rainA += (preset.rain - this.rainA) * kR;
      this.rainB += (this.rainA - this.rainB) * kR;
      this.rainC += (this.rainB - this.rainC) * kR;
    }
    this.put(env, P_CLOUD_COVER, clamp01(this.cloudB));
    this.put(env, P_CLOUD_TYPE, clamp01(this.typeB));
    // A squall in a cloudy sky brings its own burst of rain; in clear air it is
    // only wind.
    const squallRain =
      preset.cloudCover > 0.5 ? SQUALL_RAIN_BOOST * this.wind.squallEnvelope : 0;
    this.put(env, P_RAIN, clamp01(this.rainC + squallRain));

    // --- fog: a spatial field sampled at the ship, not a global slider
    if (simDt > 0) this.lagFog = damp(this.lagFog, preset.fog, 1 / TAU_FOG_S, simDt);
    this.fogField.advect(env.windVector.x, env.windVector.z, env.windSpeed, dt);
    const absX = this.world.shipRoot.position.x + this.world.origin.x;
    const absZ = this.world.shipRoot.position.z + this.world.origin.z;
    const fogHere = this.lagFog * this.fogField.at(absX, absZ);
    if (this.pinMask & (1 << P_FOG)) this.fogAmount = this.pinValues[P_FOG];
    else this.fogAmount = fogHere;
    this.detail.fog = this.fogAmount;

    // --- visibility: extinction coefficients add, distances do not
    if (simDt > 0) {
      this.visBeta = damp(this.visBeta, betaFromVisibility(preset.visibility), 1 / TAU_VIS_S, simDt);
    }
    const beta = this.visBeta + rainBeta(env.rain) + fogBeta(this.fogAmount);
    this.put(
      env,
      P_VISIBILITY,
      THREE.MathUtils.clamp(visibilityFromBeta(beta), VISIBILITY_MIN, VISIBILITY_MAX),
    );

    // --- turbidity
    if (simDt > 0) this.lagTurb = damp(this.lagTurb, preset.turbidity, 1 / TAU_TURB_S, simDt);
    this.put(
      env,
      P_TURBIDITY,
      THREE.MathUtils.clamp(this.lagTurb + 2.5 * this.fogAmount + 1.2 * env.rain, 1, 10),
    );

    // --- moon brightness, normalised so a full moon at the zenith in clear air
    // is 1.0. The SKY module turns this into radiance.
    const sinMoon = Math.sin(cel.moonAltitude);
    const gate = smoothstep(-0.1, 0.14, sinMoon);
    const lambert = Math.sqrt(Math.max(0, sinMoon));
    env.moonIntensity = clamp01(
      gate *
        (0.25 + 0.75 * lambert) *
        Math.pow(cel.illuminated, MOON_OPPOSITION_EXP) *
        (1 - 0.85 * env.cloudCover),
    );
    this.detail.moonIlluminated = cel.illuminated;
    this.detail.sunAltitude = cel.sunAltitude;
    this.detail.moonAltitude = cel.moonAltitude;
    this.detail.equationOfTime = cel.equationOfTime;

    // --- wetness: surfaces wet fast in rain and dry slowly afterwards, faster in
    // sun and wind.
    const wetTarget = clamp01(env.rain * 1.15);
    if (simDt > 0) {
      if (wetTarget > this.wetness) {
        this.wetness = damp(this.wetness, wetTarget, 1 / TAU_WET_UP_S, simDt);
      } else {
        const sunDry = clamp01(env.sunDirection.y) * (1 - 0.7 * env.cloudCover);
        const windDry = clamp01(env.windSpeed / 14);
        const rate = (0.4 + 0.6 * sunDry + 0.35 * windDry) / TAU_WET_DRY_S;
        this.wetness = damp(this.wetness, wetTarget, rate, simDt);
      }
    }
    this.detail.wetness = this.wetness;

    // --- default direct-sun radiometry. The SKY module owns every u* light
    // uniform and is free to overwrite these two `env` fields from its
    // atmosphere LUT; they are here so that `env` alone is never incoherent.
    const altDeg = cel.sunAltitude * RAD;
    const airmass = THREE.MathUtils.clamp(
      1 /
        (Math.sin(cel.sunAltitude) +
          0.50572 * Math.pow(Math.max(0.1, altDeg + 6.07995), -1.6364)),
      1,
      40,
    );
    const transmit = Math.exp(-(0.09 + 0.021 * env.turbidity) * airmass);
    env.sunIntensity =
      SUN_TOP_INTENSITY * transmit * smoothstep(-0.0157, 0.0035, env.sunDirection.y);
    kelvinToColor(
      THREE.MathUtils.lerp(1850, 5900, smoothstep(0, 0.35, env.sunDirection.y)),
      env.sunColor,
    );

    this.updateLabel(env);
    this.sanitise(env);
    updateWindVector(env);
  }

  /* ---------------------------------------------------------------- *
   *  Uniforms
   * ---------------------------------------------------------------- */

  private publishUniforms(world: World): void {
    const env = world.env;
    const u = world.uniforms;

    u.uWind.value.copy(env.windVector);
    u.uWindSpeed.value = env.windSpeed * env.gust;
    u.uVisibility.value = env.visibility;
    // Koschmieder. The engine's stock defaults already agree with this relation.
    u.uFogDensity.value = betaFromVisibility(env.visibility);
    u.uWetness.value = this.wetness;

    // NOTE: uSunDirection, uSunColor, uSunIntensity, uMoonDirection, uMoonColor,
    // uMoonIntensity, uSkyColor, uGroundColor and uFogColor are owned by the SKY
    // module, which derives them from its atmosphere LUTs. The director only
    // writes env.sunDirection / env.moonDirection / env.moonPhase /
    // env.moonIntensity / env.timeOfDay and leaves the radiometry alone.

    world.stats['env:nonFinite'] = this.nonFiniteHits;
    world.stats['env:simRate'] = this.detail.simRate;
  }

  /* ---------------------------------------------------------------- *
   *  Pins and external writes
   * ---------------------------------------------------------------- */

  /** Single write path for every field we own; a pin always wins. */
  private put(env: Environment, i: number, v: number): void {
    const value = this.pinMask & (1 << i) ? this.pinValues[i] : v;
    switch (i) {
      case P_WIND_SPEED:
        env.windSpeed = value;
        break;
      case P_WIND_BEARING:
        env.windBearing = value;
        break;
      case P_GUST:
        env.gust = value;
        break;
      case P_WAVE_HEIGHT:
        env.waveHeight = value;
        break;
      case P_SEA_STATE:
        env.seaState = value;
        break;
      case P_SWELL_BEARING:
        env.swellBearing = value;
        break;
      case P_CHOPPINESS:
        env.choppiness = value;
        break;
      case P_CLOUD_COVER:
        env.cloudCover = value;
        break;
      case P_CLOUD_TYPE:
        env.cloudType = value;
        break;
      case P_RAIN:
        env.rain = value;
        break;
      case P_TURBIDITY:
        env.turbidity = value;
        break;
      case P_VISIBILITY:
        env.visibility = value;
        break;
      case P_TIME_OF_DAY:
        env.timeOfDay = value;
        break;
      case P_DAY_OF_YEAR:
        env.dayOfYear = value;
        break;
      case P_LATITUDE:
        env.latitude = value;
        break;
      case P_MOON_PHASE:
        env.moonPhase = value;
        break;
      case P_FOG:
        this.fogAmount = value;
        break;
    }
  }

  private read(env: Environment, i: number): number {
    switch (i) {
      case P_WIND_SPEED:
        return env.windSpeed;
      case P_WIND_BEARING:
        return env.windBearing;
      case P_GUST:
        return env.gust;
      case P_WAVE_HEIGHT:
        return env.waveHeight;
      case P_SEA_STATE:
        return env.seaState;
      case P_SWELL_BEARING:
        return env.swellBearing;
      case P_CHOPPINESS:
        return env.choppiness;
      case P_CLOUD_COVER:
        return env.cloudCover;
      case P_CLOUD_TYPE:
        return env.cloudType;
      case P_RAIN:
        return env.rain;
      case P_TURBIDITY:
        return env.turbidity;
      case P_VISIBILITY:
        return env.visibility;
      case P_TIME_OF_DAY:
        return env.timeOfDay;
      case P_DAY_OF_YEAR:
        return env.dayOfYear;
      case P_LATITUDE:
        return env.latitude;
      case P_MOON_PHASE:
        return env.moonPhase;
      default:
        return this.fogAmount;
    }
  }

  /**
   * Anything on `env` that differs from what we wrote last frame was written by
   * somebody else — the UI, a save, or the capture harness — so adopt it into the
   * matching integrator instead of dragging it back.
   */
  private adoptExternalWrites(env: Environment): void {
    if (!this.shadowValid) return;
    for (let i = 0; i < PINNABLE.length; i++) {
      const v = this.read(env, i);
      if (v === this.shadow[i] || !Number.isFinite(v)) continue;
      switch (i) {
        case P_WIND_SPEED:
          this.lagWind = v;
          break;
        case P_WIND_BEARING:
          this.wind.setBearing(v);
          break;
        case P_WAVE_HEIGHT:
          this.sea.setHeight(v);
          break;
        case P_SWELL_BEARING:
          this.sea.swellBearing = wrapTau(v);
          break;
        case P_CLOUD_COVER:
          this.cloudA = this.cloudB = v;
          break;
        case P_CLOUD_TYPE:
          this.typeA = this.typeB = v;
          break;
        case P_RAIN:
          this.rainA = this.rainB = this.rainC = v;
          break;
        case P_TURBIDITY:
          this.lagTurb = v - 2.5 * this.fogAmount - 1.2 * env.rain;
          break;
        case P_VISIBILITY:
          this.visBeta = Math.max(
            betaFromVisibility(VISIBILITY_MAX),
            betaFromVisibility(v) - rainBeta(env.rain) - fogBeta(this.fogAmount),
          );
          break;
        case P_TIME_OF_DAY:
          this.absDays = Math.floor(this.absDays) + THREE.MathUtils.clamp(v, 0, 23.99999) / 24;
          break;
        case P_DAY_OF_YEAR:
          this.absDays += v - this.shadow[P_DAY_OF_YEAR];
          break;
        case P_MOON_PHASE:
          this.phaseForce = clamp01(v);
          break;
        case P_FOG:
          this.lagFog = v;
          break;
        default:
          break;
      }
    }
  }

  /**
   * Hold every pinned field's integrator at the pinned value, so a forced state
   * is exactly stable frame after frame and releasing a pin continues smoothly
   * from where it was rather than jumping.
   */
  private syncPinnedIntegrators(env: Environment): void {
    const m = this.pinMask;
    if (m === 0) return;
    if (m & (1 << P_WIND_SPEED)) this.lagWind = this.pinValues[P_WIND_SPEED];
    if (m & (1 << P_WIND_BEARING)) this.wind.setBearing(this.pinValues[P_WIND_BEARING]);
    if (m & (1 << P_WAVE_HEIGHT)) this.sea.setHeight(this.pinValues[P_WAVE_HEIGHT]);
    if (m & (1 << P_SWELL_BEARING)) this.sea.swellBearing = wrapTau(this.pinValues[P_SWELL_BEARING]);
    if (m & (1 << P_CLOUD_COVER)) this.cloudA = this.cloudB = this.pinValues[P_CLOUD_COVER];
    if (m & (1 << P_CLOUD_TYPE)) this.typeA = this.typeB = this.pinValues[P_CLOUD_TYPE];
    if (m & (1 << P_RAIN)) this.rainA = this.rainB = this.rainC = this.pinValues[P_RAIN];
    if (m & (1 << P_TURBIDITY)) {
      this.lagTurb = this.pinValues[P_TURBIDITY] - 2.5 * this.fogAmount - 1.2 * env.rain;
    }
    if (m & (1 << P_VISIBILITY)) {
      this.visBeta = Math.max(
        betaFromVisibility(VISIBILITY_MAX),
        betaFromVisibility(this.pinValues[P_VISIBILITY]) -
          rainBeta(env.rain) -
          fogBeta(this.fogAmount),
      );
    }
    if (m & (1 << P_TIME_OF_DAY)) {
      this.absDays =
        Math.floor(this.absDays) +
        THREE.MathUtils.clamp(this.pinValues[P_TIME_OF_DAY], 0, 23.99999) / 24;
    }
    if (m & (1 << P_FOG)) this.lagFog = this.pinValues[P_FOG];
  }

  private snapshot(env: Environment): void {
    for (let i = 0; i < PINNABLE.length; i++) this.shadow[i] = this.read(env, i);
    this.shadowValid = true;
  }

  /* ---------------------------------------------------------------- *
   *  Control surface implementation
   * ---------------------------------------------------------------- */

  private pin(field: string, value: number): void {
    const i = PIN_INDEX[field];
    if (i === undefined || !Number.isFinite(value)) return;
    this.pinMask |= 1 << i;
    this.pinValues[i] = value;
    this.frozen = true;
  }

  private unpin(field: string): void {
    if (field === 'all') {
      this.pinMask = 0;
      this.phaseForce = -1;
      this.frozen = false;
      return;
    }
    const i = PIN_INDEX[field];
    if (i === undefined) return;
    this.pinMask &= ~(1 << i);
    if (i === P_MOON_PHASE) this.phaseForce = -1;
    if (this.pinMask === 0) this.frozen = false;
  }

  private setPreset(name: string, immediate: boolean): boolean {
    const p = presetById(name);
    if (!p) return false;
    this.wind.shift(isFrontal(this.preset, p), this.world.env.latitude >= 0 ? 1 : -1, this.rng);
    this.preset = p;
    this.dwellSeconds = this.rollDwell(p);
    this.detail.targetPreset = p.id;
    if (immediate) this.snapToPreset(this.world.env, p);
    return true;
  }

  private snapToPreset(env: Environment, p: WeatherPreset): void {
    this.lagWind = p.windSpeed;
    this.cloudA = this.cloudB = p.cloudCover;
    this.typeA = this.typeB = p.cloudType;
    this.rainA = this.rainB = this.rainC = p.rain;
    this.lagTurb = p.turbidity;
    this.visBeta = betaFromVisibility(p.visibility);
    this.lagFog = p.fog;
    this.sea.reset(this.seaEquilibrium(p.windSpeed), this.wind.bearing);
    this.wetness = clamp01(p.rain * 1.15);
    this.labelPreset = p;
    void env;
  }

  private seaEquilibrium(windSpeed: number): number {
    // Same fit as SeaState; kept local so snapping does not need the integrator.
    return 0.0472 * Math.pow(Math.max(0, windSpeed), 1.594);
  }

  private skipHours(hours: number): void {
    if (!Number.isFinite(hours) || hours <= 0) return;
    const total = hours * 3600;
    // 120 simulated seconds is comfortably inside every time constant here, so
    // the lags integrate to the same place they would have in real time.
    const step = 120;
    const n = Math.min(4000, Math.ceil(total / step));
    const simDt = total / n;
    const env = this.world.env;
    for (let i = 0; i < n; i++) this.tick(env, 0, simDt);
    this.publishUniforms(this.world);
    this.snapshot(env);
  }

  private reseedFromEnv(env: Environment): void {
    this.absDays =
      env.dayOfYear + THREE.MathUtils.clamp(env.timeOfDay, 0, 23.99999) / 24;
    this.lagWind = env.windSpeed;
    this.wind.setBearing(env.windBearing);
    this.sea.setHeight(env.waveHeight);
    this.sea.swellBearing = wrapTau(env.swellBearing);
    this.sea.windSeaBearing = wrapTau(env.windBearing);
    this.sea.choppiness = env.choppiness;
    this.cloudA = this.cloudB = env.cloudCover;
    this.typeA = this.typeB = env.cloudType;
    this.rainA = this.rainB = this.rainC = env.rain;
    this.lagTurb = env.turbidity;
    this.visBeta = Math.max(
      betaFromVisibility(VISIBILITY_MAX),
      betaFromVisibility(env.visibility),
    );
    this.wetness = clamp01(env.rain * 1.15);
    this.labelPreset = this.nearestPreset(env);
    this.shadowValid = false;
  }

  /**
   * The capture harness assigns `env` fields directly and then emits this. Adopt
   * the values AND pin exactly the keys it set, so a forced scene is bit-stable
   * through the settle window instead of being dragged back toward our own state.
   */
  private onCaptureScene(payload?: unknown): void {
    const env = this.world.env;
    this.reseedFromEnv(env);
    this.frozen = true;
    const patch = (payload as { env?: Record<string, unknown> } | undefined)?.env;
    if (!patch) return;
    for (const key in patch) {
      const i = PIN_INDEX[key];
      if (i === undefined) continue;
      const v = Number(patch[key]);
      if (!Number.isFinite(v)) continue;
      this.pinMask |= 1 << i;
      this.pinValues[i] = v;
    }
    // A forced visibility implies a forced fog thickness; without this the fog
    // field would keep pulling visibility around underneath the pin.
    if (this.pinMask & (1 << P_VISIBILITY)) {
      this.pinMask |= 1 << P_FOG;
      this.pinValues[P_FOG] = this.fogAmount;
    }
  }

  private rollDwell(p: WeatherPreset): number {
    return (p.minHours + this.rng() * (p.maxHours - p.minHours)) * 3600;
  }

  private nearestPreset(env: Environment): WeatherPreset {
    let best = PRESETS[0];
    let bestD = Infinity;
    for (let i = 0; i < PRESETS.length; i++) {
      const d = presetDistance(
        PRESETS[i],
        env.windSpeed,
        env.cloudCover,
        env.cloudType,
        env.rain,
        env.turbidity,
        env.visibility,
      );
      if (d < bestD) {
        bestD = d;
        best = PRESETS[i];
      }
    }
    return best;
  }

  /**
   * `weatherLabel` describes what the player can actually see, matched against
   * the preset table with hysteresis — not whichever preset we happen to be
   * aiming at. That keeps the label honest mid-blend, under UI pins and under a
   * forced capture state.
   */
  private updateLabel(env: Environment): void {
    const cur = presetDistance(
      this.labelPreset,
      env.windSpeed,
      env.cloudCover,
      env.cloudType,
      env.rain,
      env.turbidity,
      env.visibility,
    );
    let best = this.labelPreset;
    let bestD = Infinity;
    for (let i = 0; i < PRESETS.length; i++) {
      const d = presetDistance(
        PRESETS[i],
        env.windSpeed,
        env.cloudCover,
        env.cloudType,
        env.rain,
        env.turbidity,
        env.visibility,
      );
      if (d < bestD) {
        bestD = d;
        best = PRESETS[i];
      }
    }
    if (bestD < cur * LABEL_HYSTERESIS) this.labelPreset = best;
    env.weatherLabel = this.labelPreset.label;
  }

  /**
   * Final guard. Every published field is clamped to its documented range, and a
   * non-finite value is replaced and counted in `stats['env:nonFinite']` so a bug
   * shows up in the debug overlay instead of silently poisoning the ocean.
   */
  private sanitise(env: Environment): void {
    env.windSpeed = this.fix(env.windSpeed, 0, 45, 8);
    env.windBearing = wrapTau(this.fix(env.windBearing, -1e6, 1e6, 0));
    env.gust = this.fix(env.gust, GUST_MIN, GUST_MAX, 1);
    env.beaufort = this.fix(env.beaufort, 0, 12, 4);
    env.waveHeight = this.fix(env.waveHeight, 0, 20, 1);
    env.seaState = this.fix(env.seaState, 0, 9, 3);
    env.swellBearing = wrapTau(this.fix(env.swellBearing, -1e6, 1e6, 0));
    env.choppiness = this.fix(env.choppiness, 0, 1, 0.5);
    env.timeOfDay = this.fix(env.timeOfDay, 0, 24, 12) % 24;
    env.dayOfYear = this.fix(env.dayOfYear, 0, DAYS_PER_YEAR, 172);
    env.latitude = this.fix(env.latitude, -89, 89, 38);
    env.moonPhase = this.fix(env.moonPhase, 0, 1, 0);
    env.moonIntensity = this.fix(env.moonIntensity, 0, 1, 0);
    env.sunIntensity = this.fix(env.sunIntensity, 0, 30, 0);
    env.turbidity = this.fix(env.turbidity, 1, 10, 2.4);
    env.cloudCover = this.fix(env.cloudCover, 0, 1, 0.4);
    env.cloudType = this.fix(env.cloudType, 0, 1, 0.7);
    env.rain = this.fix(env.rain, 0, 1, 0);
    env.visibility = this.fix(env.visibility, VISIBILITY_MIN, VISIBILITY_MAX, 25000);
  }

  private fix(v: number, lo: number, hi: number, fallback: number): number {
    if (!Number.isFinite(v)) {
      this.nonFiniteHits++;
      return fallback;
    }
    return v < lo ? lo : v > hi ? hi : v;
  }
}

export { TAU as ENV_TAU, DEG as ENV_DEG };
