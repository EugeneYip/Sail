/**
 * Solver frame types.
 *
 * `Wrench` is the force + torque accumulator, ship-body frame, torque taken
 * about the centre of gravity. Everything the solver computes lands here;
 * nothing allocates. `Pose` carries the body->world rotation as nine plain
 * numbers so the hot loops never touch a THREE.Matrix4.
 */

/** Rigid-body pose. `m` is row-major body->world: world = M * body. */
export interface Pose {
  /** World position of the centre of gravity. */
  x: number;
  y: number;
  z: number;
  m: Float64Array;
}

export function createPose(): Pose {
  const m = new Float64Array(9);
  m[0] = 1;
  m[4] = 1;
  m[8] = 1;
  return { x: 0, y: 0, z: 0, m };
}

/** Rotate a body-frame vector into world. Returns only the requested axis. */
export function bodyToWorldY(p: Pose, x: number, y: number, z: number): number {
  return p.m[3] * x + p.m[4] * y + p.m[5] * z;
}


export interface Wrench {
  fx: number;
  fy: number;
  fz: number;
  tx: number;
  ty: number;
  tz: number;
}

export function createWrench(): Wrench {
  return { fx: 0, fy: 0, fz: 0, tx: 0, ty: 0, tz: 0 };
}

export function clearWrench(w: Wrench): void {
  w.fx = 0;
  w.fy = 0;
  w.fz = 0;
  w.tx = 0;
  w.ty = 0;
  w.tz = 0;
}

/** Apply a body-frame force at a body-frame offset from the CG. */
export function addForceAt(
  w: Wrench,
  fx: number,
  fy: number,
  fz: number,
  rx: number,
  ry: number,
  rz: number,
): void {
  w.fx += fx;
  w.fy += fy;
  w.fz += fz;
  w.tx += ry * fz - rz * fy;
  w.ty += rz * fx - rx * fz;
  w.tz += rx * fy - ry * fx;
}

export function addTorque(w: Wrench, tx: number, ty: number, tz: number): void {
  w.tx += tx;
  w.ty += ty;
  w.tz += tz;
}
