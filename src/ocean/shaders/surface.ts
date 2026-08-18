import { GLSL } from '../../util/glsl';
import { SHARED_UNIFORM_DECL } from '../../core/SharedUniforms';

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
    vec4 d0 = texture2D(uDisp${i}, uv);
    vec4 d1 = texture2D(uDeriv${i}, uv);
    slope += vec2(d0.w, d1.x);
    jac   += vec3(d1.y, d1.z, d1.w);
${i === 0 ? '    lowSlope = vec2(d0.w, d1.x);\n' : ''}    // Slope variance the pixel footprint can no longer resolve becomes
    // roughness instead of aliasing.
    lostVar += uCascadeSlopeVar[${i}] *
      smoothstep(uCascadePxFade[${i}].x, uCascadePxFade[${i}].y, pxWorld);
  }`;
  }

  const wakeDecl = hasWake
    ? `uniform sampler2D uWake;
uniform mat3 uWakeMatrix;
uniform float uWakeStrength;`
    : '';

  // The wake field is a torus: uv = fract(matrix * vec3(worldX, worldZ, 1)).
  // R = persistent foam, G = height in metres, BA = world-space slope of it.
  const wakeVert = hasWake
    ? `
  {
    vec2 wuv = fract((uWakeMatrix * vec3(world, 1.0)).xy);
    disp.y += textureLod(uWake, wuv, 0.0).g * uWakeStrength;
  }`
    : '';

  const wakeFrag = hasWake
    ? `
  {
    vec2 wuv = fract((uWakeMatrix * vec3(P.xz, 1.0)).xy);
    vec4 wk = texture2D(uWake, wuv);
    slope += wk.ba * uWakeStrength;
    wakeFoam = wk.r * uWakeStrength;
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

  // The horizon skirt rises to eye height so the water silhouette lands exactly
  // on the eye-level horizon line with no sliver of sky beneath it.
  float skirtRise = isSkirt * smoothstep(0.80, 1.0, r) * max(uCameraPos.y, 0.0);

  vec3 pos = vec3(world.x + disp.x, disp.y + skirtRise, world.y + disp.z);
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
uniform float uCascadeSlopeVar[${cascades}];
uniform vec2  uCascadePxFade[${cascades}];

uniform sampler2D uFoam;
uniform sampler2D uFoamDetail;
uniform sampler2D uReflection;
uniform vec4  uFoamWindow;      // (originX, originZ, 1/size, unused)
uniform vec2  uResolution;
uniform float uPixelAngle;      // world metres per pixel, per metre of distance
uniform float uSlopeRms;
uniform float uWaveHeight;
uniform float uHasReflection;
uniform float uFoamAmount;

varying vec4 vWorldDist;
varying vec4 vAbsMisc;

/* Deep clear ocean. Extinction is per channel, so red is gone within ~1.3 m of
 * water while blue keeps going for tens of metres — that split is what makes a
 * thin backlit crest jade and the body of the wave near-black blue. */
const vec3 EXTINCTION   = vec3(0.75, 0.145, 0.058);
/* Volume scattering albedo of open ocean water: almost no red at all. */
const vec3 DEEP_COLOR   = vec3(0.0032, 0.0300, 0.0520);
const vec3 SSS_COLOR    = vec3(0.055, 0.230, 0.185);
const vec3 FOAM_ALBEDO  = vec3(0.72, 0.78, 0.80);

/**
 * Sky radiance for reflections and for the distance fade. Driven entirely by the
 * shared sky uniforms, so when the atmosphere module writes uSkyColor/uFogColor
 * the water's horizon matches the real sky and the join disappears.
 */
vec3 oceanSky(vec3 dir){
  float h = clamp(dir.y, -1.0, 1.0);
  vec3 col = mix(uFogColor, uSkyColor, pow(saturate1(h), 0.42));
  float cs = max(dot(dir, uSunDirection), 0.0);
  col += uSunColor * uSunIntensity * 0.010 * pow(cs, 10.0);
  // Rays that would look under the horizon see haze, not sky.
  col = mix(uFogColor * 0.62, col, saturate1(h * 9.0 + 0.55));
  return col;
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

  vec2 slope = vec2(0.0);
  vec2 lowSlope = vec2(0.0);
  vec3 jac = vec3(0.0);
  float lostVar = 0.0;
  float wakeFoam = 0.0;
  ${fragSample}
  ${wakeFrag}

  if (isSkirt > 0.5) { slope = vec2(0.0); jac = vec3(0.0); lostVar = uSlopeRms * uSlopeRms; }

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
  float instant = saturate1((0.68 - fold) * 2.2) * uFoamAmount;
  float foam = mix(instant, max(persistent, instant * 0.45), inWindow);
  foam = max(foam, wakeFoam);

  vec3 fd = texture2D(uFoamDetail, vAbs * 0.16).rgb;
  vec3 fd2 = texture2D(uFoamDetail, vAbs * 0.041 + 0.37).rgb;
  float breakup = mix(fd.r, fd2.r, 0.5);
  // Ragged edges: erode the coverage by the breakup field instead of fading it.
  foam = saturate1((foam * 1.35 - breakup * 0.55) * 2.0);
  foam *= 1.0 - smoothstep(4000.0, 14000.0, dist) * 0.6;
  N = normalize(N + vec3(fd.g - 0.5, 0.0, fd.b - 0.5) * foam * 1.1);

  /* ---- specular ---------------------------------------------------- */
  float NoV = max(dot(N, V), 1e-3);
  // Two regimes in one lobe: near the camera the normal map really does carry
  // the microfacets, far away it cannot, so widen to the statistical slope
  // distribution (alpha = sqrt(2)*sigma) and use the low-frequency normal. This
  // is the sun-glitter path, and doing it this way is what removes the sparkle.
  float glit = smoothstep(45.0, 850.0, dist);
  float aTight = sqrt(max(0.0022 + 2.0 * lostVar, 1e-5));
  float aWide = clamp(1.4142 * uSlopeRms, 0.055, 0.62);
  float alpha = mix(aTight, aWide, glit);
  vec3 Ns = normalize(mix(N, Nlow, glit * 0.85));
  alpha = mix(alpha, clamp(alpha * 2.2, 0.0, 0.9), uWetness * 0.7);
  alpha = clamp(mix(alpha, 0.62, foam), 0.02, 0.95);

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
    sunSpec = uSunColor * uSunIntensity * (D * Vs * F * NoL);
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
  float fres = lwFresnelWater(NoV);
  vec3 R = reflect(-V, N);
  R.y = abs(R.y) * 0.55 + R.y * 0.45; // keep grazing rays out of the ground
  vec3 skyRefl = oceanSky(normalize(R));
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
  vec3 skyIrr = uSkyColor * (0.55 + 0.45 * saturate1(N.y));
  vec3 body = DEEP_COLOR * (skyIrr + uSunColor * uSunIntensity * 0.055 * saturate1(uSunDirection.y));

  // Light transmitted through the crest. Thickness grows with how far this point
  // sits above the local mean, so only crests glow, and Beer-Lambert through
  // that thickness is what turns the glow jade rather than white.
  float crest = saturate1((dispY + uWaveHeight * 0.12) / max(uWaveHeight * 0.85, 0.12));
  float thickness = mix(3.2, 0.35, crest);
  vec3 trans = exp(-EXTINCTION * thickness);
  float back = saturate1(dot(V, -uSunDirection) * 0.5 + 0.5);
  back = pow(back, 3.0);
  float wrap = saturate1((dot(N, uSunDirection) + 0.6) / 1.6);
  float steep = saturate1(length(slope) * 0.55);
  vec3 sss = SSS_COLOR * trans * uSunColor * uSunIntensity
           * (back * 0.85 + 0.15) * wrap * (0.25 + 0.75 * crest) * (0.35 + 0.9 * steep);

  vec3 foamCol = FOAM_ALBEDO * (skyIrr * 0.9 + uSunColor * uSunIntensity * 0.085
                 * saturate1(dot(N, uSunDirection) * 0.6 + 0.4));

  vec3 col = mix(body + sss, foamCol, foam);
  col = mix(col, reflection, fres * (1.0 - foam * 0.72));
  col += sunSpec * (1.0 - foam * 0.55);

  /* ---- backface: we are under the surface --------------------------- */
  if (!gl_FrontFacing) {
    vec3 under = DEEP_COLOR * 6.0 * (uSkyColor + uSunColor * uSunIntensity * 0.02);
    float caustic = saturate1(0.5 + 0.5 * noise2(vAbs * 0.35 + uTime * 0.25));
    col = under * (0.7 + 0.6 * caustic);
  }

  /* ---- aerial perspective ------------------------------------------ */
  float vis = max(uVisibility, 200.0);
  float t = 1.0 - exp(-dist * 2.6 / vis);
  vec3 haze = oceanSky(normalize(-V));
  col = mix(col, haze, t);

  gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
}
`;

  return { vertexShader, fragmentShader };
}
