import { GLSL } from '../../util/glsl';
import { ATMOSPHERE_GLSL } from './atmosphere';
import { CELESTIAL_GLSL } from './celestial';
import { CLOUD_COMMON_GLSL } from './cloudCommon';
import { CLOUD_LIGHTING_GLSL } from './cloudLighting';

/** Raymarch steps for the coarse in-line march the environment probe uses. */
const ENV_CLOUD_STEPS = 14;

/**
 * The visible sky. A fullscreen triangle drawn first in the main scene with
 * depth writes off, so everything else composites over it.
 *
 * Radiance sources, in the order they are added:
 *   1. sky-view LUT      — multiply-scattered atmosphere at this camera altitude
 *   2. airglow           — the 557.7 nm oxygen floor, so night is never pure black
 *   3. stars + Milky Way — attenuated by the view-ray transmittance
 *   4. moon disc         — phase terminator, Lommel-Seeliger regolith, earthshine
 *   5. sun disc          — limb-darkened, 0.5334 deg, transmittance-attenuated
 *   6. moon sky glow     — analytic single scattering from a weak source
 *   7. clouds            — composited from the reprojected raymarch buffer
 *
 * Defines:
 *   SKY_CLOUDS  composite the screen-space cloud buffer
 *   SKY_ENV     environment-probe variant: no sun disc (the directional light
 *               already carries it), no stars, coarse in-line cloud march
 */
export const SKY_VERT = /* glsl */ `
precision highp float;
out vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`;

export const SKY_FRAG = /* glsl */ `
precision highp float;
precision highp sampler2D;
precision highp sampler3D;
in vec2 vUv;
layout(location = 0) out vec4 fragColor;

${GLSL.common}
${GLSL.simplex3d}
${GLSL.fbm}
${GLSL.worley3d}
${ATMOSPHERE_GLSL}
${CELESTIAL_GLSL}

uniform sampler2D tTransmittance;
uniform sampler2D tSkyView;
uniform sampler2D tStarRamp;
uniform sampler2D tMoonAlbedo;

uniform mat4  uRayMatrix;
uniform vec3  uCameraPosW;
uniform vec3  uSunDirection;
uniform vec3  uMoonDirection;
uniform vec3  uCelestialPole;
uniform mat3  uStarMatrix;

uniform vec3  uSunDiscRadiance;
uniform vec3  uMoonDiscRadiance;
uniform vec3  uMoonEarthshine;
uniform vec3  uMoonGlow;
uniform vec3  uAirglow;
uniform float uStarBrightness;
uniform float uMilkyWay;
uniform float uPixelAngle;
uniform float uMieMul;
uniform float uSkyTime;

#ifdef SKY_CLOUDS
uniform sampler2D tClouds;
#endif

#ifdef SKY_ENV_CLOUDS
${CLOUD_COMMON_GLSL}
${CLOUD_LIGHTING_GLSL}
uniform sampler2D tCloudShadow;
uniform mat4 uCloudShadowMatrix;

/**
 * Coarse in-line cloud march for the environment probe.
 *
 * The probe is 256x128 and refreshes at 6 Hz, so 14 steps with no detail octave
 * and no shaft march is about 400 k samples — a rounding error next to the
 * screen march, and without it every ship surface would be lit by a blue sky
 * while the visible sky is solid overcast. Same 'cloudMarch', same lighting, so
 * the IBL cannot disagree with what the camera sees.
 */
vec4 envCloudMarch(vec3 camPos, vec3 dir){
  vec3 pos = vec3(camPos.x * 0.001, RG + max(0.0, camPos.y) * 0.001, camPos.z * 0.001);
  float jitter = hash12(dir.xz * 137.0) * 0.9;
  return cloudMarch(pos, dir, uSunDirection, ${ENV_CLOUD_STEPS}.0, jitter, tTransmittance,
                    false, tCloudShadow, uCloudShadowMatrix, false);
}
#endif

/** Kasten-Young airmass — used for stellar extinction and scintillation. */
float airmassKY(float cosZenith){
  float c = max(cosZenith, -0.03);
  return 1.0 / (c + 0.50572 * pow(max(0.001, 96.07995 - degrees(acos(clamp(c, -1.0, 1.0)))), -1.6364));
}

void main(){
#ifdef SKY_EQUIRECT
  // three's equirect convention: u = atan(z, x)/TAU + 0.5, v = asin(y)/PI + 0.5.
  float lat = (vUv.y - 0.5) * PI;
  float lon = (vUv.x - 0.5) * TAU;
  float cl = cos(lat);
  vec3 dir = vec3(cos(lon) * cl, sin(lat), sin(lon) * cl);
#else
  vec2 ndc = vUv * 2.0 - 1.0;
  vec4 hp = uRayMatrix * vec4(ndc, 1.0, 1.0);
  vec3 dir = normalize(hp.xyz / hp.w - uCameraPosW);
#endif

  float camAltKm = max(0.0, uCameraPosW.y) * 0.001;
  float r = RG + camAltKm;

  float viewZenithCos = dir.y;
  vec2 sunH = uSunDirection.xz;
  vec2 dirH = dir.xz;
  float sunHLen = length(sunH);
  float dirHLen = length(dirH);
  float lightViewCos = (sunHLen > 1e-5 && dirHLen > 1e-5)
    ? clamp(dot(dirH, sunH) / (dirHLen * sunHLen), -1.0, 1.0)
    : 1.0;

  float horizonCos = -sqrt(max(0.0, r * r - RG * RG)) / r;
  bool hitsGround = viewZenithCos < horizonCos;

  vec3 L = texture(tSkyView, skyViewToUv(hitsGround, viewZenithCos, lightViewCos, r)).rgb;

  float above = hitsGround ? 0.0 : 1.0;
  float am = airmassKY(viewZenithCos);

  // Airglow: a real, faint emission layer. Without it a moonless night has a
  // mathematically black zenith, which reads as a rendering failure.
  L += uAirglow * min(am, 6.0) * above;

  vec3 viewTrans = sampleTransmittance(tTransmittance, r, max(viewZenithCos, horizonCos + 1e-4));

  vec3 space = vec3(0.0);

#ifndef SKY_ENV
  if (uStarBrightness > 0.0004 && above > 0.5) {
    vec3 cd = uStarMatrix * dir;
    space += starField(cd, uPixelAngle, uSkyTime, min(am, 12.0), tStarRamp) * uStarBrightness;
    space += milkyWay(cd) * uMilkyWay;
  }
#endif

  float moonCov = 0.0;
  if (above > 0.5 && dot(dir, uMoonDirection) > cos(MOON_ANG_R * 2.0)) {
    vec3 moon = moonDisc(dir, uMoonDirection, uSunDirection, uCelestialPole, uPixelAngle,
                         tMoonAlbedo, uMoonDiscRadiance, uMoonEarthshine, moonCov);
    space = space * (1.0 - moonCov) + moon;
  }

  L += space * viewTrans;

#ifndef SKY_ENV
  float cosSun = dot(dir, uSunDirection);
  if (above > 0.5 && cosSun > cos(SUN_ANG_R * 2.2)) {
    float theta = acos(clamp(cosSun, -1.0, 1.0));
    // The disc edge is antialiased over one pixel; below ~1 px the whole disc
    // shrinks in intensity instead of vanishing, which keeps it stable in TAA.
    float soft = max(uPixelAngle * 0.6, SUN_ANG_R * 0.02);
    float edge = 1.0 - smoothstep(SUN_ANG_R - soft, SUN_ANG_R + soft, theta);
    L += uSunDiscRadiance * sunLimbDarkening(theta) * edge * viewTrans;
  }
#endif

  L += weakSourceSkyGlow(dir, uMoonDirection, uMoonGlow, uMieMul) * above;

#ifdef SKY_CLOUDS
  vec4 cl = texture(tClouds, vUv);
  L = L * cl.a + cl.rgb;
#endif
#ifdef SKY_ENV_CLOUDS
  vec4 ecl = envCloudMarch(uCameraPosW, dir);
  L = L * ecl.a + ecl.rgb;
#endif

  fragColor = vec4(max(L, vec3(0.0)), 1.0);
}
`;
