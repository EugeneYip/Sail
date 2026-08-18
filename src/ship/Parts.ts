/**
 * The animated-transform table.
 *
 * Every moving piece of the ship — thirteen yards, the spanker boom and gaff,
 * the rudder, the wheel, the tiller, the capstan — lives inside the same merged
 * geometry as the static hull. Each vertex carries an `aPart` slot; this class
 * owns one pivot + quaternion per slot and writes them into the uniform arrays
 * that `shaders/parts.ts` reads. The rigging material applies the identical
 * transform to its per-instance endpoints, which is what makes a braced yard
 * drag its braces and its sail round with it.
 *
 * Nothing here allocates: every vector and quaternion is a field.
 */

import * as THREE from 'three';
import { damp } from '../util/math';
import type { SailState, ShipState } from '../types';
import { JIB_IDS, MASTS, PART, SPANKER, YARDS } from './dims';
import type { RigFrame } from './build/masts';
import type { PartUniforms } from './materials/materials';

/**
 * How much further a fore-and-aft sail swings than a square yard for the same
 * trim command. Must match `SHEET_GAIN` in physics/constants.ts: physics builds
 * the sail's normal from the same product, so a mismatch points the cloth one
 * way and sends the force the other.
 */
const SHEET_GAIN = 2.35;

interface Joint {
  slot: number;
  pivot: THREE.Vector3;
  axis: THREE.Vector3;
  /** Current angle, damped toward `target`. */
  angle: number;
  target: number;
  /** Smoothing rate, per second. Heavy spars swing slowly. */
  rate: number;
}

const _q = new THREE.Quaternion();

export class PartRig {
  private joints: Joint[] = [];
  /** Yard slot -> index into `world.ship.sails`, or -1. */
  private yardSail: number[] = [];
  /** Headsail slot -> index into `world.ship.sails`, or -1. */
  private jibSail: number[] = [];
  private uniforms: PartUniforms;
  private wheelAngle = 0;
  private capstanAngle = 0;

  constructor(uniforms: PartUniforms) {
    this.uniforms = uniforms;
  }

  /** Mast axis direction, allowing for rake. */
  private static mastAxis(mast: number, out: THREE.Vector3): THREE.Vector3 {
    return out.set(0, 1, Math.tan(MASTS[mast].rake)).normalize();
  }

  build(sails: SailState[], frame: RigFrame): void {
    const axis = new THREE.Vector3();

    for (const y of YARDS) {
      // The spritsail yard braces on the bowsprit, about a vertical axis.
      if (y.mast === 3) axis.set(0, 1, 0);
      else PartRig.mastAxis(y.mast, axis);
      const pivot = new THREE.Vector3(0, y.y, 0);
      if (y.mast < 3) pivot.z = MASTS[y.mast].z + y.y * Math.tan(MASTS[y.mast].rake);
      else pivot.set(0, 0, 0);
      this.joints.push({
        slot: y.part,
        pivot,
        axis: axis.clone(),
        angle: 0,
        target: 0,
        // Lower yards are enormous; they come round slowly.
        rate: y.tier === 0 ? 0.55 : 0.75 + y.tier * 0.2,
      });
      const si = sails.findIndex((s) => s.id === y.id);
      this.yardSail[y.part] = si;
    }

    // The crossjack and the spritsail carry no sail of their own; they follow
    // the sail above them so the rig never looks half-braced.
    const follow = (yardId: string, sailId: string) => {
      const y = YARDS.find((v) => v.id === yardId);
      const si = sails.findIndex((s) => s.id === sailId);
      if (y) this.yardSail[y.part] = si;
    };
    follow('mizzen-crossjack', 'mizzen-topsail');
    follow('spritsail', 'fore-course');

    const mizzen = MASTS[2];
    PartRig.mastAxis(2, axis);
    for (const [slot, y] of [[PART.BOOM, SPANKER.boomY], [PART.GAFF, SPANKER.gaffY]] as const) {
      this.joints.push({
        slot,
        pivot: new THREE.Vector3(0, y, mizzen.z + y * Math.tan(mizzen.rake)),
        axis: axis.clone(),
        angle: 0,
        target: 0,
        rate: 0.9,
      });
    }

    // A headsail is hanked to its stay, so sheeting one is a rotation of the
    // whole sail about the stay itself — the same kind of joint as a braced
    // yard rather than a special case in the sail shader. Rotating the sail
    // (which lies in the centreline plane when unsheeted) about a stay that
    // leans aft is what makes the clew swing out AND lift, the way a real jib
    // does when the sheet is eased.
    for (let i = 0; i < JIB_IDS.length; i++) {
      const stay = frame.headStays[i];
      this.joints.push({
        slot: PART.JIB0 + i,
        pivot: stay.tack.clone(),
        axis: stay.dir.clone(),
        angle: 0,
        target: 0,
        rate: 1.35,
      });
      this.jibSail[PART.JIB0 + i] = sails.findIndex((s) => s.id === JIB_IDS[i]);
    }

    this.joints.push({
      slot: PART.RUDDER,
      pivot: new THREE.Vector3(0, 0, 26.2),
      axis: new THREE.Vector3(0, 1, 0),
      angle: 0,
      target: 0,
      rate: 6,
    });
    this.joints.push({
      slot: PART.TILLER,
      pivot: new THREE.Vector3(0, 0, 26.2),
      axis: new THREE.Vector3(0, 1, 0),
      angle: 0,
      target: 0,
      rate: 6,
    });
  }

  /** Ship-local pivot of a slot, for anything that needs to follow a spar. */
  pivotOf(slot: number): THREE.Vector3 | null {
    const j = this.joints.find((v) => v.slot === slot);
    return j ? j.pivot : null;
  }

  update(ship: ShipState, dt: number): void {
    const sails = ship.sails;

    for (const j of this.joints) {
      if (j.slot >= 1 && j.slot <= 13) {
        const si = this.yardSail[j.slot];
        j.target = si >= 0 ? sails[si].brace : 0;
      } else if (j.slot === PART.BOOM || j.slot === PART.GAFF) {
        const sp = sails.find((s) => s.id === 'spanker');
        j.target = sp ? sp.brace * SHEET_GAIN : 0;
      } else if (j.slot >= PART.JIB0) {
        const si = this.jibSail[j.slot];
        j.target = si >= 0 ? sails[si].brace * SHEET_GAIN : 0;
      } else if (j.slot === PART.RUDDER || j.slot === PART.TILLER) {
        // The tiller lies forward of the rudder head, so it swings the other way.
        j.target = j.slot === PART.RUDDER ? ship.rudder : -ship.rudder;
      }
      j.angle = damp(j.angle, j.target, j.rate * 4, dt);
      this.write(j.slot, j.pivot, j.axis, j.angle);
    }

    // The wheel is geared about four turns from hard over to hard over.
    this.wheelAngle = damp(this.wheelAngle, ship.rudder * 11.5, 24, dt);
    _axis.set(1, 0, 0);
    this.write(PART.WHEEL, _wheelPivot, _axis, this.wheelAngle);

    // The capstan idles unless the anchor is coming home; a slow drift keeps
    // it from looking welded down.
    this.capstanAngle += dt * 0.04;
    _axis.set(0, 1, 0);
    this.write(PART.CAPSTAN, _capstanPivot, _axis, this.capstanAngle);
  }

  /** Where the wheel's axle sits — set by the deck builder. */
  setWheel(p: THREE.Vector3): void {
    _wheelPivot.copy(p);
  }
  setCapstan(p: THREE.Vector3): void {
    _capstanPivot.copy(p);
  }

  private write(slot: number, pivot: THREE.Vector3, axis: THREE.Vector3, angle: number): void {
    _q.setFromAxisAngle(axis, angle);
    const q = this.uniforms.uPartQ.value[slot];
    q.set(_q.x, _q.y, _q.z, _q.w);
    this.uniforms.uPartP.value[slot].copy(pivot);
  }
}

const _axis = new THREE.Vector3();
const _wheelPivot = new THREE.Vector3();
const _capstanPivot = new THREE.Vector3();
