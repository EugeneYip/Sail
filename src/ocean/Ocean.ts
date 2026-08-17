import * as THREE from 'three';
import type { IOcean, Module, WaveSample, World } from '../types';

/**
 * PLACEHOLDER — replaced by the FFT ocean.
 * Kept only so the engine boots; implements the full IOcean contract.
 */
export class Ocean implements Module, IOcean {
  readonly name = 'ocean';
  readonly seaLevel = 0;
  private mesh!: THREE.Mesh;
  private t = 0;

  init(world: World): void {
    const geo = new THREE.PlaneGeometry(20000, 20000, 1, 1).rotateX(-Math.PI / 2);
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0.02, 0.09, 0.14),
      roughness: 0.08,
      metalness: 0,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.name = 'ocean-placeholder';
    world.scene.add(this.mesh);
    world.ocean = this;
  }

  update(world: World): void {
    this.t = world.time.elapsed;
    const c = world.camera.position;
    this.mesh.position.set(c.x, 0, c.z);
  }

  sampleHeight(x: number, z: number): number {
    return Math.sin(x * 0.03 + this.t * 0.9) * 0.55 + Math.cos(z * 0.021 - this.t * 0.7) * 0.4;
  }

  sample(x: number, z: number, out: WaveSample): WaveSample {
    const e = 0.5;
    out.height = this.sampleHeight(x, z);
    out.dx = 0;
    out.dz = 0;
    const hx = this.sampleHeight(x + e, z) - this.sampleHeight(x - e, z);
    const hz = this.sampleHeight(x, z + e) - this.sampleHeight(x, z - e);
    out.normal.set(-hx / (2 * e), 1, -hz / (2 * e)).normalize();
    out.velocity.set(0, 0, 0);
    return out;
  }
}

export function createWaveSample(): WaveSample {
  return { height: 0, dx: 0, dz: 0, normal: new THREE.Vector3(0, 1, 0), velocity: new THREE.Vector3() };
}
