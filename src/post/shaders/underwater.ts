import { GLSL } from '../../util/glsl';
import { POST_COMMON } from './common';

/**
 * Below-the-surface look. Driven by `world.ext.camera.underwater` (0..1), which
 * the camera rig ramps to 1 at ~0.35 m of submersion, so this has to be
 * continuous at 0 — a hard switch would flash on every wave that washes the
 * lens.
 *
 * Four things, in the order light meets them:
 *
 *  1. **Refraction** — a two-frequency sine warp. Small (a few pixels) and
 *     slow. It runs *after* the temporal resolve on purpose: an animated warp
 *     in front of TAA is invisible to the velocity buffer and would smear.
 *  2. **Absorption** — Beer-Lambert over the linear view distance with real
 *     coefficients for clear ocean water. Red is gone by ~8 m, green survives
 *     to ~40 m, blue to ~120 m. This is what makes water read as water rather
 *     than as a blue filter.
 *  3. **Inscatter** — the same path length adds the water's own colour back,
 *     so distance fades toward the medium instead of toward black.
 *  4. **Blur + fall-off** — the eye is not corrected for water, so everything
 *     is soft; and the field of view darkens hard at the edges.
 */
export const UNDERWATER_FRAG = /* glsl */ `
precision highp float;
${GLSL.common}
${POST_COMMON}
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform vec2  uTexelSize;
uniform vec2  uDepthRange;
uniform float uAmount;
uniform float uTime;
uniform float uAspect;
uniform vec3  uAbsorb;     // 1/m, per channel
uniform vec3  uScatter;    // medium colour, scene-linear, PRE-exposure
// 1x1 adaptation state. Everything downstream of 'prepare' is in exposed units,
// so the medium colour has to be brought into the same space here rather than
// on the CPU, which no longer knows the exact exposure.
uniform sampler2D tExposure;
uniform float uDistort;    // pixels
uniform float uBlur;       // pixels
varying vec2 vUv;

void main() {
  vec2 p = vUv * vec2(uAspect, 1.0);

  // Two incommensurate frequencies so the warp never visibly repeats.
  vec2 warp = vec2(
    sin(p.y * 21.0 + uTime * 1.15) * 0.6 + sin(p.y * 8.3 - uTime * 0.71) * 0.4,
    sin(p.x * 17.0 - uTime * 0.94) * 0.6 + sin(p.x * 6.7 + uTime * 0.62) * 0.4);
  vec2 uv = vUv + warp * uDistort * uTexelSize * uAmount;

  // Soft 5-tap disc. Cheap, and the distortion hides the tap pattern.
  float r = uBlur * uAmount;
  vec3 col = texture2D(tColor, uv).rgb * 0.36;
  col += texture2D(tColor, uv + vec2( 0.96, 0.28) * r * uTexelSize).rgb * 0.16;
  col += texture2D(tColor, uv + vec2(-0.28, 0.96) * r * uTexelSize).rgb * 0.16;
  col += texture2D(tColor, uv + vec2(-0.96,-0.28) * r * uTexelSize).rgb * 0.16;
  col += texture2D(tColor, uv + vec2( 0.28,-0.96) * r * uTexelSize).rgb * 0.16;

  float d = texture2D(tDepth, vUv).x;
  // The sky reads as the far plane; underwater there is no sky, only more
  // water, so clamp the path length to something the medium can actually fill.
  float dist = min(linearDepth(d, uDepthRange.x, uDepthRange.y), 140.0);

  vec3 trans = exp(-uAbsorb * dist);
  col = col * trans + uScatter * texture2D(tExposure, vec2(0.5)).g * (1.0 - trans);

  // Mask of the visible aperture: a diver's field of view is a dark oval.
  float edge = cos4Vignette(vUv, uAspect, 0.9);
  col *= mix(1.0, edge * 0.85 + 0.15, uAmount);

  gl_FragColor = vec4(mix(texture2D(tColor, vUv).rgb, col, uAmount), 1.0);
}
`;
