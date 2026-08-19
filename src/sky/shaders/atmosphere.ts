import {
  AERIAL_MAX_KM,
  AERIAL_SLICES,
  ATMOSPHERE_TOP_KM,
  GROUND_ALBEDO,
  GROUND_RADIUS_KM,
  HAZE_CULL_TAU,
  HAZE_SCALE_HEIGHT_M,
  MIE_ABSORPTION,
  MIE_ANISOTROPY,
  MIE_SCALE_HEIGHT_KM,
  MIE_SCATTERING,
  MULTISCATTER_SIZE,
  OZONE_ABSORPTION,
  OZONE_CENTRE_KM,
  OZONE_HALF_WIDTH_KM,
  RAYLEIGH_SCALE_HEIGHT_KM,
  RAYLEIGH_SCATTERING,
  SKYVIEW_H,
  SKYVIEW_W,
  TRANSMITTANCE_H,
  TRANSMITTANCE_W,
} from '../constants';

const f = (n: number) => (Number.isInteger(n) ? n.toFixed(1) : String(n));
const v3 = (v: { x: number; y: number; z: number }) => `vec3(${v.x}, ${v.y}, ${v.z})`;

/**
 * The atmosphere participating-medium model plus Bruneton's LUT
 * parameterisations and Hillaire's energy-conserving scattering integrator.
 * Depends on: GLSL.common (PI, saturate1, hash*).
 */
export const ATMOSPHERE_GLSL = /* glsl */ `
#ifndef SKY_ATMOSPHERE
#define SKY_ATMOSPHERE

const float RG = ${f(GROUND_RADIUS_KM)};
const float RT = ${f(ATMOSPHERE_TOP_KM)};
const vec3  BETA_R = ${v3(RAYLEIGH_SCATTERING)};
const float H_R = ${f(RAYLEIGH_SCALE_HEIGHT_KM)};
const float BETA_M_S = ${MIE_SCATTERING};
const float BETA_M_A = ${MIE_ABSORPTION};
const float H_M = ${f(MIE_SCALE_HEIGHT_KM)};
const float MIE_G = ${f(MIE_ANISOTROPY)};
const vec3  BETA_O = ${v3(OZONE_ABSORPTION)};
const float OZONE_C = ${f(OZONE_CENTRE_KM)};
const float OZONE_W = ${f(OZONE_HALF_WIDTH_KM)};
const vec3  GROUND_ALBEDO = ${v3(GROUND_ALBEDO)};

const vec2 TRANSMITTANCE_RES = vec2(${f(TRANSMITTANCE_W)}, ${f(TRANSMITTANCE_H)});
const vec2 MULTISCATTER_RES  = vec2(${f(MULTISCATTER_SIZE)}, ${f(MULTISCATTER_SIZE)});
const vec2 SKYVIEW_RES       = vec2(${f(SKYVIEW_W)}, ${f(SKYVIEW_H)});
const float AERIAL_SLICES    = ${f(AERIAL_SLICES)};
const float AERIAL_MAX_KM    = ${f(AERIAL_MAX_KM)};

/*
 * Weather haze. Declared HERE rather than in the sky shader because the cloud
 * march needs the same value: a ray whose haze column has already erased the
 * deck is a ray not worth marching, and the two must agree or the march would
 * cull cloud the sky still shows. Extinction in EXCESS of clear air, 1/m, so it
 * is exactly 0 on a 30 km day and every one of these terms folds away.
 */
uniform float uHazeBeta;
const float HAZE_H = ${f(HAZE_SCALE_HEIGHT_M)};
const float HAZE_CULL_TAU = ${f(HAZE_CULL_TAU)};

/** Haze optical depth in front of everything a ray of this elevation can see. */
float hazeColumnTau(float dirY){
  return uHazeBeta * (HAZE_H / max(abs(dirY), 0.015));
}

// Half-texel guards so a LUT edge sample lands on the extreme parameter value
// rather than half a texel inside it (Hillaire's fromUnitToSubUvs).
vec2 toSubUvs(vec2 uv, vec2 res){ return (uv + 0.5 / res) * (res / (res + 1.0)); }
vec2 fromSubUvs(vec2 uv, vec2 res){ return (uv - 0.5 / res) * (res / (res - 1.0)); }

/** Nearest non-negative ray-sphere hit for a sphere centred on the origin. */
float raySphereNear(vec3 o, vec3 d, float radius){
  float b = dot(o, d);
  float c = dot(o, o) - radius * radius;
  float disc = b * b - c;
  if (disc < 0.0) return -1.0;
  disc = sqrt(disc);
  float t0 = -b - disc;
  float t1 = -b + disc;
  if (t1 < 0.0) return -1.0;
  return t0 < 0.0 ? t1 : t0;
}

/** Farthest hit — used to find the exit point through the top of atmosphere. */
float raySphereFar(vec3 o, vec3 d, float radius){
  float b = dot(o, d);
  float c = dot(o, o) - radius * radius;
  float disc = b * b - c;
  if (disc < 0.0) return -1.0;
  return -b + sqrt(disc);
}

/**
 * Medium at altitude h (km). mieMul scales the aerosol column for turbidity.
 */
void sampleMedium(float h, float mieMul, out vec3 scattering, out vec3 extinction,
                  out vec3 rayleighS, out float mieS){
  float dR = exp(-max(0.0, h) / H_R);
  float dM = exp(-max(0.0, h) / H_M) * mieMul;
  float dO = max(0.0, 1.0 - abs(h - OZONE_C) / OZONE_W);
  rayleighS = BETA_R * dR;
  mieS = BETA_M_S * dM;
  scattering = rayleighS + vec3(mieS);
  extinction = scattering + vec3(BETA_M_A * dM) + BETA_O * dO;
}

float phaseRayleigh(float c){ return (3.0 / (16.0 * PI)) * (1.0 + c * c); }

/** Cornette-Shanks — closer to real Mie forward scatter than plain HG. */
float phaseMie(float c, float g){
  float g2 = g * g;
  float k = 3.0 / (8.0 * PI) * (1.0 - g2) / (2.0 + g2);
  float d = 1.0 + g2 - 2.0 * g * c;
  return k * (1.0 + c * c) / max(1e-4, d * sqrt(max(1e-4, d)));
}

float phaseHG(float c, float g){
  float g2 = g * g;
  float d = 1.0 + g2 - 2.0 * g * c;
  return (1.0 - g2) / (4.0 * PI * max(1e-4, d * sqrt(max(1e-4, d))));
}

const float UNIFORM_PHASE = 1.0 / (4.0 * PI);

/* --- transmittance LUT parameterisation (Bruneton) --- */

vec2 transmittanceUv(float r, float mu){
  float H = sqrt(max(0.0, RT * RT - RG * RG));
  float rho = sqrt(max(0.0, r * r - RG * RG));
  float d = max(0.0, -r * mu + sqrt(max(0.0, r * r * (mu * mu - 1.0) + RT * RT)));
  float dMin = RT - r;
  float dMax = rho + H;
  return vec2((d - dMin) / max(1e-5, dMax - dMin), rho / H);
}

void transmittanceParams(vec2 uv, out float r, out float mu){
  float H = sqrt(max(0.0, RT * RT - RG * RG));
  float rho = H * uv.y;
  r = sqrt(rho * rho + RG * RG);
  float dMin = RT - r;
  float dMax = rho + H;
  float d = dMin + uv.x * (dMax - dMin);
  mu = d == 0.0 ? 1.0 : clamp((H * H - rho * rho - d * d) / (2.0 * r * d), -1.0, 1.0);
}

vec3 sampleTransmittance(sampler2D lut, float r, float mu){
  return texture(lut, toSubUvs(transmittanceUv(r, mu), TRANSMITTANCE_RES)).rgb;
}

/* --- multiple-scattering LUT parameterisation --- */

vec2 multiScatterUv(float r, float muSun){
  return toSubUvs(vec2(muSun * 0.5 + 0.5,
                       clamp((r - RG) / (RT - RG), 0.0, 1.0)), MULTISCATTER_RES);
}

/* --- sky-view LUT parameterisation (Hillaire) --- */

void skyViewFromUv(vec2 uv, float r, out float viewZenithCos, out float lightViewCos){
  uv = fromSubUvs(uv, SKYVIEW_RES);
  float vHorizon = sqrt(max(1e-4, r * r - RG * RG));
  float cosBeta = vHorizon / r;
  float beta = acos(clamp(cosBeta, -1.0, 1.0));
  float zenithHorizon = PI - beta;
  float viewZenith;
  if (uv.y < 0.5) {
    float c = 1.0 - 2.0 * uv.y;
    viewZenith = zenithHorizon * (1.0 - c * c);
  } else {
    float c = 2.0 * uv.y - 1.0;
    viewZenith = zenithHorizon + beta * c * c;
  }
  viewZenithCos = cos(viewZenith);
  float cu = uv.x * uv.x;
  lightViewCos = -(cu * 2.0 - 1.0);
}

vec2 skyViewToUv(bool hitsGround, float viewZenithCos, float lightViewCos, float r){
  float vHorizon = sqrt(max(1e-4, r * r - RG * RG));
  float cosBeta = vHorizon / r;
  float beta = acos(clamp(cosBeta, -1.0, 1.0));
  float zenithHorizon = PI - beta;
  float viewZenith = acos(clamp(viewZenithCos, -1.0, 1.0));
  float v;
  if (!hitsGround) {
    float c = viewZenith / max(1e-4, zenithHorizon);
    v = (1.0 - sqrt(max(0.0, 1.0 - c))) * 0.5;
  } else {
    float c = (viewZenith - zenithHorizon) / max(1e-4, beta);
    v = sqrt(max(0.0, c)) * 0.5 + 0.5;
  }
  float u = sqrt(max(0.0, -lightViewCos * 0.5 + 0.5));
  return toSubUvs(vec2(u, v), SKYVIEW_RES);
}

/**
 * Hillaire's scattering integrator. Everything else in the module is a caller.
 *
 *   pos           planet-centred position, km
 *   dir           unit view direction
 *   sunDir        unit direction toward the sun
 *   tMaxOverride  clip the march (km), < 0 = to the atmosphere/ground boundary
 *   steps         march sample count
 *   jitter        0..1 sample offset inside the first step
 *   phased        false = isotropic phase (used when baking multiple scattering)
 *   msLutOn       add the multiple-scattering LUT contribution
 *
 * Outputs radiance in the same units as sunIrradiance.
 */
struct Scatter {
  vec3 L;
  vec3 transmittance;
  vec3 multiScatAs1;
  float tMax;
};

Scatter integrateScattering(
    vec3 pos, vec3 dir, vec3 sunDir, vec3 sunIrradiance,
    float tMaxOverride, float steps, float jitter, float mieMul,
    bool includeGround, bool phased, bool msLutOn,
    sampler2D transLut, sampler2D msLut){

  Scatter res;
  res.L = vec3(0.0);
  res.transmittance = vec3(1.0);
  res.multiScatAs1 = vec3(0.0);

  float tTop = raySphereFar(pos, dir, RT);
  float tGround = raySphereNear(pos, dir, RG);
  bool hitsGround = tGround > 0.0;
  float tMax = hitsGround ? tGround : tTop;
  if (tMax <= 0.0) { res.tMax = 0.0; return res; }
  if (tMaxOverride > 0.0) { tMax = min(tMax, tMaxOverride); hitsGround = hitsGround && tGround <= tMax + 1e-4; }
  res.tMax = tMax;

  float cosTheta = dot(dir, sunDir);
  float pR = phased ? phaseRayleigh(cosTheta) : UNIFORM_PHASE;
  float pM = phased ? phaseMie(cosTheta, MIE_G) : UNIFORM_PHASE;

  float dt = tMax / steps;
  float t = dt * jitter;

  for (float i = 0.0; i < steps; i += 1.0) {
    vec3 p = pos + dir * (t + dt * 0.5);
    float r = length(p);
    float h = r - RG;

    vec3 scattering, extinction, rayleighS;
    float mieS;
    sampleMedium(h, mieMul, scattering, extinction, rayleighS, mieS);

    vec3 up = p / r;
    float muSun = dot(up, sunDir);

    // Planet shadow: the sun ray from this sample must clear the ground.
    float shadow = raySphereNear(p, sunDir, RG) > 0.0 ? 0.0 : 1.0;
    vec3 sunT = sampleTransmittance(transLut, r, muSun);

    vec3 stepT = exp(-extinction * dt);
    vec3 invExt = 1.0 / max(extinction, vec3(1e-9));

    vec3 inscatter = (rayleighS * pR + vec3(mieS) * pM) * sunT * shadow;
    if (msLutOn) {
      vec3 ms = texture(msLut, multiScatterUv(r, muSun)).rgb;
      inscatter += scattering * ms;
    }
    vec3 S = sunIrradiance * inscatter;

    // Energy-conserving analytic integration of the segment (Hillaire eq. 5).
    res.L += res.transmittance * (S - S * stepT) * invExt;

    vec3 msAs1 = (scattering - scattering * stepT) * invExt;
    res.multiScatAs1 += res.transmittance * msAs1;

    res.transmittance *= stepT;
    t += dt;
  }

  if (includeGround && hitsGround) {
    vec3 p = pos + dir * tMax;
    float r = length(p);
    vec3 up = p / r;
    float muSun = dot(up, sunDir);
    if (muSun > 0.0) {
      vec3 sunT = sampleTransmittance(transLut, r, muSun);
      res.L += res.transmittance * sunIrradiance * sunT * muSun * GROUND_ALBEDO / PI;
    }
  }

  return res;
}
#endif
`;
