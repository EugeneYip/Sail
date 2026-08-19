import * as THREE from 'three';
import { directionFrom, type CameraContext, type CameraMode, type CameraSolve } from '../CameraMode';
import { damp, wrapPi } from '../../util/math';

/**
 * Untethered fly-cam for debugging. WASD to translate, R/F for up/down, mouse
 * to look, shift to boost. Not part of the player's C cycle unless
 * `settings.debug` is on; always reachable with V.
 *
 * Deliberately has no collision, no shake and no framing rules — its whole job
 * is to let you go and look at the thing that is broken.
 *
 * It is the one mode that accumulates its own look angles (`ownsLook`), because
 * a fly-cam's aim is world-absolute and must not recentre or clamp to a ship it
 * has flown away from. That is also how it stayed inverted after every other
 * mode was fixed: it read `world.input.lookYaw` directly and so skipped the sign
 * normalisation in the rig. It now reads `ctx.lookYawDelta`, which is the same
 * per-frame delta with the signs already corrected. Do not reach past it to
 * `world.input` again.
 */

const BASE_SPEED = 26; // m/s
const BOOST = 6;
const ACCEL_RATE = 6;
const FOV = 60;

export class FreeMode implements CameraMode {
  readonly name = 'free';
  readonly lookYawLimit = 0; // unclamped; handled internally
  readonly lookPitchMin = -1.48;
  readonly lookPitchMax = 1.48;
  readonly ownsLook = true;

  private pos = new THREE.Vector3();
  private vel = new THREE.Vector3();
  private yaw = 0;
  private pitch = 0;
  private dir = new THREE.Vector3();
  private right = new THREE.Vector3();
  private wish = new THREE.Vector3();

  enter(ctx: CameraContext): void {
    const cam = ctx.world.camera;
    this.pos.copy(cam.position);
    this.vel.set(0, 0, 0);
    // Adopt the current aim so entering free-cam never snaps the view.
    cam.getWorldDirection(this.dir);
    this.yaw = Math.atan2(this.dir.x, -this.dir.z);
    this.pitch = Math.asin(THREE.MathUtils.clamp(this.dir.y, -1, 1));
  }

  solve(ctx: CameraContext, out: CameraSolve): void {
    const { world, dt } = ctx;
    const input = world.input;

    if (!world.cam.locked && !input.uiFocus) {
      this.yaw = wrapPi(this.yaw + ctx.lookYawDelta);
      this.pitch = THREE.MathUtils.clamp(
        this.pitch + ctx.lookPitchDelta,
        this.lookPitchMin,
        this.lookPitchMax,
      );
    }
    directionFrom(this.yaw, this.pitch, this.dir);
    this.right.set(-this.dir.z, 0, this.dir.x).normalize();

    const fwd = (input.pressed('w') ? 1 : 0) - (input.pressed('s') ? 1 : 0);
    const strafe = (input.pressed('d') ? 1 : 0) - (input.pressed('a') ? 1 : 0);
    const lift = (input.pressed('r') ? 1 : 0) - (input.pressed('f') ? 1 : 0);
    const speed = BASE_SPEED * (input.pressed('shift') ? BOOST : 1);

    this.wish.set(0, 0, 0);
    this.wish.addScaledVector(this.dir, fwd);
    this.wish.addScaledVector(this.right, strafe);
    this.wish.y += lift;
    if (this.wish.lengthSq() > 1e-6) this.wish.normalize().multiplyScalar(speed);

    this.vel.x = damp(this.vel.x, this.wish.x, ACCEL_RATE, dt);
    this.vel.y = damp(this.vel.y, this.wish.y, ACCEL_RATE, dt);
    this.vel.z = damp(this.vel.z, this.wish.z, ACCEL_RATE, dt);
    this.pos.addScaledVector(this.vel, dt);

    out.position.copy(this.pos);
    out.target.copy(this.pos).addScaledVector(this.dir, 100);
    out.roll = 0;
    out.fov = FOV;
    out.aperture = 8;
    out.focusMode = 'point';
    ctx.frame.focusPoint(out.focusPoint, 12);
    out.focusRate = 4;
    out.shakeScale = 0;
    out.avoidHull = false;
    out.avoidRig = false;
    out.waterClearance = -1000;
    out.shot = '';
  }

  shift(dx: number, dy: number, dz: number): void {
    this.pos.set(this.pos.x + dx, this.pos.y + dy, this.pos.z + dz);
  }
}
