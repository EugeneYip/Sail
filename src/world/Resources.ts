import * as THREE from 'three';
import { createPatchGeometry } from './HeightField';
import { createDetailTextures, createLeafTexture, createStoneTexture, type DetailTextures } from './procTex';

/**
 * GPU resources shared by every island: the unit CDLOD patch, the tiling
 * detail array textures and the two building/foliage atlases.
 *
 * Built lazily so a session that never streams an island pays nothing, and
 * reference-counted only in the trivial sense that the world module owns
 * exactly one instance and disposes it.
 */
export class WorldResources {
  readonly patchPos: THREE.BufferAttribute;
  readonly patchIdx: THREE.BufferAttribute;
  private detailTex: DetailTextures | null = null;
  private leaf: THREE.DataTexture | null = null;
  private stone: THREE.DataTexture | null = null;

  constructor() {
    const p = createPatchGeometry();
    this.patchPos = p.position;
    this.patchIdx = p.index;
  }

  get detail(): DetailTextures {
    if (!this.detailTex) this.detailTex = createDetailTextures();
    return this.detailTex;
  }

  get leafTexture(): THREE.DataTexture {
    if (!this.leaf) this.leaf = createLeafTexture(128);
    return this.leaf;
  }

  get stoneTexture(): THREE.DataTexture {
    if (!this.stone) this.stone = createStoneTexture(128);
    return this.stone;
  }

  dispose(): void {
    this.detailTex?.dispose();
    this.leaf?.dispose();
    this.stone?.dispose();
    this.detailTex = null;
    this.leaf = null;
    this.stone = null;
  }
}
