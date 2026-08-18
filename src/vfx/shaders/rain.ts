import { GLSL } from '../../util/glsl';
import { SHARED_UNIFORM_DECL } from '../../core/SharedUniforms';

/**
 * Falling rain, drawn as one instanced quad per streak.
 *
 * Each instance owns a fixed random point inside a world-space box that is
 * wrapped around the camera every frame, so drops stay put in the world and
 * parallax correctly — the box only ever re-homes a drop as it leaves the
 * far edge, where it is already faded out. The fall offset is pre-wrapped on
 * the CPU so `uTime * speed` never grows large enough to lose precision.
 *
 * A small fraction of instances are flagged as the near layer: a tiny box a
 * couple of metres across, with much larger, much softer sprites. That is the
 * out-of-focus foreground, and it is what makes rain read as *near* rather
 * than as a texture on the sky.
 */

export const rainVert = /* glsl */ `
precision highp float;
${GLSL.common}
${SHARED_UNIFORM_DECL}
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
attribute vec3 position;    // quad corner, -1..1
attribute vec4 aSeed;       // xyz = cell position 0..1, w = per-drop random

uniform vec3  uBox;         // far-layer box dimensions, metres
uniform vec3  uOffset;      // pre-wrapped fall + drift offset, far layer
uniform vec3  uOffsetNear;  // ditto for the near layer's much smaller box
uniform vec3  uVel;         // rain velocity, m/s, world
uniform float uShear;       // extra horizontal drift per metre of height
uniform float uWidth;       // streak half-width, metres
uniform float uExposure;    // streak length in seconds of "shutter"
uniform float uNearFrac;    // fraction of instances assigned to the near layer

varying vec2  vUv;
varying float vFade;
varying float vNear;

void main(){
  float near = step(aSeed.w, uNearFrac);
  vec3 box = mix(uBox, vec3(3.2, 2.6, 3.2), near);
  vec3 lo = uCameraPos - box * 0.5;

  vec3 p = aSeed.xyz * box + mix(uOffset, uOffsetNear, near);
  p = mod(p - lo, box) + lo;
  // Wind shear: the higher the drop, the further downwind it has been carried.
  p.xz += uVel.xz * (p.y - uCameraPos.y) * uShear;

  vec3 rel = p - uCameraPos;
  float dxz = length(rel.xz);
  // Fade at the box rim (where wrapping happens) and right at the lens.
  vFade = (1.0 - smoothstep(box.x * 0.30, box.x * 0.49, dxz))
        * smoothstep(near > 0.5 ? 0.30 : 2.0, near > 0.5 ? 0.75 : 7.0, length(rel));
  vNear = near;
  if (vFade <= 0.002){ gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }

  vec4 mv = viewMatrix * vec4(p, 1.0);
  vec3 vd = mat3(viewMatrix) * uVel;
  vec2 axis = normalize(vd.xy + vec2(1e-5, -1e-5));

  float halfW = uWidth * mix(1.0, 6.5, near);
  float halfL = 0.5 * length(uVel) * uExposure * mix(1.0, 0.55, near) + halfW;
  vec2 off = vec2(position.x * halfW, position.y * halfL);
  mv.xy += vec2(off.x * axis.y + off.y * axis.x, -off.x * axis.x + off.y * axis.y);
  gl_Position = projectionMatrix * mv;
  vUv = position.xy * 0.5 + 0.5;
}
`;

export const rainFrag = /* glsl */ `
precision highp float;
${GLSL.common}
${SHARED_UNIFORM_DECL}
uniform sampler2D tStreak;
uniform float uIntensity;

varying vec2  vUv;
varying float vFade;
varying float vNear;

void main(){
  vec4 t = texture2D(tStreak, vUv);
  // The near layer is out of focus: throw away the core, keep only the halo.
  float cover = mix(t.a, t.g * 0.55, vNear);
  float a = cover * vFade * uIntensity * mix(0.5, 0.16, vNear);
  if (a < 0.003) discard;

  // A rain streak is a lens: it is mostly a smeared image of whatever is
  // behind and above it, which in practice means the sky and the sun.
  vec3 col = uSkyColor * 1.25 + uFogColor * 0.65;
  col += uSunColor * uSunIntensity * INV_PI * 0.09 * mix(t.r, 0.3, vNear);
  col += uMoonColor * uMoonIntensity * 0.12;
  gl_FragColor = vec4(col * a, a);
}
`;

/* ------------------------------------------------------------------ *
 *  Water on the lens
 * ------------------------------------------------------------------ */

/**
 * Droplets clinging to the front element, drawn on a camera-locked quad in
 * front of the near plane.
 *
 * We cannot sample the scene from here — the post stack owns that — so the
 * beads are lit rather than refractive: a bright Fresnel ring, a dim body
 * carrying sky colour, and a hot specular pip toward the sun. Against a dark
 * storm sky that is exactly what water on glass looks like. Deliberately
 * sparse; the effect dies completely below `rain ~ 0.4`.
 */
export const lensVert = /* glsl */ `
precision highp float;
attribute vec3 position;
varying vec2 vUv;
void main(){
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const lensFrag = /* glsl */ `
precision highp float;
${GLSL.common}
${SHARED_UNIFORM_DECL}
uniform float uIntensity;
uniform vec2  uAspect;
uniform vec2  uDrift;     // accumulated shed offset, uv
uniform vec2  uSunUv;     // sun position in uv, or (-1,-1) when behind
uniform float uSeed;

varying vec2 vUv;

// One bead per jittered cell, with a slow downward crawl that stalls and slips
// the way surface tension actually behaves.
vec4 bead(vec2 uv, float scale, float seedOff, float sizeMul){
  vec2 p = uv * scale;
  vec2 id = floor(p);
  vec2 f = fract(p);
  vec4 best = vec4(0.0);
  for (int j = -1; j <= 1; j++){
    for (int i = -1; i <= 1; i++){
      vec2 o = vec2(float(i), float(j));
      vec2 cell = id + o;
      vec3 h = hash32(cell + seedOff);
      if (h.z > 0.30) continue;                       // most cells are empty
      // Slip-stick crawl, slower for small beads.
      float t = uTime * (0.05 + h.z * 0.5) + h.x * 9.0;
      float slip = floor(t) + smoothstep(0.55, 1.0, fract(t));
      vec2 c = o + vec2(h.x, fract(h.y - slip * 0.055));
      vec2 d = f - c;
      float rad = (0.10 + h.z * 0.5) * sizeMul;
      float m = 1.0 - smoothstep(rad * 0.72, rad, length(d));
      if (m > best.w) best = vec4(d / max(rad, 1e-4), length(d) / max(rad, 1e-4), m);
    }
  }
  return best;
}

void main(){
  if (uIntensity < 0.004) discard;
  vec2 uv = vUv * uAspect + uDrift;

  vec4 b1 = bead(uv, 7.0, uSeed, 1.0);
  vec4 b2 = bead(uv, 15.0, uSeed + 31.0, 0.8);
  vec4 b = b1.w > b2.w ? b1 : b2;
  float m = b.w;
  if (m < 0.004) discard;

  float rn = saturate1(b.z);
  // Fake a hemispherical bead normal so the ring lights correctly.
  vec3 n = normalize(vec3(b.xy, sqrt(max(0.02, 1.0 - rn * rn)) * 1.25));
  float fres = pow(1.0 - saturate1(n.z), 2.2);

  vec3 col = uSkyColor * (0.35 + 0.9 * fres) + uFogColor * 0.35;
  if (uSunUv.x > -0.5){
    vec2 sd = (vUv - uSunUv) * uAspect - n.xy * 0.06;
    col += uSunColor * uSunIntensity * INV_PI * 0.5 * exp(-dot(sd, sd) * 40.0) * (0.3 + fres);
  }
  col += uMoonColor * uMoonIntensity * 0.25 * fres;

  float a = m * uIntensity * (0.16 + 0.5 * fres);
  gl_FragColor = vec4(col * a, a);
}
`;

/* ------------------------------------------------------------------ *
 *  Lightning bolt
 * ------------------------------------------------------------------ */

export const boltVert = /* glsl */ `
precision highp float;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
attribute vec3 position;
attribute vec2 aInfo;     // x = brightness, y = along-channel 0..1
varying float vBright;
varying float vAlong;
void main(){
  vBright = aInfo.x;
  vAlong = aInfo.y;
  gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
}
`;

export const boltFrag = /* glsl */ `
precision highp float;
${GLSL.common}
uniform float uFlicker;
uniform vec3  uColor;
varying float vBright;
varying float vAlong;
void main(){
  // The channel dims and reddens toward the tip as the current dies.
  float a = vBright * uFlicker * mix(1.0, 0.5, vAlong);
  if (a < 0.002) discard;
  // Hot white core bleeding to blue in the corona.
  vec3 col = uColor * (0.6 + 3.4 * a) + vec3(1.0) * a * 5.0;
  gl_FragColor = vec4(col * a, 0.0);
}
`;

/** Broad soft glow standing in for the illuminated cloud mass. */
export const glowVert = /* glsl */ `
precision highp float;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
attribute vec3 position;
uniform vec3  uCentre;
uniform float uRadius;
varying vec2 vLocal;
void main(){
  vLocal = position.xy;
  vec4 mv = viewMatrix * vec4(uCentre, 1.0);
  mv.xy += position.xy * uRadius;
  gl_Position = projectionMatrix * mv;
}
`;

export const glowFrag = /* glsl */ `
precision highp float;
${GLSL.common}
uniform float uAmp;
uniform vec3  uColor;
varying vec2 vLocal;
void main(){
  float r = length(vLocal);
  if (r > 1.0 || uAmp < 0.001) discard;
  float e = pow(1.0 - r, 2.6);
  gl_FragColor = vec4(uColor * e * uAmp, 0.0);
}
`;
