import { GLSL } from '../../util/glsl';
import { POST_COMMON } from './common';

/**
 * Screen-space velocity by depth reprojection.
 *
 * Stores `currentUv - previousUv` in RG16F, so a history fetch is
 * `uv - velocity`. The current position is unprojected from the *unjittered*
 * NDC (`ndc - uJitter`) and reprojected with the previous frame's unjittered
 * view-projection, which keeps the buffer in jitter-free screen space — both
 * TAA and motion blur want that.
 *
 * KNOWN ARTEFACT: this is camera reprojection only. Anything displaced in its
 * vertex shader (the FFT ocean surface, billowing canvas, flags, spray
 * particles) reports the velocity of the *static* point it happens to occupy,
 * not its true motion. TAA's neighbourhood clamp turns that into a rejected
 * history sample (slight aliasing) rather than a smear, which is the failure
 * mode we want; motion blur simply under-blurs moving water. Fixing it properly
 * needs an MRT velocity output from the ocean and ship materials.
 */
export const VELOCITY_FRAG = /* glsl */ `
precision highp float;
${GLSL.common}
${POST_COMMON}
uniform sampler2D tDepth;
uniform mat4 uInvViewProj;
uniform mat4 uPrevViewProj;
uniform vec3 uCamPos;
uniform vec3 uPrevCamPos;
uniform vec2 uJitter;
varying vec2 vUv;

void main() {
  float d = texture2D(tDepth, vUv).x;
  vec2 ndc = vUv * 2.0 - 1.0 - uJitter;
  vec2 prevUv;

  if (d >= 0.9999995) {
    // Sky: unprojecting the far plane is numerically hopeless and translation
    // parallax is irrelevant out there, so reproject the ray direction only.
    vec3 dir = normalize(worldFromDepth(ndc, 0.5, uInvViewProj) - uCamPos) * 1000.0;
    vec4 pc = uPrevViewProj * vec4(uPrevCamPos + dir, 1.0);
    prevUv = (pc.xy / pc.w) * 0.5 + 0.5;
  } else {
    vec3 wp = worldFromDepth(ndc, d, uInvViewProj);
    vec4 pc = uPrevViewProj * vec4(wp, 1.0);
    prevUv = (pc.xy / pc.w) * 0.5 + 0.5;
  }

  gl_FragColor = vec4(vUv - prevUv, 0.0, 1.0);
}
`;

/** Tile-max of |velocity| along one axis. Two of these give a 2D tile max. */
export const TILE_MAX_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tVelocity;
uniform vec2 uDir;          // (1,0) then (0,1), in source texels
uniform vec2 uTexelSize;    // 1 / source size
uniform float uTile;
varying vec2 vUv;

void main() {
  vec2 best = vec2(0.0);
  float bestLen = -1.0;
  for (int i = 0; i < 32; i++) {
    if (float(i) >= uTile) break;
    vec2 off = uDir * (float(i) + 0.5) * uTexelSize;
    vec2 base = vUv - uDir * (uTile * 0.5) * uTexelSize;
    vec2 v = texture2D(tVelocity, base + off).xy;
    float l = dot(v, v);
    if (l > bestLen) { bestLen = l; best = v; }
  }
  gl_FragColor = vec4(best, 0.0, 1.0);
}
`;

/** 3x3 neighbour-max so a fast object can smear over the static background. */
export const NEIGHBOUR_MAX_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tTile;
uniform vec2 uTexelSize;
varying vec2 vUv;

void main() {
  vec2 best = vec2(0.0);
  float bestLen = -1.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 v = texture2D(tTile, vUv + vec2(float(i), float(j)) * uTexelSize).xy;
      float l = dot(v, v);
      // Corner taps only win if they clearly dominate — stops a diagonal
      // neighbour from dragging blur into a tile it barely touches.
      if (i != 0 && j != 0) l *= 0.75;
      if (l > bestLen) { bestLen = l; best = v; }
    }
  }
  gl_FragColor = vec4(best, 0.0, 1.0);
}
`;
