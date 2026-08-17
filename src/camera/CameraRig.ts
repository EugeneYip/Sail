import * as THREE from 'three';
import type { Module, World } from '../types';

/** PLACEHOLDER — replaced by the cinematic multi-mode rig. */
export class CameraRig implements Module {
  readonly name = 'camera';
  private pos = new THREE.Vector3(0, 30, 90);
  private look = new THREE.Vector3();

  init(): void {}

  update(world: World): void {
    const t = world.shipRoot.position;
    const h = world.ship.heading;
    const back = new THREE.Vector3(-Math.sin(h), 0, Math.cos(h)).multiplyScalar(world.cam.distance);
    const want = new THREE.Vector3(t.x + back.x, t.y + 26, t.z + back.z);
    const k = 1 - Math.exp(-2.2 * world.time.dt);
    this.pos.lerp(want, k);
    this.look.lerp(new THREE.Vector3(t.x, t.y + 14, t.z), k);
    world.camera.position.copy(this.pos);
    world.camera.lookAt(this.look);
    world.cam.focusDistance = this.pos.distanceTo(this.look);
  }
}
