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
import { DETAIL_DECL } from '../shaders/detail';
import type { TexSet } from './textures';

export interface PartUniforms {
  uPartQ: { value: THREE.Vector4[] };
  uPartP: { value: THREE.Vector3[] };
}

/**
 * Per-pixel detail parameters, all in metres or 0..1 amplitudes. See
 * `shaders/detail.ts` for what each tier does and why it is not in a texture.
 */
export interface DetailOptions {
  /** Oak ring spacing, metres. White oak runs 6-14 mm. */
  ringPitch?: number;
  /** How much darker the latewood line is, 0..1 of albedo. */
  ringAlbedo?: number;
  /** Relief of the ring figure, metres. */
  ringRelief?: number;
  /** Roughness swing across a ring, 0..1. */
  ringRough?: number;
  /** Plank width, metres. 0 leaves the surface unplanked. */
  plankPitch?: number;
  /** Half-width of a caulked seam, metres. Real caulk is 3 mm each side. */
  seamWidth?: number;
  /** How dark the caulk is, 0..1. */
  seamDark?: number;
  /** Relief of the fibre tier, metres. */
  fibreRelief?: number;
  /** Fibre / pore spacing, metres. */
  fibrePitch?: number;
  /** Albedo swing of the fibre tier, 0..1. */
  fibreAlbedo?: number;
  /** Per-board tonal spread, 0..1. */
  plankTone?: number;
  /** Traffic wear: scrubbed pale and smooth along the paths, 0..1. */
  wear?: number;
  /** Roughness swing from the fibre tier — the whole story on metals. */
  fibreRough?: number;
  /** Per-board roughness spread, 0..1. */
  plankRough?: number;
  /**
   * Mean board length between butt joints, metres. A deck board is 6-8 m; a
   * sheet of copper sheathing on the bottom is four feet. 0 keeps the timber
   * default of 5.6-8.0 m.
   */
  boardLen?: number;
  /** Spread of the board length, metres. */
  boardJitter?: number;
  /** Coarse figure (ray fleck, streaking) spacing, metres. 0 disables. */
  figurePitch?: number;
  /** Albedo swing of the figure tier, 0..1. */
  figureAlbedo?: number;
  /** Relief of the figure tier, metres. */
  figureRelief?: number;
  /** Roughness swing of the figure tier, 0..1. */
  figureRough?: number;
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
  detail?: DetailOptions;
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
uniform vec2 uTileM;
uniform vec4 uDetailA;
uniform vec4 uDetailB;
uniform vec4 uDetailC;
uniform vec4 uDetailD;
uniform vec4 uDetailE;
${GLSL_COMMON_SAFE}
${GLSL.noise2d}
${GLSL.brdf}
${GLSL.surface}
${DETAIL_DECL}
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

  const d = o.detail ?? {};
  const tileM = { value: new THREE.Vector2(tile[0], tile[1]) };
  const detailA = {
    value: new THREE.Vector4(
      d.ringPitch ?? 0.009, d.ringAlbedo ?? 0, d.ringRelief ?? 0, d.ringRough ?? 0,
    ),
  };
  const detailB = {
    value: new THREE.Vector4(
      d.plankPitch ?? 0, d.seamWidth ?? 0.003, d.seamDark ?? 0, d.fibreRelief ?? 0,
    ),
  };
  const detailC = {
    value: new THREE.Vector4(
      d.fibrePitch ?? 0.0016, d.fibreAlbedo ?? 0, d.plankTone ?? 0, d.wear ?? 0,
    ),
  };
  const detailD = {
    value: new THREE.Vector4(
      d.fibreRough ?? 0, d.plankRough ?? 0, d.boardLen ?? 0, d.boardJitter ?? 0,
    ),
  };
  // The tier that carries the surface at a two-metre viewing distance, where the
  // fibre tier above has already faded to nothing. Off by default so a family
  // that has no business having wood figure (glass) simply omits it.
  const detailE = {
    value: new THREE.Vector4(
      d.figurePitch ?? 0, d.figureAlbedo ?? 0, d.figureRelief ?? 0, d.figureRough ?? 0,
    ),
  };

  m.onBeforeCompile = (shader) => {
    shader.uniforms.uPartQ = parts.uPartQ;
    shader.uniforms.uPartP = parts.uPartP;
    shader.uniforms.uGrime = grime;
    shader.uniforms.uEnvAmount = envAmount;
    shader.uniforms.uTileM = tileM;
    shader.uniforms.uDetailA = detailA;
    shader.uniforms.uDetailB = detailB;
    shader.uniforms.uDetailC = detailC;
    shader.uniforms.uDetailD = detailD;
    shader.uniforms.uDetailE = detailE;
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
        // Declared at function scope so the roughness, AO and normal stages
        // below consume the same evaluation instead of running it four times.
        vec2 lwDetG = vec2(0.0);
        float lwDetRgh = 0.0;
        float lwDetAo = 1.0;
        {
          // vMapUv is in tile units; uTileM converts it to metres, which is the
          // only frame in which a 6 mm caulk seam or a 9 mm growth ring can be
          // asked to hold its size independently of the texture resolution.
          float lwDetAlb;
          lwWoodDetail(vMapUv * uTileM, uDetailA, uDetailB, uDetailC, uDetailD,
                       uDetailE, lwDetAlb, lwDetRgh, lwDetAo, lwDetG);
          diffuseColor.rgb *= lwDetAlb;
        }
        {
          // Salt and grime settle on anything that faces up, and rain darkens it.
          float up = clamp(vShipWN.y, 0.0, 1.0);
          float n = hash13(floor(vShipWP * 3.7));
          float acc = smoothstep(0.42, 0.95, up) * (0.72 + 0.28 * n) * uGrime;
          // Linear albedo of a dried salt crust. 0.78 was brighter than fresh
          // snow and chalked every up-facing surface on the ship; 0.50 mixed at
          // 0.35 still did, just less. The deck faces up more squarely than
          // anything else on the ship, so it took the full dose — and pulling a
          // third of the way to a NEUTRAL grey is what killed it: it desaturated
          // the timber until the grain had nothing left to be visible against,
          // which read in the frame as bleached lavender board. A holystoned
          // deck is pale, but it is pale OAK. Salt mostly dulls and darkens; the
          // lightening is the small part of it.
          vec3 salt = vec3(0.44, 0.45, 0.46);
          diffuseColor.rgb = mix(diffuseColor.rgb, mix(diffuseColor.rgb * 0.78, salt, 0.18), acc);
          diffuseColor.rgb *= mix(1.0, 0.66, uWetness * (0.35 + 0.65 * up));
        }`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor = clamp(roughnessFactor + lwDetRgh, 0.04, 1.0);
        roughnessFactor = mix(roughnessFactor, 0.14, uWetness * (0.3 + 0.7 * clamp(vShipWN.y, 0.0, 1.0)));`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#ifdef USE_NORMALMAP_TANGENTSPACE
        {
          // The baked map carries everything down to a centimetre; the detail
          // tier carries the grain, pores and seam grooves below that. Layering
          // them with reoriented normal mapping keeps the baked slope intact
          // instead of the base being flattened by a whitened detail average,
          // which is what a naive add or overwrite does.
          vec3 mapN = texture2D(normalMap, vNormalMapUv).xyz * 2.0 - 1.0;
          mapN.xy *= normalScale;
          // tbn[0] is the unit world direction of +u, so lwDetG — a slope per
          // metre in the same (along, across) frame — needs no rescaling.
          vec3 detN = normalize(vec3(-lwDetG.x, -lwDetG.y, 1.0));
          normal = normalize(tbn * blendNormalRNM(normalize(mapN), detN));
        }
        #endif`,
      )
      .replace(
        '#include <aomap_fragment>',
        `#include <aomap_fragment>
        {
          float lwAo = lwDetAo;
          reflectedLight.indirectDiffuse *= lwAo;
          #if defined( USE_ENVMAP ) && defined( STANDARD )
            reflectedLight.indirectSpecular *= lwAo;
          #endif
        }`,
      )
      .replace(
        '#include <lights_fragment_maps>',
        `#include <lights_fragment_maps>
        #if defined( USE_ENVMAP ) && defined( RE_IndirectSpecular )
          // 'env' is the per-family reflection strength: 1.5 on brass, 0.6 on a
          // painted deck. It used to scale the analytic lobe below, which is now
          // compiled out whenever scene.environment is bound — and sky/EnvProbe
          // binds it unconditionally, so the option had gone silently inert and
          // every family was reflecting at 1.0. Scale three's own specular IBL
          // instead. Deliberately NOT iblIrradiance: 'env' has always meant
          // reflection, and the diffuse ambient belongs to the grade.
          radiance *= uEnvAmount;
        #endif`,
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
