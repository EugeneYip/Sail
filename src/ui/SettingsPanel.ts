import type { CameraModeName, Environment, QualityTier, World } from '../types';
import { applyQualityPreset, defaultSettings } from '../core/Settings';
import { BINDINGS } from './bindings';
import { action, choice, group, note, readout, slider, toggle, type Ctl } from './controls';
import { add, el, setClass } from './dom';
import type { HudMode } from './mode';
import {
  beaufortFromSpeed, beaufortName, cardinal, clamp, RAD2DEG,
  seaStateName, shipTime, toKnots, visibilityText,
} from './format';

/**
 * The ship's book — one scrolling column of hairline-separated groups.
 *
 * `settings:changed` makes the engine re-run every module's `applySettings` and
 * a full resize, so a slider drag must not emit it per pointer move: writes are
 * marked dirty and flushed at most every 140 ms (and on close). Environment
 * writes go straight to `world.env` and need no event.
 */

const EMIT_MS = 140;
const SYNC_MS = 240;

export class SettingsPanel {
  readonly root: HTMLElement;
  /** Read by the layer: hold the clock against the weather system's drift. */
  readonly hold = { time: false, value: 12 };

  onPhoto: () => void = () => {};
  onShot: () => void = () => {};
  /** Owned by the layer — the panel is one of three ways to flip the mode. */
  getMode: () => HudMode = () => 'minimal';
  setMode: (mode: HudMode) => void = () => {};

  private body: HTMLElement;
  private ctls: Ctl[] = [];
  private world: World;
  private open_ = false;
  private dirty = false;
  private lastEmit = 0;
  private lastSync = 0;

  constructor(world: World) {
    this.world = world;
    this.hold.value = world.env.timeOfDay;

    this.root = el('aside', 'panel');
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-label', "Ship's book");
    this.root.tabIndex = -1;

    const head = add(this.root, el('header', 'panel-h'));
    add(head, el('div', 'panel-t', "Ship's Book"));
    const close = add(head, el('button', 'panel-x', 'esc'));
    close.type = 'button';
    close.setAttribute('aria-label', 'Close settings');
    close.addEventListener('click', () => this.close());

    this.body = add(this.root, el('div', 'panel-b'));
    this.buildSailing();
    this.buildVoyage();
    this.buildPicture();
    this.buildEffects();
    this.buildSeaAndShadow();
    this.buildPerformance();
    this.buildSound();
    this.buildCamera();
    this.buildControlsDoc();

    this.root.addEventListener('keydown', (e) => this.trapTab(e));
  }

  /* ---------------------------------------------------------------- *
   *  commit paths
   * ---------------------------------------------------------------- */

  private commitSettings = (): void => {
    this.dirty = true;
  };

  /** Environment fields need no event, but the derived ones must follow. */
  private commitEnv = (): void => {
    const env = this.world.env;
    const t = env.windBearing + Math.PI;
    env.windVector.set(Math.sin(t), 0, -Math.cos(t)).normalize();
    env.beaufort = beaufortFromSpeed(env.windSpeed);
    env.weatherLabel = describeWeather(env);
  };

  private commitNone = (): void => {};

  /**
   * If the weather system ever publishes an override handle, prefer it — it can
   * blend rather than snap. Nothing publishes one today, hence the duck type.
   */
  private pin(field: keyof Environment, value: number): void {
    const ext = this.world.ext.env as { pin?: (f: string, v: number) => void } | null | undefined;
    if (ext && typeof ext.pin === 'function') {
      try {
        ext.pin(field, value);
      } catch {
        /* an override handle that throws is not our problem */
      }
    }
  }

  private envNum(field: 'timeOfDay' | 'windSpeed' | 'windBearing' | 'seaState' | 'waveHeight'
    | 'choppiness' | 'swellBearing' | 'cloudCover' | 'cloudType' | 'rain' | 'turbidity'
    | 'visibility' | 'latitude' | 'dayOfYear') {
    return (v: number): void => {
      this.world.env[field] = v;
      this.pin(field, v);
    };
  }

  /* ---------------------------------------------------------------- *
   *  groups
   * ---------------------------------------------------------------- */

  private buildSailing(): void {
    const g = group(this.body, 'Sailing');
    this.add(choice<HudMode>(g, {
      label: 'Mode',
      options: [{ v: 'minimal', t: 'minimal' }, { v: 'pro', t: 'pro' }],
      get: () => this.getMode(),
      set: (v) => this.setMode(v),
    }, this.commitNone));
    this.add(note(g, () => (this.getMode() === 'pro'
      ? 'The full instrument set, and the ship as she really sailed — yours to trim, and yours to put in irons.'
      : 'Speed and heading. The watch trims the sails; you steer with the arrow keys.')));
  }

  private buildVoyage(): void {
    const env = this.world.env;
    const g = group(this.body, 'Voyage');

    this.add(slider(g, {
      label: 'Time of day', min: 0, max: 24, step: 0.05,
      get: () => env.timeOfDay,
      set: (v) => {
        this.envNum('timeOfDay')(v);
        this.hold.value = v;
      },
      fmt: (v) => shipTime(v).clock,
    }, this.commitNone));

    this.add(toggle(g, {
      label: 'Hold the clock',
      get: () => this.hold.time,
      set: (v) => {
        this.hold.time = v;
        this.hold.value = env.timeOfDay;
      },
    }, this.commitNone));

    this.add(slider(g, {
      label: 'Wind speed', min: 0, max: 34, step: 0.2,
      get: () => env.windSpeed,
      set: this.envNum('windSpeed'),
      fmt: (v) => `${toKnots(v).toFixed(0)} kn · F${beaufortFromSpeed(v)}`,
    }, this.commitEnv));

    this.add(slider(g, {
      label: 'Wind from', min: 0, max: 355, step: 5,
      get: () => Math.round(((env.windBearing * RAD2DEG) % 360 + 360) % 360 / 5) * 5,
      set: (v) => this.envNum('windBearing')(v / RAD2DEG),
      fmt: (v) => `${String(Math.round(v)).padStart(3, '0')}° ${cardinal(v)}`,
    }, this.commitEnv));

    this.add(slider(g, {
      label: 'Sea state', min: 0, max: 9, step: 1,
      get: () => Math.round(env.seaState),
      set: this.envNum('seaState'),
      fmt: (v) => `${v} · ${seaStateName(v)}`,
    }, this.commitEnv));

    this.add(slider(g, {
      label: 'Wave height', min: 0, max: 14, step: 0.1,
      get: () => env.waveHeight,
      set: this.envNum('waveHeight'),
      fmt: (v) => `${v.toFixed(1)} m`,
    }, this.commitEnv));

    this.add(slider(g, {
      label: 'Chop', min: 0, max: 1, step: 0.02,
      get: () => env.choppiness,
      set: this.envNum('choppiness'),
      fmt: pct,
    }, this.commitEnv));

    this.add(slider(g, {
      label: 'Swell from', min: 0, max: 355, step: 5,
      get: () => Math.round(((env.swellBearing * RAD2DEG) % 360 + 360) % 360 / 5) * 5,
      set: (v) => this.envNum('swellBearing')(v / RAD2DEG),
      fmt: (v) => `${String(Math.round(v)).padStart(3, '0')}° ${cardinal(v)}`,
    }, this.commitEnv));

    this.add(slider(g, {
      label: 'Cloud cover', min: 0, max: 1, step: 0.01,
      get: () => env.cloudCover, set: this.envNum('cloudCover'), fmt: pct,
    }, this.commitEnv));

    this.add(slider(g, {
      label: 'Cloud form', min: 0, max: 1, step: 0.01,
      get: () => env.cloudType, set: this.envNum('cloudType'),
      fmt: (v) => (v < 0.34 ? 'stratus' : v < 0.7 ? 'stratocumulus' : 'cumulus'),
    }, this.commitEnv));

    this.add(slider(g, {
      label: 'Rain', min: 0, max: 1, step: 0.01,
      get: () => env.rain, set: this.envNum('rain'), fmt: pct,
    }, this.commitEnv));

    this.add(slider(g, {
      label: 'Haze', min: 1, max: 10, step: 0.1,
      get: () => env.turbidity, set: this.envNum('turbidity'),
      fmt: (v) => v.toFixed(1),
    }, this.commitEnv));

    this.add(slider(g, {
      label: 'Visibility', min: 300, max: 40000, step: 100,
      get: () => env.visibility, set: this.envNum('visibility'), fmt: visibilityText,
    }, this.commitEnv));

    this.add(slider(g, {
      label: 'Latitude', min: -60, max: 60, step: 1,
      get: () => Math.round(env.latitude), set: this.envNum('latitude'),
      fmt: (v) => `${Math.abs(v)}° ${v < 0 ? 'S' : 'N'}`,
    }, this.commitNone));

    this.add(slider(g, {
      label: 'Day of year', min: 1, max: 365, step: 1,
      get: () => Math.round(env.dayOfYear), set: this.envNum('dayOfYear'),
      fmt: (v) => dayLabel(v),
    }, this.commitNone));

    this.add(readout(g, 'Reported as', () => this.world.env.weatherLabel));
  }

  private buildPicture(): void {
    const s = this.world.settings;
    const g = group(this.body, 'Picture');

    this.add(choice<QualityTier>(g, {
      label: 'Quality',
      options: [
        { v: 'low', t: 'low' }, { v: 'medium', t: 'med' },
        { v: 'high', t: 'high' }, { v: 'ultra', t: 'ultra' },
      ],
      get: () => s.quality,
      set: (v) => {
        applyQualityPreset(s, v);
        this.syncAll();
      },
    }, this.commitSettings));

    this.add(slider(g, {
      label: 'Field of view', min: 35, max: 95, step: 1,
      get: () => s.fov, set: (v) => (s.fov = v), fmt: (v) => `${v}°`,
    }, this.commitSettings));

    this.add(slider(g, {
      label: 'Exposure', min: -3, max: 3, step: 0.05,
      get: () => s.exposureBias, set: (v) => (s.exposureBias = v),
      fmt: (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)} EV`,
    }, this.commitSettings));

    this.add(toggle(g, {
      label: 'Auto exposure', get: () => s.autoExposure, set: (v) => (s.autoExposure = v),
    }, this.commitSettings));

    this.add(slider(g, {
      label: 'Pixel ratio cap', min: 0.75, max: 2, step: 0.25,
      get: () => s.maxPixelRatio, set: (v) => (s.maxPixelRatio = v),
      fmt: (v) => `${v.toFixed(2)}×`,
    }, this.commitSettings));

    this.add(choice<Settings_AA>(g, {
      label: 'Antialiasing',
      options: [
        { v: 'off', t: 'off' }, { v: 'fxaa', t: 'fxaa' },
        { v: 'smaa', t: 'smaa' }, { v: 'taa', t: 'taa' },
      ],
      get: () => s.antialias,
      set: (v) => (s.antialias = v),
    }, this.commitSettings));

    this.add(toggle(g, {
      label: 'Instruments', get: () => s.showHud, set: (v) => (s.showHud = v),
    }, this.commitSettings));

    this.add(toggle(g, {
      label: 'Performance overlay', get: () => s.debug, set: (v) => (s.debug = v),
    }, this.commitSettings));
  }

  private buildEffects(): void {
    const s = this.world.settings;
    const g = group(this.body, 'Effects');

    const t = (label: string, k: EffectKey): void => {
      this.add(toggle(g, { label, get: () => s[k], set: (v) => (s[k] = v) }, this.commitSettings));
    };

    t('Volumetric clouds', 'volumetricClouds');
    this.add(slider(g, {
      label: 'Cloud steps', min: 12, max: 96, step: 4,
      get: () => s.cloudSteps, set: (v) => (s.cloudSteps = v), fmt: (v) => String(v),
    }, this.commitSettings));
    t('Screen-space reflections', 'screenSpaceReflections');
    t('Bloom', 'bloom');
    t('Depth of field', 'depthOfField');
    t('Motion blur', 'motionBlur');
    t('Film grain', 'filmGrain');
    t('Chromatic aberration', 'chromaticAberration');
    t('Lens dirt', 'lensDirt');
    t('Vignette', 'vignette');
  }

  private buildSeaAndShadow(): void {
    const s = this.world.settings;
    const g = group(this.body, 'Sea & shadows');

    this.add(choice<number>(g, {
      label: 'Ocean spectrum',
      options: [{ v: 128, t: '128' }, { v: 256, t: '256' }, { v: 512, t: '512' }],
      get: () => s.oceanResolution, set: (v) => (s.oceanResolution = v),
    }, this.commitSettings));

    this.add(slider(g, {
      label: 'Ocean cascades', min: 2, max: 4, step: 1,
      get: () => s.oceanCascades, set: (v) => (s.oceanCascades = v), fmt: (v) => String(v),
    }, this.commitSettings));

    this.add(choice<number>(g, {
      label: 'Shadow map',
      options: [
        { v: 1024, t: '1k' }, { v: 1536, t: '1.5k' },
        { v: 2048, t: '2k' }, { v: 4096, t: '4k' },
      ],
      get: () => s.shadowMapSize, set: (v) => (s.shadowMapSize = v),
    }, this.commitSettings));

    this.add(slider(g, {
      label: 'Shadow cascades', min: 1, max: 4, step: 1,
      get: () => s.shadowCascades, set: (v) => (s.shadowCascades = v), fmt: (v) => String(v),
    }, this.commitSettings));

    this.add(slider(g, {
      label: 'Foliage density', min: 0, max: 2, step: 0.05,
      get: () => s.propDensity, set: (v) => (s.propDensity = v), fmt: (v) => `${v.toFixed(2)}×`,
    }, this.commitSettings));

    this.add(slider(g, {
      label: 'Spray density', min: 0, max: 2, step: 0.05,
      get: () => s.particleDensity, set: (v) => (s.particleDensity = v), fmt: (v) => `${v.toFixed(2)}×`,
    }, this.commitSettings));
  }

  private buildPerformance(): void {
    const s = this.world.settings;
    const g = group(this.body, 'Performance');

    this.add(toggle(g, {
      label: 'Adaptive resolution',
      get: () => s.adaptiveResolution, set: (v) => (s.adaptiveResolution = v),
    }, this.commitSettings));

    this.add(choice<number>(g, {
      label: 'Target',
      options: [
        { v: 30, t: '30' }, { v: 45, t: '45' }, { v: 60, t: '60' },
        { v: 90, t: '90' }, { v: 120, t: '120' }, { v: 144, t: '144' },
      ],
      get: () => s.targetFps, set: (v) => (s.targetFps = v),
    }, this.commitSettings));

    this.add(readout(g, 'Render scale', () => {
      const w = this.world;
      return `${w.settings.renderScale.toFixed(2)}× · ${w.size.width}×${w.size.height}`;
    }));
    this.add(readout(g, 'Frame rate', () => `${this.world.time.fps.toFixed(0)} fps`));

    this.add(action(g, 'Restore defaults', 'reset', () => {
      Object.assign(this.world.settings, defaultSettings());
      this.syncAll();
      this.commitSettings();
    }));
  }

  private buildSound(): void {
    const s = this.world.settings;
    const g = group(this.body, 'Sound');
    this.add(slider(g, {
      label: 'Master', min: 0, max: 1, step: 0.01,
      get: () => s.masterVolume, set: (v) => (s.masterVolume = v), fmt: pct,
    }, this.commitSettings));
    this.add(slider(g, {
      label: 'Music', min: 0, max: 1, step: 0.01,
      get: () => s.musicVolume, set: (v) => (s.musicVolume = v), fmt: pct,
    }, this.commitSettings));
  }

  private buildCamera(): void {
    const cam = this.world.cam;
    const g = group(this.body, 'Camera');

    this.add(choice<CameraModeName>(g, {
      label: 'View',
      options: [
        { v: 'chase', t: 'chase' }, { v: 'helm', t: 'helm' },
        { v: 'bowsprit', t: 'bow' }, { v: 'masthead', t: 'mast' },
        { v: 'orbit', t: 'orbit' }, { v: 'cinematic', t: 'cine' },
        { v: 'free', t: 'free' },
      ],
      get: () => cam.mode, set: (v) => (cam.mode = v),
    }, this.commitNone));

    this.add(slider(g, {
      label: 'Chase distance', min: 24, max: 180, step: 1,
      get: () => cam.distance, set: (v) => (cam.distance = v), fmt: (v) => `${v} m`,
    }, this.commitNone));

    this.add(slider(g, {
      label: 'Aperture', min: 1.2, max: 22, step: 0.1,
      get: () => cam.aperture, set: (v) => (cam.aperture = v), fmt: (v) => `f/${v.toFixed(1)}`,
    }, this.commitNone));

    this.add(action(g, 'Photo mode', 'F2', () => this.onPhoto()));
    this.add(action(g, 'Save frame', 'png', () => this.onShot()));
  }

  private buildControlsDoc(): void {
    const g = group(this.body, 'Controls');
    for (const grp of BINDINGS) {
      add(g, el('div', 'kb-t', grp.title));
      for (const b of grp.items) {
        const row = add(g, el('div', 'kb'));
        const keys = add(row, el('span', 'kb-k'));
        for (const k of b.keys) add(keys, el('kbd', undefined, k));
        add(row, el('span', 'kb-l', b.label));
      }
    }
  }

  private add(c: Ctl): void {
    this.ctls.push(c);
  }

  /* ---------------------------------------------------------------- *
   *  lifecycle
   * ---------------------------------------------------------------- */

  get isOpen(): boolean {
    return this.open_;
  }

  open(): void {
    if (this.open_) return;
    this.open_ = true;
    setClass(this.root, 'on', true);
    this.syncAll();
    this.root.focus({ preventScroll: true });
  }

  close(): void {
    if (!this.open_) return;
    this.open_ = false;
    setClass(this.root, 'on', false);
    this.flush();
  }

  toggleOpen(): void {
    if (this.open_) this.close();
    else this.open();
  }

  /** Only ever called while open, so a closed panel costs nothing. */
  update(now: number): void {
    if (this.dirty && now - this.lastEmit > EMIT_MS) {
      this.dirty = false;
      this.lastEmit = now;
      this.world.bus.emit('settings:changed');
    }
    if (now - this.lastSync > SYNC_MS) {
      this.lastSync = now;
      this.syncAll();
    }
  }

  syncAll(): void {
    for (const c of this.ctls) c.sync();
  }

  private flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.lastEmit = performance.now();
    this.world.bus.emit('settings:changed');
  }

  private trapTab(e: KeyboardEvent): void {
    if (e.key !== 'Tab') return;
    const items = this.root.querySelectorAll<HTMLElement>(
      'button:not([tabindex="-1"]), input, [href], select',
    );
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (!e.shiftKey && e.target === last) {
      e.preventDefault();
      first.focus();
    } else if (e.shiftKey && (e.target === first || e.target === this.root)) {
      e.preventDefault();
      last.focus();
    }
  }
}

type Settings_AA = 'off' | 'fxaa' | 'smaa' | 'taa';

type EffectKey =
  | 'volumetricClouds' | 'screenSpaceReflections' | 'bloom' | 'depthOfField'
  | 'motionBlur' | 'filmGrain' | 'chromaticAberration' | 'lensDirt' | 'vignette';

function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_ENDS = [31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365];

function dayLabel(day: number): string {
  const d = clamp(Math.round(day), 1, 365);
  let i = 0;
  while (i < 11 && d > MONTH_ENDS[i]) i++;
  const start = i === 0 ? 0 : MONTH_ENDS[i - 1];
  return `${d - start} ${MONTHS[i]}`;
}

/**
 * The weather system owns `weatherLabel` in principle but never writes it, and
 * a stale label under hand-set weather would simply be a lie. Same phrasing as
 * the seed value in core/State.
 */
function describeWeather(env: Environment): string {
  let sky: string;
  if (env.visibility < 2500) sky = 'Fog';
  else if (env.rain > 0.5) sky = 'Rain';
  else if (env.rain > 0.06) sky = 'Squally';
  else if (env.cloudCover > 0.88) sky = 'Overcast';
  else if (env.cloudCover > 0.58) sky = 'Cloudy';
  else if (env.cloudCover > 0.24) sky = 'Fair';
  else sky = 'Clear';
  return `${sky} — ${beaufortName(beaufortFromSpeed(env.windSpeed))}`;
}
