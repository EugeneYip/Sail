import { GLSL } from '../../util/glsl';
import { POST_COMMON } from './common';

/**
 * Velocity-buffer motion blur with a fixed exposure time.
 *
 * The velocity it is handed is measured in the SHIP's frame where the pixel is
 * ship and the world's where it is not — see 'VELOCITY_FRAG'. Without that, the
 * deck under a first-person eye reports the camera's own translation parallax,
 * which grows as 1/depth, and the near field smears while the rig stays sharp.
 *
 * The blur direction comes from the dilated *tile* max velocity rather than the
 * pixel's own, which is what lets a fast object smear over static background
 * instead of being clipped to its own silhouette. Sample weighting is McGuire's
 * reach test: a tap contributes only if its own velocity is long enough to have
 * carried it to this pixel during the shutter interval.
 *
 * Sample count scales with the blur length, and the length is hard-capped at a
 * fraction of screen height — an uncapped whip-pan turns the whole frame to
 * porridge, which reads as a bug rather than as motion.
 */
export const MOTION_BLUR_FRAG = /* glsl */ `
precision highp float;
${GLSL.common}
${POST_COMMON}
uniform sampler2D tColor;
uniform sampler2D tVelocity;
uniform sampler2D tNeighbourMax;
uniform sampler2D tDepth;
uniform vec2 uResolution;
uniform vec2 uTexelSize;
uniform float uShutter;      // exposure seconds / frame seconds; see MotionBlur.ts
uniform float uMaxLength;    // pixels
uniform float uFrame;
uniform vec2 uDepthRange;

#ifndef MB_MAX_TAPS
#define MB_MAX_TAPS 12
#endif
varying vec2 vUv;

void main() {
  vec3 centre = texture2D(tColor, vUv).rgb;
  vec2 tileVel = texture2D(tNeighbourMax, vUv).xy * uShutter;
  float tileLen = length(tileVel * uResolution);

  if (tileLen < 1.0) {
    gl_FragColor = vec4(centre, 1.0);
    return;
  }

  // Cap, preserving direction.
  if (tileLen > uMaxLength) {
    tileVel *= uMaxLength / tileLen;
    tileLen = uMaxLength;
  }

  int taps = int(clamp(tileLen * 0.5, 4.0, float(MB_MAX_TAPS)));
  vec2 selfVel = texture2D(tVelocity, vUv).xy * uShutter;
  float selfLen = length(selfVel * uResolution);
  float centreDepth = linearDepth(texture2D(tDepth, vUv).x, uDepthRange.x, uDepthRange.y);

  // Jitter the tap positions so 8 samples do not read as 8 ghosts.
  float jitter = ign(gl_FragCoord.xy) + uFrame * 0.61803399;
  jitter = fract(jitter) - 0.5;

  vec3 accum = centre * 0.6;
  float wsum = 0.6;

  for (int k = 0; k < MB_MAX_TAPS; k++) {
    if (k >= taps) break;
    float t = ((float(k) + 0.5) / float(taps) - 0.5) + jitter / float(taps);
    vec2 suv = vUv + tileVel * t;
    if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) continue;

    vec2 sVel = texture2D(tVelocity, suv).xy * uShutter;
    float sLen = length(sVel * uResolution);
    float dist = abs(t) * tileLen;

    // Foreground/background classification: a nearer sample is allowed to smear
    // over us, a farther one only if we are ourselves moving.
    float sDepth = linearDepth(texture2D(tDepth, suv).x, uDepthRange.x, uDepthRange.y);
    float nearer = saturate1((centreDepth - sDepth) * 0.5 + 0.5);
    float reach = saturate1((sLen - dist) * 0.5 + 0.5) * nearer
                + saturate1((selfLen - dist) * 0.5 + 0.5) * (1.0 - nearer);

    accum += texture2D(tColor, suv).rgb * reach;
    wsum += reach;
  }

  gl_FragColor = vec4(accum / max(wsum, 1e-4), 1.0);
}
`;
