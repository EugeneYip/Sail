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
 * Depends on: GLSL.common, the atmosphere snippet (RG, raySphere*).
 */
export const CLOUD_COMMON_GLSL = /* glsl */ `
#ifndef SKY_CLOUD_COMMON
#define SKY_CLOUD_COMMON

uniform highp sampler3D tCloudBase;
uniform highp sampler3D tCloudDetail;
uniform sampler2D tWeather;
uniform vec2  uWeatherOffset;
uniform vec2  uDetailOffset;
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
  vec4 wm = texture(tWeather, (xz + uWeatherOffset) / uWeatherExtent);

  float type = saturate1(uCloudType + (wm.g - 0.5) * 0.55);
  float grad = heightGradient(h, type);
  if (grad <= 0.001) return 0.0;

  float cov = saturate1(uCoverage);
  float cf = saturate1(remap(wm.r, 1.0 - cov * 1.15, 1.0 - cov * 0.18, 0.0, 1.0));
  if (cf <= 0.001) return 0.0;

  vec3 bp = vec3(xz.x, alt, xz.y) * uBaseScale;
  vec4 base = texture(tCloudBase, bp);
  float lowFbm = base.g * 0.625 + base.b * 0.25 + base.a * 0.125;
  float shape = saturate1(remap(base.r, lowFbm - 1.0, 1.0, 0.0, 1.0)) * grad;

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
  wxz = p.xz * 1000.0;
  alt = (length(p) - RG) * 1000.0;
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
#endif
`;
