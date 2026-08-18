import type { Environment, SailState } from '../types';
import { clamp01, smoothstep } from '../util/math';
import {
  CG_Y,
  CG_Z,
  RHO_AIR,
  SHEET_GAIN,
  WINDAGE_CD,
  WINDAGE_FRONTAL,
  WINDAGE_LATERAL,
  WINDAGE_Y,
  WIND_REF_HEIGHT,
  WIND_SHEAR_ALPHA,
} from './constants';
import {
  LUFF_COLLAPSE_RATE,
  LUFF_FILL_RATE,
  geometryFor,
  luffTarget,
  sailCoefficients,
  type Coefficients,
} from './Rig';
import { addForceAt, bodyToWorldY, type Pose, type Wrench } from './Wrench';

/**
 * Per-sail aerodynamics.
 *
 * Every sail is solved on its own: its own height in the boundary layer, its
 * own apparent wind (including the velocity the mast head has from the ship's
 * roll and yaw, which is most of the rig's roll damping), its own angle of
 * attack against its own chord, its own stall, and its own share of the wake of
 * everything upwind of it. The total is a force and a centre of effort tens of
 * metres above the centre of lateral resistance, and the couple between them is
 * where heel and weather helm come from. Nothing here is scripted; if you brace
 * the yards wrong the ship stops.
 *
 * Everything is computed in the ship's body frame. Both square sails and
 * fore-and-aft sails have a vertical span and a horizontal chord, so the 2D
 * section of every sail on this ship lies in the body XZ plane — which is why
 * the apparent wind is flattened into that plane and why a heeled rig loses
 * drive by cos(heel) without any special case.
 */

/** Fraction of the wind a fully blanketed sail loses. */
const BLANKET_MAX = 0.82;
/** How far a wake persists, in multiples of the blanketing sail's width. */
const WAKE_LENGTH = 2.6;
/** Dynamic pressure at which the cloth is fully bellied, Pa. */
const CAMBER_FULL_Q = 110;

interface SailRec {
  /** Centre of effort relative to the CG, body frame. */
  rx: number;
  ry: number;
  rz: number;
  hoist: number;
  chord: number;
  ar: number;
  triangular: boolean;
  /** Sail normal in the body XZ plane, updated from `brace` each substep. */
  nx: number;
  nz: number;
  /** Last angle of attack, radians — feeds the wake width. */
  alpha: number;
  /** Along-wind ordinate used to sort the wake, metres. */
  along: number;
  /** Wind multiplier from blanketing, 0..1. */
  exposure: number;
}

const coeff: Coefficients = { cl: 0, cd: 0 };

export class RigAero {
  private rec: SailRec[] = [];
  /** Reference apparent wind in the body XZ plane, direction of travel. */
  refX = 0;
  refZ = 1;
  refSpeed = 0;
  /** Sum of |force| this substep, newtons, and the area actually drawing. */
  totalForce = 0;
  drawingArea = 0;

  init(sails: SailState[]): void {
    this.rec = sails.map((s) => {
      const g = geometryFor(s);
      return {
        rx: 0,
        ry: g.y - CG_Y,
        rz: g.z - CG_Z,
        hoist: g.hoist,
        chord: g.chord,
        ar: g.ar,
        triangular: s.triangular,
        nx: 0,
        nz: 1,
        alpha: 0,
        along: 0,
        exposure: 1,
      };
    });
  }

  /** True wind speed at height `h` above the sea, power-law boundary layer. */
  static windAt(v10: number, h: number): number {
    return v10 * Math.pow(Math.max(h, 2) / WIND_REF_HEIGHT, WIND_SHEAR_ALPHA);
  }

  /**
   * Sail normal in the body XZ plane. The ship module rotates a yard about +Y
   * by `brace`, and a boom by `brace * SHEET_GAIN`; physics must use exactly the
   * same angle or the cloth points one way and the force goes the other.
   */
  private setNormal(rec: SailRec, sail: SailState): void {
    if (rec.triangular) {
      const s = sail.brace * SHEET_GAIN;
      // Chord runs tack-to-clew: (sin s, 0, cos s). Normal is athwartships.
      rec.nx = Math.cos(s);
      rec.nz = -Math.sin(s);
    } else {
      const b = sail.brace;
      rec.nx = Math.sin(b);
      rec.nz = Math.cos(b);
    }
  }

  /**
   * Wake shadowing. A sail loses wind when another sail sits between it and the
   * breeze: the fore course is blanketed by the main when running dead before
   * the wind, which is exactly why a square-rigger is faster on a broad reach
   * than square-on. O(n^2) over 16 sails, which is nothing.
   */
  private blanket(sails: SailState[]): void {
    const rec = this.rec;
    const wx = this.refX;
    const wz = this.refZ;
    for (let i = 0; i < rec.length; i++) {
      rec[i].along = rec[i].rx * wx + rec[i].rz * wz;
      rec[i].exposure = 1;
    }
    for (let j = 0; j < rec.length; j++) {
      const b = rec[j];
      let shade = 0;
      for (let i = 0; i < rec.length; i++) {
        if (i === j) continue;
        const a = rec[i];
        const along = b.along - a.along;
        if (along <= 0.5) continue;
        const strength = sails[i].set * (0.35 + 0.65 * (1 - sails[i].luff));
        if (strength < 0.05) continue;

        // Wake half-width: how much sky the blanketing sail actually covers.
        const wa = a.chord * (0.3 + 0.7 * Math.abs(Math.sin(a.alpha)));
        const wb = b.chord * (0.3 + 0.7 * Math.abs(Math.sin(b.alpha)));
        const dxs = b.rx - a.rx;
        const dzs = b.rz - a.rz;
        // Component across the wind, in the horizontal plane.
        const lateral = Math.abs(dxs * wz - dzs * wx);
        const lat = 1 - clamp01(lateral / (0.5 * (wa + wb) + 1));

        const dy = Math.abs(a.ry - b.ry);
        const vert = 1 - clamp01(dy / (0.5 * (a.hoist + b.hoist) + 1));

        const decay = Math.exp(-along / (WAKE_LENGTH * wa + 8));
        shade += strength * lat * vert * decay;
      }
      b.exposure = 1 - BLANKET_MAX * clamp01(shade);
    }
  }

  /**
   * Solve the whole rig for one substep and accumulate into `out`.
   * `vb`/`wb` are the body-frame linear and angular velocity of the CG.
   */
  solve(
    sails: SailState[],
    env: Environment,
    pose: Pose,
    vbx: number,
    vby: number,
    vbz: number,
    wbx: number,
    wby: number,
    wbz: number,
    dt: number,
    out: Wrench,
  ): void {
    const m = pose.m;
    const v10 = env.windSpeed * env.gust;
    // True wind travel direction rotated into the body frame (transpose of M).
    const wvx = env.windVector.x;
    const wvy = env.windVector.y;
    const wvz = env.windVector.z;
    const wdx = m[0] * wvx + m[3] * wvy + m[6] * wvz;
    const wdz = m[2] * wvx + m[5] * wvy + m[8] * wvz;

    // Reference apparent wind at mid-rig height, used for trim and blanketing.
    const vRef = RigAero.windAt(v10, Math.max(2, pose.y + 30));
    let rx = wdx * vRef - vbx;
    let rz = wdz * vRef - vbz;
    const rlen = Math.hypot(rx, rz);
    if (rlen > 1e-4) {
      rx /= rlen;
      rz /= rlen;
    } else {
      rx = 0;
      rz = 1;
    }
    this.refX = rx;
    this.refZ = rz;
    this.refSpeed = rlen;

    this.blanket(sails);

    let total = 0;
    let drawing = 0;

    for (let i = 0; i < sails.length; i++) {
      const sail = sails[i];
      const rec = this.rec[i];
      this.setNormal(rec, sail);

      if (sail.set < 0.02) {
        sail.force = 0;
        sail.luff = sail.luff + (0 - sail.luff) * (1 - Math.exp(-4 * dt));
        sail.camber += (0 - sail.camber) * (1 - Math.exp(-4 * dt));
        continue;
      }

      // Height of this sail's centre of effort above the sea.
      const h = pose.y + bodyToWorldY(pose, rec.rx, rec.ry, rec.rz);
      const vw = RigAero.windAt(v10, h) * rec.exposure;

      // Velocity of the sail's centre of effort: the mast head sweeps fast when
      // she rolls, and that sweep is most of the rig's roll damping.
      const vpx = vbx + (wby * rec.rz - wbz * rec.ry);
      const vpz = vbz + (wbx * rec.ry - wby * rec.rx);

      const awx = wdx * vw - vpx;
      const awz = wdz * vw - vpz;
      const aw2 = awx * awx + awz * awz;
      if (aw2 < 1e-5) {
        sail.force = 0;
        continue;
      }
      const aw = Math.sqrt(aw2);
      const uwx = awx / aw;
      const uwz = awz / aw;

      // sin(alpha) is the wind's component along the sail normal.
      let dot = uwx * rec.nx + uwz * rec.nz;
      if (dot > 1) dot = 1;
      else if (dot < -1) dot = -1;
      const alpha = Math.asin(Math.abs(dot));
      rec.alpha = alpha;

      sailCoefficients(alpha, rec.ar, rec.triangular, coeff);

      // Lift acts across the flow, from the pressure face to the suction face.
      let lx = rec.nx - dot * uwx;
      let lz = rec.nz - dot * uwz;
      const ll = Math.hypot(lx, lz);
      if (ll > 1e-5) {
        lx /= ll;
        lz /= ll;
      } else {
        lx = 0;
        lz = 0;
      }
      const sgn = dot >= 0 ? 1 : -1;

      const press = 0.5 * RHO_AIR * aw2;
      const q = press * sail.area * sail.set;
      const fx = q * (coeff.cl * sgn * lx + coeff.cd * uwx);
      const fz = q * (coeff.cl * sgn * lz + coeff.cd * uwz);
      addForceAt(out, fx, 0, fz, rec.rx, rec.ry, rec.rz);

      const mag = Math.hypot(fx, fz);
      sail.force = mag;
      total += mag;

      // Luff, with hysteresis: a shivering sail needs more incidence to fill
      // than a drawing one needs to collapse. Drives cloth and audio, so it has
      // to move smoothly and for a physical reason.
      const lt = luffTarget(alpha, sail.luff);
      const rate = lt > sail.luff ? LUFF_COLLAPSE_RATE : LUFF_FILL_RATE;
      sail.luff += (lt - sail.luff) * (1 - Math.exp(-rate * dt));

      const fill = smoothstep(0, CAMBER_FULL_Q, press) * (1 - sail.luff);
      const camberTarget = sgn * (0.05 + 0.35 * fill) * sail.set;
      sail.camber += (camberTarget - sail.camber) * (1 - Math.exp(-5 * dt));

      drawing += sail.area * sail.set * (1 - sail.luff);
    }

    this.totalForce = total;
    this.drawingArea = drawing;

    // Windage of hull, masts, yards and furled canvas. In a gale under bare
    // poles this is the only thing driving her, and it is not small.
    const hw = RigAero.windAt(v10, WINDAGE_Y);
    const gx = wdx * hw - vbx;
    const gz = wdz * hw - vbz;
    const gs = Math.hypot(gx, gz);
    if (gs > 1e-4) {
      const k = 0.5 * RHO_AIR * WINDAGE_CD * gs;
      addForceAt(
        out,
        k * WINDAGE_LATERAL * gx,
        0,
        k * WINDAGE_FRONTAL * gz,
        0,
        WINDAGE_Y - CG_Y,
        -CG_Z,
      );
    }
  }
}
