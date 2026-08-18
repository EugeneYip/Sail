/** GLSL shared by several post passes. Depends on GLSL.common from util/glsl. */
export const POST_COMMON = /* glsl */ `
#ifndef LEEWARD_POST_COMMON
#define LEEWARD_POST_COMMON

// --- HDR range compression -------------------------------------------------
// Karis's reversible tonemap. Blending, clamping and edge detection all behave
// far better in this compressed space than on raw radiance, and it is exactly
// invertible so nothing is lost.
vec3 tmap(vec3 c)   { return c / (1.0 + max(max(c.r, c.g), c.b)); }
vec3 tunmap(vec3 c) { return c / max(1e-4, 1.0 - max(max(c.r, c.g), c.b)); }
float tmapW(vec3 c) { return 1.0 / (1.0 + lwLuminance(c)); }

// --- YCoCg ----------------------------------------------------------------
// TAA clamping in YCoCg is what stops a bright specular glint from dragging a
// coloured comet behind it: chroma and luma get independent variance bounds.
vec3 rgbToYCoCg(vec3 c) {
  return vec3(
     0.25 * c.r + 0.5 * c.g + 0.25 * c.b,
     0.5  * c.r             - 0.5  * c.b,
    -0.25 * c.r + 0.5 * c.g - 0.25 * c.b);
}
vec3 yCoCgToRgb(vec3 c) {
  float t = c.x - c.z;
  return vec3(t + c.y, c.x + c.z, t - c.y);
}

// --- Depth ----------------------------------------------------------------
// Depth buffer is DEPTH_COMPONENT32F with the default [0,1] range.
float linearDepth(float d, float near, float far) {
  return (near * far) / (far - (far - near) * d);
}
/** World position from a depth sample and the inverse view-projection. */
vec3 worldFromDepth(vec2 ndc, float depth, mat4 invViewProj) {
  vec4 h = invViewProj * vec4(ndc, depth * 2.0 - 1.0, 1.0);
  return h.xyz / h.w;
}

// --- Sampling -------------------------------------------------------------
/**
 * 5-tap Catmull-Rom (Karis's collapse of the 4x4 bicubic onto bilinear taps).
 * Resampling the TAA history bilinearly is the single biggest source of
 * "TAA is soft"; this costs 5 taps and removes most of it.
 */
vec3 sampleCatmullRom(sampler2D tex, vec2 uv, vec2 texSize) {
  vec2 samplePos = uv * texSize;
  vec2 texPos1 = floor(samplePos - 0.5) + 0.5;
  vec2 f = samplePos - texPos1;

  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);

  vec2 w12 = w1 + w2;
  vec2 offset12 = w2 / max(w12, vec2(1e-5));

  vec2 texPos0 = (texPos1 - 1.0) / texSize;
  vec2 texPos3 = (texPos1 + 2.0) / texSize;
  vec2 texPos12 = (texPos1 + offset12) / texSize;

  vec3 result = vec3(0.0);
  result += texture2D(tex, vec2(texPos12.x, texPos0.y)).rgb  * (w12.x * w0.y);
  result += texture2D(tex, vec2(texPos0.x,  texPos12.y)).rgb * (w0.x  * w12.y);
  result += texture2D(tex, vec2(texPos12.x, texPos12.y)).rgb * (w12.x * w12.y);
  result += texture2D(tex, vec2(texPos3.x,  texPos12.y)).rgb * (w3.x  * w12.y);
  result += texture2D(tex, vec2(texPos12.x, texPos3.y)).rgb  * (w12.x * w3.y);
  float wsum = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
  return max(result / max(wsum, 1e-5), vec3(0.0));
}

// --- Misc -----------------------------------------------------------------
/** Uniform -> triangular PDF on [-1,1]. The right shape for 1-LSB dither. */
float triangularNoise(float u) {
  float o = u * 2.0 - 1.0;
  return sign(o) * (1.0 - sqrt(max(0.0, 1.0 - abs(o))));
}
/** Natural cos^4 optical falloff, not a painted black ring. */
float cos4Vignette(vec2 uv, float aspect, float strength) {
  vec2 q = (uv - 0.5) * vec2(aspect, 1.0);
  float r2 = dot(q, q) * 4.0;
  float c = 1.0 / (1.0 + r2 * strength);
  return c * c;
}
#endif
`;
