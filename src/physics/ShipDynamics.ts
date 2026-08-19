import * as THREE from 'three';
import type { Module, World } from '../types';
import { DEG, RAD, angleDelta, damp, fromKnots, toKnots, wrapPi } from '../util/math';
import { RigAero } from './Aero';
import {
  integrateRotation,
  orthonormalize,
  poseHeading,
  poseHeel,
  posePitch,
  poseToQuaternion,
  setPoseHeading,
} from './Body';
import {
  Assist,
  ASSIST_HELM_KD,
  ASSIST_HELM_KP,
  ASSIST_HYDRO,
  ASSIST_RUDDER_SLEW_TIME,
  ASSIST_TOP_SPEED_KNOTS,
  PRO_HYDRO,
} from './Assist';
import { Hydro } from './Hydro';
import {
  buildHull,
  buildMassProperties,
  measureHydrostatics,
  type Hull,
  type Hydrostatics,
  type MassProperties,
} from './Hull';
import { SailTrim } from './Trim';
import { clearWrench, createPose, createWrench, type Pose, type Wrench } from './Wrench';
import {
  BEAM,
  DRAUGHT,
  GRAVITY,
  HELM_KD,
  HELM_KP,
  LWL,
  MASS,
  MAX_SUB_STEPS,
  ORIGIN_SHIFT_RADIUS,
  RUDDER_MAX,
  RUDDER_SLEW_TIME,
  SUB_STEP,
} from './constants';

/**
 * Six-degree-of-freedom ship solver.
 *
 * There is no scripted motion anywhere in this file. The ship is a rigid body
 * with anisotropic added mass; every force on it is computed from geometry and
 * the state of the air and water:
 *
 *   buoyancy    140 hull panels, each integrating rho*g against its own depth
 *               below its own station's wave surface. Heave, pitch, roll, the
 *               righting moments and wave-following all fall out of that sum.
 *   aero        16 sails, each with its own height in the wind's boundary
 *               layer, its own apparent wind including the sweep of the mast
 *               head, its own stall, and its own share of the wake of whatever
 *               is upwind of it. Heel and weather helm are the couple between
 *               the resulting centre of effort, 25 m up, and the centre of
 *               lateral resistance, 3 m down.
 *   hydro       ITTC friction plus a wave-making term with a pole just above
 *               13 kn, low-aspect lateral force (leeway), nonlinear roll and
 *               yaw damping, and the rudder as a real stalling foil.
 *
 * INTEGRATION. Semi-implicit Euler on a fixed 1/120 s substep with an
 * accumulator, so 30 fps and 240 fps produce the same ship. Linear and angular
 * momentum are carried in the BODY frame — added mass is direction-dependent,
 * a hull shoves aside its own displacement again to move sideways but almost
 * nothing to move ahead — with the full transport terms
 * `M dv/dt = F - w x (Mv)` and `I dw/dt = T - w x (Iw)` so a turn behaves
 * correctly instead of gaining energy.
 *
 * Hull discretisation comes from the AGENTS.md dimensions, not from
 * `world.ext.ship.hullPoints`: that handle is a bare point cloud with no
 * normals, areas or topology, and a pressure integral needs all three. See the
 * note at the top of `Hull.ts`.
 *
 * Measured behaviour is in the comment block above `measureHydrostatics` in
 * Hull.ts and in `scripts/physics-test.mjs`, which asserts all of it.
 */

/** Shape published on `world.ext.physics`. Diagnostics and test hooks only. */
export interface PhysicsExt {
  /** Hydrostatics measured off the panel set at init. */
  readonly hydrostatics: Hydrostatics;
  /** Panel count actually built. */
  readonly panels: number;
  /** Sail area currently drawing, m^2, and the total force on the rig, N. */
  readonly rigForce: number;
  /** Speed through the water, m/s, and the drift angle that goes with it. */
  readonly waterSpeed: number;
  readonly resistance: number;
  readonly rudderForce: number;
  /** Displaced volume this instant, m^3 — should hover near 2146. */
  readonly volume: number;
  /** Canvas set, in units of sails, 0..16. */
  sailLevel: number;
  /** Freeze the sea flat and still. Test hook: isolates the ship from the ocean. */
  flatSea: boolean;
  /**
   * Handling mode. TRUE (the default) is the assist layer; FALSE is Pro, the
   * bare measured solver. Writing this also writes `world.settings.assist`, so
   * the UI can toggle either one and both agree. Safe to flip at any time.
   */
  assist: boolean;
  /** Canvas the player has ordered, 0..1. What the up/down arrows move. */
  readonly throttle: number;
  /** Assist speed ceiling on a beam reach in a 10 m/s breeze, knots. */
  readonly assistTopKnots: number;
  /** Assist forward force and yaw moment applied last substep, N and N*m. 0 in Pro. */
  readonly assistDrive: number;
  readonly assistTurn: number;
  /** Put her on a bearing at a given speed, upright and at rest otherwise. */
  reset(headingDeg: number, knots: number, heelDeg?: number): void;
  /**
   * Advance the solver alone, without rendering, at a fixed frame delta. This
   * is how `physics-test.mjs` gets deterministic answers: nothing else in the
   * engine ticks, so the only variable is the frame rate being simulated.
   * Returns a per-frame trace when `record` is set.
   */
  run(seconds: number, frameDt: number, record?: boolean): PhysicsTrace[];
}

export interface PhysicsTrace {
  t: number;
  knots: number;
  heelDeg: number;
  pitchDeg: number;
  headingDeg: number;
  leewayDeg: number;
  twaDeg: number;
  /** Velocity made good toward the wind's source, knots. Negative = losing. */
  vmgKnots: number;
  rudderDeg: number;
  bowSlam: number;
  sailArea: number;
}

export class ShipDynamics implements Module {
  readonly name = 'physics';

  private hull!: Hull;
  private mp!: MassProperties;
  private hs!: Hydrostatics;
  private readonly hydro = new Hydro();
  private readonly aero = new RigAero();
  private readonly trim = new SailTrim();

  private readonly pose: Pose = createPose();
  private readonly wrench: Wrench = createWrench();

  /** Body-frame linear velocity of the centre of gravity, m/s. */
  private vbx = 0;
  private vby = 0;
  private vbz = 0;
  /** Body-frame angular velocity: x = pitch rate, y = yaw rate, z = roll rate. */
  private wbx = 0;
  private wby = 0;
  private wbz = 0;

  private accumulator = 0;
  private bowSlam = 0;
  private rudder = 0;
  /** Net forward force from the rig last substep, N. Feeds `inIrons`. */
  private aeroThrust = 0;
  /** Latched so `inIrons` cannot chatter as she swings through the wind. */
  private ironsLatch = false;
  /** Course the man on the wheel is holding, radians. */
  private helmCourse = 0;

  /** The arcade handling layer. See `Assist.ts`; ON by default. */
  private readonly assistLayer = new Assist();
  private assistOn = false;

  /** Body offset of the stem at deck level, for the bow-slam accelerometer. */
  private bowRX = 0;
  private bowRY = 0;
  private bowRZ = 0;

  private world!: World;
  private ext!: PhysicsExt;
  private trace: PhysicsTrace[] = [];

  init(world: World): void {
    this.world = world;
    this.hull = buildHull();
    this.mp = buildMassProperties();
    this.hs = measureHydrostatics(this.hull, this.mp);
    this.hydro.init(this.hull, this.mp, this.hs);
    this.aero.init(world.ship.sails);
    this.trim.init(world.ship.sails);

    this.bowRX = -this.mp.cg.x;
    this.bowRY = -this.mp.cg.y;
    this.bowRZ = this.hull.bowZ - this.mp.cg.z;

    const ship = world.ship;
    ship.mass = MASS;
    ship.loa = LWL;
    ship.beam = BEAM;
    ship.draught = DRAUGHT;

    // Start on a beam reach rather than wherever the default heading happens to
    // fall relative to the day's wind: at 60 deg off the bow a square-rigger is
    // inside her no-go zone and would sit there luffing.
    const heading = wrapPi(world.env.windBearing + 95 * DEG);
    // With way on. The voyage does not start from a dead stop off a mooring:
    // from rest a square-rigger sags bodily to leeward before she gathers way,
    // and starting there means the first thing the player sees is a ship in
    // irons.
    this.place(heading, 5, 0);
    this.helmCourse = heading;
    this.setAssist(world.settings.assist !== false);
    this.publish(world);

    // A 2200 t hull needs minutes to reach terminal speed, and the capture
    // harness only waits a few seconds, so settle the solver here on a flat sea
    // and again whenever the harness changes the weather. Without this every
    // screenshot is of a ship that has just been dropped in the water.
    this.settle(world, 90);
    world.bus.on('capture:scene', () => this.settle(world, 60));

    const self = this;
    this.ext = {
      hydrostatics: this.hs,
      panels: this.hull.count,
      get rigForce() {
        return self.aero.totalForce;
      },
      get waterSpeed() {
        return self.hydro.out.waterSpeed;
      },
      get resistance() {
        return self.hydro.out.resistance;
      },
      get rudderForce() {
        return self.hydro.out.rudderForce;
      },
      get volume() {
        return self.hydro.out.volume;
      },
      get sailLevel() {
        return self.trim.level;
      },
      set sailLevel(v: number) {
        self.trim.level = v;
      },
      get flatSea() {
        return self.hydro.flatSea;
      },
      set flatSea(v: boolean) {
        self.hydro.flatSea = v;
      },
      get assist() {
        return self.assistOn;
      },
      set assist(v: boolean) {
        self.setAssist(v);
        self.world.settings.assist = v;
      },
      get throttle() {
        return self.trim.ordered / Math.max(1, self.world.ship.sails.length);
      },
      assistTopKnots: ASSIST_TOP_SPEED_KNOTS,
      get assistDrive() {
        return self.assistOn ? self.assistLayer.drive : 0;
      },
      get assistTurn() {
        return self.assistOn ? self.assistLayer.turn : 0;
      },
      reset: (h, kn, heel) => this.reset(h, kn, heel ?? 0),
      run: (s, dt, rec) => this.run(s, dt, rec ?? false),
    };
    world.ext.physics = this.ext;

    if (world.settings.debug) {
      const h = this.hs;
      console.info(
        `[physics] ${this.hull.count} panels  float ${h.floatY.toFixed(3)} m  ` +
          `V ${h.volume.toFixed(0)} m^3  KB ${h.kb.toFixed(2)}  BM ${h.bm.toFixed(2)}  ` +
          `GM ${h.gm.toFixed(2)}  roll ${h.rollPeriod.toFixed(1)} s  ` +
          `GZ ${h.gz.map((g) => g.toFixed(2)).join('/')}`,
      );
    }
  }

  update(world: World): void {
    const t0 = performance.now();
    // The mode is a setting, so the UI toggle needs no access to physics at all.
    // Deliberately here and not in `tick()`: `run()` is a measurement hook and
    // must keep whatever mode the caller asked for.
    if (world.settings.assist !== this.assistOn) this.setAssist(world.settings.assist);
    this.tick(world, world.time.dt);
    world.stats['physics:ms'] = performance.now() - t0;
  }

  applySettings(world: World): void {
    this.setAssist(world.settings.assist !== false);
  }

  /* ------------------------------------------------------------------ *
   *  frame
   * ------------------------------------------------------------------ */

  private tick(world: World, dt: number): void {
    if (!(dt > 0)) return;

    this.controls(world, dt);

    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= SUB_STEP && steps < MAX_SUB_STEPS) {
      this.step(world, SUB_STEP);
      this.accumulator -= SUB_STEP;
      steps++;
    }
    // A stall longer than MAX_SUB_STEPS * SUB_STEP is dropped rather than paid
    // back; catching up would only make the next frame worse.
    if (steps >= MAX_SUB_STEPS) this.accumulator = 0;
    world.stats['physics:substeps'] = steps;

    this.publish(world);
    this.shiftOrigin(world);
  }

  /** Wheel, canvas and yards. Real-time rate limited, never per substep. */
  private controls(world: World, dt: number): void {
    const { ship, input } = world;

    // The wheel. `input.steer` is rudder, directly. With no hand on it the
    // quartermaster holds the ordered course instead of letting her round up —
    // see HELM_KP in constants.ts for why that is not cheating.
    const steer = THREE.MathUtils.clamp(input.steer, -1, 1);
    const assist = this.assistOn;
    let cmd: number;
    if (Math.abs(steer) > 0.02) {
      cmd = steer;
      this.helmCourse = ship.heading;
    } else {
      // heading rate is -wby, so the derivative term adds wby.
      cmd = THREE.MathUtils.clamp(
        (assist ? ASSIST_HELM_KP : HELM_KP) * angleDelta(ship.heading, this.helmCourse) +
          (assist ? ASSIST_HELM_KD : HELM_KD) * this.wby,
        -1,
        1,
      );
    }
    const target = cmd * RUDDER_MAX;
    ship.rudderTarget = target;
    const slew =
      (RUDDER_MAX / (assist ? ASSIST_RUDDER_SLEW_TIME : RUDDER_SLEW_TIME)) * dt;
    const d = target - this.rudder;
    this.rudder = Math.abs(d) <= slew ? target : this.rudder + Math.sign(d) * slew;
    ship.rudder = this.rudder;

    this.trim.update(
      ship.sails,
      input,
      this.aero.refX,
      this.aero.refZ,
      this.aero.refSpeed,
      poseHeel(this.pose),
      this.rudder / RUDDER_MAX,
      this.wby,
      dt,
    );
  }

  /* ------------------------------------------------------------------ *
   *  one substep
   * ------------------------------------------------------------------ */

  private step(world: World, h: number): void {
    const pose = this.pose;
    const m = pose.m;
    const w = this.wrench;
    clearWrench(w);

    this.hydro.sampleSea(world.ocean, pose);

    // Weight, at the centre of gravity so it produces no torque by definition.
    // World-vertical in body components is M's second row (see Body.ts).
    const fg = -MASS * GRAVITY;
    w.fx += m[3] * fg;
    w.fy += m[4] * fg;
    w.fz += m[5] * fg;

    this.hydro.buoyancy(pose, this.vbx, this.vby, this.vbz, this.wbx, this.wby, this.wbz, w);
    this.hydro.forces(
      pose,
      this.vbx,
      this.vby,
      this.vbz,
      this.wbx,
      this.wby,
      this.wbz,
      poseHeel(pose),
      this.rudder,
      h,
      w,
    );

    const fzHydro = w.fz;
    this.aero.solve(
      world.ship.sails,
      world.env,
      pose,
      this.vbx,
      this.vby,
      this.vbz,
      this.wbx,
      this.wby,
      this.wbz,
      h,
      w,
    );
    // Forward is -Z, so a rig that is drawing shows up as a negative delta.
    this.aeroThrust = -(w.fz - fzHydro);

    // The assist adds its two forces to the SAME wrench, on the same substep,
    // and they go through the same integrator below. Nothing is special-cased.
    if (this.assistOn) {
      const env = world.env;
      this.assistLayer.apply(
        w,
        this.trim.level / Math.max(1, world.ship.sails.length),
        this.rudder / RUDDER_MAX,
        wrapPi(env.windBearing - poseHeading(pose)),
        env.windSpeed * env.gust,
        -this.vbz,
        this.hydro.out.waterSpeed,
      );
    }

    this.integrate(pose, w, h);
  }

  /**
   * Semi-implicit Euler with the body-frame transport terms. Velocity is
   * updated from the forces at the start of the step and the pose from the new
   * velocity, which is what makes a stiff buoyancy spring stable at 1/120 s.
   */
  private integrate(pose: Pose, w: Wrench, h: number): void {
    const mB = this.mp.mBody;
    const iB = this.mp.iBody;
    const invM = this.mp.invMBody;
    const invI = this.mp.invIBody;

    const vbx = this.vbx;
    const vby = this.vby;
    const vbz = this.vbz;
    const wbx = this.wbx;
    const wby = this.wby;
    const wbz = this.wbz;

    // M dv/dt = F - w x (M v). With anisotropic added mass the momentum, not
    // the velocity, is what gets transported.
    const px = mB.x * vbx;
    const py = mB.y * vby;
    const pz = mB.z * vbz;
    const ax = (w.fx - (wby * pz - wbz * py)) * invM.x;
    const ay = (w.fy - (wbz * px - wbx * pz)) * invM.y;
    const az = (w.fz - (wbx * py - wby * px)) * invM.z;

    // I dw/dt = T - w x (I w).
    const lx = iB.x * wbx;
    const ly = iB.y * wby;
    const lz = iB.z * wbz;
    const alx = (w.tx - (wby * lz - wbz * ly)) * invI.x;
    const aly = (w.ty - (wbz * lx - wbx * lz)) * invI.y;
    const alz = (w.tz - (wbx * ly - wby * lx)) * invI.z;

    this.bowAcceleration(pose, ax, ay, az, alx, aly, alz, h);

    this.vbx = vbx + ax * h;
    this.vby = vby + ay * h;
    this.vbz = vbz + az * h;
    this.wbx = wbx + alx * h;
    this.wby = wby + aly * h;
    this.wbz = wbz + alz * h;

    const m = pose.m;
    pose.x += (m[0] * this.vbx + m[1] * this.vby + m[2] * this.vbz) * h;
    pose.y += (m[3] * this.vbx + m[4] * this.vby + m[5] * this.vbz) * h;
    pose.z += (m[6] * this.vbx + m[7] * this.vby + m[8] * this.vbz) * h;

    integrateRotation(pose, this.wbx * h, this.wby * h, this.wbz * h);
    orthonormalize(pose);

    if (!Number.isFinite(pose.x + pose.y + pose.z + this.vbx + this.wbz)) this.recover();
  }

  /**
   * Vertical acceleration at the stem, m/s^2, signed and lightly smoothed.
   * Taken analytically from the body accelerations rather than by differencing
   * positions — a substep difference is mostly quantisation noise, and VFX
   * spawns a curtain of spray off this while the camera shakes off it.
   */
  private bowAcceleration(
    pose: Pose,
    ax: number,
    ay: number,
    az: number,
    alx: number,
    aly: number,
    alz: number,
    h: number,
  ): void {
    const rx = this.bowRX;
    const ry = this.bowRY;
    const rz = this.bowRZ;
    const wx = this.wbx;
    const wy = this.wby;
    const wz = this.wbz;

    // Acceleration of the CG in world terms, expressed in body components.
    const cgx = ax + (wy * this.vbz - wz * this.vby);
    const cgy = ay + (wz * this.vbx - wx * this.vbz);
    const cgz = az + (wx * this.vby - wy * this.vbx);

    // alpha x r.
    const tx = aly * rz - alz * ry;
    const ty = alz * rx - alx * rz;
    const tz = alx * ry - aly * rx;

    // omega x (omega x r).
    const cx = wy * rz - wz * ry;
    const cy = wz * rx - wx * rz;
    const cz = wx * ry - wy * rx;
    const ccx = wy * cz - wz * cy;
    const ccy = wz * cx - wx * cz;
    const ccz = wx * cy - wy * cx;

    const m = pose.m;
    const worldY =
      m[3] * (cgx + tx + ccx) + m[4] * (cgy + ty + ccy) + m[5] * (cgz + tz + ccz);
    // Fast enough to keep the spike, slow enough to drop substep hash.
    this.bowSlam = damp(this.bowSlam, worldY, 24, h);
  }

  /** Last resort if a pathological sea state produces a non-finite state. */
  private recover(): void {
    const heading = poseHeading(this.pose);
    this.place(Number.isFinite(heading) ? heading : 0, 0, 0);
    console.warn('[physics] non-finite state recovered');
  }

  /* ------------------------------------------------------------------ *
   *  publishing
   * ------------------------------------------------------------------ */

  private publish(world: World): void {
    const ship = world.ship;
    const pose = this.pose;
    const m = pose.m;
    const cg = this.mp.cg;

    // The blackboard carries the hull origin (waterline amidships); the solver
    // carries the centre of gravity.
    ship.position.set(
      pose.x - (m[0] * cg.x + m[1] * cg.y + m[2] * cg.z),
      pose.y - (m[3] * cg.x + m[4] * cg.y + m[5] * cg.z),
      pose.z - (m[6] * cg.x + m[7] * cg.y + m[8] * cg.z),
    );
    poseToQuaternion(pose, ship.quaternion);

    const vwx = m[0] * this.vbx + m[1] * this.vby + m[2] * this.vbz;
    const vwy = m[3] * this.vbx + m[4] * this.vby + m[5] * this.vbz;
    const vwz = m[6] * this.vbx + m[7] * this.vby + m[8] * this.vbz;
    ship.velocity.set(vwx, vwy, vwz);
    ship.angularVelocity.set(
      m[0] * this.wbx + m[1] * this.wby + m[2] * this.wbz,
      m[3] * this.wbx + m[4] * this.wby + m[5] * this.wbz,
      m[6] * this.wbx + m[7] * this.wby + m[8] * this.wbz,
    );

    // Speed over ground is what a log reads: horizontal only, so heave in a
    // gale does not inflate it.
    ship.speedKnots = toKnots(Math.hypot(vwx, vwz));
    ship.heading = poseHeading(pose);
    ship.heel = poseHeel(pose);
    ship.pitch = posePitch(pose);
    // Drift angle is meaningless when she is barely moving — atan2 of two
    // numbers near zero is noise, and the HUD and the wake both read this.
    ship.leeway = this.hydro.out.waterSpeed > 0.35 ? this.hydro.out.drift : 0;
    ship.rudder = this.rudder;
    ship.bowSlam = this.bowSlam;
    ship.sailArea = this.aero.drawingArea;
    ship.mass = MASS;
    ship.loa = LWL;
    ship.beam = BEAM;
    ship.draught = DRAUGHT;

    /* --- apparent wind, at the 10 m reference height ---------------------- */
    const env = world.env;
    const v10 = env.windSpeed * env.gust;
    const wdx = env.windVector.x * v10;
    const wdz = env.windVector.z * v10;
    // Ship-relative, then rotated into the body frame.
    const rx = wdx - vwx;
    const rz = wdz - vwz;
    const awx = m[0] * rx + m[6] * rz;
    const awz = m[2] * rx + m[8] * rz;
    ship.apparentWindSpeed = Math.hypot(awx, awz);
    // Where it comes FROM, relative to the bow (-Z), positive to starboard.
    ship.apparentWindAngle = Math.atan2(-awx, awz);

    const twa = wrapPi(env.windBearing - ship.heading);
    ship.pointOfSail = pointOfSail(twa, v10);

    // In irons: head to wind AND unable to drive out of it. Latched, because
    // she swings 20 deg either side of the wind while she is stuck there.
    const twaAbs = Math.abs(twa);
    const water = this.hydro.out.waterSpeed;
    // Assist has no no-go zone to be caught in: the drive force does not care
    // what the yards are doing, so she always answers and always makes way.
    // Reported honestly rather than suppressed — nothing here is ever latched
    // true in assist because the condition it describes cannot arise.
    if (this.assistOn) {
      this.ironsLatch = false;
    } else if (this.ironsLatch) {
      this.ironsLatch = twaAbs < 62 * DEG && water < 1.6;
    } else {
      this.ironsLatch = twaAbs < 44 * DEG && (this.aeroThrust <= 0 || water < 0.7);
    }
    ship.inIrons = this.ironsLatch;
  }

  /**
   * Floating origin. Past 4 km the ship is rebased toward the world origin and
   * the offset banked in `world.origin`, which is what keeps float32 shader
   * coordinates precise on a long voyage. The payload is the delta that was
   * ADDED to every render-space position, which is the convention the camera
   * rig and the world module already listen for.
   */
  private shiftOrigin(world: World): void {
    const p = world.ship.position;
    if (Math.abs(p.x) < ORIGIN_SHIFT_RADIUS && Math.abs(p.z) < ORIGIN_SHIFT_RADIUS) return;

    const dx = -p.x;
    const dz = -p.z;
    this.pose.x += dx;
    this.pose.z += dz;
    p.x += dx;
    p.z += dz;
    // true voyage position = render position + origin, so the bank moves the
    // other way and ends up accumulating the distance actually sailed.
    world.origin.x -= dx;
    world.origin.z -= dz;
    shiftPayload.set(dx, 0, dz);
    world.bus.emit('origin:shift', shiftPayload);
  }

  /* ------------------------------------------------------------------ *
   *  diagnostics and test hooks
   * ------------------------------------------------------------------ */

  /** Put the hull on a bearing, floating at her measured waterline. */
  private place(heading: number, speed: number, heel: number): void {
    const pose = this.pose;
    setPoseHeading(pose, heading);
    if (heel !== 0) integrateRotation(pose, 0, 0, -heel);
    orthonormalize(pose);
    pose.y = this.hs.floatY + this.mp.cg.y;
    this.vbx = 0;
    this.vby = 0;
    this.vbz = -speed;
    this.wbx = 0;
    this.wby = 0;
    this.wbz = 0;
    this.accumulator = 0;
    this.bowSlam = 0;
    this.rudder = 0;
    this.ironsLatch = false;
  }

  /**
   * Select the handling mode. Swapping the hydro tuning struct and the trim
   * rates is the whole of it — there is no second solver to switch to, and no
   * state is discarded, so this is safe to flip mid-voyage at any speed.
   */
  private setAssist(on: boolean): void {
    this.assistOn = on;
    this.hydro.tuning = on ? ASSIST_HYDRO : PRO_HYDRO;
    this.trim.assist = on;
  }

  private reset(headingDeg: number, knots: number, heelDeg: number): void {
    this.place(headingDeg * DEG, fromKnots(knots), heelDeg * DEG);
    this.helmCourse = headingDeg * DEG;
    this.pose.x = 0;
    this.pose.z = 0;
    this.aeroThrust = 0;
    // Brace the yards for the condition she has just been placed in and drop any
    // player bias. `run()` must be a pure function of (pose, rig, weather, dt)
    // for the acceptance tests to mean anything, and the yards are lagged state
    // that used to survive a reset.
    this.aero.reference(this.world.env, this.pose, this.vbx, this.vbz);
    this.trim.reset(
      this.world.ship.sails,
      this.aero.refX,
      this.aero.refZ,
      this.aero.refSpeed,
    );
    // A reset is a MEASUREMENT hook, and Pro is the calibrated ship, so it
    // always lands in Pro mode. `scripts/assist-test.mjs` sets `px.assist =
    // true` after each of its resets; `scripts/physics-test.mjs` therefore
    // keeps measuring the Pro ship without knowing the assist exists.
    this.setAssist(false);
    this.publish(this.world);
  }

  /** Advance the solver alone on a flat sea until the state stops changing. */
  private settle(world: World, seconds: number): void {
    const wasFlat = this.hydro.flatSea;
    this.hydro.flatSea = true;
    const frame = 1 / 30;
    const n = Math.round(seconds / frame);
    for (let i = 0; i < n; i++) this.tick(world, frame);
    this.hydro.flatSea = wasFlat;
    this.accumulator = 0;
  }

  private run(seconds: number, frameDt: number, record: boolean): PhysicsTrace[] {
    const world = this.world;
    const trace = this.trace;
    trace.length = 0;
    const n = Math.max(1, Math.round(seconds / frameDt));
    for (let i = 0; i < n; i++) {
      this.tick(world, frameDt);
      if (record) trace.push(this.snapshot((i + 1) * frameDt));
    }
    if (!record) trace.push(this.snapshot(n * frameDt));
    return trace;
  }

  private snapshot(t: number): PhysicsTrace {
    const ship = this.world.ship;
    const env = this.world.env;
    const twa = wrapPi(env.windBearing - ship.heading);
    // Toward the wind's source: bearing `windBearing` is (sin, 0, -cos).
    const sx = Math.sin(env.windBearing);
    const sz = -Math.cos(env.windBearing);
    return {
      t,
      knots: ship.speedKnots,
      heelDeg: ship.heel * RAD,
      pitchDeg: ship.pitch * RAD,
      headingDeg: ship.heading * RAD,
      leewayDeg: ship.leeway * RAD,
      twaDeg: twa * RAD,
      vmgKnots: toKnots(ship.velocity.x * sx + ship.velocity.z * sz),
      rudderDeg: ship.rudder * RAD,
      bowSlam: ship.bowSlam,
      sailArea: ship.sailArea,
    };
  }
}

const shiftPayload = new THREE.Vector3();

/**
 * Point of sail from the TRUE wind angle, which is what a sailor means by it.
 * The boundaries are the conventional ones; the no-go zone is not enforced
 * here, it emerges from the rig and the leeway.
 */
function pointOfSail(twa: number, windSpeed: number): string {
  if (windSpeed < 0.6) return 'becalmed';
  const a = Math.abs(twa) * RAD;
  if (a < 32) return 'head to wind';
  if (a < 70) return 'close hauled';
  if (a < 85) return 'close reach';
  if (a < 100) return 'beam reach';
  if (a < 155) return 'broad reach';
  return 'running';
}
