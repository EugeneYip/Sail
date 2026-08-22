import { GLSL } from '../../util/glsl';

/** Tileable 3D gradient noise — the stock simplex is not periodic. */
const TILEABLE = /* glsl */ `
#ifndef SKY_TILEABLE
#define SKY_TILEABLE
float tileGrad3(vec3 p, float period){
  vec3 ip = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float n = 0.0;
  for (int k = 0; k < 2; k++)
  for (int j = 0; j < 2; j++)
  for (int i = 0; i < 2; i++) {
    vec3 o = vec3(float(i), float(j), float(k));
    vec3 cell = mod(ip + o, vec3(period));
    vec3 g = normalize(hash33(cell + 0.5) * 2.0 - 1.0);
    float w = mix(1.0 - u.x, u.x, o.x) * mix(1.0 - u.y, u.y, o.y) * mix(1.0 - u.z, u.z, o.z);
    n += w * dot(g, f - o);
  }
  return n * 1.5;
}
float tilePerlin3(vec3 p, float period, int octaves){
  float a = 0.5, s = 0.0, norm = 0.0, fr = 1.0;
  for (int i = 0; i < 6; i++) {
    if (i >= octaves) break;
    s += a * tileGrad3(p * fr, period * fr);
    norm += a;
    fr *= 2.0;
    a *= 0.5;
  }
  return s / norm;
}
/**
 * PER-AXIS period, and it is not a convenience.
 *
 * The lattice wraps with 'mod(cell, period)', so the field is periodic over the
 * unit square only if the coordinate spans EXACTLY 'period' on each axis. With
 * one scalar for both axes, any anisotropic field — one deliberately scaled
 * differently in x and y to make streaks — silently stops tiling on its short
 * axis. Measured on the shipped cirrus channel, which spanned 1.6 against a
 * period of 9: the mean |step| across the v wrap was 0.306 against 0.0047 in
 * the interior, a 65x discontinuity on a channel whose standard deviation is
 * 0.288. See CLOUD_WEATHER_FRAG for what that drew on screen.
 */
float tileGrad2(vec2 p, vec2 period){
  vec2 ip = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float n = 0.0;
  for (int j = 0; j < 2; j++)
  for (int i = 0; i < 2; i++) {
    vec2 o = vec2(float(i), float(j));
    vec2 cell = mod(ip + o, period);
    vec2 g = normalize(hash22(cell + 0.5) * 2.0 - 1.0);
    float w = mix(1.0 - u.x, u.x, o.x) * mix(1.0 - u.y, u.y, o.y);
    n += w * dot(g, f - o);
  }
  return n * 1.42;
}
float tileGrad2(vec2 p, float period){ return tileGrad2(p, vec2(period)); }
float tilePerlin2(vec2 p, vec2 period, int octaves){
  float a = 0.5, s = 0.0, norm = 0.0, fr = 1.0;
  for (int i = 0; i < 7; i++) {
    if (i >= octaves) break;
    s += a * tileGrad2(p * fr, period * fr);
    norm += a;
    fr *= 2.0;
    a *= 0.5;
  }
  return s / norm;
}
float tilePerlin2(vec2 p, float period, int octaves){
  return tilePerlin2(p, vec2(period), octaves);
}
#endif
`;

/**
 * Base cloud volume, 128^3 RGBA8, one Z slice per draw.
 *   R = Perlin-Worley (the billowy low-frequency shape)
 *   G,B,A = inverted Worley at rising frequencies (the FBM erosion basis)
 */
export const CLOUD_BASE_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
layout(location = 0) out vec4 fragColor;
${GLSL.common}
${GLSL.worley3d}
${TILEABLE}
uniform float uSlice;
uniform float uSize;

void main(){
  vec3 p = vec3(vUv, (uSlice + 0.5) / uSize);

  float perlin = tilePerlin3(p * 4.0, 4.0, 4) * 0.5 + 0.5;
  float wf = worleyFbm3(p, 4.0);
  // Perlin-Worley: keep Perlin's connected billows but carve Worley's cell walls.
  float pw = clamp(remap(perlin, wf - 1.0, 1.0, 0.0, 1.0), 0.0, 1.0);

  float w1 = 1.0 - worley3(p, 8.0).x;
  float w2 = 1.0 - worley3(p, 16.0).x;
  float w3 = 1.0 - worley3(p, 32.0).x;

  fragColor = vec4(pw, w1, w2, w3);
}
`;

/** Detail volume, 32^3 RGB8 — high-frequency Worley for edge erosion. */
export const CLOUD_DETAIL_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
layout(location = 0) out vec4 fragColor;
${GLSL.common}
${GLSL.worley3d}
uniform float uSlice;
uniform float uSize;

void main(){
  vec3 p = vec3(vUv, (uSlice + 0.5) / uSize);
  float a = 1.0 - worley3(p, 6.0).x;
  float b = 1.0 - worley3(p, 12.0).x;
  float c = 1.0 - worley3(p, 24.0).x;
  fragColor = vec4(a, b, c, 1.0);
}
`;

/**
 * Weather map, 512^2 RGBA8, tiling over CLOUD_WEATHER_EXTENT_M.
 *   R = coverage field
 *   G = cloud-type bias (local stratus vs. cumulus)
 *   B = precipitation / density bias
 *   A = cirrus field for the high layer
 */
export const CLOUD_WEATHER_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
layout(location = 0) out vec4 fragColor;
${GLSL.common}
${TILEABLE}

/**
 * Normal CDF, tanh approximation — max error 3e-4, which is far below an 8-bit
 * texel. Used to HISTOGRAM-FLATTEN the coverage field.
 *
 * A sum of Perlin octaves is near-Gaussian and narrow: this mix measured
 * [0.285, 0.703], so thresholding it at '1 - cloudCover' cut a fraction of sky
 * that had almost nothing to do with cloudCover — at 0.38 the field never
 * reached the threshold at all and the sky came out clear. Pushing it through its
 * own CDF makes it uniform on 0..1, which is what makes the threshold in
 * cloudDensity() linear in coverage by construction.
 *
 * COVERAGE_SIGMA is FITTED, not derived: Perlin noise has lighter tails than a
 * Gaussian, so the value that flattens the deciles best is wider than the true
 * standard deviation. 0.074 lands the deciles within 0.022 of uniform. Re-fit it
 * by reading the weather-map deciles if the octave weights below ever change.
 */
const float COVERAGE_SIGMA = 0.074;

float gaussCdf(float x, float sigma){
  float z = x / sigma;
  return 0.5 * (1.0 + tanh(0.7978845608 * (z + 0.044715 * z * z * z)));
}

void main(){
  vec2 p = vUv;
  // Two scales of coverage: synoptic fronts plus individual cell clusters.
  float front = tilePerlin2(p * 2.0, 2.0, 3) * 0.5 + 0.5;
  float cells = tilePerlin2(p * 7.0, 7.0, 4) * 0.5 + 0.5;
  float coverage = gaussCdf(mix(front, cells, 0.55) - 0.5, COVERAGE_SIGMA);

  /*
   * G carries BOTH the cloud-family bias and the per-column base altitude, and a
   * lone period-3 Perlin decorrelates in about 16 km — wider than a frame. So
   * every cloud in view shared one base altitude and one family, and the base
   * drew a dead-straight line across the sky. Measured on the baked field at
   * cover 0.40, the visible cloud base moved only 26 m across a 938 m step and
   * 55 m across 3 km.
   *
   * Adding a period-18 term (2.7 km cells over the 48 km extent) at equal power
   * moves half the variance to a scale you can see across. The 0.71 weights are
   * 1/sqrt(2): summing two independent fields in quadrature keeps the channel's
   * standard deviation, so the TOTAL base-altitude spread and the type spread are
   * unchanged and only their spatial scale moves. Nothing is added to the
   * amplitude, because 'baseAlt' is budgeted against cloudShells() and a bigger
   * swing would hang the lowest bases below the marched shell.
   */
  float typeLo = tilePerlin2(p * 3.0 + vec2(11.3, 4.7), 3.0, 3);
  float typeHi = tilePerlin2(p * 18.0 + vec2(3.9, 21.1), 18.0, 2);
  float type = clamp((typeLo + typeHi) * 0.71 * 0.5 + 0.5, 0.0, 1.0);
  float precip = clamp(tilePerlin2(p * 5.0 + vec2(2.1, 8.9), 5.0, 3) * 0.5 + 0.5, 0.0, 1.0);

  /*
   * Cirrus wants long streaks, so the field is anisotropic: fewer cells along
   * the streak than across it.
   *
   * Flattened for the same reason as coverage: unflattened it never dropped
   * below 0.29, so every threshold left a low-contrast veil over the ENTIRE sky
   * instead of distinct bands with clear air between them.
   *
   * THE PERIODS ARE PER-AXIS AND INTEGER, and both properties are load-bearing.
   * This used to be 'tilePerlin2(vec2(p.x*9, p.y*1.6), 9.0, 4)' — one scalar
   * period of 9 for a v axis that spans 1.6 — so the lattice never closed along
   * v and the channel carried a hard step of 0.31 (65x the interior step) once
   * per tile. A constant-v discontinuity is a straight line along world X, and
   * the cirrus deck is an analytic shell 7.6 km up seen out to 320 km, so the
   * three wraps inside that radius drew three dead-straight streaks across the
   * whole sky, converging on the X vanishing point and passing BEHIND the
   * cumulus because the cirrus slab is composited after the low march. That is
   * DIAGNOSIS's blind critique item (c) — "slab layers seen edge-on, you can see
   * the planes" — and it was one missing vec2.
   *
   * Non-integer periods are equally fatal, just less obviously: 'mod(cell, 1.6)'
   * on an integer lattice lands on 0.4, which is not a lattice point, so the
   * hash is evaluated off-grid and the field is discontinuous EVERYWHERE rather
   * than on one line. Keep these integers.
   *
   * The streaks also got SHORTER, and that is the other half of the fix. The
   * along-streak cell count was 1.6 over the 96 km tile — 60 km cells — so the
   * coarse octave that carries most of the amplitude produced ridges longer than
   * the visible cirrus deck is wide, and a ridge that never ends is a ridge that
   * "crosses the whole sky". 4 and 8 cells put them at 24 km and 12 km, which
   * still reads as streaks — cirrus IS streaks, that is the whole point — while
   * leaving each one a beginning and an end. Measured on the bake: correlation
   * length along the streak 17.17 -> 7.33 km, anisotropy 6.76 -> 2.65x, ridge
   * geometry at the shipped uCirrusAmount 2.63 x 11.81 -> 2.44 x 5.44 km. The
   * histogram flattening survived it untouched — mean 0.505 -> 0.500, sd
   * 0.288 -> 0.293, and the fraction of the map above the threshold 28.9 ->
   * 28.2 % — so COVERAGE_SIGMA did NOT need refitting and 'uCirrusAmount' still
   * means the fraction of sky it says.
   */
  const vec2 CIRRUS_LO = vec2(9.0, 4.0);
  const vec2 CIRRUS_HI = vec2(21.0, 8.0);
  float ci = tilePerlin2(p * CIRRUS_LO, CIRRUS_LO, 4) * 0.5 + 0.5;
  float ci2 = tilePerlin2(p * CIRRUS_HI + vec2(5.5, 1.7), CIRRUS_HI, 3) * 0.5 + 0.5;
  float cirrus = gaussCdf(ci * 0.65 + ci2 * 0.35 - 0.5, COVERAGE_SIGMA * 0.85);

  fragColor = vec4(coverage, type, precip, cirrus);
}
`;
