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
  };
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
`;
