import * as THREE from 'three';
import type { World } from '../../types';
import type { PartUniforms } from '../materials/materials';
import type { TexSet } from '../materials/textures';
import type { RigFrame } from './masts';

export interface SailResult {
  group: THREE.Group;
  meshes: THREE.Mesh[];
  update(world: World): void;
  applySettings(quality: number): void;
  dispose(): void;
}

export function buildSails(
  world: World,
  parts: PartUniforms,
  canvas: TexSet,
  frame: RigFrame,
  quality: number,
): SailResult {
  void world;
  void parts;
  void canvas;
  void frame;
  void quality;
  const group = new THREE.Group();
  return {
    group,
    meshes: [],
    update() {},
    applySettings() {},
    dispose() {},
  };
}
