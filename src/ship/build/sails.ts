/**
 * The suit of canvas.
 *
 * Sixteen sails, one draw call, one shadow draw call. Every sail is the same
 * unit (u, v) grid instanced once per sail; the cut is four corner uniforms and
 * the whole shape — camber, shiver, reef, furl — is evaluated in the vertex
 * shader from what the rig solver writes into `SailState` each frame. See
 * `shaders/sail.ts` for the deformation itself.
 *
 * Three families, one patch:
 *
 *   square      bent to a jackstay on its yard, clews sheeted out to the yard
 *               below — head narrow, foot wide, the trapezoid that makes a
 *               square rig legible from a mile off
 *   headsail    a triangle hanked to its stay; sheeting it rotates the whole
 *               sail about the stay, so it is the same kind of joint as a
 *               braced yard rather than a special case in the shader
 *   spanker     a gaff quadrilateral on the mizzen boom and gaff, both of which
 *               swing about the same mast axis, so one part slot carries it
 *
 * The material is a patched MeshPhysicalMaterial: it inherits three's lights,
 * shadows, fog and sky IBL, and its `sheen` lobe is a Charlie/Ashikhmin fabric
 * BRDF rather than plain GGX, which is what makes woven flax read as cloth.
 * Diffuse transmission is added on top so a backlit sail glows and carries the
 * shadow of whatever stands between it and the sun.
 */

import * as THREE from 'three';
import type { World } from '../../types';
import { GLSL, lwFloat } from '../../util/glsl';
import { SHARED_UNIFORM_DECL } from '../../core/SharedUniforms';
import { JIB_CUT, JIB_IDS, MASTS, PART, SAIL_YARDS, SPANKER_CLEW, squareCut } from '../dims';
import { PARTS_DECL } from '../shaders/parts';
import {
  PANEL_TILE_M, PANEL_WIDTH_M, SAIL_VERT_BODY, SEAM_TILE_M, sailDecl,
} from '../shaders/sail';
import type { PartUniforms } from '../materials/materials';
import type { TexSet } from '../materials/textures';
import type { RigFrame } from './masts';

export interface SailResult {
  group: THREE.Group;
  meshes: THREE.Mesh[];
  update(world: World): void;
  applySettings(quality: number): void;
  dispose(): void;
}

/** Sheet gain: a fore-and-aft sail swings this much further than a square yard.
 *  Must match `SHEET_GAIN` in physics/constants.ts or the cloth points one way
 *  and the force goes the other. */
const SHEET_GAIN = 2.35;

/**
 * Grid resolution (chord x span) per quality tier. The chord needs the vertices:
 * a luffing sail carries two and a half fold cycles across it and anything under
 * about twenty samples aliases them away.
 */
const GRID: readonly [number, number][] = [[13, 9], [17, 11], [21, 15], [27, 19]];

/** How much light comes through the cloth, relative to its diffuse albedo. */
const CLOTH_TRANSMISSION = 0.34;

/** Depth of a tension crease at the clew, metres. */
const CREASE_AMP_M = 0.05;
/** How far a crease reaches into the sail, as a fraction of the hoist. */
const CREASE_REACH = 0.4;
/** Ridges in the fan from one corner, in cycles of the fan parameter. */
const CREASE_CYCLES = 2.4;

interface SailUniforms {
  uSailA: { value: THREE.Vector3[] };
  uSailB: { value: THREE.Vector3[] };
  uSailC: { value: THREE.Vector3[] };
  uSailD: { value: THREE.Vector3[] };
  uSailState: { value: THREE.Vector4[] };
  uSailInfo: { value: THREE.Vector4[] };
  uSailStep: { value: THREE.Vector2 };
  uSailTime: { value: number };
}

const _wind = new THREE.Vector3();
const _iq = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();

export function buildSails(
  world: World,
  parts: PartUniforms,
  canvas: TexSet,
  frame: RigFrame,
  quality: number,
): SailResult {
  const sails = world.ship.sails;
  const n = sails.length;
  const group = new THREE.Group();
  group.name = 'ship-sails';

  const u: SailUniforms = {
    uSailA: { value: [] },
    uSailB: { value: [] },
    uSailC: { value: [] },
    uSailD: { value: [] },
    uSailState: { value: [] },
    uSailInfo: { value: [] },
    uSailStep: { value: new THREE.Vector2() },
    uSailTime: { value: 0 },
  };
  for (let i = 0; i < n; i++) {
    u.uSailA.value.push(new THREE.Vector3());
    u.uSailB.value.push(new THREE.Vector3());
    u.uSailC.value.push(new THREE.Vector3());
    u.uSailD.value.push(new THREE.Vector3());
    u.uSailState.value.push(new THREE.Vector4(0, 0, 0, 0));
    u.uSailInfo.value.push(new THREE.Vector4(0, 0, 0, 0));
  }

  /** Sail index -> 1 for fore-and-aft, 0 for square. Drives the luff-side flip. */
  const isFA = new Uint8Array(n);
  const drawn: number[] = [];
  let area = 0;

  for (let i = 0; i < n; i++) {
    const s = sails[i];
    const A = u.uSailA.value[i];
    const B = u.uSailB.value[i];
    const C = u.uSailC.value[i];
    const D = u.uSailD.value[i];
    const info = u.uSailInfo.value[i];
    // Decorrelate the shiver of neighbouring sails.
    const seed = (i * 0.6180339887498949) % 1;

    const yard = SAIL_YARDS.find((y) => y.id === s.id);
    const jib = JIB_IDS.indexOf(s.id as (typeof JIB_IDS)[number]);

    if (yard) {
      const yf = frame.yards.find((v) => v.spec.id === yard.id);
      if (!yf) continue;
      const cut = squareCut(yard);
      // The head is bent to a jackstay on the FORE side of the yard, and the
      // foot carries the mast's own rake so the cloth hangs parallel to the
      // spar instead of crossing it. Both matter: the mast moves ~0.43 m forward
      // over the drop of a course while the sail used to hang plumb, so the
      // lower third of every square sail had the mast straight through it.
      const rake = yard.mast < MASTS.length ? Math.tan(MASTS[yard.mast].rake) : 0;
      const hy = yf.centre.y;
      const hz = yf.centre.z - yard.radius * 0.35;
      const fy = hy - cut.drop;
      const fz = hz - cut.drop * rake;
      A.set(-cut.headHalf, hy, hz);
      B.set(cut.headHalf, hy, hz);
      C.set(cut.footHalf, fy, fz);
      D.set(-cut.footHalf, fy, fz);
      info.set(yard.part, 0, cut.roach, seed);
      area += quadArea(A, B, C, D);
    } else if (jib >= 0) {
      const stay = frame.headStays[jib];
      const cut = JIB_CUT[jib];
      const run = 1 / Math.hypot(1, cut.rise);
      A.copy(stay.head);
      B.copy(stay.head);
      D.copy(stay.tack);
      C.set(stay.tack.x, stay.tack.y + cut.foot * cut.rise * run, stay.tack.z + cut.foot * run);
      info.set(PART.JIB0 + jib, 1, 0, seed);
      isFA[i] = 1;
      area += quadArea(A, B, C, D);
    } else if (s.id === 'spanker') {
      const sp = frame.spanker;
      A.copy(sp.gaffPivot);
      B.copy(sp.gaffEnd);
      D.copy(sp.boomPivot);
      C.copy(sp.boomPivot).lerp(sp.boomEnd, SPANKER_CLEW);
      info.set(PART.BOOM, 1, 0, seed);
      isFA[i] = 1;
      area += quadArea(A, B, C, D);
    } else {
      continue;
    }
    drawn.push(i);
  }

  let res = GRID[Math.max(0, Math.min(3, quality))];
  let geo = makeSailGrid(res[0], res[1], drawn);
  u.uSailStep.value.set(1 / (res[0] - 1), 1 / (res[1] - 1));

  const mat = makeSailMaterial(world, parts, canvas, u, n);
  const depth = makeSailDepth(parts, u, n);

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'ship-sail-cloth';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.customDepthMaterial = depth;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  group.add(mesh);

  world.stats['ship:sailArea'] = area;
  world.stats['ship:sailTris'] = ((res[0] - 1) * (res[1] - 1) * 2) * drawn.length;

  return {
    group,
    meshes: [mesh],

    update(w) {
      const st = u.uSailState.value;
      u.uSailTime.value = w.time.elapsed;

      // Apparent wind in the ship's body frame — the same quantity the rig
      // solver trims to, so the cloth and the force agree about which leech is
      // the luff on this tack.
      _wind.copy(w.env.windVector).multiplyScalar(w.env.windSpeed * w.env.gust);
      _wind.sub(w.ship.velocity);
      _iq.copy(w.ship.quaternion).conjugate();
      _wind.applyQuaternion(_iq);

      for (let i = 0; i < n; i++) {
        const s = w.ship.sails[i];
        let flip = 0;
        if (!isFA[i]) {
          // Chord runs along the yard: (cos b, 0, -sin b). Air entering at the
          // port leech makes that leech the luff, which is u = 0.
          const flow = _wind.x * Math.cos(s.brace) - _wind.z * Math.sin(s.brace);
          flip = flow > 0 ? 0 : 1;
        }
        st[i].set(s.set, s.luff, s.camber, flip);
      }
    },

    applySettings(q) {
      const want = GRID[Math.max(0, Math.min(3, q))];
      if (want[0] === res[0] && want[1] === res[1]) return;
      res = want;
      geo.dispose();
      geo = makeSailGrid(res[0], res[1], drawn);
      mesh.geometry = geo;
      u.uSailStep.value.set(1 / (res[0] - 1), 1 / (res[1] - 1));
      world.stats['ship:sailTris'] = ((res[0] - 1) * (res[1] - 1) * 2) * drawn.length;
    },

    dispose() {
      geo.dispose();
      mat.dispose();
      depth.dispose();
    },
  };
}

/** Area of the flat cut, for the build-time sanity number in world.stats. */
function quadArea(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3): number {
  return 0.5 * (tri(a, b, c) + tri(a, c, d));
}
function tri(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): number {
  return _v.subVectors(b, a).cross(_w.subVectors(c, a)).length();
}

/**
 * The shared unit grid. `position.xy` IS the (chord, span) parameter pair; the
 * vertex shader turns it into a point on whichever sail the instance names.
 */
function makeSailGrid(nu: number, nv: number, drawn: number[]): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry();
  const pos = new Float32Array(nu * nv * 3);
  const uv = new Float32Array(nu * nv * 2);
  const nrm = new Float32Array(nu * nv * 3);
  const idx: number[] = [];
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const k = i * nv + j;
      const a = i / (nu - 1);
      const b = j / (nv - 1);
      pos[k * 3] = a;
      pos[k * 3 + 1] = b;
      uv[k * 2] = a;
      uv[k * 2 + 1] = b;
      nrm[k * 3 + 2] = 1;
    }
  }
  for (let i = 0; i < nu - 1; i++) {
    for (let j = 0; j < nv - 1; j++) {
      const a = i * nv + j;
      const b = (i + 1) * nv + j;
      const c = (i + 1) * nv + j + 1;
      const d = i * nv + j + 1;
      idx.push(a, b, c, a, c, d);
    }
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setIndex(idx);
  g.setAttribute('iSail', new THREE.InstancedBufferAttribute(new Float32Array(drawn), 1));
  g.instanceCount = drawn.length;
  // The rig fills the screen from every camera the game has; culling by the
  // unit grid's own bounds would pop every sail out of frame at once.
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 30, 0), 95);
  return g;
}

const VERT_HEAD = /* glsl */ `
varying vec4 vSail;
varying vec4 vCloth;
varying vec2 vSailUv;
varying vec3 vSailWP;
varying vec3 vSailTan;
`;

const FRAG_HEAD = /* glsl */ `
varying vec4 vSail;
varying vec4 vCloth;
varying vec2 vSailUv;
varying vec3 vSailWP;
varying vec3 vSailTan;
uniform float uClothTrans;
`;

/**
 * Cloth detail, drawn procedurally rather than left to the canvas texture.
 *
 * A panel seam is 610 mm apart and a bolt rope is 50 mm thick: at a hundred
 * metres both are well under a pixel, so a texture carrying them minifies to
 * flat grey and the sail reads as paper. Widening each feature to hold about a
 * pixel (from the screen-space derivative of the same distance in metres) and
 * fading its CONTRAST as it does keeps seams and roping legible from the
 * masthead down to a boarding party, without aliasing on the way.
 */
const CLOTH_DETAIL = /* glsl */ `
float lwClothLine(float distM, float widthM, float aa) {
  float w = max(widthM, aa);
  return (1.0 - smoothstep(0.0, w, distM)) * clamp(widthM / w, 0.25, 1.0);
}

/**
 * The weave.
 *
 * This used to be baked into the canvas map as two sinusoids at 190 and 150
 * cycles across 512 texels — 2.7 texels a cycle, right at Nyquist. What came out
 * was a beating moiré that averaged to a flat grey-green field: measured, the
 * baked albedo had a standard deviation of 0.024 at a two-metre viewing
 * distance, which is a constant with a rounding error on it. That is the whole
 * of the owner's "the sails read as flat cloth".
 *
 * Generated here instead, the pitch is in METRES and holds at any distance. No.1
 * flax duck is a plain weave of about 2.4 mm warp pitch with a slightly coarser
 * weft, and it is genuinely visible at arm's length — the ribbed sheen across a
 * sail is the single strongest cue that it is cloth and not paper.
 *
 * Both tiers fade out as their pitch approaches a pixel, which is what stops the
 * weave becoming the sparkle field a texture at this frequency turns into. The
 * relief comes back as an analytic slope in 'g', per metre.
 *
 *   m  (along the span, across the chord) in metres
 */
float lwWeave(vec2 m, vec2 aa, out vec2 g) {
  const float WARP = 0.0024;
  const float WEFT = 0.0031;
  float fw = clamp(WARP / max(aa.y * 2.0, 1e-7) - 1.0, 0.0, 1.0);
  float ff = clamp(WEFT / max(aa.x * 2.0, 1e-7) - 1.0, 0.0, 1.0);

  float kw = TAU / WARP;
  float kf = TAU / WEFT;
  float sw = sin(m.y * kw);
  float sf = sin(m.x * kf);

  // A plain weave is one set of threads passing over the other, so the two
  // sinusoids do not add — the crossing where both are up is the high point and
  // the crossing where both are down is the pit. Multiplying the phases gives
  // that, and it is still differentiable in closed form.
  float h = 0.62 * sw * fw + 0.5 * sf * ff + 0.34 * sw * sf * fw * ff;
  g = vec2(
    (0.5 * kf * cos(m.x * kf)) * ff + (0.34 * kf * sw * cos(m.x * kf)) * fw * ff,
    (0.62 * kw * cos(m.y * kw)) * fw + (0.34 * kw * cos(m.y * kw) * sf) * fw * ff
  );
  return h;
}

/**
 * Tension creases fanning out of a corner of the sail.
 *
 * A drawing sail is a membrane hauled at discrete points, so the cloth gathers
 * into a fan of shallow ridges running from each clew up into the belly. They
 * are the detail that separates cloth under load from a smooth bent plane, and
 * they are far too fine for a 21x15 vertex grid, so they live in the normal.
 *
 * The ridges are laid out in the projective fan parameter y / (x + y), which is
 * constant along rays from the corner and — unlike atan — differentiable in two
 * multiplies. That matters: the slopes come back analytically in 'g', so the
 * normal never needs 'dFdx' of a high-frequency function, which is exactly what
 * turns fine detail into sparkle in the mid-distance.
 *
 *   d      metres from the corner, (along the chord, along the span)
 *   decayM how far the crease reaches before it dies out
 *   g      out: (dh/dchord, dh/dspan), dimensionless slopes
 */
float lwCreaseFan(vec2 d, float amp, float decayM, float cycles, float phase, out vec2 g) {
  float s = d.x + d.y + 1e-3;
  float r = length(d) + 1e-3;
  float k = cycles * 6.2831853;
  float A = amp * exp(-r / decayM);
  float a = k * (d.y / s) + phase;
  float sn = sin(a);
  float cs = cos(a);
  // d/dx of the envelope along the ray, plus d/dx of the ridge across it.
  g = (-A / decayM) * (d / r) * sn + (A * cs * k) * (vec2(-d.y, d.x) / (s * s));
  return A * sn;
}
`;

function makeSailMaterial(
  world: World,
  parts: PartUniforms,
  tex: TexSet,
  u: SailUniforms,
  count: number,
): THREE.MeshPhysicalMaterial {
  const m = new THREE.MeshPhysicalMaterial({
    map: tex.map,
    normalMap: tex.normalMap,
    aoMap: tex.ormMap,
    roughnessMap: tex.ormMap,
    // Heavy flax is very rough; the fabric sheen lobe below does the work that
    // a tight GGX highlight would do wrong.
    roughness: 0.94,
    metalness: 0,
    sheen: 1,
    sheenRoughness: 0.62,
    sheenColor: new THREE.Color(0xa8a294),
    side: THREE.DoubleSide,
    aoMapIntensity: 0.85,
    normalScale: new THREE.Vector2(0.85, 0.85),
    dithering: true,
  });
  const trans = { value: CLOTH_TRANSMISSION };

  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, world.uniforms, u);
    shader.uniforms.uPartQ = parts.uPartQ;
    shader.uniforms.uPartP = parts.uPartP;
    shader.uniforms.uClothTrans = trans;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>\n${VERT_HEAD}${PARTS_DECL}${sailDecl(count)}`,
      )
      .replace('void main() {', `vec3 vPosL;\nvec3 vNormalL;\nvoid main() {\n${SAIL_VERT_BODY}`)
      .replace(
        '#include <uv_vertex>',
        `#include <uv_vertex>
        {
          // vSailUv is in metres; the canvas tiles at a fixed physical size so a
          // course and a royal show the same weave.
          vec2 lwTileUv = vSailUv / vec2(${lwFloat(SEAM_TILE_M)}, ${lwFloat(PANEL_TILE_M)});
          #if defined( USE_UV ) || defined( USE_ANISOTROPY )
            vUv = lwTileUv;
          #endif
          #ifdef USE_MAP
            vMapUv = lwTileUv;
          #endif
          #ifdef USE_NORMALMAP
            vNormalMapUv = lwTileUv;
          #endif
          #ifdef USE_AOMAP
            vAoMapUv = lwTileUv;
          #endif
          #ifdef USE_ROUGHNESSMAP
            vRoughnessMapUv = lwTileUv;
          #endif
        }`,
      )
      .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vNormalL;')
      .replace('#include <begin_vertex>', 'vec3 transformed = vPosL;');

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\n${GLSL.common}${GLSL.noise2d}${SHARED_UNIFORM_DECL}${FRAG_HEAD}${CLOTH_DETAIL}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        // Declared outside the block so the normal-map stage below can consume
        // the creases without evaluating the fan a second time.
        vec2 lwCreaseG = vec2(0.0);
        float lwCreaseH = 0.0;
        {
          float spanM = vSailUv.x;
          float chordM = vSailUv.y;
          float aaC = fwidth(chordM) * 0.6 + 1e-5;
          float aaS = fwidth(spanM) * 0.6 + 1e-5;

          // Vertical panel seams: cloths run head to foot, doubled and
          // double-stitched, so each seam is a raised darker line.
          float pf = chordM / ${lwFloat(PANEL_WIDTH_M)};
          float seamD = min(fract(pf), 1.0 - fract(pf)) * ${lwFloat(PANEL_WIDTH_M)};
          float seam = lwClothLine(seamD, 0.022, aaC);
          // Every cloth is a slightly different bolt of flax.
          float panelTone = hash11(floor(pf) * 0.731 + 3.17);
          // Two rows of hand stitching, one either side of the overlap, at the
          // ten-to-the-inch a sailmaker works to. This is the detail that says
          // the seam is sewn rather than drawn on.
          float stitchRow = lwClothLine(abs(seamD - 0.016), 0.0016, aaC);
          float stitch = stitchRow
            * lwClothLine(min(fract(spanM / 0.0085), 1.0 - fract(spanM / 0.0085)) * 0.0085,
                          0.0022, aaS);

          // Bolt ropes all round the sail, heavier on the leeches.
          float edgeSpanM = min(vSail.y, 1.0 - vSail.y) * vCloth.y;
          float rope = max(lwClothLine(vCloth.x, 0.055, aaC),
                           lwClothLine(edgeSpanM, 0.042, aaS));

          // Reef bands with the points seized through their eyelets. Square
          // sails only: a jib has no reef band.
          float band = 0.0;
          for (int i = 0; i < 3; i++) {
            float bd = abs(vSail.y - (0.26 + float(i) * 0.22)) * vCloth.y;
            band = max(band, lwClothLine(bd, 0.05, aaS));
          }
          band *= 1.0 - vCloth.z;
          float qf = chordM / 0.52;
          float pts = band * lwClothLine(min(fract(qf), 1.0 - fract(qf)) * 0.52, 0.035, aaC);

          // Cringles: a roped and thimbled eyelet at every corner, and one more
          // wherever a reef band runs out to a leech.
          float fromFoot = max(vCloth.y - spanM, 0.0);
          float cornerR = length(vec2(vCloth.x, min(spanM, fromFoot)));
          float cring = lwClothLine(abs(cornerR - 0.11), 0.030, aaC);
          float reefCring = band * lwClothLine(abs(vCloth.x - 0.14), 0.032, aaC);

          // Tension creases from the clews, and a weaker, finer gather at the
          // head where the cloth is seized to the jackstay. Both die away as
          // their spacing approaches a pixel: a crease fan that outruns the
          // sample rate stops reading as cloth and starts reading as noise.
          // No branch around this: 'load' comes from a varying, so a conditional
          // would put the fwidth below in non-uniform control flow, where the
          // derivative is undefined. The weights collapse to zero on their own.
          float load = clamp(vCloth.w, 0.0, 1.0) * (1.0 - vSail.w);
          vec2 dClew = vec2(vCloth.x, fromFoot);
          vec2 dHead = vec2(vCloth.x, spanM);
          float reach = max(vCloth.y, 1.0) * ${lwFloat(CREASE_REACH)};
          vec2 g1;
          vec2 g2;
          float h1 = lwCreaseFan(dClew, ${lwFloat(CREASE_AMP_M)}, reach,
                                 ${lwFloat(CREASE_CYCLES)}, 0.0, g1);
          float h2 = lwCreaseFan(dHead, ${lwFloat(CREASE_AMP_M)} * 0.4, reach * 0.55,
                                 ${lwFloat(CREASE_CYCLES)} * 1.4, 1.7, g2);
          // Fade each fan out as its ridge spacing approaches a pixel, and near
          // the corner itself where the fan parameter is singular.
          float aaFan = aaC * 5.0;
          float res1 = clamp((dClew.x + dClew.y) / (${lwFloat(CREASE_CYCLES)} * aaFan) - 1.0, 0.0, 1.0)
                     * smoothstep(0.05, 0.35, length(dClew));
          float res2 = clamp((dHead.x + dHead.y) / (${lwFloat(CREASE_CYCLES)} * 1.4 * aaFan) - 1.0, 0.0, 1.0)
                     * smoothstep(0.05, 0.35, length(dHead));
          float w1 = load * res1;
          float w2 = load * res2;
          lwCreaseH = h1 * w1 + h2 * w2;
          lwCreaseG = g1 * w1 + g2 * w2;

          // Weathering: dirt and mildew collect toward the foot and in patches.
          float stain = noise2(vec2(spanM, chordM) * 0.085);
          float foot = smoothstep(0.5, 1.0, vSail.y);
          vec3 grime = vec3(0.78, 0.79, 0.74);

          // The weave. Relief of 0.11 mm over a 2.4 mm pitch is a peak slope of
          // 0.29 — a 16-degree tilt, which is what makes a sunlit sail ripple
          // with light instead of reading as a bent sheet of paper.
          vec2 weaveG;
          float weave = lwWeave(vec2(spanM, chordM), vec2(fwidth(spanM), fwidth(chordM)), weaveG);
          // lwWeave works in (span, chord); lwCreaseG is in (chord, span).
          lwCreaseG += vec2(weaveG.y, weaveG.x) * 0.00011;

          diffuseColor.rgb *= 0.93 + 0.14 * panelTone;
          diffuseColor.rgb *= 1.0 + 0.055 * weave;
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * grime,
                                 foot * 0.4 + smoothstep(0.5, 0.9, stain) * 0.35);
          diffuseColor.rgb *= 1.0 - seam * 0.28 - band * 0.2 - pts * 0.5
                                  - stitch * 0.42;
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.45, rope * 0.9);
          diffuseColor.rgb *= 1.0 - cring * 0.5 - reefCring * 0.42;
          // Grime settles in the bottom of a crease.
          diffuseColor.rgb *= 1.0 - 0.09 * clamp(-lwCreaseH / ${lwFloat(CREASE_AMP_M)}, 0.0, 1.0);
          // The gathered bundle lies in its own shadow.
          diffuseColor.rgb *= 1.0 - 0.45 * smoothstep(0.03, 0.5, vSail.z);
        }`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        if (dot(lwCreaseG, lwCreaseG) > 1e-12) {
          // Perturb along the sail's own surface frame. vSailTan is the world
          // chord direction from the vertex shader, so the only work here is one
          // Gram-Schmidt against the shaded normal.
          vec3 lwWn = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
          vec3 lwT = vSailTan - lwWn * dot(lwWn, vSailTan);
          float lwTl = length(lwT);
          if (lwTl > 1e-4) {
            lwT /= lwTl;
            vec3 lwB = cross(lwWn, lwT);
            lwWn = normalize(lwWn - (lwCreaseG.x * lwT + lwCreaseG.y * lwB));
            normal = normalize((viewMatrix * vec4(lwWn, 0.0)).xyz);
          }
        }`,
      )
      .replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
        {
          // Cloth translucency. Flax passes a third of the light that reaches
          // it, so a backlit sail glows and shows the shadow of everything
          // between it and the sun — the yard, the buntlines, the sail above.
          // uSunIntensity is IRRADIANCE so the 1/PI is ours; uSkyColor is
          // radiance and is not (see sky/constants.ts).
          vec3 wn = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
          float back = max(0.0, -dot(wn, uSunDirection));
          float sh = 1.0;
          #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
            DirectionalLightShadow lwSailShadow = directionalLightShadows[ 0 ];
            sh = getShadow(
              directionalShadowMap[ 0 ], lwSailShadow.shadowMapSize,
              lwSailShadow.shadowIntensity, lwSailShadow.shadowBias,
              lwSailShadow.shadowRadius, vDirectionalShadowCoord[ 0 ]);
          #endif
          vec3 through = material.diffuseColor * uClothTrans;
          reflectedLight.indirectDiffuse +=
              through * pow(back, 1.6) * uSunColor * uSunIntensity * INV_PI
                      * sh * lwCloudShadow(vSailWP)
            + through * 0.28 * uSkyColor;
        }`,
      );
  };
  m.customProgramCacheKey = () => 'ship-sail';
  return m;
}

/**
 * The matching depth material, so the shadow is cast by the deformed cloth and
 * not by a flat quad hanging in the wrong place.
 *
 * A sail is a single surface with no thickness, so back-face depth and
 * front-face depth are the same and the light's own bias cannot separate them.
 * Pushing the caster a hand's breadth away from the shadow camera fixes the
 * self-shadow acne without detaching the shadow the sail throws on the deck
 * fifteen metres below.
 */
function makeSailDepth(
  parts: PartUniforms,
  u: SailUniforms,
  count: number,
): THREE.MeshDepthMaterial {
  const d = new THREE.MeshDepthMaterial();
  d.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.uniforms.uPartQ = parts.uPartQ;
    shader.uniforms.uPartP = parts.uPartP;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        vec2 vSailUv;
        vec4 vSail;
        vec4 vCloth;
        vec3 vSailWP;
        vec3 vSailTan;
        ${PARTS_DECL}${sailDecl(count)}`,
      )
      .replace('void main() {', `vec3 vPosL;\nvec3 vNormalL;\nvoid main() {\n${SAIL_VERT_BODY}`)
      .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vNormalL;')
      .replace(
        '#include <begin_vertex>',
        `vec3 transformed = vPosL;
        {
          // The ship transform is rigid, so the transpose of its rotation is its
          // inverse and the light direction can be brought into ship space
          // without a matrix inverse (which GLSL ES 1.00 does not have).
          vec3 wp = (modelMatrix * vec4(transformed, 1.0)).xyz;
          vec3 away = normalize(wp - cameraPosition);
          transformed += normalize(away * mat3(modelMatrix)) * 0.16;
        }`,
      );
  };
  d.customProgramCacheKey = () => 'ship-sail-depth';
  return d;
}
