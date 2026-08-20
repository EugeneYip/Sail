import * as THREE from 'three';
import {
  directionFrom,
  localToWorld,
  MAX_AXIS_ELEVATION,
  type CameraContext,
  type CameraMode,
  type CameraSolve,
} from '../CameraMode';
import { springDamp } from '../../util/math';

/**
 * First person at the wheel, on the quarterdeck.
 *
 * Composition rules
 * -----------------
 * - A helmsman steers by the HORIZON and the BOW, at a wheel. All three have to
 *   be in the frame, and the eye height is what decides whether any of them are
 *   — see `EYE_ABOVE_RAIL_M`. Everything else here is secondary to that.
 * - The eye stands abaft the wheel, on the centreline, at the height the two
 *   clearances below demand rather than at a standing height. The axis is 2 deg
 *   BELOW horizontal with a 71 deg lens: the horizon lands a little above centre,
 *   the deck runs away to the bow through the middle of the frame, the wheel's
 *   upper rim crosses the lower third, and the main course and lower topsails
 *   fill the top. Nothing is centred.
 * - The player can look ANYWHERE: a full turn on the spot, and up to the trucks
 *   or down to the binnacle. A helmsman is a person standing on a deck, not a
 *   head in a vice, and the 150 deg yaw stop this mode used to carry meant you
 *   could not look at your own wake. Look angles are stored ship-relative, so
 *   the view turns with the ship and dead ahead stays dead ahead through a tack.
 * - Stopped down to f/5.6. A 26 mm-equivalent lens at f/5.6 is hyperfocal from
 *   about 2 m, so the wheel and the masthead are sharp at the same time. This is
 *   the one view where deep focus is the point.
 *
 * Motion
 * ------
 * The eye is bolted to the deck, but a person standing on a deck is not: the
 * legs absorb the sharp part of the heave and the neck holds the head level
 * against roll. So the eye position uses the ship's filtered transform minus a
 * fraction of the residual heave (knee flex), and the aim uses only a fraction
 * of the hull's roll and pitch (vestibular stabilisation). What is left is the
 * slow, heavy motion of two thousand tonnes, which is what you want to feel.
 */

/** Base axis, radians. Slightly down so the wheel and deck stay in frame. */
const BASE_PITCH = -0.035;
const FOV = 71;

/**
 * Metres of clear sea the eye holds above the bulwark cap.
 *
 * This is the whole defect, and it was eight centimetres. The ship publishes
 * `helmY = 7.35` (a 1.68 m eye on a quarterdeck at 5.67) and `bulwarkY = 7.436`
 * — so the helmsman's eye sits 8.6 cm BELOW the top of his own bulwark, and
 * measured on a 1600x900 frame the sea line was behind timber across **100% of
 * the frame width**: longest clear run 0 px. A helm view with no horizon in it
 * is not a helm view, whatever else is in frame.
 *
 * The real ship does not have this problem because its quarterdeck is a whole
 * deck above the waist; this model's quarterdeck is 0.18 m above it, so the
 * waist bulwark is at the helmsman's eye. That is not something `src/camera` can
 * fix, so the camera solves the constraint instead of the anatomy.
 */
const EYE_ABOVE_RAIL_M = 0.5;
/**
 * Metres the eye holds above the wheel's UPPER RIM, so the rim has a horizon
 * behind it instead of running along it.
 *
 * Measured before: the rim projected 79 px ABOVE the sea line, against the main
 * course — pale timber on pale canvas, which is what "no silhouette" means. The
 * fix is not to hide the wheel but to get the sea behind its top edge.
 *
 * Both margins are deliberately small, and TOGETHER they lift the eye about
 * 0.67 m above `helmY`: this eye is a CAMERA at 2.35 m above the deck, not a
 * person. That is stated rather than hidden because the honest fix lives in
 * `src/ship` — a quarterdeck that steps up over the waist, and a wheel whose
 * disc is not lying flat — and once either lands, `Math.max` below hands the
 * height straight back to the published anatomy with no change here.
 */
const EYE_ABOVE_WHEEL_RIM_M = 0.16;
/**
 * Wheel outer radius at the spoke handles, metres. The anatomy publishes the
 * wheel's CENTRE and not its size, so this is the one dimension here that is
 * assumed rather than read; 1.24 m is measured off the built geometry
 * (`aPart == PART.WHEEL`, ship-local X span 2.48 m).
 */
const WHEEL_RADIUS_M = 1.24;
/** How much of the hull's roll the head keeps. A real neck cancels most of it. */
const ROLL_RETAINED = 0.55;
const PITCH_RETAINED = 0.5;
/** Fraction of the sharp heave the legs absorb. */
const KNEE_FLEX = 0.35;
/** Lateral lean into acceleration, metres per m/s^2. */
const SWAY_PER_ACCEL = 0.022;
const SWAY_MAX_M = 0.09;
/** Metres ahead along the deck that autofocus locks onto. */
const FOCUS_AHEAD_M = 22;

export class HelmMode implements CameraMode {
  readonly name = 'helm';
  /** A full turn, wrapped rather than clamped: you can look astern. */
  readonly lookYawLimit = Math.PI;
  /** Exactly enough to reach both poles from the composed axis, and no more. */
  readonly lookPitchMin = -MAX_AXIS_ELEVATION - BASE_PITCH;
  readonly lookPitchMax = MAX_AXIS_ELEVATION - BASE_PITCH;

  private sway = 0;
  private vSway = { v: 0 };
  private bob = 0;
  private vBob = { v: 0 };
  private dir = new THREE.Vector3();
  private eye = new THREE.Vector3();

  enter(): void {
    this.sway = 0;
    this.vSway.v = 0;
    this.bob = 0;
    this.vBob.v = 0;
  }

  solve(ctx: CameraContext, out: CameraSolve): void {
    const { frame, anatomy, dt } = ctx;

    // Body compensation. Both channels are spring filtered again on top of the
    // frame's own filtering: this is a human body, the slowest filter on the ship.
    const swayWant = THREE.MathUtils.clamp(
      -frame.lateralAccel * SWAY_PER_ACCEL,
      -SWAY_MAX_M,
      SWAY_MAX_M,
    );
    this.sway = springDamp(this.sway, swayWant, this.vSway, 0.42, dt);
    this.bob = springDamp(this.bob, -frame.heaveResidual * KNEE_FLEX, this.vBob, 0.3, dt);

    // The eye height is a solved constraint, not a constant: high enough to see
    // the sea over the bulwark cap and to keep the wheel's upper rim against
    // that sea. Re-derived every frame because the ship may republish either
    // number, and the moment it publishes better ones `helmY` wins on its own.
    const eyeY = Math.max(
      anatomy.helmY,
      anatomy.bulwarkY + EYE_ABOVE_RAIL_M,
      anatomy.wheelY + WHEEL_RADIUS_M + EYE_ABOVE_WHEEL_RIM_M,
    );
    localToWorld(frame, anatomy.helmX + this.sway, eyeY, anatomy.helmZ, this.eye);
    this.eye.y += this.bob;
    out.position.copy(this.eye);

    const yaw = frame.heading + ctx.lookYaw;
    // The hull's residual pitch rides on top of the player's, so the total needs
    // the vertical guard even though the accumulator was already clamped to it.
    const pitch = THREE.MathUtils.clamp(
      BASE_PITCH + ctx.lookPitch + frame.pitch * PITCH_RETAINED,
      -MAX_AXIS_ELEVATION,
      MAX_AXIS_ELEVATION,
    );
    directionFrom(yaw, pitch, this.dir);
    out.target.copy(this.eye).addScaledVector(this.dir, 60);

    out.roll = frame.heel * ROLL_RETAINED;
    out.fov = FOV;
    out.aperture = 5.6;
    out.focusMode = 'point';
    // Focus a comfortable working distance down the deck, not on the rail: a
    // helmsman is looking at the sails and the sea, not at their own hands.
    out.focusPoint.copy(this.eye).addScaledVector(this.dir, FOCUS_AHEAD_M);
    out.focusRate = 3.4;
    // Head-mounted: the whole body already moves with the slam, so extra
    // rotational shake reads as double-counting. Keep it, but restrained.
    out.shakeScale = 0.55;
    out.avoidHull = false;
    out.avoidRig = false;
    // Never lift a deck-mounted eye: it would detach from the ship. Green water
    // over the quarterdeck is a legitimate thing to see.
    out.waterClearance = -50;
    out.shot = '';
  }
}
