import type { Module } from '../types';
import { CameraRig } from './CameraRig';

/** Owned by the camera agent. Add internal modules here, in update order. */
export function createCameraModules(): Module[] {
  return [new CameraRig()];
}
