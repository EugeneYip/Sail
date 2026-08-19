import { GLSL } from '../../util/glsl';
import { POST_COMMON } from './common';
import { LUT_SIZE } from '../luts/LookLut';

/**
 * The one pass that turns scene-linear radiance into 8-bit sRGB. Nothing
 * downstream of it exists, so every ordering decision here is a claim about
 * where in a real camera the effect happens:
 *
 *   lateral CA      — in the lens, on linear light, radial and 3-tap
 *   bloom + dirt    — light scattered on the front element, added linearly
 *   vignette        — cos^4 falloff of the aperture, linear
 *   AgX             — the film/sensor transfer curve
 *   look LUT        — the grade, display-referred, where a grade belongs
 *   lift/gamma/gain — runtime trim on top of the baked look
 *   grain           — the negative, so it lives in display space
 *   dither          — quantisation noise, the very last thing before 8 bits
 *
 * The dither is not decoration. A clear sky is a smooth 30:1 gradient across
 * 900 rows; at 8 bits that is a visible Mach band every ~30 rows. One LSB of
 * triangular-PDF noise removes it completely and costs a single hash.
 *
 * ## Where the sRGB encode is — and where it is NOT
 *
 * `agx()` ends with the AgX outset matrix and NOT with the AgX EOTF, so its
 * output is **already display-encoded** (sRGB gamma, values in [0,1]); three's
 * own `AgXToneMapping` finishes with `pow(col, 2.2)` for exactly this reason,
 * to hand a *linear* value back to the renderer's automatic encode. We have no
 * automatic encode, so everything after `agx()` here — the look LUT, the trim,
 * the split tone, the grain, the dither — is display-encoded, which is the
 * correct domain for all five, and the frame is written out as-is.
 *
 * Calling `linearToSrgb()` at the end was a second encode on top of AgX's. It
 * mapped middle grey from 0.50 to 0.72 and a near-black 0.02 to 0.16, which is
 * the whole of the "pale, milky, no contrast, blacks never reach black" defect:
 * an 8-stop scene arrived on screen occupying barely three stops of the top of
 * the range. Measured on the noon frame it moved the median from 189 to 96 and
 * took the 1st percentile from 108 to 12. Do not put it back.
 */
export const COMPOSITE_FRAG = /* glsl */ `
precision highp float;
precision highp sampler3D;
${GLSL.common}
${GLSL.color}
${POST_COMMON}

#define LUT_N ${LUT_SIZE}

uniform sampler2D tColor;
uniform sampler2D tBloom;
uniform sampler2D tDirt;
uniform sampler3D tLook;

uniform vec2  uResolution;
uniform float uTime;
uniform float uFrame;
uniform float uAspect;

uniform float uBloomStrength;
uniform float uDirtStrength;
uniform float uCA;            // radial channel split, uv units at the corner
uniform float uVignette;
uniform float uGrain;
uniform vec3  uLookBlend;     // (slabA, slabB, mix)
uniform float uLookAmount;

uniform vec3  uLift;
uniform vec3  uGamma;
uniform vec3  uGain;
uniform vec3  uSplitShadow;
uniform vec3  uSplitHighlight;
uniform float uSplitAmount;
uniform float uSaturation;

varying vec2 vUv;

/* ---- look LUT ---------------------------------------------------------- */

vec3 lutTexel(ivec3 c, int slab) {
  return texelFetch(tLook, ivec3(c.x, c.y, c.z + slab * LUT_N), 0).rgb;
}

/**
 * Tetrahedral interpolation. Trilinear would need the slabs to be separate
 * textures (hardware filtering would bleed one look into the next across the
 * stacked Z boundary) and is worse anyway: on a LUT with a strong hue rotation
 * trilinear pulls colours toward the cube diagonal, tetrahedral does not.
 */
vec3 lutApply(vec3 c, int slab) {
  vec3 p = clamp(c, 0.0, 1.0) * float(LUT_N - 1);
  ivec3 i0 = min(ivec3(floor(p)), ivec3(LUT_N - 2));
  vec3 f = p - vec3(i0);

  vec3 c000 = lutTexel(i0, slab);
  vec3 c111 = lutTexel(i0 + ivec3(1, 1, 1), slab);
  vec3 r;

  if (f.x > f.y) {
    if (f.y > f.z) {
      vec3 c100 = lutTexel(i0 + ivec3(1, 0, 0), slab);
      vec3 c110 = lutTexel(i0 + ivec3(1, 1, 0), slab);
      r = c000 + (c100 - c000) * f.x + (c110 - c100) * f.y + (c111 - c110) * f.z;
    } else if (f.x > f.z) {
      vec3 c100 = lutTexel(i0 + ivec3(1, 0, 0), slab);
      vec3 c101 = lutTexel(i0 + ivec3(1, 0, 1), slab);
      r = c000 + (c100 - c000) * f.x + (c101 - c100) * f.z + (c111 - c101) * f.y;
    } else {
      vec3 c001 = lutTexel(i0 + ivec3(0, 0, 1), slab);
      vec3 c101 = lutTexel(i0 + ivec3(1, 0, 1), slab);
      r = c000 + (c001 - c000) * f.z + (c101 - c001) * f.x + (c111 - c101) * f.y;
    }
  } else {
    if (f.z > f.y) {
      vec3 c001 = lutTexel(i0 + ivec3(0, 0, 1), slab);
      vec3 c011 = lutTexel(i0 + ivec3(0, 1, 1), slab);
      r = c000 + (c001 - c000) * f.z + (c011 - c001) * f.y + (c111 - c011) * f.x;
    } else if (f.z > f.x) {
      vec3 c010 = lutTexel(i0 + ivec3(0, 1, 0), slab);
      vec3 c011 = lutTexel(i0 + ivec3(0, 1, 1), slab);
      r = c000 + (c010 - c000) * f.y + (c011 - c010) * f.z + (c111 - c011) * f.x;
    } else {
      vec3 c010 = lutTexel(i0 + ivec3(0, 1, 0), slab);
      vec3 c110 = lutTexel(i0 + ivec3(1, 1, 0), slab);
      r = c000 + (c010 - c000) * f.y + (c110 - c010) * f.x + (c111 - c110) * f.z;
    }
  }
  return r;
}

/* ---- main -------------------------------------------------------------- */

void main() {
  vec2 q = vUv - 0.5;
  float r2 = dot(q * vec2(uAspect, 1.0), q * vec2(uAspect, 1.0));

  // Lateral chromatic aberration: transverse, so the split grows with field
  // height and is zero on axis. Three taps is enough at sub-pixel magnitudes.
  vec3 col;
  if (uCA > 0.0) {
    vec2 off = q * r2 * uCA;
    col.r = texture2D(tColor, vUv + off).r;
    col.g = texture2D(tColor, vUv).g;
    col.b = texture2D(tColor, vUv - off).b;
  } else {
    col = texture2D(tColor, vUv).rgb;
  }

  vec3 bloom = texture2D(tBloom, vUv).rgb;
  // Dirt modulates the *scattered* light only, so it is invisible until
  // something bright is in frame — which is exactly how a dirty front element
  // behaves. Multiplying the whole image by it is the amateur version.
  float dirt = texture2D(tDirt, vUv).r;
  bloom *= 1.0 + dirt * uDirtStrength;
  col = mix(col, bloom, uBloomStrength);

  col *= cos4Vignette(vUv, uAspect, uVignette);

  col = agx(col);

  // Look LUT, two slabs bracketing the sun elevation.
  vec3 graded = mix(
    lutApply(col, int(uLookBlend.x)),
    lutApply(col, int(uLookBlend.y)),
    uLookBlend.z);
  col = mix(col, graded, uLookAmount);

  // Runtime trim on top of the baked look — weather reaches the grade through
  // these, the time of day reaches it through the LUT blend.
  col = col * uGain + uLift;
  col = pow(max(col, vec3(0.0)), uGamma);

  float l = lwLuminance(col);
  float sh = smoothstep(0.0, 0.55, l);
  col *= mix(uSplitShadow, uSplitHighlight, sh) * uSplitAmount + (1.0 - uSplitAmount);

  col = clamp(mix(vec3(l), col, uSaturation), 0.0, 1.0);

  // Grain on the negative: strongest through the midtones, almost absent in the
  // highlights (where real silver halide is saturated) and pulled back in the
  // deep shadows so night does not turn to static.
  if (uGrain > 0.0) {
    float gLum = lwLuminance(col);
    float shape = (1.0 - smoothstep(0.35, 0.95, gLum)) * smoothstep(0.0, 0.10, gLum);
    float n = animatedNoise(gl_FragCoord.xy, uFrame);
    // Two decorrelated draws so the grain has some chroma, like real film.
    float n2 = animatedNoise(gl_FragCoord.xy + 37.0, uFrame + 11.0);
    vec3 g = vec3(triangularNoise(n), triangularNoise(mix(n, n2, 0.5)), triangularNoise(n2));
    col += g * uGrain * shape;
  }

  // No sRGB encode here. AgX already left us display-encoded and everything
  // since has been display-encoded too — see the header note.
  col = max(col, vec3(0.0));

  // Triangular-PDF dither at exactly one 8-bit LSB. Without this the sky bands.
  float d1 = hash12(gl_FragCoord.xy + vec2(uFrame * 1.61803399, uFrame * 0.7548777));
  float d2 = hash12(gl_FragCoord.yx + vec2(uFrame * 0.3247180, uFrame * 2.2360679));
  col += vec3(d1 + d2 - 1.0) * (1.0 / 255.0);

  gl_FragColor = vec4(col, 1.0);
}
`;
