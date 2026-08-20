import { GLSL } from '../../util/glsl';
import { CLOUD_SHADOW_STEPS } from '../constants';
import { ATMOSPHERE_GLSL } from './atmosphere';
import { CLOUD_COMMON_GLSL } from './cloudCommon';
import { CLOUD_LIGHTING_GLSL } from './cloudLighting';

const f = (n: number) => (Number.isInteger(n) ? n.toFixed(1) : String(n));

const HEAD = /* glsl */ `
precision highp float;
precision highp sampler2D;
precision highp sampler3D;
in vec2 vUv;
layout(location = 0) out vec4 fragColor;
${GLSL.common}
${ATMOSPHERE_GLSL}
uniform float uMieMul;
${CLOUD_COMMON_GLSL}
${CLOUD_LIGHTING_GLSL}
`;

/**
 * The raymarch, at half width and half height of the frame.
 *
 * Rays are built from the UNJITTERED projection so the buffer is a stable image
 * that the resolve can reproject without having to undo TAA's sub-pixel offset.
 * The start offset inside the first step is interleaved-gradient noise advanced
 * by the golden ratio per frame, which is what turns the visible slab banding of
 * a 40-step march into high-frequency noise the temporal filter can eat.
 *
 * On top of that the buffer carries its own half-texel ray offset per frame, so
 * the temporal filter also supersamples the SILHOUETTE rather than only the
 * march. See the long comment in main().
 */
export const CLOUD_MARCH_FRAG = /* glsl */ `
${HEAD}
uniform sampler2D tTransmittance;
uniform sampler2D tCloudShadow;
uniform mat4  uCloudShadowMatrix;
uniform mat4  uRayMatrix;
uniform vec3  uCameraPosW;
uniform vec3  uSunDirection;
uniform vec2  uResolution;
uniform float uFrameIndex;
uniform float uSteps;
uniform float uShafts;

void main(){
  /*
   * SUB-TEXEL RAY JITTER — the fix for the stair-stepped cloud silhouette.
   *
   * The march runs at half width and half height and the density field is
   * thresholded hard ('density > 0.0015', and sigma * dt * 1000 saturates the
   * step transmittance within a hair of that), so the alpha edge of a cloud is
   * very nearly binary AT HALF RESOLUTION. Four bilinear taps in the sky shader
   * soften that staircase but cannot remove it: no reconstruction filter can
   * recover an edge position the buffer never sampled.
   *
   * So sample it. The whole buffer is offset by ONE low-discrepancy 2D sample
   * per frame — the R2 / Roberts sequence, which covers the unit square evenly
   * for any prefix, and uFrameIndex cycles 0..63 so the set is fixed and
   * repeatable. Over the ~20 frames the temporal filter integrates, each edge
   * texel therefore sees the true edge at ~20 sub-texel positions and converges
   * to its correct partial coverage. This is ordinary supersampling; it costs
   * two 'fract' and one madd per ray and no extra fetch.
   *
   * It survives the resolve's neighbourhood clamp, which is the part that had to
   * be checked rather than assumed. That clamp measures how far it had to move
   * the history ('moved'), not how far history is from the current frame — and a
   * history sample displaced by under one texel is still inside the min/max of
   * the current 3x3, so the clamp does not bite, 'moved' stays near zero and the
   * accumulation is allowed to do the averaging.
   *
   * This offset is NOT the same thing as TAA's jitter and is deliberately not
   * undone. Clouds.render still hands us the UNJITTERED projection in
   * uRayMatrix, precisely so that TAA's offset cannot enter the reprojection;
   * this offset is our own, is bounded by half a half-res texel (one full-res
   * pixel), and the resolve reprojects with the unjittered ray on purpose — the
   * resulting sub-texel mismatch IS the blur that antialiases the edge.
   */
  vec2 sub = vec2(fract(uFrameIndex * 0.7548776662),
                  fract(uFrameIndex * 0.5698402909)) - 0.5;
  vec2 ndc = (vUv + sub / uResolution) * 2.0 - 1.0;
  vec4 hp = uRayMatrix * vec4(ndc, 1.0, 1.0);
  vec3 dir = normalize(hp.xyz / hp.w - uCameraPosW);

  float jitter = animatedNoise(vUv * uResolution, uFrameIndex);
  vec3 pos = vec3(uCameraPosW.x * 0.001,
                  RG + max(0.0, uCameraPosW.y) * 0.001,
                  uCameraPosW.z * 0.001);

  fragColor = cloudMarch(pos, dir, uSunDirection, uSteps, jitter, tTransmittance,
                         true, tCloudShadow, uCloudShadowMatrix, uShafts > 0.5);
}
`;

/**
 * Temporal resolve.
 *
 * History is reprojected by intersecting this frame's ray with a sphere at the
 * deck's mid-altitude and projecting that point with the previous frame's
 * view-projection. Using a sphere rather than a per-pixel cloud depth is exact
 * to well under a tenth of a pixel here: the parallax difference between a
 * cloud at 2 km and one at 8 km, for a camera translating 0.2 m in a frame, is
 * 7e-5 rad, and rotation — which is what actually happens when a player looks
 * around — is handled exactly by the ray direction either way.
 *
 * NEIGHBOURHOOD CLAMP. The history is clamped to the min/max of the 3x3 block of
 * this frame's raw march before it is blended. That is the whole defence against
 * smearing: on a fast turn the reprojected sample no longer resembles anything
 * in its new neighbourhood, so the clamp collapses it onto the current frame and
 * the trail cannot form. Off-screen history is rejected outright.
 */
export const CLOUD_RESOLVE_FRAG = /* glsl */ `
${GLSL.common}
precision highp float;
in vec2 vUv;
layout(location = 0) out vec4 fragColor;

const float RG = ${f(6360)};

uniform sampler2D tRaw;
uniform sampler2D tHistory;
uniform mat4  uRayMatrix;
uniform mat4  uPrevViewProj;
uniform vec3  uCameraPosW;
uniform vec2  uTexel;
uniform float uMidRadius;
uniform float uAlpha;
uniform float uReset;

void main(){
  vec4 cur = texture(tRaw, vUv);

  vec4 lo = cur;
  vec4 hi = cur;
  vec4 mean = cur;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      if (i == 0 && j == 0) continue;
      vec4 s = texture(tRaw, vUv + vec2(float(i), float(j)) * uTexel);
      lo = min(lo, s);
      hi = max(hi, s);
      mean += s;
    }
  }
  mean *= 1.0 / 9.0;

  if (uReset < 0.5) {
    vec2 ndc = vUv * 2.0 - 1.0;
    vec4 hp = uRayMatrix * vec4(ndc, 1.0, 1.0);
    vec3 dir = normalize(hp.xyz / hp.w - uCameraPosW);

    // Ray vs. the mid-deck shell, in planet space.
    vec3 o = vec3(uCameraPosW.x * 0.001, RG + max(0.0, uCameraPosW.y) * 0.001,
                  uCameraPosW.z * 0.001);
    float b = dot(o, dir);
    float c = dot(o, o) - uMidRadius * uMidRadius;
    float disc = b * b - c;
    float t = disc > 0.0 ? max(-b + sqrt(disc), 0.0) : 40.0;
    vec3 anchor = uCameraPosW + dir * (t * 1000.0);

    vec4 pc = uPrevViewProj * vec4(anchor, 1.0);
    if (pc.w > 0.0) {
      vec2 puv = (pc.xy / pc.w) * 0.5 + 0.5;
      if (all(greaterThan(puv, vec2(0.0))) && all(lessThan(puv, vec2(1.0)))) {
        vec4 raw = texture(tHistory, puv);
        vec4 hist = clamp(raw, lo, hi);
        // How hard the clamp had to work IS the disocclusion signal. Where the
        // reprojected sample no longer belongs in its neighbourhood, fall back
        // toward this frame instead of averaging in something from elsewhere.
        float box = length((hi - lo).rgb) + (hi.a - lo.a) + 1e-4;
        float moved = (length((hist - raw).rgb) + abs(hist.a - raw.a)) / box;
        float a = mix(uAlpha, 1.0, saturate1(moved * 1.5));
        fragColor = mix(hist, cur, a);
        return;
      }
    }
  }

  // No usable history. A single-frame march is noisy, so lean on the spatial
  // mean for the first frame after a cut or at a screen edge that just opened.
  fragColor = mix(mean, cur, 0.45);
}
`;

/**
 * Top-down sun-transmittance slice, published as `ext.sky.cloudShadowMap`.
 *
 * One texel is one sea-level point; the march runs from that point along the sun
 * ray through both cloud layers. That is what a shadow on water actually is, and
 * moving cloud shadow over open water is the single largest realism win the sky
 * has to give the ocean. It is deliberately a sea-level slice — a receiver above
 * the water walks its position back down the sun ray before sampling, which is
 * one multiply-add and exact for a plane-parallel deck.
 */
export const CLOUD_SHADOW_FRAG = /* glsl */ `
${HEAD}
uniform vec3  uSunDirection;
uniform vec2  uShadowCentre;
uniform float uShadowExtent;

const int SHADOW_STEPS = ${CLOUD_SHADOW_STEPS};

void main(){
  vec2 world = uShadowCentre + (vUv - 0.5) * uShadowExtent;
  vec3 pos = normalize(vec3(world.x * 0.001, RG, world.y * 0.001)) * RG;
  vec3 dir = uSunDirection;

  float tau = 0.0;
  if (uCoverage > 0.002 && dir.y > 0.004) {
    float rB, rT;
    cloudShells(rB, rT);
    float t0, t1;
    if (layerSegment(pos, dir, rB, rT, t0, t1)) {
      float seg = min(t1 - t0, 40.0);
      float dt = seg / float(SHADOW_STEPS);
      // Start offset inside the first step, hashed on WORLD position so it is
      // stable as the map re-centres. Without it the coarse march quantises the
      // shadow into visible terraces that crawl as the deck drifts across.
      float t = t0 + dt * (0.15 + 0.7 * hash12(floor(world * 0.04)));
      float h;
      for (int i = 0; i < SHADOW_STEPS; i++) {
        tau += cloudDensityAt(pos + dir * t, false, h) * dt;
        t += dt;
      }
      tau *= 1000.0 * CLOUD_SIGMA_T;
    }
  }

  float tCirrus;
  tau += cirrusOpticalDepth(pos, dir, tCirrus);

  // Thick cloud never reaches zero on the ground: multiple scattering leaks a
  // few percent through even a nimbostratus deck, and clamping here is what
  // keeps an overcast sea leaden rather than black.
  fragColor = vec4(max(exp(-tau), 0.035), 0.0, 0.0, 1.0);
}
`;
