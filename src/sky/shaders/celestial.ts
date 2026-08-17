import { GLSL } from '../../util/glsl';
import { MOON_ANGULAR_RADIUS, SUN_ANGULAR_RADIUS } from '../constants';

/**
 * Sun disc, moon, stars and the Milky Way.
 *
 * Depends on: GLSL.common, GLSL.simplex3d, GLSL.fbm, GLSL.worley3d and the
 * atmosphere snippet (for BETA_*, H_*, phase functions).
 */
export const CELESTIAL_GLSL = /* glsl */ `
#ifndef SKY_CELESTIAL
#define SKY_CELESTIAL

const float SUN_ANG_R  = ${SUN_ANGULAR_RADIUS};
const float MOON_ANG_R = ${MOON_ANGULAR_RADIUS};

/* Galactic frame in equatorial coordinates: north galactic pole at
   RA 12h51.4m / Dec +27.13, galactic centre (Sgr A*) at RA 17h45.7m / Dec -28.94. */
const vec3 GAL_POLE   = vec3(-0.8676, -0.1981,  0.4560);
const vec3 GAL_CENTRE = vec3(-0.0550, -0.8735, -0.4839);

/**
 * Solar limb darkening. Blue darkens faster than red, so the disc edge is
 * measurably warmer than its centre — the reason a photographed sun has a
 * soft orange rim even high in the sky.
 */
vec3 sunLimbDarkening(float theta){
  float x = clamp(theta / SUN_ANG_R, 0.0, 1.0);
  float mu = sqrt(max(0.0, 1.0 - x * x));
  const vec3 u = vec3(0.55, 0.62, 0.75);
  return max(vec3(0.0), vec3(1.0) - u * (1.0 - mu));
}

/* --- cube-face cell grid, used to place stars without pole crowding --- */

vec3 cubeFaceDir(int face, vec2 st){
  if (face == 0) return vec3( 1.0, st.x, st.y);
  if (face == 1) return vec3(-1.0, st.x, st.y);
  if (face == 2) return vec3(st.x,  1.0, st.y);
  if (face == 3) return vec3(st.x, -1.0, st.y);
  if (face == 4) return vec3(st.x, st.y,  1.0);
  return vec3(st.x, st.y, -1.0);
}

void dirToCubeFace(vec3 d, out int face, out vec2 st){
  vec3 a = abs(d);
  if (a.x >= a.y && a.x >= a.z) { face = d.x > 0.0 ? 0 : 1; st = d.yz / a.x; }
  else if (a.y >= a.z)          { face = d.y > 0.0 ? 2 : 3; st = d.xz / a.y; }
  else                          { face = d.z > 0.0 ? 4 : 5; st = d.xy / a.z; }
}

/**
 * Procedural star catalogue. One star per grid cell on a cube-mapped celestial
 * sphere, brightness from a steep power law so the magnitude histogram looks
 * like the real sky (a handful of first-magnitude stars, thousands of faint
 * ones). Colour comes from a stellar-temperature ramp baked with kelvinToColor.
 *
 *   cd         direction in the celestial frame (already rotated for sidereal time)
 *   pixelAngle angular size of one pixel, radians — keeps stars ~1.5 px wide at
 *              any resolution instead of flickering in and out
 *   airmass    Kasten-Young airmass, drives both extinction and scintillation
 */
vec3 starField(vec3 cd, float pixelAngle, float time, float airmass, sampler2D tTempRamp){
  int face;
  vec2 st;
  dirToCubeFace(cd, face, st);

  const float GRID = 24.0;
  vec2 g = st * GRID;
  vec2 base = floor(g);

  float sigma = max(pixelAngle * 1.15, 0.00035);
  float twinkleAmp = clamp((airmass - 1.0) * 0.3, 0.0, 0.8);
  float extinction = exp(-0.19 * (airmass - 1.0));

  vec3 sum = vec3(0.0);
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 cell = base + vec2(float(i), float(j));
      if (abs(cell.x + 0.5) > GRID || abs(cell.y + 0.5) > GRID) continue;
      vec3 h = hash33(vec3(cell, float(face) * 41.0 + 7.0));
      float mag = pow(h.z, 5.5);
      if (mag < 0.0012) continue;

      vec2 sub = (cell + vec2(h.x, h.y)) / GRID;
      vec3 sdir = normalize(cubeFaceDir(face, sub));
      float d = length(sdir - cd);
      float w = exp(-(d * d) / (sigma * sigma));
      if (w < 0.002) continue;

      float ph = h.x * 31.7 + h.y * 12.3;
      float tw = 1.0 + twinkleAmp * (sin(time * (5.4 + h.x * 6.0) + ph) * 0.6
                                   + sin(time * (2.7 + h.y * 3.4) + ph * 2.3) * 0.4);
      vec3 col = texture(tTempRamp, vec2(hash12(cell + float(face) * 3.3), 0.5)).rgb;
      sum += col * (mag * w * max(0.0, tw) * extinction);
    }
  }
  return sum;
}

/**
 * The Milky Way as a dust-lane-broken band about the galactic equator, warmer
 * and brighter toward the bulge in Sagittarius.
 */
vec3 milkyWay(vec3 cd){
  float sinB = dot(cd, GAL_POLE);
  float band = exp(-pow(abs(sinB) / 0.155, 1.7));
  if (band < 0.004) return vec3(0.0);

  float bulge = smoothstep(-0.35, 0.9, dot(cd, GAL_CENTRE));
  float clouds = fbm3(cd * 6.5, 4, 2.13, 0.55) * 0.5 + 0.5;
  float rift = fbm3(cd * 3.1 + vec3(17.3, 4.1, 9.7), 3, 2.31, 0.5) * 0.5 + 0.5;
  float dust = 1.0 - 0.8 * smoothstep(0.42, 0.72, rift) * band;

  float density = band * mix(0.3, 1.0, clouds) * dust * mix(0.55, 1.9, bulge);
  vec3 tint = mix(vec3(0.62, 0.70, 0.95), vec3(1.0, 0.88, 0.70), bulge * 0.8);

  // Unresolved star grain so the band is not a smooth airbrushed smudge.
  float grain = hash13(floor(cd * 900.0));
  density *= 1.0 + 0.55 * (grain - 0.5);
  return tint * density;
}

/**
 * Moon disc. 'moonToSun' is the direction of the sun as seen from the moon, which
 * is what puts the terminator in the right place; 'tMoonAlbedo' is the equirect
 * surface map baked at init.
 */
vec3 moonDisc(vec3 dir, vec3 moonDir, vec3 moonToSun, vec3 poleDir,
              float pixelAngle, sampler2D tMoonAlbedo, vec3 sunlight,
              vec3 earthshine, out float coverage){
  coverage = 0.0;
  float cosD = dot(dir, moonDir);
  if (cosD < cos(MOON_ANG_R * 1.6)) return vec3(0.0);

  vec3 xM = normalize(cross(poleDir, moonDir) + vec3(1e-5, 0.0, 0.0));
  vec3 yM = cross(moonDir, xM);
  vec3 off = dir - moonDir * cosD;
  float ax = dot(off, xM);
  float ay = dot(off, yM);
  float q = sqrt(ax * ax + ay * ay) / MOON_ANG_R;

  float edge = 1.0 - smoothstep(1.0 - pixelAngle / MOON_ANG_R - 0.004,
                                1.0 + pixelAngle / MOON_ANG_R + 0.004, q);
  if (edge <= 0.0) return vec3(0.0);
  coverage = edge;

  float qc = min(q, 0.9999);
  vec3 n = normalize(xM * (ax / MOON_ANG_R) + yM * (ay / MOON_ANG_R)
                     - moonDir * sqrt(max(0.0, 1.0 - qc * qc)));

  // Surface lookup in the moon's own frame: it is tidally locked, so the same
  // face is always toward us and the map can be a fixed equirect.
  float lon = atan(dot(n, xM), -dot(n, moonDir));
  float lat = asin(clamp(dot(n, yM), -1.0, 1.0));
  vec3 albedo = texture(tMoonAlbedo, vec2(lon / TAU + 0.5, lat / PI + 0.5)).rgb;

  float ndl = dot(n, moonToSun);
  // Terminator softened by the sun's own angular size seen from the moon.
  float lit = smoothstep(-0.035, 0.055, ndl);
  // Lommel-Seeliger: regolith backscatters hard, so a full moon reads flat and
  // bright rather than as a shaded ball.
  float nv = max(0.02, dot(n, -moonDir));
  float ls = clamp(max(ndl, 0.0) / (max(ndl, 0.0) + nv), 0.0, 1.0) * 2.0;

  vec3 c = albedo * sunlight * (lit * ls);
  c += albedo * earthshine * (1.0 - lit);
  return c * edge;
}

/**
 * Single-scattering sky glow from a weak source (the moon). A full LUT chain per
 * light source is not worth 0.0026 of the sun's irradiance; this is the analytic
 * homogeneous-slab solution, which has the right colour and the right horizon
 * falloff.
 */
vec3 weakSourceSkyGlow(vec3 dir, vec3 srcDir, vec3 irradiance, float mieMul){
  float mu = max(dir.y, 0.015);
  float airmass = min(1.0 / mu, 22.0);
  float cosTheta = dot(dir, srcDir);
  vec3 colR = BETA_R * H_R;
  float colM = BETA_M_S * H_M * mieMul;
  vec3 scat = (colR * phaseRayleigh(cosTheta) + vec3(colM * phaseMie(cosTheta, MIE_G))) * airmass;
  vec3 tau = (colR + vec3((BETA_M_S + BETA_M_A) * H_M * mieMul)) * airmass;
  return irradiance * scat * (vec3(1.0) - exp(-tau)) / max(tau, vec3(1e-4));
}
#endif
`;

/**
 * Moon surface albedo, baked once into a 256x128 equirect. Maria are large
 * low-frequency basalt floods; craters are worley rims with bright ejecta.
 */
export const MOON_TEXTURE_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
layout(location = 0) out vec4 fragColor;
${GLSL.common}
${GLSL.simplex3d}
${GLSL.fbm}
${GLSL.worley3d}

vec3 sphereFromUv(vec2 uv){
  float lon = (uv.x - 0.5) * TAU;
  float lat = (uv.y - 0.5) * PI;
  float cl = cos(lat);
  return vec3(sin(lon) * cl, sin(lat), cos(lon) * cl);
}

float craterLayer(vec3 p, float freq, float depth){
  vec2 w = worley3(p, freq);
  float f1 = w.x;
  // Bowl floor, bright raised rim, faint ejecta blanket.
  float floorMask = 1.0 - smoothstep(0.0, 0.30, f1);
  float rim = smoothstep(0.24, 0.33, f1) * (1.0 - smoothstep(0.33, 0.46, f1));
  float ejecta = (1.0 - smoothstep(0.40, 0.85, f1)) * 0.18;
  return (rim * 0.9 + ejecta - floorMask * depth);
}

void main(){
  vec3 p = sphereFromUv(vUv);

  // Maria: a few very large dark floods, concentrated on the near side.
  float lowFreq = fbm3(p * 1.35 + vec3(3.7, 1.1, 8.2), 3, 2.05, 0.55) * 0.5 + 0.5;
  float maria = smoothstep(0.50, 0.66, lowFreq);
  float nearSide = smoothstep(-0.2, 0.7, p.z);
  maria *= mix(0.25, 1.0, nearSide);

  float base = 0.118;
  float highlands = fbm3(p * 9.0, 4, 2.17, 0.5) * 0.5 + 0.5;
  float albedo = mix(base, 0.062, maria);
  albedo *= mix(0.86, 1.14, highlands);

  float craters = craterLayer(p, 9.0, 0.28) * 0.55
                + craterLayer(p, 21.0, 0.24) * 0.35
                + craterLayer(p, 46.0, 0.20) * 0.22;
  albedo *= 1.0 + craters * mix(1.0, 0.35, maria);

  // A couple of bright young craters with ray systems (Tycho, Copernicus).
  float rays = 0.0;
  vec3 tycho = normalize(vec3(-0.19, -0.72, 0.66));
  float dT = acos(clamp(dot(p, tycho), -1.0, 1.0));
  float rayN = fbm3(normalize(p - tycho * 0.0) * 26.0, 2, 2.3, 0.5) * 0.5 + 0.5;
  rays += (1.0 - smoothstep(0.06, 0.62, dT)) * smoothstep(0.45, 0.85, rayN) * 0.5;
  albedo *= 1.0 + rays;

  fragColor = vec4(vec3(albedo) * vec3(1.06, 1.0, 0.92), 1.0);
}
`;
