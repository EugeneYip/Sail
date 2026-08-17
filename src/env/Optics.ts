/**
 * Visibility bookkeeping.
 *
 * Extinction coefficients ADD; visibility distances do not. So every obscurant
 * (clean air, rain, fog) contributes a beta and we convert back once at the end.
 * This is why visibility can only ever get worse when weather is added, and why
 * a fog bank inside a rain squall behaves correctly without any special case.
 *
 * Koschmieder: V = 3.912 / beta for a 2% contrast threshold. The engine's
 * default uniforms agree with this (uVisibility 22000 <-> uFogDensity 0.00018),
 * so `uFogDensity` is exactly this beta.
 */

export const KOSCHMIEDER = 3.912;

/** Metres of visibility -> extinction coefficient, 1/m. */
export function betaFromVisibility(metres: number): number {
  return KOSCHMIEDER / Math.max(1, metres);
}

/** Extinction coefficient -> metres of visibility. */
export function visibilityFromBeta(beta: number): number {
  return KOSCHMIEDER / Math.max(1e-9, beta);
}

/**
 * Rain extinction. Calibrated so that a full gale's 0.68 rain over 22 km clear
 * air lands on ~5.2 km, matching the capture harness's `storm` scene; driving
 * rain (1.0) alone caps visibility at ~4.3 km.
 */
const RAIN_BETA = 9.0e-4;
const RAIN_EXP = 1.15;
export function rainBeta(rain: number): number {
  if (rain <= 0) return 0;
  return RAIN_BETA * Math.pow(rain, RAIN_EXP);
}

/**
 * Fog extinction. The exponent gives a long hazy toe and a dense core, so a fog
 * bank reads as ~9 km haze at its edge and ~220 m pea soup in the middle rather
 * than as a linear ramp.
 */
const FOG_BETA = 0.0196;
const FOG_EXP = 2.2;
export function fogBeta(fog: number): number {
  if (fog <= 0) return 0;
  return FOG_BETA * Math.pow(fog, FOG_EXP);
}

/** Metres. Below this the ocean shader has nothing left to shade. */
export const VISIBILITY_MIN = 90;
export const VISIBILITY_MAX = 60000;
