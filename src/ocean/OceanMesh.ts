import * as THREE from 'three';

/**
 * Camera-centred geometry clipmap.
 *
 * Level 0 is a solid grid of `m` x `m` cells with half-extent H0; level k is a
 * square annulus with half-extent H0*2^k whose hole is exactly the previous
 * level's footprint, so cell size doubles per level. Because the ring extent and
 * the cell size scale together, a cell projects to a constant ~2*f/m pixels at
 * every distance — triangle density is uniform in screen space without a
 * projected grid's degenerate cases.
 *
 * Cracks are closed by the CDLOD morph: in the outer band of each level, odd
 * grid vertices slide onto their even neighbour, so by the shared boundary the
 * fine level's polyline is exactly the coarse level's. See `surface.ts`.
 *
 * The last ring is a flat skirt that rises to eye height at 55 km. An infinite
 * flat ocean's horizon sits exactly at eye level; a finite one leaves a
 * sub-pixel sliver of sky underneath it. Lifting the outermost edge to eye
 * height closes that seam, and it happens far enough out to be fully
 * fog-saturated, so the tilt cannot be seen.
 */

/** Half-extent of the innermost level, metres. */
export const CLIPMAP_H0 = 48;
/** Ring levels, so the displaced field reaches ~24 km. */
export const CLIPMAP_LEVELS = 10;
/**
 * Outer radius of the flat horizon skirt, metres. Twice the last ring's extent,
 * because a ring's hole is always half its own extent — that makes the skirt's
 * inner edge land exactly on the last ring's outer edge. Inside the 60 km far
 * plane.
 */
export const HORIZON_RADIUS = CLIPMAP_H0 * Math.pow(2, CLIPMAP_LEVELS);

export interface ClipmapLevel {
  mesh: THREE.Mesh;
  /** Metres per grid unit. */
  cell: number;
  halfExtent: number;
  level: number;
}

function gridGeometry(m: number, hollow: boolean, isSkirt = false): THREE.BufferGeometry {
  const side = m + 1;
  const pos = new Float32Array(side * side * 3);
  // (half extent in grid units, skirt flag). Constant per geometry, but the
  // vertex shader needs both and a geometry is shared by many meshes, so an
  // attribute is the cheapest place to put them.
  const meta = new Float32Array(side * side * 2);
  for (let j = 0; j <= m; j++) {
    for (let i = 0; i <= m; i++) {
      const o = (j * side + i) * 3;
      pos[o] = i - m / 2;
      pos[o + 1] = 0;
      pos[o + 2] = j - m / 2;
      const q = (j * side + i) * 2;
      meta[q] = m / 2;
      meta[q + 1] = isSkirt ? 1 : 0;
    }
  }
  const hole = m / 4; // quarter of the side on each axis from the centre
  const idx: number[] = [];
  for (let j = 0; j < m; j++) {
    for (let i = 0; i < m; i++) {
      if (hollow) {
        const cx = i - m / 2;
        const cz = j - m / 2;
        // Skip the quads covered by the finer level.
        if (cx >= -hole && cx < hole && cz >= -hole && cz < hole) continue;
      }
      const a = j * side + i;
      const b = a + 1;
      const c = a + side;
      const d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aMeta', new THREE.BufferAttribute(meta, 2));
  geo.setIndex(idx);
  // Bounds are meaningless for a shader-displaced camera-centred mesh.
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
  return geo;
}

export class OceanMesh {
  readonly group = new THREE.Group();
  readonly levels: ClipmapLevel[] = [];
  private solid: THREE.BufferGeometry;
  private ring: THREE.BufferGeometry;
  private horizon: THREE.BufferGeometry;

  constructor(m: number, material: THREE.Material) {
    this.solid = gridGeometry(m, false);
    this.ring = gridGeometry(m, true);
    // The skirt carries no detail; 16 cells a side is plenty.
    this.horizon = gridGeometry(16, true, true);

    this.group.name = 'ocean';
    this.group.frustumCulled = false;

    for (let k = 0; k < CLIPMAP_LEVELS; k++) {
      const halfExtent = CLIPMAP_H0 * Math.pow(2, k);
      const geo = k === 0 ? this.solid : this.ring;
      const mesh = new THREE.Mesh(geo, material);
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      // Ocean.updateClipmap writes matrixWorld directly every frame; letting
      // three recompute it would just undo that.
      mesh.matrixAutoUpdate = false;
      mesh.matrixWorldAutoUpdate = false;
      this.group.add(mesh);
      this.levels.push({ mesh, cell: (2 * halfExtent) / m, halfExtent, level: k });
    }

    const skirt = new THREE.Mesh(this.horizon, material);
    skirt.frustumCulled = false;
    skirt.castShadow = false;
    skirt.receiveShadow = false;
    skirt.matrixAutoUpdate = false;
    skirt.matrixWorldAutoUpdate = false;
    this.group.add(skirt);
    this.levels.push({
      mesh: skirt,
      cell: (2 * HORIZON_RADIUS) / 16,
      halfExtent: HORIZON_RADIUS,
      level: CLIPMAP_LEVELS,
    });
  }

  dispose(): void {
    this.solid.dispose();
    this.ring.dispose();
    this.horizon.dispose();
  }
}
