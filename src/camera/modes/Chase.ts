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
 *   lateral eye offset then places the ship off-centre for free (~42% of frame
 *   width) and the frame automatically contains the water the ship is sailing
 *   into. That is leading room, and it costs one multiply.
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

const SIDE_FROM_HEEL = 0.15;
const SIDE_FROM_TURN = 0.13;
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
  private side = 0;
  private lead = LEAD_BASE_M;
  private roll = 0;
  private eye = new THREE.Vector3();

  enter(ctx: CameraContext): void {
    this.dist = clampDistance(ctx.world.cam.distance);
    this.vDist.v = 0;
    this.fov = FOV_BASE + (FOV_AT_TOP_SPEED - FOV_BASE) * ctx.frame.speedNorm;
    this.side = sideTarget(ctx);
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
    this.side = damp(this.side, sideTarget(ctx), 1.5, dt);
    this.lead = damp(this.lead, LEAD_BASE_M + LEAD_PER_SPEED_M * frame.speedNorm, 1.1, dt);
    this.roll = damp(this.roll, rollTarget(ctx), 2.0, dt);

    const sideM = this.side * d;
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

function sideTarget(ctx: CameraContext): number {
  const heelBias = THREE.MathUtils.clamp(ctx.frame.heel / FULL_HEEL, -1, 1);
  const turnBias = THREE.MathUtils.clamp(ctx.frame.turnRate / FULL_TURN_RATE, -1, 1);
  return heelBias * SIDE_FROM_HEEL + turnBias * SIDE_FROM_TURN;
}

function rollTarget(ctx: CameraContext): number {
  const turnBias = THREE.MathUtils.clamp(ctx.frame.turnRate / FULL_TURN_RATE, -1, 1);
  // Negative roll tilts the horizon's inside edge down, i.e. banks into the turn.
  return -turnBias * BANK_PER_TURN + ctx.frame.heel * HEEL_TO_ROLL;
}
