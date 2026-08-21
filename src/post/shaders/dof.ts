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

/**
 * The blend-in ramp, shared by both fields.
 *
 * A gather at half resolution has a floor on how sharp its result can be: one
 * bilinear tap of a half-res buffer is already a 2 px box, and the full-res
 * upsample adds a 2 px triangle on top. So a pixel asking for 1.2 px of defocus
 * receives about 2.6 px if its full-res colour is fully replaced. Both fields
 * therefore have to fade in over the first couple of pixels of CoC instead of
 * switching, or there is a visible depth at which blur turns on.
 *
 * The far field always did this. The near field did NOT: its alpha reached 1.0
 * the instant the gather's own threshold let it run, so it was a **step** from 0
 * to 1 at 1.2 px of CoC. Evaluating this arithmetic against the lens uniforms
 * the camera rig actually publishes, rather than measuring it off a capture:
 *
 *     CoC px   near alpha, was   near alpha, now   far alpha
 *      0.60          0.000             0.000         0.000
 *      0.80          0.000             0.157         0.140
 *      1.00          0.000             0.325         0.280
 *      1.19          0.000             0.495         0.413
 *      1.40          1.000             0.692         0.560
 *      1.60          1.000             0.888         0.700
 *      1.84          1.000             1.000         0.868
 *      2.33          1.000             1.000         1.000
 *
 * 'DOF_RAMP_START_PX' is also the gather's own cut-off, so a field switches on
 * and begins to ramp at the same CoC instead of at two different ones.
 *
 * Nothing at or beyond 2.03 px of CoC changes by a single bit, which is the whole
 * of the near-field look that has been reviewed. Where the step sat in metres
 * depends on the lens: 1.49 m at the helm (16.8 mm f/5.6 focused at 22 m), 1.64 m
 * at the masthead, 3.28 m on the bowsprit at f/2.8, 5.85 m in orbit. At the helm
 * that is closer than anything actually in frame — the nearest deck pixel is
 * about 2.6 m — which is why ablating the whole DoF pass there measured 0.2-0.7
 * sd and why this looked like nothing. On the bowsprit the jibboom, martingale
 * and headsail tacks span it.
 */
const DOF_RAMP_GLSL = /* glsl */ `
#ifndef DOF_RAMP
#define DOF_RAMP
#define DOF_RAMP_START_PX 0.6
float cocRamp(float cocPx) { return saturate1((cocPx - DOF_RAMP_START_PX) * 0.7); }
#endif
#ifndef DOF_NEAR_RAMP
#define DOF_NEAR_RAMP 1
#endif
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
 * "foreground has a hard edge" DoF tell). Coverage accumulates into alpha, and
 * each sample claims coverage in proportion to how defocused *it* is — see
 * `DOF_RAMP_GLSL`. Keying the ramp to the covering sample rather than to this
 * pixel's own CoC is what keeps the outward spread: a sharp background pixel
 * under a strongly blurred foreground still gets fully covered.
 */
export const DOF_GATHER_FRAG = /* glsl */ `
precision highp float;
${GLSL.common}
${DOF_RAMP_GLSL}
uniform sampler2D tHalf;
uniform sampler2D tNearMax;
uniform vec2 uHalfTexel;
uniform float uMaxCoc;
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

  // A field switches on exactly where its ramp starts, so there is no CoC at
  // which the combine asks for a blur the gather declined to compute.
  float cutPx = DOF_RAMP_START_PX;
#if defined(DOF_NEAR) && !DOF_NEAR_RAMP
  cutPx = 1.2;   // the old near-field step; reachable via ext.post.dofNearRamp
#endif
  if (searchPx < cutPx * 0.5) {   // searchPx is a half-res radius
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
    vec2 off = apertureOffset(a, r) * uHalfTexel;
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
#if defined(DOF_NEAR) && DOF_NEAR_RAMP
    // 'reach' is half-res pixels; the ramp is in full-res ones.
    coverage += w * cocRamp(reach * 2.0);
#else
    coverage += w;
#endif
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
${DOF_RAMP_GLSL}
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform sampler2D tFar;
uniform sampler2D tNear;
varying vec2 vUv;

void main() {
  vec3 sharp = max(texture2D(tColor, vUv).rgb, vec3(0.0));
  float coc = cocFromDepth(texture2D(tDepth, vUv).x);

  // Both fields ramp in over the same pixel and a half of CoC, so there is no
  // depth at which blur switches on. The near field's share of that ramp is
  // already baked into its alpha by the gather.
  vec3 col = mix(sharp, texture2D(tFar, vUv).rgb, cocRamp(coc));

  vec4 near = texture2D(tNear, vUv);
  col = mix(col, near.rgb, near.a);

  gl_FragColor = vec4(col, 1.0);
}
`;
