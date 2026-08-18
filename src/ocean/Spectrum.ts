/**
 * Directional wave spectrum — JONSWAP with a Donelan–Banner–Hasselmann
 * directional spread, split into band-limited cascades.
 *
 * Everything in here is the CPU half of a pair: the GLSL in
 * `shaders/spectrum.ts` evaluates the *same* formulas mode-for-mode so the CPU
 * wave sampler and the GPU surface agree. If you change a constant here, change
 * it there. The scalar parameters that vary with weather are computed once per
 * change on the CPU and handed to the shader as uniforms, so only the per-mode
 * shape functions are duplicated.
 */

import type { Environment } from '../types';
import { lwFloat } from '../util/glsl';

export const GRAVITY = 9.81;
/** Wavenumber where surface tension starts to matter, rad/m. */
export const K_CAPILLARY = 364;

/** Peak-enhancement of the wind-sea JONSWAP peak. 3.3 is the standard value. */
export const GAMMA_WIND = 3.3;
/** Swell is a far narrower peak — it has travelled out of its generating area. */
export const GAMMA_SWELL = 7.0;
/** Directional spread exponent for swell (sech^2 beta). Large = narrow. */
export const BETA_SWELL = 11.0;
/** Open-ocean fetch, metres. Caps how long the wind sea can grow. */
const FETCH = 300e3;
/** Pierson–Moskowitz fully developed peak coefficient. */
const PM_PEAK = 0.855;
/** JONSWAP alpha. Only a constant scale — the spectrum is renormalised to Hs. */
const ALPHA = 0.0081;

/**
 * Mode index in the *finer* cascade at which the band handover happens. The
 * finer cascade never carries its own lowest modes (they would tile at its own
 * tile size), the coarser one covers them instead.
 */
const HANDOVER_MODE = 5.0;
/** Half-width of the crossfade, in octaves of k. */
export const HANDOVER_OCTAVES = 0.42;

/** Angular frequency from wavenumber, deep water plus the capillary term. */
export function dispersion(k: number): number {
  return Math.sqrt(GRAVITY * k * (1 + (k * k) / (K_CAPILLARY * K_CAPILLARY)));
}

/* ------------------------------------------------------------------ *
 *  Cascade layout
 * ------------------------------------------------------------------ */

export interface CascadeLayout {
  /** Tile size in metres. */
  size: number;
  /** FFT resolution. */
  n: number;
  /** Lower band edge, rad/m (0 for the coarsest). */
  kMin: number;
  /** Upper band edge, rad/m (Infinity for the finest). */
  kMax: number;
}

/**
 * Tile sizes per cascade count. The coarsest must be big enough that a gale's
 * ~300 m peak swell sits several modes above the fundamental, or the swell
 * visibly repeats. The finest reaches capillary scale for close-up detail.
 */
const TILE_PLANS: Record<number, number[]> = {
  1: [512],
  2: [1024, 64],
  3: [2048, 256, 32],
  4: [2048, 512, 128, 32],
};

/**
 * FFT resolution per cascade. A band-limited cascade only needs enough modes to
 * reach its own upper band edge with ~3 texels per shortest wavelength; going
 * wider is pure bandwidth. Capped at 256 — the FFT is memory-bandwidth bound
 * and the 256 case already resolves 25 cm ripples on the finest tile, which is
 * below a pixel at any sane camera distance.
 */
const MAX_FFT_N = 256;

function pow2ceil(x: number): number {
  let n = 16;
  while (n < x) n *= 2;
  return n;
}

export function buildCascades(count: number, resolution: number): CascadeLayout[] {
  const sizes = TILE_PLANS[Math.max(1, Math.min(4, count))] ?? TILE_PLANS[4];
  const cap = Math.min(MAX_FFT_N, Math.max(64, pow2ceil(resolution)));
  const out: CascadeLayout[] = [];

  for (let i = 0; i < sizes.length; i++) {
    const size = sizes[i];
    const isLast = i === sizes.length - 1;
    // Handover to the next (finer) cascade.
    const kHand = isLast ? Infinity : (HANDOVER_MODE * 2 * Math.PI) / sizes[i + 1];
    // Enough modes to represent the top of our own band, oversampled 3x so
    // bilinear reconstruction of the shortest wave in the band is smooth.
    const n = isLast
      ? cap
      : Math.min(cap, pow2ceil((3 * kHand * size) / (2 * Math.PI)));
    const kPrev = i === 0 ? 0 : (HANDOVER_MODE * 2 * Math.PI) / size;
    out.push({ size, n, kMin: kPrev, kMax: kHand });
  }
  return out;
}

/**
 * Amplitude weight for cascade `i` at wavenumber k. Adjacent cascades use
 * cos/sin of the same crossfade angle so that w_i^2 + w_{i+1}^2 == 1 exactly:
 * the variance of the summed field is the spectrum's variance, with no energy
 * double-counted in the overlap and none lost.
 */
export function cascadeWeight(k: number, kMin: number, kMax: number): number {
  let w = 1;
  if (kMin > 0) {
    // Rising edge: we are the finer cascade of this pair.
    const t = crossfade(k, kMin);
    w *= Math.sin(t * Math.PI * 0.5);
  }
  if (Number.isFinite(kMax)) {
    const t = crossfade(k, kMax);
    w *= Math.cos(t * Math.PI * 0.5);
  }
  return w;
}

function crossfade(k: number, kEdge: number): number {
  const octaves = Math.log2(Math.max(k, 1e-6) / kEdge) / (2 * HANDOVER_OCTAVES) + 0.5;
  const t = octaves < 0 ? 0 : octaves > 1 ? 1 : octaves;
  return t * t * (3 - 2 * t);
}

/* ------------------------------------------------------------------ *
 *  Spectrum shape
 * ------------------------------------------------------------------ */

export interface SpectrumParams {
  /** Wind-sea peak angular frequency, rad/s. */
  omegaPeakWind: number;
  /** Swell peak angular frequency, rad/s. */
  omegaPeakSwell: number;
  /** Variance scale so the wind sea contributes its share of Hs^2/16. */
  varScaleWind: number;
  varScaleSwell: number;
  /** Travel direction of the wind sea, XZ unit vector. */
  windDirX: number;
  windDirZ: number;
  /** Travel direction of the swell, XZ unit vector. */
  swellDirX: number;
  swellDirZ: number;
  /** Horizontal (Gerstner) displacement multiplier. */
  choppiness: number;
  /** Significant wave height actually targeted, m. */
  hs: number;
  /** Dominant wavenumber and frequency — used for orbital velocity + foam flow. */
  peakK: number;
  peakOmega: number;
  /** RMS surface slope of the REAL sea, capillaries included. Drives glitter. */
  slopeRms: number;
  /**
   * The part of `slopeRms^2` that lives above the finest cascade's Nyquist and
   * therefore cannot be geometry or a normal map at any resolution. It has to
   * become roughness instead; see `surface.ts`.
   */
  slopeVarTail: number;
}

/**
 * Cox & Munk 1954, total mean-square surface slope of a clean sea against wind
 * speed at 10 m. This is a measurement, and it is the honest total: a 256-mode
 * cascade reaching 25 rad/m resolves less than a quarter of it, because slope
 * variance is dominated by the centimetre ripple that no FFT grid will ever
 * carry. Renderers that skip this are the ones whose water looks like plastic.
 */
export function coxMunkSlopeVariance(windSpeed10m: number): number {
  return 0.003 + 0.00512 * Math.max(windSpeed10m, 0);
}

/** JONSWAP in angular frequency. */
function jonswapOmega(omega: number, omegaPeak: number, gamma: number): number {
  if (omega <= 1e-4) return 0;
  const sigma = omega <= omegaPeak ? 0.07 : 0.09;
  const d = (omega - omegaPeak) / (sigma * omegaPeak);
  const r = Math.exp(-0.5 * d * d);
  const wp = omegaPeak / omega;
  const wp4 = wp * wp * wp * wp;
  const o5 = omega * omega * omega * omega * omega;
  return ((ALPHA * GRAVITY * GRAVITY) / o5) * Math.exp(-1.25 * wp4) * Math.pow(gamma, r);
}

/**
 * Omnidirectional wavenumber spectrum, m^3/rad. Deep-water Jacobian
 * dω/dk = ½√(g/k) converts the frequency spectrum.
 */
export function spectrumK(k: number, omegaPeak: number, gamma: number): number {
  if (k <= 1e-6) return 0;
  const omega = Math.sqrt(GRAVITY * k);
  return jonswapOmega(omega, omegaPeak, gamma) * 0.5 * Math.sqrt(GRAVITY / k);
}

/**
 * Donelan–Banner–Hasselmann directional spread, normalised so
 * ∫D dθ = 1 over [-π, π]. `thetaRel` is the angle to the mean direction.
 */
export function spreadDBH(omega: number, omegaPeak: number, thetaRel: number): number {
  return spreadSech2(spreadBetaDBH(omega, omegaPeak), thetaRel);
}

/**
 * The DBH spread exponent alone. Split out because it depends only on k, so the
 * CPU sampler hoists it into a per-wavenumber table and pays it once per ring
 * instead of once per mode.
 */
export function spreadBetaDBH(omega: number, omegaPeak: number): number {
  const wr = omega / Math.max(omegaPeak, 1e-4);
  let beta: number;
  if (wr < 0.95) beta = 2.61 * Math.pow(wr, 1.3);
  else if (wr < 1.6) beta = 2.28 * Math.pow(wr, -1.3);
  else {
    const eps = -0.4 + 0.8393 * Math.exp(-0.567 * Math.log(wr * wr));
    beta = Math.pow(10, eps);
  }
  return Math.max(beta, 0.12);
}

export function spreadSech2(beta: number, thetaRel: number): number {
  const s = 1 / Math.cosh(beta * thetaRel);
  return ((beta * 0.5) / Math.tanh(beta * Math.PI)) * s * s;
}

/**
 * Solve the weather state into spectrum parameters. Integrates each component
 * on a log-polar grid to renormalise it onto the requested Hs, and picks up the
 * slope variance on the way (needed for the glitter lobe and for specular
 * anti-aliasing).
 */
export function solveSpectrum(
  env: Environment,
  cascades: CascadeLayout[],
  out?: SpectrumParams,
): SpectrumParams {
  const u = Math.max(0.6, env.windSpeed);
  const hs = Math.max(0.02, env.waveHeight);
  const chop = Math.min(1, Math.max(0, env.choppiness));

  // Fully developed peak, limited by fetch. max() because a short fetch cannot
  // produce the long fully developed peak.
  const omegaPM = (PM_PEAK * GRAVITY) / u;
  const omegaFetch = 22 * Math.cbrt((GRAVITY * GRAVITY) / (u * FETCH));
  const omegaPeakWind = Math.max(omegaPM, omegaFetch);
  const omegaPeakSwell = omegaPeakWind * 0.72;

  // Calm seas are swell-dominated; a whipped-up sea is mostly local chop.
  const swellFrac = 0.62 - 0.44 * chop;

  const kLo = (2 * Math.PI) / cascades[0].size;
  const last = cascades[cascades.length - 1];
  const kHi = (Math.PI * last.n) / last.size;

  // The band-coverage weight depends only on the cascade layout, and both
  // integrations walk the same k grid, so it is worth hoisting: it carries three
  // transcendentals per cascade per step and it was most of the rebake's cost.
  const grid = coverageGrid(kLo, kHi, cascades);
  const windInt = integrate(grid, omegaPeakWind, GAMMA_WIND);
  const swellInt = integrate(grid, omegaPeakSwell, GAMMA_SWELL);

  const targetM0 = (hs * hs) / 16;
  const varScaleWind = ((1 - swellFrac) * targetM0) / Math.max(windInt.m0, 1e-12);
  const varScaleSwell = (swellFrac * targetM0) / Math.max(swellInt.m0, 1e-12);

  // Resolved slope variance, i.e. what the cascades can actually put on screen.
  const m2 = varScaleWind * windInt.m2 + varScaleSwell * swellInt.m2;
  const m2Total = Math.max(m2, coxMunkSlopeVariance(env.windSpeed));
  const peakK = (omegaPeakWind * omegaPeakWind) / GRAVITY;

  const windDirX = -Math.sin(env.windBearing);
  const windDirZ = Math.cos(env.windBearing);
  const swellDirX = -Math.sin(env.swellBearing);
  const swellDirZ = Math.cos(env.swellBearing);

  // Written in place when `out` is given: a rebake must not allocate, because it
  // can land on any frame and a GC pause is worse than the rebake itself.
  const p = out ?? ({} as SpectrumParams);
  p.omegaPeakWind = omegaPeakWind;
  p.omegaPeakSwell = omegaPeakSwell;
  p.varScaleWind = varScaleWind;
  p.varScaleSwell = varScaleSwell;
  p.windDirX = windDirX;
  p.windDirZ = windDirZ;
  p.swellDirX = swellDirX;
  p.swellDirZ = swellDirZ;
  // Steeper chop needs more horizontal displacement, but past ~1.6 the
  // Jacobian folds everywhere and the surface self-intersects.
  p.choppiness = 0.85 + 0.75 * chop;
  p.hs = hs;
  p.peakK = peakK;
  p.peakOmega = dispersion(peakK);
  p.slopeRms = Math.sqrt(Math.max(m2Total, 1e-9));
  p.slopeVarTail = Math.max(m2Total - m2, 0);
  return p;
}

const INTEGRATE_STEPS = 192;

interface CoverageGrid {
  /** Sample wavenumbers, log spaced. */
  k: Float64Array;
  /** Sum of squared cascade weights at each k, times k*dLn. */
  weight: Float64Array;
  /** Number of entries actually used (those with non-zero coverage). */
  count: number;
}

const coverage: CoverageGrid = {
  k: new Float64Array(INTEGRATE_STEPS),
  weight: new Float64Array(INTEGRATE_STEPS),
  count: 0,
};
/** Layout signature the cached grid was built for. */
let coverageKey = '';

/**
 * Log-spaced k grid with the cascades' band coverage folded in. The coverage is
 * a property of the cascade layout alone, so it survives every weather change
 * and is only rebuilt when the layout is.
 */
function coverageGrid(kLo: number, kHi: number, cascades: CascadeLayout[]): CoverageGrid {
  let key = `${kLo}|${kHi}`;
  for (const c of cascades) key += `|${c.size},${c.n},${c.kMin},${c.kMax}`;
  if (key === coverageKey) return coverage;
  coverageKey = key;

  const dLn = Math.log(kHi / kLo) / INTEGRATE_STEPS;
  const lnLo = Math.log(kLo);
  let count = 0;
  for (let i = 0; i < INTEGRATE_STEPS; i++) {
    const k = Math.exp(lnLo + (i + 0.5) * dLn);
    // Sum of squared cascade weights — 1 inside a band, and 1 across a
    // crossfade by construction, but 0 outside the covered range.
    let wSum = 0;
    for (const c of cascades) {
      const w = cascadeWeight(k, c.kMin, c.kMax);
      // A cascade cannot carry modes above its own Nyquist.
      if (k <= (Math.PI * c.n) / c.size) wSum += w * w;
    }
    if (wSum <= 0) continue;
    coverage.k[count] = k;
    // dk = k dLn; the 2π∫...dθ of the normalised spread is 1, so the
    // directional integral drops out and m0 = ∫S(k) dk.
    coverage.weight[count] = wSum * k * dLn;
    count++;
  }
  coverage.count = count;
  return coverage;
}

/**
 * ∫S k dk (variance, m0) and ∫S k^3 dk (slope variance, m2) over the union of
 * the cascade bands, weighted by the same crossfade the shader uses so the
 * renormalisation matches what actually gets rendered.
 */
function integrate(g: CoverageGrid, omegaPeak: number, gamma: number): { m0: number; m2: number } {
  let m0 = 0;
  let m2 = 0;
  for (let i = 0; i < g.count; i++) {
    const k = g.k[i];
    const s = spectrumK(k, omegaPeak, gamma) * g.weight[i];
    m0 += s;
    m2 += s * k * k;
  }
  return { m0, m2 };
}

/** Per-cascade slope variance, for the roughness-from-lost-detail term. */
export function cascadeSlopeVariance(p: SpectrumParams, c: CascadeLayout): number {
  const steps = 64;
  const kLo = (2 * Math.PI) / c.size;
  const kHi = (Math.PI * c.n) / c.size;
  const dLn = Math.log(kHi / kLo) / steps;
  let m2 = 0;
  for (let i = 0; i < steps; i++) {
    const k = kLo * Math.exp((i + 0.5) * dLn);
    const w = cascadeWeight(k, c.kMin, c.kMax);
    if (w <= 0) continue;
    const s =
      (p.varScaleWind * spectrumK(k, p.omegaPeakWind, GAMMA_WIND) +
        p.varScaleSwell * spectrumK(k, p.omegaPeakSwell, GAMMA_SWELL)) *
      w *
      w *
      k *
      dLn;
    m2 += s * k * k;
  }
  return m2;
}

/**
 * Variance density of one discrete mode, m^2. Shared by the CPU sampler and
 * mirrored by `spectrumGLSL`. `dk` is 2π/L for both, so the CPU grid (which
 * uses fewer modes of the same tile) reproduces the GPU field exactly for
 * every mode it carries.
 */
export function modeVariance(
  kx: number,
  kz: number,
  dk: number,
  p: SpectrumParams,
  c: CascadeLayout,
): number {
  const k2 = kx * kx + kz * kz;
  if (k2 < 1e-12) return 0;
  const k = Math.sqrt(k2);
  const w = cascadeWeight(k, c.kMin, c.kMax);
  if (w <= 1e-5) return 0;

  const nx = kx / k;
  const nz = kz / k;
  const omega = dispersion(k);

  const cw = Math.max(-1, Math.min(1, nx * p.windDirX + nz * p.windDirZ));
  const cs = Math.max(-1, Math.min(1, nx * p.swellDirX + nz * p.swellDirZ));

  const sWind =
    p.varScaleWind *
    spectrumK(k, p.omegaPeakWind, GAMMA_WIND) *
    spreadDBH(omega, p.omegaPeakWind, Math.acos(cw));
  const sSwell =
    p.varScaleSwell *
    spectrumK(k, p.omegaPeakSwell, GAMMA_SWELL) *
    spreadSech2(BETA_SWELL, Math.acos(cs));

  // S(kx,kz) = S(k)·D(θ)/k ; variance per mode = S(kx,kz)·dkx·dkz.
  return ((sWind + sSwell) / k) * w * w * dk * dk;
}

/** GLSL mirror of the shape functions above. */
export const SPECTRUM_GLSL = /* glsl */ `
#ifndef OCEAN_SPECTRUM
#define OCEAN_SPECTRUM
#define OC_G 9.81
#define OC_TAU 6.283185307179586
#define OC_KCAP 364.0
#define OC_GAMMA_WIND ${lwFloat(GAMMA_WIND)}
#define OC_GAMMA_SWELL ${lwFloat(GAMMA_SWELL)}
#define OC_BETA_SWELL ${lwFloat(BETA_SWELL)}
#define OC_ALPHA ${lwFloat(ALPHA)}
#define OC_HANDOVER_OCT ${lwFloat(HANDOVER_OCTAVES)}

float ocDispersion(float k){
  return sqrt(OC_G * k * (1.0 + (k*k)/(OC_KCAP*OC_KCAP)));
}

float ocCrossfade(float k, float kEdge){
  float o = log2(max(k, 1e-6) / kEdge) / (2.0 * OC_HANDOVER_OCT) + 0.5;
  float t = clamp(o, 0.0, 1.0);
  return t*t*(3.0 - 2.0*t);
}

// kMax <= 0.0 means "no upper edge".
float ocCascadeWeight(float k, float kMin, float kMax){
  float w = 1.0;
  if (kMin > 0.0) w *= sin(ocCrossfade(k, kMin) * 1.5707963);
  if (kMax > 0.0) w *= cos(ocCrossfade(k, kMax) * 1.5707963);
  return w;
}

float ocJonswap(float omega, float omegaPeak, float gamma){
  if (omega <= 1e-4) return 0.0;
  float sigma = omega <= omegaPeak ? 0.07 : 0.09;
  float d = (omega - omegaPeak) / (sigma * omegaPeak);
  float r = exp(-0.5*d*d);
  float wp = omegaPeak / omega;
  float wp4 = wp*wp*wp*wp;
  float o5 = omega*omega*omega*omega*omega;
  return (OC_ALPHA * OC_G * OC_G / o5) * exp(-1.25*wp4) * pow(gamma, r);
}

float ocSpectrumK(float k, float omegaPeak, float gamma){
  if (k <= 1e-6) return 0.0;
  float omega = sqrt(OC_G * k);
  return ocJonswap(omega, omegaPeak, gamma) * 0.5 * sqrt(OC_G / k);
}

float ocSpreadSech2(float beta, float thetaRel){
  float s = 1.0 / cosh(beta * thetaRel);
  return (beta * 0.5) / tanh(beta * 3.14159265) * s * s;
}

float ocSpreadDBH(float omega, float omegaPeak, float thetaRel){
  float wr = omega / max(omegaPeak, 1e-4);
  float beta;
  if (wr < 0.95)      beta = 2.61 * pow(wr, 1.3);
  else if (wr < 1.6)  beta = 2.28 * pow(wr, -1.3);
  else {
    float eps = -0.4 + 0.8393 * exp(-0.567 * log(wr*wr));
    beta = pow(10.0, eps);
  }
  return ocSpreadSech2(max(beta, 0.12), thetaRel);
}
#endif
`;
