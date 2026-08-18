import * as THREE from 'three';
import type { Pose } from './Wrench';

/**
 * Rigid-body pose algebra for the solver.
 *
 * The orientation is carried as a 3x3 row-major body->world matrix in nine
 * doubles rather than a quaternion: the hot loops need to rotate a few hundred
 * vectors per substep and the matrix form does that with three multiply-adds
 * apiece. Drift is handled by re-orthonormalising every substep, which costs
 * about thirty flops and is cheaper than the branchy quaternion path.
 *
 * `m` maps body to world, so its COLUMNS are the ship's axes in world space:
 *   col0 = (m0, m3, m6) = starboard,  col1 = (m1, m4, m7) = up,
 *   col2 = (m2, m5, m8) = aft (the bow is -col2).
 * Its ROWS are the world axes in body space, which is what makes the
 * world-vertical extraction `(m1, m4, m7)` used all over `Hydro` correct.
 */

const scratch = new THREE.Matrix4();

/**
 * Point the bow at a compass bearing. Bearing 0 is world -Z and +90 deg is
 * world +X, so a bearing of `h` is a yaw of `-h` about +Y — rotating about +Y
 * swings the bow to PORT.
 */
export function setPoseHeading(pose: Pose, heading: number): void {
  const c = Math.cos(heading);
  const s = Math.sin(heading);
  const m = pose.m;
  // R_y(-heading).
  m[0] = c;
  m[1] = 0;
  m[2] = -s;
  m[3] = 0;
  m[4] = 1;
  m[5] = 0;
  m[6] = s;
  m[7] = 0;
  m[8] = c;
}

/**
 * Advance the orientation by a body-frame rotation vector (radians, already
 * multiplied by the timestep). Exact Rodrigues rather than a first-order
 * update, because a 12 s roll at 30 fps is a 3 deg step and the first-order
 * form pumps energy into it.
 */
export function integrateRotation(pose: Pose, tx: number, ty: number, tz: number): void {
  const angle = Math.sqrt(tx * tx + ty * ty + tz * tz);
  let r0: number;
  let r1: number;
  let r2: number;
  let r3: number;
  let r4: number;
  let r5: number;
  let r6: number;
  let r7: number;
  let r8: number;
  if (angle < 1e-12) {
    r0 = 1;
    r1 = -tz;
    r2 = ty;
    r3 = tz;
    r4 = 1;
    r5 = -tx;
    r6 = -ty;
    r7 = tx;
    r8 = 1;
  } else {
    const ax = tx / angle;
    const ay = ty / angle;
    const az = tz / angle;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const t = 1 - c;
    r0 = c + ax * ax * t;
    r1 = ax * ay * t - az * s;
    r2 = ax * az * t + ay * s;
    r3 = ay * ax * t + az * s;
    r4 = c + ay * ay * t;
    r5 = ay * az * t - ax * s;
    r6 = az * ax * t - ay * s;
    r7 = az * ay * t + ax * s;
    r8 = c + az * az * t;
  }

  const m = pose.m;
  const a0 = m[0];
  const a1 = m[1];
  const a2 = m[2];
  const a3 = m[3];
  const a4 = m[4];
  const a5 = m[5];
  const a6 = m[6];
  const a7 = m[7];
  const a8 = m[8];
  m[0] = a0 * r0 + a1 * r3 + a2 * r6;
  m[1] = a0 * r1 + a1 * r4 + a2 * r7;
  m[2] = a0 * r2 + a1 * r5 + a2 * r8;
  m[3] = a3 * r0 + a4 * r3 + a5 * r6;
  m[4] = a3 * r1 + a4 * r4 + a5 * r7;
  m[5] = a3 * r2 + a4 * r5 + a5 * r8;
  m[6] = a6 * r0 + a7 * r3 + a8 * r6;
  m[7] = a6 * r1 + a7 * r4 + a8 * r7;
  m[8] = a6 * r2 + a7 * r5 + a8 * r8;
}

/** Gram-Schmidt the body axes back to orthonormal. Kills integration drift. */
export function orthonormalize(pose: Pose): void {
  const m = pose.m;
  let x0 = m[0];
  let x1 = m[3];
  let x2 = m[6];
  let l = Math.sqrt(x0 * x0 + x1 * x1 + x2 * x2);
  if (l < 1e-9) {
    setPoseHeading(pose, 0);
    return;
  }
  x0 /= l;
  x1 /= l;
  x2 /= l;

  let y0 = m[1];
  let y1 = m[4];
  let y2 = m[7];
  const d = x0 * y0 + x1 * y1 + x2 * y2;
  y0 -= d * x0;
  y1 -= d * x1;
  y2 -= d * x2;
  l = Math.sqrt(y0 * y0 + y1 * y1 + y2 * y2);
  if (l < 1e-9) {
    setPoseHeading(pose, 0);
    return;
  }
  y0 /= l;
  y1 /= l;
  y2 /= l;

  // z = x cross y keeps the frame right-handed by construction.
  const z0 = x1 * y2 - x2 * y1;
  const z1 = x2 * y0 - x0 * y2;
  const z2 = x0 * y1 - x1 * y0;

  m[0] = x0;
  m[3] = x1;
  m[6] = x2;
  m[1] = y0;
  m[4] = y1;
  m[7] = y2;
  m[2] = z0;
  m[5] = z1;
  m[8] = z2;
}

/** Compass bearing of the bow, radians, 0 = north. */
export function poseHeading(pose: Pose): number {
  const m = pose.m;
  // Bow in world = -col2 = (-m2, -m5, -m8); bearing b has direction (sin b, -cos b).
  return Math.atan2(-m[2], m[8]);
}

/** Heel, radians. Positive = starboard rail down. */
export function poseHeel(pose: Pose): number {
  const m = pose.m;
  // Starboard axis in world is (m0, m3, m6); the rail goes down as m3 goes
  // negative. Dividing by the mast's world-up component keeps it sane at pitch.
  return Math.atan2(-m[3], m[4]);
}

/** Pitch, radians. Positive = bow up. */
export function posePitch(pose: Pose): number {
  return Math.asin(THREE.MathUtils.clamp(-pose.m[5], -1, 1));
}

export function poseToQuaternion(pose: Pose, out: THREE.Quaternion): void {
  const m = pose.m;
  scratch.set(m[0], m[1], m[2], 0, m[3], m[4], m[5], 0, m[6], m[7], m[8], 0, 0, 0, 0, 1);
  out.setFromRotationMatrix(scratch);
}
