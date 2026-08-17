import { GLSL } from '../../util/glsl';

export const EXPOSURE_BINS = 64;
/** Square luminance mip the histogram is built from. */
export const EXPOSURE_LUM_SIZE = 64;
/** Horizontal strips the partial histogram is split into, for occupancy. */
export const EXPOSURE_STRIPS = 32;

/** log2(luminance) range covered by the histogram, in our scene-radiance units. */
export const EXPOSURE_MIN_LOG = -10;
export const EXPOSURE_MAX_LOG = 8;

/**
 * Pass 1 — log-luminance reduce to a small square.
 *
 * 16 bilinear taps per output texel cover the whole footprint, so a single
 * specular pixel cannot swing a bin; the log is taken per tap so the reduce is
 * a geometric mean, which is what exposure metering wants.
 */
export const LUM_REDUCE_FRAG = /* glsl */ `
precision highp float;
${GLSL.common}
uniform sampler2D tScene;
uniform vec2 uSceneTexel;
uniform vec2 uFootprint;   // source texels covered by one output texel
varying vec2 vUv;

void main() {
  float sum = 0.0;
  for (int j = 0; j < 4; j++) {
    for (int i = 0; i < 4; i++) {
      vec2 f = (vec2(float(i), float(j)) + 0.5) * 0.25 - 0.5;
      vec2 uv = vUv + f * uFootprint * uSceneTexel;
      vec3 c = max(texture2D(tScene, uv).rgb, vec3(0.0));
      sum += log2(max(luminance(c), 1e-6));
    }
  }
  gl_FragColor = vec4(sum / 16.0, 0.0, 0.0, 1.0);
}
`;

/**
 * Pass 2 — partial weighted histogram.
 *
 * Output is BINS x STRIPS; texel (b, s) holds the total centre-weight of the
 * luminance texels in strip `s` that fall in bin `b`. Metering weight peaks
 * slightly below frame centre, where the ship sits: a plain average would let
 * a bright sky set the exposure and silhouette the hull.
 */
export const HISTOGRAM_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tLum;
uniform float uBins;
uniform float uStrips;
uniform float uLumSize;
uniform vec2 uRange;      // (minLog, maxLog)
varying vec2 vUv;

float meteringWeight(vec2 uv) {
  vec2 q = (uv - vec2(0.5, 0.45)) * vec2(1.0, 1.15);
  float r2 = dot(q, q) * 4.0;
  return exp(-r2 * 1.4) * 0.85 + 0.15;
}

void main() {
  float bin = floor(vUv.x * uBins);
  float strip = floor(vUv.y * uStrips);
  float rowsPerStrip = uLumSize / uStrips;
  float invRange = 1.0 / (uRange.y - uRange.x);

  float total = 0.0;
  for (int r = 0; r < 8; r++) {
    if (float(r) >= rowsPerStrip) break;
    float y = (strip * rowsPerStrip + float(r) + 0.5) / uLumSize;
    for (int c = 0; c < 64; c++) {
      if (float(c) >= uLumSize) break;
      float x = (float(c) + 0.5) / uLumSize;
      float logLum = texture2D(tLum, vec2(x, y)).r;
      float t = clamp((logLum - uRange.x) * invRange, 0.0, 0.99999);
      float b = floor(t * uBins);
      if (b == bin) total += meteringWeight(vec2(x, y));
    }
  }
  gl_FragColor = vec4(total, 0.0, 0.0, 1.0);
}
`;

/** Pass 3 — collapse the strips. */
export const HISTOGRAM_REDUCE_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tPartial;
uniform float uStrips;
varying vec2 vUv;

void main() {
  float sum = 0.0;
  for (int s = 0; s < 64; s++) {
    if (float(s) >= uStrips) break;
    sum += texture2D(tPartial, vec2(vUv.x, (float(s) + 0.5) / uStrips)).r;
  }
  gl_FragColor = vec4(sum, 0.0, 0.0, 1.0);
}
`;

/**
 * Pass 4 — weighted percentile band into a 1x1 float target for readback.
 *
 * Averaging the whole histogram lets whatever covers the most pixels win. We
 * instead average only the band between two percentiles, which throws away the
 * sun disc and the specular glitter at the top and the deep shadow at the
 * bottom. Output: (meanLog2Luminance, totalWeight, 0, 1).
 */
export const HISTOGRAM_RESOLVE_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tHistogram;
uniform float uBins;
uniform vec2 uRange;
uniform vec2 uPercentile;   // (low, high) in 0..1
varying vec2 vUv;

void main() {
  float total = 0.0;
  for (int b = 0; b < 64; b++) {
    if (float(b) >= uBins) break;
    total += texture2D(tHistogram, vec2((float(b) + 0.5) / uBins, 0.5)).r;
  }
  if (total <= 0.0) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  float loClip = total * uPercentile.x;
  float hiClip = total * uPercentile.y;
  float acc = 0.0, sum = 0.0, wsum = 0.0;
  float span = (uRange.y - uRange.x) / uBins;
  for (int b = 0; b < 64; b++) {
    if (float(b) >= uBins) break;
    float c = texture2D(tHistogram, vec2((float(b) + 0.5) / uBins, 0.5)).r;
    float lo = acc;
    acc += c;
    float w = max(0.0, min(acc, hiClip) - max(lo, loClip));
    float logLum = uRange.x + (float(b) + 0.5) * span;
    sum += w * logLum;
    wsum += w;
  }
  gl_FragColor = vec4(wsum > 0.0 ? sum / wsum : 0.0, total, 0.0, 1.0);
}
`;
