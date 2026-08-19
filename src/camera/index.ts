import type { Module } from '../types';
import { CameraRig } from './CameraRig';

/**
 * Owned by the camera agent. Add internal modules here, in update order.
 *
 * The rig is one module on purpose: modes, collision, shake and the lens all
 * have to run between the ship's transform and the render, in that order, and
 * splitting them into separate `Module`s would only add a way to get the order
 * wrong. Everything else in this directory is a plain class the rig drives.
 *
 * Layout
 *   CameraRig.ts   dispatch, output filters, collision, shake, lens, publishing
 *   ShipFrame.ts   the filtered ship transform every mode follows (anti-jitter)
 *   modes/*.ts     composition only: where the eye goes, what it looks at
 *   Collision.ts   hull + sail-plan proxies, ocean and terrain probes
 *   Noise.ts       gradient-noise rotational shake
 *   Autofocus.ts   dioptre-space focus pull
 *   Anatomy.ts     where the cameras bolt on, overridable via `ext.ship`
 *   ext.ts         the `world.ext.camera` contract (post + audio read it)
 *
 * STATUS — rig wired, all seven modes live, capture hold implemented. Known
 * gaps are listed at the end of `CameraRig.ts`'s header comment.
 *
 * FREE LOOK — the one rule everything here depends on: positive `lookYaw`
 * swings the VIEW to starboard, positive `lookPitch` tilts it UP. Derive a mode's
 * pose from the view direction, never from where the eye ends up; an orbiting
 * camera has to move its eye the OPPOSITE way to swing the view, and that
 * inversion is where every sign error in this directory has come from. The
 * contract is on `CameraContext` and it is asserted, not eyeballed, by
 * `.tmp/camdrag.mjs` — four drag directions in seven modes, checked against the
 * resulting view axis. Run it after touching any look maths.
 *
 * Yaw is a full circle in every mode that follows the ship, because a player's
 * first instinct is to look at the bow. Pitch limits are physical only: the eye
 * may not go into the sea, and no axis may reach vertical (`MAX_AXIS_ELEVATION`,
 * where the world-up look-at basis degenerates).
 */
export function createCameraModules(): Module[] {
  return [new CameraRig()];
}
