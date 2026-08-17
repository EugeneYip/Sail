import * as THREE from 'three';
import type { Module, World } from '../types';

/** PLACEHOLDER — replaced by the procedural USS Constitution. */
export class Ship implements Module {
  readonly name = 'ship';

  init(world: World): void {
    const hull = new THREE.Mesh(
      new THREE.BoxGeometry(world.ship.beam, 8, world.ship.loa),
      new THREE.MeshStandardMaterial({ color: 0x5a4432, roughness: 0.7 }),
    );
    hull.position.y = 1;
    hull.castShadow = true;
    hull.receiveShadow = true;
    world.shipRoot.add(hull);

    for (let i = 0; i < 3; i++) {
      const mast = new THREE.Mesh(
        new THREE.CylinderGeometry(0.5, 0.7, 46, 8),
        new THREE.MeshStandardMaterial({ color: 0x3d2f22, roughness: 0.75 }),
      );
      mast.position.set(0, 25, -14 + i * 15);
      mast.castShadow = true;
      world.shipRoot.add(mast);
    }
  }

  update(world: World): void {
    world.shipRoot.position.copy(world.ship.position);
    world.shipRoot.quaternion.copy(world.ship.quaternion);
  }
}
