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
 * Fraction of DIRECT sunlight that reaches a world-space point through the cloud
 * deck. 1.0 outside the map, and 1.0 whenever there are no clouds.
 *
 * Multiply your direct sun term by this and nothing else. In particular do not
 * also scale the ambient or the fog: 'uSunIntensity' already carries the deck's
 * MEAN attenuation, and 'uCloudShadowStrength' is published as that same mean so
 * that mix(1, T, strength) cannot count the deck twice — at solid overcast the
 * mean has done the work and the strength tapers with it, while at broken cover
 * the strength is near 1 and shadows land at full contrast.
 *
 * One texture fetch. The map is a sea-level slice, so a receiver well above the
 * water drifts by 'altitude / tan(sunElevation)'; at a masthead that is metres
 * against a 50 m shadow feature and not worth correcting.
 */
float lwCloudShadow(vec3 worldPos){
  if (uCloudShadowStrength <= 0.0) return 1.0;
  vec2 uv = (uCloudShadowMatrix * vec4(worldPos, 1.0)).xy;
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return 1.0;
  return mix(1.0, texture2D(uCloudShadowMap, uv).r, uCloudShadowStrength);
}
`;
