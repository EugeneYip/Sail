import {
  CLOUD_CIRRUS_MAP_SCALE,
  CLOUD_CIRRUS_OPTICAL_DEPTH,
  CLOUD_CIRRUS_THICKNESS_M,
  CLOUD_EXTINCTION_PER_M,
  CLOUD_HIGH_M,
} from '../constants';

const f = (n: number) => (Number.isInteger(n) ? n.toFixed(1) : String(n));

/**
 * Cloud density field and layer geometry, shared by the raymarch, the shadow
 * pass and the env-map pass.
 *
 * Positions arrive in PLANET SPACE (km, origin at the planet centre) so that the
 * deck curves down to the horizon like a real cloud layer instead of running
 * flat to infinity. Altitude is derived as 'length(p) - RG', which keeps ~1 m
 * precision in fp32 at these radii; the horizontal coordinates stay small and
 * exact, and they are what the noise is sampled with.
 *
 * `uFieldOffset` carries BOTH the floating-origin offset and the accumulated
 * wind scroll, in metres. Everything — weather map, base volume, detail volume —
 * is sampled through it, so the whole field advects as one body and a
 * floating-origin shift does not slide the clouds sideways.
 *
 * Depends on: GLSL.common, the atmosphere snippet (RG, raySphere*).
 */
export const CLOUD_COMMON_GLSL = /* glsl */ `
#ifndef SKY_CLOUD_COMMON
#define SKY_CLOUD_COMMON

const float CLOUD_SIGMA_T = ${CLOUD_EXTINCTION_PER_M};
const float CIRRUS_ALT_KM = ${f(CLOUD_HIGH_M / 1000)};
const float CIRRUS_TAU = ${CLOUD_CIRRUS_OPTICAL_DEPTH};
const float CIRRUS_THICK_M = ${f(CLOUD_CIRRUS_THICKNESS_M)};
const float CIRRUS_MAP_SCALE = ${f(CLOUD_CIRRUS_MAP_SCALE)};

uniform highp sampler3D tCloudBase;
uniform highp sampler3D tCloudDetail;
uniform sampler2D tWeather;
uniform vec2  uFieldOffset;
uniform vec2  uDetailOffset;
uniform vec2  uCirrusOffset;
uniform float uWeatherExtent;
uniform float uBaseScale;
uniform float uDetailScale;
uniform float uCoverage;
uniform float uCloudType;
uniform float uErosion;
uniform float uLayerBottom;
uniform float uLayerTop;
uniform float uShear;
uniform vec2  uWindDir;
uniform float uDensityScale;
uniform float uCirrusAmount;

/**
 * Vertical profile per cloud family. Stratus is a thin sheet near the base,
 * cumulus fills most of the slab and only fades at the very top.
 */
float heightGradient(float h, float type){
  float stratus = linstep(0.0, 0.07, h) * (1.0 - linstep(0.14, 0.30, h));
  float stratocu = linstep(0.0, 0.10, h) * (1.0 - linstep(0.30, 0.68, h));
  float cumulus  = linstep(0.0, 0.13, h) * (1.0 - linstep(0.70, 1.0, h));
  float a = 1.0 - saturate1(type * 2.0);
  float b = 1.0 - abs(type - 0.5) * 2.0;
  float c = saturate1(type * 2.0 - 1.0);
  return stratus * a + stratocu * b + cumulus * c;
}

/**
 * 'detail' false skips the high-frequency erosion — used by the sun march and
 * the shadow map, where the extra octaves cost more than they show.
 */
float cloudDensity(vec2 wxz, float alt, bool detail, out float hFrac){
  float h = (alt - uLayerBottom) / max(1.0, uLayerTop - uLayerBottom);
  hFrac = h;
  if (h < 0.0 || h > 1.0) return 0.0;

  vec2 xz = wxz + uWindDir * (h * uShear);
  vec4 wm = texture(tWeather, xz / uWeatherExtent);

  float type = saturate1(uCloudType + (wm.g - 0.5) * 0.55);
  float grad = heightGradient(h, type);
  if (grad <= 0.001) return 0.0;

  float cov = saturate1(uCoverage);
  float cf = saturate1(remap(wm.r, 1.0 - cov * 1.25, 1.0 - cov * 0.15, 0.0, 1.0));
  if (cf <= 0.001) return 0.0;

  vec3 bp = vec3(xz.x, alt, xz.y) * uBaseScale;
  vec4 base = texture(tCloudBase, bp);
  float lowFbm = base.g * 0.625 + base.b * 0.25 + base.a * 0.125;
  float shape = saturate1(remap(base.r, lowFbm - 1.0, 1.0, 0.0, 1.0));

  // Above ~0.8 cover the deck stops being a field of separate cells and becomes
  // a continuous sheet with holes in it. Without this the storm scene keeps
  // showing blue between towering cumulus however high cloudCover is pushed.
  float sheet = linstep(0.78, 1.0, cov);
  shape = mix(shape, mix(shape, 1.0, 0.72), sheet) * grad;

  float density = saturate1(remap(shape, 1.0 - cf, 1.0, 0.0, 1.0)) * cf;
  if (density <= 0.0) return 0.0;

  if (detail) {
    vec3 dp = vec3(xz.x + uDetailOffset.x, alt, xz.y + uDetailOffset.y) * uDetailScale;
    vec3 d = texture(tCloudDetail, dp).rgb;
    float hf = d.r * 0.625 + d.g * 0.25 + d.b * 0.125;
    // Billows curl inward at the base and shred into wisps at the top.
    float mod2 = mix(hf, 1.0 - hf, saturate1(h * 5.0));
    density = saturate1(remap(density, mod2 * uErosion, 1.0, 0.0, 1.0));
  }

  return density * uDensityScale * mix(0.72, 1.35, wm.b);
}

/** Convert a planet-space point (km) to the world XZ / altitude the field wants. */
void planetToField(vec3 p, out vec2 wxz, out float alt){
  wxz = p.xz * 1000.0 + uFieldOffset;
  alt = (length(p) - RG) * 1000.0;
}

/** Density at a planet-space point, the form every march actually calls. */
float cloudDensityAt(vec3 p, bool detail, out float hFrac){
  vec2 wxz;
  float alt;
  planetToField(p, wxz, alt);
  return cloudDensity(wxz, alt, detail, hFrac);
}

/**
 * Entry/exit parameters of the ray through the layer shells. Returns false when
 * the ray misses the layer or is blocked by the planet first.
 */
bool layerSegment(vec3 pos, vec3 dir, float rB, float rT, out float t0, out float t1){
  float rc = length(pos);
  float tGround = raySphereNear(pos, dir, RG);
  if (rc < rB) {
    float tEnter = raySphereNear(pos, dir, rB);
    if (tEnter < 0.0) return false;
    if (tGround > 0.0 && tGround < tEnter) return false;
    float tExit = raySphereNear(pos, dir, rT);
    if (tExit < 0.0) return false;
    t0 = tEnter;
    t1 = tExit;
  } else if (rc < rT) {
    t0 = 0.0;
    float tB = raySphereNear(pos, dir, rB);
    float tT = raySphereNear(pos, dir, rT);
    t1 = tB > 0.0 ? min(tB, tT) : tT;
  } else {
    float tT = raySphereNear(pos, dir, rT);
    if (tT < 0.0) return false;
    t0 = tT;
    float tB = raySphereNear(pos, dir, rB);
    t1 = tB > 0.0 ? tB : raySphereFar(pos, dir, rT);
  }
  return t1 > t0;
}

/**
 * Dual-lobe Henyey-Greenstein. The forward lobe is the silver lining you get
 * looking toward the sun through a cloud edge; the small backward lobe keeps the
 * anti-solar side from going dead.
 */
float cloudPhase(float cosT, float ecc){
  return mix(phaseHG(cosT, 0.82 * ecc), phaseHG(cosT, -0.28 * ecc), 0.36);
}

/**
 * Cirrus: one analytic slab at CIRRUS_ALT_KM rather than a march. Ice cloud is
 * optically thin (tau well under 1), so a single Beer-Lambert slab carries
 * everything a march would and costs three texture fetches instead of forty.
 * Returns optical depth along the ray and writes the shell hit distance.
 */
float cirrusOpticalDepth(vec3 pos, vec3 dir, out float tHit){
  tHit = 0.0;
  if (uCirrusAmount <= 0.002) return 0.0;
  float rC = RG + CIRRUS_ALT_KM;
  if (length(pos) >= rC) return 0.0;
  float t = raySphereNear(pos, dir, rC);
  if (t <= 0.0) return 0.0;
  tHit = t;

  vec3 p = pos + dir * t;
  vec2 xz = p.xz * 1000.0 + uFieldOffset + uCirrusOffset;
  float ci = texture(tWeather, xz / (uWeatherExtent * CIRRUS_MAP_SCALE)).a;

  // One 3D fetch, sampled with a squashed vertical, gives the fibrous streaks
  // that separate cirrus from a flat alpha wash.
  vec3 dp = vec3(xz.x, p.y * 60.0, xz.y) * (uDetailScale * 0.22);
  float streak = texture(tCloudDetail, dp).g;
  ci = saturate1(remap(ci, 0.52 - uCirrusAmount * 0.5, 1.0, 0.0, 1.0));
  ci *= mix(0.45, 1.0, streak);

  // Slant path through a shell of finite thickness.
  float up = max(abs(normalize(p).y), 0.06);
  float path = CIRRUS_THICK_M / up;
  return CIRRUS_TAU * ci * uCirrusAmount * (path / CIRRUS_THICK_M);
}
#endif
`;
