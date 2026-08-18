import * as THREE from 'three';
import type { IOcean } from '../types';
import { springDamp } from '../util/math';

/**
 * Camera collision. Two analytic proxy volumes in ship space plus a probe
 * against the ocean surface and (when the world module publishes one) the
 * terrain.
 *
 * Proxies rather than raycasts against `world.shipRoot`: the camera module
 * cannot see the ship's real geometry (it belongs to another agent), a full
 * hierarchy raycast for five whiskers every frame is not free, and
 * `Raycaster.intersectObject` allocates an intersection record per hit — which
 * the no-allocation-in-update rule forbids. A frigate's hull and sail plan are
 * both well approximated by a box and a cylinder, and a camera collider is
 * supposed to be conservative anyway.
 */

/** No-hit sentinel for the segment tests. */
const NO_HIT = -1;

/** Bulwark/hammock-netting top above the waterline, metres. */
const DEFAULT_BULWARK_Y = 7.6;
/** Longitudinal and lateral padding on the hull box, metres. */
const HULL_PAD_XZ = 0.8;
const HULL_PAD_Z = 2.4;

/**
 * Whatever the world module publishes on `world.ext.world`. The real contract
 * is `WorldExt.sampleTerrainHeight` (see `src/world/api.ts`); the other two
 * names are accepted so a rename over there cannot silently drop the camera
 * through an island.
 */
export interface TerrainProbe {
  sampleTerrainHeight?(x: number, z: number): number;
  sampleHeight?(x: number, z: number): number;
  terrainHeight?(x: number, z: number): number;
}

export class CameraCollider {
  /** Hull box in ship-local space. */
  private min = new THREE.Vector3(-7.5, -8, -29);
  private max = new THREE.Vector3(7.5, DEFAULT_BULWARK_Y, 29);
  /** Sail-plan cylinder: radius about the mast line, y range, centre Z. */
  private rigRadius = 19;
  private rigY0 = 7;
  private rigY1 = 66;
  private rigZ = -2;

  /** Smoothed vertical lift applied to keep the eye clear of a surface. */
  private lift = 0;
  private vLift = { v: 0 };

  /** Metres the last resolve moved the eye. Diagnostic. */
  moved = 0;

  private invQ = new THREE.Quaternion();
  private lp = new THREE.Vector3();
  private le = new THREE.Vector3();
  private d = new THREE.Vector3();

  setHull(beam: number, hullLength: number, draught: number, bulwarkY = DEFAULT_BULWARK_Y): void {
    const hx = beam * 0.5 + HULL_PAD_XZ;
    const hz = hullLength * 0.5 + HULL_PAD_Z;
    this.min.set(-hx, -draught - 1.5, -hz);
    this.max.set(hx, bulwarkY, hz);
  }

  setRig(radius: number, y0: number, y1: number, centreZ: number): void {
    this.rigRadius = radius;
    this.rigY0 = y0;
    this.rigY1 = y1;
    this.rigZ = centreZ;
  }

  reset(): void {
    this.lift = 0;
    this.vLift.v = 0;
    this.moved = 0;
  }

  /**
   * Whisker from `pivot` (the look target) toward `eye`. If the hull is in the
   * way, pull the eye in to just short of the entry point; if the pivot itself
   * is inside the hull, push the eye out past the exit instead. Writes `eye`.
   */
  resolveHull(
    eye: THREE.Vector3,
    pivot: THREE.Vector3,
    shipPos: THREE.Vector3,
    shipQuat: THREE.Quaternion,
    margin: number,
  ): void {
    this.toLocal(pivot, shipPos, shipQuat, this.lp);
    this.toLocal(eye, shipPos, shipQuat, this.le);
    this.d.subVectors(this.le, this.lp);
    const len = this.d.length();
    if (len < 1e-4) return;

    const t = this.segmentBox(this.lp, this.d, margin / len);
    if (t === NO_HIT) return;
    // Interpolate in world space so the result is exact regardless of the
    // local-space round trip.
    eye.lerpVectors(pivot, eye, t);
    this.moved += Math.abs(1 - t) * len;
  }

  /** Same whisker against the sail-plan cylinder. */
  resolveRig(
    eye: THREE.Vector3,
    pivot: THREE.Vector3,
    shipPos: THREE.Vector3,
    shipQuat: THREE.Quaternion,
    margin: number,
  ): void {
    this.toLocal(pivot, shipPos, shipQuat, this.lp);
    this.toLocal(eye, shipPos, shipQuat, this.le);
    this.d.subVectors(this.le, this.lp);
    const len = this.d.length();
    if (len < 1e-4) return;

    const t = this.segmentCylinder(this.lp, this.d, margin / len);
    if (t === NO_HIT) return;
    eye.lerpVectors(pivot, eye, t);
    this.moved += Math.abs(1 - t) * len;
  }

  /**
   * Keep the eye `clearance` metres above the water (and above terrain when a
   * probe is published). A negative clearance permits deliberate submersion.
   * Returns metres below the surface (positive == submerged).
   */
  resolveSurfaces(
    eye: THREE.Vector3,
    ocean: IOcean | null,
    terrain: TerrainProbe | null,
    clearance: number,
    dt: number,
  ): number {
    let surface = -1e6;
    if (ocean) surface = ocean.sampleHeight(eye.x, eye.z);
    const submersion = surface > -1e5 ? surface - eye.y : -1e6;

    if (terrain) {
      const fn = terrain.sampleTerrainHeight ?? terrain.sampleHeight ?? terrain.terrainHeight;
      if (fn) {
        const th = fn.call(terrain, eye.x, eye.z);
        if (Number.isFinite(th) && th > surface) surface = th;
      }
    }
    if (surface < -1e5) {
      this.lift = 0;
      this.vLift.v = 0;
      return submersion;
    }

    const want = Math.max(0, surface + clearance - eye.y);
    // Rise fast so a crest never engulfs the lens, settle back slowly so the
    // camera does not bob once per wave.
    const smoothTime = want > this.lift ? 0.16 : 0.55;
    this.lift = springDamp(this.lift, want, this.vLift, smoothTime, dt);
    if (this.lift > 1e-4) {
      eye.y += this.lift;
      this.moved += this.lift;
    }
    return submersion - Math.max(0, this.lift);
  }

  private toLocal(
    p: THREE.Vector3,
    shipPos: THREE.Vector3,
    shipQuat: THREE.Quaternion,
    out: THREE.Vector3,
  ): void {
    this.invQ.copy(shipQuat).invert();
    out.subVectors(p, shipPos).applyQuaternion(this.invQ);
  }

  /**
   * Slab test of the segment p -> p+d against the hull box. Returns the
   * parameter the eye should be moved to, or NO_HIT.
   *
   * Three cases, and getting them wrong is the difference between a camera
   * that never clips and one that teleports:
   *   - the volume lies strictly BETWEEN pivot and eye -> occlusion, pull the
   *     eye in to just short of the entry face;
   *   - both endpoints are inside -> the eye is buried, push it out past the
   *     exit face;
   *   - only the PIVOT is inside (the normal case: the whisker starts at a
   *     point in the middle of the hull) -> nothing is between them, no hit.
   *     Treating this as a push-out is what yanks a 76 m chase camera to 22 m.
   */
  private segmentBox(p: THREE.Vector3, d: THREE.Vector3, marginT: number): number {
    let t0 = -Infinity;
    let t1 = Infinity;
    for (let a = 0; a < 3; a++) {
      const pa = a === 0 ? p.x : a === 1 ? p.y : p.z;
      const da = a === 0 ? d.x : a === 1 ? d.y : d.z;
      const lo = a === 0 ? this.min.x : a === 1 ? this.min.y : this.min.z;
      const hi = a === 0 ? this.max.x : a === 1 ? this.max.y : this.max.z;
      if (Math.abs(da) < 1e-7) {
        if (pa < lo || pa > hi) return NO_HIT;
        continue;
      }
      let ta = (lo - pa) / da;
      let tb = (hi - pa) / da;
      if (ta > tb) {
        const s = ta;
        ta = tb;
        tb = s;
      }
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
      if (t0 > t1) return NO_HIT;
    }
    if (t1 <= 0 || t0 >= 1) return NO_HIT;
    if (t0 > 1e-4) return Math.max(0.1, t0 - marginT);
    if (t1 >= 1) return t1 + marginT;
    return NO_HIT;
  }

  /** Segment vs. vertical cylinder about (0, rigZ) with a finite y range. */
  private segmentCylinder(p: THREE.Vector3, d: THREE.Vector3, marginT: number): number {
    const px = p.x;
    const pz = p.z - this.rigZ;
    const a = d.x * d.x + d.z * d.z;
    if (a < 1e-9) return NO_HIT;
    const b = 2 * (px * d.x + pz * d.z);
    const c = px * px + pz * pz - this.rigRadius * this.rigRadius;
    const disc = b * b - 4 * a * c;
    if (disc <= 0) return NO_HIT;
    const sq = Math.sqrt(disc);
    const t0 = (-b - sq) / (2 * a);
    const t1 = (-b + sq) / (2 * a);
    if (t1 <= 0 || t0 >= 1) return NO_HIT;

    // Same three cases as the box. The y range makes the "reject" answer far
    // more common here: most whiskers cross the mast circle well above or below
    // the sail plan.
    if (t0 > 1e-4) {
      const y = p.y + d.y * t0;
      if (y < this.rigY0 || y > this.rigY1) return NO_HIT;
      return Math.max(0.1, t0 - marginT);
    }
    if (t1 < 1) return NO_HIT;
    const y = p.y + d.y;
    if (y < this.rigY0 || y > this.rigY1) return NO_HIT;
    return t1 + marginT;
  }
}
