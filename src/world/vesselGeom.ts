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
  stripes: readonly number[];
  boot: number;
  canvas: number;
  /** Best speed through the water, m/s. */
  topSpeed: number;
  /** Multiplier on how far she heels for a given wind. */
  stiffness: number;
}

const ROUGH_PAINT = 0.42;
const ROUGH_CANVAS = 0.86;
const ROUGH_DECK = 0.74;
const ROUGH_SPAR = 0.58;

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

/** Section outline, starboard side: [halfBeamScale, yKind, yFrac]. */
const SECTION: readonly (readonly [number, number, number])[] = [
  [1.00, 1, 1.00], // rail cap
  [0.98, 1, 0.72], // deck level, inboard face of the bulwark
  [1.00, 1, 0.30], // wale
  [0.99, 1, 0.00], // waterline
  [0.90, 0, 0.32],
  [0.62, 0, 0.70],
  [0.20, 0, 0.94],
  [0.00, 0, 1.00], // keel
];

function hullColour(spec: VesselSpec, yFrac: number, above: boolean): RGB {
  const hull = srgb(spec.hull);
  if (!above) return mixRGB(srgb(spec.boot), hull, 0.25);
  for (const s of spec.stripes) {
    if (Math.abs(yFrac - s) < 0.085) return srgb(0xd8b166);
  }
  if (yFrac > 0.9) return mixRGB(hull, srgb(0x000000), 0.35);
  return hull;
}

function buildHull(b: MeshBuilder, spec: VesselSpec): void {
  const half = spec.loa * 0.5;
  const railIdx: number[][] = [];
  const deckIdx: number[][] = [];
  const rings: number[][] = [];
  const aux: Aux = [0, 0, 0, ROUGH_PAINT];

  for (const [t, hbf, keelf, railf] of STATIONS) {
    const z = -half + t * spec.loa;
    const hb = Math.max(0.02, (spec.beam * 0.5) * hbf);
    const keelY = -spec.draught * keelf;
    const railY = spec.rail * railf;
    const ring: number[] = [];
    const starboard: number[] = [];
    const port: number[] = [];
    for (const [hs, kindAbove, yf] of SECTION) {
      const above = kindAbove === 1;
      const y = above ? railY * yf : keelY * yf;
      const col = hullColour(spec, yf, above);
      starboard.push(b.vert(hb * hs, y, z, col, aux));
      if (hs > 1e-4) port.push(b.vert(-hb * hs, y, z, col, aux));
    }
    for (let i = 0; i < starboard.length; i++) ring.push(starboard[i]);
    for (let i = port.length - 1; i >= 0; i--) ring.push(port[i]);
    rings.push(ring);
    railIdx.push([starboard[0], port[0]]);
    deckIdx.push([starboard[1], port[1], hb * 0.98, railY * 0.72, z]);
  }
  b.tube(rings, false);

  // Deck. Without it the hull is an open trough and you see straight through
  // the bow, which is the single most common way a low-detail ship reads as
  // unfinished.
  const deckCol = srgb(0x9c7c50);
  const deckAux: Aux = [0, 0, 0, ROUGH_DECK];
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
      // Cloth is never a flat sheet even at the head; a touch of tone variation
      // across the panel keeps a big sail from reading as cardboard.
      const shade = 1 - 0.10 * Math.cos(Math.PI * v) * Math.cos(Math.PI * u);
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

  for (const m of spec.masts) {
    const heel = spec.rail * 0.7;
    const rake = spec.loa * 0.012;
    const capH = heel + (m.height - heel) * 0.56;
    const spar: Aux = [0, 0, 0, ROUGH_SPAR];
    b.cyl(0, heel - 0.6, m.z, 0, capH, m.z + rake, r0, r0 * 0.72, 7, sparLo, spar);
    b.cyl(0, capH - 0.4, m.z + rake, 0, m.height, m.z + rake * 1.8, r0 * 0.6, r0 * 0.3, 6, sparHi, spar);

    if (m.squares > 0) {
      // Yards climb the mast; a course yard is about twice the beam, and each
      // one above it is shorter.
      const spans = [1.06, 0.9, 0.72, 0.56];
      const levels = [0.30, 0.53, 0.72, 0.86];
      const yardZ = m.z + rake * 0.7;
      for (let i = 0; i < Math.min(m.squares, 4); i++) {
        const yTop = heel + (m.height - heel) * levels[i];
        const yBot = i === 0 ? heel + 1.2 : heel + (m.height - heel) * levels[i - 1] + 0.5;
        const hs = spec.beam * spans[i];
        b.cyl(-hs, yTop, yardZ, hs, yTop, yardZ, r0 * 0.34, r0 * 0.34, 5, sparHi, [1, yardZ, 0, ROUGH_SPAR]);
        sailPanel(
          b,
          [-hs * 0.97, yTop - 0.15, yardZ],
          [hs * 0.97, yTop - 0.15, yardZ],
          [hs * 0.84, yBot, yardZ],
          [-hs * 0.84, yBot, yardZ],
          4,
          3,
          1,
          yardZ,
          canvas,
        );
      }
    }

    if (m.gaff) {
      const peak = heel + (m.height - heel) * (m.gaffPeak ?? 0.82);
      const boomEnd = m.z + spec.loa * 0.30;
      const boomY = heel + 0.9;
      const gaffZ = m.z + spec.loa * 0.20;
      b.cyl(0, boomY, m.z + 0.3, 0, boomY - 0.2, boomEnd, r0 * 0.32, r0 * 0.24, 5, sparHi, [2, m.z, 0, ROUGH_SPAR]);
      b.cyl(0, peak - 1.2, m.z + 0.3, 0, peak, gaffZ, r0 * 0.28, r0 * 0.2, 5, sparHi, [2, m.z, 0, ROUGH_SPAR]);
      sailPanel(
        b,
        [0, boomY + 0.1, m.z + 0.4],
        [0, peak - 1.1, m.z + 0.4],
        [0, peak - 0.1, gaffZ],
        [0, boomY - 0.15, boomEnd],
        3,
        3,
        2,
        m.z,
        canvas,
      );
    }
  }

  if (spec.bowsprit > 0) {
    const tipZ = -half - spec.bowsprit;
    const tipY = spec.rail * 0.9 + spec.bowsprit * 0.16;
    b.cyl(0, spec.rail * 0.72, -half + 1.0, 0, tipY, tipZ, r0 * 0.62, r0 * 0.34, 6, sparLo, [0, 0, 0, ROUGH_SPAR]);
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
        2,
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
    boot: 0x4a3326,
    canvas: 0xa86a44,
    topSpeed: 3.3,
    stiffness: 1.25,
    masts: [
      { z: -2.4, height: 15.5, squares: 0, gaff: true, gaffPeak: 0.86 },
      { z: 3.6, height: 13.0, squares: 0, gaff: true, gaffPeak: 0.86 },
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
    boot: 0x6a6144,
    canvas: 0xd9d1bd,
    topSpeed: 5.6,
    stiffness: 0.72,
    masts: [
      { z: -15.0, height: 50.0, squares: 3 },
      { z: 0.5, height: 58.0, squares: 3 },
      { z: 15.0, height: 44.0, squares: 2, gaff: true, gaffPeak: 0.34 },
    ],
  },
];
