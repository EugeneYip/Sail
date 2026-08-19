import * as THREE from 'three';
import {
  anchorRelative,
  orbitAxisTilt,
  orbitElevation,
  subjectRelative,
  type CameraContext,
  type CameraMode,
  type CameraSolve,
} from '../CameraMode';
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
 *   keeps the hull's perspective from stretching.
 * - The distance is not a constant: the closest the mode will go is whatever
 *   makes the whole ship, jibboom to taffrail, fit `FIT_FRACTION` of the frame
 *   WIDTH at the current aspect ratio. See `fitDistance`.
 * - f/5.6 focused on the hull: the whole ship must be sharp in a screenshot.
 *
 * Two composition bugs lived here, and they are `DIAGNOSIS.md` section 10's
 * "the ship sits right of centre and grazes the right frame edge" — which is a
 * fair description of the `orbit` capture, where the jibboom left the frame
 * entirely:
 *
 *   1. The aim rode `frame.anchor`, which is deliberately laggy (1.4 m dead
 *      zone, 0.55 s spring). At 13 kn that is several metres of lag along the
 *      course, and this camera sits 14 deg forward of the BEAM, where a
 *      fore-and-aft lag is very nearly a pure sideways framing error. Fixed by
 *      aiming with `subjectRelative`: the eye still rides the smooth anchor.
 *   2. The frame had no margin to absorb the error even so. A ship 61 m long
 *      spans 86% of the frame width at 110 m with a 40 deg lens, and the mode's
 *      70 m zoom floor allowed 136%. The floor is now derived, not picked.
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

/** Hard floor, only reached on a very wide frame; `fitDistance` usually wins. */
const MIN_DISTANCE = 70;
const MAX_DISTANCE = 420;

/**
 * Fraction of the frame WIDTH the whole ship may span at the closest the mode
 * will go. 0.78 leaves 11% of the frame clear at each end, which is the margin
 * a full-profile shot needs to survive the residual heave and heading filtering
 * without anything touching an edge.
 */
const FIT_FRACTION = 0.78;
/**
 * The anatomy's jibboom station is a SEAT set inboard of the tip, so the spar
 * runs on past it. This is how much, and it is the difference between framing
 * the ship and framing the ship minus the end of its jibboom.
 */
const JIBBOOM_TIP_PAD_M = 5;

/** Same two physical free-look bounds as the chase camera. */
const MIN_EYE_ABOVE_SEA_M = 4.5;
const MAX_EYE_ELEVATION = 1.3;
const MAX_AXIS_TILT = 0.9;

export class OrbitMode implements CameraMode {
  readonly name = 'orbit';
  readonly lookYawLimit = Math.PI;
  /**
   * Generous, because the geometry — not this pair — is what actually stops the
   * look: the eye descends until it is `MIN_EYE_ABOVE_SEA_M` off the water or
   * rises to `MAX_EYE_ELEVATION`, and the remainder becomes axis tilt, capped at
   * `MAX_AXIS_TILT`. These bounds sit just outside where all of that saturates,
   * so the player can reach every attainable angle without winding up a pile of
   * dead look angle they then have to drag back through.
   */
  readonly lookPitchMin = -1.15;
  readonly lookPitchMax = 1.15;
  /** `[0]` is rewritten every frame by `fitDistance`. */
  readonly distanceRange: [number, number] = [MIN_DISTANCE, MAX_DISTANCE];

  /** Azimuth from dead astern, radians, signed. */
  private azimuth = CANONICAL_AZIMUTH;
  private dist = 110;
  private vDist = { v: 0 };
  private eye = new THREE.Vector3();

  enter(ctx: CameraContext): void {
    this.distanceRange[0] = this.fitDistance(ctx);
    this.dist = this.clampDistance(ctx.world.cam.distance);
    this.vDist.v = 0;
    const canon = this.canonical(ctx);
    // Start short of the canonical bearing so there is visible motion during
    // the settle, then arrive and stop.
    this.azimuth = canon - Math.sign(canon || 1) * CAPTURE_APPROACH;
  }

  solve(ctx: CameraContext, out: CameraSolve): void {
    const { frame, dt } = ctx;

    // Re-derived every frame: the anatomy can be republished by the ship agent
    // and the aspect ratio changes when the window does.
    this.distanceRange[0] = this.fitDistance(ctx);
    this.dist = springDamp(
      this.dist,
      this.clampDistance(ctx.world.cam.distance),
      this.vDist,
      0.5,
      dt,
    );
    const d = this.dist;

    if (ctx.captureHold) {
      const canon = this.canonical(ctx);
      const t = smootherstep(0, CAPTURE_EASE_SECONDS, ctx.captureTime);
      this.azimuth = canon - Math.sign(canon || 1) * CAPTURE_APPROACH * (1 - t);
    } else {
      this.azimuth += ORBIT_RATE * dt;
      if (this.azimuth > Math.PI * 3) this.azimuth -= Math.PI * 2;
    }

    // theta = 0 is dead astern; +theta swings the EYE toward starboard, so the
    // player's yaw enters negated (dragging right swings the VIEW to starboard,
    // which walks the eye the other way — see `CameraContext`).
    const theta = this.azimuth - ctx.lookYaw;
    const baseY = EYE_HEIGHT_PER_M * d + EYE_HEIGHT_BASE;
    const elev = orbitElevation(d, baseY, ctx.lookPitch, MIN_EYE_ABOVE_SEA_M, MAX_EYE_ELEVATION);
    const tilt = orbitAxisTilt(d, baseY, ctx.lookPitch, elev, MAX_AXIS_TILT);
    const radius = Math.hypot(d, baseY);
    const horiz = radius * Math.cos(elev);
    const side = Math.sin(theta) * horiz;
    const fore = -Math.cos(theta) * horiz;

    anchorRelative(frame, side, fore, radius * Math.sin(elev), this.eye);
    out.position.copy(this.eye);
    // Aim at the ship, not the anchor, and at the middle of its LENGTH rather
    // than the hull origin — the origin is amidships on the WATERLINE, and the
    // jibboom puts several metres more ship forward of it than aft.
    subjectRelative(
      frame,
      0,
      loaMidForward(ctx),
      LOOK_HEIGHT_PER_M * d + LOOK_HEIGHT_BASE + horiz * Math.tan(tilt),
      out.target,
    );

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

  /**
   * The closest this mode may sit and still show the whole ship with margin.
   *
   * Straight trigonometry, and it replaces a picked constant that was wrong by
   * 75%: at the old 70 m floor a 61 m ship spans 136% of a 16:9 frame through a
   * 40 deg lens. Derived per frame because it depends on the aspect ratio, so a
   * portrait phone pulls back instead of cropping the bow off.
   */
  private fitDistance(ctx: CameraContext): number {
    const a = ctx.anatomy;
    const halfLoa = (a.sternZ - a.jibboomZ + JIBBOOM_TIP_PAD_M) * 0.5;
    const size = ctx.world.size;
    const tanHalfX =
      Math.tan(THREE.MathUtils.degToRad(FOV) * 0.5) * (size.width / Math.max(1, size.height));
    const need = (2 * halfLoa) / Math.max(0.05, FIT_FRACTION * tanHalfX);
    return THREE.MathUtils.clamp(need, MIN_DISTANCE, MAX_DISTANCE);
  }

  private clampDistance(d: number): number {
    return THREE.MathUtils.clamp(d, this.distanceRange[0], this.distanceRange[1]);
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

/**
 * Metres forward of the hull origin to the midpoint of the ship's LENGTH.
 *
 * The origin is amidships on the waterline, but the jibboom carries the ship
 * ~35 m forward against ~27 m aft to the taffrail, so aiming at the origin puts
 * the geometric centre of the subject 4 m off frame centre — and it is the bow
 * end that runs out of frame.
 */
function loaMidForward(ctx: CameraContext): number {
  const a = ctx.anatomy;
  return (-a.jibboomZ + JIBBOOM_TIP_PAD_M - a.sternZ) * 0.5;
}
