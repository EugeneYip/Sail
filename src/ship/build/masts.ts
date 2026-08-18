/**
 * Masts, tops, yards and the head spars.
 *
 * Each mast is three overlapping sections (lower, top, topgallant) with a
 * doubling at each join: the upper section steps forward of the lower one and
 * passes through the forward hole of the cap, which is why the effective rake
 * decreases with height. The fighting tops are real framed platforms —
 * trestletrees, crosstrees, a planked floor and a lubber's hole — not discs.
 *
 * The `RigFrame` returned here is the single source of truth for where every
 * rope and sail attaches, so the rigging and the sail plan can never drift out
 * of register with the spars.
 */

import * as THREE from 'three';
import { MeshBuilder } from './Builder';
import type { Bins } from './hull';
import {
  BOWSPRIT, MASTS, PART, SPANKER, YARDS, deckSideY, tAtZ, type MastSpec, type YardSpec,
} from '../dims';

export interface MastFrame {
  spec: MastSpec;
  /** Axis point of the lower mast at height y. */
  lower(y: number, out?: THREE.Vector3): THREE.Vector3;
  /** Axis point of the topmast at height y. */
  top(y: number, out?: THREE.Vector3): THREE.Vector3;
  /** Axis point of the topgallant mast at height y. */
  tg(y: number, out?: THREE.Vector3): THREE.Vector3;
  /** Axis point of whichever section carries height y. */
  at(y: number, out?: THREE.Vector3): THREE.Vector3;
  /** Height of the fighting top's floor. */
  platformY: number;
  /** Height of the crosstrees at the topmast head. */
  crossY: number;
  halfWidth: number;
  depth: number;
}

export interface YardFrame {
  spec: YardSpec;
  centre: THREE.Vector3;
  /** Arm tips in the un-braced (square) position. */
  stbd: THREE.Vector3;
  port: THREE.Vector3;
  /** Rotation pivot for the brace: the mast axis at the yard's height. */
  pivot: THREE.Vector3;
}

export interface RigFrame {
  masts: MastFrame[];
  yards: YardFrame[];
  bowsprit: {
    heel: THREE.Vector3;
    cap: THREE.Vector3;
    jibboomEnd: THREE.Vector3;
    flyingEnd: THREE.Vector3;
    strikerTip: THREE.Vector3;
    dir: THREE.Vector3;
  };
  spanker: {
    boomPivot: THREE.Vector3;
    boomEnd: THREE.Vector3;
    gaffPivot: THREE.Vector3;
    gaffEnd: THREE.Vector3;
  };
}

/** How far forward of the lower mast the upper sections are stepped. */
const DOUBLING_FWD = 0.58;
const TG_FWD = 0.4;

export function buildMasts(bins: Bins, quality: number): RigFrame {
  const masts: MastFrame[] = [];

  for (const spec of MASTS) {
    const tanR = Math.tan(spec.rake);
    const mk = (dz: number) => (y: number, out = new THREE.Vector3()) =>
      out.set(0, y, spec.z + y * tanR + dz);
    const lower = mk(0);
    const top = mk(-DOUBLING_FWD);
    const tg = mk(-DOUBLING_FWD - TG_FWD);
    const platformY = spec.lowerTop - 2.15;
    const crossY = spec.topmastTop - 1.5;
    const f: MastFrame = {
      spec,
      lower,
      top,
      tg,
      at: (y, out = new THREE.Vector3()) =>
        y < spec.topmastFoot + 1.4 ? lower(y, out) : y < spec.tgFoot + 1.2 ? top(y, out) : tg(y, out),
      platformY,
      crossY,
      halfWidth: spec.topHalfWidth,
      depth: spec.topDepth,
    };
    masts.push(f);
    buildMast(bins, f, quality);
  }

  const yards: YardFrame[] = [];
  for (const spec of YARDS) {
    if (spec.mast === 3) continue;
    const m = masts[spec.mast];
    const pivot = m.at(spec.y);
    // The yard hangs a little forward of its mast so it can brace round.
    const clear = spec.tier === 0 ? 0.75 : 0.5;
    const centre = pivot.clone();
    centre.z -= clear;
    const stbd = centre.clone();
    stbd.x += spec.half;
    const port = centre.clone();
    port.x -= spec.half;
    const yf: YardFrame = { spec, centre, stbd, port, pivot };
    yards.push(yf);
    buildYard(bins, yf, quality);
  }

  const bowsprit = buildBowsprit(bins, yards, quality);
  const spanker = buildSpanker(bins, masts[2]);

  buildMastCoats(bins, masts);

  return { masts, yards, bowsprit, spanker };
}

/* ------------------------------------------------------------------ *
 *  One mast
 * ------------------------------------------------------------------ */

function buildMast(bins: Bins, f: MastFrame, quality: number): void {
  const s = f.spec;
  const oak = bins.oak;
  const ir = bins.iron;
  const radial = quality >= 2 ? 12 : 8;

  // Lower mast: square below the deck in reality, but the wedges hide that.
  oak.setColorHexLinear(0xffffff, 0.72);
  sparSection(oak, f.lower, s.deckY - 1.6, s.lowerTop, s.lowerRadius * 1.06, s.topRadius * 1.15, radial);
  // Topmast and topgallant, overlapping their lower sections at the doubling.
  oak.setColorHexLinear(0xffffff, 0.78);
  sparSection(oak, f.top, s.topmastFoot, s.topmastTop, s.topRadius * 1.05, s.tgRadius * 1.25, radial);
  oak.setColorHexLinear(0xffffff, 0.84);
  sparSection(oak, f.tg, s.tgFoot, s.tgTop, s.tgRadius * 1.05, s.tgRadius * 0.62, Math.max(6, radial - 4));
  // Pole to the truck.
  sparSection(oak, f.tg, s.tgTop - 0.2, s.truck, s.tgRadius * 0.6, s.tgRadius * 0.34, 6);

  // Truck: the little disc at the very top with sheave holes for the flag halyard.
  const tp = f.tg(s.truck);
  oak.setColorHexLinear(0xffffff, 0.9);
  oak.pushTransform(new THREE.Matrix4().makeTranslation(tp.x, tp.y, tp.z));
  oak.revolve([[0, 0], [0.2, 0.02], [0.22, 0.1], [0.16, 0.16], [0, 0.18]], 10, 3);
  oak.popTransform();

  // Iron hoops down the lower mast and the topmast.
  ir.setColorHexLinear(0xffffff, 0.85);
  const hoop = (fn: (y: number, o?: THREE.Vector3) => THREE.Vector3, y0: number, y1: number, r: number, n: number) => {
    for (let i = 0; i < n; i++) {
      const y = y0 + ((i + 0.5) / n) * (y1 - y0);
      const p = fn(y);
      const rr = r * (1 - 0.32 * ((y - y0) / (y1 - y0)));
      ir.pushTransform(new THREE.Matrix4().makeTranslation(p.x, p.y, p.z));
      ir.revolve([[rr * 1.09, -0.075], [rr * 1.12, 0], [rr * 1.09, 0.075]], 10, 3);
      ir.popTransform();
    }
  };
  hoop(f.lower, s.deckY, s.lowerTop - 0.5, s.lowerRadius * 1.06, 9);
  hoop(f.top, s.topmastFoot + 1, s.topmastTop - 0.5, s.topRadius * 1.05, 6);

  buildTop(bins, f, quality);
  buildCrosstrees(bins, f);
}

function sparSection(
  b: MeshBuilder,
  axis: (y: number, out?: THREE.Vector3) => THREE.Vector3,
  y0: number, y1: number, r0: number, r1: number, radial: number,
): void {
  const n = 5;
  const path: THREE.Vector3[] = [];
  const radii: number[] = [];
  for (let i = 0; i < n; i++) {
    const s = i / (n - 1);
    path.push(axis(y0 + (y1 - y0) * s));
    radii.push(r0 + (r1 - r0) * s);
  }
  b.tube(path, radii, radial, true, 0.32);
}

/**
 * A fighting top: trestletrees fore-and-aft, crosstrees athwartships, a planked
 * floor with a lubber's hole abaft the mast, and a rim round the after edge.
 */
function buildTop(bins: Bins, f: MastFrame, quality: number): void {
  const s = f.spec;
  const oak = bins.oak;
  const y = f.platformY;
  const c = f.lower(y);
  const hw = f.halfWidth;
  const d = f.depth;
  const zFwd = c.z - d * 0.42;
  const zAft = c.z + d * 0.58;

  // Outline: rectangular aft, rounded forward.
  const hwAt = (v: number) => {
    // v: 0 forward, 1 aft.
    const k = Math.min(1, v / 0.34);
    return hw * (0.34 + 0.66 * Math.sqrt(Math.max(0, k)));
  };

  const NU = quality >= 2 ? 13 : 9;
  const NV = quality >= 2 ? 11 : 7;
  const holeZ0 = 0.5;
  const holeZ1 = 0.78;
  const holeX = 0.42;

  oak.setColorHexLinear(0xffffff, 0.86);
  for (const yOff of [0, -0.1] as const) {
    oak.grid(
      NU, NV,
      (i, j, out) => {
        const v = j / (NV - 1);
        const fx = (i / (NU - 1)) * 2 - 1;
        out.set(fx * hwAt(v), y + yOff, zFwd + v * (zAft - zFwd));
      },
      (i, j) => {
        const v = j / (NV - 1);
        const fx = (i / (NU - 1)) * 2 - 1;
        return [(zFwd + v * (zAft - zFwd)) / 3.2, (fx * hwAt(v)) / 1.12];
      },
      {
        // cross(d/di, d/dj) on this grid points down, so the walked-on floor
        // is the flipped one and the ceiling underneath is not.
        flip: yOff >= 0,
        skip: (i, j) => {
          const v = (j + 0.5) / (NV - 1);
          const fx = ((i + 0.5) / (NU - 1)) * 2 - 1;
          const insideHole = v > holeZ0 && v < holeZ1 && Math.abs(fx) < holeX;
          const insideMast = v > 0.18 && v < 0.5 && Math.abs(fx) < 0.3;
          return insideHole || insideMast;
        },
      },
    );
  }

  // Trestletrees and crosstrees under the floor.
  oak.setColorHexLinear(0xffffff, 0.7);
  for (const side of [1, -1] as const) {
    oak.box(side * (s.lowerRadius + 0.24), y - 0.24, (zFwd + zAft) * 0.5, 0.13, 0.15, d * 0.56);
  }
  for (let i = 0; i < 4; i++) {
    const v = 0.12 + (i / 3) * 0.82;
    const z = zFwd + v * (zAft - zFwd);
    oak.box(0, y - 0.16, z, hwAt(v) * 0.98, 0.1, 0.1);
  }

  // Rim: a low rail round the after two thirds.
  oak.setColorHexLinear(0xffffff, 0.9);
  const rimN = quality >= 2 ? 16 : 10;
  for (let i = 0; i <= rimN; i++) {
    const fr = i / rimN;
    // Walk the outline: up the starboard side, across the stern, back down.
    let x: number;
    let z: number;
    if (fr < 0.42) {
      const v = 0.2 + (fr / 0.42) * 0.8;
      x = hwAt(v);
      z = zFwd + v * (zAft - zFwd);
    } else if (fr < 0.58) {
      x = hw * (1 - ((fr - 0.42) / 0.16) * 2);
      z = zAft;
    } else {
      const v = 1 - ((fr - 0.58) / 0.42) * 0.8;
      x = -hwAt(v);
      z = zFwd + v * (zAft - zFwd);
    }
    oak.box(x, y + 0.28, z, 0.07, 0.28, 0.07);
  }

  // The cap at the lower masthead: two holes, lower mast aft, topmast forward.
  const capY = s.lowerTop - 0.28;
  const capC = f.lower(capY);
  const capT = f.top(capY);
  bins.black.setColorHexLinear(0xffffff, 0.9);
  bins.black.box((capC.x + capT.x) * 0.5, capY, (capC.z + capT.z) * 0.5,
    s.topRadius * 2.2, 0.19, Math.abs(capC.z - capT.z) * 0.5 + s.topRadius * 1.6);
}

function buildCrosstrees(bins: Bins, f: MastFrame): void {
  const s = f.spec;
  const oak = bins.oak;
  const y = f.crossY;
  const c = f.top(y);
  oak.setColorHexLinear(0xffffff, 0.8);
  for (const side of [1, -1] as const) {
    oak.box(side * (s.topRadius + 0.16), y, c.z, 0.09, 0.1, s.topDepth * 0.3);
  }
  for (const dz of [-0.4, 0.4]) {
    oak.box(0, y + 0.08, c.z + dz, s.topHalfWidth * 0.52, 0.07, 0.08);
  }
  // Topmast cap.
  const capY = s.topmastTop - 0.2;
  const a = f.top(capY);
  const b = f.tg(capY);
  bins.black.setColorHexLinear(0xffffff, 0.9);
  bins.black.box((a.x + b.x) * 0.5, capY, (a.z + b.z) * 0.5,
    s.tgRadius * 2.3, 0.13, Math.abs(a.z - b.z) * 0.5 + s.tgRadius * 1.7);
}

/* ------------------------------------------------------------------ *
 *  Yards
 * ------------------------------------------------------------------ */

function buildYard(bins: Bins, yf: YardFrame, quality: number): void {
  const oak = bins.oak;
  const ir = bins.iron;
  const s = yf.spec;
  const prevPart = oak.partIndex;

  oak.partIndex = s.part;
  ir.partIndex = s.part;
  oak.setColorHexLinear(0xffffff, 0.8);
  oak.spar(yf.port, yf.stbd, s.radius, s.radius, quality >= 2 ? 10 : 7, true);

  // Jackstay: the iron rod along the top of the yard that the sail is bent to.
  ir.setColorHexLinear(0xffffff, 0.8);
  const n = quality >= 2 ? 9 : 5;
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    const x = yf.port.x + (yf.stbd.x - yf.port.x) * t;
    ir.box(x, yf.centre.y + s.radius + 0.07, yf.centre.z - s.radius * 0.35, 0.03, 0.07, 0.03);
  }
  ir.box(yf.centre.x, yf.centre.y + s.radius + 0.12, yf.centre.z - s.radius * 0.35,
    s.half * 0.94, 0.022, 0.022);

  // Slings and the iron truss that holds the yard to the mast.
  ir.setColorHexLinear(0xffffff, 0.9);
  ir.box(yf.centre.x, yf.centre.y, (yf.centre.z + yf.pivot.z) * 0.5, s.radius * 1.5, 0.09,
    Math.abs(yf.pivot.z - yf.centre.z) * 0.5);

  // Cleats at the arms to stop the sheets slipping off.
  for (const tip of [yf.port, yf.stbd]) {
    const dir = Math.sign(tip.x);
    oak.setColorHexLinear(0xffffff, 0.75);
    oak.box(tip.x - dir * 0.5, yf.centre.y, yf.centre.z, 0.07, s.radius * 0.85, s.radius * 0.85);
  }

  oak.partIndex = prevPart;
  ir.partIndex = prevPart;
}

/* ------------------------------------------------------------------ *
 *  Head spars
 * ------------------------------------------------------------------ */

function buildBowsprit(bins: Bins, yards: YardFrame[], quality: number): RigFrame['bowsprit'] {
  const oak = bins.oak;
  const B = BOWSPRIT;
  const dir = new THREE.Vector3(0, Math.sin(B.steeve), -Math.cos(B.steeve));
  const heel = new THREE.Vector3(0, B.heel.y, B.heel.z);
  const cap = heel.clone().addScaledVector(dir, B.length);

  oak.setColorHexLinear(0xffffff, 0.72);
  oak.spar(heel, cap, B.radius0, B.radius1, quality >= 2 ? 12 : 8);

  // Jibboom runs out beyond the cap, a touch flatter than the bowsprit.
  const dir2 = new THREE.Vector3(0, Math.sin(B.steeve * 0.78), -Math.cos(B.steeve * 0.78)).normalize();
  const jStart = cap.clone().addScaledVector(dir, -2.2);
  const jibboomEnd = jStart.clone().addScaledVector(dir2, B.jibboom);
  oak.setColorHexLinear(0xffffff, 0.8);
  oak.spar(jStart, jibboomEnd, B.jibboomRadius * 1.4, B.jibboomRadius * 0.7, 8);

  const dir3 = new THREE.Vector3(0, Math.sin(B.steeve * 0.6), -Math.cos(B.steeve * 0.6)).normalize();
  const fStart = jibboomEnd.clone().addScaledVector(dir2, -3.0);
  const flyingEnd = fStart.clone().addScaledVector(dir3, B.flying);
  oak.setColorHexLinear(0xffffff, 0.86);
  oak.spar(fStart, flyingEnd, B.flyingRadius * 1.5, B.flyingRadius * 0.7, 6);

  // Bowsprit cap: a squared block with the jibboom running through it.
  bins.black.setColorHexLinear(0xffffff, 0.9);
  bins.black.pushTransform(new THREE.Matrix4().compose(
    cap,
    new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), dir),
    new THREE.Vector3(1, 1, 1),
  ));
  bins.black.box(0, 0.1, 0, 0.62, 0.62, 0.14);
  bins.black.popTransform();

  // Dolphin striker: hangs under the cap and spreads the martingale stays.
  const strikerTip = cap.clone();
  strikerTip.y -= B.strikerLen * 0.95;
  strikerTip.z += B.strikerLen * 0.28;
  oak.setColorHexLinear(0xffffff, 0.8);
  oak.spar(cap.clone().add(new THREE.Vector3(0, 0.1, 0)), strikerTip, 0.15, 0.08, 6);

  // Spritsail yard, athwart the bowsprit.
  const sy = YARDS.find((y) => y.id === 'spritsail')!;
  const mid = heel.clone().addScaledVector(dir, B.length * 0.62);
  const a = mid.clone();
  a.x -= sy.half;
  const b = mid.clone();
  b.x += sy.half;
  oak.partIndex = sy.part;
  oak.setColorHexLinear(0xffffff, 0.78);
  oak.spar(a, b, sy.radius, sy.radius, 8, true);
  oak.partIndex = 0;
  yards.push({ spec: sy, centre: mid, stbd: b, port: a, pivot: mid.clone() });

  // Bees and the gammon iron.
  bins.iron.setColorHexLinear(0xffffff, 0.85);
  for (let i = 0; i < 3; i++) {
    const p = heel.clone().addScaledVector(dir, 3.2 + i * 4.2);
    bins.iron.pushTransform(new THREE.Matrix4().compose(
      p,
      new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir),
      new THREE.Vector3(1, 1, 1),
    ));
    bins.iron.revolve([[0.52, -0.06], [0.55, 0], [0.52, 0.06]], 10, 3);
    bins.iron.popTransform();
  }

  return { heel, cap, jibboomEnd, flyingEnd, strikerTip, dir };
}

function buildSpanker(bins: Bins, mizzen: MastFrame): RigFrame['spanker'] {
  const oak = bins.oak;
  const S = SPANKER;
  const boomPivot = mizzen.lower(S.boomY);
  boomPivot.z += mizzen.spec.lowerRadius + 0.3;
  const boomEnd = boomPivot.clone();
  boomEnd.z += S.boomLen;
  boomEnd.y += 0.55;

  oak.partIndex = PART.BOOM;
  oak.setColorHexLinear(0xffffff, 0.78);
  oak.spar(boomPivot, boomEnd, S.boomRadius, S.boomRadius * 0.66, 9);
  // Boom saddle and topping-lift band.
  bins.iron.partIndex = PART.BOOM;
  bins.iron.setColorHexLinear(0xffffff, 0.85);
  bins.iron.box(boomEnd.x, boomEnd.y, boomEnd.z - 0.5, 0.22, 0.22, 0.1);
  bins.iron.partIndex = 0;
  oak.partIndex = 0;

  const gaffPivot = mizzen.lower(S.gaffY);
  gaffPivot.z += mizzen.spec.lowerRadius + 0.28;
  const gaffEnd = gaffPivot.clone();
  gaffEnd.z += S.gaffLen * Math.cos(S.gaffRise);
  gaffEnd.y += S.gaffLen * Math.sin(S.gaffRise);

  oak.partIndex = PART.GAFF;
  oak.setColorHexLinear(0xffffff, 0.8);
  oak.spar(gaffPivot, gaffEnd, S.gaffRadius, S.gaffRadius * 0.7, 8);
  // Gaff jaws.
  oak.setColorHexLinear(0xffffff, 0.72);
  for (const side of [1, -1] as const) {
    oak.box(side * 0.42, gaffPivot.y, gaffPivot.z - 0.55, 0.07, 0.14, 0.55);
  }
  oak.partIndex = 0;

  return { boomPivot, boomEnd, gaffPivot, gaffEnd };
}

/** Canvas coats and oak wedges where each mast passes through the deck. */
function buildMastCoats(bins: Bins, masts: MastFrame[]): void {
  for (const m of masts) {
    const y = deckSideY(tAtZ(m.spec.z)) + 0.28;
    const p = m.lower(y);
    bins.black.setColorHexLinear(0xffffff, 0.75);
    bins.black.pushTransform(new THREE.Matrix4().makeTranslation(p.x, p.y, p.z));
    bins.black.revolve(
      [
        [m.spec.lowerRadius * 1.55, -0.24], [m.spec.lowerRadius * 1.5, 0.0],
        [m.spec.lowerRadius * 1.28, 0.22], [m.spec.lowerRadius * 1.1, 0.34],
      ],
      12, 2,
    );
    bins.black.popTransform();
  }
}
