import * as THREE from 'three';
import { MeshBuilder, mixRGB, srgb, type Aux, type RGB } from './wgeom';

/**
 * Other vessels, built the same way the player's ship is — a lofted hull, real
 * spars, real cloth — at a fraction of the detail, because the nearest one you
 * will ever get is a couple of cables off the beam.
 *
 * Ship local axes: +X starboard, +Y up, -Z forward. y = 0 is her own waterline,
 * so the instance origin can be dropped straight onto the wave height.
 */

export interface MastSpec {
  /** Ship-local z of the mast heel, metres. */
  z: number;
  /** Masthead height above the waterline, metres. */
  height: number;
  /** Number of square sails, course first. 0 for a fore-and-aft rig. */
  squares: number;
  /** A gaff sail set on this mast, abaft it. */
  gaff?: boolean;
  /** Fraction of the mast's height the gaff peak reaches. */
  gaffPeak?: number;
  /** Boom length abaft the mast, metres. Defaults to 0.30 of the hull length. */
  boom?: number;
}

export interface VesselSpec {
  key: string;
  label: string;
  /** Hull length, metres. */
  loa: number;
  beam: number;
  draught: number;
  /** Rail height above the waterline amidships, metres. */
  rail: number;
  masts: MastSpec[];
  /** Bowsprit length forward of the stem, metres. 0 for none. */
  bowsprit: number;
  jibs: number;
  hull: number;
  /** Gunport-stripe centres, as a fraction of the rail height at each station. */
  stripes: readonly number[];
  /** Half-height of the painted band, metres. */
  stripeH: number;
  /** Gunports a side per stripe. 0 for a vessel that carries no guns. */
  ports: number;
  boot: number;
  canvas: number;
  /** Best speed through the water, m/s. */
  topSpeed: number;
  /** Divides the heel angle: a three-decker is stiffer than a fishing boat. */
  stiffness: number;
}

const ROUGH_PAINT = 0.42;
const ROUGH_CANVAS = 0.86;
const ROUGH_DECK = 0.74;
const ROUGH_SPAR = 0.58;
const ROUGH_RIG = 0.9;

/** `aAux.x` codes; the meaning of the middle channels follows from it. */
const KIND_FIXED = 0;
const KIND_SQUARE = 1;
const KIND_FORE_AFT = 2;
const KIND_ROPE = 3;

/** No stripe anywhere near this vertex. Any value past the widest band will do. */
const NO_STRIPE = 1e3;

/** Hull stations, bow to stern: [t, halfBeamFrac, keelFrac, railFrac]. */
const STATIONS: readonly (readonly [number, number, number, number])[] = [
  [0.00, 0.05, 0.30, 1.16],
  [0.07, 0.30, 0.72, 1.02],
  [0.18, 0.66, 0.94, 0.86],
  [0.32, 0.90, 1.00, 0.76],
  [0.48, 1.00, 1.00, 0.72],
  [0.63, 0.98, 0.99, 0.74],
  [0.78, 0.84, 0.92, 0.82],
  [0.91, 0.60, 0.72, 0.95],
  [1.00, 0.44, 0.40, 1.08],
];

/** The buff the gunport stripes are painted in. */
export const STRIPE_COLOUR = 0xd8b166;

/**
 * Section outline, starboard side: [halfBeamScale, above-water?, yFrac].
 *
 * The stripes used to need their own levels here, because the paint was baked
 * into vertex colours and so had to land ON a vertex to exist. It does not any
 * more — the fragment shader box-filters the band — but the levels the shader
 * DOES need are the ones that keep the distance-to-the-nearest-stripe linear
 * inside every quad: the centre of each stripe, where that distance has a kink,
 * and the midpoint between two stripes, where the nearest stripe changes. Miss
 * either and the band bends in the middle of a strake.
 */
function sectionOutline(stripes: readonly number[]): (readonly [number, number, number])[] {
  const levels = new Set<number>([1.0, 0.86, 0.72, 0.5, 0.3, 0.14, 0.0]);
  const st = [...stripes].sort((a, b) => a - b);
  for (let i = 0; i < st.length; i++) {
    levels.add(st[i]);
    if (i + 1 < st.length) levels.add((st[i] + st[i + 1]) * 0.5);
  }
  const sorted = [...levels].sort((a, b) => b - a);
  const out: (readonly [number, number, number])[] = [];
  for (const yf of sorted) {
    // Tuck the topside in very slightly above the wale so the rail reads as a
    // rail rather than as the widest part of the hull.
    const hs = yf > 0.78 ? 0.975 : yf > 0.42 ? 1.0 : 0.995;
    out.push([hs, 1, yf]);
  }
  out.push([0.9, 0, 0.32], [0.62, 0, 0.7], [0.2, 0, 0.94], [0.0, 0, 1.0]);
  return out;
}

function hullColour(spec: VesselSpec, yFrac: number, above: boolean): RGB {
  const hull = srgb(spec.hull);
  if (!above) return mixRGB(srgb(spec.boot), hull, 0.25);
  if (yFrac > 0.9) return mixRGB(hull, srgb(0x000000), 0.35);
  if (yFrac < 0.16) return mixRGB(hull, srgb(spec.boot), 0.45);
  return hull;
}

/**
 * Signed metres from this vertex to the nearest stripe centre on its own
 * station, which is what the fragment shader filters the band out of. Signed,
 * not absolute, so the two edges of the band are distinguishable; the sign is
 * arbitrary but has to be consistent, so it is measured upward.
 */
function stripeDistance(spec: VesselSpec, railY: number, y: number): number {
  if (!spec.stripes.length) return NO_STRIPE;
  let best = NO_STRIPE;
  for (const s of spec.stripes) {
    const d = y - railY * s;
    if (Math.abs(d) < Math.abs(best)) best = d;
  }
  return best;
}

function buildHull(b: MeshBuilder, spec: VesselSpec): void {
  const half = spec.loa * 0.5;
  const railIdx: number[][] = [];
  const deckIdx: number[][] = [];
  const rings: number[][] = [];
  const aux: Aux = [KIND_FIXED, NO_STRIPE, 0, ROUGH_PAINT];
  const section = sectionOutline(spec.stripes);

  for (const [t, hbf, keelf, railf] of STATIONS) {
    const z = -half + t * spec.loa;
    const hb = Math.max(0.02, (spec.beam * 0.5) * hbf);
    const keelY = -spec.draught * keelf;
    const railY = spec.rail * railf;
    const ring: number[] = [];
    const starboard: number[] = [];
    const port: number[] = [];
    for (const [hs, kindAbove, yf] of section) {
      const above = kindAbove === 1;
      const y = above ? railY * yf : keelY * yf;
      const col = hullColour(spec, yf, above);
      // Only the painted topside carries a stripe; her copper does not.
      const sd: Aux = [KIND_FIXED, above ? stripeDistance(spec, railY, y) : NO_STRIPE, 0, ROUGH_PAINT];
      starboard.push(b.vert(hb * hs, y, z, col, sd));
      if (hs > 1e-4) port.push(b.vert(-hb * hs, y, z, col, sd));
    }
    for (let i = 0; i < starboard.length; i++) ring.push(starboard[i]);
    for (let i = port.length - 1; i >= 0; i--) ring.push(port[i]);
    rings.push(ring);
    railIdx.push([starboard[0], port[0]]);
    deckIdx.push([starboard[1], port[1], hb * 0.96, railY * 0.86, z]);
  }
  b.tube(rings, false);

  // Deck. Without it the hull is an open trough and you see straight through
  // the bow, which is the single most common way a low-detail ship reads as
  // unfinished.
  const deckCol = srgb(0x9c7c50);
  const deckAux: Aux = [KIND_FIXED, NO_STRIPE, 0, ROUGH_DECK];
  const deckRows: number[][] = [];
  for (const d of deckIdx) {
    const hb = d[2] as number;
    const y = d[3] as number;
    const z = d[4] as number;
    deckRows.push([
      b.vert(hb, y, z, deckCol, deckAux),
      b.vert(hb * 0.55, y + 0.02, z, deckCol, deckAux),
      b.vert(-hb * 0.55, y + 0.02, z, deckCol, deckAux),
      b.vert(-hb, y, z, deckCol, deckAux),
    ]);
  }
  b.tube(deckRows, false);

  // Stem and transom, closed.
  const stemCol = mixRGB(srgb(spec.hull), srgb(0x000000), 0.2);
  const first = rings[0];
  const stem = b.vert(0, spec.rail * 0.62, -half - spec.loa * 0.035, stemCol, aux);
  for (let i = 0; i + 1 < first.length; i++) b.tri(stem, first[i + 1], first[i]);
  b.tri(stem, first[0], first[first.length - 1]);

  const last = rings[rings.length - 1];
  const transom = b.vert(0, spec.rail * 0.5, half + spec.loa * 0.012, stemCol, aux);
  for (let i = 0; i + 1 < last.length; i++) b.tri(transom, last[i], last[i + 1]);
  b.tri(transom, last[last.length - 1], last[0]);
}

/**
 * One sail. A quadrilateral grid with the belly baked in as a 0..1 shape the
 * vertex shader scales and signs per instance, so the same geometry draws a sail
 * full on one tack and full the other way on the other. Collapse `p10` onto
 * `p11` for a triangular jib.
 */
function sailPanel(
  b: MeshBuilder,
  p00: readonly [number, number, number],
  p10: readonly [number, number, number],
  p11: readonly [number, number, number],
  p01: readonly [number, number, number],
  nu: number,
  nv: number,
  kind: number,
  pivotZ: number,
  col: RGB,
  tone = 1,
): void {
  const rows: number[][] = [];
  for (let iv = 0; iv <= nv; iv++) {
    const v = iv / nv;
    const row: number[] = [];
    for (let iu = 0; iu <= nu; iu++) {
      const u = iu / nu;
      const ax = p00[0] + (p10[0] - p00[0]) * u;
      const ay = p00[1] + (p10[1] - p00[1]) * u;
      const az = p00[2] + (p10[2] - p00[2]) * u;
      const bx = p01[0] + (p11[0] - p01[0]) * u;
      const by = p01[1] + (p11[1] - p01[1]) * u;
      const bz = p01[2] + (p11[2] - p01[2]) * u;
      const bulge = Math.sin(Math.PI * u) * Math.sin(Math.PI * v);
      /*
       * A three-master's canvas has to read as four or five separate sails and
       * not one pale mass, and what separates two courses is the dark band at
       * the foot of the upper one: the yard shadows it, the sail above shades
       * it, and the belly's lower curve turns away from the sky.
       *
       * Baked as a RAMP over the lower third rather than as an edge, on purpose.
       * A hard line one pixel wide has the same sub-pixel problem as a shroud;
       * a gradient point-samples to its own average at every distance, so the
       * separation survives all the way out to the horizon without aliasing.
       */
      const foot = 1 - 0.44 * Math.min(1, Math.max(0, (v - 0.5) / 0.5) ** 1.4);
      // Both leeches a little darker: a sail is a curved surface, not a card.
      const limb = 1 - 0.10 * Math.abs(2 * u - 1) ** 2;
      const shade = foot * limb * tone;
      row.push(
        b.vert(
          ax + (bx - ax) * v,
          ay + (by - ay) * v,
          az + (bz - az) * v,
          [col[0] * shade, col[1] * shade, col[2] * shade],
          [kind, pivotZ, bulge, ROUGH_CANVAS],
        ),
      );
    }
    rows.push(row);
  }
  b.tube(rows, false);
}

function buildRig(b: MeshBuilder, spec: VesselSpec): void {
  const half = spec.loa * 0.5;
  const sparLo = srgb(0xa8834e);
  const sparHi = srgb(0xc0a072);
  const canvas = srgb(spec.canvas);
  const r0 = spec.beam * 0.055;

  for (let mi = 0; mi < spec.masts.length; mi++) {
    const m = spec.masts[mi];
    const heel = spec.rail * 0.7;
    const rake = spec.loa * 0.012;
    const capH = heel + (m.height - heel) * 0.56;
    const spar: Aux = [KIND_FIXED, NO_STRIPE, 0, ROUGH_SPAR];
    b.cyl(0, heel - 0.6, m.z, 0, capH, m.z + rake, r0, r0 * 0.72, 7, sparLo, spar);
    b.cyl(0, capH - 0.4, m.z + rake, 0, m.height, m.z + rake * 1.8, r0 * 0.6, r0 * 0.3, 6, sparHi, spar);

    if (m.squares > 0) {
      // Yards climb the mast; a course yard is about twice the beam, and each
      // one above it is shorter.
      const spans = [1.06, 0.92, 0.76, 0.58];
      // Spread the yards further up the mast when she carries fewer sails, so a
      // three-sail rig does not leave a third of the topmast a bare pole.
      const levels = m.squares >= 4 ? [0.26, 0.47, 0.66, 0.84] : [0.30, 0.56, 0.80, 0.9];
      const yardZ = m.z + rake * 0.7;
      for (let i = 0; i < Math.min(m.squares, 4); i++) {
        const yTop = heel + (m.height - heel) * levels[i];
        // The foot of a topsail is sheeted to the yard BELOW it, not left
        // hanging 2 m above it. The gap made the rig read as stacked cardboard.
        const yBot = i === 0 ? heel + 1.1 : heel + (m.height - heel) * levels[i - 1] - 0.15;
        const hs = spec.beam * spans[i];
        b.cyl(-hs, yTop, yardZ, hs, yTop, yardZ, r0 * 0.34, r0 * 0.34, 5, sparHi, [KIND_SQUARE, yardZ, 0, ROUGH_SPAR]);
        sailPanel(
          b,
          [-hs * 0.97, yTop - 0.15, yardZ],
          [hs * 0.97, yTop - 0.15, yardZ],
          [hs * 0.84, yBot, yardZ],
          [-hs * 0.84, yBot, yardZ],
          4,
          3,
          KIND_SQUARE,
          yardZ,
          canvas,
          // The course is the oldest and dirtiest cloth on her, and a touch of
          // tone between the tiers is another thing that stops them merging.
          0.9 + i * 0.035,
        );
      }
    }

    /*
     * Standing rigging: five shrouds a side, a pair of backstays and the stays
     * forward, all as ropes. Five thin ones read as a gang where three fat ones
     * read as nothing — a lower gang really is eight or ten shrouds with
     * ratlines across it, and what the eye gets at any distance is the total
     * ink of the whole gang, not any individual line.
     *
     * 5.6 cm is about right for a lower shroud (an eleven-inch rope is eleven
     * inches of CIRCUMFERENCE), and it is thinner than the cones this replaces.
     * The ink still goes UP, because there are four times as many lines and
     * none of them fall through a pixel any more.
     */
    const tarred = srgb(0x1d1a17);
    const capZ = m.z + rake;
    /*
     * Sized off her beam, because rope was sized off the ship: a first rate's
     * lower shrouds were fourteen to sixteen inch rope — that is CIRCUMFERENCE,
     * so 11-13 cm through — and a brig's were half that. A flat 5.6 cm for
     * everything measured 8 per cent LESS ink on the liner than the three fat
     * cones it replaced, which is the wrong direction: what the eye gets from a
     * gang at half a mile is the sum of the whole gang, and a real lower gang is
     * seven to ten shrouds a side, not three.
     */
    const shroudR = Math.max(0.022, spec.beam * 0.0040);
    const stayR = Math.max(0.026, spec.beam * 0.0042);
    const GANG = 7;
    for (const side of [1, -1]) {
      for (let k = 0; k < GANG; k++) {
        const f = k / (GANG - 1);
        const spread = spec.beam * (0.36 + f * 0.16);
        const along = m.z + spec.loa * (0.022 + f * 0.092);
        b.rope(
          side * spread, heel * 0.98, along,
          side * r0 * 0.8, capH - 0.5, capZ,
          shroudR, shroudR * 0.85, KIND_ROPE, ROUGH_RIG, tarred,
        );
      }
      // A backstay: masthead to the rail well abaft her, which is the line that
      // gives a rig its rake against the sky.
      b.rope(
        side * spec.beam * 0.40, heel * 0.95, Math.min(half - 0.5, m.z + spec.loa * 0.26),
        side * r0 * 0.45, heel + (m.height - heel) * 0.93, capZ,
        stayR, stayR, KIND_ROPE, ROUGH_RIG, tarred,
      );
    }
    // Forestay and topmast stay. They run forward to the next mast's heel, or
    // to the stemhead on the foremast, never through the mast ahead of her.
    const fwdLimit = mi > 0 ? spec.masts[mi - 1].z + spec.loa * 0.03 : -half - spec.bowsprit * 0.35;
    for (const [fromH, len, r] of [[0.56, 0.62, stayR], [0.92, 1.0, stayR * 0.85]] as const) {
      const top = heel + (m.height - heel) * fromH;
      const foot = Math.max(fwdLimit, m.z - (m.z - fwdLimit) * len);
      b.rope(0, top - 0.4, capZ, 0, heel * 0.9 + (foot < -half ? 1.2 : 0), foot, r, r, KIND_ROPE, ROUGH_RIG, tarred);
    }

    if (m.gaff) {
      const peak = heel + (m.height - heel) * (m.gaffPeak ?? 0.82);
      const boomLen = m.boom ?? spec.loa * 0.30;
      const boomEnd = m.z + boomLen;
      const boomY = heel + 0.9;
      const gaffZ = m.z + boomLen * 0.62;
      b.cyl(0, boomY, m.z + 0.3, 0, boomY - 0.2, boomEnd, r0 * 0.32, r0 * 0.24, 5, sparHi, [KIND_FORE_AFT, m.z, 0, ROUGH_SPAR]);
      b.cyl(0, peak - 1.2, m.z + 0.3, 0, peak, gaffZ, r0 * 0.28, r0 * 0.2, 5, sparHi, [KIND_FORE_AFT, m.z, 0, ROUGH_SPAR]);
      sailPanel(
        b,
        [0, boomY + 0.1, m.z + 0.4],
        [0, peak - 1.1, m.z + 0.4],
        [0, peak - 0.1, gaffZ],
        [0, boomY - 0.15, boomEnd],
        3,
        3,
        KIND_FORE_AFT,
        m.z,
        canvas,
      );
    }
  }

  if (spec.bowsprit > 0) {
    const tipZ = -half - spec.bowsprit;
    const tipY = spec.rail * 0.9 + spec.bowsprit * 0.16;
    b.cyl(0, spec.rail * 0.72, -half + 1.0, 0, tipY, tipZ, r0 * 0.62, r0 * 0.34, 6, sparLo, [KIND_FIXED, NO_STRIPE, 0, ROUGH_SPAR]);
    const fore = spec.masts[0];
    for (let j = 0; j < spec.jibs; j++) {
      const f = (j + 1) / (spec.jibs + 1);
      const headY = spec.rail * 0.7 + (fore.height - spec.rail * 0.7) * (0.52 + f * 0.3);
      const tackZ = -half - spec.bowsprit * (0.25 + f * 0.7);
      const tackY = spec.rail * 0.8 + (tipY - spec.rail * 0.9) * (0.25 + f * 0.7);
      sailPanel(
        b,
        [0, tackY, tackZ],
        [0, headY, fore.z - 0.4],
        [0, headY, fore.z - 0.4],
        [0, tackY + (headY - tackY) * 0.12, tackZ + spec.loa * 0.12],
        3,
        3,
        KIND_FORE_AFT,
        fore.z,
        srgb(spec.canvas),
      );
    }
  }
}

export function buildVessel(spec: VesselSpec): THREE.BufferGeometry {
  const b = new MeshBuilder();
  buildHull(b, spec);
  buildRig(b, spec);
  return b.finish(`world-vessel-${spec.key}`);
}

/**
 * The fleet. Three hulls is the right number: a working boat, a merchantman and
 * something that makes you glad you are not at war with anyone.
 */
export const VESSEL_SPECS: readonly VesselSpec[] = [
  {
    key: 'smack',
    label: 'fishing smack',
    loa: 14.5,
    beam: 4.6,
    draught: 2.0,
    rail: 1.55,
    bowsprit: 3.4,
    jibs: 1,
    hull: 0x24312e,
    stripes: [],
    stripeH: 0,
    ports: 0,
    boot: 0x4a3326,
    canvas: 0xa86a44,
    topSpeed: 3.3,
    stiffness: 0.85,
    masts: [
      { z: -2.6, height: 12.6, squares: 0, gaff: true, gaffPeak: 0.80, boom: 5.6 },
      { z: 3.4, height: 11.0, squares: 0, gaff: true, gaffPeak: 0.80, boom: 6.4 },
    ],
  },
  {
    key: 'brig',
    label: 'brig',
    loa: 28.0,
    beam: 7.8,
    draught: 3.4,
    rail: 2.2,
    bowsprit: 8.0,
    jibs: 2,
    hull: 0x181a1d,
    stripes: [0.44],
    // 0.54 m of paint on 1.6 m of freeboard. Wide for a brig, and deliberately:
    // a quarter-metre band was a pixel and a half at the range she is passed at.
    stripeH: 0.27,
    ports: 8,
    boot: 0x5d5238,
    canvas: 0xd6cdb8,
    topSpeed: 4.9,
    stiffness: 1.0,
    masts: [
      { z: -7.0, height: 30.0, squares: 3 },
      { z: 4.2, height: 32.0, squares: 3, gaff: true, gaffPeak: 0.36 },
    ],
  },
  {
    key: 'liner',
    label: 'ship of the line',
    loa: 56.0,
    beam: 15.2,
    draught: 6.6,
    rail: 5.0,
    bowsprit: 16.0,
    jibs: 3,
    hull: 0x14161a,
    stripes: [0.34, 0.66],
    stripeH: 0.42,
    ports: 13,
    boot: 0x6a6144,
    canvas: 0xd9d1bd,
    topSpeed: 5.6,
    stiffness: 1.75,
    masts: [
      { z: -15.0, height: 50.0, squares: 3 },
      { z: 0.5, height: 58.0, squares: 3 },
      { z: 15.0, height: 44.0, squares: 2, gaff: true, gaffPeak: 0.34 },
    ],
  },
];
