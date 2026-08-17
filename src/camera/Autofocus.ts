import * as THREE from 'three';
import { damp } from '../util/math';

/**
 * Autofocus with a real focus pull.
 *
 * The rack runs in DIOPTRES (1/metres), not metres, because that is how a lens
 * barrel actually moves: the distance scale is compressed at the far end, so a
 * pull from 8 m to infinity travels barely any barrel while 1 m to 2 m travels a
 * lot. Interpolating in metres makes near racks feel instant and far racks feel
 * eternal; interpolating in dioptres feels like a focus puller's hand.
 */

const MIN_FOCUS_M = 0.35;
const MAX_FOCUS_M = 40000;
/** Barrel speed limit, dioptres/second — the "focus puller's hand" constant. */
const MAX_DIOPTRE_RATE = 1.1;
/** Earth radius used for the geometric horizon, metres. */
const EARTH_RADIUS_M = 6371000;

export class Autofocus {
  /** Metres. Written to `cam.focusDistance`. */
  distance = 80;
  private dioptre = 1 / 80;

  snap(target: number): void {
    const d = THREE.MathUtils.clamp(target, MIN_FOCUS_M, MAX_FOCUS_M);
    this.dioptre = 1 / d;
    this.distance = d;
  }

  /** @param rate exponential approach rate in dioptre space, per second. */
  update(dt: number, target: number, rate: number): void {
    const d = THREE.MathUtils.clamp(target, MIN_FOCUS_M, MAX_FOCUS_M);
    const want = 1 / d;
    const next = damp(this.dioptre, want, rate, dt);
    const maxStep = MAX_DIOPTRE_RATE * dt;
    this.dioptre += THREE.MathUtils.clamp(next - this.dioptre, -maxStep, maxStep);
    this.distance = 1 / Math.max(this.dioptre, 1 / MAX_FOCUS_M);
  }
}

/**
 * Geometric distance to the sea horizon for an eye `h` metres up, including the
 * standard 1.06 terrestrial-refraction factor. 10 m up == 12 km.
 */
export function horizonDistance(h: number): number {
  return Math.sqrt(2 * EARTH_RADIUS_M * Math.max(h, 0.4)) * 1.06;
}

/** 35 mm-equivalent focal length for a vertical FOV, on a 24 mm-high frame. */
export function focalLengthMm(fovDeg: number): number {
  return 12 / Math.tan(THREE.MathUtils.degToRad(fovDeg) * 0.5);
}
