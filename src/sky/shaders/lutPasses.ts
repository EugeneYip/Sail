import { GLSL } from '../../util/glsl';
import { ATMOSPHERE_GLSL } from './atmosphere';

const HEAD = /* glsl */ `
precision highp float;
precision highp sampler2D;
in vec2 vUv;
layout(location = 0) out vec4 fragColor;
${GLSL.common}
${ATMOSPHERE_GLSL}
`;

/** Shared fullscreen-triangle vertex shader for every sky pass. */
export const PASS_VERT = /* glsl */ `
precision highp float;
out vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/**
 * Transmittance LUT, 256x64. Optical depth from a point at (r, mu) to the top
 * of the atmosphere (or to the ground if the ray hits it).
 */
export const TRANSMITTANCE_FRAG = /* glsl */ `
${HEAD}
uniform float uMieMul;
const float STEPS = 48.0;

void main(){
  float r, mu;
  transmittanceParams(fromSubUvs(vUv, TRANSMITTANCE_RES), r, mu);
  vec3 pos = vec3(0.0, r, 0.0);
  vec3 dir = vec3(sqrt(max(0.0, 1.0 - mu * mu)), mu, 0.0);

  float tGround = raySphereNear(pos, dir, RG);
  float tTop = raySphereFar(pos, dir, RT);
  float tMax = tGround > 0.0 ? tGround : tTop;

  vec3 depth = vec3(0.0);
  float dt = tMax / STEPS;
  for (float i = 0.0; i < STEPS; i += 1.0) {
    vec3 p = pos + dir * ((i + 0.5) * dt);
    vec3 sc, ex, rs;
    float ms;
    sampleMedium(length(p) - RG, uMieMul, sc, ex, rs, ms);
    depth += ex * dt;
  }
  fragColor = vec4(exp(-depth), 1.0);
}
`;

/**
 * Multiple-scattering LUT, 32x32. 64 uniformly distributed directions, 20 march
 * steps each, isotropic phase, then the geometric series 1/(1-f_ms) so cloud-free
 * air keeps the energy that would otherwise vanish after one bounce. This is what
 * stops the zenith going black at dusk and the shadowed side of the sky going flat.
 */
export const MULTISCATTER_FRAG = /* glsl */ `
${HEAD}
uniform sampler2D tTransmittance;
uniform float uMieMul;
const float SQRT_SAMPLES = 8.0;
const float DIR_STEPS = 20.0;

void main(){
  vec2 uv = fromSubUvs(vUv, MULTISCATTER_RES);
  float muSun = clamp(uv.x * 2.0 - 1.0, -1.0, 1.0);
  float r = RG + clamp(uv.y, 0.0, 1.0) * (RT - RG);
  r = clamp(r, RG + 0.002, RT - 0.002);

  vec3 pos = vec3(0.0, r, 0.0);
  vec3 sunDir = vec3(sqrt(max(0.0, 1.0 - muSun * muSun)), muSun, 0.0);

  vec3 sumL = vec3(0.0);
  vec3 sumF = vec3(0.0);
  float n = SQRT_SAMPLES * SQRT_SAMPLES;

  for (float a = 0.0; a < SQRT_SAMPLES; a += 1.0) {
    for (float b = 0.0; b < SQRT_SAMPLES; b += 1.0) {
      float theta = TAU * (a + 0.5) / SQRT_SAMPLES;
      float cosPhi = 1.0 - 2.0 * (b + 0.5) / SQRT_SAMPLES;
      float sinPhi = sqrt(max(0.0, 1.0 - cosPhi * cosPhi));
      vec3 dir = vec3(cos(theta) * sinPhi, cosPhi, sin(theta) * sinPhi);

      Scatter s = integrateScattering(pos, dir, sunDir, vec3(1.0),
        -1.0, DIR_STEPS, 0.5, uMieMul, true, false, false,
        tTransmittance, tTransmittance);
      sumL += s.L;
      sumF += s.multiScatAs1;
    }
  }

  vec3 fms = sumF / n;
  vec3 l2 = sumL / n;
  fragColor = vec4(l2 / max(vec3(1e-4), vec3(1.0) - fms), 1.0);
}
`;

/**
 * Sky-view LUT, 192x108. Azimuth is measured relative to the sun so the LUT
 * exploits the sky's mirror symmetry; the elevation mapping is quadratic about
 * the horizon so the horizon band — where all the gradient detail lives — gets
 * most of the rows.
 */
export const SKYVIEW_FRAG = /* glsl */ `
${HEAD}
uniform sampler2D tTransmittance;
uniform sampler2D tMultiScatter;
uniform vec3 uSunIrradiance;
uniform float uSunZenithCos;
uniform float uCameraAltKm;
uniform float uMieMul;
const float STEPS = 32.0;

void main(){
  float r = RG + uCameraAltKm;
  float viewZenithCos, lightViewCos;
  skyViewFromUv(vUv, r, viewZenithCos, lightViewCos);

  float viewSin = sqrt(max(0.0, 1.0 - viewZenithCos * viewZenithCos));
  vec3 dir = vec3(viewSin * lightViewCos, viewZenithCos,
                  viewSin * sqrt(max(0.0, 1.0 - lightViewCos * lightViewCos)));
  vec3 sunDir = vec3(sqrt(max(0.0, 1.0 - uSunZenithCos * uSunZenithCos)), uSunZenithCos, 0.0);
  vec3 pos = vec3(0.0, r, 0.0);

  Scatter s = integrateScattering(pos, dir, sunDir, uSunIrradiance,
    -1.0, STEPS, 0.3, uMieMul, true, true, true, tTransmittance, tMultiScatter);

  fragColor = vec4(s.L, 1.0);
}
`;

/**
 * Aerial-perspective froxel volume, 32x32x32. One slice per draw; w maps
 * linearly to distance ALONG THE VIEW RAY, 0..AERIAL_MAX_KM.
 *
 * RGB = inscattered radiance in game units, A = mean transmittance. The march
 * samples the cloud shadow map, which is where crepuscular rays come from: a
 * froxel sitting in a cloud's shadow receives no sun and stops glowing, so the
 * lit air between shadows reads as a shaft.
 */
export const AERIAL_FRAG = /* glsl */ `
${HEAD}
uniform sampler2D tTransmittance;
uniform sampler2D tMultiScatter;
uniform sampler2D tCloudShadow;
uniform mat4 uCloudShadowMatrix;
uniform mat4 uRayMatrix;
uniform vec3 uCameraPosW;
uniform vec3 uSunDirection;
uniform vec3 uSunIrradiance;
uniform float uCloudShadowAmount;
uniform float uSliceIndex;
uniform float uMieMul;

void main(){
  vec2 ndc = vUv * 2.0 - 1.0;
  vec4 far = uRayMatrix * vec4(ndc, 1.0, 1.0);
  vec3 dir = normalize(far.xyz / far.w - uCameraPosW);

  float camAltKm = max(0.0, uCameraPosW.y) * 0.001;
  vec3 pos = vec3(uCameraPosW.x * 0.001, RG + camAltKm, uCameraPosW.z * 0.001);

  float tMax = (uSliceIndex + 1.0) / AERIAL_SLICES * AERIAL_MAX_KM;
  float steps = clamp(uSliceIndex * 0.8 + 4.0, 4.0, 24.0);

  float tTopHit = raySphereFar(pos, dir, RT);
  float tGround = raySphereNear(pos, dir, RG);
  float limit = tGround > 0.0 ? min(tGround, tTopHit) : tTopHit;
  tMax = min(tMax, max(0.02, limit));

  float cosTheta = dot(dir, uSunDirection);
  float pR = phaseRayleigh(cosTheta);
  float pM = phaseMie(cosTheta, MIE_G);

  vec3 L = vec3(0.0);
  vec3 throughput = vec3(1.0);
  float dt = tMax / steps;
  float t = dt * 0.5;

  for (float i = 0.0; i < steps; i += 1.0) {
    vec3 p = pos + dir * t;
    float rr = length(p);
    vec3 sc, ex, rs;
    float ms;
    sampleMedium(rr - RG, uMieMul, sc, ex, rs, ms);

    vec3 up = p / rr;
    float muSun = dot(up, uSunDirection);
    float shadow = raySphereNear(p, uSunDirection, RG) > 0.0 ? 0.0 : 1.0;

    if (uCloudShadowAmount > 0.0) {
      vec3 wp = vec3(p.x * 1000.0, (rr - RG) * 1000.0, p.z * 1000.0);
      vec2 csUv = (uCloudShadowMatrix * vec4(wp, 1.0)).xy;
      float cs = 1.0;
      if (all(greaterThan(csUv, vec2(0.0))) && all(lessThan(csUv, vec2(1.0)))) {
        cs = texture(tCloudShadow, csUv).r;
      }
      shadow *= mix(1.0, cs, uCloudShadowAmount);
    }

    vec3 sunT = sampleTransmittance(tTransmittance, rr, muSun);
    vec3 msL = texture(tMultiScatter, multiScatterUv(rr, muSun)).rgb;

    vec3 S = uSunIrradiance * ((rs * pR + vec3(ms) * pM) * sunT * shadow + sc * msL);
    vec3 stepT = exp(-ex * dt);
    L += throughput * (S - S * stepT) / max(ex, vec3(1e-9));
    throughput *= stepT;
    t += dt;
  }

  fragColor = vec4(L, dot(throughput, vec3(1.0 / 3.0)));
}
`;
