/**
 * The lines plan of the USS Constitution, as data.
 *
 * Everything the hull, rig and sail builders need is derived from the tables
 * here so the whole ship stays self-consistent. Distances are metres in ship
 * local space: +X starboard, +Y up, -Z forward (bow). y = 0 is the load
 * waterline.
 *
 * The hull is lofted the way a shipwright lofts one: a set of longitudinal
 * "level" curves (keel, copper line, wale, gunport sill/head, sheer) that each
 * sweep fore-and-aft, crossed by station sections whose 2D shape is built from
 * a control polygon (flat of floor -> rising floor -> turn of the bilge ->
 * maximum beam -> tumblehome). Grid rows follow the level curves, so plank
 * runs, the paint bands and the gunport rows automatically follow the hull's
 * curvature instead of being straight lines in UV space.
 */

import { catmullRom } from '../util/math';

export type Curve = readonly (readonly [number, number])[];

/** Catmull-Rom through a sorted (t, value) table, clamped outside the range. */
export function sampleCurve(pts: Curve, t: number): number {
  const n = pts.length;
  if (t <= pts[0][0]) return pts[0][1];
  if (t >= pts[n - 1][0]) return pts[n - 1][1];
  let i = 0;
  while (i < n - 2 && t > pts[i + 1][0]) i++;
  const u = (t - pts[i][0]) / (pts[i + 1][0] - pts[i][0]);
  return catmullRom(
    pts[Math.max(0, i - 1)][1],
    pts[i][1],
    pts[i + 1][1],
    pts[Math.min(n - 1, i + 2)][1],
    u,
  );
}

/* ------------------------------------------------------------------ *
 *  Principal dimensions
 * ------------------------------------------------------------------ */

/** Gun-deck length; the lofted hull spans exactly this in z. */
export const HULL_LENGTH = 53.3;
/** Forward end of the lofted hull (the stem rabbet). */
export const Z_STEM = -27.0;
/** After end of the lofted hull (where the counter meets the transom). */
export const Z_TRANSOM = Z_STEM + HULL_LENGTH;
export const HALF_BEAM_MAX = 6.65;
export const DRAUGHT = 6.4;
/** Transverse crown of the spar deck at the centreline. */
export const DECK_CAMBER = 0.3;
/** Thickness of the topside bulwark planking. */
export const BULWARK_THICK = 0.3;
/** Thickness of the hull at the gun deck — the depth of a gunport liner. */
export const HULL_THICK = 0.46;
/** How far the wales stand proud of the surrounding planking. */
export const WALE_PROUD = 0.135;

export function zAt(t: number): number {
  return Z_STEM + t * HULL_LENGTH;
}
export function tAtZ(z: number): number {
  return (z - Z_STEM) / HULL_LENGTH;
}

/* ------------------------------------------------------------------ *
 *  Longitudinal level curves — t = 0 at the stem, 1 at the transom
 * ------------------------------------------------------------------ */

/** Bottom of the section at the centreline: rocker, forefoot and stern tuck. */
const KEEL_Y: Curve = [
  [0.0, 2.55], [0.03, -0.9], [0.06, -3.4], [0.1, -5.15], [0.15, -6.05],
  [0.22, -6.34], [0.35, -6.4], [0.55, -6.4], [0.7, -6.33], [0.8, -6.15],
  [0.86, -5.6], [0.9, -4.55], [0.94, -2.75], [0.97, -0.6], [1.0, 1.55],
];

/** Top of Paul Revere's copper sheathing — the boot top. */
const COPPER_Y: Curve = [
  [0.0, 3.5], [0.06, 1.3], [0.15, 0.62], [0.3, 0.42], [0.5, 0.4],
  [0.7, 0.46], [0.85, 0.74], [0.94, 1.6], [1.0, 2.55],
];

const WALE_BOT_Y: Curve = [
  [0.0, 4.25], [0.06, 2.1], [0.15, 1.15], [0.3, 0.82], [0.5, 0.78],
  [0.7, 0.88], [0.85, 1.26], [0.94, 2.2], [1.0, 3.05],
];

const WALE_TOP_Y: Curve = [
  [0.0, 5.0], [0.06, 3.1], [0.15, 2.05], [0.3, 1.7], [0.5, 1.66],
  [0.7, 1.78], [0.85, 2.2], [0.94, 3.05], [1.0, 3.8],
];

/** Sills of the gun-deck ports. */
const PORT_SILL_Y: Curve = [
  [0.0, 5.95], [0.06, 4.3], [0.15, 3.2], [0.3, 2.72], [0.5, 2.62],
  [0.7, 2.72], [0.85, 3.1], [0.94, 3.85], [1.0, 4.5],
];

const PORT_HEAD_Y: Curve = [
  [0.0, 6.95], [0.06, 5.45], [0.15, 4.36], [0.3, 3.88], [0.5, 3.78],
  [0.7, 3.88], [0.85, 4.26], [0.94, 5.0], [1.0, 5.62],
];

/** Top of the bulwark rail — the sheer line. */
const SHEER_Y: Curve = [
  [0.0, 8.35], [0.06, 7.75], [0.15, 7.15], [0.3, 6.78], [0.45, 6.65],
  [0.6, 6.66], [0.75, 6.86], [0.88, 7.45], [0.95, 8.05], [1.0, 8.45],
];

/** Height of the bulwark above the spar deck at the ship's side. */
const BULWARK_H: Curve = [
  [0.0, 2.2], [0.1, 1.85], [0.25, 1.55], [0.45, 1.45], [0.7, 1.45],
  [0.88, 1.55], [1.0, 1.75],
];

/** Maximum half-breadth of the section, metres. */
const HALF_BEAM: Curve = [
  [0.0, 0.3], [0.03, 1.05], [0.07, 2.05], [0.12, 3.2], [0.18, 4.35],
  [0.25, 5.3], [0.32, 5.95], [0.4, 6.42], [0.47, 6.63], [0.54, 6.65],
  [0.61, 6.55], [0.68, 6.34], [0.75, 6.0], [0.82, 5.5], [0.88, 4.9],
  [0.94, 4.3], [1.0, 3.85],
];

/**
 * Fraction of the maximum half-breadth lost between the point of maximum beam
 * and the sheer. Positive is tumblehome (sides curve inboard going up) — the
 * signature of the Constitution's silhouette. Negative is flare: the bow above
 * the wale and the after quarters both flare outboard.
 */
const TUMBLE: Curve = [
  [0.0, -0.16], [0.06, -0.11], [0.14, -0.045], [0.24, 0.03], [0.34, 0.095],
  [0.45, 0.135], [0.58, 0.145], [0.7, 0.135], [0.8, 0.105], [0.88, 0.055],
  [0.95, -0.01], [1.0, -0.05],
];

/** 0 = deep V section, 1 = flat floor. */
const FLOOR: Curve = [
  [0.0, 0.02], [0.1, 0.06], [0.22, 0.24], [0.35, 0.52], [0.5, 0.66],
  [0.65, 0.6], [0.78, 0.42], [0.88, 0.22], [0.96, 0.08], [1.0, 0.05],
];

/** Tightness of the turn of the bilge, 0 = soft, 1 = hard corner. */
const BILGE: Curve = [
  [0.0, 0.1], [0.15, 0.25], [0.3, 0.55], [0.5, 0.72], [0.7, 0.66],
  [0.85, 0.45], [1.0, 0.3],
];

/** Half-thickness of the keel / deadwood / sternpost at the centreline. */
const KEEL_HALF: Curve = [
  [0.0, 0.3], [0.05, 0.32], [0.15, 0.34], [0.5, 0.36], [0.8, 0.36],
  [0.9, 0.42], [0.96, 0.6], [1.0, 0.9],
];

/** Bulwark port band for the spar-deck carronades, relative to the sheer. */
const SPAR_SILL_DROP = 1.15;
const SPAR_HEAD_DROP = 0.42;

export function keelY(t: number): number {
  return sampleCurve(KEEL_Y, t);
}
export function sheerY(t: number): number {
  return sampleCurve(SHEER_Y, t);
}
export function halfBeam(t: number): number {
  return sampleCurve(HALF_BEAM, t);
}
/** Spar deck height at the ship's side (before camber). */
export function deckSideY(t: number): number {
  return sampleCurve(SHEER_Y, t) - sampleCurve(BULWARK_H, t);
}
/** Spar deck height on the centreline, including the transverse crown. */
export function deckCentreY(t: number): number {
  return deckSideY(t) + DECK_CAMBER;
}
/** Gun deck height on the centreline. */
export function gunDeckY(t: number): number {
  return sampleCurve(PORT_SILL_Y, t) - 0.72 + DECK_CAMBER * 0.6;
}
export function waleTopY(t: number): number {
  return sampleCurve(WALE_TOP_Y, t);
}

/* ------------------------------------------------------------------ *
 *  Section shape
 * ------------------------------------------------------------------ */

/** Which painted surface a hull row belongs to — one mesh per bin. */
export const enum Bin {
  Copper = 0,
  Black = 1,
  Stripe = 2,
}

export interface HullRow {
  /** Absolute height at station t. */
  y(t: number): number;
  bin: Bin;
  /** How far this row stands proud of the fair surface (the wale belt). */
  proud: number;
}

/**
 * Row layout, keel to rail. Rows land exactly on the level curves so the
 * copper line, the raised wale belt and both gunport bands are edge-aligned,
 * which is what lets the paint bands and the port cut-outs be exact.
 */
function buildRows(): HullRow[] {
  const rows: HullRow[] = [];
  const between = (lo: Curve | ((t: number) => number), hi: Curve | ((t: number) => number), f: number) => {
    const lf = typeof lo === 'function' ? lo : (t: number) => sampleCurve(lo, t);
    const hf = typeof hi === 'function' ? hi : (t: number) => sampleCurve(hi, t);
    return (t: number) => {
      const a = lf(t);
      return a + (hf(t) - a) * f;
    };
  };
  const push = (y: (t: number) => number, bin: Bin, proud = 0) => rows.push({ y, bin, proud });

  const sparSill = (t: number) => sampleCurve(SHEER_Y, t) - SPAR_SILL_DROP;
  const sparHead = (t: number) => sampleCurve(SHEER_Y, t) - SPAR_HEAD_DROP;

  // Keel to the copper line: most of the rows, clustered around the bilge.
  for (const f of [0, 0.06, 0.14, 0.24, 0.35, 0.46, 0.56, 0.65, 0.72, 0.79, 0.86, 0.93, 1]) {
    push(between(KEEL_Y, COPPER_Y, f), Bin.Copper);
  }
  // Copper line to the bottom of the main wale.
  push(between(COPPER_Y, WALE_BOT_Y, 0.5), Bin.Black);
  push(between(COPPER_Y, WALE_BOT_Y, 1), Bin.Black);
  // The wale belt itself, chamfered at both edges.
  push(between(WALE_BOT_Y, WALE_TOP_Y, 0.28), Bin.Black, WALE_PROUD);
  push(between(WALE_BOT_Y, WALE_TOP_Y, 0.72), Bin.Black, WALE_PROUD);
  push(between(WALE_BOT_Y, WALE_TOP_Y, 1), Bin.Black);
  // Wale to the gun-deck port sills.
  push(between(WALE_TOP_Y, PORT_SILL_Y, 0.34), Bin.Black);
  push(between(WALE_TOP_Y, PORT_SILL_Y, 0.68), Bin.Black);
  push(between(WALE_TOP_Y, PORT_SILL_Y, 1), Bin.Black);
  // The white gunport stripe.
  push(between(PORT_SILL_Y, PORT_HEAD_Y, 0.34), Bin.Stripe);
  push(between(PORT_SILL_Y, PORT_HEAD_Y, 0.67), Bin.Stripe);
  push(between(PORT_SILL_Y, PORT_HEAD_Y, 1), Bin.Stripe);
  // Topsides up to the spar-deck carronade ports.
  push(between(PORT_HEAD_Y, sparSill, 0.36), Bin.Black);
  push(between(PORT_HEAD_Y, sparSill, 0.72), Bin.Black);
  push(between(PORT_HEAD_Y, sparSill, 1), Bin.Black);
  push(between(sparSill, sparHead, 0.5), Bin.Black);
  push(sparHead, Bin.Black);
  // Sheer rail, with a narrow moulding just under the cap.
  push(between(sparHead, SHEER_Y, 0.55), Bin.Black, WALE_PROUD * 0.45);
  push((t) => sampleCurve(SHEER_Y, t), Bin.Black);
  return rows;
}

export const HULL_ROWS: HullRow[] = buildRows();

/** Named row indices. The port bands are exact grid blocks. */
export const ROW_COPPER_TOP = 12;
export const ROW_PORT_SILL = 20;
export const ROW_PORT_HEAD = 23;
export const ROW_SPAR_SILL = 26;
export const ROW_SPAR_HEAD = 28;
export const ROW_SHEER = HULL_ROWS.length - 1;

/**
 * A station section, tabulated so half-breadth can be looked up by height.
 * The control polygon is the shipwright's: flat of floor, rising floor, turn
 * of the bilge, maximum beam, then tumblehome (or flare) to the rail.
 */
export class Station {
  readonly t: number;
  readonly z: number;
  readonly keel: number;
  readonly sheer: number;
  readonly beam: number;
  private ys: Float32Array;
  private ws: Float32Array;

  constructor(t: number, samples = 88) {
    this.t = t;
    this.z = zAt(t);
    this.keel = keelY(t);
    this.sheer = sheerY(t);
    this.beam = halfBeam(t);

    const b = this.beam;
    const tumble = sampleCurve(TUMBLE, t);
    const floor = sampleCurve(FLOOR, t);
    const bilge = sampleCurve(BILGE, t);
    const kh = Math.min(sampleCurve(KEEL_HALF, t), b * 0.9);
    // Maximum beam sits a little above the wale, below the gunport sills.
    const maxY =
      sampleCurve(WALE_TOP_Y, t) + (sampleCurve(PORT_SILL_Y, t) - sampleCurve(WALE_TOP_Y, t)) * 0.4;
    const d = Math.max(0.2, maxY - this.keel);
    const up = Math.max(0.05, this.sheer - maxY);

    const cp: [number, number][] = [
      [kh, this.keel],
      [b * (0.05 + 0.14 * floor) + kh * 0.4, this.keel + 0.06 * d],
      [b * (0.16 + 0.3 * floor), this.keel + 0.24 * d],
      [b * (0.46 + 0.28 * floor), this.keel + 0.46 * d],
      [b * (0.72 + 0.18 * bilge), this.keel + 0.64 * d],
      [b * (0.93 + 0.055 * bilge), this.keel + 0.82 * d],
      [b, maxY],
      [b * (1 - tumble * 0.34), maxY + 0.4 * up],
      [b * (1 - tumble * 0.8), maxY + 0.78 * up],
      [b * (1 - tumble), this.sheer],
    ];

    this.ys = new Float32Array(samples);
    this.ws = new Float32Array(samples);
    const segs = cp.length - 1;
    for (let i = 0; i < samples; i++) {
      const s = (i / (samples - 1)) * segs;
      const k = Math.min(segs - 1, Math.floor(s));
      const u = s - k;
      const g = (j: number, c: 0 | 1) => cp[Math.max(0, Math.min(cp.length - 1, j))][c];
      this.ws[i] = catmullRom(g(k - 1, 0), g(k, 0), g(k + 1, 0), g(k + 2, 0), u);
      this.ys[i] = catmullRom(g(k - 1, 1), g(k, 1), g(k + 1, 1), g(k + 2, 1), u);
    }
    // Enforce monotone height so the lookup below is well defined.
    for (let i = 1; i < samples; i++) {
      if (this.ys[i] <= this.ys[i - 1]) this.ys[i] = this.ys[i - 1] + 1e-4;
      this.ws[i] = Math.max(this.ws[i], 0.02);
    }
  }

  /** Half-breadth at height y, clamped to the section's range. */
  widthAt(y: number): number {
    const ys = this.ys;
    const n = ys.length;
    if (y <= ys[0]) return this.ws[0];
    if (y >= ys[n - 1]) return this.ws[n - 1];
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (ys[mid] > y) hi = mid;
      else lo = mid;
    }
    const f = (y - ys[lo]) / (ys[hi] - ys[lo]);
    return this.ws[lo] + (this.ws[hi] - this.ws[lo]) * f;
  }

  /** d(halfBreadth)/dy, used for the outward surface normal. */
  slopeAt(y: number): number {
    const h = 0.12;
    return (this.widthAt(y + h) - this.widthAt(y - h)) / (2 * h);
  }
}

/* ------------------------------------------------------------------ *
 *  Gun ports
 * ------------------------------------------------------------------ */

export interface PortSpec {
  z: number;
  halfWidth: number;
  /** True for the gun-deck battery, false for the spar-deck carronade ports. */
  gunDeck: boolean;
  open: boolean;
}

/** 15 gun-deck ports and 11 spar-deck ports per side — the historical battery. */
export function buildPorts(rng: () => number): PortSpec[] {
  const out: PortSpec[] = [];
  for (let i = 0; i < 15; i++) {
    out.push({ z: -19.4 + i * 2.72, halfWidth: 0.46, gunDeck: true, open: rng() < 0.62 });
  }
  for (let i = 0; i < 11; i++) {
    out.push({ z: -16.4 + i * 3.1, halfWidth: 0.4, gunDeck: false, open: rng() < 0.75 });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 *  Rig
 * ------------------------------------------------------------------ */

export interface MastSpec {
  name: 'fore' | 'main' | 'mizzen';
  z: number;
  /** Rake aft, radians. */
  rake: number;
  /** Deck level where the mast passes through. */
  deckY: number;
  lowerTop: number;
  topmastFoot: number;
  topmastTop: number;
  tgFoot: number;
  tgTop: number;
  truck: number;
  lowerRadius: number;
  topRadius: number;
  tgRadius: number;
  /** Half-width and fore-aft depth of the fighting top. */
  topHalfWidth: number;
  topDepth: number;
  /** Number of lower / topmast / topgallant shrouds per side. */
  shrouds: [number, number, number];
}

/** Mainmast truck 67 m above the waterline; fore 60 m, mizzen 52 m. */
export const MASTS: readonly MastSpec[] = [
  {
    name: 'fore', z: -16.6, rake: 0.018, deckY: deckSideY(tAtZ(-16.6)) + DECK_CAMBER * 0.7,
    lowerTop: 23.7, topmastFoot: 20.9, topmastTop: 41.4, tgFoot: 38.6, tgTop: 54.6, truck: 60.0,
    lowerRadius: 0.5, topRadius: 0.3, tgRadius: 0.175,
    topHalfWidth: 2.55, topDepth: 3.1, shrouds: [8, 5, 3],
  },
  {
    name: 'main', z: 0.6, rake: 0.033, deckY: deckSideY(tAtZ(0.6)) + DECK_CAMBER * 0.7,
    lowerTop: 26.5, topmastFoot: 23.5, topmastTop: 46.2, tgFoot: 43.2, tgTop: 61.0, truck: 67.0,
    lowerRadius: 0.54, topRadius: 0.325, tgRadius: 0.19,
    topHalfWidth: 2.85, topDepth: 3.45, shrouds: [9, 5, 3],
  },
  {
    name: 'mizzen', z: 15.6, rake: 0.056, deckY: deckSideY(tAtZ(15.6)) + DECK_CAMBER * 0.7,
    lowerTop: 20.6, topmastFoot: 18.1, topmastTop: 35.9, tgFoot: 33.3, tgTop: 47.4, truck: 52.0,
    lowerRadius: 0.43, topRadius: 0.26, tgRadius: 0.15,
    topHalfWidth: 2.1, topDepth: 2.6, shrouds: [6, 4, 2],
  },
];

/** Bowsprit steeve, and where the head spars end up. */
export const BOWSPRIT = {
  /** Inboard heel, on the centreline just forward of the foremast. */
  heel: { y: 5.1, z: -21.6 },
  steeve: 0.335,
  length: 15.4,
  radius0: 0.56,
  radius1: 0.33,
  /** Jibboom runs on beyond the bowsprit cap. */
  jibboom: 12.6,
  jibboomRadius: 0.2,
  flying: 8.4,
  flyingRadius: 0.12,
  /** Dolphin striker, hanging under the bowsprit cap. */
  strikerLen: 2.5,
};

/** Where each yard crosses its mast and how long it is (half-length, m). */
export interface YardSpec {
  id: string;
  mast: number;
  tier: number;
  y: number;
  half: number;
  radius: number;
  /** Part slot used by the vertex shader to brace it. */
  part: number;
  /** Height of the sail hung from this yard. */
  sailDrop: number;
}

export const YARDS: readonly YardSpec[] = [
  { id: 'fore-course', mast: 0, tier: 0, y: 17.8, half: 13.1, radius: 0.34, part: 1, sailDrop: 11.4 },
  { id: 'fore-topsail', mast: 0, tier: 1, y: 30.4, half: 9.3, radius: 0.25, part: 2, sailDrop: 11.6 },
  { id: 'fore-topgallant', mast: 0, tier: 2, y: 41.6, half: 6.5, radius: 0.17, part: 3, sailDrop: 8.3 },
  { id: 'fore-royal', mast: 0, tier: 3, y: 49.4, half: 4.7, radius: 0.12, part: 4, sailDrop: 6.1 },
  { id: 'main-course', mast: 1, tier: 0, y: 20.2, half: 14.6, radius: 0.37, part: 5, sailDrop: 12.6 },
  { id: 'main-topsail', mast: 1, tier: 1, y: 34.1, half: 10.4, radius: 0.27, part: 6, sailDrop: 12.7 },
  { id: 'main-topgallant', mast: 1, tier: 2, y: 46.4, half: 7.3, radius: 0.185, part: 7, sailDrop: 9.1 },
  { id: 'main-royal', mast: 1, tier: 3, y: 55.0, half: 5.2, radius: 0.13, part: 8, sailDrop: 6.7 },
  { id: 'mizzen-crossjack', mast: 2, tier: 0, y: 15.4, half: 8.9, radius: 0.26, part: 9, sailDrop: 0 },
  { id: 'mizzen-topsail', mast: 2, tier: 1, y: 26.3, half: 7.1, radius: 0.21, part: 10, sailDrop: 9.6 },
  { id: 'mizzen-topgallant', mast: 2, tier: 2, y: 35.9, half: 5.0, radius: 0.145, part: 11, sailDrop: 7.2 },
  { id: 'mizzen-royal', mast: 2, tier: 3, y: 42.6, half: 3.6, radius: 0.1, part: 12, sailDrop: 5.0 },
  { id: 'spritsail', mast: 3, tier: 0, y: 0, half: 7.0, radius: 0.2, part: 13, sailDrop: 0 },
];

/** Animated transform slots consumed by the `shipPart` vertex snippet. */
export const PART = {
  STATIC: 0,
  /** 1..13 are the yards, in YARDS order. */
  BOOM: 14,
  GAFF: 15,
  RUDDER: 16,
  WHEEL: 17,
  TILLER: 18,
  CAPSTAN: 19,
} as const;
export const PART_COUNT = 22;

/** Spanker boom and gaff, on the mizzen. */
export const SPANKER = {
  boomY: 8.9,
  boomLen: 20.5,
  boomRadius: 0.29,
  gaffY: 16.4,
  gaffLen: 13.4,
  gaffRise: 0.42,
  gaffRadius: 0.19,
};
