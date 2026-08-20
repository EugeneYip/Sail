/**
 * Where the standing rigging is, as something a sail can press against.
 *
 * A course sheeted home bellies a tenth of its chord to leeward. On the main
 * that is three metres of cloth moving aft, and the shroud gang it moves into is
 * seized to the channels — it cannot get out of the way. Measured with
 * `.tmp/ropesail.mjs`, that single fact accounted for most of the rope-through-
 * canvas in the ship: `ratline-lower` 17-23 and `shroud-lower` 7-10 in live
 * trim, and 45 / 126 once the yards were braced.
 *
 * A smaller camber constant would hide it and cost the rig its shape, so
 * instead the cloth is told where the rigging IS. This file reduces every gang
 * of shrouds, the backstay fan and the mast itself to a handful of planes with
 * a footprint, which `lwSailPoint` uses to flatten the cloth locally where it
 * would otherwise pass through — which is what canvas actually does when it
 * takes up against the rigging, and why a real course carries a vertical crease
 * over the lee shrouds.
 *
 * Each slot is
 *
 *   plane = (A, B, C, halfWidth)   the limit surface, z <= A + B*|x| + C*y
 *   band  = (P, Q, y0, y1)         its footprint, |x| within halfWidth of P + Q*y,
 *                                  y within [y0, y1]
 *
 * so the shader costs one dot product and two smoothsteps per slot. The planes
 * are FITTED to the same member endpoints `build/rigging.ts` draws, by the
 * shared helpers below, so the two can never drift apart: move a channel and the
 * envelope moves with it.
 */

import * as THREE from 'three';
import { CHANNELS } from './hull';
import { MASTS, Station, sheerY, tAtZ, type MastSpec } from '../dims';
import type { MastFrame, RigFrame } from './masts';

/** Slots per mast: lower gang, topmast gang, topgallant gang, backstays, mast. */
export const RIG_SLOTS = 5;
export const RIG_N = RIG_SLOTS * 3;

/**
 * How wide, in metres, the cloth feels an obstacle beyond its own width.
 *
 * Canvas is not a point sampler: it drapes over a shroud and the flat runs out
 * a metre or so either side. It also has to be wide compared with the vertex
 * spacing — a course at high quality is a 27x19 grid over 27 m, so a feather
 * much under a metre would be resolved by a single row and read as a kink
 * rather than a fold.
 */
export const RIG_FEATHER_M = 1.35;
/**
 * Radius of the soft-min knee, metres. The cloth begins to flatten this far
 * short of contact, so a sail that merely comes close does not snap.
 */
export const RIG_KNEE_M = 0.34;
/** Clearance kept between the cloth and the rope's own surface, metres. */
const RIG_MARGIN_M = 0.10;
/** Extra footprint half-width beyond the members' own spread, metres. */
const BAND_PAD_M = 0.28;

export interface RigEnvUniforms {
  uRigPlane: { value: THREE.Vector4[] };
  uRigBand: { value: THREE.Vector4[] };
}

/**
 * How far a mast's shroud gangs fan away from its axis, as a fraction of the
 * book value.
 *
 * The mizzen gang fans FORWARD (see `CHANNELS`), and its own square sails hang
 * forward of the mast too, so at full spread the gang's leading shrouds stood
 * ahead of the mizzen topsail's flat cut — the sail and the rigging were
 * interleaved before any camber was applied at all, and no contact model can fix
 * that because there is no side of the gang the cloth can be on. Pulling the
 * mizzen fan in leaves half a metre of daylight between the gang and the cut,
 * which the contact model can then defend. It stays clear of the spanker because
 * the spanker's luff is ON the mast and every part of the gang is forward of it.
 */
function gangSpread(s: MastSpec): number {
  return s.name === 'mizzen' ? 0.55 : 1;
}

export interface Member {
  bot: THREE.Vector3;
  top: THREE.Vector3;
}

/** Deadeye positions on one channel, starboard side, outboard face. */
export function channelPoints(mast: number): THREE.Vector3[] {
  const ch = CHANNELS[mast];
  const out: THREE.Vector3[] = [];
  const n = MASTS[ch.mast].shrouds[0];
  for (let i = 0; i < n; i++) {
    const z = ch.z0 + ((i + 0.5) / n) * (ch.z1 - ch.z0);
    const t = tAtZ(z);
    const st = new Station(t);
    out.push(new THREE.Vector3(
      st.widthAt(sheerY(t) - 0.85) + 0.78, sheerY(t) - 0.85 + 0.34, z,
    ));
  }
  return out;
}

/**
 * The three shroud gangs of one mast, starboard side, as member endpoints.
 *
 * `build/rigging.ts` draws exactly these, mirrored for port; the envelope below
 * is fitted to them. Nothing else may compute a shroud endpoint.
 */
export function mastGangs(m: MastFrame, chan: THREE.Vector3[]): {
  lower: Member[]; topmast: Member[]; tg: Member[]; backstay: Member[];
} {
  const s = m.spec;
  const fwd = (s.name === 'mizzen' ? -1 : 1) * gangSpread(s);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();

  const lower: Member[] = [];
  const headY = s.lowerTop - 1.1;
  const nLower = s.shrouds[0];
  for (let i = 0; i < nLower; i++) {
    const f = (i + 0.5) / nLower;
    m.lower(headY - i * 0.16, a);
    lower.push({
      bot: chan[i].clone(),
      top: new THREE.Vector3(
        a.x + s.lowerRadius + 0.16 + i * 0.035,
        a.y,
        a.z + fwd * (m.depth * 0.10 + f * m.depth * 0.55),
      ),
    });
  }

  const topmast: Member[] = [];
  const nTop = s.shrouds[1];
  for (let i = 0; i < nTop; i++) {
    const f = (i + 0.5) / nTop;
    m.lower(m.platformY, a);
    m.top(m.crossY - i * 0.12, b);
    topmast.push({
      bot: new THREE.Vector3(
        a.x + m.halfWidth * (0.5 + 0.48 * f), m.platformY + 0.3,
        a.z + fwd * (m.depth * 0.02 + f * m.depth * 0.5),
      ),
      top: new THREE.Vector3(b.x + s.topRadius + 0.1, b.y, b.z - 0.3 + f * 0.7),
    });
  }

  const tg: Member[] = [];
  const nTg = s.shrouds[2];
  for (let i = 0; i < nTg; i++) {
    const f = (i + 0.5) / nTg;
    m.top(m.crossY, a);
    m.tg(s.tgTop - 1.2, b);
    tg.push({
      bot: new THREE.Vector3(
        a.x + s.topHalfWidth * 0.5, m.crossY + 0.1, a.z + fwd * (0.08 + f * 0.7),
      ),
      top: new THREE.Vector3(b.x + s.tgRadius + 0.06, b.y, b.z),
    });
  }

  const backstay: Member[] = [];
  for (const [hy, dz] of backstayTable(s)) {
    const src = hy > s.tgFoot ? m.tg(hy, a) : m.top(hy, a);
    const z = THREE.MathUtils.clamp(s.z + dz, -24, 25.6);
    const t = tAtZ(z);
    const st = new Station(t);
    backstay.push({
      top: new THREE.Vector3(src.x + s.topRadius + 0.08, src.y, src.z),
      bot: new THREE.Vector3(st.widthAt(sheerY(t) - 0.85) + 0.72, sheerY(t) - 0.5, z),
    });
  }

  return { lower, topmast, tg, backstay };
}

/**
 * Backstay heads, how far abaft the mast each is set up, and its radius.
 * `build/rigging.ts` draws from this table; the envelope is fitted to it.
 */
export function backstayTable(s: MastSpec): readonly (readonly [number, number, number])[] {
  return [
    [s.topmastTop - 1.6, 5.0, 0.032],
    [s.topmastTop - 2.4, 7.2, 0.03],
    [s.tgTop - 1.6, 9.4, 0.026],
  ];
}

/* ------------------------------------------------------------------ *
 *  Fitting
 * ------------------------------------------------------------------ */

interface Sample {
  x: number;
  y: number;
  z: number;
}

/** Members sampled along their length, folded to |x|. */
function sampleMembers(ms: Member[], n = 6): Sample[] {
  const out: Sample[] = [];
  for (const mem of ms) {
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      out.push({
        x: Math.abs(THREE.MathUtils.lerp(mem.bot.x, mem.top.x, t)),
        y: THREE.MathUtils.lerp(mem.bot.y, mem.top.y, t),
        z: THREE.MathUtils.lerp(mem.bot.z, mem.top.z, t),
      });
    }
  }
  return out;
}

/** Least squares of v on {1, y}. */
function fitLine(pts: Sample[], v: (s: Sample) => number): [number, number] {
  let n = 0, sy = 0, syy = 0, sv = 0, svy = 0;
  for (const p of pts) {
    n++; sy += p.y; syy += p.y * p.y; sv += v(p); svy += v(p) * p.y;
  }
  const den = n * syy - sy * sy;
  if (Math.abs(den) < 1e-9) return [sv / Math.max(n, 1), 0];
  const q = (n * svy - sy * sv) / den;
  return [(sv - q * sy) / n, q];
}

/**
 * One envelope slot from a set of members.
 *
 * `dx` — the deviation of |x| from the fitted band centre — is orthogonal to
 * {1, y} by construction, so the plane's three coefficients come out of two
 * independent fits instead of a 3x3 solve that is singular whenever the members
 * happen to run diagonally (which the lower gang does: its x is a linear
 * function of its height, so {1, |x|, y} is rank two).
 *
 * The plane is then biased forward until no member is in front of it, so the
 * limit is the whole gang's leading surface however badly the fit went.
 */
function fitSlot(pts: Sample[]): { plane: THREE.Vector4; band: THREE.Vector4 } | null {
  if (pts.length < 2) return null;
  const [p, q] = fitLine(pts, (s) => s.x);
  let sdd = 0, sdz = 0;
  for (const s of pts) {
    const d = s.x - (p + q * s.y);
    sdd += d * d;
    sdz += d * s.z;
  }
  // A gang whose members all lie at one |x| for a given height carries no
  // information about how z varies across it, so do not invent a gradient.
  const b = sdd > 0.35 ? sdz / sdd : 0;
  const [a0, c0] = fitLine(pts, (s) => s.z - b * (s.x - (p + q * s.y)));

  let bias = Infinity;
  let halfW = 0;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const s of pts) {
    const d = s.x - (p + q * s.y);
    bias = Math.min(bias, s.z - (a0 + c0 * s.y + b * d));
    halfW = Math.max(halfW, Math.abs(d));
    y0 = Math.min(y0, s.y);
    y1 = Math.max(y1, s.y);
  }
  const a = a0 + bias - RIG_MARGIN_M;
  // Fold the band centre into the plane so the shader can use |x| directly.
  return {
    plane: new THREE.Vector4(a - b * p, b, c0 - b * q, halfW + BAND_PAD_M),
    band: new THREE.Vector4(p, q, y0, y1),
  };
}

/**
 * The mast, as a slab across its own width.
 *
 * A cylinder would be more exact, but a square sail is bent to a jackstay only
 * a metre forward of the axis and bellies three times that, so what the cloth
 * needs to know is where the forward surface is — and a slab of the mast's own
 * width gives that, over all three sections at once, from the leading edge of
 * each. Without it the mainmast passed clean through the middle of its own
 * course at any useful camber; the crease this leaves down the centre of a
 * sheeted course is the mast printing through, which is what a photograph of a
 * close-hauled square rigger shows.
 */
function mastSamples(m: MastFrame): { pts: Sample[]; halfW: number } {
  const s = m.spec;
  const pts: Sample[] = [];
  let halfW = 0;
  const sect: [(y: number, o?: THREE.Vector3) => THREE.Vector3, number, number, number, number][] = [
    [m.lower, s.deckY, s.lowerTop, s.lowerRadius * 1.06, s.topRadius * 1.15],
    [m.top, s.topmastFoot, s.topmastTop, s.topRadius * 1.05, s.tgRadius * 1.25],
    [m.tg, s.tgFoot, s.tgTop, s.tgRadius * 1.05, s.tgRadius * 0.62],
  ];
  const a = new THREE.Vector3();
  for (const [axis, ya, yb, r0, r1] of sect) {
    for (let i = 0; i <= 4; i++) {
      const t = i / 4;
      const y = THREE.MathUtils.lerp(ya, yb, t);
      const r = THREE.MathUtils.lerp(r0, r1, t);
      axis(y, a);
      pts.push({ x: 0, y, z: a.z - r });
      halfW = Math.max(halfW, r);
    }
  }
  return { pts, halfW };
}

export function buildRigEnvelope(frame: RigFrame): RigEnvUniforms {
  const plane: THREE.Vector4[] = [];
  const band: THREE.Vector4[] = [];
  for (let i = 0; i < RIG_N; i++) {
    // An unused slot is a plane infinitely far aft over an empty footprint.
    plane.push(new THREE.Vector4(1e6, 0, 0, 0));
    band.push(new THREE.Vector4(0, 0, 1e6, -1e6));
  }

  for (let mi = 0; mi < frame.masts.length; mi++) {
    const m = frame.masts[mi];
    const g = mastGangs(m, channelPoints(mi));
    const sets = [g.lower, g.topmast, g.tg, g.backstay];
    for (let k = 0; k < sets.length; k++) {
      const fit = fitSlot(sampleMembers(sets[k]));
      if (!fit) continue;
      plane[mi * RIG_SLOTS + k].copy(fit.plane);
      band[mi * RIG_SLOTS + k].copy(fit.band);
    }
    const ms = mastSamples(m);
    const fit = fitSlot(ms.pts);
    if (fit) {
      fit.plane.w = ms.halfW + BAND_PAD_M;
      plane[mi * RIG_SLOTS + 4].copy(fit.plane);
      band[mi * RIG_SLOTS + 4].copy(fit.band);
    }
  }

  return { uRigPlane: { value: plane }, uRigBand: { value: band } };
}
