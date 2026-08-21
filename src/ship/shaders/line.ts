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
 *   - the ribbon is drawn a pixel wider than the rope on each side and the
 *     fragment shader computes the rope's EXACT area inside each pixel, so a
 *     shroud at 80 m fades instead of flickering (`lwLineCoverage` below)
 *
 * It is a patched MeshStandardMaterial rather than a hand-written shader so the
 * ropes are lit by exactly the same lights, fog and shadows as the hull.
 */

import * as THREE from 'three';
import { PARTS_DECL } from './parts';
import { sailDecl } from './sail';
import { SHIP_AERIAL_FN, SHIP_AERIAL_UNIFORMS } from './aerial';
import { lwFloat } from '../../util/glsl';
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
const COMMON = (sailCount: number, seg: number): string => /* glsl */ `
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
varying float vEdgePx;
varying float vRPx;
varying vec3 vRightL;
varying vec3 vViewL;
varying float vKind;
${PARTS_DECL}
${sailDecl(sailCount, false)}

/**
 * Most scallops a ${seg}-segment ribbon can carry.
 *
 * A lower gang has 8 or 9 shrouds, so a ratline seized across it has 7 or 8
 * bays — and the ribbon has ${seg} segments, i.e. 1.5 samples per bay. A
 * per-bay sawtooth sampled below Nyquist is not a scallop, it is per-vertex
 * noise, and it is what made every ratline a ragged polyline with a random
 * 0-3 cm kink at each of its thirteen vertices. Four samples a droop is the
 * least that reads as a curve, so the count is clamped there: a slack chain
 * over three bays instead of a scallop over eight, which is at least a shape.
 */
const float LW_MAX_BAYS = ${lwFloat(Math.max(1, Math.floor(seg / 4)))};

vec3 ropePoint(vec3 A, vec3 B, float s, float sag, float bays, vec3 windOff){
  vec3 P = mix(A, B, s);
  float e;
  if (bays > 0.5) {
    float sp = fract(s * min(bays, LW_MAX_BAYS));
    e = sp * (1.0 - sp) * 4.0;
  } else {
    e = s * (1.0 - s) * 4.0;
  }
  P.y -= sag * e;
  return P + windOff * e;
}

/**
 * Exact area of a strip of half-width 'r' inside a one-pixel box centred 'd'
 * from the strip's axis. Both in pixels.
 *
 * This is the whole rigging antialiasing story, so it is worth being precise
 * about why the obvious alternative does not work. The renderer asks for NO
 * MSAA ('Engine.ts': we do our own AA in post), so a ribbon narrower than a
 * pixel rasterises with BINARY coverage — it lands on one pixel or on two, and
 * which one flips as the camera moves a fraction of a pixel. Two hundred
 * shrouds and ratlines doing that at once is the crawling black net two
 * observers reported. Widening the quad to 1.4 px and scaling its alpha by the
 * true width, which is what this did before, conserves the average but leaves
 * the EDGE hard, so the flicker survives at reduced amplitude; and the 0.25
 * alpha floor it clamped to made a 0.2 px ratline four times too dark, which is
 * the other half of the same report.
 *
 * The integral of this over d is 2r for every r, so total ink is preserved at
 * any distance and no floor is needed: a rope thinner than a pixel simply gets
 * fainter, which is what a rope thinner than a pixel does.
 */
float lwLineCoverage(float d, float r) {
  return clamp(min(d + 0.5, r) - max(d - 0.5, -r), 0.0, 1.0);
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
  seg: number,
): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    map: tex.map,
    normalMap: tex.normalMap,
    roughness: 0.86,
    metalness: 0,
    transparent: true,
    // NO DEPTH WRITE, and this is the second half of the crawling-net fix.
    //
    // Every rope in the rig is one instance in one draw call, so where two of
    // them cross they blend in buffer order — and with depthWrite on, whichever
    // was drawn first also wrote depth and DISCARDED the other. A ratline gang
    // crosses its own shrouds a hundred times, so a hundred crossings each
    // either dropped a line or doubled it depending on which happened to be
    // nearer, and that decision flips as the camera moves. Depth TESTING is
    // untouched, so the hull, the spars and the sails still occlude the rig
    // correctly; all that is given up is rope-over-rope occlusion, and a
    // tarred rope at full coverage blends to the same near-black anyway.
    depthWrite: false,
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
    shader.uniforms.uSunDirection = shared.uSunDirection;
    shader.uniforms.uSunColor = shared.uSunColor;
    shader.uniforms.uSunIntensity = shared.uSunIntensity;
    shader.uniforms.uMoonColor = shared.uMoonColor;
    shader.uniforms.uMoonIntensity = shared.uMoonIntensity;
    shader.uniforms.uFogColor = shared.uFogColor;
    shader.uniforms.uFogDensity = shared.uFogDensity;
    shader.uniforms.uVisibility = shared.uVisibility;
    Object.assign(shader.uniforms, sailU);

    shader.vertexShader = /* glsl */ `
      ${GLSL_COMMON_SAFE}
      ${COMMON(sailCount, seg)}
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

            // The ribbon is drawn one pixel WIDER than the rope on each side and
            // the fragment shader takes the exact box-filter coverage of the
            // rope's own strip inside it — see 'lwLineCoverage'. 'right' is
            // perpendicular to the view direction by construction, so it lies
            // in the screen plane and 'ppm' converts it to pixels exactly.
            float viewZ = -(modelViewMatrix * vec4(P, 1.0)).z;
            float ppm = projectionMatrix[1][1] * 0.5 * uViewportH / max(0.08, viewZ);
            float rPx = iParam.y * ppm;
            float wPx = max(rPx + 1.0, 1.0);
            float grow = wPx / max(rPx, 1e-4);

            vPosL = P + right * side * iParam.y * grow;
            vEdgePx = side * wPx;
            vRPx = rPx;
            vRightL = right;
            vViewL = viewL;
            vNormalL = normalize(right * side * 0.85 + viewL * 0.6);
            vLineAlong = s * span * 2.6;
      `,
        )}
    `;

    shader.fragmentShader = /* glsl */ `
      ${GLSL_COMMON_SAFE}
      ${SHIP_AERIAL_UNIFORMS}
      varying float vEdgePx;
      varying float vRPx;
      varying vec3 vRightL;
      varying vec3 vViewL;
      varying float vKind;
      uniform float uLineFade;
      float lwLineCoverage(float d, float r) {
        return clamp(min(d + 0.5, r) - max(d - 0.5, -r), 0.0, 1.0);
      }
      ${shader.fragmentShader
        // After three's own '#include <common>', because lwShipAerial needs
        // 'inverseTransformDirection' from it and the 'vViewPosition' varying
        // three declares just above it.
        .replace('#include <common>', `#include <common>\n${SHIP_AERIAL_FN}`)
        .replace(
          '#include <normal_fragment_begin>',
          `#include <normal_fragment_begin>
          {
            // Reconstruct a cylindrical normal across the ribbon so a rope
            // reads round rather than as a flat tape.
            //
            // Faded out below a two-pixel rope, because a pixel that contains
            // the WHOLE cylinder has one honest normal — the average one, which
            // faces the camera. Sweeping a full -1..1 cylinder across two pixels
            // of ribbon instead puts a second high-contrast signal at the
            // sampling limit, on top of the coverage problem, and it was
            // brightening one side of every distant shroud.
            float c = clamp(vEdgePx / max(vRPx, 1e-3), -1.0, 1.0) * clamp(vRPx, 0.0, 1.0);
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
          diffuseColor.a *= lwLineCoverage(vEdgePx, vRPx) * uLineFade;`,
        )
        .replace(
          '#include <opaque_fragment>',
          `#include <opaque_fragment>
          // The air in front of the rope. Tarred rigging is the darkest thing on
          // the ship, so at any distance it was the first to clip to pure black
          // and read as an ink line rather than as cordage. See shaders/aerial.ts.
          gl_FragColor.rgb = lwShipAerial(gl_FragColor.rgb);`,
        )}
    `;
  };
  m.customProgramCacheKey = () => `ship-line-${seg}`;
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
