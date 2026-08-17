import { betaFromVisibility, fogBeta, rainBeta, visibilityFromBeta } from './Optics';

/**
 * Named weather conditions. Each one is a COMPLETE, internally consistent
 * parameter set — never a partial patch — so that any preset can be entered
 * from any other and the result is always physically plausible.
 *
 * Invariants deliberately held by this table (asserted in scripts/weather-test.mjs):
 *   - rain > 0.02 implies cloudCover >= 0.55        (no rain from a clear sky)
 *   - fog  > 0.5  implies windSpeed <  5            (wind mixes fog away)
 *   - rain > 0.4  implies effective visibility < 15 km
 *   - choppiness at equilibrium rises monotonically with windSpeed
 *   - `visibility` is CLEAR-AIR only; rain and fog are added as extinction on
 *     top, so the field is an upper bound and never contradicts `rain`.
 */
export interface WeatherPreset {
  id: string;
  /** Written to `env.weatherLabel`. */
  label: string;

  /** Sustained true wind at 10 m, m/s. */
  windSpeed: number;
  /** 0..1, scales gust turbulence intensity from 6% to 17%. */
  gustiness: number;
  /** Expected squalls per real minute. Squalls are felt, so they are timed in
   *  real seconds rather than simulated ones — see WindField. */
  squallsPerMinute: number;
  /** Stationary std dev of the slow direction wander, degrees. */
  wanderDeg: number;

  cloudCover: number;
  /** 0 = flat stratus, 1 = towering cumulus. */
  cloudType: number;
  rain: number;
  /** Clear-air turbidity before rain and fog are added. */
  turbidity: number;
  /** Clear-air visibility, metres. Rain and fog only reduce it. */
  visibility: number;
  /** 0..1 scale on the spatial fog-bank field. 0 = fog impossible here. */
  fog: number;

  /** Dwell time before the state machine moves on, simulated hours. */
  minHours: number;
  maxHours: number;
  /** Weighted successors: [presetId, weight]. Ordering is physically plausible. */
  next: ReadonlyArray<readonly [string, number]>;

  /** Filled in by `finalisePresets` — expected visibility once fog and rain land. */
  effectiveVisibility: number;
}

/** Mean value of the fog-bank field over a large area — used for label matching. */
export const FOG_FIELD_MEAN = 0.45;

const TABLE: WeatherPreset[] = [
  {
    id: 'glassy',
    label: 'Glassy calm',
    windSpeed: 0.7,
    gustiness: 0.25,
    squallsPerMinute: 0,
    wanderDeg: 14,
    cloudCover: 0.12,
    cloudType: 0.25,
    rain: 0,
    turbidity: 2.1,
    visibility: 36000,
    fog: 0.03,
    minHours: 2,
    maxHours: 5,
    next: [
      ['light-air', 0.78],
      ['heat-haze', 0.22],
    ],
    effectiveVisibility: 0,
  },
  {
    id: 'light-air',
    label: 'Light air',
    windSpeed: 2.6,
    gustiness: 0.4,
    squallsPerMinute: 0.01,
    wanderDeg: 13,
    cloudCover: 0.24,
    cloudType: 0.5,
    rain: 0,
    turbidity: 2.5,
    visibility: 32000,
    fog: 0.08,
    minHours: 2,
    maxHours: 5,
    next: [
      ['glassy', 0.24],
      ['fair-breeze', 0.5],
      ['fog-bank', 0.16],
      ['heat-haze', 0.1],
    ],
    effectiveVisibility: 0,
  },
  {
    id: 'heat-haze',
    label: 'Tropical heat haze',
    windSpeed: 3.8,
    gustiness: 0.35,
    squallsPerMinute: 0.03,
    wanderDeg: 12,
    cloudCover: 0.28,
    cloudType: 0.45,
    rain: 0,
    turbidity: 6.4,
    visibility: 13000,
    fog: 0.1,
    minHours: 3,
    maxHours: 7,
    next: [
      ['light-air', 0.4],
      ['fair-breeze', 0.3],
      ['glassy', 0.15],
      ['fresh-cumulus', 0.15],
    ],
    effectiveVisibility: 0,
  },
  {
    id: 'fog-bank',
    label: 'Fog bank',
    windSpeed: 1.7,
    gustiness: 0.3,
    squallsPerMinute: 0,
    wanderDeg: 14,
    cloudCover: 0.8,
    cloudType: 0.1,
    rain: 0,
    turbidity: 7.0,
    visibility: 26000,
    fog: 0.95,
    minHours: 1.5,
    maxHours: 4,
    next: [
      ['light-air', 0.5],
      ['overcast', 0.3],
      ['glassy', 0.2],
    ],
    effectiveVisibility: 0,
  },
  {
    id: 'fair-breeze',
    label: 'Fair — moderate breeze',
    windSpeed: 7.6,
    gustiness: 0.55,
    squallsPerMinute: 0.08,
    wanderDeg: 11,
    cloudCover: 0.38,
    cloudType: 0.7,
    rain: 0,
    turbidity: 2.4,
    visibility: 30000,
    fog: 0.05,
    minHours: 3,
    maxHours: 7,
    next: [
      ['light-air', 0.24],
      ['fresh-cumulus', 0.45],
      ['overcast', 0.26],
      ['heat-haze', 0.05],
    ],
    effectiveVisibility: 0,
  },
  {
    id: 'fresh-cumulus',
    label: 'Fresh breeze, fair-weather cumulus',
    windSpeed: 10.6,
    gustiness: 0.75,
    squallsPerMinute: 0.2,
    wanderDeg: 9,
    cloudCover: 0.46,
    cloudType: 0.92,
    rain: 0.02,
    turbidity: 2.0,
    visibility: 35000,
    fog: 0.02,
    minHours: 3,
    maxHours: 7,
    next: [
      ['fair-breeze', 0.4],
      ['overcast', 0.24],
      ['building-gale', 0.2],
      ['rain-squall', 0.16],
    ],
    effectiveVisibility: 0,
  },
  {
    id: 'clearing',
    label: 'Clearing after rain',
    windSpeed: 9.0,
    gustiness: 0.8,
    squallsPerMinute: 0.22,
    wanderDeg: 10,
    cloudCover: 0.44,
    cloudType: 0.88,
    rain: 0.03,
    turbidity: 1.7,
    // Post-frontal air is the cleanest you ever get. This is the preset that
    // makes a session worth staying in — sharp cumulus over a still-big sea.
    visibility: 42000,
    fog: 0.02,
    minHours: 2,
    maxHours: 5,
    next: [
      ['fresh-cumulus', 0.45],
      ['fair-breeze', 0.35],
      ['light-air', 0.2],
    ],
    effectiveVisibility: 0,
  },
  {
    id: 'overcast',
    label: 'Overcast and grey',
    windSpeed: 8.2,
    gustiness: 0.45,
    squallsPerMinute: 0.06,
    wanderDeg: 10,
    cloudCover: 0.95,
    cloudType: 0.14,
    rain: 0,
    turbidity: 3.6,
    visibility: 19000,
    fog: 0.18,
    minHours: 3,
    maxHours: 8,
    next: [
      ['fair-breeze', 0.25],
      ['rain-squall', 0.3],
      ['building-gale', 0.25],
      ['fog-bank', 0.1],
      ['clearing', 0.1],
    ],
    effectiveVisibility: 0,
  },
  {
    id: 'rain-squall',
    label: 'Rain squall',
    windSpeed: 13.5,
    gustiness: 0.95,
    squallsPerMinute: 0.8,
    wanderDeg: 12,
    cloudCover: 0.93,
    cloudType: 0.82,
    rain: 0.68,
    turbidity: 5.0,
    visibility: 26000,
    fog: 0.05,
    minHours: 0.8,
    maxHours: 2.5,
    next: [
      ['overcast', 0.4],
      ['clearing', 0.35],
      ['building-gale', 0.25],
    ],
    effectiveVisibility: 0,
  },
  {
    id: 'building-gale',
    label: 'Building gale',
    windSpeed: 17.0,
    gustiness: 0.85,
    squallsPerMinute: 0.4,
    wanderDeg: 7,
    cloudCover: 0.9,
    cloudType: 0.88,
    rain: 0.22,
    turbidity: 4.2,
    visibility: 24000,
    fog: 0.03,
    minHours: 1.5,
    maxHours: 3,
    next: [
      ['full-gale', 0.45],
      ['rain-squall', 0.25],
      ['overcast', 0.3],
    ],
    effectiveVisibility: 0,
  },
  {
    id: 'full-gale',
    label: 'Full gale',
    windSpeed: 22.0,
    gustiness: 0.9,
    squallsPerMinute: 0.55,
    wanderDeg: 6,
    cloudCover: 0.98,
    cloudType: 0.94,
    rain: 0.68,
    turbidity: 5.6,
    visibility: 22000,
    fog: 0.02,
    minHours: 2,
    maxHours: 5,
    next: [
      ['storm', 0.25],
      ['building-gale', 0.3],
      ['clearing', 0.45],
    ],
    effectiveVisibility: 0,
  },
  {
    id: 'storm',
    label: 'Storm',
    windSpeed: 27.5,
    gustiness: 1.0,
    squallsPerMinute: 0.7,
    wanderDeg: 5,
    cloudCover: 1.0,
    cloudType: 0.98,
    rain: 0.92,
    turbidity: 6.8,
    visibility: 20000,
    fog: 0.02,
    minHours: 1.5,
    maxHours: 3.5,
    next: [
      ['full-gale', 0.7],
      ['clearing', 0.3],
    ],
    effectiveVisibility: 0,
  },
];

function finalisePresets(): void {
  for (const p of TABLE) {
    const beta =
      betaFromVisibility(p.visibility) + rainBeta(p.rain) + fogBeta(p.fog * FOG_FIELD_MEAN);
    p.effectiveVisibility = visibilityFromBeta(beta);
  }
}
finalisePresets();

export const PRESETS: ReadonlyArray<WeatherPreset> = TABLE;
export const PRESET_IDS: ReadonlyArray<string> = TABLE.map((p) => p.id);

const BY_ID = new Map<string, WeatherPreset>();
for (const p of TABLE) BY_ID.set(p.id, p);

export function presetById(id: string): WeatherPreset | undefined {
  return BY_ID.get(id);
}

export const DEFAULT_PRESET_ID = 'fair-breeze';

/**
 * Pick a successor. `r` must be in [0, 1); passing the RNG value in rather than
 * calling it here keeps this pure and testable.
 */
export function pickSuccessor(p: WeatherPreset, r: number): WeatherPreset {
  let total = 0;
  for (let i = 0; i < p.next.length; i++) total += p.next[i][1];
  let acc = 0;
  const target = r * total;
  for (let i = 0; i < p.next.length; i++) {
    acc += p.next[i][1];
    if (target < acc) return BY_ID.get(p.next[i][0]) ?? p;
  }
  return BY_ID.get(p.next[p.next.length - 1][0]) ?? p;
}

/**
 * A cold front sweeps through when the rain stops on a still-strong wind, or
 * when the wind jumps hard. Frontal passages get a fast, large veer; everything
 * else gets a slow, small wander of the mean direction.
 */
export function isFrontal(from: WeatherPreset, to: WeatherPreset): boolean {
  return (from.rain > 0.3 && to.rain < 0.15) || to.windSpeed - from.windSpeed > 5;
}

const W_WIND = 6;
const W_COVER = 0.3;
const W_TYPE = 0.4;
const W_RAIN = 0.3;
const W_TURB = 3;
const W_LOGVIS = 0.7;

/**
 * Squared normalised distance from a live parameter set to a preset. Used to
 * derive `env.weatherLabel` from what the player can actually see, rather than
 * from whichever preset we happen to be aiming at — so the label stays honest
 * under blending, under UI pins and under a forced capture state.
 */
export function presetDistance(
  p: WeatherPreset,
  windSpeed: number,
  cloudCover: number,
  cloudType: number,
  rain: number,
  turbidity: number,
  visibility: number,
): number {
  const dw = (windSpeed - p.windSpeed) / W_WIND;
  const dc = (cloudCover - p.cloudCover) / W_COVER;
  const dt = (cloudType - p.cloudType) / W_TYPE;
  const dr = (rain - p.rain) / W_RAIN;
  const du = (turbidity - p.turbidity) / W_TURB;
  const dv = Math.log(Math.max(50, visibility) / p.effectiveVisibility) / W_LOGVIS;
  return dw * dw + dc * dc + dt * dt + dr * dr + du * du + dv * dv;
}
