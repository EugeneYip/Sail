import { GLSL } from '../../util/glsl';
import { POST_COMMON } from './common';

/**
 * Physically parameterised depth of field.
 *
 * Circle of confusion comes straight from the thin-lens equation using the
 * camera rig's `focusDistance` and `aperture` and a 24 mm sensor height:
 *
 *   f      = (sensorHeight/2) / tan(fov/2)
 *   coc_mm = (f^2 / N) * |d - focus| / (focus * (d - f))
 *   coc_px = coc_mm / sensorHeight * screenHeight
 *
 * At the defaults (58 deg fov, f/2.8, 80 m focus) that is ~0.05 px at 200 m and
 * ~3 px for rigging at 2 m — which is the point. slowroads has a barely-there
 * DoF and anything more on an ocean scene reads as a bug, not as a lens.
 */
const COC_GLSL = /* glsl */ `
uniform vec2 uCocParams;    // (f^2 / N, focalLength) in metres
uniform vec2 uCocScale;     // (screenHeight / sensorHeight, 1 / maxCoc)
uniform float uFocus;       // metres
uniform vec2 uDepthRange;   // (near, far)
uniform float uMaxCoc;      // full-res pixels

/** Signed CoC in full-res pixels. Negative = in front of the focal plane. */
float cocFromDepth(float depth) {
  float d = linearDepth(depth, uDepthRange.x, uDepthRange.y);
  float mm = uCocParams.x * abs(d - uFocus) / max(uFocus * (d - uCocParams.y), 1e-4);
  float px = mm * uCocScale.x;
  return clamp(px, 0.0, uMaxCoc) * sign(d - uFocus);
}
`;

/** Half-res colour + CoC. Alpha holds the signed CoC normalised by uMaxCoc. */
export const DOF_PREPARE_FRAG = /* glsl */ `
precision highp float;
${GLSL.common}
${POST_COMMON}
${COC_GLSL}
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform vec2 uFullTexel;
varying vec2 vUv;

void main() {
  // One bilinear colour tap at the half-res centre already averages the 2x2.
  vec3 c = max(texture2D(tColor, vUv).rgb, vec3(0.0));
  // CoC takes the most extreme of the 2x2 so a thin near-field silhouette does
  // not get averaged away against the sharp background behind it.
  float best = 0.0;
  for (int j = 0; j < 2; j++) {
    for (int i = 0; i < 2; i++) {
      vec2 o = (vec2(float(i), float(j)) - 0.5) * uFullTexel;
      float coc = cocFromDepth(texture2D(tDepth, vUv + o).x);
      if (abs(coc) > abs(best)) best = coc;
    }
  }
  gl_FragColor = vec4(c, best * uCocScale.y);
}
`;

/** 1/8-res max near-field CoC, used to size the near gather's search radius. */
export const DOF_NEAR_MAX_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tHalf;
uniform vec2 uHalfTexel;
varying vec2 vUv;

void main() {
  float m = 0.0;
  for (int j = 0; j < 4; j++) {
    for (int i = 0; i < 4; i++) {
      vec2 o = (vec2(float(i), float(j)) - 1.5) * uHalfTexel;
      m = max(m, -texture2D(tHalf, vUv + o).a);
    }
  }
  gl_FragColor = vec4(m, 0.0, 0.0, 1.0);
}
`;

/**
 * Gather bokeh, one pass per field.
 *
 * Both fields use a golden-angle spiral with a hexagonal squeeze, so the bokeh
 * reads as a real iris rather than a Gaussian blob. The weighting differs:
 *
 * FAR: search radius is the *centre* pixel's CoC and a sample only contributes
 * if its own CoC reaches this pixel. That is what stops sharp background from
 * being averaged in, and equally stops a sharp foreground from bleeding into a
 * blurred background.
 *
 * NEAR: search radius comes from the dilated near-CoC map, not from the centre
 * pixel, so out-of-focus foreground genuinely spreads *outward* over sharp
 * background instead of being clipped to its own silhouette (the classic
 * "foreground has a hard edge" DoF tell). Coverage accumulates into alpha.
 */
export const DOF_GATHER_FRAG = /* glsl */ `
precision highp float;
${GLSL.common}
uniform sampler2D tHalf;
uniform sampler2D tNearMax;
uniform vec2 uHalfTexel;
uniform float uMaxCoc;
uniform float uAspect;
uniform float uFrame;
varying vec2 vUv;

#ifndef DOF_TAPS
#define DOF_TAPS 16
#endif
#define GOLDEN 2.399963229728653

/** Hexagonal aperture: pull the spiral radius in toward the six flats. */
vec2 apertureOffset(float angle, float radius) {
  float hex = 1.0 - 0.09 * cos(6.0 * angle);
  return vec2(cos(angle), sin(angle)) * radius * hex;
}

void main() {
  vec2 uv = vUv;
  vec4 centre = texture2D(tHalf, uv);

#ifdef DOF_NEAR
  float searchPx = texture2D(tNearMax, uv).r * uMaxCoc * 0.5;
#else
  float searchPx = max(centre.a * uMaxCoc, 0.0) * 0.5;
#endif

  if (searchPx < 0.6) {
    gl_FragColor = vec4(centre.rgb, 0.0);
    return;
  }

  // Rotating the spiral per pixel trades banding for a little dither, which the
  // half-res upsample then hides.
  float rot = ign(gl_FragCoord.xy) * TAU + uFrame * 0.61803399 * TAU;
  vec3 accum = vec3(0.0);
  float wsum = 0.0;
  float coverage = 0.0;

  for (int k = 0; k < DOF_TAPS; k++) {
    float fk = (float(k) + 0.5) / float(DOF_TAPS);
    float r = sqrt(fk) * searchPx;
    float a = float(k) * GOLDEN + rot;
    vec2 off = apertureOffset(a, r) * uHalfTexel * vec2(1.0, uAspect);
    vec4 s = texture2D(tHalf, uv + off);
    float sCoc = s.a * uMaxCoc * 0.5;
#ifdef DOF_NEAR
    float reach = max(-sCoc, 0.0);
#else
    float reach = max(sCoc, 0.0);
#endif
    // Soft "does this sample's blur circle cover us" test.
    float w = saturate1((reach - r) * 0.75 + 0.6);
    accum += s.rgb * w;
    wsum += w;
    coverage += w;
  }

  vec3 col = wsum > 1e-4 ? accum / wsum : centre.rgb;
#ifdef DOF_NEAR
  float alpha = saturate1(coverage / float(DOF_TAPS) * 1.6);
  gl_FragColor = vec4(col, alpha);
#else
  gl_FragColor = vec4(col, 1.0);
#endif
}
`;

/** Full-res composite of sharp, far field and near field. */
export const DOF_COMBINE_FRAG = /* glsl */ `
precision highp float;
${GLSL.common}
${POST_COMMON}
${COC_GLSL}
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform sampler2D tFar;
uniform sampler2D tNear;
varying vec2 vUv;

void main() {
  vec3 sharp = max(texture2D(tColor, vUv).rgb, vec3(0.0));
  float coc = cocFromDepth(texture2D(tDepth, vUv).x);

  // Ramp the far field in over the first pixel and a half of CoC so there is no
  // visible boundary where blur switches on.
  float farAlpha = saturate1((coc - 0.6) * 0.7);
  vec3 col = mix(sharp, texture2D(tFar, vUv).rgb, farAlpha);

  vec4 near = texture2D(tNear, vUv);
  col = mix(col, near.rgb, near.a);

  gl_FragColor = vec4(col, 1.0);
}
`;
