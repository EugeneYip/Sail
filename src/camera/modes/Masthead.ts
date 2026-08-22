import * as THREE from 'three';
import {
  directionFrom,
  localToWorld,
  MAX_AXIS_ELEVATION,
  type CameraContext,
  type CameraMode,
  type CameraSolve,
} from '../CameraMode';

/**
 * From high on the main topmast, above the fighting top, looking down the sail
 * plan.
 *
 * Composition rules
 * -----------------
 * - Axis 33 deg down with a 74 deg lens. That places the horizon at 93% of frame
 *   height AT THE CENTRE COLUMN — a deliberate sliver of sky at the very top.
 *   Without it the shot is an abstract top-down and the height does not read;
 *   with it the eye has something to measure the drop against, which is what
 *   makes it vertiginous. Heel rolls that line, so on a beam reach it leaves the
 *   top edge on the windward side and sinks toward mid-frame on the other.
 * - The eye HEIGHT is derived from that axis, not read off the anatomy, because
 *   the two are one composition. The bottom edge of frame sits 70 deg below
 *   horizontal, so an eye h metres above the deck puts the deck's near edge
 *   h/tan(70 deg) forward of the mast and hides everything nearer.
 *   `DECK_NEAR_EDGE` fixes that distance and the height follows; read the other
 *   way, that identity is where this shot's original hard-coded 38 m came from.
 * - `anatomy.mainTopY` is a FLOOR on the height, not the height. It names the
 *   lower fighting top, and this shot cannot be taken from there. The ship
 *   publishes 25.85 m for this hull, which stands the eye 1.5 m above a platform
 *   5.7 m wide and 3.5 m fore-and-aft: the planking underfoot then takes 40% of
 *   the frame, the deck is entirely behind it, and the fore top is at eye level
 *   so the drop cannot read at all. See `notes/masthead-perch.md`.
 * - Seated 2.2 m to starboard of the mast axis and a little abaft it, so the mast
 *   is a vertical edge at the side of the frame rather than a pole through the
 *   middle, and the deck below is seen at an angle instead of straight down.
 * - Full heel is applied to the roll. At 36 m up, 8 deg of heel swings the eye
 *   5.0 m sideways over a 6-10 s period, and this ship carries 8-14 deg with the
 *   assist on. Filtering that away would throw out the entire reason to climb
 *   the mast.
 * - f/4.5 focused on the deck below. The lens is wide, so nearly everything is
 *   sharp; the aperture matters for the shot's near rigging only.
 */

const BASE_PITCH = -0.576; // 33 deg down
const FOV = 74;

/** Tangent of the bottom edge of frame below horizontal: 33 + 74/2 = 70 deg. */
const FRAME_BOTTOM_TAN = Math.tan(-BASE_PITCH + THREE.MathUtils.degToRad(FOV) * 0.5);

/**
 * Where the deck's near edge enters frame, metres forward of the mainmast.
 *
 * 11 m, not the 12 m this shot was first written for, and the metre is not
 * taste. 12 m puts the eye at 38.5 m, which on this rig is a metre above the
 * FOOT of the main topgallant: the lens ends up beside a 15 m sail and 40% of
 * the frame is canvas. 11 m lands it at 35.7 m, near the middle of the clear
 * band between the topsail's head (34.1 m) and the topgallant's foot (37.3 m).
 *
 * This module cannot see that band — the sail plan reaches the camera only as
 * `Collision`'s single cylinder — so the constant is tuned against captures
 * rather than derived. A topmast-head station on `ext.ship` would make it
 * derivable; until there is one, re-shoot `--scene masthead` if the rig moves.
 */
const DECK_NEAR_EDGE = 11;

/** Metres of mast left above the eye, so the truck stays something overhead. */
const TRUCK_CLEARANCE = 8;

/** Metres above the fighting top when the anatomy forces the floor. */
const STANDING_HEIGHT = 1.5;

export class MastheadMode implements CameraMode {
  readonly name = 'masthead';
  readonly lookYawLimit = Math.PI; // you are in a crow's nest: look anywhere
  /**
   * Derived from the composed axis rather than picked, so both poles are exactly
   * reachable: the axis starts 33 deg DOWN, so the range is asymmetric. The old
   * +0.75 stopped 40 deg short of the truck — from the crosstrees, with the
   * topmast and the royal yard right there, that was the wrong 40 deg to lose.
   */
  readonly lookPitchMin = -MAX_AXIS_ELEVATION - BASE_PITCH;
  readonly lookPitchMax = MAX_AXIS_ELEVATION - BASE_PITCH;

  private dir = new THREE.Vector3();
  private eye = new THREE.Vector3();

  enter(): void {}

  solve(ctx: CameraContext, out: CameraSolve): void {
    const { frame, anatomy } = ctx;

    // Bounded by the two stations the anatomy does name: never below the
    // platform the eye would otherwise be standing on, never above the truck.
    const floor = anatomy.mainTopY + STANDING_HEIGHT;
    const perchY = THREE.MathUtils.clamp(
      anatomy.deckY + DECK_NEAR_EDGE * FRAME_BOTTOM_TAN,
      floor,
      Math.max(floor, anatomy.mastheadY - TRUCK_CLEARANCE),
    );
    localToWorld(frame, anatomy.mainTopX, perchY, anatomy.mainTopZ, this.eye);
    out.position.copy(this.eye);

    const yaw = frame.heading + ctx.lookYaw;
    const pitch = THREE.MathUtils.clamp(
      BASE_PITCH + ctx.lookPitch + frame.pitch * 0.9,
      -MAX_AXIS_ELEVATION,
      MAX_AXIS_ELEVATION,
    );
    directionFrom(yaw, pitch, this.dir);
    out.target.copy(this.eye).addScaledVector(this.dir, 55);

    out.roll = frame.heel;
    out.fov = FOV;
    out.aperture = 4.5;
    out.focusMode = 'point';
    // Focus on the deck rather than the hull origin: the deck is what the eye
    // lands on and it is 31 m nearer than the horizon.
    frame.focusPoint(out.focusPoint, anatomy.deckY);
    out.focusRate = 3;
    out.shakeScale = 1.3; // amplified by the lever arm, like the real thing
    out.avoidHull = false;
    out.avoidRig = false;
    out.waterClearance = -50;
    out.shot = '';
  }
}
