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
 * gaps are listed at the end of `CameraRig.ts`'s header comment; the honest
 * one is that composition was tuned against a ship whose real geometry was
 * still being built, so the framing constants deserve one more pass once the
 * rig and sails are final.
 */
export function createCameraModules(): Module[] {
  return [new CameraRig()];
}
