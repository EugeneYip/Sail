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
float tileGrad2(vec2 p, float period){
  vec2 ip = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float n = 0.0;
  for (int j = 0; j < 2; j++)
  for (int i = 0; i < 2; i++) {
    vec2 o = vec2(float(i), float(j));
    vec2 cell = mod(ip + o, vec2(period));
    vec2 g = normalize(hash22(cell + 0.5) * 2.0 - 1.0);
    float w = mix(1.0 - u.x, u.x, o.x) * mix(1.0 - u.y, u.y, o.y);
    n += w * dot(g, f - o);
  }
  return n * 1.42;
}
float tilePerlin2(vec2 p, float period, int octaves){
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

  // Cirrus wants long streaks, so sample an anisotropically stretched field.
  // Flattened for the same reason as coverage: unflattened it never dropped below
  // 0.29, so every threshold left a low-contrast veil over the ENTIRE sky instead
  // of distinct bands with clear air between them.
  float ci = tilePerlin2(vec2(p.x * 9.0, p.y * 1.6), 9.0, 4) * 0.5 + 0.5;
  float ci2 = tilePerlin2(vec2(p.x * 21.0, p.y * 3.2) + vec2(5.5, 1.7), 21.0, 3) * 0.5 + 0.5;
  float cirrus = gaussCdf(ci * 0.65 + ci2 * 0.35 - 0.5, COVERAGE_SIGMA * 0.85);

  fragColor = vec4(coverage, type, precip, cirrus);
}
`;
