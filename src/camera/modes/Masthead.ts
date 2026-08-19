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
 * From the main topmast crosstrees, 38 m up, looking down the sail plan.
 *
 * Composition rules
 * -----------------
 * - Seated 2.2 m to starboard of the mast axis, so the mast itself is a vertical
 *   edge at the side of the frame rather than a pole through the middle, and the
 *   deck below is seen at an angle instead of straight down.
 * - Axis 33 deg down with a 74 deg lens. That places the horizon at 93% of frame
 *   height — a deliberate sliver of sky at the very top. Without it the shot is
 *   an abstract top-down and the height does not read; with it the eye has
 *   something to measure the drop against, which is what makes it vertiginous.
 * - The deck is visible from 12 m forward of the mainmast all the way to the
 *   bow, running out of frame as a converging wedge. The main yard's arms are at
 *   -45 deg either side, so the yard crosses the bottom corners as a strong
 *   diagonal, and the fore mast's yards stack below and beyond it.
 * - Full heel is applied to the roll. At 38 m up, 8 deg of heel swings the eye
 *   5.3 m sideways over a 6-10 s period. Filtering that away would throw out the
 *   entire reason to climb the mast.
 * - f/4.5 focused on the deck below. The lens is wide, so nearly everything is
 *   sharp; the aperture matters for the shot's near rigging only.
 */

const BASE_PITCH = -0.576; // 33 deg down
const FOV = 74;

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

    localToWorld(frame, anatomy.mainTopX, anatomy.mainTopY, anatomy.mainTopZ, this.eye);
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
    // lands on and it is 33 m nearer than the horizon.
    frame.focusPoint(out.focusPoint, anatomy.deckY);
    out.focusRate = 3;
    out.shakeScale = 1.3; // amplified by the lever arm, like the real thing
    out.avoidHull = false;
    out.avoidRig = false;
    out.waterClearance = -50;
    out.shot = '';
  }
}
