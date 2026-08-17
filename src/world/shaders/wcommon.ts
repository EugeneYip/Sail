/**
 * GLSL shared by every world material.
 *
 * All of these expect `SHARED_UNIFORM_DECL` and `GLSL.common` to be included
 * first, and they assume `glslVersion: THREE.GLSL3` (three then aliases
 * `texture2D`/`varying`/`gl_FragColor` for us, while `texelFetch` becomes
 * available — which is what lets us read a nearest-only float heightfield and
 * interpolate it identically on CPU and GPU).
 */

/** Bilinear heightfield fetch. Must match `HeightField.height()` in TS. */
export const HEIGHTFIELD = /* glsl */ `
#ifndef WORLD_HEIGHTFIELD
#define WORLD_HEIGHTFIELD
uniform sampler2D tHeight;   // RG32F: r = height (m), g = moisture code
uniform sampler2D tMat;      // RGBA8: rg = normal.xz, b = sandiness, a = AO
uniform vec4 uHF;            // x = gridN, y = extent, z = cell size, w = 1/gridN

vec2 hfCoord(vec2 lxz){ return (lxz / uHF.y + 0.5) * (uHF.x - 1.0); }

vec2 hfSampleHM(vec2 lxz){
  vec2 t = hfCoord(lxz);
  vec2 f = fract(t);
  ivec2 c = ivec2(floor(t));
  int n = int(uHF.x) - 1;
  ivec2 a = clamp(c, ivec2(0), ivec2(n));
  ivec2 b = clamp(c + 1, ivec2(0), ivec2(n));
  vec2 h00 = texelFetch(tHeight, ivec2(a.x, a.y), 0).rg;
  vec2 h10 = texelFetch(tHeight, ivec2(b.x, a.y), 0).rg;
  vec2 h01 = texelFetch(tHeight, ivec2(a.x, b.y), 0).rg;
  vec2 h11 = texelFetch(tHeight, ivec2(b.x, b.y), 0).rg;
  return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
}

float hfHeight(vec2 lxz){ return hfSampleHM(lxz).r; }

vec4 hfMat(vec2 lxz){
  return texture(tMat, (hfCoord(lxz) + 0.5) * uHF.w);
}

/** Shading normal from the baked normal channels, dithered to kill 8-bit banding. */
vec3 hfNormal(vec2 lxz, float dither){
  vec4 m = hfMat(lxz);
  vec2 nxz = (m.rg + (dither - 0.5) * (1.0 / 255.0)) * 2.0 - 1.0;
  float ny = sqrt(max(1e-4, 1.0 - dot(nxz, nxz)));
  return normalize(vec3(nxz.x, ny, nxz.y));
}
#endif
`;

/**
 * Terrain self-shadowing by marching the heightfield toward the sun. A shadow
 * map cannot resolve a 4 km island and a 900 m peak at once; a 10-tap
 * geometric march can, and it gives us the long raking shadows that make a
 * ridgeline readable at golden hour.
 */
export const HEIGHT_SHADOW = /* glsl */ `
#ifndef WORLD_HEIGHT_SHADOW
#define WORLD_HEIGHT_SHADOW
float hfSunShadow(vec2 lxz, float h, vec3 sunDir){
  float horiz = length(sunDir.xz);
  if (sunDir.y <= 0.015 || horiz < 1e-3) return 0.0;
  vec2 dir = sunDir.xz / horiz;
  float rise = sunDir.y / horiz;
  float sh = 1.0;
  float t = uHF.z * 1.5;
  for (int i = 0; i < 10; i++){
    float hh = hfHeight(lxz + dir * t);
    float hr = h + rise * t;
    sh = min(sh, 1.0 - linstep(0.0, 14.0 + t * 0.02, hh - hr));
    t *= 1.72;
  }
  return sh;
}
#endif
`;

/**
 * Aerial perspective. Analytic exponential-height fog integral along the view
 * ray plus a forward-scattering sun lobe, so a distant island fades from the
 * waterline upward the way real haze does rather than uniformly.
 */
export const WORLD_AERIAL = /* glsl */ `
#ifndef WORLD_AERIAL
#define WORLD_AERIAL
#define AERIAL_SCALE_H 1350.0

float aerialOptical(vec3 camPos, vec3 wp, float dist){
  float hc = max(camPos.y, 0.0);
  float hw = max(wp.y, 0.0);
  float dh = hw - hc;
  if (abs(dh) < 1.0) return dist * exp(-hc / AERIAL_SCALE_H);
  return dist * (AERIAL_SCALE_H / dh) * (exp(-hc / AERIAL_SCALE_H) - exp(-hw / AERIAL_SCALE_H));
}

vec3 worldAerial(vec3 col, vec3 wp, float dist){
  // Weather publishes both a density and a visibility; honour whichever implies
  // the thicker air so the fog preset actually reads as fog.
  float density = max(uFogDensity, 3.0 / max(uVisibility, 200.0));
  float opt = aerialOptical(uCameraPos, wp, dist);
  float t = 1.0 - exp(-opt * density);
  vec3 V = (wp - uCameraPos) / max(dist, 1e-3);
  float cosT = max(0.0, dot(V, uSunDirection));
  float mie = pow(cosT, 8.0) * 0.5 + pow(cosT, 2.0) * 0.07;
  vec3 inscatter = uFogColor * (1.0 + vec3(-0.16, -0.03, 0.24) * t)
                 + uSunColor * (uSunIntensity * 0.016 * mie)
                 + uMoonColor * (uMoonIntensity * 0.02);
  return mix(col, inscatter, clamp(t, 0.0, 1.0));
}
#endif
`;

/** Sky/sun/moon ambient for hand-written world materials. */
export const WORLD_LIGHTING = /* glsl */ `
#ifndef WORLD_LIGHTING
#define WORLD_LIGHTING
// Hemispheric ambient: sky above, ground bounce below.
vec3 worldAmbient(vec3 n, float ao){
  float up = n.y * 0.5 + 0.5;
  vec3 amb = mix(uGroundColor, uSkyColor, up);
  return amb * ao;
}

vec3 worldDirect(vec3 n, vec3 albedo, float shadow, float rough, vec3 V){
  vec3 L = uSunDirection;
  float NoL = max(0.0, dot(n, L));
  vec3 lit = albedo * uSunColor * (uSunIntensity * NoL * shadow) * INV_PI;
  // Moonlight is a second, much dimmer directional with no shadowing.
  float NoM = max(0.0, dot(n, uMoonDirection));
  lit += albedo * uMoonColor * (uMoonIntensity * NoM) * INV_PI;
  // One cheap GGX lobe — wet rock and sand both need a visible sheen.
  vec3 H = normalize(L + V);
  float a = max(0.045, rough * rough);
  float NoH = max(0.0, dot(n, H));
  float NoV = max(1e-3, dot(n, V));
  float spec = D_GGX(NoH, a) * V_SmithGGXCorrelated(NoV, max(NoL, 1e-3), a);
  lit += uSunColor * (uSunIntensity * NoL * shadow * spec * 0.05);
  return lit;
}
#endif
`;
