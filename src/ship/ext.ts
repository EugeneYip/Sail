import * as THREE from 'three';
import {
  BOWSPRIT, DECK_CAMBER, MASTS, SPANKER, Station, YARDS, Z_STEM, Z_TRANSOM,
  deckSideY, sheerY, tAtZ,
} from './dims';

/**
 * Published on `world.ext.ship`, allocated once in `init` and never replaced —
 * consumers may cache the reference and every vector is mutated in place.
 *
 * Everything is in SHIP LOCAL metres: +X starboard, +Y up, -Z forward (bow),
 * y = 0 at the design waterline. Multiply by `root.matrixWorld` (or
 * `world.shipRoot.matrixWorld`, which is the same transform) for world space.
 *
 * Three groups of fields, for three consumers:
 *
 *   camera  — the flat numeric anatomy (`deckY`, `helmZ`, `mainTopY`, ...).
 *             `src/camera/Anatomy.ts` copies every numeric key it recognises,
 *             so these must stay in sync with the geometry, not with a guess.
 *   vfx     — `bowLocal` / `sternLocal` / `halfBeamAt` / `gunPortsLocal`,
 *             the spawn frame for bow spray, wake and gun smoke.
 *   physics — `hullPoints`, a cloud of wetted-surface sample points.
 */
export interface ShipExt {
  /** The geometry group inside `world.shipRoot`. */
  root: THREE.Object3D;
  /** Fighting-top platform centres, fore/main/mizzen. */
  mastTops: THREE.Vector3[];
  /** Truck (very top) of each mast. */
  mastTrucks: THREE.Vector3[];
  /** Named mount points on deck: helm, binnacle, capstan, bell, boats... */
  deckAnchors: Record<string, THREE.Vector3>;
  /** Stem head at the waterline. */
  bowPosition: THREE.Vector3;
  /** Transom at the waterline. */
  sternPosition: THREE.Vector3;
  /** Wetted-surface sample points for buoyancy integration. */
  hullPoints: THREE.Vector3[];
  /** Every sail mesh, in `world.ship.sails` order where one exists. */
  sailMeshes: THREE.Mesh[];

  /* ---- vfx ---- */
  bowLocal: THREE.Vector3;
  sternLocal: THREE.Vector3;
  deckHeight: number;
  halfBeamAt(t: number): number;
  gunPortsLocal: THREE.Vector3[];
  gunStarboardLocal: THREE.Vector3[];

  /* ---- camera anatomy ---- */
  deckY: number;
  bulwarkY: number;
  helmX: number;
  helmY: number;
  helmZ: number;
  wheelY: number;
  wheelZ: number;
  jibboomX: number;
  jibboomY: number;
  jibboomZ: number;
  mainTopX: number;
  mainTopY: number;
  mainTopZ: number;
  mainMastZ: number;
  mastheadY: number;
  mainYardY: number;
  mainYardHalfSpan: number;
  bowY: number;
  bowZ: number;
  sternY: number;
  sternZ: number;
}

/** Waterline half-beam, t = 0 at the stem, 1 at the transom. */
function waterlineHalfBeam(t: number): number {
  return new Station(THREE.MathUtils.clamp(t, 0, 1)).widthAt(0);
}

export function createShipExt(root: THREE.Object3D): ShipExt {
  const main = MASTS[1];
  const mainYard = YARDS.find((y) => y.id === 'main-course')!;
  const tMid = 0.5;
  const deckY = deckSideY(tMid) + DECK_CAMBER;
  const sheerMid = sheerY(tMid);

  // Wheel stands just forward of the mizzen; the helmsman is abaft it.
  const wheelZ = MASTS[2].z - 3.2;
  const deckAtHelm = deckSideY(tAtZ(wheelZ)) + DECK_CAMBER;

  const B = BOWSPRIT;
  const steeve2 = B.steeve * 0.78;
  // A seat 4 m inboard of the jibboom tip.
  const jibZ = B.heel.z - (B.length - 2.2) * Math.cos(B.steeve) - (B.jibboom - 4) * Math.cos(steeve2);
  const jibY = B.heel.y + (B.length - 2.2) * Math.sin(B.steeve) + (B.jibboom - 4) * Math.sin(steeve2);

  return {
    root,
    mastTops: [],
    mastTrucks: [],
    deckAnchors: {},
    bowPosition: new THREE.Vector3(0, 0, Z_STEM - 1.9),
    sternPosition: new THREE.Vector3(0, 0, Z_TRANSOM + 0.4),
    hullPoints: [],
    sailMeshes: [],

    bowLocal: new THREE.Vector3(0, 0, Z_STEM - 1.9),
    sternLocal: new THREE.Vector3(0, 0, Z_TRANSOM + 0.4),
    deckHeight: deckY,
    halfBeamAt: waterlineHalfBeam,
    gunPortsLocal: [],
    gunStarboardLocal: [],

    deckY,
    bulwarkY: sheerMid + 0.8,
    helmX: 0,
    helmY: deckAtHelm + 1.68,
    helmZ: wheelZ + 1.9,
    wheelY: deckAtHelm + 0.95,
    wheelZ,
    jibboomX: 0.85,
    jibboomY: jibY + 0.5,
    jibboomZ: jibZ,
    // Off the mast axis and on the after edge of the top, clear of the rigging.
    mainTopX: main.topHalfWidth * 0.72,
    mainTopY: main.lowerTop - 2.15 + 1.5,
    mainTopZ: main.z + 1.2,
    mainMastZ: main.z,
    mastheadY: main.truck,
    mainYardY: mainYard.y,
    mainYardHalfSpan: mainYard.half,
    bowY: 8.1,
    bowZ: Z_STEM - 1.9,
    sternY: sheerY(1) + 0.5,
    sternZ: Z_TRANSOM + 1.6,
  };
}

/** Sanity: the spanker sheets to the boom end, which overhangs the taffrail. */
export const SPANKER_OVERHANG = SPANKER.boomLen + MASTS[2].z - Z_TRANSOM;
