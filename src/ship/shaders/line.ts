/**
 * The rigging material.
 *
 * Several hundred ropes in one instanced draw call. Each instance carries its
 * two endpoints, a sag depth, a radius and a "bays" count; the vertex shader
 * builds a camera-facing ribbon along the sagging curve. Endpoints are pushed
 * through `shipPart` first, so a braced yard drags its braces with it.
 *
 * Three details matter for it not to look fake:
 *   - every line sags (a quadratic, which is within a percent of a catenary
 *     over these spans and much cheaper), scalloped per bay for ratlines
 *   - wind sway with an envelope that is exactly zero at both ends and scales
 *     with the unsupported span
 *   - sub-pixel lines are widened to ~1.4 px and their alpha reduced to match,
 *     so a shroud at 80 m is a faint continuous line instead of aliased dashes
 *
 * It is a patched MeshStandardMaterial rather than a hand-written shader so the
 * ropes are lit by exactly the same lights, fog and shadows as the hull.
 */

import * as THREE from 'three';
import { PARTS_DECL } from './parts';
import { sailDecl } from './sail';
import { GLSL_COMMON_SAFE, type PartUniforms } from '../materials/materials';
import type { SharedUniforms } from '../../types';
import type { TexSet } from '../materials/textures';
import type { SailUniforms } from '../build/sails';

export interface LineMatUniforms {
  uCamLocal: { value: THREE.Vector3 };
  uViewportH: { value: number };
  uLineFade: { value: number };
}

/**
 * `iBind` is what stops a buntline being drawn through the sail it is supposed
 * to be lying against.
 *
 * A buntline or leechline genuinely runs ON the cloth: it is rove through
 * cringles on the sail's forward face and hauls the bunt up to the yard.
 * Routing it as a straight line between two points of the REST CUT can only
 * ever be wrong, because the cloth is vertex-animated — a line that clears a
 * furled sail pierces a full one, and the other way about. So a bound line is
 * evaluated from the same `lwSailPoint` the cloth is drawn from, along the
 * (u, v) path in `iBindUV`, and pushed `iBind.y` metres out along the cloth's
 * own normal onto its forward face. Camber, shiver, reef and the furled roll
 * are then followed for free, in every state, permanently.
 *
 *   iBind   = (sail slot + 1, standoff in metres, unused, unused)
 *   iBindUV = (u0, v0, u1, v1)
 *
 * `iBind.x == 0` is the ordinary straight-and-sagging rope, which is all but a
 * few dozen of the nine hundred instances.
 */
const COMMON = (sailCount: number): string => /* glsl */ `
attribute vec3 iA;
attribute vec3 iB;
attribute vec4 iParam;   // sag, radius, bays, kind (0 = tarred, 1 = manila)
attribute vec2 iPart;
attribute vec4 iBind;
attribute vec4 iBindUV;
uniform vec3 uCamLocal;
uniform float uViewportH;
uniform vec3 uWind;
uniform float uWindSpeed;
uniform float uTime;
varying float vSide;
varying float vFade;
varying vec3 vRightL;
varying vec3 vViewL;
varying float vKind;
${PARTS_DECL}
${sailDecl(sailCount, false)}

vec3 ropePoint(vec3 A, vec3 B, float s, float sag, float bays, vec3 windOff){
  vec3 P = mix(A, B, s);
  float e;
  if (bays > 0.5) {
    float sp = fract(s * bays);
    e = sp * (1.0 - sp) * 4.0;
  } else {
    e = s * (1.0 - s) * 4.0;
  }
  P.y -= sag * e;
  return P + windOff * e;
}

/** A point on the cloth, 'standoff' metres proud of its forward face. */
vec3 lwBoundPoint(int si, float s, float standoff){
  vec2 uv = mix(iBindUV.xy, iBindUV.zw, clamp(s, 0.0, 1.0));
  vec4 aux; vec4 met; vec4 j0; vec4 j1;
  // lwSailPoint clamps its parameter, so at the leech and the foot a forward
  // difference collapses. Step inward there and put the sign back on the cross
  // product, exactly as SAIL_VERT_BODY does.
  float sx = uv.x + uSailStep.x > 1.0 ? -1.0 : 1.0;
  float sy = uv.y + uSailStep.y > 1.0 ? -1.0 : 1.0;
  vec3 P  = lwSailPoint(si, uv, aux, met);
  vec3 Pu = lwSailPoint(si, uv + vec2(sx * uSailStep.x, 0.0), j0, j1);
  vec3 Pv = lwSailPoint(si, uv + vec2(0.0, sy * uSailStep.y), j0, j1);
  vec3 n = cross(Pv - P, Pu - P) * (sx * sy);
  float nl = length(n);
  n = nl > 1e-9 ? n / nl : vec3(0.0, 0.0, 1.0);
  // The forward face is -n: a square sail's cloth normal comes out +Z, and the
  // buntlines are rove up the fore side of it.
  return shipPart(P - n * standoff, uSailInfo[si].x);
}

vec3 lwLinePoint(vec3 A, vec3 B, float s, vec3 windOff){
  if (iBind.x > 0.5) return lwBoundPoint(int(iBind.x - 0.5), s, iBind.y);
  return ropePoint(A, B, s, iParam.x, iParam.z, windOff);
}
`;

export function makeLineMaterial(
  shared: SharedUniforms,
  parts: PartUniforms,
  tex: TexSet,
  extra: LineMatUniforms,
  sailU: SailUniforms,
  sailCount: number,
): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    map: tex.map,
    normalMap: tex.normalMap,
    roughness: 0.86,
    metalness: 0,
    transparent: true,
    depthWrite: true,
    side: THREE.DoubleSide,
    dithering: true,
  });

  m.onBeforeCompile = (shader) => {
    shader.uniforms.uPartQ = parts.uPartQ;
    shader.uniforms.uPartP = parts.uPartP;
    shader.uniforms.uCamLocal = extra.uCamLocal;
    shader.uniforms.uViewportH = extra.uViewportH;
    shader.uniforms.uLineFade = extra.uLineFade;
    shader.uniforms.uWind = shared.uWind;
    shader.uniforms.uWindSpeed = shared.uWindSpeed;
    shader.uniforms.uTime = shared.uTime;
    Object.assign(shader.uniforms, sailU);

    shader.vertexShader = /* glsl */ `
      ${GLSL_COMMON_SAFE}
      ${COMMON(sailCount)}
      ${shader.vertexShader
        .replace('#include <common>', '#include <common>')
        .replace(
          '#include <uv_vertex>',
          // Rope UV: distance along the line, so the lay of the rope stays the
          // same physical size whatever the span. three has no single `vUv` any
          // more — each map has its own varying — so both have to be set.
          `#include <uv_vertex>
          vMapUv = vec2(vLineAlong, position.y * 0.5 + 0.5);
          vNormalMapUv = vMapUv;`,
        )
        .replace(
          '#include <beginnormal_vertex>',
          `#include <beginnormal_vertex>
          objectNormal = vNormalL;`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          transformed = vPosL;`,
        )
        .replace(
          'void main() {',
          `float vLineAlong;
          vec3 vNormalL;
          vec3 vPosL;
          void main() {
            vec3 A = shipPart(iA, iPart.x);
            vec3 B = shipPart(iB, iPart.y);
            float s = clamp(position.x, 0.0, 1.0);
            float side = position.y;
            float span = length(B - A);
            vKind = iParam.w;

            // Wind sway: travelling, amplitude with the span, slack rope more.
            float seed = fract(dot(iA, vec3(0.113, 0.271, 0.077)) + iParam.x * 3.7);
            float ph = uTime * (1.1 + 1.9 * seed) + seed * 31.0;
            vec3 wdir = normalize(uWind + vec3(1e-4, 0.0, 0.0));
            float amp = 0.0032 * span * uWindSpeed * (0.35 + 0.9 * iParam.w);
            vec3 windOff = (wdir * sin(ph) + vec3(0.0, 0.45, 0.0) * sin(ph * 1.63 + 1.1)) * amp;

            vec3 P  = lwLinePoint(A, B, s, windOff);
            vec3 P2 = lwLinePoint(A, B, min(1.0, s + 0.02), windOff);
            vec3 tangent = normalize(P2 - P + vec3(0.0, 1e-5, 0.0));
            vec3 viewL = normalize(uCamLocal - P);
            vec3 right = cross(tangent, viewL);
            float rl = length(right);
            right = rl > 1e-3 ? right / rl : normalize(cross(tangent, vec3(0.0, 1.0, 0.0)) + vec3(1e-4));

            // Widen sub-pixel lines and drop their alpha to keep the coverage.
            float viewZ = -(modelViewMatrix * vec4(P, 1.0)).z;
            float ppm = projectionMatrix[1][1] * 0.5 * uViewportH / max(0.08, viewZ);
            float px = iParam.y * 2.0 * ppm;
            float grow = px < 1.4 ? 1.4 / max(px, 1e-3) : 1.0;
            vFade = px < 1.4 ? max(0.25, px / 1.4) : 1.0;

            vPosL = P + right * side * iParam.y * grow;
            vRightL = right;
            vViewL = viewL;
            vSide = side;
            vNormalL = normalize(right * side * 0.85 + viewL * 0.6);
            vLineAlong = s * span * 2.6;
      `,
        )}
    `;

    shader.fragmentShader = /* glsl */ `
      ${GLSL_COMMON_SAFE}
      varying float vSide;
      varying float vFade;
      varying vec3 vRightL;
      varying vec3 vViewL;
      varying float vKind;
      uniform float uLineFade;
      ${shader.fragmentShader
        .replace(
          '#include <normal_fragment_begin>',
          `#include <normal_fragment_begin>
          {
            // Reconstruct a cylindrical normal across the ribbon so a rope
            // reads round rather than as a flat tape.
            float c = clamp(vSide, -1.0, 1.0);
            vec3 nl = normalize(vRightL * c * 0.94 + vViewL * sqrt(max(0.04, 1.0 - c * c * 0.88)));
            normal = normalize((viewMatrix * vec4(nl, 0.0)).xyz);
            nonPerturbedNormal = normal;
          }`,
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          // Tarred standing rigging is near-black; running rigging is manila.
          vec3 tar = vec3(0.055, 0.052, 0.05);
          vec3 manila = vec3(0.46, 0.38, 0.25);
          diffuseColor.rgb *= mix(tar, manila, vKind) * 2.0;
          diffuseColor.a *= vFade * uLineFade;`,
        )}
    `;
  };
  m.customProgramCacheKey = () => 'ship-line';
  return m;
}

/** Base ribbon: `seg` spans along the rope, two vertices across. */
export function makeRibbonGeometry(seg: number): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry();
  const pos: number[] = [];
  const uv: number[] = [];
  const nrm: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= seg; i++) {
    const s = i / seg;
    for (const side of [-1, 1]) {
      pos.push(s, side, 0);
      uv.push(s, side * 0.5 + 0.5);
      nrm.push(0, 0, 1);
    }
  }
  for (let i = 0; i < seg; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
  }
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setIndex(idx);
  return g;
}
