import * as THREE from 'three';
import { anchorRelative, type CameraContext, type CameraMode, type CameraSolve } from '../CameraMode';
import { smootherstep, springDamp, wrapPi } from '../../util/math';

/**
 * The screenshot mode: a slow automatic orbit showing the whole profile.
 *
 * Composition rules
 * -----------------
 * - 104 deg off the stern, i.e. 14 deg forward of the beam. A dead beam-on shot
 *   is a flat elevation drawing; 14 deg of bow bias reads the bowsprit and the
 *   head rig and gives the hull some depth while still reading as a profile.
 * - The lit side is chosen automatically: the orbit settles on whichever beam
 *   faces the sun, so the gunport stripe and the sail faces are front- or
 *   side-lit rather than in shadow.
 * - Eye height is 0.16x the distance and the aim is 0.26x, so the axis tilts
 *   ~6 deg UP. That is a heroic low angle: the horizon lands on the lower third,
 *   the hull sits below it, and the rig soars through the upper two thirds — the
 *   composition of every marine painting ever made.
 * - 40 deg lens. Mildly long, which flattens the sea into stacked bands and
 *   keeps the hull's perspective from stretching. At the default 110 m the ship
 *   spans 78% of frame height with margin at both ends.
 * - f/5.6 focused on the hull: the whole ship must be sharp in a screenshot.
 *
 * Determinism: see `CameraRig` — during a capture hold the azimuth eases into
 * the canonical bearing over 3.4 s and then stops dead, so two captures of the
 * same build frame identically.
 */

/** Free-run orbit rate, rad/s. A full circle in 114 s. */
const ORBIT_RATE = 0.055;
/** Camera bearing from the ship, measured from dead astern toward starboard. */
const CANONICAL_AZIMUTH = 1.815; // 104 deg
/** How far back the capture ease-in starts, radians. */
const CAPTURE_APPROACH = 0.26;
const CAPTURE_EASE_SECONDS = 3.4;

const EYE_HEIGHT_PER_M = 0.16;
const EYE_HEIGHT_BASE = 3;
const LOOK_HEIGHT_PER_M = 0.26;
const LOOK_HEIGHT_BASE = 3;
const FOV = 40;

const MIN_DISTANCE = 70;
const MAX_DISTANCE = 420;

export class OrbitMode implements CameraMode {
  readonly name = 'orbit';
  readonly lookYawLimit = Math.PI;
  readonly lookPitchMin = -0.3;
  readonly lookPitchMax = 0.35;
  readonly distanceRange = [MIN_DISTANCE, MAX_DISTANCE] as const;

  /** Azimuth from dead astern, radians, signed. */
  private azimuth = CANONICAL_AZIMUTH;
  private dist = 110;
  private vDist = { v: 0 };
  private eye = new THREE.Vector3();

  enter(ctx: CameraContext): void {
    this.dist = clampDistance(ctx.world.cam.distance);
    this.vDist.v = 0;
    const canon = this.canonical(ctx);
    // Start short of the canonical bearing so there is visible motion during
    // the settle, then arrive and stop.
    this.azimuth = canon - Math.sign(canon || 1) * CAPTURE_APPROACH;
  }

  solve(ctx: CameraContext, out: CameraSolve): void {
    const { frame, dt } = ctx;

    this.dist = springDamp(this.dist, clampDistance(ctx.world.cam.distance), this.vDist, 0.5, dt);
    const d = this.dist;

    if (ctx.captureHold) {
      const canon = this.canonical(ctx);
      const t = smootherstep(0, CAPTURE_EASE_SECONDS, ctx.captureTime);
      this.azimuth = canon - Math.sign(canon || 1) * CAPTURE_APPROACH * (1 - t);
    } else {
      this.azimuth += ORBIT_RATE * dt;
      if (this.azimuth > Math.PI * 3) this.azimuth -= Math.PI * 2;
    }

    const theta = this.azimuth + ctx.lookYaw;
    // theta = 0 is dead astern; +theta swings toward starboard.
    const side = Math.sin(theta) * d;
    const fore = -Math.cos(theta) * d;
    const eyeY = EYE_HEIGHT_PER_M * d + EYE_HEIGHT_BASE + Math.tan(ctx.lookPitch) * d;

    anchorRelative(frame, side, fore, eyeY, this.eye);
    out.position.copy(this.eye);
    anchorRelative(frame, 0, 0, LOOK_HEIGHT_PER_M * d + LOOK_HEIGHT_BASE, out.target);

    out.roll = 0;
    out.fov = FOV;
    out.aperture = 5.6;
    out.focusMode = 'point';
    frame.focusPoint(out.focusPoint, 12);
    out.focusRate = 2.4;
    out.shakeScale = 0.35; // a screenshot mode; keep it nearly locked off
    out.avoidHull = true;
    out.avoidRig = true;
    out.waterClearance = 2.6;
    out.posSmoothTime = 0.3;
    out.targetSmoothTime = 0.55;
    out.shot = '';
  }

  /** Beam bearing on the sunlit side, wrapped into (-PI, PI]. */
  private canonical(ctx: CameraContext): number {
    const sun = ctx.world.env.sunDirection;
    const sunBearing = Math.atan2(sun.x, -sun.z);
    // Bearing of "dead astern" as seen from the ship.
    const astern = ctx.frame.heading + Math.PI;
    const toSun = wrapPi(sunBearing - astern);
    return toSun >= 0 ? CANONICAL_AZIMUTH : -CANONICAL_AZIMUTH;
  }
}

function clampDistance(d: number): number {
  return THREE.MathUtils.clamp(d, MIN_DISTANCE, MAX_DISTANCE);
}
