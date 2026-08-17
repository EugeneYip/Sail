import { GLSL } from '../../util/glsl';
import { SHARED_UNIFORM_DECL } from '../../core/SharedUniforms';
import { HEIGHTFIELD, HEIGHT_SHADOW, WORLD_AERIAL, WORLD_LIGHTING } from './wcommon';

/**
 * CDLOD terrain. One instanced draw per island: every quadtree node is an
 * instance of the same 33x33 unit patch, and the vertex shader morphs each
 * vertex toward its parent grid as the node approaches its LOD range limit.
 *
 * The LOD metric is evaluated at y = 0 rather than at the displaced vertex, so
 * two neighbouring nodes at different levels always agree on the shared edge —
 * that is what makes this crack-free without skirts, and pop-free without
 * discrete LOD swaps.
 */
export const terrainVert = /* glsl */ `
precision highp float;
${SHARED_UNIFORM_DECL}
${GLSL.common}
${HEIGHTFIELD}

attribute vec4 aNode;      // xz = node origin (island-local m), z = size, w = level

uniform vec3  uIslandPos;  // render-space position of the island local origin
uniform float uLodStart[8];
uniform float uLodEnd[8];
uniform float uPatch;

varying vec2  vLocal;
varying vec3  vWorld;
varying float vDist;
varying float vMorph;

void main(){
  vec2 g = position.xz;
  vec2 lxz = aNode.xy + g * aNode.z;

  vec3 flat0 = uIslandPos + vec3(lxz.x, 0.0, lxz.y);
  float d = distance(flat0, uCameraPos);
  int lv = int(aNode.w + 0.5);
  float ms = uLodStart[lv];
  float me = uLodEnd[lv];
  float k = clamp((d - ms) / max(me - ms, 1.0), 0.0, 1.0);

  vec2 fp = fract(g * (uPatch * 0.5)) * (2.0 / uPatch);
  lxz = aNode.xy + (g - fp * k) * aNode.z;

  vec2 hm = hfSampleHM(lxz);
  vec3 wp = uIslandPos + vec3(lxz.x, hm.x, lxz.y);

  vLocal = lxz;
  vWorld = wp;
  vDist  = distance(wp, uCameraPos);
  vMorph = hm.y;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

export const terrainFrag = /* glsl */ `
precision highp float;
${SHARED_UNIFORM_DECL}
${GLSL.common}
${GLSL.noise2d}
${GLSL.brdf}
${GLSL.surface}
${HEIGHTFIELD}
${HEIGHT_SHADOW}
${WORLD_LIGHTING}
${WORLD_AERIAL}

uniform sampler2DArray tDetail;   // rgb albedo, a height
uniform sampler2DArray tDetailN;  // rg normal.xy, b AO, a roughness
uniform vec3  uRockCol;
uniform vec3  uSandCol;
uniform vec3  uFloraCol;
uniform float uSnowLine;
uniform float uWaveH;
uniform vec2  uSwellDir;     // unit XZ the swell travels toward
uniform float uNear;         // 1 when this island is close enough for full detail

varying vec2  vLocal;
varying vec3  vWorld;
varying float vDist;
varying float vMorph;

#define L_ROCK  0.0
#define L_SAND  1.0
#define L_GRASS 2.0
#define L_SCREE 3.0

vec4 triAlbedo(vec3 p, vec3 n, float scale, float layer, vec3 b){
  return texture(tDetail, vec3(p.zy * scale, layer)) * b.x
       + texture(tDetail, vec3(p.xz * scale, layer)) * b.y
       + texture(tDetail, vec3(p.xy * scale, layer)) * b.z;
}

vec3 unpackDN(vec2 rg){
  vec2 t = rg * 2.0 - 1.0;
  return vec3(t, sqrt(max(1e-4, 1.0 - dot(t, t))));
}

void main(){
  float dither = ign(gl_FragCoord.xy);
  vec3  N0 = hfNormal(vLocal, dither);
  vec4  m  = hfMat(vLocal);
  float h  = vWorld.y;
  float sandiness = m.b;
  float ao0 = m.a;
  float moistCode = vMorph;
  float river = linstep(0.895, 0.955, moistCode);
  float moist = min(moistCode, 0.88) / 0.88;

  float slope = 1.0 - N0.y;
  vec3 P = vec3(vLocal.x, h, vLocal.y);   // island-local: stable across origin shifts

  // --- material weights -----------------------------------------------------
  float rockW  = linstep(0.22, 0.52, slope);
  float screeW = linstep(0.13, 0.34, slope) * (1.0 - rockW) * (1.0 - moist * 0.65);
  float sandW  = sandiness * (1.0 - rockW * 0.9);
  float grassW = max(0.0, 1.0 - rockW - screeW - sandW) * (0.25 + 0.75 * linstep(0.04, 0.34, moist));
  float bare   = max(0.0, 1.0 - rockW - screeW - sandW - grassW);
  screeW += bare * 0.6;
  rockW  += bare * 0.4;
  float wsum = rockW + screeW + sandW + grassW;
  rockW /= wsum; screeW /= wsum; sandW /= wsum; grassW /= wsum;

  vec3 tb = pow(abs(N0), vec3(4.0));
  tb /= max(tb.x + tb.y + tb.z, 1e-5);

  // --- albedo ---------------------------------------------------------------
  vec4 rock  = triAlbedo(P, N0, 0.075, L_ROCK, tb);
  vec4 sand  = texture(tDetail, vec3(P.xz * 0.30, L_SAND));
  vec4 grass = texture(tDetail, vec3(P.xz * 0.19, L_GRASS));
  vec4 scree = texture(tDetail, vec3(P.xz * 0.14, L_SCREE));

  vec3 albedo = rock.rgb  * uRockCol * 3.1 * rockW
              + sand.rgb  * uSandCol * 2.2 * sandW
              + grass.rgb * uFloraCol * 5.2 * grassW
              + scree.rgb * uRockCol * 3.9 * screeW;

  // Large-scale value/hue variation so a whole hillside is never one colour.
  float macro = noise2(P.xz * 0.0075) * 0.5 + noise2(P.xz * 0.0021) * 0.5;
  albedo *= 1.0 + macro * 0.24;
  albedo.g *= 1.0 + macro * 0.05;

  // --- forest canopy mass: what makes a 12 km island read as forested -------
  float clump = noise2(P.xz * 0.021) * 0.5 + 0.5;
  float canopy = linstep(0.16, 0.62, moist) * (1.0 - rockW) * (1.0 - sandW)
               * linstep(0.25, 0.6, clump) * step(1.5, h);
  albedo = mix(albedo, uFloraCol * (1.6 + macro * 0.7), canopy * 0.86);

  // --- snow -----------------------------------------------------------------
  float snow = linstep(uSnowLine, uSnowLine + 90.0, h + macro * 70.0)
             * (1.0 - linstep(0.5, 0.78, slope));
  albedo = mix(albedo, vec3(0.72, 0.755, 0.80), snow);

  // --- river channels -------------------------------------------------------
  albedo = mix(albedo, albedo * 0.42, river * 0.8);

  // --- normal ---------------------------------------------------------------
  vec3 dnRock  = unpackDN((texture(tDetailN, vec3(P.zy * 0.075, L_ROCK)).rg * tb.x
                         + texture(tDetailN, vec3(P.xz * 0.075, L_ROCK)).rg * tb.y
                         + texture(tDetailN, vec3(P.xy * 0.075, L_ROCK)).rg * tb.z));
  vec4 gnTex = texture(tDetailN, vec3(P.xz * 0.30, L_SAND)) * sandW
             + texture(tDetailN, vec3(P.xz * 0.19, L_GRASS)) * grassW
             + texture(tDetailN, vec3(P.xz * 0.14, L_SCREE)) * screeW;
  vec3 dnGround = unpackDN(gnTex.rg / max(sandW + grassW + screeW, 1e-3));

  // Reoriented normal mapping to layer the two detail sets, then rotate the
  // result into the heightfield's frame.
  vec3 dn = blendNormalRNM(mix(dnGround, dnRock, rockW), dnRock);
  float dnAmp = mix(0.35, 1.0, uNear) * (1.0 - snow * 0.6);
  dn = normalize(mix(vec3(0.0, 0.0, 1.0), dn, dnAmp));
  vec3 T, B;
  basis(N0, T, B);
  vec3 N = normalize(T * dn.x + B * dn.y + N0 * dn.z);

  float ao = ao0 * mix(1.0, gnTex.b + 0.35, 0.5);
  float rough = clamp(mix(0.92, 0.72, rockW) - snow * 0.1, 0.25, 0.98);

  // --- wet band at the waterline, driven by the live sea state --------------
  float wetTop = uWaveH * 1.5 + 0.7;
  float wet = linstep(wetTop, -uWaveH * 0.6 - 0.4, h);
  wet *= 0.35 + 0.65 * sandW;
  albedo *= mix(1.0, 0.46, wet);
  rough = mix(rough, 0.16, wet * 0.85);

  // --- swash line: a thin foam smear the shore shell cannot reach ----------
  float swashPhase = sin(uTime * 0.55 + P.x * 0.02 + P.z * 0.017) * 0.5 + 0.5;
  float band = 0.35 + uWaveH * 0.55 * (0.55 + 0.45 * swashPhase);
  float swash = linstep(band, 0.0, abs(h - band * 0.35))
              * (0.35 + 0.65 * sandW) * linstep(0.6, 0.15, slope);
  swash *= 0.5 + 0.5 * (noise2(P.xz * 0.35 + vec2(uTime * 0.4, 0.0)) * 0.5 + 0.5);

  // --- underwater: seabed as seen from above, the shell adds the water ------
  float under = linstep(0.0, -1.2, h);
  albedo = mix(albedo, albedo * vec3(0.55, 0.78, 0.86), under * 0.7);
  rough = mix(rough, 0.5, under);

  albedo = mix(albedo, vec3(1.0), clamp(swash * (1.0 - under), 0.0, 0.85));

  // --- lighting -------------------------------------------------------------
  vec3 V = normalize(uCameraPos - vWorld);
  float shadow = 1.0;
  if (vDist < 7000.0) shadow = hfSunShadow(vLocal, h, uSunDirection);
  else shadow = step(0.02, uSunDirection.y);
  // Wrapped term keeps the terrain from going pitch black on the shadow side.
  shadow = mix(shadow, 1.0, 0.12);

  vec3 col = worldDirect(N, albedo, shadow, rough, V) + worldAmbient(N, ao) * albedo;
  col += uSkyColor * albedo * canopy * 0.06;

  col = worldAerial(col, vWorld, vDist);
  gl_FragColor = vec4(col, 1.0);
}
`;
