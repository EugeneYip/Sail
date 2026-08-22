import { GLSL } from '../../util/glsl';
import { SHARED_UNIFORM_DECL } from '../../core/SharedUniforms';
import { EARTH_RADIUS_M, MAX_EYE_ON_LIMB_M } from '../OceanMesh';

/**
 * The ocean surface material.
 *
 * Vertex: CDLOD-morphed clipmap, displaced by the cascades. A cascade is sampled
 * at the mip level its local cell size can carry, so the geometry is a
 * band-limited version of the wave field rather than a point-sampled one — no
 * displacement aliasing, and no energy lost at the low end either. The detail
 * that geometry drops comes back through the normal map, and the *variance* of
 * what even the normal map can no longer resolve is folded into roughness. That
 * last conversion is what stops distant water from sparkling.
 *
 * Fragment: Fresnel + a single GGX lobe whose width and normal crossfade from
 * "resolved microfacet" near the camera to "statistical slope distribution" far
 * away (the sun-glitter path), Beer–Lambert transmission through wave crests for
 * the jade backlight, a deep-ocean body colour, Jacobian-driven foam, and aerial
 * perspective into the sky's own horizon colour.
 *
 * All wave-field lookups use *wrapped-absolute* XZ (`uOceanOrigin`), see
 * `Ocean.ts` for why.
 */

/** GLSL ES 1.00 has no implicit int-to-float, so a whole number needs the point. */
const f = (n: number) => (Number.isInteger(n) ? n.toFixed(1) : String(n));

function cascadeDecls(n: number): string {
  let s = '';
  for (let i = 0; i < n; i++) {
    s += `uniform sampler2D uDisp${i};\nuniform sampler2D uDeriv${i};\n`;
  }
  return s;
}

export function surfaceShaders(
  cascades: number,
  hasWake = false,
): { vertexShader: string; fragmentShader: string } {
  let vertDisp = '';
  for (let i = 0; i < cascades; i++) {
    vertDisp += `
  {
    float w = 1.0 - smoothstep(uCascadeCellFade[${i}].x, uCascadeCellFade[${i}].y, effCell);
    if (w > 0.002) {
      vec2 uv = absXZ * uCascadeScale[${i}] + uCascadeHalfTexel[${i}];
      // Mipping a displacement map low-passes the wave field, so a cell never
      // tries to carry a wave shorter than itself.
      float lod = max(0.0, log2(effCell * uCascadeTexels[${i}]));
      vec4 d = textureLod(uDisp${i}, uv, lod);
      disp += w * vec3(d.y, d.x, d.z);
    }
  }`;
  }

  let fragSample = '';
  for (let i = 0; i < cascades; i++) {
    fragSample += `
  {
    vec2 uv = vAbs * uCascadeScale[${i}] + uCascadeHalfTexel[${i}];
    // EXPLICIT lod, from the pixel's WORLD footprint, not the hardware's
    // screen-space uv gradient. On a sea that fills the frame at grazing
    // incidence the anisotropy ratio runs into the hundreds, so a hardware
    // gradient picks a mip five or six levels too coarse and the wave field
    // flattens to a mirror — measured as a dead-flat surface in the waterline
    // and storm frames while the field itself still carried 6.6 m of relief.
    // It is also the only way the 'lostVar' bookkeeping below can be honest:
    // that term adds back exactly the slope variance THIS schedule removes, so
    // the filter and its roughness compensation have to be the same schedule.
    float lod = max(0.0, log2(pxWorld * uCascadeTexels[${i}]));
    vec4 d0 = textureLod(uDisp${i}, uv, lod);
    vec4 d1 = textureLod(uDeriv${i}, uv, lod);
    slope += vec2(d0.w, d1.x);
    jac   += vec3(d1.y, d1.z, d1.w);
    // Slope variance the pixel footprint can no longer resolve becomes
    // roughness instead of aliasing. Twice, because the footprint is not
    // square: 'pxWorld' across the view ray and 'pxAlong' along it.
    lostVar += uCascadeSlopeVar[${i}] *
      smoothstep(uCascadePxFade[${i}].x, uCascadePxFade[${i}].y, pxWorld);
    alongLost += uCascadeSlopeVar[${i}] *
      smoothstep(uCascadePxFade[${i}].x, uCascadePxFade[${i}].y, pxAlong);
  }`;
  }

  const wakeDecl = hasWake
    ? `uniform sampler2D uWake;
uniform mat3 uWakeMatrix;
uniform float uWakeStrength;
uniform vec3 uWakeAnchor;   // (shipX, shipZ, fadeRadius)

// The field is a torus, so a point further than half the wake window from the
// ship aliases onto the wake from the other side. Fade it out first.
float wakeFalloff(vec2 xz){
  return 1.0 - smoothstep(uWakeAnchor.z * 0.62, uWakeAnchor.z, distance(xz, uWakeAnchor.xy));
}`
    : '';

  // The wake field is a torus: uv = fract(matrix * vec3(worldX, worldZ, 1)).
  // R = persistent foam, G = height in metres, BA = world-space slope of it.
  const wakeVert = hasWake
    ? `
  {
    float wf = wakeFalloff(world) * uWakeStrength;
    if (wf > 0.001) {
      vec2 wuv = fract((uWakeMatrix * vec3(world, 1.0)).xy);
      disp.y += textureLod(uWake, wuv, 0.0).g * wf;
    }
  }`
    : '';

  const wakeFrag = hasWake
    ? `
  {
    float wf = wakeFalloff(P.xz) * uWakeStrength;
    if (wf > 0.001) {
      vec2 wuv = fract((uWakeMatrix * vec3(P.xz, 1.0)).xy);
      vec4 wk = texture2D(uWake, wuv);
      slope += wk.ba * wf;
      // ANYTHING THAT CANNOT BE WHITE MUST BE EXACTLY NOTHING.
      //
      // The divergent arms are a narrow ridge inside a broad Gaussian, so their
      // sub-visible tail spans a band tens of metres wide either side of the
      // cusp, and the persistent buffer's decay walks every value between the
      // peak and zero on its way out. Foam suppresses the water's specular, and
      // at golden hour the reflection it suppresses carries several hundred
      // times the body radiance — so a coverage of 0.03 is not invisible, it is
      // a broad DARK LANE ruled at the Kelvin half-angle. 'wake.ts' applies this
      // rule at the source for exactly this reason; the consumer has to apply it
      // too, because decay reintroduces the tail the source refused to write.
      wakeFoam = max(wk.r - 0.06, 0.0) * (1.0 / 0.94) * wf;
    }
  }`
    : '';

  const vertexShader = /* glsl */ `
precision highp float;
${SHARED_UNIFORM_DECL}
${cascadeDecls(cascades)}
${wakeDecl}
attribute vec2 aMeta;
uniform vec2  uOceanOrigin;
uniform float uCascadeScale[${cascades}];
uniform float uCascadeHalfTexel[${cascades}];
uniform float uCascadeTexels[${cascades}];
uniform vec2  uCascadeCellFade[${cascades}];
uniform float uGridM;
uniform float uMorphStart;

varying vec4 vWorldDist;
varying vec4 vAbsMisc;

void main(){
  float gridHalf = aMeta.x;
  float isSkirt  = aMeta.y;
  vec2 g = position.xz;

  // CDLOD morph, in grid units so it is scale independent: in the outer band an
  // odd vertex slides onto its even neighbour, which is exactly the coarser
  // level's vertex, so the shared edge is identical from both sides.
  float r = max(abs(g.x), abs(g.y)) / gridHalf;
  float morph = smoothstep(uMorphStart, 1.0, r) * (1.0 - isSkirt);
  g -= mod(g, 2.0) * morph;

  float cell = modelMatrix[0][0];
  vec4 wp = modelMatrix * vec4(g.x, 0.0, g.y, 1.0);
  vec2 world = wp.xz;
  vec2 absXZ = world + uOceanOrigin;

  // Chebyshev radius from the camera, because the clipmap rings are square: at
  // radius R the level in charge has cell size 2R/M, so deriving the cascade
  // weights from the radius rather than from this mesh's own cell size keeps
  // them continuous across a level boundary. Anything discontinuous there is a
  // crack in the surface.
  vec2 rel = world - uCameraPos.xz;
  float cheb = max(abs(rel.x), abs(rel.y));
  float effCell = max(cell, 2.0 * cheb / uGridM);

  vec3 disp = vec3(0.0);
  ${vertDisp}
  ${wakeVert}

  /*
   * Earth curvature, and the reason the horizon is a line at all.
   *
   * The sea falls away as 'd^2/(2R)' from the eye's own nadir, which puts the
   * silhouette at the tangent distance 'sqrt(2*R*h)' — 18.0 km from a 25.5 m eye,
   * against the clipmap's 49.15 km reach — instead of at the mesh's outer edge.
   * Without it the last visible sea was 2.7x past the true horizon, the aerial
   * perspective had saturated it completely, and the sea/sky luminance step
   * measured 2.0 8-bit units spread over five rows: no horizon. With it the step
   * is 3.7 units in one row, and the pale cyan hairline the probe's elevation
   * lift leaves behind (see 'oceanInscatter') goes with it, because the rows that
   * carried it are sky now. Measured in 'orbit' with the sim clock pinned; at 8 m
   * and 2.5 m eyes it is a 1 px and a 0.8 px change and reads the same, which is
   * right — the defect scaled with eye height.
   *
   * Anchored on the CAMERA, not on the world origin, because 'skyRender.ts' puts
   * the earth's limb at 'horizonCos = -sqrt(r*r - RG*RG)/r' from this same eye
   * height and the two silhouettes have to be the same line. The price is paid
   * near the camera and it is tiny: 0.8 mm at 100 m, 1 mm under the orbit camera's
   * ship. The CPU wave sampler, the wake field and the near field need no matching
   * change — but anything ELSE that sits at y = 0 a long way off does, because it
   * no longer meets the water. Unchanged, a hull at Vessels' 12.5 km retire range
   * floats 1.2 px and Boston at its 46 km one floats 4.5 px. See DIAGNOSIS; the
   * drop to apply is this one, with d measured from the camera.
   */
  const float EARTH_R = ${f(EARTH_RADIUS_M)};
  float dHoriz = length(rel);
  float drop = dHoriz * dHoriz / (2.0 * EARTH_R);

  /*
   * The skirt's outer edge still exists to stop a sliver of sky appearing under a
   * finite sea, and this is the same expression it always was.
   *
   * A flat sea's horizon is at eye level, so the old form lifted the edge by
   * 'max(uCameraPos.y, 0.0)' — worth a measured 1.16 px at the orbit camera, not
   * the "sub-pixel" the comment used to claim. A curved sea's horizon is
   * 'sqrt(2h/R)' below eye level, and the lift that lands the edge exactly on it
   * is '(sqrt(h) - D*inversesqrt(2R))^2' — which IS that same 'h' as R goes to
   * infinity, so this generalises the old hack rather than replacing it.
   *
   * Clamped at zero, so it is identically zero whenever the mesh already reaches
   * past the tangent point: every eye up to ${MAX_EYE_ON_LIMB_M.toFixed(0)} m, which is every
   * camera but the debug fly-cam. Above that it reappears, and it still
   * cannot lift any part of the sea above the limb, because the limb's elevation
   * is the thing it solves for. Measured over 860 columns of 'orbit': zero
   * slivers, and zero columns where the curved sea sits above the flat one.
   */
  float lift = max(sqrt(max(uCameraPos.y, 0.0)) - dHoriz * inversesqrt(2.0 * EARTH_R), 0.0);
  float skirtRise = isSkirt * smoothstep(0.80, 1.0, r) * lift * lift;

  vec3 pos = vec3(world.x + disp.x, disp.y + skirtRise - drop, world.y + disp.z);
  float dist = length(pos - uCameraPos);

  vWorldDist = vec4(pos, dist);
  vAbsMisc = vec4(absXZ + disp.xz, disp.y, isSkirt);

  gl_Position = projectionMatrix * viewMatrix * vec4(pos, 1.0);
}
`;

  const fragmentShader = /* glsl */ `
precision highp float;
${GLSL.common}
${GLSL.brdf}
${GLSL.noise2d}
${SHARED_UNIFORM_DECL}
${cascadeDecls(cascades)}
${wakeDecl}
uniform float uCascadeScale[${cascades}];
uniform float uCascadeHalfTexel[${cascades}];
uniform float uCascadeTexels[${cascades}];
uniform float uCascadeSlopeVar[${cascades}];
uniform vec2  uCascadePxFade[${cascades}];

uniform sampler2D uFoam;
uniform sampler2D uFoamDetail;
uniform sampler2D uReflection;
uniform sampler2D uEnvMap;      // sky's equirect radiance probe, sun disc excluded
uniform float uHasEnv;
uniform vec4  uFoamWindow;      // (originX, originZ, 1/size, unused)
uniform vec2  uResolution;
uniform float uPixelAngle;      // world metres per pixel, per metre of distance
uniform float uSlopeRms;        // TRUE rms slope of the sea, capillaries included
uniform float uSlopeVarTail;    // slope variance above the finest cascade's Nyquist
uniform float uWaveHeight;
uniform float uHasReflection;
uniform float uFoamAmount;
uniform float uFoamThreshold;   // fold below which a crest is breaking
uniform float uFoamSoftness;    // width of the fold ramp, in units of fold
uniform float uFoamCover;       // Monahan whitecap coverage for this wind, 0..1

varying vec4 vWorldDist;
varying vec4 vAbsMisc;

/* Deep clear ocean, per channel.
 *
 * EXTINCTION is the diffuse attenuation coefficient Kd, 1/m. Red is gone within
 * about a metre of water, green lasts eleven, blue thirty. That split is the
 * entire reason the sea is blue and a thin backlit crest is jade, so it is worth
 * carrying properly rather than tinting a grey.
 *
 * DEEP_ALBEDO is the irradiance reflectance of an infinitely deep column,
 * 0.33*bb/a for seawater with a little chlorophyll: 5% of the downwelling light
 * comes back in blue and essentially none in red. Anything less saturated than
 * this reads as a swimming pool, which is exactly the failure this replaces. */
const vec3 EXTINCTION   = vec3(0.90, 0.090, 0.033);
const vec3 DEEP_ALBEDO  = vec3(0.0011, 0.0165, 0.0520);
/* Scattering albedo for the light that makes it *through* a crest. Higher than
 * DEEP_ALBEDO because a single short path is single-scatter dominated. */
const vec3 SSS_ALBEDO   = vec3(0.16, 0.42, 0.36);
/* Whitecap albedo. Measurements run 0.22-0.55 depending on bubble depth. */
const float FOAM_ALBEDO = 0.38;

/** three's equirect convention: u = atan(z,x)/TAU + 0.5, v = asin(y)/PI + 0.5. */
vec2 lwEquirectUv(vec3 d){
  return vec2(atan(d.z, d.x) * 0.15915494 + 0.5, asin(clamp(d.y, -1.0, 1.0)) * INV_PI + 0.5);
}

/**
 * Smooth analytic sky radiance. Used for the distance haze, as the wide-lobe
 * blur target for the reflection, and as the whole reflection when the sky has
 * not published a probe. Driven entirely by the shared sky uniforms so the
 * water's horizon lands on the real sky's horizon and the join disappears.
 *
 * Continuous and undarkened at h == 0: any discontinuity there shows up as a
 * hard line along the horizon, which the rubric fails outright.
 */
vec3 oceanSky(vec3 dir){
  float h = clamp(dir.y, -1.0, 1.0);
  vec3 col = mix(uFogColor, uSkyColor, pow(saturate1(h), 0.42));
  float cs = max(dot(dir, uSunDirection), 0.0);
  col += uSunColor * uSunIntensity * 0.010 * pow(cs, 10.0);
  // Rays that look under the horizon see haze, not sky. Reaches 1.0 exactly at
  // h == 0 so the horizon row is the sky's own horizon radiance.
  col = mix(uFogColor * 0.62, col, saturate1(h * 12.0 + 1.0));
  return col;
}

/**
 * Reflected radiance. The sky's probe carries the clouds, which is most of what
 * makes water look like water; a single tap of it is only right for a mirror, so
 * it is blurred toward the smooth gradient in proportion to how wide the facet
 * distribution is. The probe excludes the sun disc — that arrives as the GGX
 * lobe below.
 */
vec3 oceanReflection(vec3 dir, float alpha){
  vec3 wide = oceanSky(dir);
  if (uHasEnv < 0.5) return wide;
  vec3 probe = texture2D(uEnvMap, lwEquirectUv(dir)).rgb;
  // The blur target is a two-colour ramp, so this rate decides how much real sky
  // survives. Under overcast 'uSkyColor' and 'uFogColor' are within 10% of each
  // other, which makes 'wide' a flat grey with no direction in it at all —
  // measured 0.284/0.272/0.258 against 0.303/0.320/0.383 in the gale scene. At
  // the old 1.7 a routine alpha of 0.3 replaced 51% of the reflection with that
  // flat grey and the sea lost its last normal-dependent term. The probe is
  // already a prefiltered radiance probe, so blurring it this hard was double
  // filtering anyway.
  return mix(probe, wide, saturate1(alpha * 0.95));
}

/**
 * Directional reflectance of a ROUGH water surface.
 *
 * This is the single term that decides whether the sea reads as deep water or as
 * a sheet of pale sky, because the two are not close: measured at golden hour the
 * reflected horizon radiance is 783x the deep-water body radiance, so even a 2%
 * reflectance still puts 16x more sky than water in the pixel. Smooth-surface
 * Schlick goes to 1.0 at grazing, and a sea fills most of the frame at grazing,
 * so with Schlick alone the water can never show its own colour at any hour.
 *
 * Two corrections, both standard and both physical:
 *   - f90 is capped at (1 - roughness). A rough facet distribution has no mirror
 *     direction to reflect into at the horizon.
 *   - Smith G1 masking. At grazing, most facets oriented to send the sky to the
 *     eye are hidden behind their own neighbours. This is the directional albedo
 *     of the specular lobe approximated by its masking term alone, which for
 *     f0 = 0.02 is within a few percent of the split-sum integral.
 *
 * Both vanish at normal incidence, so the near field is untouched.
 */
float oceanReflectance(float NoV, float a){
  float f90 = max(1.0 - a, 0.02);
  float F = 0.02 + (f90 - 0.02) * pow5(1.0 - NoV);
  float a2 = a * a;
  float G1 = 2.0 * NoV / max(NoV + sqrt(a2 + (1.0 - a2) * NoV * NoV), 1e-4);
  return F * G1;
}

/**
 * In-scattered radiance for a near-horizontal path over the sea.
 *
 * The analytic ramp is one colour for the entire horizon at every azimuth, so
 * using it for the distance haze paints the whole far sea a single hue — at
 * golden hour that is a uniformly orange sea with no blue anywhere in frame, and
 * it also guarantees the water's horizon row cannot match the sky's own, which is
 * the hard-seam failure. The probe has the real azimuthal variation, so sample it
 * along the view azimuth, just above the horizon: a horizontal path is lit by the
 * sky around it, not by whatever lies below the horizon in the probe.
 */
vec3 oceanInscatter(vec3 fwd){
  /* HALF A PROBE TEXEL, NOT TWO DEGREES.
   *
   * The lift exists so the tap cannot pick up whatever the probe holds below the
   * horizon, and it has to be as small as that allows: the probe is a 256x128
   * equirect with v = asin(y)/PI + 0.5, so one texel is 1.41 deg of elevation,
   * and the old 0.035 rad was 1.42 texels UP. The sea's last rows therefore
   * carried sky from two degrees higher than the sky immediately above them,
   * which near the horizon is where the atmosphere's gradient is steepest.
   * Measured in 'orbit', x 0-520: the sea's top row ran B-R 32.2 against the
   * sky's 17.8 — a pure-chroma hairline, equal in luminance and 14 units bluer,
   * and the 'pale cyan hairline at y 573-576' of DIAGNOSIS §62.
   *
   * 0.0123 is sin(PI * 0.5 / 128), i.e. exactly the centre of the first texel
   * above the horizon: the lowest tap whose bilinear footprint contains no
   * below-horizon sample. It halves the excess to B-R 25.5 with the luminance
   * still continuous. Lower is worse and was measured: 0.0060 puts the row 5.4
   * BELOW the sky and 0.0 puts it 13 below, both hard dark lines, which is the
   * contamination the lift is for. The residual is the probe texel's own 1.41
   * deg average being bluer than the 0.02 deg row of sky above it, and closing
   * it needs elevation resolution near the horizon that a 128-row probe has not
   * got.
   */
  vec3 lifted = normalize(vec3(fwd.x, 0.0, fwd.z) + vec3(0.0, 0.0123, 0.0));
  vec3 wide = oceanSky(lifted);
  if (uHasEnv < 0.5) return wide;
  vec3 probe = texture2D(uEnvMap, lwEquirectUv(lifted)).rgb;
  // Keep a little of the analytic term: it carries the sun's forward scatter,
  // which the probe deliberately excludes.
  return mix(probe, wide, 0.25);
}

/** Rain ring ripples: hashed drop centres, each a decaying travelling ring. */
vec3 rainRipple(vec2 p, float amount){
  vec2 acc = vec2(0.0);
  for (int o = 0; o < 2; o++) {
    float sc = o == 0 ? 1.6 : 3.7;
    vec2 q = p * sc;
    vec2 id = floor(q);
    vec2 f = fract(q) - 0.5;
    for (int j = -1; j <= 1; j++)
    for (int i = -1; i <= 1; i++) {
      vec2 o2 = vec2(float(i), float(j));
      vec3 h = hash32(id + o2);
      // Each cell fires on its own cycle.
      float t = fract(uTime * 1.35 + h.z);
      vec2 c = o2 + h.xy - 0.5 - f;
      float d = length(c);
      float ring = sin((d * 26.0 - t * 34.0)) * exp(-d * 7.0) * (1.0 - t) * step(d * 1.4, t + 0.05);
      acc += normalize(c + 1e-4) * ring;
    }
  }
  return vec3(acc.x, 0.0, acc.y) * amount * 0.055;
}

void main(){
  vec3 P = vWorldDist.xyz;
  float dist = vWorldDist.w;
  vec2 vAbs = vAbsMisc.xy;
  float dispY = vAbsMisc.z;
  float isSkirt = vAbsMisc.w;

  vec3 V = normalize(uCameraPos - P);
  float pxWorld = max(dist * uPixelAngle, 1e-3);
  // At grazing incidence the pixel's world footprint is 'pxWorld' ACROSS the
  // view ray and this ALONG it -- 3.2 m by 514 m at four kilometres with the
  // eye 25.6 m up. Every schedule below that asks "can the pixel still resolve
  // this" has to be asked twice, once per axis.
  float pxAlong = pxWorld / max(abs(V.y), 1e-3);

  vec2 slope = vec2(0.0);
  vec3 jac = vec3(0.0);
  float lostVar = 0.0;
  float alongLost = 0.0;
  float wakeFoam = 0.0;
  ${fragSample}
  ${wakeFrag}

  if (isSkirt > 0.5) {
    slope = vec2(0.0); jac = vec3(0.0);
    lostVar = uSlopeRms * uSlopeRms; alongLost = lostVar;
  }

  // Everything above the finest cascade's Nyquist is slope variance that no
  // resolution would have rendered, so it is roughness at every distance.
  lostVar += uSlopeVarTail;
  alongLost += uSlopeVarTail;

  // CAPILLARY RIPPLE. The line above is right for anything the pixel cannot
  // resolve — but within a few tens of metres the pixel CAN resolve part of that
  // tail, and rolling ALL of it into roughness is why the near field rendered as
  // smooth glass between the cascade's waves. Cox & Munk's total mean-square
  // slope is dominated by the centimetre ripple no FFT grid carries, so
  // 'uSlopeVarTail' is large (0.045 at a fresh breeze, i.e. 0.21 rms of slope
  // going begging).
  //
  // Only the part of the tail that is actually resolvable comes back. The tail
  // spans the finest cascade's 25 cm down to 1.7 mm capillaries — 7.2 octaves —
  // and a slope spectrum is roughly flat per octave, so the 2.6 octaves between
  // 25 cm and 4 cm are RIP_BAND of it. Whatever is restored here is subtracted
  // from 'lostVar' below, or the same water is counted twice: once as visible
  // slope and once as the roughness that exists precisely because it is not.
  float ripRes = 1.0 - smoothstep(0.020, 0.130, pxWorld);
  if (ripRes > 0.004) {
    const float RIP_BAND = 0.35;
    // Measured rms of |d noise2 / d p| per axis, for the exact noise2 in
    // src/util/glsl.ts: 0.8828 (200k samples, central differences). Written as a
    // measurement so the amplitude below is a conversion and not a taste knob.
    const float RIP_GRAD = 0.8828;
    float restore = uSlopeVarTail * RIP_BAND * ripRes;
    // Two octaves sharing the slope variance equally, so each carries
    // restore/2 of the total and restore/4 per axis.
    float amp = sqrt(restore * 0.5) / (RIP_GRAD * 1.41421356);
    // Drift with the wind-driven surface layer rather than sitting still in
    // world space: ~3% of wind speed is the classic surface drift.
    vec2 rp = vAbs + uWind.xz * (uTime * 0.03);
    slope += (noise2d_d(rp * 2.2).yz + noise2d_d(rp * 5.7 + 17.3).yz) * amp;
    lostVar = max(lostVar - restore, 0.0);
    // The ripple goes into 'slope' on both axes, so the along-ray books have to
    // credit it too -- but only as far as the along-ray footprint reaches. At
    // 160 m that footprint is 0.8 m long and a 25 cm ripple is already gone.
    alongLost = max(alongLost - uSlopeVarTail * RIP_BAND *
      (1.0 - smoothstep(0.020, 0.130, pxAlong)), 0.0);
  }

  if (uWetness > 0.01) slope += rainRipple(vAbs, uWetness).xz;

  // Normal of the *displaced* surface: with horizontal displacement the height
  // gradient alone is wrong, the full Jacobian is needed.
  float jxx = 1.0 + jac.x;
  float jzz = 1.0 + jac.y;
  float jxz = jac.z;
  vec3 N = normalize(vec3(
    jxz * slope.y - slope.x * jzz,
    max(jxx * jzz - jxz * jxz, 0.02),
    slope.x * jxz - slope.y * jxx));

  /* THE LOW-FREQUENCY NORMAL IS ANISOTROPIC, BECAUSE THE FOOTPRINT IS.
   *
   * 'Nlow' is what both specular paths below blend toward: the normal whose
   * slope the pixel can still PLACE, as opposed to the slope it can only own as
   * roughness. It used to be cascade 0 alone -- the 0.5-2 km swell -- and that
   * is why the far field died. Cascade 0 holds 3.6% of the slope variance the
   * footprint still carries at 4 km, and its 32 m texel spans nineteen pixels
   * there, so it can produce a gradient down the screen and nothing at all
   * across it: per-row mean |dL/dx| over x 0-500 in 'orbit' read 1.99-2.19 from
   * the horizon to y 660, which is the dither's own floor (DIAGNOSIS §67).
   *
   * The fix is not "use the whole slope" -- that is the same point sample the
   * macro blend below exists to reject, and it is measured: it lifts |dL/dx| by
   * 0.39 and lifts the temporal std of the per-row band signal beyond 600 m from
   * 0.09-0.25 to 0.29-0.41, i.e. it buys far-field detail by handing §17C's
   * flickering streaks back.
   *
   * It is that the footprint is 3 m by 514 m, so the two axes have different
   * answers. Decompose the slope along the horizontal view direction and across
   * it: dot(N, V) is (V.y - sAlong) to first order and the ACROSS component
   * does not enter it at all, so the along axis is exactly the one that
   * rectifies dot(N, V) negative and flickers, and the across axis is exactly
   * the one whose detail the pixel can hold. Keep the across component whole,
   * and cut the along component to the rms the along-ray footprint still
   * carries -- the same 'lostVar' schedule, asked at 'pxAlong'.
   */
  float slopeVarTotal = max(uSlopeRms * uSlopeRms, 1e-6);
  float carried = max(slopeVarTotal - lostVar, 1e-6);
  // Fraction of the along-axis slope RMS that survives the along-ray footprint.
  // 1 near the camera (the footprint is square there), 0 past ~900 m, where the
  // footprint is longer than every cascade's texel and there is no along-ray
  // placement left to render.
  float kAlong = sqrt(clamp(max(slopeVarTotal - alongLost, 0.0) / carried, 0.0, 1.0));
  vec2 vDir = V.xz / max(length(V.xz), 1e-5);
  vec2 lowSlope = slope - vDir * (dot(slope, vDir) * (1.0 - kAlong));
  vec3 Nlow = normalize(vec3(-lowSlope.x, 1.0, -lowSlope.y));

  float fold = jxx * jzz - jxz * jxz;

  /* ---- foam -------------------------------------------------------- */
  // Persistent foam lives in a camera-following window; outside it (and across
  // its edge) fall back to the instantaneous fold mask so distant whitecaps
  // still appear. Feathering the edge is what keeps the window from reading as
  // a square on the water.
  vec2 fw = (vAbs - uFoamWindow.xy) * uFoamWindow.z + 0.5;
  vec2 fe = min(fw, 1.0 - fw);
  float inWindow = smoothstep(0.0, 0.05, min(fe.x, fe.y));
  float persistent = texture2D(uFoam, clamp(fw, 0.0, 1.0)).r;
  // The Jacobian says WHERE the surface is breaking; Monahan's coverage law says
  // HOW MUCH of it should be. A fixed fold threshold ties the two together only
  // at one wind speed: measured, it gave a full gale 2.3% whitecap coverage where
  // Monahan wants ~15%, so a storm had no whitecaps at all. Moving the threshold
  // with the coverage is what makes the fold mask agree with the statistic.
  //
  // The ramp width has to match the width of the fold DISTRIBUTION, not be a
  // constant. Measured over a 500 m grid in the gale scene the fold histogram
  // runs 0.5 to 1.4 with the bulk inside 0.15 of 1.0, and 18% of the surface
  // sits below the 0.89 threshold — which is what Monahan asks for. But at the
  // old fixed slope of 2.4 that 18% was handed an opacity of only 0.05 to 0.15,
  // and the breakup field below subtracts up to 0.21, so every whitecap in a
  // full gale was erased before it was drawn. Dividing by a width that tracks
  // the sea state is what turns the same selection into visible foam.
  float instant = saturate1((uFoamThreshold - fold) / uFoamSoftness) * uFoamAmount;
  // The persistent buffer ADDS history; it must never subtract from the live fold
  // mask. Damping 'instant' to 0.45 inside the window meant that whenever the
  // buffer was empty the near field got less than half the foam the far field
  // got, across the one boundary where that is most visible — and at a fresh
  // breeze the buffer was empty every time, because Foam.ts was thresholding
  // below the whole fold distribution.
  float cover = max(instant, persistent * inWindow);
  // The wake channel is capped at 0.78 by contract and consumers amplify it.
  // 0.88 puts the froth band hugging the topsides at 0.69 COVERAGE — a band that
  // is two-thirds solid and torn at its edges, which is what a hull at speed
  // carries. Under the old amplify-and-clamp form the same 0.78 saturated to a
  // flat 1.0 across the whole footprint, so the number could not be raised.
  cover = max(cover, wakeFoam * 0.88);

  // FAR-FIELD WHITECAPS. The Jacobian says WHERE the surface is breaking, and it
  // can only say it while the displacement is still resolved: the explicit LOD
  // above mips the cascades by pixel footprint, which drives 'fold' to exactly
  // 1.0 and 'instant' to 0. Past a few hundred metres a full gale therefore
  // rendered with no whitecaps at all while the near field had 18% — and the
  // horizon of a storm with no white on it is the single loudest tell in the
  // frame. The whitecap STATISTIC does not change with distance, only our
  // ability to say where, so wherever the fold has gone sub-texel the coverage
  // is handed to Monahan's law and the breakup field below decides placement.
  float foldLive = saturate1(carried / slopeVarTotal * 3.3);
  cover = max(cover, uFoamCover * (1.0 - foldLive));

  /* COVERAGE IS A THRESHOLD ON NOISE, NOT A TINT.
   *
   * This is the fix for the near-field foam plate, and it is one mechanism for
   * three separate reported defects.
   *
   * What was here subtracted a zero-mean noise field from the coverage and
   * multiplied by 1.7. That form cannot produce foam. Integrate it over a
   * uniform breakup field and a coverage of 0.18 renders a MEAN ALPHA OF 0.31
   * spread across the whole footprint: 100% of the area goes a third white
   * instead of 18% of it going white. A uniform partial wash bounded by a smooth
   * contour is a pale plate — and the wake field spans 1024 m over its texture,
   * so its own envelope carries nothing finer than a metre and there was nothing
   * else in the pixel to break it up. The same integral at coverage ZERO returns
   * 0.089, so the form also laid a 9% white haze over the entire open sea.
   *
   * The replacement thresholds a histogram-FLATTENED field (see
   * 'textures.ts::flatten'). For a field uniform on 0..1,
   * E[linstep(t - w, t + w, d)] = 1 - t at ANY ramp width, and any zero-mean
   * perturbation of t leaves that expectation untouched. So the boundary can be
   * torn with as much high-frequency detail as the pixel can resolve while the
   * AREA stays exactly the coverage the physics asked for: 0.18 renders as 18%
   * of the area at full brightness, which is foam, and 0 renders as nothing.
   *
   * Four octaves, 24 m down to 43 cm — feature size is an eighth of the tile, so
   * 3.0 m, 0.81 m, 0.21 m and 5.3 cm. Each is rotated and drifts at its own
   * rate, so the visible repeat is the beat of four periods rather than the
   * shortest of them (water tiling is an automatic rubric failure) and the froth
   * churns instead of sliding under the hull as wallpaper.
   */
  vec2 dr = uWind.xz * (uTime * 0.03);
  vec2 uv0 = (vAbs + dr) * 0.041 + vec2(0.37, 0.11);
  vec2 uv1 = rot2(0.91) * ((vAbs + dr * 1.06) * 0.154);
  vec2 uv2 = rot2(2.13) * ((vAbs + dr * 1.14) * 0.60) + vec2(0.62, 0.29);
  vec4 f0 = texture2D(uFoamDetail, uv0);
  vec4 f1 = texture2D(uFoamDetail, uv1);
  vec4 f2 = texture2D(uFoamDetail, uv2);
  // An octave is worth READING while the pixel footprint is smaller than its
  // features. Note that the perturbations are self-nullifying and therefore
  // cannot be got wrong: a flattened channel mips toward its mean of 0.5, so
  // '(tap - 0.5)' fades to zero on its own as the octave goes sub-pixel. r2 and
  // r3 are purely there to skip the tap, and being generous with them is safe.
  float r2 = 1.0 - smoothstep(0.070, 0.320, pxWorld);
  float r3 = 1.0 - smoothstep(0.016, 0.080, pxWorld);
  // r1 IS NOT in that category and its schedule is load bearing. Both decision
  // taps are flattened, so a crossfade between them is uniform at either end —
  // but if the fine one is still weighted after it has mipped to a constant 0.5
  // then 'decide' becomes a constant too, and a threshold against a constant is
  // a BINARY decision that paints or clears whole regions at once. So r1 has to
  // reach zero while f1's 0.81 m features are still a couple of pixels across
  // (0.42 is ~210 m at a 900-line viewport), handing the decision to f0's 3 m
  // features, which stay resolved to about a kilometre.
  float r1 = 1.0 - smoothstep(0.13, 0.42, pxWorld);
  // AND THE CROSSFADE ITSELF HAS TO BE VARIANCE PRESERVING. mix() of two
  // INDEPENDENT uniform fields is narrower than uniform — its variance is
  // (r^2 + (1-r)^2)/12, so at r = 0.5 the sd is 0.204 against uniform's 0.289 —
  // and a narrower field cannot reach an extreme threshold, which loses coverage
  // exactly where coverage is low. Measured over 8100 samples at 100-175 m: the
  // plain mix rendered 0.110 against a requested 0.18, a 39% shortfall, and
  // rescaling the deviation back to unit variance brings it to 0.155. This is
  // the largest single error left in the chain, so do not simplify it away.
  float mixNorm = inversesqrt(r1 * r1 + (1.0 - r1) * (1.0 - r1));
  float decide = saturate1(0.5 + (mix(f0.a, f1.a, r1) - 0.5) * mixNorm);
  // THE PERTURBATION MUST VANISH AT BOTH ENDS OF THE COVERAGE RANGE. At coverage
  // 0 a negative excursion still opens the threshold and paints foam on clear
  // water; at coverage 1 a positive one punches holes in solid froth. Scaling by
  // 2*min(c, 1-c) kills both and leaves the expectation exactly c, because the
  // scale factor depends only on the coverage and not on the noise.
  float bite = min(cover, 1.0 - cover) * 2.0;
  float thr = 1.0 - cover
            + bite * ((f0.r - 0.5) * 0.60
                    + (f2.a - 0.5) * 0.84 * r2);
  vec2 bump = vec2(f1.g - 0.5, f1.b - 0.5) + vec2(f2.g - 0.5, f2.b - 0.5) * r2 * 1.3;
  if (r3 > 0.004) {
    // The only tap with a gradient steep enough to tear the boundary at the
    // PIXEL scale with the camera at the rail, which is the range this is judged
    // at. Branch is coherent — it is a function of distance alone.
    vec2 uv3 = rot2(3.71) * ((vAbs + dr * 1.24) * 2.34) + vec2(0.19, 0.83);
    vec4 f3 = texture2D(uFoamDetail, uv3);
    thr += bite * (f3.a - 0.5) * 0.72 * r3;
    bump += vec2(f3.g - 0.5, f3.b - 0.5) * r3 * 1.5;
  }
  // The ramp has to widen as the decision field's own contrast mips away, or a
  // flattened field at a kilometre turns the coverage decision into a binary one
  // about 0.5 and the whole far sea goes white. At w = 0.5 the linstep IS the
  // coverage, which is the correct answer for a whitecap that is sub-pixel.
  float wThr = mix(0.05, 0.5, smoothstep(1.2, 3.5, pxWorld));
  // WIDEN THE RAMP WHERE THE WAKE IS THE ONLY THING SUPPLYING COVERAGE.
  //
  // Measured in the near field: 'cover' before the wake is injected is 0.003 to
  // 0.014 out to 400 px, so alongside the hull the wake is the SOLE source of
  // coverage and the mask is shaped by nothing but the wake's own metre-scale
  // gradient. With the ramp at its 0.05 floor the margin (decide - thr)/wThr
  // reads 2.4 to 2.6 across the froth band, so the linstep CLAMPS: every spatial
  // structure in 'decide' is discarded and the band renders as a featureless
  // plate, ruled where the margin sweeps the narrow window. The same narrow ramp
  // is why the froth beyond it crazes into hard islands instead of grading.
  //
  // Widening is the one knob that is free here: E[linstep(t - w, t + w, d)] is
  // 1 - t at ANY width for zero-mean d, and 'thr' tracks 1 - cover to within 0.05
  // in every band, so the construction above is intact and the MEAN coverage does
  // not move. What changes is that the decision stops clamping, so the froth
  // grades instead of switching.
  //
  // Keyed to the WAKE's coverage, not the total, so natural whitecaps keep the
  // shipped ramp: a gale's own 'cover' is around 0.15 and must still tear.
  wThr = max(wThr, 0.05 + 0.42 * smoothstep(0.20, 0.62, wakeFoam * 0.88));
  float foam = linstep(thr - wThr, thr + wThr, decide);
  foam *= 1.0 - smoothstep(4000.0, 14000.0, dist) * 0.6;
  // Bubble relief, at the two or three scales the pixel can carry, and only
  // where there IS foam — this is the raft's own surface, not the water's, so a
  // binary coverage mask means the froth is bumpy and the water beside it is
  // not. G/B carry the gradient of the (flattened) raft height at sd 0.092
  // measured, so three octaves at these weights give an rms slope of 0.23 on
  // the froth: a bubble raft is bumpy, but it is not a random normal. The clamp
  // bounds the rare tail rather than letting it invert N.
  vec2 bumpC = clamp(bump, vec2(-0.9), vec2(0.9));
  N = normalize(N + vec3(bumpC.x, 0.0, bumpC.y) * foam * 1.1);

  /* ---- specular ---------------------------------------------------- */
  // Two regimes in one lobe: near the camera the normal map really does carry
  // the microfacets, far away it cannot, so widen to the statistical slope
  // distribution (alpha = sqrt(2)*sigma) and use the low-frequency normal. This
  // is the sun-glitter path, and doing it this way is what removes the sparkle.
  // GGX alpha from a slope distribution is sqrt(2 * per-axis variance), and
  // lostVar/uSlopeRms^2 are the total over both axes, so alpha is their sqrt.
  // Getting the factor of root 2 wrong here spreads the sun over the whole sea
  // as a flat white wash instead of a glitter lobe.
  //
  // The wide end used to be the TOTAL rms, which is right only if 'Nlow' carries
  // no slope at all -- true to within 3.6% while it was cascade 0, not true of
  // the anisotropic 'Nlow' above, which keeps the whole across-ray half. Add
  // back what the blend actually removes and nothing else: see 'alphaR' below
  // for the derivation, this is the same expression at the sun lobe's own blend
  // weight. It lands within 2% of uSlopeRms at sea state 3-7 -- the tail is 47%
  // to 86% of the total variance and no blend can reach it -- so this is a
  // correctness statement, not a visible change.
  float glit = smoothstep(45.0, 850.0, dist);
  float aTight = sqrt(max(lostVar, 1e-5));
  float kSun = mix(1.0, kAlong, glit * 0.85);
  float aWide = clamp(sqrt(lostVar + 0.5 * carried * (1.0 - kSun * kSun)), 0.055, 0.62);
  float alpha = mix(aTight, aWide, glit);
  vec3 Ns = normalize(mix(N, Nlow, glit * 0.85));
  // Rain does roughen the surface, but 'rainRipple' above already put its ripple
  // into 'slope', so a large multiplier here counts the same water twice. At the
  // old 2.2 the gale scene ran a near-field alpha of 0.47 — a matte surface, on
  // water fifty metres from the camera — and that is most of why a 6.4 m sea
  // rendered as a flat sheet.
  alpha = mix(alpha, clamp(alpha * 1.25, 0.0, 0.55), uWetness * 0.7);
  alpha = clamp(mix(alpha, 0.62, foam), 0.02, 0.95);

  /* CLOUD SHADOW OBEYS THE SAME FOOTPRINT RULE AS EVERYTHING ELSE HERE.
   *
   * At grazing incidence a pixel's world footprint is 'pxWorld' across and
   * 'pxWorld / |V.y|' ALONG the view ray — 3 m by 514 m at four kilometres with
   * the eye 25 m up. The shadow map is 26 km over 512 texels, so one screen row
   * near the horizon spans ten of its texels and a few rows span a whole cloud.
   * Point-sampling it there answers a "where" the pixel cannot hold, and since
   * the sun glitter is the dominant term in the far field the answer arrives as
   * a stack of hard horizontal bands across the horizon with the sea's own
   * detail nowhere in it. That is DIAGNOSIS §62's top defect, measured: the
   * column-mean luminance profile over x 0-520 of 'orbit' carried SEVEN
   * discontinuities and a total |d2L| of 58.9, against 11.0 with the shadow
   * removed outright.
   *
   * Averaging the shadow ALONG the footprint does not fix it — sixteen taps over
   * the same span measured 41.2 against a null of 51.9 — because a cloud shadow
   * is wider than the footprint. The error is resolving it at all: once the
   * footprint is longer than the shadow field's own features there is no
   * placement left to render, and the expected transmittance over the footprint
   * is the field's mean. 'lwCloudShadow' is normalised so that mean is exactly
   * 1.0, so converging to 1.0 is not "switching the shadow off" — the absolute
   * darkening under overcast is already inside 'uSunIntensity', which is why a
   * storm does not brighten.
   *
   * The band is where a pixel stops being able to place a cloud: shadow cells
   * run a couple of hundred metres to a few kilometres, so a footprint of 80 m
   * can still put one down and 600 m cannot. Measured over the same profile:
   * total |d2L| 17.8 and two discontinuities at 80/600, against 44.0 at
   * 150/1200 and 50.7 at 300/2400; landed, the same profile reads 13.4 and 15.3
   * on repeated nulls with ZERO discontinuities. In 'orbit' it fades out between
   * 1.6 and 4.3 km, i.e. across the last fourteen rows before the horizon; the
   * near field is untouched (8 m of footprint at 500 m).
   */
  float shadowFootprint = pxWorld / max(abs(V.y), 1e-3);
  float shadowRes = 1.0 - smoothstep(80.0, 600.0, shadowFootprint);
  float sunVis = mix(1.0, lwCloudShadow(P), shadowRes);
  vec3 sunIrr = uSunColor * uSunIntensity * sunVis;

  vec3 sunSpec = vec3(0.0);
  {
    vec3 L = uSunDirection;
    vec3 H = normalize(L + V);
    float NoL = max(dot(Ns, L), 0.0);
    float NsoV = max(dot(Ns, V), 1e-3);
    float NoH = max(dot(Ns, H), 0.0);
    float D = lwD_GGX(NoH, alpha);
    float Vs = lwV_SmithGGX(NsoV, NoL, alpha);
    // Foam is a rough dielectric, water is a smooth one.
    float f0 = mix(0.02, 0.05, foam);
    float F = lwF_SchlickF(f0, 1.0, max(dot(H, V), 0.0));
    sunSpec = sunIrr * (D * Vs * F * NoL);
  }
  {
    vec3 L = uMoonDirection;
    vec3 H = normalize(L + V);
    float NoL = max(dot(Ns, L), 0.0);
    float NoH = max(dot(Ns, H), 0.0);
    float D = lwD_GGX(NoH, max(alpha, 0.05));
    float Vs = lwV_SmithGGX(max(dot(Ns, V), 1e-3), NoL, max(alpha, 0.05));
    sunSpec += uMoonColor * uMoonIntensity * (D * Vs * 0.02 * NoL);
  }

  /* ---- reflection -------------------------------------------------- */
  // 'oceanReflectance' is a MACRO-surface model: Schlick Fresnel plus a Smith
  // masking term that already accounts for facets hidden behind their
  // neighbours, with 'alpha' describing those facets. Feeding it the
  // point-sampled MICRO normal therefore double counts — and at grazing
  // incidence it does so catastrophically. The sea's rms slope is 0.1-0.2 while
  // the grazing sine is 0.09 at 300 m and 0.03 at 900 m, so dot(N, V) goes
  // NEGATIVE over a large fraction of the surface; 'max(.., 1e-3)' rectifies
  // that, and G1 at 1e-3 is ~0.03 where the macro answer is ~0.7. The pixel
  // loses 12x of a reflected sky that carries several hundred times the body
  // radiance, so it renders nearly black.
  //
  // Which side of that rectification a pixel lands on depends only on where
  // inside its own footprint it happened to sample, so the TAA jitter flips it
  // every frame; and the fraction of surface affected is a function of the
  // grazing angle, which on a flat sea is a function of screen ROW. Those two
  // together are the owner-reported defect exactly: darker horizontal bands in
  // the mid distance that flicker.
  //
  // Measured with the ocean sim clock pinned and the camera static, so wave
  // motion cannot contribute (.tmp/flick.mjs, noon, 1600x900): temporal std of
  // the per-row band signal beyond 600 m was 0.38 with the micro normal here and
  // 0.10 with the macro normal, against a film-grain floor of 0.03; per-pixel
  // frame delta over the same rows fell 4.67 -> 2.25 on a floor of 2.05. Static
  // band strength at 130-240 m fell 24%.
  //
  // The blend criterion is the failure condition itself: how likely the sampled
  // facet is to be backfacing, i.e. the slope rms the normal still carries
  // against the grazing sine. A footprint-area criterion was tried instead and
  // is worse — it plateaus at 0.56 across 130-250 m, because between the
  // cascades' pixel fades there is a stretch where no further variance is
  // dropped, and 130-250 m is exactly where the owner sees the bands. Combining
  // the two measured identical to this one alone, so this is the whole story.
  // The 0.25 offset is what keeps the near field untouched: at 40 m the carried
  // rms is 13% of the grazing sine and cannot rectify anything.
  float macro = saturate1(sqrt(carried) / max(abs(V.y), 1e-3) - 0.25);
  vec3 Nmac = normalize(mix(N, Nlow, macro));
  // Blending a normal toward its own low-pass removes variance from the
  // geometry, and exactly that much has to come back as lobe width or the two
  // halves of one specular lobe disagree about the surface.
  //
  // 'Nlow' differs from N on the ALONG-ray axis only, by a factor kAlong, so the
  // blend scales that axis by kRef and leaves the across-ray axis alone. Slope
  // variance splits evenly between the two axes, hence the 0.5: what the blend
  // removes is half of 'carried' times (1 - kRef^2). The old form was this
  // expression with kAlong pinned to 0 and no 0.5 -- i.e. it assumed the blend
  // flattened BOTH axes completely, which is what blending toward cascade 0
  // very nearly did. Keeping that form with the anisotropic 'Nlow' would count
  // the across-ray half twice, once as slope in the normal and once as the
  // roughness that exists precisely because it is not.
  float kRef = mix(1.0, kAlong, macro);
  float alphaR = clamp(max(alpha, sqrt(lostVar + 0.5 * carried * (1.0 - kRef * kRef))), 0.02, 0.95);
  float fres = oceanReflectance(max(dot(Nmac, V), 1e-3), alphaR);
  vec3 R = reflect(-V, Nmac);
  R.y = abs(R.y) * 0.55 + R.y * 0.45; // keep grazing rays out of the ground
  vec3 skyRefl = oceanReflection(normalize(R), alphaR);
  vec3 reflection = skyRefl;
  if (uHasReflection > 0.5) {
    // The mirrored render is valid at the fragment's own screen position for a
    // flat plane; perturb by the surface normal for the waves.
    vec2 ruv = gl_FragCoord.xy / uResolution;
    float bend = 0.06 / (1.0 + dist * 0.03);
    ruv += vec2(N.x, N.z) * bend;
    vec2 cl = clamp(ruv, vec2(0.002), vec2(0.998));
    vec4 rf = texture2D(uReflection, cl);
    float edge = smoothstep(0.0, 0.02, min(min(ruv.x, ruv.y), min(1.0 - ruv.x, 1.0 - ruv.y)));
    // Fade the probe out with distance; past a few hundred metres the parallax
    // error of a planar probe is worse than just using the sky.
    float valid = edge * rf.a * (1.0 - smoothstep(250.0, 900.0, dist));
    reflection = mix(skyRefl, rf.rgb, valid);
  }

  /* ---- water body + subsurface ------------------------------------- */
  // How much of the dome this point can actually see. A trough is walled in by
  // the crests around it; a crest sees the whole sky.
  //
  // This matters far more than it looks. Under overcast, uSkyColor and uFogColor
  // are within 10% of each other (measured 0.284/0.272/0.258 against
  // 0.303/0.320/0.383 in the gale), so the reflected sky is the same grey in every
  // direction and carries NO normal dependence; the body term's own N.y factor
  // moves 1.8% across the whole slope range. With both of those flat there was
  // literally nothing left in the shader that responded to the surface, and a
  // 6.4 m sea rendered as a smooth sheet. Elevation-based occlusion is the one
  // structural cue that does not depend on the sky having a gradient, and it
  // fades out with distance on its own because 'dispY' comes from the same
  // mip-filtered displacement the geometry does.
  //
  // Written SYMMETRICALLY about 1.0 on purpose. A one-sided darkening would bias
  // the mean, and 'dispY' converges to zero as the displacement mips out, so any
  // bias would apply itself to the whole far field as a distance ramp and put a
  // step at the horizon — the one failure the rubric rejects outright. This form
  // is 1.0 wherever the waves are unresolved, so the far field and the horizon
  // row are untouched and only water with real relief in it gets modulated.
  float relH = clamp(dispY / max(uWaveHeight * 0.5, 0.15), -1.0, 1.0);
  float trough = 1.0 + 0.30 * relH;
  // Downwelling radiance just under the surface. uSkyColor is already E_sky/PI;
  // sun irradiance owes the 1/PI (see the contract in src/sky/constants.ts).
  vec3 skyIrr = uSkyColor * (0.55 + 0.45 * saturate1(N.y)) * trough;
  vec3 Ed = skyIrr + sunIrr * INV_PI * saturate1(uSunDirection.y);
  // An optically deep column returns the asymptote albedo*Ed: a finite
  // Beer-Lambert slab would be wrong here, because more path means MORE return,
  // not less, and blue is exactly the channel with the longest path. The
  // extinction split earns its keep in the crest transmission below and in the
  // 65:14:1 blue:green:red of DEEP_ALBEDO itself.
  vec3 body = DEEP_ALBEDO * Ed;

  // Light transmitted through the crest. Thickness scales with the sea state
  // rather than being a fixed metre count, so a storm crest is a genuinely long
  // path and a ripple is a short one, which is what decides how jade it goes.
  float crest = saturate1((dispY + uWaveHeight * 0.12) / max(uWaveHeight * 0.85, 0.12));
  float thickness = max(uWaveHeight, 0.35) * mix(1.7, 0.22, crest);
  vec3 trans = exp(-EXTINCTION * thickness);
  // Forward-scatter lobe: it only fires with the crest between eye and sun.
  float back = saturate1(dot(V, -uSunDirection) * 0.5 + 0.5);
  back = back * back * back * back;
  // Wrapped diffuse, because the light entered the far side of the water.
  float wrap = saturate1((dot(N, uSunDirection) + 0.75) / 1.75);
  float steep = saturate1(length(slope) * 0.8);
  vec3 sss = SSS_ALBEDO * trans * sunIrr * INV_PI
           * (back * 3.0 + 0.08) * wrap * (0.15 + 0.85 * crest) * (0.25 + 1.1 * steep);

  vec3 foamCol = vec3(FOAM_ALBEDO) * (skyIrr
                 + sunIrr * INV_PI * saturate1(dot(N, uSunDirection) * 0.6 + 0.4));

  // FOAM MUST TAKE THE GLOSS AWAY, NOT JUST ADD WHITE, AND IT MUST TAKE EXACTLY
  // ITS OWN COVERAGE OF IT.
  //
  // 'foam' is now the fraction of the pixel that aerated water covers, so the
  // water terms are weighted by what is left uncovered. Foam is a scattering
  // medium with no coherent reflection direction; the 10% residual is the wet
  // film between the bubbles, which is why a whitecap still has a sheen and does
  // not read as matte paint.
  //
  // The previous pair (0.72 on the reflection, 0.55 on the sun lobe) removed
  // LESS than the coverage, and that asymmetry is not free. At golden hour the
  // reflected horizon carries several hundred times the body radiance, so
  // d(radiance)/d(coverage) at low coverage was dominated by the reflection it
  // failed to remove: faint foam brightened nothing and dimmed nothing enough,
  // and what it left behind was a broad, evenly grey wash. Coverage-proportional
  // is both the physical answer and the one where a faint wake simply has a few
  // white flecks in it instead of a lane of dirty ice.
  float clear = 1.0 - 0.90 * foam;
  vec3 col = mix(body + sss, foamCol, foam);
  // The reflected sky is occluded by the neighbouring crests too, and under a
  // flat sky this is the only thing that puts any shape into the term that
  // carries most of the energy. Half strength, because a reflection gathers over
  // the whole lobe rather than from one direction.
  col = mix(col, reflection * (0.5 + 0.5 * trough), fres * clear);
  col += sunSpec * clear;

  /* ---- backface: we are under the surface --------------------------- */
  if (!gl_FrontFacing) {
    vec3 under = DEEP_ALBEDO * 12.0 * (uSkyColor + sunIrr * INV_PI * 0.06);
    float caustic = saturate1(0.5 + 0.5 * noise2(vAbs * 0.35 + uTime * 0.25));
    col = under * (0.7 + 0.6 * caustic);
  }

  /* ---- aerial perspective ------------------------------------------ */
  // Koschmieder extinction straight off the published fog density rather than a
  // tuned multiplier: at 34 km visibility that is 1.15e-4 /m, so 100 m of water
  // is hazed by about 1% and the near field stays crisp. Measured, so the sea is
  // NOT the source of the frame's close-range haze: 1.8% at 30 m even in a storm.
  //
  // The sky publishes an 'aerialLUT' froxel volume and this still does not sample
  // it, for two reasons. It is rebuilt every 4th frame, so a camera cut would drag
  // stale in-scatter across the whole sea; and the volume's far plane is a few km
  // while the horizon is 5-18 km out, so the horizon row — the one row that must
  // match the sky or the rubric fails on a hard seam — is past its range. The
  // probe-based 'oceanInscatter' below gets the azimuthal variation, which was the
  // thing actually missing, without either problem.
  float ext = max(uFogDensity, 3.912 / max(uVisibility, 200.0));
  float t = 1.0 - exp(-dist * ext);
  // A CAP on the horizon step, and no longer the thing that erases it.
  //
  // It was written when the sea ran flat to 49 km and compressed everything past
  // ~12 km into the last row, which forced that row to the sky's own colour. With
  // curvature the last sea is at 'sqrt(2*R*h)' and Koschmieder alone already has
  // t = 0.44 at a 2.5 m eye, 0.77 at 8 m and 0.91 at 25 m, so this term is inert
  // at every eye height a camera mode reaches (measured: removing it from the
  // untouched build changes tot|d2L| by 0.3 on a null spread of 0.4). What it
  // still does is bound the step when visibility is very high — at 44 km and a
  // 25 m eye it lifts t from 0.80 to 0.84 — and that is worth one 'max'.
  t = max(t, smoothstep(6000.0, 22000.0, dist));
  vec3 haze = oceanInscatter(-V);
  col = mix(col, haze, t);

  gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
}
`;

  return { vertexShader, fragmentShader };
}
