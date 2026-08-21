/**
 * The ensign at the spanker gaff.
 *
 * HISTORY, because getting a national flag wrong reads as carelessness. The
 * vessel modelled here is the 1797 44-gun frigate as she fought in 1812, and
 * the flag of the United States from 1 May 1795 to 3 July 1818 had **fifteen
 * stars and fifteen stripes** — the two states admitted after the original
 * thirteen each added a stripe as well as a star, which is why this is the only
 * US flag that is not thirteen-striped. Today's Constitution wears a 50-star
 * flag; she is a commissioned warship and that is correct for her, but it is
 * wrong for the ship being drawn.
 *
 * Proportions are those of the Star-Spangled Banner itself, the surviving
 * 15-star ensign: 30 ft on the hoist by 42 ft on the fly (1 : 1.4), a union
 * eight stripes deep, and stars two feet from point to point in five rows of
 * three. The wide gaps between the star columns are not an approximation —
 * that is what the real flag looks like.
 *
 * POSITION. A ship of this era wears her ensign at the **peak of the spanker
 * gaff**, on a halyard rove through the peak, not at a masthead. `frame.spanker`
 * gives the gaff peak, and the flag is carried by `PART.GAFF` so it goes round
 * with the boom and gaff when the spanker is sheeted.
 *
 * CLOTH. A flag is not a waving quad. Wool bunting flown from a fixed hoist
 * carries a travelling wave that starts at nothing on the hoist rope and grows
 * toward the free edge, and whose wavelength shortens and frequency rises with
 * the wind. In light air the aerodynamic force cannot hold the cloth out at all
 * and it hangs in a slack curtain from the halyard; in a gale it flies nearly
 * straight downwind and snaps. Both ends of that range are the same three
 * uniforms — how far it flies out, how big the wave is, how fast it runs — so
 * the flag reads the weather without a second model.
 */

import * as THREE from 'three';
import type { World } from '../../types';
import { PART } from '../dims';
import { PARTS_DECL } from '../shaders/parts';
import { GLSL_COMMON_SAFE, type PartUniforms } from '../materials/materials';
import { SHIP_AERIAL_FN, SHIP_AERIAL_UNIFORMS } from '../shaders/aerial';
import type { RigFrame } from './masts';

export interface EnsignResult {
  mesh: THREE.Mesh;
  update(world: World): void;
  applySettings(quality: number): void;
  dispose(): void;
}

/* ------------------------------------------------------------------ *
 *  Flag geometry, in flag units (hoist = 1)
 * ------------------------------------------------------------------ */

/** Fly / hoist. The Star-Spangled Banner is 30 ft by 42 ft. */
const FLY_RATIO = 42 / 30;
const STRIPES = 15;
/**
 * The union covers the top EIGHT stripes: 16 ft 1 in of a 30 ft hoist.
 *
 * Eight, not the seven of today's flag. Seven is a count that belongs to a
 * thirteen-stripe field: 7/13 = 0.538 of the hoist, and the same proportion on
 * fifteen stripes is 8.08 — which is what 16 ft 1 in of 30 ft measures. Carrying
 * the count across instead of the proportion would put the union at 0.467 and
 * leave it visibly shallower than the real flag's.
 */
const UNION_STRIPES = 8;
/** Union width as a fraction of the fly — the long-standing 2/5. */
const UNION_FLY_FRAC = 0.4;
const STAR_ROWS = 5;
const STAR_COLS = 3;
/** Stars are two feet point to point on a thirty-foot hoist. */
const STAR_R = 1 / 30;
/** Inner / outer radius of a regular five-pointed star. */
const STAR_INNER = Math.cos(Math.PI * 0.4) / Math.cos(Math.PI * 0.2);

/** Size of the ensign itself, metres on the hoist. */
const HOIST_M = 3.8;
/** Clearance from the spanker's leech, metres, in the sail's own plane. */
const LEECH_CLEAR_M = 0.22;

/**
 * Grid per quality tier, (along the fly, along the hoist).
 *
 * The fly needs the vertices, not the hoist: the travelling wave runs along the
 * fly and at a gale wavelength there are two and a half of them across it.
 */
const GRID: readonly [number, number][] = [[11, 6], [15, 8], [21, 11], [27, 14]];

/* ------------------------------------------------------------------ *
 *  Texture
 * ------------------------------------------------------------------ */

const _tex: THREE.Texture[] = [];

/** sRGB, because `bake` writes an sRGB-tagged byte texture. */
const RED: readonly [number, number, number] = [0.6, 0.128, 0.18];
const BLUE: readonly [number, number, number] = [0.165, 0.163, 0.335];
const WHITE: readonly [number, number, number] = [0.905, 0.887, 0.845];

/** Cheap value noise; the flag needs texture, not a noise library. */
function vnoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const h = (a: number, b: number) => {
    const s = Math.sin(a * 127.1 + b * 311.7 + seed * 74.7) * 43758.5453;
    return s - Math.floor(s);
  };
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = h(xi, yi);
  const b = h(xi + 1, yi);
  const c = h(xi, yi + 1);
  const d = h(xi + 1, yi + 1);
  return (a + (b - a) * sx) + ((c + (d - c) * sx) - (a + (b - a) * sx)) * sy;
}

/**
 * Signed distance to a regular five-pointed star at the origin, point toward
 * +y. Negative inside. Analytic, so the edge can be antialiased against the
 * texel size instead of being stepped and left to alias.
 *
 * `+y` is the star's OWN up, which is not the texture's: `v` runs down the hoist
 * from the head, so a caller passing `fy - cy` gets a pentagram standing on its
 * point. That is what shipped, and a dump of the baked texture measured the five
 * arms at 36.8, 108.5, 180.3, 252.5 and 325.5 degrees from vertical instead of
 * 0, 72, 144, 216, 288. An upside-down star on a national ensign is exactly the
 * class of error this file's header is about, and no amount of reading the
 * generator would have caught it.
 */
function starSd(x: number, y: number, r: number): number {
  const seg = Math.PI * 0.4;
  // Fold the plane into one of the five identical wedges about +Y.
  let a = Math.atan2(x, y);
  a -= Math.round(a / seg) * seg;
  const rad = Math.hypot(x, y);
  const px = Math.abs(rad * Math.sin(a));
  const py = rad * Math.cos(a);
  // Edge from the tip to the inner vertex of the wedge.
  const tx = 0;
  const ty = r;
  const ix = r * STAR_INNER * Math.sin(seg * 0.5);
  const iy = r * STAR_INNER * Math.cos(seg * 0.5);
  const dx = ix - tx;
  const dy = iy - ty;
  const len = Math.hypot(dx, dy);
  return (dx * (py - ty) - dy * (px - tx)) / len;
}

/**
 * Bake the flag. `u` runs from the hoist to the fly, `v` from the head down.
 *
 * Clamped, not repeated: at the leech the sail-style wrap would fetch the blue
 * of the union across the free edge and leave a coloured hairline that is
 * invisible in a thumbnail and obvious the moment anyone looks at the flag,
 * which is the whole failure mode this file is guarding against.
 */
function makeEnsignTexture(size: number): { map: THREE.Texture; normalMap: THREE.Texture } {
  const w = size;
  const h = Math.max(8, Math.round(size / FLY_RATIO));
  const alb = new Uint8Array(w * h * 4);
  const hgt = new Float32Array(w * h);
  const unionV = UNION_STRIPES / STRIPES;
  const unionU = UNION_FLY_FRAC;
  // One texel, in flag units, for antialiasing the star edges.
  const aa = 1.2 / h;

  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w;
      // Position in hoist units, so a star is round rather than stretched.
      const fx = u * FLY_RATIO;
      const fy = v;

      const row = Math.floor(v * STRIPES);
      let c: readonly [number, number, number] = row % 2 === 0 ? RED : WHITE;

      // Sewn seams between the strips of bunting, and the stitching in them.
      // The union is ONE piece of blue bunting, so the stripe seams stop at its
      // fly edge — carrying them across it drew eight horizontal creases over
      // the stars that no flag has ever had.
      const sv = v * STRIPES;
      const seamD = Math.min(sv - Math.floor(sv), 1 - (sv - Math.floor(sv))) / STRIPES;
      const inUnion = u < unionU && v < unionV;
      let seam = Math.max(0, 1 - seamD / (1.4 / h));
      if (inUnion) seam = 0;
      // The union's own two seams: where it is sewn to the stripes below and to
      // the field abaft it.
      const unionSeam = Math.max(
        Math.max(0, 1 - Math.abs(v - unionV) / (1.4 / h)) * (u < unionU ? 1 : 0),
        Math.max(0, 1 - Math.abs(u - unionU) * FLY_RATIO / (1.4 / h)) * (v < unionV ? 1 : 0),
      );
      seam = Math.max(seam, unionSeam);
      const stitch = seam * (vnoise(fx * 260, fy * 260, 7) > 0.55 ? 1 : 0);

      let inStar = 0;
      if (inUnion) {
        c = BLUE;
        const cw = unionU * FLY_RATIO;
        const ch = unionV;
        const col = Math.min(STAR_COLS - 1, Math.floor((fx / cw) * STAR_COLS));
        const srow = Math.min(STAR_ROWS - 1, Math.floor((fy / ch) * STAR_ROWS));
        const cx = ((col + 0.5) / STAR_COLS) * cw;
        const cy = ((srow + 0.5) / STAR_ROWS) * ch;
        // cy - fy, not fy - cy: v grows DOWN the hoist and the star points UP.
        const sd = starSd(fx - cx, cy - fy, STAR_R);
        inStar = 1 - Math.min(1, Math.max(0, sd / aa + 0.5));
      }
      if (inStar > 0) {
        c = [
          c[0] + (WHITE[0] - c[0]) * inStar,
          c[1] + (WHITE[1] - c[1]) * inStar,
          c[2] + (WHITE[2] - c[2]) * inStar,
        ];
      }

      // Weathering. A sea ensign fades and frays from the fly inward, and the
      // dye of the day was madder and indigo, both of which go chalky in sun.
      const fade = Math.pow(u, 2.6) * 0.3;
      const soil = (vnoise(fx * 7, fy * 7, 31) - 0.5) * 0.09
        + (vnoise(fx * 23, fy * 23, 47) - 0.5) * 0.05;
      // Worsted bunting: a coarse rib along the weave.
      const weave = (vnoise(fx * 340, fy * 120, 53) - 0.5) * 0.055;
      const light = 1 + soil + weave;

      const i = (y * w + x) * 4;
      for (let k = 0; k < 3; k++) {
        const base = c[k] * light;
        const faded = base + (0.86 - base) * fade;
        alb[i + k] = Math.max(0, Math.min(1, faded - seam * 0.14)) * 255;
      }
      alb[i + 3] = 255;
      hgt[y * w + x] = weave * 6 + seam * 0.5 + stitch * 0.7 + inStar * 0.25;
    }
  }

  const nrm = new Uint8Array(w * h * 4);
  const at = (x: number, y: number) =>
    hgt[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = at(x + 1, y) - at(x - 1, y);
      const dy = at(x, y + 1) - at(x, y - 1);
      let nx = -dx * 1.4;
      let ny = -dy * 1.4;
      const l = Math.hypot(nx, ny, 1);
      nx /= l;
      ny /= l;
      const i = (y * w + x) * 4;
      nrm[i] = (nx * 0.5 + 0.5) * 255;
      nrm[i + 1] = (ny * 0.5 + 0.5) * 255;
      nrm[i + 2] = (1 / l * 0.5 + 0.5) * 255;
      nrm[i + 3] = 255;
    }
  }

  const mk = (data: Uint8Array, srgb: boolean) => {
    const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = THREE.ClampToEdgeWrapping;
    t.wrapT = THREE.ClampToEdgeWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 8;
    t.needsUpdate = true;
    _tex.push(t);
    return t;
  };
  return { map: mk(alb, true), normalMap: mk(nrm, false) };
}

/* ------------------------------------------------------------------ *
 *  Cloth
 * ------------------------------------------------------------------ */

interface EnsignUniforms {
  /** Gaff-peak anchor of the head of the hoist, ship-local. */
  uEnsAnchor: { value: THREE.Vector3 };
  /**
   * Which way the hoist edge runs. NOT straight down: the spanker's boom is
   * 20.5 m and its gaff only 13.4, so the leech falls away aft at 29 degrees
   * from the vertical, and a flag hung plumb from the peak has its foot two
   * metres INSIDE the sail. Hanging it along the leech puts the whole flag
   * abaft the canvas in every trim, which is where an ensign at the peak
   * actually flies.
   */
  uEnsHoist: { value: THREE.Vector3 };
  /** Where the air GOES, in ship-local space, horizontal and normalised. */
  uEnsWind: { value: THREE.Vector3 };
  /** (hoist m, fly m, part slot, unused). */
  uEnsSize: { value: THREE.Vector4 };
  /** (fly-out 0..1, wave amplitude / fly, wavenumber, angular frequency). */
  uEnsWave: { value: THREE.Vector4 };
  uEnsTime: { value: number };
}

/**
 * The flag surface, as one function of (s along the fly, t down the hoist), so
 * the normal can be taken by difference of the deformed sheet rather than
 * interpolated from the flat one — the same trick the sails use, and the reason
 * a fold in the bunting shades like a fold.
 */
const ENSIGN_DECL = /* glsl */ `
uniform vec3 uEnsAnchor;
uniform vec3 uEnsHoist;
uniform vec3 uEnsWind;
uniform vec4 uEnsSize;
uniform vec4 uEnsWave;
uniform float uEnsTime;

vec3 lwEnsignPoint(vec2 st){
  float s = clamp(st.x, 0.0, 1.0);
  float t = clamp(st.y, 0.0, 1.0);
  float hoist = uEnsSize.x;
  float fly = uEnsSize.y;
  float out_ = uEnsWave.x;
  float amp = uEnsWave.y;
  float k = uEnsWave.z;
  float w = uEnsWave.w;

  vec3 down = uEnsHoist;
  vec3 wd = uEnsWind;
  vec3 side = normalize(cross(down, wd) + vec3(1e-5, 0.0, 0.0));

  // The hoist edge hangs on its halyard; the cloth leaves it downwind. In light
  // air 'out_' collapses and the same expression becomes a curtain hanging from
  // the halyard, which is what an ensign really does in a calm.
  float reach = fly * mix(0.34, 1.0, out_);
  float sagFly = (1.0 - out_) * fly * 0.72;
  vec3 P = shipPart(uEnsAnchor, uEnsSize.z)
    + down * (hoist * t)
    + wd * (reach * s)
    + vec3(0.0, -1.0, 0.0) * (sagFly * s * s);

  // Travelling wave: nothing at the hoist rope, growing toward the free edge,
  // and tilted along the hoist so the crease runs diagonally as it does on a
  // real flag rather than as a rigid vertical corrugation.
  float grow = pow(s, 1.45);
  float ph = k * s - w * uEnsTime + t * 1.75;
  float a = fly * amp * grow;
  float lat = sin(ph) + 0.34 * sin(2.27 * ph + 1.1);
  P += side * (a * lat);
  // The sheet twists as the fold passes, so the free edge lifts and falls too.
  P += down * (a * 0.34 * sin(ph * 0.82 + 2.1));
  // The unsupported foot of the hoist edge is pulled aft and down a little.
  P += down * (hoist * 0.04 * t * t * (1.0 - out_));
  return P;
}
`;

const ENSIGN_VERT = /* glsl */ `
  vec2 lwSt = position.xy;
  float lwDx = lwSt.x + uEnsStep.x > 1.0 ? -uEnsStep.x : uEnsStep.x;
  float lwDy = lwSt.y + uEnsStep.y > 1.0 ? -uEnsStep.y : uEnsStep.y;
  vec3 lwP  = lwEnsignPoint(lwSt);
  vec3 lwPs = lwEnsignPoint(lwSt + vec2(lwDx, 0.0));
  vec3 lwPt = lwEnsignPoint(lwSt + vec2(0.0, lwDy));
  vec3 lwN = cross(lwPt - lwP, lwPs - lwP) * sign(lwDx * lwDy);
  float lwNl = length(lwN);
  lwN = lwNl > 1e-9 ? lwN / lwNl : vec3(0.0, 0.0, 1.0);

  // lwEnsignPoint already transformed its anchor by the gaff. The rest is in
  // ship space on purpose: a flag streams downwind, and pushing the whole
  // sheet through the gaff's rotation would swing the wind round with the
  // boom.
  vPosL = lwP;
  vNormalL = lwN;
  vEnsUv = lwSt;
`;

export function buildEnsign(
  world: World,
  parts: PartUniforms,
  frame: RigFrame,
  quality: number,
): EnsignResult {
  const flyM = HOIST_M * FLY_RATIO;
  // Just under the peak, and a little inboard of it, so the halyard's upper
  // block has somewhere to be.
  // Down the leech, from the peak to the clew on the boom.
  const clew = frame.spanker.boomPivot.clone()
    .lerp(frame.spanker.boomEnd, 0.97);
  const leech = clew.clone().sub(frame.spanker.gaffEnd).normalize();
  // Perpendicular to the leech, in the sail's plane, pointing away from the
  // luff: the direction to stand the flag off the canvas.
  // (0, +z, -y) of a leech that runs down-and-aft points up-and-aft, which is
  // out of the sail. The other sign points down and forward, straight into the
  // canvas, and buries the hoist third of the flag behind it.
  const outward = new THREE.Vector3(0, leech.z, -leech.y).normalize();
  const anchor = frame.spanker.gaffEnd.clone()
    .addScaledVector(outward, LEECH_CLEAR_M)
    .addScaledVector(leech, 0.18);

  const u: EnsignUniforms = {
    uEnsAnchor: { value: anchor },
    uEnsHoist: { value: leech },
    uEnsWind: { value: new THREE.Vector3(0, 0, 1) },
    uEnsSize: { value: new THREE.Vector4(HOIST_M, flyM, PART.GAFF, 0) },
    uEnsWave: { value: new THREE.Vector4(0.5, 0.09, 9, 6) },
    uEnsTime: { value: 0 },
  };
  const step = { value: new THREE.Vector2() };

  let res = GRID[Math.max(0, Math.min(3, quality))];
  let geo = makeGrid(res[0], res[1]);
  step.value.set(1 / (res[0] - 1), 1 / (res[1] - 1));

  const tex = makeEnsignTexture(quality >= 2 ? 512 : 256);
  const mat = new THREE.MeshStandardMaterial({
    map: tex.map,
    normalMap: tex.normalMap,
    // Worsted wool bunting: matte, and it takes no specular worth speaking of.
    roughness: 0.92,
    metalness: 0,
    side: THREE.DoubleSide,
    dithering: true,
  });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.uniforms.uEnsStep = step;
    shader.uniforms.uPartQ = parts.uPartQ;
    shader.uniforms.uPartP = parts.uPartP;
    shader.uniforms.uSunDirection = world.uniforms.uSunDirection;
    shader.uniforms.uSunColor = world.uniforms.uSunColor;
    shader.uniforms.uSunIntensity = world.uniforms.uSunIntensity;
    shader.uniforms.uMoonColor = world.uniforms.uMoonColor;
    shader.uniforms.uMoonIntensity = world.uniforms.uMoonIntensity;
    shader.uniforms.uFogColor = world.uniforms.uFogColor;
    shader.uniforms.uFogDensity = world.uniforms.uFogDensity;
    shader.uniforms.uVisibility = world.uniforms.uVisibility;
    shader.vertexShader = /* glsl */ `
      ${GLSL_COMMON_SAFE}
      ${PARTS_DECL}
      uniform vec2 uEnsStep;
      varying vec2 vEnsUv;
      ${ENSIGN_DECL}
      ${shader.vertexShader
        .replace('void main() {', `vec3 vPosL;\nvec3 vNormalL;\nvoid main() {\n${ENSIGN_VERT}`)
        .replace(
          '#include <uv_vertex>',
          `#include <uv_vertex>
          #ifdef USE_MAP
            vMapUv = vEnsUv;
          #endif
          #ifdef USE_NORMALMAP
            vNormalMapUv = vEnsUv;
          #endif`,
        )
        .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vNormalL;')
        .replace('#include <begin_vertex>', 'vec3 transformed = vPosL;')}
    `;
    shader.fragmentShader = `varying vec2 vEnsUv;\n${SHIP_AERIAL_UNIFORMS}\n${shader.fragmentShader
      // After three's own '#include <common>': lwShipAerial needs
      // 'inverseTransformDirection' from it and the 'vViewPosition' varying
      // three declares just above it.
      .replace('#include <common>', `#include <common>\n${SHIP_AERIAL_FN}`)
      .replace(
        '#include <opaque_fragment>',
        `#include <opaque_fragment>
        // The air in front of the bunting, so a flag forty metres up hazes with
        // the masthead it flies from. See shaders/aerial.ts.
        gl_FragColor.rgb = lwShipAerial(gl_FragColor.rgb);`,
      )}`;
  };
  mat.customProgramCacheKey = () => 'ship-ensign';

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'ship-ensign';
  // A three-metre rag forty metres up casts nothing anyone can see, and a
  // shadow would need a second copy of the vertex animation in a depth
  // material to be correct rather than wrong.
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  mesh.renderOrder = 1;

  return {
    mesh,
    update(w) {
      u.uEnsTime.value = w.time.elapsed;
      // Where the air goes, in the ship's frame, flattened to the horizontal:
      // a flag streams downwind whatever the gaff is doing.
      _wind.copy(w.env.windVector);
      _iq.copy(w.ship.quaternion).conjugate();
      _wind.applyQuaternion(_iq);
      _wind.y = 0;
      if (_wind.lengthSq() < 1e-6) _wind.set(0, 0, 1);
      _wind.normalize();
      u.uEnsWind.value.copy(_wind);

      // One number drives the whole range: how hard it is blowing.
      const spd = w.env.windSpeed * w.env.gust;
      // Flying out: nothing below about 2 m/s, board-flat by a near gale.
      const out = THREE.MathUtils.clamp((spd - 1.6) / 12.5, 0, 1);
      const wave = u.uEnsWave.value;
      wave.x = out * out * (3 - 2 * out);
      // Amplitude peaks in a fresh breeze and is squeezed out again as the
      // cloth is pulled bar-taut: a flag in a real gale cracks rather than
      // billows, which is the second harmonic in the shader doing the work.
      wave.y = 0.03 + 0.115 * Math.sin(Math.PI * Math.min(1, spd / 22)) ** 0.7;
      // Shorter, faster waves as it blows harder.
      wave.z = 5.2 + 0.62 * spd;
      wave.w = 1.4 + 0.72 * spd;
    },
    applySettings(q) {
      const want = GRID[Math.max(0, Math.min(3, q))];
      if (want[0] === res[0] && want[1] === res[1]) return;
      res = want;
      geo.dispose();
      geo = makeGrid(res[0], res[1]);
      mesh.geometry = geo;
      step.value.set(1 / (res[0] - 1), 1 / (res[1] - 1));
    },
    dispose() {
      geo.dispose();
      mat.dispose();
      for (const t of _tex) t.dispose();
      _tex.length = 0;
    },
  };
}

const _wind = new THREE.Vector3();
const _iq = new THREE.Quaternion();

/** `position.xy` IS (s along the fly, t down the hoist). */
function makeGrid(ns: number, nt: number): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array(ns * nt * 3);
  const uv = new Float32Array(ns * nt * 2);
  const nrm = new Float32Array(ns * nt * 3);
  const idx: number[] = [];
  for (let i = 0; i < ns; i++) {
    for (let j = 0; j < nt; j++) {
      const k = i * nt + j;
      const a = i / (ns - 1);
      const b = j / (nt - 1);
      pos[k * 3] = a;
      pos[k * 3 + 1] = b;
      uv[k * 2] = a;
      uv[k * 2 + 1] = b;
      nrm[k * 3 + 2] = 1;
    }
  }
  for (let i = 0; i < ns - 1; i++) {
    for (let j = 0; j < nt - 1; j++) {
      const a = i * nt + j;
      const b = (i + 1) * nt + j;
      const c = (i + 1) * nt + j + 1;
      const d = i * nt + j + 1;
      idx.push(a, b, c, a, c, d);
    }
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 20, 30), 12);
  return g;
}
