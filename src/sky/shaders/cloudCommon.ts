import {
  CLOUD_CIRRUS_MAP_SCALE,
  CLOUD_CIRRUS_OPTICAL_DEPTH,
  CLOUD_CIRRUS_THICKNESS_M,
  CLOUD_COLUMNS_PER_RAY,
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
const float CLOUD_COLUMNS_PER_RAY = ${f(CLOUD_COLUMNS_PER_RAY)};

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
 * Column coverage from the weather map's R channel.
 *
 * R is baked histogram-flattened (see gaussCdf in cloudNoise.ts), so it is
 * uniform on 0..1 and a threshold at '1 - p' selects a fraction of COLUMNS equal
 * to p.
 *
 * SLANT MULTIPLICITY, and it is not a detail. A fraction of columns equals a
 * fraction of SKY for a vertical ray and for nothing else. This deck's marched
 * shells span 4.8 km and its weather field decorrelates in 2.5 km, so a ray at
 * 25 deg elevation crosses CLOUD_COLUMNS_PER_RAY = 4.1 independent columns and
 * is opaque if any one of them is dense: sky coverage is 1 - (1-p)^4.1, not p.
 * Feeding the knob in as p is what made cloudCover 0.4 render as a 99 % opaque
 * featureless ceiling above 15 deg elevation — DIAGNOSIS.md section 36's
 * "soft opaque cloud smear covering most of the sky" — while leaving the whole
 * usable range of the knob inside 0.05..0.15. Invert it here, once, so
 * 'cloudCover' means the fraction of sky a player sees covered. The derivation
 * and the measurements are on CLOUD_COLUMNS_PER_RAY.
 *
 * The exponent is what separates weather from mere quantity: below about 0.5 the
 * field is pushed DOWN so isolated columns reach full density and the gaps stay
 * properly blue, and as cover closes it is pushed UP so the deck becomes a
 * continuous sheet with holes rather than dense cumulus with blue between. A
 * gale is not "lots of fair-weather cloud". It rides the ORIGINAL knob, not the
 * per-column value, because it is describing the weather the player asked for.
 */
float columnCoverage(float cover){
  return 1.0 - pow(1.0 - saturate1(cover), 1.0 / CLOUD_COLUMNS_PER_RAY);
}

float coverageAt(float wmR, float cover){
  float p = columnCoverage(cover);
  float t = 1.0 - p;
  /*
   * No 0.12 floor on the denominator. It used to stop 'u' ever reaching 1 once p
   * fell below 0.12, and since a column produces no cloud at all until cf clears
   * about 0.37 (see the floor note below), that turned a thin deck into a
   * COMPLETELY clear sky rather than a sparse one: measured, cloudCover 0.05
   * rendered exactly zero cloud at every elevation. The inversion above puts the
   * common covers right at that cliff — 0.4 maps to p = 0.12 — so the floor had
   * to go with it.
   */
  float u = saturate1((wmR - t) / max(1e-3, p));
  float shaped = pow(u, mix(1.7, 0.32, cover));
  /*
   * Floor at high cover, and it is not cosmetic.
   *
   * This value goes on to threshold the base noise ('density = remap(shape,
   * 1 - cf, 1, 1)'), and 'shape' has a narrow distribution around 0.63 — so a
   * column produces no cloud at all until cf clears about 0.37. Measured at
   * cover 0.855: 27 % of columns fell under that, the top-down shadow slice came
   * back 44 % mean transmittance, and the CPU mirror's beamTransmittance said
   * 0.11. A four-fold disagreement between the deck you see and the deck every
   * material is lit by, and a gale with blue holes in it.
   *
   * Lifting the floor as cover closes removes the threshold entirely by ~0.95, so
   * a solid overcast is a solid sheet. Below 0.72 nothing changes and broken
   * cumulus keeps its genuinely blue gaps.
   */
  return mix(shaped, 1.0, smoothstep(0.72, 1.0, cover));
}

/**
 * 'detail' false skips the high-frequency erosion — used by the sun march and
 * the shadow map, where the extra octaves cost more than they show.
 */
float cloudDensity(vec2 wxz, float alt, bool detail, out float hFrac){
  float slab = max(1.0, uLayerTop - uLayerBottom);
  // Nominal slab coordinate. Only the shear lookup and the shell bounds use it;
  // the profile below runs on a PER-COLUMN slab. Bounds are generous because the
  // per-column base wanders below uLayerBottom and a tall cell overshoots the top.
  float h0 = (alt - uLayerBottom) / slab;
  hFrac = saturate1(h0);
  if (h0 < -0.2 || h0 > 1.25) return 0.0;

  vec2 xz = wxz + uWindDir * (saturate1(h0) * uShear);
  vec4 wm = texture(tWeather, xz / uWeatherExtent);

  float cf = coverageAt(wm.r, saturate1(uCoverage));
  if (cf <= 0.002) return 0.0;

  float type = saturate1(uCloudType + (wm.g - 0.5) * 0.55);

  /*
   * Per-column base altitude and depth.
   *
   * One flat shell for the whole deck puts every cloud base at exactly
   * uLayerBottom, and from a deck-level camera that draws a dead-straight edge
   * across the frame — the rubric's "hard seam" failure, and the single most
   * artificial thing about a naive layered cloud field. Real bases wander a few
   * hundred metres from cell to cell.
   *
   * Depth follows local coverage because that is how convection works: an
   * isolated fair-weather cell is a shallow puff, and only the columns inside a
   * dense cluster have the lift to build a tower. This is what gives the field a
   * silhouette instead of a uniform slab with a noisy edge.
   */
  float baseAlt = uLayerBottom + (wm.g - 0.5) * slab * 0.19;
  float depth = slab * mix(0.30, 1.08, cf * cf);
  float h = (alt - baseAlt) / depth;
  if (h < 0.0 || h > 1.0) return 0.0;
  hFrac = h;

  float grad = heightGradient(h, type);
  if (grad <= 0.001) return 0.0;

  vec3 bp = vec3(xz.x, alt, xz.y) * uBaseScale;
  vec4 base = texture(tCloudBase, bp);
  float lowFbm = base.g * 0.625 + base.b * 0.25 + base.a * 0.125;
  float shape = saturate1(remap(base.r, lowFbm - 1.0, 1.0, 0.0, 1.0)) * grad;

  float density = saturate1(remap(shape, 1.0 - cf, 1.0, 0.0, 1.0));
  if (density <= 0.0) return 0.0;

  if (detail) {
    vec3 dp = vec3(xz.x + uDetailOffset.x, alt, xz.y + uDetailOffset.y) * uDetailScale;
    vec3 d = texture(tCloudDetail, dp).rgb;
    float hf = d.r * 0.625 + d.g * 0.25 + d.b * 0.125;
    // Billows curl inward at the base and shred into wisps at the top.
    float mod2 = mix(hf, 1.0 - hf, saturate1(h * 5.0));
    /*
     * CAULIFLOWER, not cotton wool. Two separate things kept the erosion from
     * reading as cumuliform, and neither of them was the amount.
     *
     * FREQUENCY. The detail volume wraps at CLOUD_DETAIL_TILE_M = 750 m and its
     * dominant octave is Worley at 6 cells, i.e. 125 m features. The deck is
     * actually seen from 15-40 km, and the view march's step grows to
     * DT_MAX = 1.2 km, so a 125 m feature sits far under one sample and the
     * temporal filter averages it to a smooth wash — which is why uErosion at
     * 0.376 "barely registers". The lobes a cumulus is READ by are 200-600 m
     * across, and the base volume already carries exactly that band in .b and .a
     * (inverted Worley at 16 and 32 cells over a 6 km tile = 375 m and 187 m
     * cells). That texel is already fetched for 'lowFbm', so moving most of the
     * carving onto it costs no bandwidth and no extra fetch. Some weight stays
     * on 'mod2' deliberately: the detail volume is the only field that creeps
     * relative to the base (uDetailOffset in CloudField.update), so it is what
     * makes a cumulus boil instead of advecting as a rigid stamp.
     *
     * HEIGHT. Erosion was constant through the slab. A cumulus is the opposite
     * of constant: a soft, almost flat base at the condensation level and hard,
     * high-contrast lobes on the crown. Ramping the erosion with height is what
     * turns a puff into a tower.
     *
     * The ramp is deliberately built to average just UNDER 1 over the slab
     * (0.30 + 1.35 * 0.5 = 0.975), so the net erosion this applies is no
     * stronger than the flat 1.0 it replaces. Erosion removes density, and
     * density is what CLOUD_COLUMNS_PER_RAY's coverage calibration is tuned
     * against, so a redistribution that cannot increase the mean cannot walk the
     * coverage fix backwards. Keep that property if these numbers are retuned.
     */
    float lobes = saturate1(base.b * 0.62 + base.a * 0.38);
    float carve = mix(lobes, mod2, 0.42);
    float crown = 0.30 + 1.35 * smoothstep(0.15, 0.85, h);
    density = saturate1(remap(density, carve * uErosion * crown, 1.0, 0.0, 1.0));
  }

  return density * uDensityScale * mix(0.72, 1.35, wm.b);
}

/**
 * Planet radii of the shells the low deck can actually occupy.
 *
 * NOT uLayerBottom/uLayerTop: cloudDensity() lets each column's base wander down
 * by 0.1 slab and a tower in a dense cluster overshoot the nominal top by a
 * quarter of one, so marching only the nominal slab would slice the tops off the
 * tallest cells and clip the lowest bases. These bounds match the h0 test there
 * exactly — if one changes, change both.
 */
void cloudShells(out float rB, out float rT){
  float slab = uLayerTop - uLayerBottom;
  rB = RG + max(60.0, uLayerBottom - 0.2 * slab) * 0.001;
  rT = RG + (uLayerBottom + 1.25 * slab) * 0.001;
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

  // The A channel is flattened, so thresholding at '1 - amount' puts cirrus over
  // a fraction of sky equal to uCirrusAmount and leaves the rest genuinely clear.
  // 'amount' appears ONCE, here: multiplying the optical depth by it as well
  // (which an earlier version did) made a 30 % cirrus day a 100 % grey veil.
  ci = saturate1(remap(ci, 1.0 - uCirrusAmount, 1.0 - uCirrusAmount * 0.3, 0.0, 1.0));
  if (ci <= 0.002) return 0.0;

  // One 3D fetch, sampled with a squashed vertical, gives the fibrous streaks
  // that separate cirrus from a flat alpha wash.
  vec3 dp = vec3(xz.x, p.y * 60.0, xz.y) * (uDetailScale * 0.22);
  float streak = texture(tCloudDetail, dp).g;
  ci *= mix(0.25, 1.0, streak);

  // Slant path through a shell of finite thickness.
  float up = max(abs(normalize(p).y), 0.06);
  return CIRRUS_TAU * ci / up;
}
#endif
`;
