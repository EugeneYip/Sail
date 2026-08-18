/**
 * Every rope on the ship, in one instanced draw call.
 *
 * A "line" is two ship-local endpoints plus (sag, radius, bays, kind) and two
 * `aPart` slots. The vertex shader in `shaders/line.ts` sweeps a camera-facing
 * ribbon along the sagging curve between the endpoints, after pushing both
 * through the animated-part transform — so a braced yard drags its braces round
 * with it and a swung boom drags its sheet.
 *
 * Line families, in build order:
 *   standing  shrouds (paired, to deadeyes on the channels), futtock shrouds,
 *             topmast and topgallant shrouds, fore/back stays, bobstays,
 *             bowsprit shrouds, martingale stays
 *   ratlines  seized across every shroud gang, scalloped per bay
 *   running   braces, lifts, halyards, sheets, tacks, clewlines, buntlines,
 *             leechlines, bowlines, spanker vang and sheet
 */

import * as THREE from 'three';
import type { World } from '../../types';
import { makeLineMaterial, makeRibbonGeometry, type LineMatUniforms } from '../shaders/line';
import type { PartUniforms } from '../materials/materials';
import type { TexSet } from '../materials/textures';
import type { HullResult } from './hull';
import { CHANNELS } from './hull';
import type { MastFrame, RigFrame, YardFrame } from './masts';
import {
  BOWSPRIT, MASTS, PART, SPANKER, Station, YARDS, deckSideY, sheerY, squareCut, tAtZ, DECK_CAMBER,
} from '../dims';

export interface RiggingResult {
  mesh: THREE.Mesh;
  lineCount: number;
  update(world: World, root: THREE.Object3D): void;
  applySettings(quality: number): void;
  dispose(): void;
}

/** kind: 0 = tarred standing rigging, 1 = pale manila running rigging. */
const TAR = 0;
const MANILA = 1;

class LineSet {
  readonly a: number[] = [];
  readonly b: number[] = [];
  readonly p: number[] = [];
  readonly part: number[] = [];
  count = 0;

  add(
    A: THREE.Vector3, B: THREE.Vector3,
    sag: number, radius: number, kind: number,
    bays = 0, partA = 0, partB = 0,
  ): void {
    this.a.push(A.x, A.y, A.z);
    this.b.push(B.x, B.y, B.z);
    this.p.push(sag, radius, bays, kind);
    this.part.push(partA, partB);
    this.count++;
  }
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();

export function buildRigging(
  world: World,
  parts: PartUniforms,
  rope: TexSet,
  hull: HullResult,
  frame: RigFrame,
  quality: number,
): RiggingResult {
  const L = new LineSet();

  const chan = channelPoints(hull);
  for (let mi = 0; mi < frame.masts.length; mi++) {
    shrouds(L, frame.masts[mi], chan[mi], quality);
  }
  stays(L, frame);
  headRigging(L, frame);
  running(L, frame, quality);
  spankerRigging(L, frame);
  flagHalyards(L, frame);

  const seg = quality >= 3 ? 12 : quality >= 2 ? 9 : 6;
  const g = makeRibbonGeometry(seg);
  g.instanceCount = L.count;
  g.setAttribute('iA', new THREE.InstancedBufferAttribute(new Float32Array(L.a), 3));
  g.setAttribute('iB', new THREE.InstancedBufferAttribute(new Float32Array(L.b), 3));
  g.setAttribute('iParam', new THREE.InstancedBufferAttribute(new Float32Array(L.p), 4));
  g.setAttribute('iPart', new THREE.InstancedBufferAttribute(new Float32Array(L.part), 2));
  // The rig fills the screen from every camera; culling it by the unit ribbon's
  // own bounds would pop it out of frame.
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 30, 0), 90);

  const extra: LineMatUniforms = {
    uCamLocal: { value: new THREE.Vector3() },
    uViewportH: { value: 900 },
    uLineFade: { value: 1 },
  };
  const mat = makeLineMaterial(world.uniforms, parts, rope, extra);
  const mesh = new THREE.Mesh(g, mat);
  mesh.name = 'ship-rigging';
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.matrixAutoUpdate = false;
  mesh.renderOrder = 2;

  const inv = new THREE.Matrix4();
  return {
    mesh,
    lineCount: L.count,
    update(w, root) {
      inv.copy(root.matrixWorld).invert();
      extra.uCamLocal.value.setFromMatrixPosition(w.camera.matrixWorld).applyMatrix4(inv);
      extra.uViewportH.value = w.size.height;
    },
    applySettings() {},
    dispose() {
      g.dispose();
      mat.dispose();
    },
  };
}

/* ------------------------------------------------------------------ *
 *  Standing rigging
 * ------------------------------------------------------------------ */

interface ChannelPts {
  /** Deadeye positions on the channel, outboard face, per side. */
  stbd: THREE.Vector3[];
  port: THREE.Vector3[];
}

function channelPoints(hull: HullResult): ChannelPts[] {
  const out: ChannelPts[] = [];
  for (const ch of CHANNELS) {
    const stbd: THREE.Vector3[] = [];
    const port: THREE.Vector3[] = [];
    const n = MASTS[ch.mast].shrouds[0];
    for (let i = 0; i < n; i++) {
      const z = ch.z0 + ((i + 0.5) / n) * (ch.z1 - ch.z0);
      const t = tAtZ(z);
      const st = new Station(t);
      const y = sheerY(t) - 0.85 + 0.34;
      const w = st.widthAt(sheerY(t) - 0.85) + 0.78;
      stbd.push(new THREE.Vector3(w, y, z));
      port.push(new THREE.Vector3(-w, y, z));
    }
    out.push({ stbd, port });
  }
  void hull;
  return out;
}

function shrouds(L: LineSet, m: MastFrame, ch: ChannelPts, quality: number): void {
  const s = m.spec;
  const headY = s.lowerTop - 1.1;
  const nLower = s.shrouds[0];

  for (const side of [1, -1] as const) {
    const pts = side > 0 ? ch.stbd : ch.port;
    // Lower shrouds: the gang leads to the masthead, spread by the top.
    const top: THREE.Vector3[] = [];
    for (let i = 0; i < nLower; i++) {
      const f = (i + 0.5) / nLower;
      m.lower(headY - i * 0.16, _a);
      top.push(new THREE.Vector3(
        _a.x + side * (s.lowerRadius + 0.16 + i * 0.035),
        _a.y,
        _a.z - m.depth * 0.28 + f * m.depth * 0.66,
      ));
    }
    for (let i = 0; i < nLower; i++) {
      const A = pts[i];
      const B = top[i];
      // A shroud is set up bar-taut; only a hair of sag.
      L.add(B, A, 0.09, 0.036, TAR);
      // Deadeye pair and lanyard, drawn as a short thick stub.
      _c.copy(A);
      _c.y -= 0.36;
      L.add(A, _c, 0.0, 0.1, TAR);
    }

    // Ratlines: every 0.38 m up the gang, scalloped between each pair.
    const nRat = Math.floor((headY - pts[0].y) / (quality >= 2 ? 0.4 : 0.62));
    for (let r = 1; r < nRat; r++) {
      const f = r / nRat;
      // Stop short of the masthead where the gang closes up.
      if (f > 0.92) break;
      const fa = Math.pow(f, 1.02);
      _a.lerpVectors(pts[0], top[0], fa);
      _b.lerpVectors(pts[nLower - 1], top[nLower - 1], fa);
      // Sag scallops per bay: `bays` makes the shader repeat the droop.
      L.add(_a, _b, 0.028, 0.021, TAR, nLower - 1);
    }

    // Futtock shrouds: from the top's rim down and in to the lower mast.
    for (let i = 0; i < Math.min(5, nLower); i++) {
      const f = (i + 0.5) / Math.min(5, nLower);
      m.lower(m.platformY + 0.3, _a);
      _c.set(_a.x + side * m.halfWidth * 0.95, m.platformY + 0.34, _a.z - m.depth * 0.3 + f * m.depth * 0.7);
      m.lower(m.platformY - 2.1, _b);
      _d.set(_b.x + side * (s.lowerRadius + 0.1), _b.y, _b.z - m.depth * 0.16 + f * m.depth * 0.36);
      L.add(_c, _d, 0.02, 0.03, TAR);
    }

    // Topmast shrouds: from the top's rim to the crosstrees.
    const nTop = s.shrouds[1];
    for (let i = 0; i < nTop; i++) {
      const f = (i + 0.5) / nTop;
      m.lower(m.platformY, _a);
      _c.set(_a.x + side * m.halfWidth * (0.5 + 0.48 * f), m.platformY + 0.3,
        _a.z - m.depth * 0.3 + f * m.depth * 0.62);
      m.top(m.crossY - i * 0.12, _b);
      _d.set(_b.x + side * (s.topRadius + 0.1), _b.y, _b.z - 0.3 + f * 0.7);
      L.add(_d, _c, 0.05, 0.028, TAR);
    }
    // Topmast ratlines.
    const nTopRat = Math.floor((m.crossY - m.platformY) / (quality >= 2 ? 0.42 : 0.66));
    if (nTop >= 2) {
      m.lower(m.platformY, _a);
      const a0 = new THREE.Vector3(_a.x + side * m.halfWidth * 0.52, m.platformY + 0.3, _a.z - m.depth * 0.3);
      const a1 = new THREE.Vector3(
        _a.x + side * m.halfWidth * 0.97, m.platformY + 0.3, _a.z - m.depth * 0.3 + m.depth * 0.62,
      );
      m.top(m.crossY, _b);
      const b0 = new THREE.Vector3(_b.x + side * (s.topRadius + 0.1), m.crossY, _b.z - 0.3);
      const b1 = new THREE.Vector3(
        _b.x + side * (s.topRadius + 0.1), m.crossY - (nTop - 1) * 0.12, _b.z + 0.4,
      );
      for (let r = 1; r < nTopRat; r++) {
        const f = r / nTopRat;
        if (f > 0.9) break;
        _c.lerpVectors(a0, b0, f);
        _d.lerpVectors(a1, b1, f);
        L.add(_c, _d, 0.022, 0.019, TAR, nTop - 1);
      }
    }

    // Topgallant shrouds run from the crosstrees to the topgallant head.
    const nTg = s.shrouds[2];
    for (let i = 0; i < nTg; i++) {
      const f = (i + 0.5) / nTg;
      m.top(m.crossY, _a);
      _c.set(_a.x + side * s.topHalfWidth * 0.5, m.crossY + 0.1, _a.z - 0.3 + f * 0.8);
      m.tg(s.tgTop - 1.2, _b);
      _d.set(_b.x + side * (s.tgRadius + 0.06), _b.y, _b.z);
      L.add(_d, _c, 0.04, 0.02, TAR);
    }

    // Backstays: long sweeps from the topmast and topgallant heads to the
    // ship's side well abaft the channel. These are the lines that read as
    // the rig's outline from a beam-on view.
    const backZ = CHANNELS[Math.min(2, MASTS.indexOf(s))]?.z1 ?? 0;
    void backZ;
    for (const [hy, dz, rad] of [
      [s.topmastTop - 1.6, 5.0, 0.032], [s.topmastTop - 2.4, 7.2, 0.03],
      [s.tgTop - 1.6, 9.4, 0.026],
    ] as const) {
      const src = hy > s.tgFoot ? m.tg(hy, _a) : m.top(hy, _a);
      const z = THREE.MathUtils.clamp(s.z + dz, -24, 25.6);
      const t = tAtZ(z);
      const st = new Station(t);
      _c.set(src.x + side * (s.topRadius + 0.08), src.y, src.z);
      _d.set(side * (st.widthAt(sheerY(t) - 0.85) + 0.72), sheerY(t) - 0.5, z);
      L.add(_c, _d, 0.14, rad, TAR);
    }
  }
}

function stays(L: LineSet, frame: RigFrame): void {
  const [fore, main, miz] = frame.masts;

  // The four head stays come straight from `frame.headStays`, which is also
  // where the headsails get their luffs — a jib whose luff is not exactly on
  // its stay is the first thing that reads as wrong.
  for (let i = 0; i < frame.headStays.length; i++) {
    const st = frame.headStays[i];
    // Hanked sails hold a stay much straighter than a bare one hangs.
    L.add(st.head, st.tack, 0.22 + i * 0.06, i === 0 ? 0.05 : 0.036, TAR);
  }
  // Fore preventer stay, inboard of the fore stay proper.
  const B = frame.bowsprit;
  addStay(L, fore, fore.spec.lowerTop - 2.4, B.heel.clone().addScaledVector(B.dir, 1.2), 0.34, 0.042);

  // Main and mizzen stays lead forward and down to the deck at the next mast.
  const stayTo = (m: MastFrame, target: MastFrame, dz: number) => {
    const y = deckSideY(tAtZ(target.spec.z + dz)) + DECK_CAMBER;
    addStay(L, m, m.spec.lowerTop - 1.2, new THREE.Vector3(0, y + 0.6, target.spec.z + dz), 0.62, 0.05);
    addStayTop(L, m, m.spec.topmastTop - 1.4, target.lower(target.spec.lowerTop - 2.6), 0.5, 0.038);
    addStayTg(L, m, m.spec.tgTop - 1.2, target.top(target.crossY - 0.4), 0.42, 0.03);
  };
  stayTo(main, fore, 1.4);
  stayTo(miz, main, 1.6);
}

function addStay(L: LineSet, m: MastFrame, y: number, to: THREE.Vector3, sag: number, r: number): void {
  m.lower(y, _a);
  _a.z -= m.spec.lowerRadius + 0.08;
  L.add(_a, to, sag, r, TAR);
}
function addStayTop(L: LineSet, m: MastFrame, y: number, to: THREE.Vector3, sag: number, r: number): void {
  m.top(y, _a);
  _a.z -= m.spec.topRadius + 0.06;
  L.add(_a, to, sag, r, TAR);
}
function addStayTg(L: LineSet, m: MastFrame, y: number, to: THREE.Vector3, sag: number, r: number): void {
  m.tg(y, _a);
  _a.z -= m.spec.tgRadius + 0.05;
  L.add(_a, to, sag, r, TAR);
}

function headRigging(L: LineSet, frame: RigFrame): void {
  const B = frame.bowsprit;

  // Bobstays: bowsprit down to the stem, the lines that stop it lifting.
  for (const [f, sy] of [[0.55, -1.2], [0.85, 0.6], [1.0, 2.2]] as const) {
    _a.copy(B.heel).addScaledVector(B.dir, BOWSPRIT.length * f);
    _b.set(0, sy, -27.4 - sy * 0.15);
    L.add(_a, _b, 0.16, 0.05, TAR);
  }
  // Bowsprit shrouds, out to the bows.
  for (const side of [1, -1] as const) {
    _a.copy(B.cap);
    const t = tAtZ(-24.6);
    const st = new Station(t);
    _b.set(side * st.widthAt(sheerY(t) - 1.2), sheerY(t) - 1.0, -24.6);
    L.add(_a, _b, 0.12, 0.04, TAR);
  }
  // Martingale stays: jibboom down to the dolphin striker and back to the bows.
  _a.copy(B.jibboomEnd);
  L.add(_a, B.strikerTip, 0.05, 0.036, TAR);
  _a.copy(B.flyingEnd);
  L.add(_a, B.strikerTip, 0.06, 0.03, TAR);
  for (const side of [1, -1] as const) {
    const t = tAtZ(-25.4);
    const st = new Station(t);
    _b.set(side * st.widthAt(sheerY(t) - 2.4), sheerY(t) - 2.2, -25.4);
    L.add(B.strikerTip, _b, 0.05, 0.034, TAR);
  }
  // Jibboom guys, out to the head rails.
  for (const side of [1, -1] as const) {
    _b.set(side * 1.35, 6.1, -27.6);
    L.add(B.jibboomEnd, _b, 0.14, 0.03, TAR);
    _b.set(side * 1.15, 6.5, -29.4);
    L.add(B.flyingEnd, _b, 0.16, 0.026, TAR);
  }
  // Foot ropes under the bowsprit.
  for (const side of [1, -1] as const) {
    _a.copy(B.heel).addScaledVector(B.dir, 3.0);
    _a.x += side * 0.3;
    _b.copy(B.jibboomEnd);
    _b.x += side * 0.12;
    L.add(_a, _b, 0.5, 0.028, MANILA);
  }
}

/* ------------------------------------------------------------------ *
 *  Running rigging
 * ------------------------------------------------------------------ */

function running(L: LineSet, frame: RigFrame, quality: number): void {
  for (const yf of frame.yards) {
    if (yf.spec.mast === 3) {
      spritsailGear(L, yf, frame);
      continue;
    }
    const m = frame.masts[yf.spec.mast];
    const part = yf.spec.part;

    // Footropes and stirrups: what the topmen actually stand on. These hang
    // from the yard so they carry the yard's part slot at both ends.
    const nStir = quality >= 2 ? 4 : 3;
    for (const side of [1, -1] as const) {
      _a.copy(yf.centre);
      _a.x += side * 0.5;
      _a.z += yf.spec.radius * 0.7;
      _b.copy(side > 0 ? yf.stbd : yf.port);
      _b.x -= side * 0.5;
      _b.z += yf.spec.radius * 0.7;
      L.add(_a, _b, 0.62, 0.026, MANILA, 0, part, part);
      for (let i = 1; i <= nStir; i++) {
        const f = i / (nStir + 1);
        _c.lerpVectors(_a, _b, f);
        _d.copy(_c);
        _d.y = yf.centre.y + yf.spec.radius * 0.6;
        // Sag of the footrope at this station, so the stirrup reaches it.
        _c.y -= 0.62 * (4 * f * (1 - f));
        L.add(_d, _c, 0.0, 0.022, MANILA, 0, part, part);
      }
    }

    // Lifts: yard arms up to the masthead above.
    const liftY = yf.spec.tier === 0 ? m.spec.lowerTop - 0.8
      : yf.spec.tier === 1 ? m.spec.topmastTop - 0.9
        : yf.spec.tier === 2 ? m.spec.tgTop - 1.4 : m.spec.tgTop - 0.4;
    const liftAt = liftY > m.spec.tgFoot ? m.tg(liftY, _a) : liftY > m.spec.topmastFoot ? m.top(liftY, _a) : m.lower(liftY, _a);
    for (const tip of [yf.stbd, yf.port]) {
      _c.copy(liftAt);
      _c.x += Math.sign(tip.x) * 0.16;
      L.add(tip, _c, 0.22, 0.024, MANILA, 0, part, 0);
    }

    // Braces: from the yard arms aft (and, for the mizzen, forward) to a
    // fixed point, so bracing the yard visibly hauls one and slackens the
    // other. This is the single most legible piece of running rigging.
    const braceTo = braceAnchor(frame, yf.spec.mast, yf.spec.tier);
    for (const [tip, sgn] of [[yf.stbd, 1], [yf.port, -1]] as const) {
      _c.copy(braceTo);
      _c.x *= sgn;
      L.add(tip, _c, 0.55 + yf.spec.tier * 0.1, 0.023, MANILA, 0, part, 0);
    }

    // Clewlines and buntlines: from the yard down to the sail's own foot and
    // clews, taken from the same cut the sail is built from so they land on it.
    const drop = yf.spec.sailDrop;
    if (drop > 0) {
      const cut = squareCut(yf.spec);
      for (const f of quality >= 2 ? [-0.62, -0.24, 0.24, 0.62] : [-0.5, 0.5]) {
        _c.copy(yf.centre);
        _c.x += f * cut.headHalf;
        _d.copy(_c);
        _d.x = f * cut.footHalf;
        _d.y -= drop * 0.94;
        _d.z += 0.35;
        L.add(_c, _d, 0.1, 0.019, MANILA, 0, part, part);
      }
      // Sheets from the clews down to the yard below (or the deck).
      const below = frame.yards.find(
        (v) => v.spec.mast === yf.spec.mast && v.spec.tier === yf.spec.tier - 1,
      );
      for (const [tip, sgn] of [[yf.stbd, 1], [yf.port, -1]] as const) {
        _c.copy(tip);
        _c.x = sgn * cut.footHalf;
        _c.y = yf.centre.y - drop;
        _c.z = yf.centre.z + drop * 0.03;
        if (below) {
          _d.copy(sgn > 0 ? below.stbd : below.port);
          _d.x -= sgn * 0.5;
          L.add(_c, _d, 0.3, 0.021, MANILA, 0, part, below.spec.part);
        } else {
          const t = tAtZ(yf.centre.z + 2.5);
          const st = new Station(t);
          _d.set(sgn * (st.widthAt(sheerY(t) - 0.9) - 0.4), sheerY(t) - 0.9, yf.centre.z + 2.5);
          L.add(_c, _d, 0.35, 0.024, MANILA, 0, part, 0);
        }
      }
    }

    // Halyard for the yards that hoist (topsail, topgallant, royal).
    if (yf.spec.tier >= 1) {
      _c.copy(yf.centre);
      _c.z += 0.2;
      const hy = liftY + 0.6;
      const at = hy > m.spec.tgFoot ? m.tg(hy, _d) : m.top(hy, _d);
      L.add(_c, at, 0.1, 0.022, MANILA, 0, part, 0);
    }
  }
}

/** Where a brace is belayed: aft on the next mast, or on the ship's side. */
function braceAnchor(frame: RigFrame, mast: number, tier: number): THREE.Vector3 {
  const out = new THREE.Vector3();
  if (mast === 0) {
    // Fore braces lead aft to the mainmast.
    const m = frame.masts[1];
    const y = tier === 0 ? m.spec.deckY + 2.2 : tier === 1 ? m.platformY - 1.2 : m.crossY - 4;
    m.at(y, out);
    out.x += m.spec.lowerRadius + 0.5;
  } else if (mast === 1) {
    // Main braces lead aft to the mizzen.
    const m = frame.masts[2];
    const y = tier === 0 ? m.spec.deckY + 2.6 : tier === 1 ? m.platformY - 0.8 : m.crossY - 3;
    m.at(y, out);
    out.x += m.spec.lowerRadius + 0.5;
  } else {
    // Mizzen braces lead forward to the mainmast top.
    const m = frame.masts[1];
    const y = tier === 0 ? m.platformY - 3 : tier === 1 ? m.crossY - 5 : m.spec.tgFoot + 1;
    m.at(y, out);
    out.x += m.spec.lowerRadius + 0.4;
  }
  return out;
}

function spritsailGear(L: LineSet, yf: YardFrame, frame: RigFrame): void {
  const B = frame.bowsprit;
  for (const tip of [yf.stbd, yf.port]) {
    _c.copy(B.cap);
    _c.y += 0.3;
    L.add(tip, _c, 0.2, 0.022, MANILA, 0, yf.spec.part, 0);
    _d.copy(tip);
    _d.y -= 1.6;
    L.add(tip, _d, 0.0, 0.02, MANILA, 0, yf.spec.part, yf.spec.part);
  }
}

function spankerRigging(L: LineSet, frame: RigFrame): void {
  const S = frame.spanker;
  const miz = frame.masts[2];

  // Topping lifts hold the boom up when the sail is off her.
  for (const side of [1, -1] as const) {
    miz.lower(SPANKER.gaffY + 3.4, _a);
    _a.x += side * 0.3;
    _b.copy(S.boomEnd);
    _b.x += side * 0.12;
    L.add(_a, _b, 0.3, 0.028, MANILA, 0, 0, PART.BOOM);
  }
  // Peak and throat halyards for the gaff.
  miz.top(miz.spec.topmastFoot + 6.5, _a);
  L.add(_a, S.gaffEnd, 0.14, 0.026, MANILA, 0, 0, PART.GAFF);
  miz.lower(miz.spec.lowerTop - 1.6, _a);
  L.add(_a, S.gaffPivot, 0.1, 0.026, MANILA, 0, 0, PART.GAFF);
  // Vangs from the gaff peak down to the quarters.
  for (const side of [1, -1] as const) {
    const t = tAtZ(24.5);
    const st = new Station(t);
    _b.set(side * st.widthAt(sheerY(t) - 0.7), sheerY(t) - 0.4, 24.5);
    L.add(S.gaffEnd, _b, 0.32, 0.024, MANILA, 0, PART.GAFF, 0);
  }
  // Sheet: boom end to the taffrail horse.
  _b.set(0, sheerY(1) - 0.6, 26.4);
  L.add(S.boomEnd, _b, 0.24, 0.03, MANILA, 0, PART.BOOM, 0);
}

function flagHalyards(L: LineSet, frame: RigFrame): void {
  const miz = frame.masts[2];
  const main = frame.masts[1];
  miz.tg(miz.spec.truck - 0.2, _a);
  L.add(_a, frame.spanker.gaffEnd, 0.3, 0.016, MANILA, 0, 0, PART.GAFF);
  main.tg(main.spec.truck - 0.2, _a);
  main.tg(main.spec.tgTop - 3, _b);
  L.add(_a, _b, 0.12, 0.014, MANILA);
  void YARDS;
  void BOWSPRIT;
}
