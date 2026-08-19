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
  /**
   * Free-look, ship-relative, already clamped to the mode's limits.
   *
   * SIGN CONTRACT — direct manipulation, and every mode must obey it:
   * positive `lookYaw` swings the VIEW to starboard (dragging right looks
   * right), positive `lookPitch` tilts the view UP (dragging up looks up).
   * For an orbiting mode "the view swings to starboard" means the EYE travels
   * to port and the eye DROPS to look up, which is where the sign errors keep
   * coming from — derive it from the view direction, never from the eye.
   */
  lookYaw: number;
  lookPitch: number;
  /**
   * This frame's RAW look deltas, radians, sign-normalised to the contract
   * above but neither accumulated nor clamped.
   *
   * Only an `ownsLook` mode (the fly-cam) should read these; every other mode
   * wants `lookYaw`/`lookPitch`, which are accumulated, clamped to the mode's
   * limits and smoothed. They exist because reading `world.input.lookYaw`
   * directly bypasses the sign normalisation, which is exactly how the fly-cam
   * ended up the one mode still inverted after the rest were fixed.
   */
  lookYawDelta: number;
  lookPitchDelta: number;
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

/**
 * How close to straight up or down any look axis may get, radians (83 deg).
 *
 * For a first-person view this is the ONLY pitch limit needed. The per-mode neck
 * limits these modes used to carry (+72 deg at the helm, -60 at the masthead)
 * were taste dressed up as anatomy, and between them they stopped the player
 * looking at the one thing a tall ship is for: the rig, directly overhead. What
 * genuinely must not happen is the axis reaching vertical, where the world-up
 * basis the rig's `lookAt` uses degenerates and the roll snaps through 180 deg.
 *
 * A mode whose composed axis is not level should derive its look limits FROM
 * this and its own base pitch (`MAX_AXIS_ELEVATION - BASE_PITCH` and
 * `-MAX_AXIS_ELEVATION - BASE_PITCH`) rather than hard-coding a pair. That way
 * the player can always reach both poles and never accumulates look angle that
 * does nothing — which is what a limit set too tight and a limit set too loose
 * respectively feel like.
 */
export const MAX_AXIS_ELEVATION = 1.45;

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
 *
 * `side` is metres to STARBOARD, `forward` metres toward the bow, `height`
 * metres above the anchor (which sits at the hull's filtered mean waterline).
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

/**
 * Place an AIM POINT relative to the ship's actual position.
 *
 * The counterpart to `anchorRelative`, and the difference is the whole reason
 * both exist. `frame.anchor` is heavily filtered — a 1.4 m dead zone and a
 * 0.55 s spring — which is right for an EYE, because that filtering is what
 * stops the camera chasing integrator chatter. It is wrong for a TARGET: the
 * lag is several metres at speed, and a camera on the beam sees that lag
 * side-on, so the subject sits permanently off-axis. That is what pushed the
 * jibboom off the right edge of the `orbit` capture (`DIAGNOSIS.md` section 10).
 *
 * So: eyes ride the anchor, aim points ride the ship. The height still comes
 * from the anchor, because the vertical channel is the one place the filtering
 * is doing visible good — it is what lets the hull rise and fall inside the
 * frame instead of being pinned to it.
 */
export function subjectRelative(
  frame: ShipFrame,
  side: number,
  forward: number,
  height: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  const f = frame.forward;
  const r = frame.right;
  return out.set(
    frame.mountPos.x + r.x * side + f.x * forward,
    frame.anchor.y + height,
    frame.mountPos.z + r.z * side + f.z * forward,
  );
}

/**
 * Elevation of an orbiting eye after free-look pitch, radians above the anchor.
 *
 * The composed pose is given as a horizontal `radius` and a `height`; the eye
 * then rides the sphere through that point, so zero look reproduces the composed
 * pose EXACTLY and the framing constants stay meaningful. Positive `lookPitch`
 * tilts the axis up, which lowers the eye (see the sign contract on
 * `CameraContext`).
 *
 * Both bounds are physical, not taste: `minHeight` is how close to the sea the
 * lens may get before the water clamp would take over anyway, and `maxElevation`
 * stops short of vertical, where a world-up look-at basis degenerates.
 */
export function orbitElevation(
  radius: number,
  height: number,
  lookPitch: number,
  minHeight: number,
  maxElevation: number,
): number {
  const r = Math.hypot(radius, height) || 1;
  const floor = Math.asin(THREE.MathUtils.clamp(minHeight / r, -1, 1));
  return THREE.MathUtils.clamp(
    Math.atan2(height, radius) - lookPitch,
    Math.min(floor, maxElevation),
    maxElevation,
  );
}

/**
 * The pitch the orbit could NOT absorb, to be spent tilting the AXIS instead.
 *
 * Without this, free-look pitch simply dies against the sea floor: the player
 * drags up, the eye stops descending, and nothing further happens — the exact
 * "invisible wall" the owner objected to on the yaw axis. With it, the look
 * continues as a pan, so dragging up from a lens already at sea level stands the
 * rig against the sky, which is what the player was reaching for.
 *
 * `maxTilt` is the only limit that matters here and it IS physical: the target
 * height goes as `tan(tilt)`, so the axis must stop well short of vertical or
 * the aim point runs to infinity and the world-up look-at basis degenerates.
 */
export function orbitAxisTilt(
  radius: number,
  height: number,
  lookPitch: number,
  elevation: number,
  maxTilt: number,
): number {
  const want = Math.atan2(height, radius) - lookPitch;
  return THREE.MathUtils.clamp(elevation - want, -maxTilt, maxTilt);
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
