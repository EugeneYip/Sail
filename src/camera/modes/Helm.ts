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
 * - The eye stands abaft the wheel, on the centreline, 1.8 m above the spar
 *   deck. The default axis is 2 deg BELOW horizontal with a 71 deg lens: that
 *   puts the wheel rim at ~20% of frame height (bottom fifth, where a real
 *   helmsman's hands are), the deck running away to the bow through the middle
 *   of the frame, the horizon a little above centre, and the main course and
 *   lower topsails filling the top third. Everything the brief asks for is in
 *   frame at once, and nothing is centred.
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

    localToWorld(frame, anatomy.helmX + this.sway, anatomy.helmY, anatomy.helmZ, this.eye);
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
