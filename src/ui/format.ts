/** Unit conversion and period-correct naming for the HUD. Pure functions. */

export const RAD2DEG = 180 / Math.PI;
const MS_PER_KNOT = 0.5144444444444445;

export function toKnots(metresPerSecond: number): number {
  return metresPerSecond / MS_PER_KNOT;
}

export function normDeg(d: number): number {
  const m = d % 360;
  return m < 0 ? m + 360 : m;
}

export function bearingDeg(rad: number): number {
  return normDeg(rad * RAD2DEG);
}

/** Three-digit compass bearing, the way it is spoken and written. */
export function bearing3(deg: number): string {
  const d = Math.round(normDeg(deg)) % 360;
  return String(d).padStart(3, '0');
}

const CARDINAL_16 = [
  'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
];

export function cardinal(deg: number): string {
  return CARDINAL_16[Math.round(normDeg(deg) / 22.5) % 16];
}

/** Royal Navy descriptive names for the Beaufort scale. */
const BEAUFORT_NAMES = [
  'calm', 'light air', 'light breeze', 'gentle breeze', 'moderate breeze',
  'fresh breeze', 'strong breeze', 'near gale', 'gale', 'strong gale',
  'storm', 'violent storm', 'hurricane',
];

export function beaufortName(force: number): string {
  return BEAUFORT_NAMES[Math.max(0, Math.min(12, Math.round(force)))];
}

/** Douglas sea-state descriptions 0..9. */
const SEA_STATE_NAMES = [
  'glassy', 'rippled', 'smooth', 'slight', 'moderate',
  'rough', 'very rough', 'high', 'very high', 'phenomenal',
];

export function seaStateName(state: number): string {
  return SEA_STATE_NAMES[Math.max(0, Math.min(9, Math.round(state)))];
}

/** Wind speed in m/s to Beaufort force (standard scale boundaries). */
const BEAUFORT_LIMITS = [0.3, 1.6, 3.4, 5.5, 8.0, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7];
export function beaufortFromSpeed(ms: number): number {
  for (let i = 0; i < BEAUFORT_LIMITS.length; i++) if (ms < BEAUFORT_LIMITS[i]) return i;
  return 12;
}

/* ------------------------------------------------------------------ *
 *  Ship's time
 * ------------------------------------------------------------------ */

interface Watch {
  start: number;
  name: string;
}

/**
 * The seven watches of a day at sea. The 16:00–20:00 block is split into the
 * two two-hour dog watches so a crew never keeps the same watch twice running.
 */
const WATCHES: Watch[] = [
  { start: 0, name: 'Middle watch' },
  { start: 4, name: 'Morning watch' },
  { start: 8, name: 'Forenoon watch' },
  { start: 12, name: 'Afternoon watch' },
  { start: 16, name: 'First dog watch' },
  { start: 18, name: 'Last dog watch' },
  { start: 20, name: 'First watch' },
];

const BELL_WORDS = ['eight', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];

export interface ShipTime {
  /** e.g. "Forenoon watch" */
  watch: string;
  /** 1..8 */
  bells: number;
  /** e.g. "four bells" */
  bellText: string;
  /** "10:14" */
  clock: string;
}

export function shipTime(hours: number): ShipTime {
  const h = ((hours % 24) + 24) % 24;

  let w = WATCHES[0];
  for (const cand of WATCHES) if (h >= cand.start) w = cand;

  // A bell every half hour from the top of the watch; the change of watch is
  // always eight bells, except at 18:00 which ends the short first dog watch.
  const half = Math.floor((h - w.start) * 2 + 1e-6);
  const bells = half === 0 ? (w.start === 18 ? 4 : 8) : half;

  const hh = Math.floor(h);
  const mm = Math.floor((h - hh) * 60);
  return {
    watch: w.name,
    bells,
    bellText: `${BELL_WORDS[bells]} bell${bells === 1 ? '' : 's'}`,
    clock: `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`,
  };
}

/* ------------------------------------------------------------------ *
 *  Misc
 * ------------------------------------------------------------------ */

/** "Close hauled" from "close hauled" — physics writes lower case. */
export function sentenceCase(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

export function visibilityText(metres: number): string {
  if (metres >= 20000) return `${Math.round(metres / 1000)} km`;
  if (metres >= 1000) return `${(metres / 1000).toFixed(1)} km`;
  return `${Math.round(metres / 50) * 50} m`;
}

/** Thin-space thousands separator so 2 140 m² reads as one number. */
export function groupedInt(v: number): string {
  const n = Math.round(v);
  return n >= 1000 ? `${Math.floor(n / 1000)} ${String(n % 1000).padStart(3, '0')}` : String(n);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Shortest signed difference between two angles in degrees, [-180, 180). */
export function deltaDeg(a: number, b: number): number {
  let d = (a - b) % 360;
  if (d >= 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}
