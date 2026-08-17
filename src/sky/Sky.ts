import * as THREE from 'three';
import type { Module, World } from '../types';

/** PLACEHOLDER — replaced by physically based atmosphere + volumetric clouds. */
export class Sky implements Module {
  readonly name = 'sky';
  private sun!: THREE.DirectionalLight;
  private hemi!: THREE.HemisphereLight;

  init(world: World): void {
    world.scene.background = new THREE.Color(0.35, 0.52, 0.74);
    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.setScalar(world.settings.shadowMapSize);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 400;
    const c = this.sun.shadow.camera;
    c.left = -120; c.right = 120; c.top = 120; c.bottom = -120;
    c.updateProjectionMatrix();
    world.scene.add(this.sun, this.sun.target);
    this.hemi = new THREE.HemisphereLight(0x88aadd, 0x0a1a22, 0.6);
    world.scene.add(this.hemi);
  }

  update(world: World): void {
    const d = world.env.sunDirection;
    const p = world.shipRoot.position;
    this.sun.position.set(p.x + d.x * 200, p.y + d.y * 200, p.z + d.z * 200);
    this.sun.target.position.copy(p);
    world.uniforms.uSunDirection.value.copy(d);
  }
}
