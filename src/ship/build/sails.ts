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
import type { SailState, World } from '../../types';
import { GLSL, lwFloat } from '../../util/glsl';
import { SHARED_UNIFORM_DECL } from '../../core/SharedUniforms';
import { JIB_CUT, JIB_IDS, MASTS, PART, SAIL_YARDS, SPANKER_CLEW, squareCut } from '../dims';
import { PARTS_DECL } from '../shaders/parts';
import {
  PANEL_TILE_M, PANEL_WIDTH_M, SAIL_VERT_BODY, SEAM_TILE_M, sailDecl,
  sailVertOuts,
} from '../shaders/sail';
import type { PartUniforms } from '../materials/materials';
import type { TexSet } from '../materials/textures';
import type { RigFrame } from './masts';
import { buildRigEnvelope } from './rigEnvelope';

export interface SailResult {
  group: THREE.Group;
  meshes: THREE.Mesh[];
  /**
   * The cloth's own uniforms, so the rigging material can evaluate the SAME
   * `lwSailPoint` the cloth is drawn from. That is what lets a buntline lie on
   * the animated sail instead of through it — see `shaders/line.ts`.
   */
  uniforms: SailUniforms;
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

/** How far forward of the yard's surface the jackstay holds the head, metres. */
export const JACKSTAY_STANDOFF_M = 0.06;

/** How much light comes through the cloth, relative to its diffuse albedo. */
const CLOTH_TRANSMISSION = 0.34;

/** Depth of a tension crease at the clew, metres. */
const CREASE_AMP_M = 0.05;
/** How far a crease reaches into the sail, as a fraction of the hoist. */
const CREASE_REACH = 0.4;
/** Ridges in the fan from one corner, in cycles of the fan parameter. */
const CREASE_CYCLES = 2.4;

export interface SailUniforms {
  uSailA: { value: THREE.Vector3[] };
  uSailB: { value: THREE.Vector3[] };
  uSailC: { value: THREE.Vector3[] };
  uSailD: { value: THREE.Vector3[] };
  uSailState: { value: THREE.Vector4[] };
  uSailInfo: { value: THREE.Vector4[] };
  /** Per sail: 0 = drawing or slack, 1 = fully aback. See `shaders/sail.ts`. */
  uSailAback: { value: number[] };
  uSailStep: { value: THREE.Vector2 };
  uSailTime: { value: number };
  /** Where the standing rigging is, so the cloth can take up against it. */
  uRigPlane: { value: THREE.Vector4[] };
  uRigBand: { value: THREE.Vector4[] };
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
    uSailAback: { value: new Array<number>(Math.max(1, n)).fill(0) },
    uSailStep: { value: new THREE.Vector2() },
    uSailTime: { value: 0 },
    ...buildRigEnvelope(frame),
  };
  for (let i = 0; i < n; i++) {
    u.uSailA.value.push(new THREE.Vector3());
    u.uSailB.value.push(new THREE.Vector3());
    u.uSailC.value.push(new THREE.Vector3());
    u.uSailD.value.push(new THREE.Vector3());
    u.uSailState.value.push(new THREE.Vector4(0, 0, 0, 0));
    u.uSailInfo.value.push(new THREE.Vector4(0, 0, 0, 0));
  }

  const { isFA, drawn, area } = writeSailCuts(u, sails, frame);

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
    uniforms: u,

    update(w) {
      const st = u.uSailState.value;
      const abk = u.uSailAback.value;
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
        // ---- THE ABACK HOOK. NOT YET LIVE.
        //
        // As of this commit `SailState` (src/types/index.ts) has no aback field:
        // physics is adding one in a separate session because the rig currently
        // cannot tell a sail that is drawing from one pressed backwards against
        // the mast — `luffTarget` uses |alpha| — and so reports the whole sail
        // plan full and drawing when head to wind, and four fifths of it
        // flogging on a beat (DIAGNOSIS.md §20). `luff` feeds this shader
        // directly, so that wrong state is what the player sees.
        //
        // The read below is deliberately defensive rather than commented out, so
        // that the day the field lands this file needs NO edit at all — the
        // cloth starts rendering aback on the next frame. Until then every sail
        // reports 0 and `shaders/sail.ts` multiplies its aback terms by exactly
        // zero, which is why the drawing and shivering shapes are unchanged.
        //
        // Expected semantics, which is what the shader is written against:
        // 0 = drawing or merely slack, 1 = wind full on the forward face.
        // A plain boolean also works — `+true` is 1.
        abk[i] = +((s as { aback?: number }).aback ?? 0) || 0;
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

/**
 * The flat cut of every sail: four corners and an info vector each.
 *
 * Split out of `buildSails` so it can be run with no renderer at all —
 * `.tmp/ropecpu.mjs` calls this and `buildLines` to measure rope-through-canvas
 * in plain node. A probe that reimplemented the cut would drift from it, and
 * has: a sheet started a metre from the clew it is bent to because two places
 * built the same corner.
 */
export function writeSailCuts(
  u: SailUniforms, sails: readonly SailState[], frame: RigFrame,
): { isFA: Uint8Array; drawn: number[]; area: number } {
  const n = sails.length;
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
      // The jackstay is an iron rod along the yard's FORWARD face, so the head
      // is bent a whole radius forward of the spar's axis, not a third of one.
      // At 0.35 the cloth started inside the yard, and with any camber at all
      // it started inside the forward-most lower shrouds too.
      const hz = yf.centre.z - (yard.radius + JACKSTAY_STANDOFF_M);
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

  return { isFA, drawn, area };
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

const VERT_HEAD = `
${sailVertOuts(true)}
`;

const FRAG_HEAD = `
${sailVertOuts(true)}
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
 * THE WEAVE IS GONE, and the arithmetic says it had to be.
 *
 * There used to be a per-pixel plain-weave tier here at a 2.4 mm warp pitch. It
 * faded itself out with 'clamp(WARP / (2 * fwidth) - 1)', which was the right
 * instinct, but the fade was never anything but zero. This camera is 58 degrees
 * of VERTICAL field over 900 pixels, so one pixel subtends 2 * tan(29) / 900 =
 * 1.232 mm per metre of range: at the helm's 15-25 m from the courses a pixel is
 * 18-31 mm of cloth, and the weave needs 1.2 mm to survive its own fade. That is
 * a range of 0.97 m, closer than the player can get to any sail in the suit, and
 * fwidth only grows with obliquity, never shrinks. So the tier was provably zero
 * at every reachable range and it is deleted rather than defended.
 *
 * (The previous note here assumed 50 degrees over 1600 px and got 1.17 mm at 2 m,
 * which is the same number a factor of two too fine. The fov and the pixel count
 * are both in 'src/core/settings.ts' and 'scripts/capture.mjs'; measure, do not
 * assume, because a 2x error in the pixel footprint is a 2x error in every
 * antialiasing fade in this file.)
 *
 * Individual threads are not renderable on this ship. What IS renderable at
 * 18-31 mm a pixel is the BOLT: a 610 mm cloth is 20-34 px, its seam is the
 * strongest thing on a real sail, and the cockle flutes between the seams are
 * 10-20 px. That is the tier below and it is the only one there needs to be.
 */

/**
 * The COCKLE of a bolt of duck: long shallow flutes running head to foot.
 *
 * The warp is the stiff direction, so cloth under tension flutes ALONG the bolt.
 * That is the whole difference between cloth and stucco: the relief has a grain,
 * and the grain is the seam direction. The regular part of the corrugation — one
 * crest and one trough to each 610 mm cloth — is in the baked map, where it is
 * free and mips correctly; this is the irregular tier over it, at 550 mm across
 * the bolt and 3 m along, whose job is to break the map's 2.44 m tile before the
 * repeat becomes visible on a 22 m course.
 *
 * WHY THE OCTAVE WEIGHTS ARE WHAT THEY ARE. In an fBm the SLOPE an octave
 * contributes is its amplitude times its frequency, so the octave weighting that
 * governs the normal map is 'lacunarity * gain', not 'gain'. The tier this
 * replaces used 2.85 and 0.45, i.e. 1.28 — over one, so its FINEST octave, the
 * one nearest the pixel, carried more slope than its base and owned the shading.
 * 2.0 and 0.35 is 0.70, so the base octave owns it and the fine one only
 * roughens. Each octave is also faded on ITS OWN pitch rather than the tier's.
 *
 * Calibrated, not guessed: '.tmp/noise2dstat.mjs' checks the ported derivative
 * against a finite difference and measures 'noise2d_d' at an RMS per-axis
 * gradient of 0.625 and an RMS value of 0.216, so the RMS chord slope of this
 * tier is AMP * kc * 0.625 * sqrt(1 + 0.70^2) and can be stated in degrees.
 *
 *   m  (along the span, across the chord) in metres
 *   aa (fwidth(span), fwidth(chord)) in metres per pixel
 *   returns  roughly -1..1
 *   g        out: d/dm, per metre
 */
float lwClothCockle(vec2 m, vec2 aa, out vec2 g) {
  const float ACROSS = 0.55;
  const float ALONG = 3.0;
  const float LAC = 2.0;
  const float GAIN = 0.35;
  float kc = 1.0 / ACROSS;
  float ka = 1.0 / ALONG;
  float f1 = clamp(ACROSS / max(aa.y * 2.0, 1e-7) - 1.0, 0.0, 1.0);
  float f2 = clamp(ACROSS / LAC / max(aa.y * 2.0, 1e-7) - 1.0, 0.0, 1.0);
  vec2 p = vec2(m.x * ka, m.y * kc);
  vec3 a = noise2d_d(p + 5.13);
  vec3 b = noise2d_d(p * LAC + 31.7);
  g = vec2(a.y * ka, a.z * kc) * f1
    + vec2(b.y * ka, b.z * kc) * (LAC * GAIN * f2);
  return a.x * f1 + b.x * GAIN * f2;
}

/**
 * The seam, as the lapped and doubled thickness of cloth it is rather than a
 * stripe painted on — the same argument that makes the deck's caulk a groove
 * instead of a black line in 'shaders/detail.ts'.
 *
 * This is the strongest relief on a real sail and it is deliberately NOT in the
 * baked map: 22 mm of lap is four texels of a 512 map over 2.44 m, so the mip
 * chain destroys it first, and a version baked at full strength put a
 * 74-degree crease in the map's top percentile. Here it holds its step at any
 * range, because the shoulder is widened to a pixel and its slope drops to
 * match — conserving the total rise exactly the way 'lwClothLine' conserves a
 * line's ink.
 *
 *   seamD  metres from the seam centreline
 *   aa     metres of chord per pixel
 *   h      out: height in metres, 0 outside the lap
 *   returns  dh/d(seamD), which is negative
 */
float lwSeamLap(float seamD, float aa, out float h) {
  const float LAP_M = 0.011;
  const float RISE_M = 0.0015;
  float w = max(0.004, aa);
  float x = clamp((seamD - LAP_M + w) / (2.0 * w), 0.0, 1.0);
  h = RISE_M * (1.0 - x * x * (3.0 - 2.0 * x));
  return -RISE_M * 3.0 * x * (1.0 - x) / w;
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
    // 1.0, because 'makeCanvas' now bakes its height in METRES with the Sobel
    // gain set so the stored normal IS the surface slope. Anything else here
    // makes the map's measured slope a lie: '.tmp/clothprobe.mjs' reports on the
    // texture, and this is the only thing between the texture and the shading.
    normalScale: new THREE.Vector2(1, 1),
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
        float lwClothR = 0.0;
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
          // Every cloth is a slightly different bolt of flax. This is the only
          // bolt tone there is now: the baked map used to add a second one from
          // 'lattice(bolt, floor(u * 3))', which is a hard-edged 867 x 610 mm
          // rectangle of constant value, and two of them together are the
          // owner's "quilted" almost by construction. This one is per bolt for
          // the bolt's whole length, does not repeat with the tile, and sits at
          // the seam's exact phase.
          float panelTone = hash11(floor(pf) * 0.731 + 3.17);
          // Two rows of hand stitching, one either side of the overlap, at the
          // ten-to-the-inch a sailmaker works to. This is the detail that says
          // the seam is sewn rather than drawn on.
          //
          // The ROWS hold at any range — they are 1.6 mm lines and 'lwClothLine'
          // fades their contrast honestly. The individual STITCHES do not: below
          // Nyquist an 8.5 mm repeat stops being stitches, because
          // min(fract, 1 - fract) * 0.0085 never exceeds 4.25 mm, so once a pixel
          // is wider than that the line covers every sample and the term
          // collapses into a beat pattern. So the dash modulation fades to a
          // continuous row rather than taking the row down with it.
          const float STITCH_PITCH_M = 0.0085;
          float stitchRes = clamp(STITCH_PITCH_M / max(aaS * 2.0, 1e-7) - 1.0, 0.0, 1.0);
          float stitchRow = lwClothLine(abs(seamD - 0.016), 0.0016, aaC);
          float dash = lwClothLine(
            min(fract(spanM / STITCH_PITCH_M), 1.0 - fract(spanM / STITCH_PITCH_M))
              * STITCH_PITCH_M, 0.0022, aaS);
          float stitch = stitchRow * mix(1.0, dash, stitchRes);

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
          // ABACK. Slack cloth loses its creases because it is carrying nothing;
          // aback cloth is carrying MORE than a drawing sail, just backwards
          // over the mast, so it keeps them and sharpens them. The load term
          // therefore recovers with 'aback' after the luff has killed it, and
          // the fan reach shortens because the cloth is stretched over an edge a
          // metre away rather than hauled from a clew ten metres away.
          float aback = clamp(vAback, 0.0, 1.0);
          float load = clamp(vCloth.w, 0.0, 1.0) * (1.0 - vSail.w)
                     + aback * (0.85 - 0.5 * clamp(vCloth.w, 0.0, 1.0));
          vec2 dClew = vec2(vCloth.x, fromFoot);
          vec2 dHead = vec2(vCloth.x, spanM);
          float reach = max(vCloth.y, 1.0) * ${lwFloat(CREASE_REACH)} * (1.0 - 0.45 * aback);
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

          // The cockle. AMP is set from the measured statistics of 'noise2d_d'
          // (see 'lwClothCockle'): 0.032 * (1 / 0.55) * 0.625 * 1.221 is an RMS
          // chord slope of 0.044, a two-and-a-half-degree ripple, against 0.008 —
          // half a degree — along the bolt. Six to one, and the six is the seam
          // direction. A reef band is a row of points seized through eyelets and
          // the cloth gathers at every one, so the flutes are pulled harder where
          // a band runs; that stands in for a third crease fan at a tenth of the
          // cost.
          vec2 aaW = vec2(fwidth(spanM), fwidth(chordM));
          vec2 cockleG;
          float cockle = lwClothCockle(vec2(spanM, chordM), aaW, cockleG);
          float bandPull = 1.0 + 0.9 * band;
          cockle *= bandPull;
          cockleG *= bandPull;
          // Gloss follows the cockle along the warp: a real sail catches the
          // light in bands running down the cloth, not in a uniform sheen.
          lwClothR = 0.07 * cockle;
          // The lapped seam. With the baked map's seam height gone this is the
          // strongest relief on a sail, and on a real one it should be.
          float lapH;
          float lapSlope = lwSeamLap(seamD, aaC, lapH);
          // lwClothCockle works in (span, chord); lwCreaseG is in (chord, span).
          lwCreaseG += vec2(cockleG.y, cockleG.x) * 0.032;
          lwCreaseG.x += lapSlope * sign(0.5 - fract(pf));

          diffuseColor.rgb *= 0.96 + 0.08 * panelTone;
          diffuseColor.rgb *= 1.0 + 0.075 * cockle;
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

          // ---- ABACK: the rig printed on the cloth.
          //
          // This is the read that tells aback from slack at a glance. Slack
          // canvas is uniformly pale and softly folded; canvas pressed onto the
          // mast and the standing rigging picks up tar and slush from the spars
          // in HARD-EDGED bands, and the contact itself occludes.
          //
          // In FRACTIONAL chord rather than metres, deliberately. The lower mast
          // is 0.5-0.9 m through and the chords it presses on run 10 m at the
          // royal to 22 m at the course, so the contact is 4-5% of the chord on
          // every sail in the suit — near enough constant that a fraction is the
          // more honest parameter, and it needs no chord length to be recovered
          // from a varying that can be zero.
          // No branch on 'aback': it is a varying, so a conditional on it is
          // non-uniform control flow and the fwidth below would be undefined
          // inside it. Same trap as the crease fan above; the terms collapse to
          // zero on their own.
          float aaF = fwidth(vSail.x) * 0.6 + 1e-5;
          float mast = lwClothLine(abs(vSail.x - 0.5), 0.024, aaF) * (1.0 - vCloth.z);
          // Two topmast backstays either side, and the sail rubs hardest where
          // the cloth is fullest rather than at head or foot.
          float stay = max(lwClothLine(abs(vSail.x - 0.30), 0.007, aaF),
                           lwClothLine(abs(vSail.x - 0.70), 0.007, aaF));
          float press = (mast + stay * 0.7) * smoothstep(0.06, 0.42, vSail.y) * aback;
          diffuseColor.rgb *= 1.0 - 0.30 * press;
          // Contact creases kink the surface, so they carry a normal too.
          lwCreaseG.x += press * 0.55 * sign(vSail.x - 0.5);
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
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor = clamp(roughnessFactor + lwClothR, 0.35, 1.0);`,
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
${sailVertOuts(false)}
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
