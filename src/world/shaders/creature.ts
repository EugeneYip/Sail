import { GLSL } from '../../util/glsl';
import { SHARED_UNIFORM_DECL } from '../../core/SharedUniforms';
import { WORLD_AERIAL, WORLD_LIGHTING } from './wcommon';

/**
 * One program for every living thing in the world: gulls, dolphins, whales,
 * fish. The geometry differs, the animation does not — a wing is a spanwise
 * dihedral bend and a fluke is a travelling wave along the body, so both fall
 * out of the same four lines of vertex maths with different per-instance
 * amplitudes.
 *
 * Per-vertex `aAux` is (bodyT, spanT, membrane, spare):
 *   bodyT    0 at the nose, 1 at the tail tip — drives the swimming wave
 *   spanT    0 at the wing root, 1 at the tip — drives the flap
 *   membrane 0 = solid flesh, 1 = a thin blade that glows when backlit
 *
 * Per-instance:
 *   aXf (x, y, z, yaw)          render-space origin and heading
 *   aMo (pitch, roll, scale, phase)
 *   aBd (flapAmp, bendY, bendX, tint)
 *   aEx (waterY, wet, spare, spare)
 *
 * Instances with scale 0 collapse to degenerate triangles and cost no
 * rasterisation, which is how a pool of 160 gulls draws 40 of them.
 */
export const creatureVert = /* glsl */ `
precision highp float;
${SHARED_UNIFORM_DECL}
${GLSL.common}

attribute vec3 aCol;
attribute vec4 aAux;
attribute vec4 aXf;
attribute vec4 aMo;
attribute vec4 aBd;
attribute vec4 aEx;

uniform float uWaveK;     // radians of travelling wave along the body
uniform float uFlapBend;  // how much of the flap is spanwise bend vs rigid roll

varying vec3  vWorld;
varying vec3  vNormal;
varying vec3  vCol;
varying float vDist;
varying float vMembrane;
varying float vSub;
varying float vWet;

void main(){
  vec3 p = position;
  vec3 n = normal;

  // --- travelling wave: cetaceans beat vertically, fish laterally
  float t = aAux.x;
  float w = t * t;
  float phase = aMo.w - t * uWaveK;
  float sw = sin(phase);
  p.y += sw * aBd.y * w;
  p.x += sw * aBd.z * w;
  // Rotate the normal by the slope of the wave so the flanks still shade.
  float slope = cos(phase) * uWaveK * w;
  n.y -= slope * aBd.y * 0.6;
  n.x -= slope * aBd.z * 0.6;

  // --- flap: symmetric dihedral hinge on the centreline, weighted spanwise
  float span = aAux.y;
  if (span > 0.001) {
    float ang = sin(aMo.w) * aBd.x * mix(span, span * span, uFlapBend);
    float sgn = p.x >= 0.0 ? 1.0 : -1.0;
    float r = abs(p.x);
    float ca = cos(ang), sa = sin(ang);
    p = vec3(sgn * (r * ca - p.y * sa), r * sa + p.y * ca, p.z);
    float rn = abs(n.x);
    n = vec3(sgn * (rn * ca - n.y * sa), rn * sa + n.y * ca, n.z);
  }

  p *= aMo.z;

  // --- pitch, roll, yaw, in the game's conventions: yaw is a meteorological
  // bearing (0 = north = -Z, +90 deg = east = +X), positive pitch is bow up,
  // positive roll puts the starboard side down. Cheaper than a quaternion.
  float cp = cos(aMo.x), sp = sin(aMo.x);
  p = vec3(p.x, p.y * cp - p.z * sp, p.y * sp + p.z * cp);
  n = vec3(n.x, n.y * cp - n.z * sp, n.y * sp + n.z * cp);
  float cr = cos(aMo.y), sr = sin(aMo.y);
  p = vec3(p.x * cr + p.y * sr, -p.x * sr + p.y * cr, p.z);
  n = vec3(n.x * cr + n.y * sr, -n.x * sr + n.y * cr, n.z);
  float cy = cos(aXf.w), sy = sin(aXf.w);
  p = vec3(p.x * cy - p.z * sy, p.y, p.x * sy + p.z * cy);
  n = vec3(n.x * cy - n.z * sy, n.y, n.x * sy + n.z * cy);

  vec3 wp = aXf.xyz + p;
  vWorld = wp;
  vNormal = n;
  vCol = aCol * aBd.w;
  vDist = distance(wp, uCameraPos);
  vMembrane = aAux.z;
  vSub = aEx.x - wp.y;
  vWet = aEx.y;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

export const creatureFrag = /* glsl */ `
precision highp float;
${SHARED_UNIFORM_DECL}
${GLSL.common}
${GLSL.brdf}
${WORLD_LIGHTING}
${WORLD_AERIAL}

varying vec3  vWorld;
varying vec3  vNormal;
varying vec3  vCol;
varying float vDist;
varying float vMembrane;
varying float vSub;
varying float vWet;

void main(){
  vec3 V = normalize(uCameraPos - vWorld);
  vec3 N = normalize(vNormal);
  // Wings and flukes are single-sided blades drawn double-sided; face the
  // normal at the camera so the far side is not black.
  if (dot(N, V) < 0.0) N = -N;

  vec3 albedo = vCol;
  float wet = clamp(vWet + linstep(0.35, -0.1, vSub) * 0.7, 0.0, 1.0);
  float rough = mix(0.62, 0.12, wet);
  albedo *= mix(1.0, 0.72, wet);

  vec3 col = worldDirect(N, albedo, 1.0, rough, V) + worldAmbient(N, 1.0) * albedo;

  // Backlit membrane: a gull's primaries and a fluke both light up when the sun
  // is behind them, and it is most of what makes them read against a bright sky.
  float back = max(0.0, dot(-N, uSunDirection));
  col += albedo * uSunColor * (uSunIntensity * pow(back, 1.7) * vMembrane * 0.85) * INV_PI;

  // Sliding under the surface: the water eats red first, so a dolphin's back
  // goes green-blue a metre down instead of simply darker.
  float sub = linstep(0.0, 1.4, vSub);
  vec3 deep = col * vec3(0.16, 0.44, 0.52) + uSkyColor * 0.03;
  col = mix(col, deep, sub * 0.88);

  col = worldAerial(col, vWorld, vDist);
  gl_FragColor = vec4(col, 1.0);
}
`;

/**
 * The blow. A soft camera-facing plume with a floor on its screen size, because
 * a physically-sized 7 m spout is one pixel at 3 km and the entire point of a
 * spout is that you can see it from a long way off.
 *
 * Per-instance: aXf (x, y, z, size), aMo (age01, lean, seed, brightness).
 */
export const spoutVert = /* glsl */ `
precision highp float;
${SHARED_UNIFORM_DECL}
${GLSL.common}

attribute vec4 aXf;
attribute vec4 aMo;

uniform float uPxScale;   // world units per pixel, per metre of distance
uniform float uMinPx;

varying vec2  vUv;
varying vec3  vWorld;
varying float vAge;
varying float vSeed;
varying float vBright;

void main(){
  vec3 c = aXf.xyz;
  float d = distance(c, uCameraPos);
  float size = max(aXf.w, uMinPx * uPxScale * d);

  vec3 fwd = normalize(uCameraPos - c);
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), fwd));
  vec3 up = cross(fwd, right);

  vec2 q = position.xy;
  vUv = q + 0.5;
  // The plume leans downwind and spreads as it ages.
  float spread = 0.42 + aMo.x * 0.95;
  vec3 wp = c + right * (q.x * size * spread + aMo.y * size * vUv.y)
              + up * ((q.y + 0.5) * size * 2.1);

  vWorld = wp;
  vAge = aMo.x;
  vSeed = aMo.z;
  vBright = aMo.w;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

export const spoutFrag = /* glsl */ `
precision highp float;
${SHARED_UNIFORM_DECL}
${GLSL.common}
${GLSL.noise2d}
${WORLD_AERIAL}

varying vec2  vUv;
varying vec3  vWorld;
varying float vAge;
varying float vSeed;
varying float vBright;

void main(){
  vec2 q = vUv - vec2(0.5, 0.0);
  // A cone: narrow at the blowhole, wide and ragged at the top.
  float wide = 0.10 + vUv.y * 0.42;
  float radial = linstep(wide, 0.0, abs(q.x));
  float top = linstep(1.0, 0.55, vUv.y) * linstep(0.0, 0.12, vUv.y);
  float mist = noise2(vec2(q.x * 7.0, vUv.y * 4.0 - uTime * 1.4) + vSeed) * 0.5 + 0.5;
  float a = radial * top * (0.45 + 0.55 * mist);
  a *= linstep(1.0, 0.35, vAge) * vBright;
  if (a < 0.004) discard;

  // Water vapour: bright, almost white, and it scatters the sun hard.
  vec3 lit = uSkyColor * 1.3 + uSunColor * uSunIntensity * 0.09
           + uMoonColor * uMoonIntensity * 0.05;
  float d = distance(vWorld, uCameraPos);
  lit = worldAerial(lit, vWorld, d);
  gl_FragColor = vec4(lit, clamp(a * 0.85, 0.0, 1.0));
}
`;
