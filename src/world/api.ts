/**
 * World subsystem contract — the shape published on `world.ext.world`.
 *
 * Other subsystems may `import type { WorldExt } from '../world/api'` (types are
 * erased, so this is not a concrete-class dependency) and then:
 *
 *   const w = world.ext.world as WorldExt | undefined;
 *   const h = w?.sampleTerrainHeight(x, z) ?? DEEP;
 *
 * All query coordinates are RENDER space (i.e. the same space as
 * `ship.position` / `camera.position`), not absolute voyage coordinates. The
 * world translates itself on `origin:shift`, so render-space queries stay valid
 * across a floating-origin reset.
 */

import type * as THREE from 'three';

/** Height returned where there is no generated seabed — effectively "deep". */
export const DEEP_DEPTH = -140;

export interface LandQuery {
  /** Metres from the query point to the nearest above-water land. */
  distance: number;
  /** Compass bearing to that land, radians, 0 = north = -Z. */
  bearing: number;
  /** Render-space position of that land point (y = terrain height). */
  position: THREE.Vector3;
  /** Which island it belongs to. */
  islandId: number;
}

export interface IslandInfo {
  id: number;
  /** Integer site-tile coordinates this island was hashed out of. */
  tileX: number;
  tileZ: number;
  /** Render-space centre (y = 0). */
  center: THREE.Vector3;
  /** Alias of `center` — the chart instrument reads this name. */
  position: THREE.Vector3;
  /** Absolute voyage-space centre — stable across origin shifts. */
  absCenter: THREE.Vector3;
  /** Half-extent of the generated heightfield, metres. */
  halfExtent: number;
  /** Radius beyond which the island is certainly under water, metres. */
  landRadius: number;
  /** Alias of `landRadius`. */
  radius: number;
  /** Highest point, metres. */
  maxHeight: number;
  archetype: string;
  /** 0 = requested, 1 = heightfield ready, 2 = fully detailed. */
  stage: number;
}

export interface WorldLandmark {
  kind: string;
  /** Render-space position. */
  position: THREE.Vector3;
  /** Y rotation, radians. */
  rotation: number;
  islandId: number;
}

export interface WorldExt {
  /**
   * Terrain / seabed height at a render-space XZ, metres, sea level = 0.
   * Returns `DEEP_DEPTH` where no island is streamed. Cheap enough for a few
   * thousand calls per frame: one radius test per streamed island plus a
   * bilinear fetch.
   */
  sampleTerrainHeight(x: number, z: number): number;
  /** Positive water depth; 0 on or above the waterline. */
  sampleDepth(x: number, z: number): number;
  /** Nearest above-water land within `maxRadius` metres, else null. */
  nearestLand(x: number, z: number, maxRadius?: number): LandQuery | null;
  /**
   * Distance along `heading` (radians, 0 = north = -Z) until the seabed rises
   * above `-clearanceM`. Returns `maxDist` when the path is clear. Intended for
   * grounding avoidance and AI helmsmen.
   */
  clearanceAhead(x: number, z: number, heading: number, maxDist: number, clearanceM?: number): number;
  /** Every island currently streamed in, near first. */
  islands: IslandInfo[];
  /** Alias of `islands` — the streamed tile set. */
  tiles: IslandInfo[];
  /** Streamed landmarks, for camera framing and audio emitters. */
  landmarks: WorldLandmark[];
  /** Perf/debug counters. */
  stats: {
    islands: number;
    nodes: number;
    pending: number;
    genMsLast: number;
    genMsAvg: number;
    sliceMs: number;
    props: number;
  };
  seed: number;
  /** Called by the world itself on `origin:shift`; exposed for tests. */
  applyOriginShift(delta: THREE.Vector3): void;
}

/* ------------------------------------------------------------------ *
 *  Generation worker protocol (shared by main thread and gen.worker)
 * ------------------------------------------------------------------ */

export const ARCH = {
  volcanic: 0,
  atoll: 1,
  cay: 2,
  chalk: 3,
  fjord: 4,
  mangrove: 5,
  granite: 6,
  ridge: 7,
} as const;

export type ArchName = keyof typeof ARCH;

export const ARCH_NAMES: ArchName[] = [
  'volcanic',
  'atoll',
  'cay',
  'chalk',
  'fjord',
  'mangrove',
  'granite',
  'ridge',
];

export const LM = {
  lighthouse: 0,
  house: 1,
  chapel: 2,
  fort: 3,
  windmill: 4,
  ruin: 5,
  mole: 6,
  quay: 7,
  stack: 8,
  arch: 9,
  wreck: 10,
  nets: 11,
  wall: 12,
  boathouse: 13,
} as const;

export const LM_NAMES = [
  'lighthouse',
  'house',
  'chapel',
  'fort',
  'windmill',
  'ruin',
  'mole',
  'quay',
  'stack',
  'arch',
  'wreck',
  'nets',
  'wall',
  'boathouse',
];

/** 8 floats per landmark: kind, x, z, y, rot, scale, a, b (island-local metres). */
export const LM_STRIDE = 8;

/** 8 floats per scattered prop: x, z, y, scale, rot, species, tint, priority. */
export const SCATTER_STRIDE = 8;

export const SPECIES = {
  palm: 0,
  pine: 1,
  broadleaf: 2,
  scrub: 3,
  mangrove: 4,
  agave: 5,
} as const;

export const SPECIES_COUNT = 6;

export interface GenRequest {
  id: number;
  seed: number;
  /** Heightfield resolution (square). */
  gridN: number;
  /** World size the grid covers, metres (grid is centred on the island). */
  extentM: number;
  archA: number;
  archB: number;
  /** 0..1 how much of archB bleeds in. */
  blend: number;
  /** Nominal land radius, metres. */
  radiusM: number;
  /** Peak height multiplier. */
  peakScale: number;
  /** 0 = tropical, 1 = cold temperate. Drives vegetation + rock colour. */
  climate: number;
  /** Prevailing swell bearing at generation time, for beach/reef asymmetry. */
  swellBearing: number;
  erosionDroplets: number;
  scatterMax: number;
  /** Force a lighthouse — used by the capture harness island. */
  forceLandmarks: boolean;
}

export interface GenResult {
  id: number;
  gridN: number;
  extentM: number;
  /** Interleaved [height, moisture] — 2 * N * N floats. */
  hm: Float32Array;
  /** [normalX, normalZ, sandiness, ambientOcclusion] — 4 * N * N bytes. */
  mat: Uint8Array;
  /** Min/max pyramid, 2 floats per node, coarsest level first. */
  mm: Float32Array;
  scatter: Float32Array;
  scatterCount: number;
  landmarks: Float32Array;
  landmarkCount: number;
  maxHeight: number;
  landRadius: number;
  /** Fraction of grid cells above water — used to reject degenerate islands. */
  landFraction: number;
  genMs: number;
}
