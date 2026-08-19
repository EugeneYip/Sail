import * as THREE from 'three';
import type { SharedUniforms } from '../types';

/**
 * One uniform object graph shared by every custom material in the game.
 * Because the objects are shared by reference, writing `uniforms.uTime.value`
 * once per frame updates every shader that uses it — no per-material loops.
 *
 * Materials should spread these into their own uniform blocks:
 *   uniforms: { ...world.uniforms, uMyThing: { value: 1 } }
 * ...but note that spreading copies the *references*, which is exactly what we
 * want. Never deep-clone them.
 */
export function createSharedUniforms(): SharedUniforms {
  return {
    uTime: { value: 0 },
    uDt: { value: 1 / 60 },
    uSunDirection: { value: new THREE.Vector3(0.3, 0.5, -0.8).normalize() },
    uSunColor: { value: new THREE.Color(1.0, 0.96, 0.9) },
    uSunIntensity: { value: 12.0 },
    uMoonDirection: { value: new THREE.Vector3(-0.3, -0.5, 0.8).normalize() },
    uMoonColor: { value: new THREE.Color(0.55, 0.68, 0.95) },
    uMoonIntensity: { value: 0.0 },
    uSkyColor: { value: new THREE.Color(0.28, 0.45, 0.72) },
    uGroundColor: { value: new THREE.Color(0.05, 0.09, 0.13) },
    uFogColor: { value: new THREE.Color(0.62, 0.72, 0.83) },
    uFogDensity: { value: 0.00018 },
    uVisibility: { value: 22000 },
    uCameraPos: { value: new THREE.Vector3() },
    uOrigin: { value: new THREE.Vector3() },
    uWind: { value: new THREE.Vector3(1, 0, 0) },
    uWindSpeed: { value: 7 },
    uExposure: { value: 1 },
    uWetness: { value: 0 },
    // TAA sub-pixel jitter currently baked into the projection matrix, NDC.
    // (0,0) whenever TAA is off. Any shader that reprojects during the scene
    // pass must subtract this from its NDC before using a previous-frame
    // matrix; see the contract in post/Pipeline.ts.
    uJitter: { value: new THREE.Vector2() },
    // Cloud shadows. Written by the sky module every frame; sample them with
    // lwCloudShadow() below rather than by hand. Defaults are "no clouds", so a
    // material can use them unconditionally even before the sky module is up.
    uCloudShadowMap: { value: whitePixel() },
    uCloudShadowMatrix: { value: new THREE.Matrix4() },
    uCloudShadowStrength: { value: 0 },
  };
}

/** 1x1 white — the "nothing is shadowed" default for `uCloudShadowMap`. */
function whitePixel(): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  t.needsUpdate = true;
  return t;
}

/** GLSL that every custom material can `#include` by string concatenation. */
export const SHARED_UNIFORM_DECL = /* glsl */ `
uniform float uTime;
uniform float uDt;
uniform vec3  uSunDirection;
uniform vec3  uSunColor;
uniform float uSunIntensity;
uniform vec3  uMoonDirection;
uniform vec3  uMoonColor;
uniform float uMoonIntensity;
uniform vec3  uSkyColor;
uniform vec3  uGroundColor;
uniform vec3  uFogColor;
uniform float uFogDensity;
uniform float uVisibility;
uniform vec3  uCameraPos;
uniform vec3  uOrigin;
uniform vec3  uWind;
uniform float uWindSpeed;
uniform float uExposure;
uniform float uWetness;
uniform vec2  uJitter;
uniform sampler2D uCloudShadowMap;
uniform mat4  uCloudShadowMatrix;
uniform float uCloudShadowStrength;

/**
 * RELATIVE modulation of the direct sun at a world-space point: how much light
 * this spot gets compared with the deck's average. 1.0 outside the map, 1.0 with
 * no clouds, above 1 in a sunlit gap and near 0 under a thick cell.
 *
 * Multiply your direct sun term by this and nothing else. Do not also scale the
 * ambient or the fog.
 *
 * The map holds ABSOLUTE transmittance along the sun ray. 'uSunIntensity' has
 * already been multiplied by the deck's MEAN transmittance, and
 * 'uCloudShadowStrength' is published as exactly that mean — so the value that
 * does not double-count the deck is the RATIO, not a blend. This used to be
 * 'mix(1.0, T, strength)', which is neither: at a mean of 0.7 it lit a gap at
 * 0.7 of full sun and a shadow at 0.23 instead of 0.035, so the contrast between
 * sunlit water and shadowed water came out 3:1 when it should be nearly 30:1 —
 * and under a real overcast, where the mean is small, it faded the shadows out
 * altogether just when the sky was most dramatic. Moving cloud shadow on open
 * water is the largest single realism win the sky has to give the sea; it is
 * worth getting the algebra right.
 *
 * Clamped above 1 rather than free, because a gap under a very dark deck would
 * otherwise ask for a 25x spike and blow the highlight out.
 *
 * One texture fetch. The map is a sea-level slice, so a receiver well above the
 * water drifts by 'altitude / tan(sunElevation)'; at a masthead that is metres
 * against a 50 m shadow feature and not worth correcting.
 */
float lwCloudShadow(vec3 worldPos){
  if (uCloudShadowStrength <= 0.0) return 1.0;
  vec2 uv = (uCloudShadowMatrix * vec4(worldPos, 1.0)).xy;
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return 1.0;
  float t = texture2D(uCloudShadowMap, uv).r;
  return clamp(t / max(uCloudShadowStrength, 0.05), 0.0, 1.35);
}
`;
