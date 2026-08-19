import * as THREE from 'three';
import type { IOcean, WaveSample } from '../types';
import { wetWeight, type Hull, type Hydrostatics, type MassProperties } from './Hull';
import { foilCoefficients, type Coefficients } from './Rig';
import { addForceAt, addTorque, type Pose, type Wrench } from './Wrench';
import { PRO_HYDRO, type HydroTuning } from './Assist';
import {
  CD_PANEL_NORMAL,
  CG_Y,
  CG_Z,
  CLR_DRIFT_SHIFT,
  CLR_DRIFT_SHIFT_MAX,
  CLR_Y,
  CLR_Z,
  CW_WALL_POWER,
  CY_CROSS,
  FK_GAIN,
  FORM_FACTOR,
  GRAVITY,
  HEAVE_DAMP,
  LATERAL_AREA,
  LWL,
  NU_WATER,
  PITCH_DAMP_LIN,
  PITCH_DAMP_QUAD,
  RHO_WATER,
  ROLL_DAMP_LIN,
  ROLL_DAMP_QUAD,
  RUDDER_AREA,
  RUDDER_ASPECT,
  RUDDER_CD0,
  RUDDER_CN_SEP,
  RUDDER_WAKE,
  RUDDER_Y,
  RUDDER_Z,
  WETTED_AREA,
  YAW_DAMP_QUAD,
  YAW_FROM_HEEL,
} from './constants';

/**
 * Hull hydrodynamics: the panel pressure integral, resistance, lateral force,
 * roll/pitch/yaw damping and the rudder.
 *
 * BUOYANCY. For a closed body in a hydrostatic field p = rho*g*(eta - y) the
 * divergence theorem gives the resultant exactly:
 *
 *     F = rho*g*V * yhat  -  rho*g*V * grad(eta)
 *
 * i.e. rho*g*V along the local free-surface NORMAL, since the surface normal is
 * proportional to (-deta/dx, 1, -deta/dz). So the integral is split:
 *
 *   - The world-VERTICAL part is taken panel by panel. That sum is exact for a
 *     closed surface (sum of y*ny*dA = V, and sum of x*y*ny*dA = V*x_cb), so it
 *     delivers the right displacement AND the right righting moments in roll and
 *     pitch with no fudge factor. Heave, pitch, roll and wave-following all fall
 *     out of it; nothing is scripted.
 *   - The world-HORIZONTAL part — the Froude-Krylov force that makes her surf and
 *     broach — is taken from the closed form above, per hull station, using that
 *     station's own displaced volume and its own surface slope. Per station, not
 *     per ship, because the bow and the stern sit on different parts of the wave:
 *     that difference is what pitches her and what tries to slew her broadside.
 *     FK_GAIN attenuates it for the Smith effect (wave pressure decays with
 *     depth, so a deep hull feels less slope than the surface does).
 *
 * Doing it this way means the open bow and transom of the panel set cost nothing:
 * those caps are near-vertical, so they contribute almost nothing to the vertical
 * integral, and the horizontal part never touches the panels at all. The
 * `closureX/closureZ` diagnostics in Hull.ts are therefore only reported, not
 * applied.
 *
 * Every hot loop is in the ship's BODY frame with the pose carried as nine plain
 * numbers. Nothing here allocates.
 */

/**
 * The one scratch wave sample the station loop reuses. Real `Vector3`s, not
 * plain objects: `IOcean.sample` writes them with `.set()`.
 */
function makeSample(): WaveSample {
  return {
    height: 0,
    dx: 0,
    dz: 0,
    normal: new THREE.Vector3(0, 1, 0),
    velocity: new THREE.Vector3(),
  };
}

export interface HydroReadout {
  /** Displaced volume this substep, m^3. */
  volume: number;
  /** Speed through the water in the horizontal plane, m/s. */
  waterSpeed: number;
  /** Drift (leeway) angle through the water, radians. Positive = slipping to starboard. */
  drift: number;
  /** Total axial resistance this substep, newtons. */
  resistance: number;
  /** Lateral hull force, newtons. Positive = to starboard. */
  sideForce: number;
  /** Rudder force magnitude, newtons, and its angle of attack. */
  rudderForce: number;
  rudderAlpha: number;
  /** Fraction of the hull's panels that are wetted, 0..1. */
  wetFraction: number;
}

const coeff: Coefficients = { cl: 0, cd: 0 };

export class Hydro {
  private hull!: Hull;
  private mp!: MassProperties;
  private sample: WaveSample = makeSample();

  /** Panel centroids and normals, offset to the centre of gravity. */
  private prx!: Float64Array;
  private pry!: Float64Array;
  private prz!: Float64Array;

  /** Column footprints, offset to the centre of gravity. */
  private crx!: Float64Array;
  private cry = 0;
  private crz!: Float64Array;

  /** Per-column ocean state for this substep. */
  private colH!: Float64Array;
  private colNX!: Float64Array;
  private colNY!: Float64Array;
  private colNZ!: Float64Array;
  /** Water velocity at the column, already rotated into the body frame. */
  private colVX!: Float64Array;
  private colVY!: Float64Array;
  private colVZ!: Float64Array;
  /** Vertical buoyant force accumulated per column, newtons. */
  private colF!: Float64Array;

  /** Vertical offset of the centre of buoyancy from the CG. Force application point. */
  private cbRY = 0;

  readonly out: HydroReadout = {
    volume: 0,
    waterSpeed: 0,
    drift: 0,
    resistance: 0,
    sideForce: 0,
    rudderForce: 0,
    rudderAlpha: 0,
    wetFraction: 0,
  };

  /** Test hook: pretend the sea is dead flat and still. Used by the roll-decay test. */
  flatSea = false;

  /**
   * The five hull coefficients the assist layer relaxes. `PRO_HYDRO` is
   * literally the constants, so Pro mode computes exactly what it always did;
   * ShipDynamics swaps in `ASSIST_HYDRO` when the assist is on. Everything else
   * in this file — the panel pressure integral, added mass, the friction line,
   * the damping — is read straight off `constants.ts` in both modes.
   */
  tuning: HydroTuning = PRO_HYDRO;

  init(hull: Hull, mp: MassProperties, hydrostatics: Hydrostatics): void {
    this.hull = hull;
    this.mp = mp;

    const n = hull.count;
    this.prx = new Float64Array(n);
    this.pry = new Float64Array(n);
    this.prz = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      this.prx[i] = hull.cx[i] - mp.cg.x;
      this.pry[i] = hull.cy[i] - mp.cg.y;
      this.prz[i] = hull.cz[i] - mp.cg.z;
    }

    const c = hull.columns;
    this.crx = new Float64Array(c);
    this.crz = new Float64Array(c);
    for (let i = 0; i < c; i++) {
      this.crx[i] = hull.colX[i] - mp.cg.x;
      this.crz[i] = hull.colZ[i] - mp.cg.z;
    }
    // Column footprints live on the hull-origin waterline plane, y = 0.
    this.cry = -mp.cg.y;

    this.colH = new Float64Array(c);
    this.colNX = new Float64Array(c);
    this.colNY = new Float64Array(c);
    this.colNZ = new Float64Array(c);
    this.colVX = new Float64Array(c);
    this.colVY = new Float64Array(c);
    this.colVZ = new Float64Array(c);
    this.colF = new Float64Array(c);

    // The wave-slope force acts through the centre of buoyancy, so it heels her
    // as well as pushing her — which is most of wave-induced roll.
    this.cbRY = hydrostatics.kb - hull.keelY * -1 - mp.cg.y - 0;
    this.cbRY = hydrostatics.kb + hull.keelY - mp.cg.y;
  }

  /**
   * Sample the sea under every hull station and rotate the result into the body
   * frame. One `ocean.sample()` per station, not per panel: a 100 m wave is
   * smooth over a 5 m footprint, and roll restoring is preserved exactly because
   * each panel still uses its own depth against its station's water plane.
   */
  sampleSea(ocean: IOcean | null, pose: Pose): void {
    const m = pose.m;
    const n = this.hull.columns;
    const s = this.sample;

    for (let i = 0; i < n; i++) {
      if (!ocean || this.flatSea) {
        this.colH[i] = 0;
        this.colNX[i] = 0;
        this.colNY[i] = 1;
        this.colNZ[i] = 0;
        this.colVX[i] = 0;
        this.colVY[i] = 0;
        this.colVZ[i] = 0;
        continue;
      }
      const rx = this.crx[i];
      const ry = this.cry;
      const rz = this.crz[i];
      const wx = pose.x + m[0] * rx + m[1] * ry + m[2] * rz;
      const wz = pose.z + m[6] * rx + m[7] * ry + m[8] * rz;
      ocean.sample(wx, wz, s);
      this.colH[i] = s.height;
      this.colNX[i] = s.normal.x;
      this.colNY[i] = s.normal.y;
      this.colNZ[i] = s.normal.z;
      // World -> body is the transpose of the body -> world matrix.
      const vx = s.velocity.x;
      const vy = s.velocity.y;
      const vz = s.velocity.z;
      this.colVX[i] = m[0] * vx + m[3] * vy + m[6] * vz;
      this.colVY[i] = m[1] * vx + m[4] * vy + m[7] * vz;
      this.colVZ[i] = m[2] * vx + m[5] * vy + m[8] * vz;
    }
  }

  /**
   * Panel buoyancy plus per-panel normal drag, accumulated into `out`.
   * `vb`/`wb` are the body-frame linear and angular velocity of the CG.
   */
  buoyancy(
    pose: Pose,
    vbx: number,
    vby: number,
    vbz: number,
    wbx: number,
    wby: number,
    wbz: number,
    out: Wrench,
  ): void {
    const hull = this.hull;
    const m = pose.m;
    const colF = this.colF;
    for (let i = 0; i < hull.columns; i++) colF[i] = 0;

    // World-vertical unit vector in BODY components. world = M * body, so
    // body = M^T * world, and M^T * (0,1,0) is M's second ROW: (m3, m4, m5).
    // Using the second column instead mirrors the force athwartships and adds
    // several times the real roll stiffness — it costs a 4 s roll period.
    const uy0 = m[3];
    const uy1 = m[4];
    const uy2 = m[5];

    const rhog = RHO_WATER * GRAVITY;
    const kDrag = 0.5 * RHO_WATER * CD_PANEL_NORMAL;
    let wet = 0;
    let force = 0;

    for (let i = 0; i < hull.count; i++) {
      const rx = this.prx[i];
      const ry = this.pry[i];
      const rz = this.prz[i];
      const col = hull.column[i];

      // World height of the panel centroid, and its depth below this station's
      // water plane.
      const py = pose.y + m[3] * rx + m[4] * ry + m[5] * rz;
      const d = this.colH[col] - py;
      const h = hull.half[i];
      if (d <= -h) continue;

      const w = wetWeight(d, h);
      const nx = hull.nx[i];
      const ny = hull.ny[i];
      const nz = hull.nz[i];
      const area = hull.area[i];

      if (w > 0) {
        // World Y component of the outward normal.
        const nyW = m[3] * nx + m[4] * ny + m[5] * nz;
        const fy = -rhog * w * area * nyW;
        addForceAt(out, uy0 * fy, uy1 * fy, uy2 * fy, rx, ry, rz);
        colF[col] += fy;
        force += fy;
      }

      // Normal drag on the wetted part. This is where roughly half the roll and
      // heave damping comes from, and it is what makes a wave slapping the
      // weather bilge actually start her rolling.
      const frac = d >= h ? 1 : (d + h) / (2 * h);
      wet += frac;
      const vpx = vbx + (wby * rz - wbz * ry) - this.colVX[col];
      const vpy = vby + (wbz * rx - wbx * rz) - this.colVY[col];
      const vpz = vbz + (wbx * ry - wby * rx) - this.colVZ[col];
      const vn = vpx * nx + vpy * ny + vpz * nz;
      const k = -kDrag * area * frac * Math.abs(vn) * vn;
      addForceAt(out, k * nx, k * ny, k * nz, rx, ry, rz);
    }

    this.out.volume = force / rhog;
    this.out.wetFraction = wet / hull.count;

    // Froude-Krylov: rho*g*V along the free-surface normal, station by station.
    for (let i = 0; i < hull.columns; i++) {
      const f = colF[i];
      if (f <= 0) continue;
      const ny = this.colNY[i] < 0.2 ? 0.2 : this.colNY[i];
      const k = (FK_GAIN * f) / ny;
      const hx = k * this.colNX[i];
      const hz = k * this.colNZ[i];
      // Rotate the world-horizontal force into the body frame.
      const bx = m[0] * hx + m[6] * hz;
      const by = m[1] * hx + m[7] * hz;
      const bz = m[2] * hx + m[8] * hz;
      addForceAt(out, bx, by, bz, this.crx[i], this.cbRY, this.crz[i]);
    }
  }

  /**
   * Resistance, lateral force, rudder and the rotational damping terms.
   *
   * RESISTANCE is ITTC-57 friction on a form factor plus a wave-making term with
   * a pole just above the documented 13 kn top speed, so the last knot costs an
   * order of magnitude more than the one before it and the ship genuinely runs
   * into a wall. Drift adds resistance on top: sailing sideways is expensive,
   * which is the mechanism that punishes pinching.
   *
   * LATERAL FORCE is the standard low-aspect cross-flow model: a circulatory
   * term that grows with sin(2*beta)/2 and a separated term that grows with
   * sin(beta)|sin(beta)|, both normal to the centreline. Because the force scales
   * with speed squared while the sail plan's side force does not, leeway is small
   * when she is going well and very large when she is not — which is exactly why
   * a square-rigger cannot pinch, and why the no-go zone emerges instead of being
   * clamped.
   *
   * The RUDDER is the same thin-foil model as a sail, with water density and its
   * own aspect ratio. Its force scales with the square of the water speed, so it
   * is soft when she is slow and does literally nothing when she is stopped, and
   * it stalls past ~21 deg.
   */
  forces(
    pose: Pose,
    vbx: number,
    vby: number,
    vbz: number,
    wbx: number,
    wby: number,
    wbz: number,
    heel: number,
    rudder: number,
    dt: number,
    out: Wrench,
  ): void {
    // Mean water velocity under the hull, body frame. Averaging the stations
    // keeps a short wave from making the whole ship think it is in a current.
    const n = this.hull.columns;
    let wvx = 0;
    let wvy = 0;
    let wvz = 0;
    for (let i = 0; i < n; i++) {
      wvx += this.colVX[i];
      wvy += this.colVY[i];
      wvz += this.colVZ[i];
    }
    wvx /= n;
    wvy /= n;
    wvz /= n;

    const vrx = vbx - wvx;
    const vry = vby - wvy;
    const vrz = vbz - wvz;

    // Axial (forward) and lateral components of the water-relative velocity.
    const u = -vrz;
    const v = vrx;
    const U = Math.hypot(u, v);
    this.out.waterSpeed = U;

    const drift = U > 0.05 ? Math.atan2(v, Math.abs(u) < 1e-6 ? 1e-6 : u) : 0;
    this.out.drift = drift;

    const q = 0.5 * RHO_WATER * U * U;
    const sb = Math.sin(drift);
    const cb = Math.cos(drift);

    /* --- axial resistance ------------------------------------------------ */
    let resistance = 0;
    if (U > 0.02) {
      const re = (U * LWL) / NU_WATER;
      const cf = re > 1e4 ? 0.075 / Math.pow(Math.log10(re) - 2, 2) : 0.01;
      const fn = U / Math.sqrt(GRAVITY * LWL);
      // The pole is real but must stay finite: clamp the denominator so the wall
      // is a wall rather than a division by zero.
      const r = Math.min(fn / this.tuning.fnWall, 0.9995);
      const den = Math.max(1 - Math.pow(r, CW_WALL_POWER), 0.02);
      const cw = (this.tuning.cwBase * fn * fn * fn * fn) / den;
      resistance = q * WETTED_AREA * (cf * FORM_FACTOR + cw);
      // Sailing sideways drags a much bigger hole through the water.
      resistance *= 1 + this.tuning.driftResistanceGain * sb * sb;

      // Guard: never let one substep reverse the flow it is opposing.
      const cap = (0.9 * this.mp.mBody.z * U) / dt;
      if (resistance > cap) resistance = cap;
    }
    this.out.resistance = resistance;
    // Retarding force along the flow, applied at the centre of buoyancy so that
    // driving hard also squats the bow, as it should.
    if (U > 1e-4) {
      const dx = -vrx / U;
      const dz = -vrz / U;
      addForceAt(out, resistance * dx, 0, resistance * dz, 0, this.cbRY, 0);
    }

    /* --- lateral force --------------------------------------------------- */
    const cn = this.tuning.cyLift * sb * cb + CY_CROSS * sb * Math.abs(sb);
    const side = -q * LATERAL_AREA * cn;
    this.out.sideForce = side;
    // The centre of lateral pressure walks forward as the drift angle grows: the
    // circulation is shed off the leading edge. Half of weather helm lives here.
    const shift = Math.min(CLR_DRIFT_SHIFT * Math.abs(drift), CLR_DRIFT_SHIFT_MAX);
    const clrZ = CLR_Z - shift;
    addForceAt(out, side, 0, 0, 0, CLR_Y - this.mp.cg.y, clrZ - this.mp.cg.z);

    // A heeled hull is asymmetric — immersed lee bow, emerged weather quarter —
    // and carves to windward. The other half of weather helm.
    addTorque(out, 0, YAW_FROM_HEEL * heel * U * U, 0);

    /* --- rotational and heave damping ------------------------------------ */
    addTorque(
      out,
      -(PITCH_DAMP_LIN * wbx + PITCH_DAMP_QUAD * Math.abs(wbx) * wbx),
      -(this.tuning.yawDampLin * U * wby + YAW_DAMP_QUAD * Math.abs(wby) * wby),
      -(ROLL_DAMP_LIN * wbz + ROLL_DAMP_QUAD * Math.abs(wbz) * wbz),
    );
    // Wave-radiation damping in heave, on top of the per-panel normal drag.
    const m = pose.m;
    const vWorldY = m[3] * vrx + m[4] * vry + m[5] * vrz;
    const fy = -HEAVE_DAMP * vWorldY;
    addForceAt(out, m[3] * fy, m[4] * fy, m[5] * fy, 0, 0, 0);

    /* --- rudder ---------------------------------------------------------- */
    const rrx = -this.mp.cg.x;
    const rry = RUDDER_Y - this.mp.cg.y;
    const rrz = RUDDER_Z - this.mp.cg.z;
    // Inflow at the blade includes the yaw rate: that is what makes a turn
    // self-limiting without any extra term.
    const rvx = (vrx + (wby * rrz - wbz * rry)) * RUDDER_WAKE;
    const rvz = (vrz + (wbx * rry - wby * rrx)) * RUDDER_WAKE;
    const rv2 = rvx * rvx + rvz * rvz;
    if (rv2 > 1e-4) {
      const rv = Math.sqrt(rv2);
      // Direction the water travels past the blade.
      const fx = -rvx / rv;
      const fz = -rvz / rv;
      // Blade normal: athwartships when amidships, rotated by the rudder angle.
      const nx = Math.cos(rudder);
      const nz = -Math.sin(rudder);
      let dot = fx * nx + fz * nz;
      if (dot > 1) dot = 1;
      else if (dot < -1) dot = -1;
      const alpha = Math.asin(Math.abs(dot));
      this.out.rudderAlpha = alpha;

      foilCoefficients(alpha, RUDDER_ASPECT, 0, RUDDER_CN_SEP, RUDDER_CD0, coeff);

      let lx = nx - dot * fx;
      let lz = nz - dot * fz;
      const ll = Math.hypot(lx, lz);
      if (ll > 1e-5) {
        lx /= ll;
        lz /= ll;
      } else {
        lx = 0;
        lz = 0;
      }
      const sgn = dot >= 0 ? 1 : -1;
      const qr = 0.5 * RHO_WATER * rv2 * RUDDER_AREA;
      const rfx = qr * (coeff.cl * sgn * lx + coeff.cd * fx);
      const rfz = qr * (coeff.cl * sgn * lz + coeff.cd * fz);
      this.out.rudderForce = Math.hypot(rfx, rfz);
      addForceAt(out, rfx, 0, rfz, rrx, rry, rrz);
    } else {
      this.out.rudderForce = 0;
      this.out.rudderAlpha = 0;
    }
  }

  /** World height of the sea under a body-frame point, for bow-slam bookkeeping. */
  seaHeightAt(column: number): number {
    return this.colH[column];
  }
}

/** Suppress unused-import complaints for values kept only for documentation. */
void CG_Y;
void CG_Z;
