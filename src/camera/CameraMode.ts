import * as THREE from 'three';
import type { World } from '../types';
import type { ShipAnatomy } from './Anatomy';
import type { ShipFrame } from './ShipFrame';

/** What autofocus should lock onto. */
export type FocusMode = 'point' | 'horizon' | 'fixed';

/**
 * A mode's output for one frame. Modes own their own smoothing and return an
 * already-settled eye and look target; the rig then applies collision, shake,
 * FOV and focus on top. One instance is shared and rewritten every frame — no
 * mode may keep a reference to it.
 */
export class CameraSolve {
  readonly position = new THREE.Vector3();
  readonly target = new THREE.Vector3();
  /**
   * Where the collision whiskers start. The rig pre-fills this with a point
   * inside the hull before every solve, which is the right origin for a camera
   * that orbits the ship; a mode with a different subject (a yardarm, the bow)
   * overwrites it. It must be a point the camera is allowed to see.
   */
  readonly pivot = new THREE.Vector3();
  /** Extra roll about the view axis, radians. */
  roll = 0;
  /** Base vertical FOV in degrees, before the user's `settings.fov` offset. */
  fov = 58;
  aperture = 4;
  focusMode: FocusMode = 'point';
  readonly focusPoint = new THREE.Vector3();
  /** Used when focusMode === 'fixed'. */
  focusFixed = 100;
  /** Dioptre-space rack rate; lower = slower, more deliberate pull. */
  focusRate = 3.2;
  /** 0 disables shake for this mode. */
  shakeScale = 1;
  avoidHull = true;
  avoidRig = false;
  /** Metres of clearance to hold above water/terrain. Negative permits a dip. */
  waterClearance = 1.6;
  /**
   * Final output filter, seconds of smooth time, applied by the rig on top of
   * whatever the mode already did. Zero for anything bolted to the ship — a
   * deck camera that lags its mount reads as the deck sliding under your feet.
   * Detached cameras want a little, and the target wants MORE than the position
   * so the hull drifts within the frame instead of being pinned to it.
   */
  posSmoothTime = 0;
  targetSmoothTime = 0;
  /** True on the frame this mode cut to a new shot. */
  cut = false;
  /** Sub-shot id, published on `ext.camera.shot`. */
  shot = '';

  reset(): void {
    this.roll = 0;
    this.posSmoothTime = 0;
    this.targetSmoothTime = 0;
    this.fov = 58;
    this.aperture = 4;
    this.focusMode = 'point';
    this.focusFixed = 100;
    this.focusRate = 3.2;
    this.shakeScale = 1;
    this.avoidHull = true;
    this.avoidRig = false;
    this.waterClearance = 1.6;
    this.cut = false;
    this.shot = '';
  }
}

export interface CameraContext {
  world: World;
  dt: number;
  frame: ShipFrame;
  anatomy: ShipAnatomy;
  /** Free-look, ship-relative, already clamped to the mode's limits. */
  lookYaw: number;
  lookPitch: number;
  /** Seconds since this mode was entered. */
  modeTime: number;
  /**
   * True while the rig is holding a deterministic pose for a screenshot. Modes
   * must stop all autonomous motion (orbit drift, cinematic cuts) once their
   * intro move has finished, so two captures of the same build match.
   */
  captureHold: boolean;
  /** Seconds since `capture:scene`, or since the mode was set externally. */
  captureTime: number;
}

export interface CameraMode {
  readonly name: string;
  /** Free-look yaw limit, radians. 0 disables yaw look. */
  readonly lookYawLimit: number;
  readonly lookPitchMin: number;
  readonly lookPitchMax: number;
  /** True when the mode reads `input.lookYaw/lookPitch` itself (free-cam). */
  readonly ownsLook?: boolean;
  /**
   * Rate, per second, at which free-look decays back to the mode's composed
   * axis once the player stops dragging. Only the framed modes want this: a
   * first-person view that slowly turns your head for you is horrible.
   */
  readonly lookRecentreRate?: number;
  /** Clamp applied to `cam.distance` while this mode is active. */
  readonly distanceRange?: readonly [number, number];
  /** Called on every entry to the mode, including externally-set ones. */
  enter(ctx: CameraContext, out: CameraSolve): void;
  solve(ctx: CameraContext, out: CameraSolve): void;
  /** Floating-origin rebase. */
  shift?(dx: number, dy: number, dz: number): void;
}

/** Convert a ship-local offset to world space using the filtered attitude. */
export function localToWorld(
  frame: ShipFrame,
  x: number,
  y: number,
  z: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  return out.set(x, y, z).applyQuaternion(frame.smoothQuat).add(frame.mountPos);
}

/**
 * Place a point relative to the follow anchor using only the filtered heading —
 * no heel or pitch. Detached cameras must not inherit the hull's attitude or
 * they inherit its motion too.
 */
export function anchorRelative(
  frame: ShipFrame,
  side: number,
  forward: number,
  height: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  const f = frame.forward;
  const r = frame.right;
  return out.set(
    frame.anchor.x + r.x * side + f.x * forward,
    frame.anchor.y + height,
    frame.anchor.z + r.z * side + f.z * forward,
  );
}

/** Unit direction from a bearing (0 = north = -Z) and an elevation. */
export function directionFrom(
  bearing: number,
  elevation: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  const ce = Math.cos(elevation);
  return out.set(Math.sin(bearing) * ce, Math.sin(elevation), -Math.cos(bearing) * ce);
}

/**
 * Aim at `subject` but rotate the axis off it, which is how you place a subject
 * at a chosen point in frame: `yawOff` degrees of axis rotation put the subject
 * `yawOff` degrees the other way on screen. Positive yawOff moves the subject
 * left, positive pitchOff moves it down.
 *
 * `elevClamp` optionally bounds the resulting axis elevation, which is how the
 * low shots keep the horizon out of the middle of the frame while still tracking
 * a moving subject.
 */
export function aimOffset(
  eye: THREE.Vector3,
  subject: THREE.Vector3,
  yawOff: number,
  pitchOff: number,
  out: THREE.Vector3,
  elevMin = -Math.PI * 0.49,
  elevMax = Math.PI * 0.49,
): THREE.Vector3 {
  const dx = subject.x - eye.x;
  const dy = subject.y - eye.y;
  const dz = subject.z - eye.z;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
  const bearing = Math.atan2(dx, -dz) + yawOff;
  const elev = THREE.MathUtils.clamp(Math.asin(dy / len) + pitchOff, elevMin, elevMax);
  const ce = Math.cos(elev);
  return out.set(
    eye.x + Math.sin(bearing) * ce * len,
    eye.y + Math.sin(elev) * len,
    eye.z - Math.cos(bearing) * ce * len,
  );
}
