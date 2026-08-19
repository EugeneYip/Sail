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
 * A ring's hole is therefore not a property of the ring: it has to be cut around
 * whatever square the finer level is currently occupying, which is up to one of
 * this ring's cells off this ring's own centre (see `Ocean.updateClipmap`). Each
 * ring size is built once per hole displacement, all nine sharing one set of
 * vertices, and the frame picks the one that frames the level below it.
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

interface GridAttributes {
  position: THREE.BufferAttribute;
  aMeta: THREE.BufferAttribute;
}

/**
 * Vertex data for an `m` x `m` grid of unit cells centred on the origin, shared
 * by every tile of that size: the hole variants differ only in which quads they
 * index, so there is no reason to hold nine copies of the vertices.
 */
function gridAttributes(m: number, isSkirt: boolean): GridAttributes {
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
  return {
    position: new THREE.BufferAttribute(pos, 3),
    aMeta: new THREE.BufferAttribute(meta, 2),
  };
}

/**
 * One tile. `hole` is the half-extent in cells of the centre left uncovered for
 * the finer level (0 for a solid tile), displaced by (ox, oz) whole cells so a
 * ring can frame a level whose centre is not its own.
 */
function tileGeometry(
  attrs: GridAttributes,
  m: number,
  hole: number,
  ox = 0,
  oz = 0,
): THREE.BufferGeometry {
  const side = m + 1;
  const idx: number[] = [];
  for (let j = 0; j < m; j++) {
    for (let i = 0; i < m; i++) {
      if (hole > 0) {
        const cx = i - m / 2;
        const cz = j - m / 2;
        // Skip the quads covered by the finer level.
        if (cx >= ox - hole && cx < ox + hole && cz >= oz - hole && cz < oz + hole) continue;
      }
      const a = j * side + i;
      const b = a + 1;
      const c = a + side;
      const d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', attrs.position);
  geo.setAttribute('aMeta', attrs.aMeta);
  geo.setIndex(idx);
  // Bounds are meaningless for a shader-displaced camera-centred mesh.
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
  return geo;
}

export class OceanMesh {
  readonly group = new THREE.Group();
  readonly levels: ClipmapLevel[] = [];
  private solid: THREE.BufferGeometry;
  /** Rings by hole displacement, indexed `(oz + 1) * 3 + (ox + 1)`. */
  private rings: THREE.BufferGeometry[] = [];
  private horizon: THREE.BufferGeometry;

  constructor(m: number, material: THREE.Material) {
    const attrs = gridAttributes(m, false);
    this.solid = tileGeometry(attrs, m, 0);
    for (let oz = -1; oz <= 1; oz++) {
      for (let ox = -1; ox <= 1; ox++) this.rings.push(tileGeometry(attrs, m, m / 4, ox, oz));
    }
    // The skirt carries no detail; 16 cells a side is plenty.
    this.horizon = tileGeometry(gridAttributes(16, true), 16, 4);

    this.group.name = 'ocean';
    this.group.frustumCulled = false;

    for (let k = 0; k < CLIPMAP_LEVELS; k++) {
      const halfExtent = CLIPMAP_H0 * Math.pow(2, k);
      const geo = k === 0 ? this.solid : this.ringGeometry(0, 0);
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

  /**
   * The ring whose hole sits (ox, oz) cells off its centre. Clamped: a hole one
   * cell further out than it should be is a seam, an undefined geometry is a
   * black screen.
   */
  ringGeometry(ox: number, oz: number): THREE.BufferGeometry {
    const cx = THREE.MathUtils.clamp(ox, -1, 1) + 1;
    const cz = THREE.MathUtils.clamp(oz, -1, 1) + 1;
    return this.rings[cz * 3 + cx];
  }

  dispose(): void {
    this.solid.dispose();
    for (const ring of this.rings) ring.dispose();
    this.horizon.dispose();
  }
}
