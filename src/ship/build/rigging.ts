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
import type { SailUniforms } from './sails';
import type { HullResult } from './hull';
import { backstayTable, channelPoints, mastGangs } from './rigEnvelope';
import type { MastFrame, RigFrame, YardFrame } from './masts';
import {
  BOWSPRIT, MASTS, PART, SPANKER, Station, YARDS, deckSideY, sheerY, squareCut, tAtZ, DECK_CAMBER,
} from '../dims';
import type { Member } from './rigEnvelope';
import { JACKSTAY_STANDOFF_M } from './sails';

/** How far abaft the yard's surface the footropes are slung, metres. */
const FOOTROPE_ABAFT_M = 0.34;
/** Length of the brace pendant leading aft off the yardarm, metres. */
const BRACE_PENDANT_M = 2.4;
/**
 * How far proud of the cloth a bound line rides, metres.
 *
 * The cloth is drawn as a 21x15 polygon mesh of an analytic surface, so between
 * vertices the triangles chord ACROSS the belly and sit a centimetre or two
 * inside the true surface. A line evaluated on the exact surface would sink
 * into the polygons on the concave side; 6 cm clears that with room to spare
 * and is invisible at any range.
 */
const BOUND_STANDOFF_M = 0.06;

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

export class LineSet {
  readonly a: number[] = [];
  readonly b: number[] = [];
  readonly p: number[] = [];
  readonly part: number[] = [];
  /**
   * Which family each instance belongs to, in instance order. Built once and
   * hung off the mesh's `userData` — no per-frame cost — because the only way
   * to find out which of nine hundred anonymous ropes is the one drawn through
   * a sail is to be able to name it. See `.tmp/ropesail.mjs`.
   */
  readonly tag: string[] = [];
  /** (sail slot + 1, standoff m, 0, 0) — see `iBind` in `shaders/line.ts`. */
  readonly bind: number[] = [];
  /** (u0, v0, u1, v1) of the path a bound line takes across the cloth. */
  readonly bindUv: number[] = [];
  /** Family applied to every `add` until the next `family()` call. */
  private cur = '?';
  count = 0;

  family(name: string): void {
    this.cur = name;
  }

  add(
    A: THREE.Vector3, B: THREE.Vector3,
    sag: number, radius: number, kind: number,
    bays = 0, partA = 0, partB = 0,
  ): void {
    this.a.push(A.x, A.y, A.z);
    this.b.push(B.x, B.y, B.z);
    this.p.push(sag, radius, bays, kind);
    this.part.push(partA, partB);
    this.bind.push(0, 0, 0, 0);
    this.bindUv.push(0, 0, 0, 0);
    this.tag.push(this.cur);
    this.count++;
  }

  /**
   * A line that LIES ON a sail: rove up the cloth's forward face from
   * (u0, v0) to (u1, v1), `standoff` metres proud of it. `A` and `B` are still
   * given because the shader keeps using them for the wind-sway seed, and
   * because they are the right answer if the binding is ever switched off.
   */
  addOnSail(
    A: THREE.Vector3, B: THREE.Vector3, radius: number,
    slot: number, uv: readonly [number, number, number, number], standoff: number,
    partSlot: number,
  ): void {
    this.add(A, B, 0, radius, MANILA, 0, partSlot, partSlot);
    const i = (this.count - 1) * 4;
    this.bind[i] = slot + 1;
    this.bind[i + 1] = standoff;
    this.bindUv[i] = uv[0];
    this.bindUv[i + 1] = uv[1];
    this.bindUv[i + 2] = uv[2];
    this.bindUv[i + 3] = uv[3];
  }
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();

/**
 * Every rope, as data, with no GPU anywhere near it.
 *
 * Separated from the mesh so the whole rig can be built and MEASURED in plain
 * node: `.tmp/ropecpu.mjs` calls this and `writeSailCuts` and does exact
 * segment-vs-triangle tests against the animated cloth, which is how the
 * rope-through-canvas counts in DIAGNOSIS are obtained. Rope routing is pure
 * geometry — it never needed a browser, and the instrument that needed one
 * could not be run while the GPU was busy.
 */
export function buildLines(sailIds: readonly string[], frame: RigFrame, quality: number): LineSet {
  const L = new LineSet();
  // Sail id -> slot in the cloth's uniform arrays, so a bound line can name
  // the sail it lies against.
  const sailSlot = new Map<string, number>();
  sailIds.forEach((id, i) => sailSlot.set(id, i));

  for (let mi = 0; mi < frame.masts.length; mi++) {
    shrouds(L, frame.masts[mi], channelPoints(mi), quality);
  }
  stays(L, frame);
  headRigging(L, frame);
  running(L, frame, sailSlot, quality);
  spankerRigging(L, frame);
  flagHalyards(L, frame);
  return L;
}

export function buildRigging(
  world: World,
  parts: PartUniforms,
  rope: TexSet,
  hull: HullResult,
  frame: RigFrame,
  sailU: SailUniforms,
  quality: number,
): RiggingResult {
  void hull;
  const L = buildLines(world.ship.sails.map((sa) => sa.id), frame, quality);

  const seg = quality >= 3 ? 12 : quality >= 2 ? 9 : 6;
  const g = makeRibbonGeometry(seg);
  g.instanceCount = L.count;
  g.setAttribute('iA', new THREE.InstancedBufferAttribute(new Float32Array(L.a), 3));
  g.setAttribute('iB', new THREE.InstancedBufferAttribute(new Float32Array(L.b), 3));
  g.setAttribute('iParam', new THREE.InstancedBufferAttribute(new Float32Array(L.p), 4));
  g.setAttribute('iPart', new THREE.InstancedBufferAttribute(new Float32Array(L.part), 2));
  g.setAttribute('iBind', new THREE.InstancedBufferAttribute(new Float32Array(L.bind), 4));
  g.setAttribute('iBindUV', new THREE.InstancedBufferAttribute(new Float32Array(L.bindUv), 4));
  // The rig fills the screen from every camera; culling it by the unit ribbon's
  // own bounds would pop it out of frame.
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 30, 0), 90);

  const extra: LineMatUniforms = {
    uCamLocal: { value: new THREE.Vector3() },
    uViewportH: { value: 900 },
    uLineFade: { value: 1 },
  };
  const mat = makeLineMaterial(
    world.uniforms, parts, rope, extra, sailU, world.ship.sails.length,
  );
  const mesh = new THREE.Mesh(g, mat);
  mesh.name = 'ship-rigging';
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.matrixAutoUpdate = false;
  mesh.renderOrder = 2;
  mesh.userData.lineTags = L.tag;

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

/** One gang mirrored onto a side, since `mastGangs` gives starboard only. */
function sided(ms: Member[], side: 1 | -1): Member[] {
  return ms.map((m) => ({
    bot: new THREE.Vector3(m.bot.x * side, m.bot.y, m.bot.z),
    top: new THREE.Vector3(m.top.x * side, m.top.y, m.top.z),
  }));
}

/**
 * WHICH WAY EACH GANG FANS, and how far, is decided in `build/rigEnvelope.ts` —
 * because the sails are told the same geometry there and flatten against it, and
 * a gang that moved without the cloth knowing would put the ratlines straight
 * back through the courses. Nothing here computes a shroud endpoint.
 */
function shrouds(L: LineSet, m: MastFrame, chan: THREE.Vector3[], quality: number): void {
  const s = m.spec;
  const headY = s.lowerTop - 1.1;
  const nLower = s.shrouds[0];
  const gangs = mastGangs(m, chan);

  for (const side of [1, -1] as const) {
    const lower = sided(gangs.lower, side);
    const pts = lower.map((v) => v.bot);
    const top = lower.map((v) => v.top);
    for (let i = 0; i < nLower; i++) {
      const A = pts[i];
      const B = top[i];
      L.family('shroud-lower');
      // A shroud is set up bar-taut; only a hair of sag.
      L.add(B, A, 0.09, 0.036, TAR);
      L.family('deadeye');
      // Deadeye pair and lanyard, drawn as a short thick stub.
      _c.copy(A);
      _c.y -= 0.36;
      L.add(A, _c, 0.0, 0.1, TAR);
    }

    L.family('ratline-lower');
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

    L.family('futtock');
    // Futtock shrouds: from the top's rim down and in to the lower mast.
    for (let i = 0; i < Math.min(5, nLower); i++) {
      const f = (i + 0.5) / Math.min(5, nLower);
      m.lower(m.platformY + 0.3, _a);
      _c.set(_a.x + side * m.halfWidth * 0.95, m.platformY + 0.34, _a.z - m.depth * 0.3 + f * m.depth * 0.7);
      m.lower(m.platformY - 2.1, _b);
      _d.set(_b.x + side * (s.lowerRadius + 0.1), _b.y, _b.z - m.depth * 0.16 + f * m.depth * 0.36);
      L.add(_c, _d, 0.02, 0.03, TAR);
    }

    L.family('shroud-topmast');
    // Topmast shrouds: from the top's rim to the crosstrees.
    const nTop = s.shrouds[1];
    const tm = sided(gangs.topmast, side);
    for (let i = 0; i < nTop; i++) L.add(tm[i].top, tm[i].bot, 0.05, 0.028, TAR);
    L.family('ratline-topmast');
    // Topmast ratlines.
    const nTopRat = Math.floor((m.crossY - m.platformY) / (quality >= 2 ? 0.42 : 0.66));
    if (nTop >= 2) {
      const a0 = tm[0].bot;
      const a1 = tm[nTop - 1].bot;
      const b0 = tm[0].top;
      const b1 = tm[nTop - 1].top;
      for (let r = 1; r < nTopRat; r++) {
        const f = r / nTopRat;
        if (f > 0.9) break;
        _c.lerpVectors(a0, b0, f);
        _d.lerpVectors(a1, b1, f);
        L.add(_c, _d, 0.022, 0.019, TAR, nTop - 1);
      }
    }

    L.family('shroud-tg');
    // Topgallant shrouds run from the crosstrees to the topgallant head.
    const tgs = sided(gangs.tg, side);
    for (const g of tgs) L.add(g.top, g.bot, 0.04, 0.02, TAR);

    // Backstays: long sweeps from the topmast and topgallant heads to the
    // ship's side well abaft the channel. These are the lines that read as
    // the rig's outline from a beam-on view.
    L.family('backstay');
    const bs = sided(gangs.backstay, side);
    const table = backstayTable(s);
    for (let i = 0; i < bs.length; i++) {
      L.add(bs[i].top, bs[i].bot, 0.14, table[i][2], TAR);
    }
  }
}

function stays(L: LineSet, frame: RigFrame): void {
  const [fore, main, miz] = frame.masts;

  // The four head stays come straight from `frame.headStays`, which is also
  // where the headsails get their luffs — a jib whose luff is not exactly on
  // its stay is the first thing that reads as wrong.
  L.family('headstay');
  for (let i = 0; i < frame.headStays.length; i++) {
    const st = frame.headStays[i];
    // Hanked sails hold a stay much straighter than a bare one hangs.
    L.add(st.head, st.tack, 0.22 + i * 0.06, i === 0 ? 0.05 : 0.036, TAR);
  }
  L.family('forestay');
  // Fore preventer stay, inboard of the fore stay proper.
  const B = frame.bowsprit;
  addStay(L, fore, fore.spec.lowerTop - 2.4, B.heel.clone().addScaledVector(B.dir, 1.2), 0.34, 0.042);

  // Main and mizzen stays lead forward and down to the deck at the next mast.
  L.family('mast-stay');
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

  L.family('bobstay');
  // Bobstays: bowsprit down to the stem, the lines that stop it lifting.
  for (const [f, sy] of [[0.55, -1.2], [0.85, 0.6], [1.0, 2.2]] as const) {
    _a.copy(B.heel).addScaledVector(B.dir, BOWSPRIT.length * f);
    _b.set(0, sy, -27.4 - sy * 0.15);
    L.add(_a, _b, 0.16, 0.05, TAR);
  }
  L.family('bowsprit-shroud');
  // Bowsprit shrouds, out to the bows.
  for (const side of [1, -1] as const) {
    _a.copy(B.cap);
    const t = tAtZ(-24.6);
    const st = new Station(t);
    _b.set(side * st.widthAt(sheerY(t) - 1.2), sheerY(t) - 1.0, -24.6);
    L.add(_a, _b, 0.12, 0.04, TAR);
  }
  L.family('martingale');
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
  L.family('jibboom-guy');
  // Jibboom guys, out to the head rails.
  for (const side of [1, -1] as const) {
    _b.set(side * 1.35, 6.1, -27.6);
    L.add(B.jibboomEnd, _b, 0.14, 0.03, TAR);
    _b.set(side * 1.15, 6.5, -29.4);
    L.add(B.flyingEnd, _b, 0.16, 0.026, TAR);
  }
  L.family('bowsprit-footrope');
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

function running(
  L: LineSet, frame: RigFrame, sailSlot: Map<string, number>, quality: number,
): void {
  for (const yf of frame.yards) {
    if (yf.spec.mast === 3) {
      spritsailGear(L, yf, frame);
      continue;
    }
    const m = frame.masts[yf.spec.mast];
    const part = yf.spec.part;

    // Footropes and stirrups: what the topmen actually stand on. These hang
    // from the yard so they carry the yard's part slot at both ends.
    L.family('yard-footrope');
    const nStir = quality >= 2 ? 4 : 3;
    // Footropes hang from stirrups on the yard's AFTER side, and they have to
    // hang clear of the sail gathered on top of it: a furled course makes a
    // roll half a metre in radius centred on the jackstay, and at 0.7 of a
    // radius abaft the axis the ropes and every stirrup ran straight through
    // it. Real ones are slung well aft of the spar for exactly this reason —
    // you stand behind the bundle to furl it.
    const ropeZ = yf.spec.radius + FOOTROPE_ABAFT_M;
    for (const side of [1, -1] as const) {
      _a.copy(yf.centre);
      _a.x += side * 0.5;
      _a.z += ropeZ;
      _b.copy(side > 0 ? yf.stbd : yf.port);
      _b.x -= side * 0.5;
      _b.z += ropeZ;
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

    L.family('lift');
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
    L.family('brace');
    const braceTo = braceAnchor(frame, yf.spec.mast, yf.spec.tier);
    for (const [tip, sgn] of [[yf.stbd, 1], [yf.port, -1]] as const) {
      _c.copy(braceTo);
      _c.x *= sgn;
      // Brace PENDANT: a short strop leading aft off the yardarm before the
      // brace proper takes over. Without it the brace left the yardarm and
      // dived straight for its belay point, which took it across the flare of
      // its own sail's foot — the clews sheet out wider than the yard — and,
      // at the far end, in through the next mast's canvas.
      _d.copy(tip);
      _d.z += BRACE_PENDANT_M;
      _d.x += sgn * 0.25;
      _d.y -= 0.12;
      L.add(tip, _d, 0.04, 0.023, MANILA, 0, part, part);
      L.add(_d, _c, 0.55 + yf.spec.tier * 0.1, 0.023, MANILA, 0, part, 0);
    }

    // Clewlines and buntlines: from the yard down to the sail's own foot and
    // clews, taken from the same cut the sail is built from so they land on it.
    const drop = yf.spec.sailDrop;
    const slot = sailSlot.get(yf.spec.id) ?? -1;
    if (drop > 0) {
      const cut = squareCut(yf.spec);
      // Buntlines and leechlines LIE ON the cloth: they are rove through
      // cringles on the sail's forward face and haul the bunt up to the yard.
      // Bound to the same `lwSailPoint` the cloth is drawn from, so they
      // follow camber, shiver, reef and the furled roll instead of cutting
      // across whichever of those happens to be showing.
      L.family('buntline');
      for (const f of quality >= 2 ? [-0.62, -0.24, 0.24, 0.62] : [-0.5, 0.5]) {
        const u = 0.5 + f * 0.5;
        _c.copy(yf.centre);
        _c.x += f * cut.headHalf;
        _d.copy(_c);
        _d.x = f * cut.footHalf;
        _d.y -= drop * 0.94;
        if (slot >= 0) {
          L.addOnSail(_c, _d, 0.019, slot, [u, 0.985, u, 0.0], BOUND_STANDOFF_M, part);
        } else {
          L.add(_c, _d, 0.1, 0.019, MANILA, 0, part, part);
        }
      }
      L.family('leechline');
      if (quality >= 2 && slot >= 0) {
        for (const u of [0.015, 0.985]) {
          _c.copy(yf.centre);
          _c.x += (u - 0.5) * 2 * cut.headHalf;
          _d.copy(_c);
          _d.y -= drop * 0.55;
          L.addOnSail(_c, _d, 0.017, slot, [u, 0.55, u, 0.0], BOUND_STANDOFF_M, part);
        }
      }
      L.family('sheet');
      // Sheets from the clews down to the yard below (or the deck).
      const below = frame.yards.find(
        (v) => v.spec.mast === yf.spec.mast && v.spec.tier === yf.spec.tier - 1,
      );
      // The clew has to be taken from the SAME construction `build/sails.ts`
      // uses, or the sheet starts a metre from the corner it is bent to —
      // which is what put every sheet through the foot of its own sail.
      const rake = yf.spec.mast < MASTS.length ? Math.tan(MASTS[yf.spec.mast].rake) : 0;
      const clewZ = yf.centre.z - (yf.spec.radius + JACKSTAY_STANDOFF_M) - drop * rake;
      for (const [tip, sgn] of [[yf.stbd, 1], [yf.port, -1]] as const) {
        _c.copy(tip);
        _c.x = sgn * (cut.footHalf + 0.05);
        _c.y = yf.centre.y - drop;
        _c.z = clewZ;
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
      L.family('yard-halyard');
      _c.copy(yf.centre);
      _c.z += 0.2;
      const hy = liftY + 0.6;
      const at = hy > m.spec.tgFoot ? m.tg(hy, _d) : m.top(hy, _d);
      L.add(_c, at, 0.1, 0.022, MANILA, 0, part, 0);
    }
  }
}

/**
 * Where a brace is belayed: aft on the next mast, or on the ship's side.
 *
 * The belay point has to be ABAFT the next mast's canvas, not on its axis.
 * These points sit inside the vertical span of the sail they are behind, and on
 * the axis they were also inside its DEPTH — so every brace on the ship ended by
 * entering the next mast's sail from in front and coming out at the back. The
 * offset is the deepest belly a course can stand (a quarter of a 26 m chord)
 * plus the yard's own standoff, which is where a pin rail or a block on the
 * stay would be anyway.
 */
const BRACE_BELAY_ABAFT_M = 2.6;

/**
 * Metres abaft its own mast that a course's braces come down to the rail.
 *
 * A COURSE's braces do not lead to the next mast at all — they lead aft and down
 * to the ship's side, and that is what keeps them clear of canvas. Leading them
 * to the next mast made them cross the whole width of the intervening sail
 * diagonally, and it is the one rope run on the ship whose whole length lies in
 * front of cloth, so it is the one the eye finds first.
 *
 * Measured with `.tmp/ropesail.mjs`, live trim: the brace family pierced 15
 * sails before this and 12 after. What is left is the UPPER tiers, which really
 * do lead to the next mast and cannot clear that mast's narrow topgallant and
 * royal canvas on a straight chord — see DIAGNOSIS. Raising
 * `BRACE_BELAY_ABAFT_M` to 4.8 was tried and measured no better (13), so it was
 * put back.
 */
const COURSE_BRACE_ABAFT_M = 9.2;

function braceAnchor(frame: RigFrame, mast: number, tier: number): THREE.Vector3 {
  const out = new THREE.Vector3();
  if (tier === 0 && mast < 2) {
    const z = MASTS[mast].z + COURSE_BRACE_ABAFT_M;
    const t = tAtZ(z);
    const st = new Station(t);
    const y = sheerY(t) - 0.9;
    // Just inboard of the rail, where the pin rail actually is.
    out.set(st.widthAt(y) - 0.45, y, z);
    return out;
  }
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
  out.z += BRACE_BELAY_ABAFT_M;
  return out;
}

function spritsailGear(L: LineSet, yf: YardFrame, frame: RigFrame): void {
  const B = frame.bowsprit;
  L.family('spritsail-gear');
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

  L.family('topping-lift');
  // Topping lifts hold the boom up when the sail is off her.
  for (const side of [1, -1] as const) {
    miz.lower(SPANKER.gaffY + 3.4, _a);
    _a.x += side * 0.3;
    _b.copy(S.boomEnd);
    _b.x += side * 0.12;
    L.add(_a, _b, 0.3, 0.028, MANILA, 0, 0, PART.BOOM);
  }
  L.family('gaff-halyard');
  // Peak and throat halyards for the gaff.
  miz.top(miz.spec.topmastFoot + 6.5, _a);
  L.add(_a, S.gaffEnd, 0.14, 0.026, MANILA, 0, 0, PART.GAFF);
  miz.lower(miz.spec.lowerTop - 1.6, _a);
  L.add(_a, S.gaffPivot, 0.1, 0.026, MANILA, 0, 0, PART.GAFF);
  L.family('vang');
  // Vangs from the gaff peak down to the quarters.
  for (const side of [1, -1] as const) {
    const t = tAtZ(24.5);
    const st = new Station(t);
    _b.set(side * st.widthAt(sheerY(t) - 0.7), sheerY(t) - 0.4, 24.5);
    L.add(S.gaffEnd, _b, 0.32, 0.024, MANILA, 0, PART.GAFF, 0);
  }
  L.family('spanker-sheet');
  // Sheet: boom end to the taffrail horse.
  _b.set(0, sheerY(1) - 0.6, 26.4);
  L.add(S.boomEnd, _b, 0.24, 0.03, MANILA, 0, PART.BOOM, 0);
}

function flagHalyards(L: LineSet, frame: RigFrame): void {
  const miz = frame.masts[2];
  const main = frame.masts[1];
  L.family('flag-halyard');
  miz.tg(miz.spec.truck - 0.2, _a);
  L.add(_a, frame.spanker.gaffEnd, 0.3, 0.016, MANILA, 0, 0, PART.GAFF);
  main.tg(main.spec.truck - 0.2, _a);
  main.tg(main.spec.tgTop - 3, _b);
  L.add(_a, _b, 0.12, 0.014, MANILA);
  void YARDS;
  void BOWSPRIT;
}
