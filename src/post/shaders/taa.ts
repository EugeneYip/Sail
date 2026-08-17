import { GLSL } from '../../util/glsl';
import { POST_COMMON } from './common';

/**
 * Temporal anti-aliasing resolve.
 *
 * The hard case here is 60% of the screen being animated water whose specular
 * glitter is both very bright and uncorrelated frame to frame. Four things keep
 * it from turning into a smear:
 *
 *  1. Everything happens in Karis-compressed space (`tmap`), so a 40 nit glint
 *     and a 0.4 nit trough are compared on comparable footing and a single
 *     firefly cannot dominate the blend.
 *  2. Clamping is done in YCoCg with independent luma/chroma variance bounds,
 *     then *clipped* (moved along the segment toward the neighbourhood mean)
 *     rather than component-clamped — clamping alone leaves colour fringes.
 *  3. Velocity is dilated by closest depth over a 3x3 neighbourhood so silhouette
 *     pixels take the foreground's motion, not the background's.
 *  4. Feedback drops as local luma disagreement rises, so a rejected sample
 *     converges again in a few frames instead of sticking around.
 *
 * The current-frame sample is a jitter-centred Gaussian over the same 3x3 taps
 * used for the variance box (free), which removes most of the residual
 * "temporal fizz"; the softness that costs us is bought back by RCAS.
 */
export const TAA_FRAG = /* glsl */ `
precision highp float;
${GLSL.common}
${POST_COMMON}
uniform sampler2D tCurrent;
uniform sampler2D tHistory;
uniform sampler2D tVelocity;
uniform sampler2D tDepth;
uniform vec2 uTexelSize;
uniform vec2 uResolution;
uniform vec2 uJitterPixels;
uniform float uFeedbackMin;
uniform float uFeedbackMax;
uniform float uVarianceGamma;
uniform float uFilterWidth;
uniform float uReset;
varying vec2 vUv;

vec3 clipAabb(vec3 lo, vec3 hi, vec3 mean, vec3 q) {
  vec3 center = 0.5 * (hi + lo);
  vec3 extents = max(0.5 * (hi - lo), vec3(1e-5));
  vec3 offset = q - center;
  vec3 rel = abs(offset) / extents;
  float m = max(max(rel.x, rel.y), rel.z);
  // Pull toward the mean, not the centre of the box, when we have to clip.
  return m > 1.0 ? mix(mean, q, 1.0 / m) : q;
}

void main() {
  // --- 1. closest-depth velocity dilation
  vec2 bestOff = vec2(0.0);
  float bestDepth = 2.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 o = vec2(float(i), float(j)) * uTexelSize;
      float d = texture2D(tDepth, vUv + o).x;
      if (d < bestDepth) { bestDepth = d; bestOff = o; }
    }
  }
  vec2 vel = texture2D(tVelocity, vUv + bestOff).xy;
  vec2 histUv = vUv - vel;

  // --- 2. current neighbourhood: jitter-centred filter + variance box
  vec3 m1 = vec3(0.0), m2 = vec3(0.0);
  vec3 boxMin = vec3(1e9), boxMax = vec3(-1e9);
  vec3 filtered = vec3(0.0);
  float wsum = 0.0;
  vec3 centreTap = vec3(0.0);
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 fo = vec2(float(i), float(j));
      vec3 s = rgbToYCoCg(tmap(max(texture2D(tCurrent, vUv + fo * uTexelSize).rgb, vec3(0.0))));
      m1 += s;
      m2 += s * s;
      boxMin = min(boxMin, s);
      boxMax = max(boxMax, s);
      if (i == 0 && j == 0) centreTap = s;
      vec2 d = fo - uJitterPixels;
      float w = exp(-2.29 * dot(d, d) * uFilterWidth);
      filtered += s * w;
      wsum += w;
    }
  }
  vec3 cur = mix(centreTap, filtered / max(wsum, 1e-5), min(uFilterWidth, 1.0));

  vec3 mean = m1 / 9.0;
  vec3 sigma = sqrt(max(m2 / 9.0 - mean * mean, vec3(0.0)));
  // Chroma gets a wider bound than luma: a tight chroma box makes coloured
  // highlights (sunset glitter) flicker, a tight luma box is what we want.
  vec3 gamma = uVarianceGamma * vec3(1.0, 1.35, 1.35);
  vec3 lo = max(mean - gamma * sigma, boxMin);
  vec3 hi = min(mean + gamma * sigma, boxMax);

  // --- 3. history
  vec3 histRgb = sampleCatmullRom(tHistory, histUv, uResolution);
  vec3 hist = rgbToYCoCg(tmap(histRgb));
  hist = clipAabb(lo, hi, mean, hist);

  // --- 4. feedback weight
  float onscreen = (histUv.x > 0.0 && histUv.x < 1.0 && histUv.y > 0.0 && histUv.y < 1.0) ? 1.0 : 0.0;
  float lumaDiff = abs(hist.x - cur.x) / max(max(hist.x, cur.x), 0.15);
  float w = mix(uFeedbackMax, uFeedbackMin, saturate1(lumaDiff * 1.6));
  float velPx = length(vel * uResolution);
  // A fast whip has almost no usable history; trust the current frame more.
  w *= 1.0 - saturate1(velPx / 48.0) * 0.30;
  w *= onscreen * (1.0 - uReset);

  vec3 outY = mix(cur, hist, w);
  gl_FragColor = vec4(max(tunmap(yCoCgToRgb(outY)), vec3(0.0)), 1.0);
}
`;

/**
 * RCAS-style sharpen. TAA's history resampling and the jitter-centred filter
 * both cost a little acuity; this buys it back without ringing because the
 * result is limited to the range already present in the 5-tap cross.
 */
export const SHARPEN_FRAG = /* glsl */ `
precision highp float;
${GLSL.common}
${POST_COMMON}
uniform sampler2D tColor;
uniform vec2 uTexelSize;
uniform float uAmount;
varying vec2 vUv;

void main() {
  vec3 e = tmap(max(texture2D(tColor, vUv).rgb, vec3(0.0)));
  vec3 b = tmap(max(texture2D(tColor, vUv + vec2(0.0, -uTexelSize.y)).rgb, vec3(0.0)));
  vec3 d = tmap(max(texture2D(tColor, vUv + vec2(-uTexelSize.x, 0.0)).rgb, vec3(0.0)));
  vec3 f = tmap(max(texture2D(tColor, vUv + vec2( uTexelSize.x, 0.0)).rgb, vec3(0.0)));
  vec3 h = tmap(max(texture2D(tColor, vUv + vec2(0.0,  uTexelSize.y)).rgb, vec3(0.0)));

  vec3 mn = min(min(min(b, d), min(f, h)), e);
  vec3 mx = max(max(max(b, d), max(f, h)), e);
  vec3 sharp = e + (4.0 * e - (b + d + f + h)) * (uAmount * 0.25);
  // Hard-limit to the local range: this is the whole trick behind RCAS.
  sharp = clamp(sharp, mn, mx);
  gl_FragColor = vec4(tunmap(sharp), 1.0);
}
`;
