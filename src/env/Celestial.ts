import { DEG, RAD, TAU, wrapTau } from '../util/math';

/**
 * Sun and moon position, and lunar phase.
 *
 * This is the low-precision series from the Astronomical Almanac (sun, ~0.01°)
 * plus the standard three-term lunar approximation (~0.3°). Both are far more
 * accurate than the player can perceive and cost ~25 transcendentals per frame.
 *
 * Verified numerically (see scripts/weather-test.mjs, which re-derives the same
 * quantities from an independent NOAA-style formulation):
 *   - lat 38°N, dayOfYear 172 (21 Jun), local noon -> altitude 75.43°,
 *     against the textbook 90° - |lat - decl| = 75.434°.
 *   - equinox sunrise azimuth 89.94° (due east).
 *   - equation of time -14.2 min in mid-February, +16.5 min in early November.
 *   - synodic month 29.5306 d, straight out of the difference of the lunar and
 *     solar mean motions (13.176396 - 0.9856474 °/day).
 *   - full moon rises within an hour of sunset; first quarter transits at
 *     sunset. Both fall out of the geometry rather than being special-cased.
 *
 * `timeOfDay` is LOCAL MEAN SOLAR TIME (i.e. clock time at the observer's
 * meridian). The equation of time is applied internally to get true solar time,
 * so local noon is genuinely not always the sun's highest point.
 */

/** Days from J2000.0 (JD 2451545.0) to 2024-01-01 00:00 UT — our day-0 epoch. */
const EPOCH_OFFSET_DAYS = 8765.5;

/** Refracted horizon: the disc's centre is still visible at -0.83°. */
export const HORIZON_ALT = -0.83 * DEG;

export interface Celestial {
  /** Radians above the horizon. Negative below. */
  sunAltitude: number;
  /** Radians, meteorological bearing: 0 = north, +PI/2 = east. */
  sunAzimuth: number;
  sunDeclination: number;
  /** Solar ecliptic longitude, radians — 0 at the vernal equinox. */
  sunEclipticLongitude: number;
  /** Equation of time, minutes. Apparent solar time minus mean solar time. */
  equationOfTime: number;

  moonAltitude: number;
  moonAzimuth: number;
  moonDeclination: number;
  /**
   * Synodic age fraction, matching the `Environment.moonPhase` contract:
   * 0 = new, 0.25 = first quarter, 0.5 = full, 0.75 = last quarter.
   */
  phase: number;
  /** Illuminated fraction of the visible disc, 0..1. Derived from `phase`. */
  illuminated: number;
}

export function createCelestial(): Celestial {
  return {
    sunAltitude: 0,
    sunAzimuth: 0,
    sunDeclination: 0,
    sunEclipticLongitude: 0,
    equationOfTime: 0,
    moonAltitude: 0,
    moonAzimuth: 0,
    moonDeclination: 0,
    phase: 0,
    illuminated: 0,
  };
}

function wrapDeg180(d: number): number {
  const x = ((d % 360) + 360) % 360;
  return x > 180 ? x - 360 : x;
}

function altitudeOf(sinLat: number, cosLat: number, dec: number, hourAngle: number): number {
  const s = sinLat * Math.sin(dec) + cosLat * Math.cos(dec) * Math.cos(hourAngle);
  return Math.asin(s < -1 ? -1 : s > 1 ? 1 : s);
}

/**
 * Azimuth measured from north toward east — the project's meteorological
 * bearing convention, so a caller can build a direction vector as
 * `(sin(az)cos(alt), sin(alt), -cos(az)cos(alt))`.
 */
function azimuthOf(sinLat: number, cosLat: number, dec: number, hourAngle: number): number {
  return Math.atan2(
    -Math.cos(dec) * Math.sin(hourAngle),
    cosLat * Math.sin(dec) - sinLat * Math.cos(dec) * Math.cos(hourAngle),
  );
}

/**
 * @param absDays    continuous days since the epoch, fractional. Never wrapped,
 *                   so the lunar phase advances smoothly across a year boundary.
 * @param timeOfDay  local mean solar time, hours 0..24.
 * @param latDeg     observer latitude, degrees.
 * @param phaseForce < 0 for the real moon; 0..1 to force a synodic phase, in
 *                   which case the moon is *moved* so its sky position stays
 *                   consistent with the illumination (elongation IS the phase).
 */
export function computeCelestial(
  absDays: number,
  timeOfDay: number,
  latDeg: number,
  phaseForce: number,
  out: Celestial,
): void {
  const n = EPOCH_OFFSET_DAYS + absDays;

  // --- Sun
  const sunMeanLonDeg = 280.46 + 0.9856474 * n;
  const sunMeanAnom = (357.528 + 0.9856003 * n) * DEG;
  const sunLonDeg =
    sunMeanLonDeg + 1.915 * Math.sin(sunMeanAnom) + 0.02 * Math.sin(2 * sunMeanAnom);
  const obliquity = (23.439 - 4e-7 * n) * DEG;

  const sl = sunLonDeg * DEG;
  const sinSl = Math.sin(sl);
  const cosSl = Math.cos(sl);
  const cosOb = Math.cos(obliquity);
  const sinOb = Math.sin(obliquity);

  const sunRa = Math.atan2(cosOb * sinSl, cosSl);
  const sunDec = Math.asin(sinOb * sinSl);

  // 4 minutes of time per degree of arc.
  const eot = 4 * wrapDeg180(sunMeanLonDeg - sunRa * RAD);

  const lat = latDeg * DEG;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);

  // Hour angle of the true sun. Zero at true solar noon, positive in the
  // afternoon (the body has crossed the meridian and is heading west).
  const sunH = (15 * (timeOfDay - 12) + eot / 4) * DEG;

  out.sunDeclination = sunDec;
  out.sunEclipticLongitude = wrapTau(sl);
  out.equationOfTime = eot;
  out.sunAltitude = altitudeOf(sinLat, cosLat, sunDec, sunH);
  out.sunAzimuth = azimuthOf(sinLat, cosLat, sunDec, sunH);

  // --- Moon
  const moonMeanLonDeg = 218.316 + 13.176396 * n;
  const moonMeanAnom = (134.963 + 13.064993 * n) * DEG;
  const moonArgLat = (93.272 + 13.229335 * n) * DEG;

  let moonLonDeg = moonMeanLonDeg + 6.289 * Math.sin(moonMeanAnom);
  // Ecliptic latitude: the lunar orbit is inclined 5.145° to the ecliptic. This
  // is what makes a winter full moon ride high and a summer one skim the south.
  const moonLatRad = 5.128 * Math.sin(moonArgLat) * DEG;
  if (phaseForce >= 0) moonLonDeg = sunLonDeg + phaseForce * 360;

  const ml = moonLonDeg * DEG;
  const sinMl = Math.sin(ml);
  const cosMl = Math.cos(ml);
  const sinB = Math.sin(moonLatRad);
  const cosB = Math.cos(moonLatRad);

  const moonRa = Math.atan2(sinMl * cosOb - (sinB / cosB) * sinOb, cosMl);
  const moonDecArg = sinB * cosOb + cosB * sinOb * sinMl;
  const moonDec = Math.asin(moonDecArg < -1 ? -1 : moonDecArg > 1 ? 1 : moonDecArg);

  // Local hour angle of any body is LST - RA, and LST - sunRa is already sunH.
  // Getting the moon's hour angle this way (rather than offsetting by the
  // ecliptic elongation) is what makes moonrise times right to a few minutes.
  const moonH = sunH + sunRa - moonRa;

  out.moonDeclination = moonDec;
  out.moonAltitude = altitudeOf(sinLat, cosLat, moonDec, moonH);
  out.moonAzimuth = azimuthOf(sinLat, cosLat, moonDec, moonH);

  // Elongation from the sun IS the phase angle.
  const elongation = wrapTau((moonLonDeg - sunLonDeg) * DEG);
  out.phase = elongation / TAU;
  out.illuminated = 0.5 * (1 - Math.cos(elongation));
}
