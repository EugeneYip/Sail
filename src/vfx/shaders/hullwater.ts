import { GLSL } from '../../util/glsl';
import { SHARED_UNIFORM_DECL } from '../../core/SharedUniforms';

/**
 * The raised, breaking, foaming water the hull pushes around: the bow wave
 * sheet with its overturning lip, the quarter wave at the after shoulder, the
 * transom pad and rooster tail, and the wetted-hull skirt that carries the
 * boot-top band and the foam streaks running aft.
 *
 * All of it is parented to 'shipRoot', so it inherits the ship's visual heave,
 * pitch and roll for free. The waterline is passed in as six sampled heights
 * (port/starboard x bow/mid/stern) converted to ship-local Y, so the sheet sits
 * on the real sea surface rather than on y = 0.
 */

const hullCommon = /* glsl */ `
uniform float uBeam;
uniform float uLwl;
uniform float uSpeed;
uniform float uSpeedN;
uniform float uHeel;
uniform float uRudder;
uniform float uSlam;
uniform float uChop;
uniform vec3  uWaterPort;   // ship-local water Y at (bow, mid, stern), port side
uniform vec3  uWaterStbd;

// Waterline half-beam of a fine-bowed frigate. t = 0 at the stem, 1 at the transom.
float halfBeamAt(float t){
  float u = clamp(t, 0.0, 1.0);
  float fwd = pow(sin(PI * pow(u, 0.58)), 0.62);
  float transom = 0.42 + 0.58 * (1.0 - smoothstep(0.72, 1.0, u));
  return uBeam * 0.5 * fwd * transom;
}

// Quadratic through the three sampled water heights.
float waterYAt(float t, float side){
  vec3 w = side < 0.0 ? uWaterPort : uWaterStbd;
  float u = clamp(t, 0.0, 1.0);
  return u < 0.5
    ? mix(w.x, w.y, u * 2.0)
    : mix(w.y, w.z, (u - 0.5) * 2.0);
}

float hash1(float n){ return fract(sin(n) * 43758.5453123); }
float ruffle(float a, float b, float t){
  return sin(a * 6.13 + t * 3.7) * 0.5 + sin(a * 17.7 - t * 5.1 + b * 3.0) * 0.3
       + sin(a * 41.0 + t * 8.3) * 0.2;
}
`;

export const hullWaterVert = /* glsl */ `
precision highp float;
${GLSL.common}
${SHARED_UNIFORM_DECL}
${hullCommon}
attribute vec3 position;   // x = t along hull, y = j across sheet, z = side (-1/+1)
attribute float aPart;     // 0 = bow/quarter sheet, 1 = transom pad

uniform mat4 modelMatrix;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;

varying vec3  vWorld;
varying float vJ;
varying float vT;
varying float vSide;
varying float vAer;      // aeration 0..1
varying float vThick;
varying float vPart;
varying float vStream;   // metres travelled along the sheet, for the foam UV

void main(){
  float t = position.x;
  float j = position.y;
  float side = position.z;
  vPart = aPart;
  vT = t; vJ = j; vSide = side;

  // Stagnation rise: the height the oncoming stream would climb to if brought
  // to rest. Real bow waves reach a good fraction of it.
  float stag = uSpeed * uSpeed / 19.62;
  float wl = waterYAt(t, side);
  vec3 p;

  if (aPart < 0.5) {
    float hb = halfBeamAt(t);
    // A heeled ship buries its lee bow: that side throws far more water.
    float lee = sign(uHeel) * side;
    float heelGain = 1.0 + lee * min(abs(uHeel) * 4.2, 1.1);
    // Bow crest just aft of the stem, plus the quarter wave at the after
    // shoulder where the buttocks close in again.
    float bowBump = exp(-sq((t - 0.085) / 0.150));
    float quarter = 0.5 * exp(-sq((t - 0.80) / 0.14));
    float slamGain = 1.0 + min(uSlam * 0.05, 1.4);
    float crest = stag * (0.80 * bowBump * slamGain + quarter) * heelGain
                  * smoothstep(0.03, 0.30, uSpeedN);

    float ruf = ruffle(t * 9.0 + side * 3.0, side, uTime) * (0.10 + 0.16 * uChop);
    // j = 0 at the hull/water root, 1 at the tip of the overturning lip. The lip
    // pitches further over the faster we go, which is what turns a smooth bow
    // wave into a breaking one.
    float rise = smoothstep(0.0, 0.66, j);
    float over = smoothstep(0.54, 1.0, j);
    float curl = 0.55 + 0.55 * uSpeedN;
    float y = crest * (rise * (1.0 + ruf * 0.5) - over * curl);
    // The sheet is thrown outboard and slightly aft as it climbs.
    float width = (1.4 + crest * 1.55) * heelGain;
    float outb = hb + width * (j * 0.9 + over * 0.7);
    float zAft = (t + over * 0.045 * (1.0 + uSpeedN)) * uLwl - uLwl * 0.5;

    p = vec3(side * outb, wl + y, zAft);
    vAer = saturate1(0.55 + 0.45 * rise + ruf * 0.4);
    // Thin at the lip, thick at the root — drives both opacity and scattering.
    vThick = (1.0 - over * 0.75) * (0.35 + 0.65 * (1.0 - j)) * saturate1(crest * 1.5);
    vStream = t * uLwl + j * 3.0;
    vJ = j;
  } else {
    // Transom pad + rooster tail. t runs aft of the transom, j across.
    float aft = t;
    float across = j;
    float wash = -uRudder * 0.55;
    float w = uBeam * 0.52 * (1.0 + 0.25 * aft);
    float pad = exp(-aft * 2.1) * (1.0 - abs(across) * 0.35);
    float plume = exp(-sq((across - wash) / 0.3)) * exp(-sq((aft - 0.22) / 0.24));
    float ruf = ruffle(aft * 7.0 + across * 5.0, across, uTime * 1.6) * 0.2;
    float y = stag * (0.5 * pad + 0.85 * plume) * (1.0 + ruf)
              * smoothstep(0.04, 0.34, uSpeedN);
    p = vec3(across * w, wl + y * 0.9, uLwl * 0.5 + aft * uLwl * 0.34);
    vAer = saturate1(0.52 + 0.34 * plume + ruf);
    vThick = saturate1((0.42 * pad + plume) * 1.15);
    vStream = aft * 24.0;
  }

  vec4 wp = modelMatrix * vec4(p, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

export const hullWaterFrag = /* glsl */ `
precision highp float;
${GLSL.common}
${GLSL.fog}
${SHARED_UNIFORM_DECL}
uniform sampler2D tFoam;
uniform float uSpeedN;
uniform float uOpacity;

varying vec3  vWorld;
varying float vJ;
varying float vT;
varying float vSide;
varying float vAer;
varying float vThick;
varying float vPart;
varying float vStream;

void main(){
  if (vThick < 0.004) discard;

  // Foam detail flows aft at the ship's speed relative to the hull.
  float flow = uTime * (2.0 + uSpeedN * 9.0);
  vec2 uvA = vec2(vStream * 0.055 - flow * 0.05, (vJ + vSide * 0.5) * 0.6);
  vec2 uvB = vec2(vStream * 0.145 - flow * 0.11, vJ * 1.7 + vSide);
  vec4 fa = texture2D(tFoam, uvA);
  vec4 fb = texture2D(tFoam, uvB);
  float bubbles = fa.r * 0.55 + fb.r * 0.45;
  float streaks = fa.g * 0.6 + fb.b * 0.4;
  float cover = saturate1(vAer * (0.55 + 0.75 * bubbles) + streaks * 0.25);

  // Aerated water is a bright, strongly forward-scattering medium.
  vec3 view = normalize(uCameraPos - vWorld);
  float sunDot = dot(view, -uSunDirection);
  float forward = pow(saturate1(sunDot), 5.0);
  // The lip is thin enough to light through, and it disperses slightly.
  vec3 disperse = vec3(1.06, 1.0, 0.92) + vec3(-0.10, 0.02, 0.16) * forward;

  // FOAM IS NOT WHITE PAINT. Broadband albedo of whitecaps and aerated water is
  // 0.4..0.55 (Koepke 1984, Frouin 1996); the ocean surface uses 0.38 for the
  // same substance. At the 0.86..0.93 this used to carry, the bow wave was
  // brighter than a sunlit sail and did not match the foam three metres away on
  // the sea, which is the tell that gives away a painted-on effect.
  vec3 albedo = mix(vec3(0.16, 0.26, 0.28), vec3(0.44, 0.47, 0.49), cover);
  // Wrap lighting: foam has no meaningful normal, it is a scattering slab.
  // uSunIntensity is irradiance and owes the 1/PI; uSkyColor / uGroundColor are
  // radiance and must not be divided again (src/sky/constants.ts).
  vec3 sun = uSunColor * uSunIntensity * INV_PI;
  float wrap = 0.55 + 0.45 * saturate1(uSunDirection.y * 1.4);
  vec3 lit = albedo * (sun * wrap * disperse
                       + uSkyColor * 0.85 + uGroundColor * 0.12);
  // Light coming THROUGH the thin part of the lip. Backlit breaking water is
  // the whole reason a bow wave reads as water rather than as paint.
  lit += sun * forward * (1.0 - vThick) * 0.40 * cover * disperse;
  lit += uMoonColor * uMoonIntensity * INV_PI * 0.2;

  float edge = smoothstep(0.0, 0.12, vJ) * (1.0 - smoothstep(0.80, 1.0, vJ));
  if (vPart > 0.5) edge = 1.0 - smoothstep(0.55, 1.0, vT);
  float a = saturate1(vThick * cover * edge * uOpacity * 1.7);
  // Sparse holes so the sheet reads as torn spray rather than a solid skin.
  a *= smoothstep(0.10, 0.45, cover);

  float dist = length(uCameraPos - vWorld);
  lit = applyAerial(lit, dist, -view, uSunDirection, uFogColor, uSunColor,
                    uFogDensity, uCameraPos.y, vWorld.y);

  gl_FragColor = vec4(lit * a, a);
}
`;

/* ------------------------------------------------------------------ *
 *  Wetted hull skirt — boot-top band + foam streaks
 * ------------------------------------------------------------------ */

export const hullSkirtVert = /* glsl */ `
precision highp float;
${GLSL.common}
${SHARED_UNIFORM_DECL}
${hullCommon}
attribute vec3 position;   // x = t along hull, y = v vertical 0..1, z = side
uniform mat4 modelMatrix;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform float uSkirtLow;
uniform float uSkirtHigh;

varying vec3  vWorld;
varying float vT;
varying float vD;       // metres above the local water surface
varying float vSide;
varying float vStream;

void main(){
  float t = position.x;
  float v = position.y;
  float side = position.z;
  float hb = halfBeamAt(t);
  float y = mix(uSkirtLow, uSkirtHigh, v);
  // Flare the section slightly above the waterline, like real topsides.
  float flare = 1.0 + max(y, 0.0) * 0.035;
  vec3 p = vec3(side * (hb * flare + 0.09), y, t * uLwl - uLwl * 0.5);

  vT = t; vSide = side;
  vD = y - waterYAt(t, side);
  vStream = t * uLwl;
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

export const hullSkirtFrag = /* glsl */ `
precision highp float;
${GLSL.common}
${GLSL.fog}
${SHARED_UNIFORM_DECL}
uniform sampler2D tFoam;
uniform float uSpeedN;
uniform float uOpacity;
uniform float uChop;

varying vec3  vWorld;
varying float vT;
varying float vD;
varying float vSide;
varying float vStream;

void main(){
  float flow = uTime * (1.5 + uSpeedN * 11.0);
  // Streaks are long along the hull and thin vertically.
  vec2 uvA = vec2(vStream * 0.028 - flow * 0.055, vD * 0.22 + vSide * 0.5);
  vec2 uvB = vec2(vStream * 0.085 - flow * 0.13, vD * 0.55 + vSide);
  float s1 = texture2D(tFoam, uvA).g;
  float s2 = texture2D(tFoam, uvB).b;
  float bub = texture2D(tFoam, uvB * vec2(2.0, 3.0)).r;

  // Boot top: the strip that has just been wetted, riding the local surface.
  float wetBand = (1.0 - smoothstep(0.0, 0.55 + uChop * 0.5, vD)) * step(-1.6, vD);
  float submerged = 1.0 - smoothstep(-0.9, 0.05, vD);

  // Foam streaks: born at the bow shoulder, dragged aft, strongest at the
  // waterline and climbing higher the faster we go.
  float bowGain = 0.35 + 1.5 * exp(-vT * 4.5);
  float climb = 1.0 - smoothstep(0.15 + uSpeedN * 1.5, 0.9 + uSpeedN * 2.6, vD);
  float streak = saturate1((s1 * 0.65 + s2 * 0.5) * 1.55 - 0.42) * bowGain * climb;
  float foamA = saturate1(streak * smoothstep(0.05, 0.32, uSpeedN) * 1.5
                          + wetBand * bub * 0.22 * uSpeedN);

  vec3 view = normalize(uCameraPos - vWorld);
  float wrap = 0.5 + 0.5 * saturate1(uSunDirection.y * 1.5);
  vec3 sun = uSunColor * uSunIntensity * INV_PI;
  // Same foam albedo as the bow sheet and the ocean surface — see the note there.
  vec3 foamCol = vec3(0.44, 0.47, 0.49) * (sun * wrap + uSkyColor * 0.9);
  // Wet paint: darker, much glossier. A sharp specular sells it — and a mirror
  // returns sun RADIANCE, so this term is scaled against 'sun * PI', not 'sun'.
  float spec = pow(saturate1(dot(reflect(-uSunDirection, vec3(0.0, 1.0, 0.0)), view)), 26.0);
  vec3 wetCol = uSkyColor * 0.55 + sun * spec * 7.0;

  float wetA = (wetBand * 0.5 + submerged * 0.34) * (0.35 + 0.65 * uWetness * 0.5 + 0.4);
  wetA = saturate1(wetA * uOpacity);
  foamA = saturate1(foamA * uOpacity);

  vec3 rgb = foamCol * foamA + wetCol * wetA * (1.0 - foamA);
  float a = foamA + wetA * (1.0 - foamA);
  if (a < 0.004) discard;

  float dist = length(uCameraPos - vWorld);
  rgb = applyAerial(rgb, dist, -view, uSunDirection, uFogColor * a, uSunColor,
                    uFogDensity, uCameraPos.y, vWorld.y);
  gl_FragColor = vec4(rgb, a);
}
`;
