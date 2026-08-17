import * as THREE from 'three';
import {
  directionFrom,
  localToWorld,
  type CameraContext,
  type CameraMode,
  type CameraSolve,
} from '../CameraMode';
import { damp, smoothstep, wrapPi } from '../../util/math';

/**
 * Out on the jibboom, looking AFT at the ship.
 *
 * Why aft and not forward: forward over the bow is beautiful for three seconds
 * and then it is an empty horizon with some spray — the same information the
 * chase camera already gives you, from a worse height. Looking aft is the only
 * position in the game where the ship comes AT the lens. You get the bow wave
 * breaking directly under the camera, the head stays and jib sheets converging
 * overhead as leading lines, the whole rig stacked up behind the bow, and the
 * ship's pitch made visceral: the lens sits ~30 m forward of the pitch axis, so
 * three degrees of pitch swings it 1.6 m vertically and the deck rises and falls
 * against the horizon. It is the shot on the cover of every book about sail.
 *
 * Composition rules
 * -----------------
 * - Seated 0.9 m to starboard of the spar's centreline so the jibboom and its
 *   guys run up the side of the frame as foreground instead of bisecting it.
 * - Base axis 172 deg (aft, angled 8 deg across the keel) and 5 deg up, so the
 *   ship reads as a diagonal, not a symmetrical mirror, and the horizon sits
 *   just below centre with the rig filling the upper two thirds.
 * - When the sun is within 15 deg of the horizon the axis biases up to 30 deg
 *   toward the sun's bearing. Backlit or side-lit canvas at that hour is the best
 *   light in the game and a DP would not shoot it any other way. It also means
 *   the sunset capture has the sun's glitter path in frame instead of behind the
 *   camera.
 * - Autofocus tracks the ship at f/2.8, and racks to the horizon when the player
 *   looks more than 60 deg off the ship — a subject-tracking AF, not a constant.
 */

const BASE_YAW_OFFSET = Math.PI - 0.14; // 172 deg from the bow: aft, angled across
const BASE_PITCH = 0.087; // 5 deg up
const FOV = 68;
const SUN_BIAS_MAX = 0.52; // 30 deg
/** Sun elevation below which the low-sun bias fades in, radians. */
const SUN_LOW_ELEVATION = 0.262; // 15 deg
/** Look yaw beyond which autofocus gives up on the ship and racks to infinity. */
const SUBJECT_LOST_YAW = 1.05;

export class BowspritMode implements CameraMode {
  readonly name = 'bowsprit';
  readonly lookYawLimit = 2.44; // 140 deg either side: you can look right forward
  readonly lookPitchMin = -0.7;
  readonly lookPitchMax = 1.0;

  private sunBias = 0;
  private focusBlend = 0;
  private dir = new THREE.Vector3();
  private eye = new THREE.Vector3();

  enter(ctx: CameraContext): void {
    this.sunBias = sunBiasTarget(ctx);
    this.focusBlend = 0;
  }

  solve(ctx: CameraContext, out: CameraSolve): void {
    const { frame, anatomy, dt } = ctx;

    this.sunBias = damp(this.sunBias, sunBiasTarget(ctx), 0.6, dt);

    localToWorld(frame, anatomy.jibboomX, anatomy.jibboomY, anatomy.jibboomZ, this.eye);
    out.position.copy(this.eye);

    const yaw = frame.heading + BASE_YAW_OFFSET + this.sunBias + ctx.lookYaw;
    const pitch = BASE_PITCH + ctx.lookPitch + frame.pitch * 0.8;
    directionFrom(yaw, pitch, this.dir);
    out.target.copy(this.eye).addScaledVector(this.dir, 70);

    // Rigidly mounted on the spar, so it takes the full heel. That is the point.
    out.roll = frame.heel;
    out.fov = FOV;
    out.aperture = 2.8;

    const lost = smoothstep(SUBJECT_LOST_YAW, SUBJECT_LOST_YAW + 0.5, Math.abs(wrapPi(ctx.lookYaw)));
    this.focusBlend = damp(this.focusBlend, lost, 2.2, dt);
    if (this.focusBlend > 0.5) {
      out.focusMode = 'horizon';
    } else {
      out.focusMode = 'point';
      frame.focusPoint(out.focusPoint, 12);
    }
    // A deliberately slow rack: this is the one view where you watch focus move.
    out.focusRate = 1.9;
    out.shakeScale = 1.15;
    out.avoidHull = false;
    out.avoidRig = false;
    out.waterClearance = -50;
    out.shot = '';
  }
}

function sunBiasTarget(ctx: CameraContext): number {
  const sun = ctx.world.env.sunDirection;
  const elevation = Math.asin(THREE.MathUtils.clamp(sun.y, -1, 1));
  const low = 1 - smoothstep(-0.05, SUN_LOW_ELEVATION, elevation);
  if (low <= 0.001) return 0;
  // Bearing of the sun, then the shortest turn from the base aft axis toward it.
  const sunBearing = Math.atan2(sun.x, -sun.z);
  const baseAxis = ctx.frame.heading + BASE_YAW_OFFSET;
  const delta = wrapPi(sunBearing - baseAxis);
  return THREE.MathUtils.clamp(delta, -SUN_BIAS_MAX, SUN_BIAS_MAX) * low;
}
