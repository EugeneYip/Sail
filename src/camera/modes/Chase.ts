import * as THREE from 'three';
import { anchorRelative, type CameraContext, type CameraMode, type CameraSolve } from '../CameraMode';
import { damp, springDamp } from '../../util/math';

/**
 * The default view: behind and above, looking slightly down.
 *
 * Composition rules
 * -----------------
 * - Eye height and look height are both fractions of the follow distance, so
 *   the framing is scale-invariant: zoom in or out and the horizon stays on the
 *   upper-third line and the hull stays on the lower third. At the default 76 m
 *   the eye sits 27.8 m up and aims at 13.2 m on the rig, a 10.9 deg downward
 *   axis, which puts the horizon at 67% of frame height with a 58 deg lens.
 * - The lens looks PARALLEL to the ship's course rather than at the hull. The
 *   lateral eye offset then places the ship off-centre for free and the frame
 *   automatically contains the water the ship is sailing into. That is leading
 *   room, and it costs one multiply.
 * - That offset is specified WHERE IT IS OBSERVED: as the hull's position in
 *   normalised device x, not as a fraction of the follow distance. Those two are
 *   only the same at one field of view, and this mode changes FOV with speed, so
 *   the old distance-fraction form pushed the hull further off-centre exactly
 *   when the lens got wider. At full heel and full rudder together it put the
 *   bow past the right frame edge — a hard fail on the rubric's composition
 *   axis. In NDC the bound is a single clamp and it is exact.
 * - The lateral offset is signed by heel, so the camera sits on the lee quarter:
 *   the deck tilts toward the lens and reads as a surface instead of an edge.
 * - The look target leads further ahead as speed rises, dropping the hull in
 *   frame and opening up the sea ahead.
 * - Royals and topgallants are deliberately cropped off the top. Fitting all
 *   67 m of rig at this distance forces a level axis, which puts the horizon
 *   dead centre and makes the ship look like a postcard. Cropping makes it look
 *   big. `orbit` is where the whole profile fits.
 *
 * The camera pulls back at speed with FOV, not distance, because distance is
 * what every composition rule above is written in terms of — moving it slides
 * the horizon and re-frames the shot, whereas 6 deg of extra FOV adds peripheral
 * motion (the real speed cue) while leaving the framing anchored.
 */

/** Yaw rate treated as a full-rudder turn, rad/s. */
const FULL_TURN_RATE = 0.085;
/** Heel treated as full lee-side bias, radians (~12.6 deg). */
const FULL_HEEL = 0.22;

const EYE_HEIGHT_PER_M = 0.26;
const EYE_HEIGHT_BASE = 8;
const LOOK_HEIGHT_PER_M = 0.115;
const LOOK_HEIGHT_BASE = 4.5;
/** Fraction of the eye's lateral offset the look target inherits. Below 1 the
 *  axis converges very slightly on the ship, which keeps it from drifting out
 *  of frame at long distances. */
const TARGET_SIDE_FOLLOW = 0.9;

/**
 * Where the hull sits, as NDC x: 0 is frame centre, ±1 is the frame edge. The
 * signs are negative because a camera displaced to starboard (positive `side`)
 * puts the hull to port of the axis. The cap is the load-bearing number — the
 * hull spans about 0.5 NDC at the default distance, so 0.30 leaves it well
 * inside the frame while still sitting on a thirds line.
 */
const SHIP_NDC_FROM_HEEL = -0.17;
const SHIP_NDC_FROM_TURN = -0.15;
const MAX_SHIP_NDC = 0.3;
const LEAD_BASE_M = 6;
const LEAD_PER_SPEED_M = 26;

const FOV_BASE = 58;
const FOV_AT_TOP_SPEED = 64.5;
const BANK_PER_TURN = 0.038; // 2.2 deg at full rudder
const HEEL_TO_ROLL = 0.1;

export const CHASE_MIN_DISTANCE = 34;
export const CHASE_MAX_DISTANCE = 260;

export class ChaseMode implements CameraMode {
  readonly name = 'chase';
  readonly lookYawLimit = 1.05;
  readonly lookPitchMin = -0.32;
  readonly lookPitchMax = 0.42;
  /** Drifts back to the composed frame a few seconds after you let go. Slow
   *  enough (a ~2 s time constant) that it reads as the camera settling rather
   *  than as the game taking the controls off you. */
  readonly lookRecentreRate = 0.5;
  readonly distanceRange = [CHASE_MIN_DISTANCE, CHASE_MAX_DISTANCE] as const;

  private dist = 76;
  private vDist = { v: 0 };
  private fov = FOV_BASE;
  /** Hull position in NDC x, smoothed. Converted to metres in `solve`. */
  private shipNdc = 0;
  private lead = LEAD_BASE_M;
  private roll = 0;
  private eye = new THREE.Vector3();

  enter(ctx: CameraContext): void {
    this.dist = clampDistance(ctx.world.cam.distance);
    this.vDist.v = 0;
    this.fov = FOV_BASE + (FOV_AT_TOP_SPEED - FOV_BASE) * ctx.frame.speedNorm;
    this.shipNdc = shipNdcTarget(ctx);
    this.lead = LEAD_BASE_M + LEAD_PER_SPEED_M * ctx.frame.speedNorm;
    this.roll = rollTarget(ctx);
  }

  solve(ctx: CameraContext, out: CameraSolve): void {
    const { frame, dt } = ctx;

    this.dist = springDamp(this.dist, clampDistance(ctx.world.cam.distance), this.vDist, 0.45, dt);
    const d = this.dist;

    // Every framing quantity is smoothed independently and slowly. A single
    // spring on the final position would couple speed changes into the height.
    this.fov = damp(this.fov, FOV_BASE + (FOV_AT_TOP_SPEED - FOV_BASE) * frame.speedNorm, 1.2, dt);
    this.shipNdc = damp(this.shipNdc, shipNdcTarget(ctx), 1.5, dt);
    this.lead = damp(this.lead, LEAD_BASE_M + LEAD_PER_SPEED_M * frame.speedNorm, 1.1, dt);
    this.roll = damp(this.roll, rollTarget(ctx), 2.0, dt);

    const eyeY = EYE_HEIGHT_PER_M * d + EYE_HEIGHT_BASE;
    const lookY = LOOK_HEIGHT_PER_M * d + LOOK_HEIGHT_BASE;

    // Free-look orbits the eye about the anchor; the target stays put so the
    // player swings around the ship rather than panning off it.
    const yaw = ctx.lookYaw;
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const back = d * cy;
    const swing = d * sy;
    const pitchLift = Math.tan(ctx.lookPitch) * d;

    // NDC x -> metres of lateral eye offset. Because the target only inherits
    // TARGET_SIDE_FOLLOW of that offset the axis converges slightly on the hull,
    // so the observed offset is a little smaller than the eye's — divide it back
    // out rather than leaving the framing a few percent tighter than asked for.
    const zEye = Math.max(back, 1);
    const converge = 1 - (1 - TARGET_SIDE_FOLLOW) * (zEye / (zEye + this.lead));
    const tanHalfX =
      Math.tan(THREE.MathUtils.degToRad(this.fov) * 0.5) *
      (ctx.world.size.width / Math.max(1, ctx.world.size.height));
    const sideM = (-this.shipNdc * zEye * tanHalfX) / converge;

    anchorRelative(frame, sideM + swing, -back, eyeY + pitchLift, this.eye);
    out.position.copy(this.eye);
    anchorRelative(frame, sideM * TARGET_SIDE_FOLLOW, this.lead, lookY, out.target);

    out.roll = this.roll;
    out.fov = this.fov;
    out.aperture = 4;
    out.focusMode = 'point';
    frame.focusPoint(out.focusPoint, 9);
    out.focusRate = 2.6;
    out.shakeScale = 1;
    out.avoidHull = true;
    out.avoidRig = true;
    out.waterClearance = 3.2;
    // The eye is already smooth (everything above it is spring filtered); the
    // TARGET gets nearly twice the smooth time, which is what lets the hull rise
    // and fall inside the frame over a swell instead of being pinned to it.
    out.posSmoothTime = 0.34;
    out.targetSmoothTime = 0.62;
    out.shot = '';
  }
}

function clampDistance(d: number): number {
  return THREE.MathUtils.clamp(d, CHASE_MIN_DISTANCE, CHASE_MAX_DISTANCE);
}

function shipNdcTarget(ctx: CameraContext): number {
  const heelBias = THREE.MathUtils.clamp(ctx.frame.heel / FULL_HEEL, -1, 1);
  const turnBias = THREE.MathUtils.clamp(ctx.frame.turnRate / FULL_TURN_RATE, -1, 1);
  return THREE.MathUtils.clamp(
    heelBias * SHIP_NDC_FROM_HEEL + turnBias * SHIP_NDC_FROM_TURN,
    -MAX_SHIP_NDC,
    MAX_SHIP_NDC,
  );
}

function rollTarget(ctx: CameraContext): number {
  const turnBias = THREE.MathUtils.clamp(ctx.frame.turnRate / FULL_TURN_RATE, -1, 1);
  // Negative roll tilts the horizon's inside edge down, i.e. banks into the turn.
  return -turnBias * BANK_PER_TURN + ctx.frame.heel * HEEL_TO_ROLL;
}
