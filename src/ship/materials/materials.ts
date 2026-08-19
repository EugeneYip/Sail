/**
 * One material per visual family. Every one is a patched MeshStandardMaterial
 * so it inherits three's lighting, shadow receive and shadow cast for free,
 * plus three injections of our own:
 *
 *   1. the `shipPart` vertex transform (see shaders/parts.ts)
 *   2. an analytic sky/ground indirect-specular lobe — the scene has no
 *      environment map yet, and without it copper, iron and brass read black
 *   3. salt bleaching and grime on up-facing surfaces, from the world normal
 *
 * `makeDepthFor()` returns the matching customDepthMaterial so animated parts
 * cast the shadow they actually occupy.
 */

import * as THREE from 'three';
import { GLSL } from '../../util/glsl';
import { SHARED_UNIFORM_DECL } from '../../core/SharedUniforms';
import type { SharedUniforms } from '../../types';
import { PARTS_DECL } from '../shaders/parts';
import type { TexSet } from './textures';

export interface PartUniforms {
  uPartQ: { value: THREE.Vector4[] };
  uPartP: { value: THREE.Vector3[] };
}

export interface ShipMatOptions {
  tex: TexSet;
  /** Metres of surface covered by one texture tile, (along, across). */
  tile?: [number, number];
  roughness?: number;
  metalness?: number;
  normalScale?: number;
  /** How much salt/grime collects on up-facing surfaces, 0..1. */
  grime?: number;
  side?: THREE.Side;
  /** Strength of the analytic sky reflection. */
  env?: number;
  color?: number;
}

const VERT_HEAD = /* glsl */ `
attribute float aPart;
varying vec3 vShipWN;
varying vec3 vShipWP;
${PARTS_DECL}
`;

/**
 * GLSL.common names its helper lwLuminance precisely so it cannot collide with
 * the `float luminance(const in vec3)` three emits in its fragment prefix.
 */
export const GLSL_COMMON_SAFE = GLSL.common;

const FRAG_HEAD = /* glsl */ `
varying vec3 vShipWN;
varying vec3 vShipWP;
uniform float uGrime;
uniform float uEnvAmount;
${GLSL_COMMON_SAFE}
${GLSL.brdf}
`;

/**
 * Patch a standard material. Kept in one place so every family gets the same
 * treatment and there is exactly one code path to debug.
 */
export function makeShipMaterial(
  shared: SharedUniforms,
  parts: PartUniforms,
  o: ShipMatOptions,
): THREE.MeshStandardMaterial {
  const tile = o.tile ?? [3.2, 1.28];
  const m = new THREE.MeshStandardMaterial({
    map: o.tex.map,
    normalMap: o.tex.normalMap,
    aoMap: o.tex.ormMap,
    roughnessMap: o.tex.ormMap,
    metalnessMap: o.tex.ormMap,
    roughness: o.roughness ?? 1,
    metalness: o.metalness ?? 1,
    vertexColors: true,
    side: o.side ?? THREE.FrontSide,
    color: o.color ?? 0xffffff,
    aoMapIntensity: 1,
    normalScale: new THREE.Vector2(o.normalScale ?? 1, o.normalScale ?? 1),
    dithering: true,
  });
  // The builders emit UVs in metres; the repeat converts to tile space.
  for (const t of [o.tex.map, o.tex.normalMap, o.tex.ormMap]) {
    void t;
  }
  m.userData.tile = tile;

  const grime = { value: o.grime ?? 0.5 };
  const envAmount = { value: o.env ?? 1 };

  m.onBeforeCompile = (shader) => {
    shader.uniforms.uPartQ = parts.uPartQ;
    shader.uniforms.uPartP = parts.uPartP;
    shader.uniforms.uGrime = grime;
    shader.uniforms.uEnvAmount = envAmount;
    shader.uniforms.uSkyColor = shared.uSkyColor;
    shader.uniforms.uGroundColor = shared.uGroundColor;
    shader.uniforms.uWetness = shared.uWetness;
    shader.uniforms.uTime = shared.uTime;

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_HEAD}`)
      .replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>
        objectNormal = shipPartN(objectNormal, aPart);
        vShipWN = normalize(mat3(modelMatrix) * objectNormal);`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        transformed = shipPart(transformed, aPart);
        vShipWP = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_HEAD}\nuniform vec3 uSkyColor;\nuniform vec3 uGroundColor;\nuniform float uWetness;\nuniform float uTime;`)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          // Salt and grime settle on anything that faces up, and rain darkens it.
          float up = clamp(vShipWN.y, 0.0, 1.0);
          float n = hash13(floor(vShipWP * 3.7));
          float acc = smoothstep(0.42, 0.95, up) * (0.55 + 0.45 * n) * uGrime;
          // Linear albedo of a dried salt crust. 0.78 was brighter than fresh
          // snow and chalked every up-facing surface on the ship.
          vec3 salt = vec3(0.50, 0.51, 0.52);
          diffuseColor.rgb = mix(diffuseColor.rgb, mix(diffuseColor.rgb * 0.72, salt, 0.35), acc);
          diffuseColor.rgb *= mix(1.0, 0.66, uWetness * (0.35 + 0.65 * up));
        }`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.14, uWetness * (0.3 + 0.7 * clamp(vShipWN.y, 0.0, 1.0)));`,
      )
      .replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
        #ifndef USE_ENVMAP
        {
          // Analytic two-lobe sky reflection, ONLY when there is no environment
          // map. With one bound, three's 'lights_fragment_maps' already supplies
          // specular IBL from the same sky and adding this doubles it — which is
          // exactly what over-brightened every ship surface once the radiometry
          // units fix made uSkyColor the right magnitude. uSkyColor and
          // uGroundColor are RADIANCE, so no 1/PI here (see sky/constants.ts).
          vec3 V = normalize(vViewPosition);
          float NoV = clamp(dot(normal, V), 0.001, 1.0);
          vec3 amb = mix(uGroundColor, uSkyColor, clamp(vShipWN.y * 0.5 + 0.5, 0.0, 1.0));
          reflectedLight.indirectSpecular +=
            amb * lwEnvBRDF(material.specularColor, material.roughness, NoV) * uEnvAmount;
        }
        #endif`,
      );
  };
  m.customProgramCacheKey = () => 'ship-std';
  return m;
}

/** The matching depth material so animated parts cast the right shadow. */
export function makeDepthFor(parts: PartUniforms): THREE.MeshDepthMaterial {
  const d = new THREE.MeshDepthMaterial();
  d.onBeforeCompile = (shader) => {
    shader.uniforms.uPartQ = parts.uPartQ;
    shader.uniforms.uPartP = parts.uPartP;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nattribute float aPart;\n${PARTS_DECL}`)
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n        transformed = shipPart(transformed, aPart);',
      );
  };
  d.customProgramCacheKey = () => 'ship-depth';
  return d;
}

export function createPartUniforms(count: number): PartUniforms {
  const q: THREE.Vector4[] = [];
  const p: THREE.Vector3[] = [];
  for (let i = 0; i < count; i++) {
    q.push(new THREE.Vector4(0, 0, 0, 1));
    p.push(new THREE.Vector3());
  }
  return { uPartQ: { value: q }, uPartP: { value: p } };
}

/** Shared uniform declarations for the hand-written (non-standard) materials. */
export const SHIP_SHARED_DECL = SHARED_UNIFORM_DECL;
