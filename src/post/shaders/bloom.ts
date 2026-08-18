import { GLSL } from '../../util/glsl';

/**
 * Progressive dual-filter bloom (Jimenez, Next Generation Post Processing in
 * Call of Duty: Advanced Warfare).
 *
 * There is deliberately **no threshold**. A threshold is what produces a hard
 * glowing outline around bright objects and makes the bloom pop as the camera
 * moves; an energy-conserving chain instead spreads a little of *everything*,
 * which is what a real lens does. The 13-tap downsample with a Karis average on
 * the first level is what stops a single specular pixel on a wave from becoming
 * a pulsing firefly.
 */
export const BLOOM_DOWN_FRAG = /* glsl */ `
precision highp float;
${GLSL.common}
uniform sampler2D tSource;
uniform vec2 uSourceTexel;
varying vec2 vUv;

float karisWeight(vec3 c) { return 1.0 / (1.0 + lwLuminance(c)); }

void main() {
  vec2 t = uSourceTexel;
  vec3 a = texture2D(tSource, vUv + t * vec2(-1.0, -1.0)).rgb;
  vec3 b = texture2D(tSource, vUv + t * vec2( 0.0, -1.0)).rgb;
  vec3 c = texture2D(tSource, vUv + t * vec2( 1.0, -1.0)).rgb;
  vec3 d = texture2D(tSource, vUv + t * vec2(-1.0,  0.0)).rgb;
  vec3 e = texture2D(tSource, vUv                       ).rgb;
  vec3 f = texture2D(tSource, vUv + t * vec2( 1.0,  0.0)).rgb;
  vec3 g = texture2D(tSource, vUv + t * vec2(-1.0,  1.0)).rgb;
  vec3 h = texture2D(tSource, vUv + t * vec2( 0.0,  1.0)).rgb;
  vec3 i = texture2D(tSource, vUv + t * vec2( 1.0,  1.0)).rgb;
  vec3 j = texture2D(tSource, vUv + t * vec2(-0.5, -0.5)).rgb;
  vec3 k = texture2D(tSource, vUv + t * vec2( 0.5, -0.5)).rgb;
  vec3 l = texture2D(tSource, vUv + t * vec2(-0.5,  0.5)).rgb;
  vec3 m = texture2D(tSource, vUv + t * vec2( 0.5,  0.5)).rgb;

#ifdef BLOOM_KARIS
  vec3 g0 = (j + k + l + m) * 0.25;
  vec3 g1 = (a + b + d + e) * 0.25;
  vec3 g2 = (b + c + e + f) * 0.25;
  vec3 g3 = (d + e + g + h) * 0.25;
  vec3 g4 = (e + f + h + i) * 0.25;
  float w0 = karisWeight(g0) * 0.5;
  float w1 = karisWeight(g1) * 0.125;
  float w2 = karisWeight(g2) * 0.125;
  float w3 = karisWeight(g3) * 0.125;
  float w4 = karisWeight(g4) * 0.125;
  vec3 sum = g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4;
  gl_FragColor = vec4(sum / max(w0 + w1 + w2 + w3 + w4, 1e-5), 1.0);
#else
  vec3 sum = e * 0.125;
  sum += (a + c + g + i) * 0.03125;
  sum += (b + d + f + h) * 0.0625;
  sum += (j + k + l + m) * 0.125;
  gl_FragColor = vec4(sum, 1.0);
#endif
}
`;

/**
 * 9-tap tent upsample, accumulated additively into the level below. The tent is
 * what keeps the chain free of mip banding — a bilinear upsample leaves visible
 * quad edges at the coarse levels.
 */
export const BLOOM_UP_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tSource;
uniform vec2 uSourceTexel;
uniform float uRadius;
uniform float uBlend;
varying vec2 vUv;

void main() {
  vec2 t = uSourceTexel * uRadius;
  vec3 sum = texture2D(tSource, vUv).rgb * 4.0;
  sum += texture2D(tSource, vUv + vec2(-t.x,  0.0)).rgb * 2.0;
  sum += texture2D(tSource, vUv + vec2( t.x,  0.0)).rgb * 2.0;
  sum += texture2D(tSource, vUv + vec2( 0.0, -t.y)).rgb * 2.0;
  sum += texture2D(tSource, vUv + vec2( 0.0,  t.y)).rgb * 2.0;
  sum += texture2D(tSource, vUv + vec2(-t.x, -t.y)).rgb;
  sum += texture2D(tSource, vUv + vec2( t.x, -t.y)).rgb;
  sum += texture2D(tSource, vUv + vec2(-t.x,  t.y)).rgb;
  sum += texture2D(tSource, vUv + vec2( t.x,  t.y)).rgb;
  // Alpha carries the blend weight: the pass is drawn with SrcAlpha/1-SrcAlpha
  // so the accumulate is mix(finer, tent(coarser), uBlend) *in place*. A plain
  // additive chain multiplies total energy by the level count and then needs an
  // arbitrary normalisation; this keeps mean brightness equal to the source's,
  // which is what makes a 5% mix a genuine 5% of the frame's light.
  gl_FragColor = vec4(sum * 0.0625, uBlend);
}
`;
