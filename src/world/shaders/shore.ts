import { GLSL } from '../../util/glsl';
import { SHARED_UNIFORM_DECL } from '../../core/SharedUniforms';
import { HEIGHTFIELD, WORLD_AERIAL } from './wcommon';

/**
 * Shore water: a translucent shell over the shallow shelf of each island,
 * instanced over the same CDLOD nodes as the terrain.
 *
 * It owns the whole shallow-water look — depth-graded absorption, a refracted
 * seabed with caustics, and the breaker line — rather than depending on the
 * ocean module reading our depth. It composites *over* the ocean and fades to
 * zero alpha by ~40 m of depth, so wherever it matters it is authoritative and
 * wherever it does not it disappears.
 *
 * Crest lines are phased on water depth, not distance, which is why they wrap
 * around headlands and reefs the way refracted swell actually does.
 */
export const shoreVert = /* glsl */ `
precision highp float;
${SHARED_UNIFORM_DECL}
${GLSL.common}
${HEIGHTFIELD}

attribute vec4 aNode;

uniform vec3  uIslandPos;
uniform float uLodStart[8];
uniform float uLodEnd[8];
uniform float uPatch;
uniform float uWaveH;
uniform float uSeaY;

varying vec2  vLocal;
varying vec3  vWorld;
varying float vDist;
varying float vDepth;
varying vec3  vChopN;

vec3 chop(vec2 p, float amp, out float y){
  float t = uTime;
  float a = sin(p.x * 0.093 + t * 1.15);
  float b = sin(p.y * 0.117 - t * 0.94);
  float c = sin((p.x + p.y) * 0.052 + t * 0.72);
  y = (a * 0.34 + b * 0.28 + c * 0.38) * amp;
  float dx = (cos(p.x * 0.093 + t * 1.15) * 0.093 * 0.34 + cos((p.x + p.y) * 0.052 + t * 0.72) * 0.052 * 0.38) * amp;
  float dz = (cos(p.y * 0.117 - t * 0.94) * 0.117 * 0.28 + cos((p.x + p.y) * 0.052 + t * 0.72) * 0.052 * 0.38) * amp;
  return normalize(vec3(-dx, 1.0, -dz));
}

void main(){
  vec2 g = position.xz;
  vec2 lxz = aNode.xy + g * aNode.z;

  vec3 flat0 = uIslandPos + vec3(lxz.x, 0.0, lxz.y);
  float d = distance(flat0, uCameraPos);
  int lv = int(aNode.w + 0.5);
  float k = clamp((d - uLodStart[lv]) / max(uLodEnd[lv] - uLodStart[lv], 1.0), 0.0, 1.0);
  vec2 fp = fract(g * (uPatch * 0.5)) * (2.0 / uPatch);
  lxz = aNode.xy + (g - fp * k) * aNode.z;

  float bed = hfHeight(lxz);
  float depth = max(0.0, uSeaY - bed);
  float amp = min(0.45, 0.12 + uWaveH * 0.16) * linstep(0.0, 2.5, depth);
  float dy;
  vChopN = chop(lxz, amp, dy);

  vec3 wp = uIslandPos + vec3(lxz.x, uSeaY + dy, lxz.y);
  vLocal = lxz;
  vWorld = wp;
  vDepth = depth;
  vDist = distance(wp, uCameraPos);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

export const shoreFrag = /* glsl */ `
precision highp float;
${SHARED_UNIFORM_DECL}
${GLSL.common}
${GLSL.noise2d}
${GLSL.brdf}
${HEIGHTFIELD}
${WORLD_AERIAL}

uniform vec3  uSandCol;
uniform vec3  uRockCol;
uniform float uWaveH;
uniform vec2  uSwellDir;    // unit XZ the swell travels toward
uniform float uSeaY;
uniform float uReef;

varying vec2  vLocal;
varying vec3  vWorld;
varying float vDist;
varying float vDepth;
varying vec3  vChopN;

// Per-metre extinction. Red dies first, which is the whole reason shallow sand
// reads turquoise and 20 m of the same sand reads deep blue.
const vec3 SIGMA = vec3(0.30, 0.055, 0.038);

void main(){
  if (vDepth < 0.02) discard;

  vec3 V = normalize(uCameraPos - vWorld);
  vec3 N = normalize(vChopN);

  // Ripple normal on top of the vertex chop.
  vec2 rp = vLocal * 1.35 + vec2(uTime * 0.6, uTime * -0.42);
  vec3 rn = noise2d_d(rp);
  vec3 rn2 = noise2d_d(rp * 2.7 - vec2(uTime * 0.3));
  float rippleAmp = 0.055 * (0.4 + 0.6 * linstep(0.2, 3.0, vDepth));
  N = normalize(N + vec3(-(rn.y * 0.7 + rn2.y * 0.3), 0.0, -(rn.z * 0.7 + rn2.z * 0.3)) * rippleAmp * 6.0);

  // --- refracted seabed -----------------------------------------------------
  float NoV = max(1e-3, dot(N, V));
  vec2 refr = (N.xz - vec3(0.0, 1.0, 0.0).xz) * 0.0;
  refr = -N.xz * vDepth * 0.42;
  vec2 sxz = vLocal + refr;
  float bed = hfHeight(sxz);
  vec4 bm = hfMat(sxz);
  vec2 bn = bm.rg * 2.0 - 1.0;
  vec3 bedN = normalize(vec3(bn.x, sqrt(max(1e-4, 1.0 - dot(bn, bn))), bn.y));
  float bedDepth = max(0.02, uSeaY - bed);

  vec3 sandAlb = uSandCol * 2.5;
  vec3 rockAlb = uRockCol * 2.2;
  vec3 bedAlb = mix(rockAlb, sandAlb, bm.b);
  // Coral heads on a reef shelf: patchy, slightly warm, slightly darker.
  float coral = uReef * linstep(9.0, 1.0, bedDepth) * linstep(0.35, 0.7, noise2(sxz * 0.06) * 0.5 + 0.5);
  bedAlb = mix(bedAlb, vec3(0.20, 0.155, 0.125), coral * 0.75);
  bedAlb *= 0.75 + 0.5 * (noise2(sxz * 0.09) * 0.5 + 0.5);

  // --- caustics -------------------------------------------------------------
  vec2 cq = sxz * 0.115;
  float c1 = noise2(cq + vec2(uTime * 0.075, uTime * 0.052));
  float c2 = noise2(cq * 1.73 - vec2(uTime * 0.061, uTime * 0.094));
  float caust = pow(saturate1(1.0 - abs(c1 + c2) * 1.35), 5.0) * 2.6;
  caust *= exp(-bedDepth * 0.11) * saturate1(uSunDirection.y * 3.0);

  float bedNoL = max(0.0, dot(bedN, uSunDirection));
  vec3 bedLit = bedAlb * (uSunColor * uSunIntensity * (bedNoL + caust) * INV_PI
                        + uSkyColor * 0.55 + uMoonColor * uMoonIntensity * 0.4);

  // --- absorption + inscatter ----------------------------------------------
  // Path length: down to the bed and back out along the view ray.
  float path = bedDepth * (1.0 + 1.0 / max(NoV, 0.22));
  vec3 transmit = exp(-SIGMA * path);
  vec3 scatterCol = mix(vec3(0.055, 0.34, 0.36), vec3(0.02, 0.13, 0.20), linstep(3.0, 26.0, bedDepth));
  scatterCol *= (uSunColor * uSunIntensity * 0.055 + uSkyColor * 0.5 + uMoonColor * uMoonIntensity * 0.25);
  vec3 col = bedLit * transmit + scatterCol * (1.0 - transmit);

  // --- reflection -----------------------------------------------------------
  float F = lwFresnelWater(NoV);
  vec3 refl = uSkyColor * 1.35 + uFogColor * 0.35;
  vec3 H = normalize(uSunDirection + V);
  float a = 0.028;
  float spec = lwD_GGX(max(0.0, dot(N, H)), a) * lwV_SmithGGX(NoV, max(1e-3, dot(N, uSunDirection)), a);
  refl += uSunColor * (uSunIntensity * spec * max(0.0, dot(N, uSunDirection)) * 0.9);
  col = mix(col, refl, F * 0.92);

  // --- surf -----------------------------------------------------------------
  vec2 bedGrad = vec2(bn.x, bn.y);
  float gl = length(bedGrad) + 1e-4;
  vec2 offshoreN = bedGrad / gl;                 // points toward deeper water
  float windward = saturate1(-dot(offshoreN, uSwellDir) * 1.15 + 0.18);

  float hb = max(0.55, uWaveH * 1.35);
  float kd = TAU / (hb * 2.3);
  float sw = sin(vDepth * kd - uTime * 1.05) * 0.5 + 0.5;
  float breakBand = exp(-sq((vDepth - hb) / (hb * 0.85)));
  float breaker = breakBand * pow(sw, 2.2) * windward * 1.35;

  vec2 fq = vLocal * 0.34 + offshoreN * (-uTime * 2.4);
  float ftex = 0.45 + 0.55 * (noise2(fq) * 0.5 + 0.5) * (noise2(fq * 2.3) * 0.5 + 0.5) * 2.0;
  float trail = linstep(hb * 1.7, 0.05, vDepth) * windward * 0.55;
  float swash = linstep(0.9 + uWaveH * 0.5, 0.02, vDepth) * (0.5 + 0.5 * sw) * 0.85;
  float foam = saturate1((breaker + trail + swash) * ftex);
  // Reef edges break even when the shore behind them does not.
  foam = saturate1(foam + breakBand * uReef * 0.45 * pow(sw, 3.0) * ftex);

  vec3 foamCol = vec3(0.86, 0.90, 0.93) * (uSunColor * uSunIntensity * 0.075 + uSkyColor * 0.9 + uMoonColor * uMoonIntensity * 0.3);
  col = mix(col, foamCol, foam);

  // --- alpha ----------------------------------------------------------------
  // Fade out into deep water so the ocean module owns everything past the shelf,
  // and fade out at the waterline so the terrain intersection has no hard edge.
  float alpha = linstep(0.04, 0.55, vDepth) * (1.0 - linstep(17.0, 44.0, vDepth));
  alpha = max(alpha, foam * 0.95 * linstep(0.02, 0.3, vDepth));
  alpha = min(1.0, alpha + F * 0.25 * linstep(0.04, 0.6, vDepth));

  col = worldAerial(col, vWorld, vDist);
  gl_FragColor = vec4(col, alpha);
}
`;
