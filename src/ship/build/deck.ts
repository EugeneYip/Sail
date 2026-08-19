/**
 * Deck furniture and the gun battery.
 *
 * Everything here goes into the same bins as the hull, so none of it costs a
 * draw call. Repeated objects (gratings, belaying pins, cannon) are emitted as
 * geometry rather than instances because they are already inside a merged mesh
 * and a merged triangle is cheaper than an instanced one at these counts.
 */

import * as THREE from 'three';
import { MeshBuilder } from './Builder';
import type { Bins, HullResult } from './hull';
import type { RigFrame } from './masts';
import { PART, Station, deckSideY, sheerY, tAtZ, DECK_CAMBER } from '../dims';

export interface DeckResult {
  anchors: Record<string, THREE.Vector3>;
  wheelPivot: THREE.Vector3;
  capstanPivot: THREE.Vector3;
}

/** Spar-deck height on the centreline at station z. */
function deckY(z: number): number {
  return deckSideY(tAtZ(z)) + DECK_CAMBER;
}

export function buildDeckFurniture(
  bins: Bins,
  hull: HullResult,
  frame: RigFrame,
  quality: number,
): DeckResult {
  const anchors: Record<string, THREE.Vector3> = {};

  const capstanPivot = new THREE.Vector3(0, deckY(6.4), 6.4);
  const wheelPivot = new THREE.Vector3(0, deckY(frame.masts[2].spec.z - 3.2) + 0.95, frame.masts[2].spec.z - 3.2);

  buildCapstan(bins, capstanPivot);
  buildWheel(bins, wheelPivot);
  buildHatches(bins, hull, quality);
  buildBelayingPins(bins, frame, quality);

  anchors.helm = new THREE.Vector3(0, wheelPivot.y - 0.95, wheelPivot.z + 1.9);
  anchors.wheel = wheelPivot.clone();
  anchors.capstan = capstanPivot.clone();
  anchors.binnacle = new THREE.Vector3(0, deckY(wheelPivot.z - 1.5), wheelPivot.z - 1.5);
  anchors.bow = new THREE.Vector3(0, deckY(-24), -24);
  anchors.waist = new THREE.Vector3(0, deckY(0), 0);

  return { anchors, wheelPivot, capstanPivot };
}

function buildCapstan(bins: Bins, p: THREE.Vector3): void {
  const oak = bins.oak;
  oak.partIndex = PART.CAPSTAN;
  oak.setColorHexLinear(0xffffff, 0.82);
  oak.pushTransform(new THREE.Matrix4().makeTranslation(p.x, p.y, p.z));
  oak.revolve(
    [
      [0.86, 0], [0.84, 0.18], [0.6, 0.42], [0.5, 0.95],
      [0.56, 1.32], [0.78, 1.44], [0.8, 1.62], [0, 1.66],
    ],
    14,
  );
  // Whelps: the vertical ribs the messenger cable bites on.
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    oak.box(Math.cos(a) * 0.6, 0.7, Math.sin(a) * 0.6, 0.1, 0.3, 0.1);
  }
  oak.popTransform();
  oak.partIndex = 0;
}

function buildWheel(bins: Bins, p: THREE.Vector3): void {
  const oak = bins.oak;
  const ir = bins.iron;
  const br = bins.brass;

  // Standards: the two uprights the barrel turns in.
  oak.setColorHexLinear(0xffffff, 0.76);
  for (const side of [1, -1] as const) {
    oak.box(side * 0.72, p.y - 0.48, p.z, 0.09, 0.62, 0.14);
  }
  // Barrel.
  oak.partIndex = PART.WHEEL;
  oak.setColorHexLinear(0xffffff, 0.8);
  oak.pushTransform(new THREE.Matrix4().compose(
    p,
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI * 0.5),
    new THREE.Vector3(1, 1, 1),
  ));
  oak.revolve([[0.17, -0.62], [0.2, -0.5], [0.2, 0.5], [0.17, 0.62]], 10);
  // Two wheels, one each side of the barrel.
  for (const off of [-0.5, 0.5]) {
    const R = 0.86;
    br.setColorHexLinear(0xffffff, 0.8);
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      const c = Math.cos(a);
      const s = Math.sin(a);
      // Spoke, running out past the rim into the handle.
      oak.box(off, c * R * 0.55, s * R * 0.55, 0.05, R * 0.55, 0.05);
      oak.box(off, c * (R + 0.18), s * (R + 0.18), 0.045, 0.2, 0.045);
      // Rim segment.
      oak.box(off, c * R, s * R, 0.055, 0.16, 0.16);
      void c;
      void s;
    }
  }
  oak.popTransform();
  oak.partIndex = 0;

  // Binnacle just forward of the wheel: a boxed cabinet with a lamp window.
  const bz = p.z - 1.5;
  const by = p.y - 0.95;
  oak.setColorHexLinear(0xffffff, 0.72);
  oak.box(0, by + 0.55, bz, 0.7, 0.55, 0.36);
  oak.box(0, by + 1.14, bz, 0.78, 0.06, 0.44);
  br.setColorHexLinear(0xffffff, 1.0);
  br.box(0, by + 0.7, bz - 0.34, 0.24, 0.24, 0.04);
  ir.setColorHexLinear(0xffffff, 0.9);
  ir.box(0, by + 0.24, bz, 0.74, 0.06, 0.4);
}

function buildHatches(bins: Bins, hull: HullResult, quality: number): void {
  const oak = bins.oak;
  const step = quality >= 2 ? 0.16 : 0.24;
  // Main, fore and after hatches with coamings and gratings.
  for (const [z, hx, hz] of [[-12.4, 1.5, 1.7], [-1.2, 1.9, 2.3], [9.6, 1.4, 1.6]] as const) {
    const y = deckY(z);
    oak.setColorHexLinear(0xffffff, 0.7);
    // Coaming.
    for (const [dx, dz, sx, sz] of [
      [hx + 0.12, 0, 0.12, hz + 0.24], [-hx - 0.12, 0, 0.12, hz + 0.24],
      [0, hz + 0.12, hx + 0.24, 0.12], [0, -hz - 0.12, hx + 0.24, 0.12],
    ] as const) {
      oak.box(dx, y + 0.22, z + dz, sx, 0.24, sz);
    }
    // Grating: two crossed sets of battens with the light showing through.
    oak.setColorHexLinear(0xffffff, 0.6);
    for (let x = -hx + step * 0.5; x < hx; x += step) {
      oak.box(x, y + 0.14, z, step * 0.3, 0.06, hz);
    }
    for (let zz = -hz + step * 0.5; zz < hz; zz += step) {
      oak.box(0, y + 0.06, z + zz, hx, 0.06, step * 0.3);
    }
  }
  void hull;
}

function buildBelayingPins(bins: Bins, frame: RigFrame, quality: number): void {
  const oak = bins.oak;
  const n = quality >= 2 ? 11 : 7;
  oak.setColorHexLinear(0xffffff, 0.78);
  for (const m of frame.masts) {
    const y = deckY(m.spec.z);
    // Fife rail round the mast, and the pins in it.
    const r = m.spec.lowerRadius + 1.15;
    for (const side of [1, -1] as const) {
      oak.box(side * r, y + 1.0, m.spec.z, 0.09, 0.09, r * 0.8);
      oak.box(side * r, y + 0.5, m.spec.z + r * 0.7, 0.08, 0.5, 0.08);
      oak.box(side * r, y + 0.5, m.spec.z - r * 0.7, 0.08, 0.5, 0.08);
      for (let i = 0; i < n; i++) {
        const z = m.spec.z + ((i + 0.5) / n - 0.5) * r * 1.5;
        oak.box(side * r, y + 0.92, z, 0.035, 0.22, 0.035);
      }
    }
  }
  // Pin rails inside the bulwarks abreast each mast.
  for (const m of frame.masts) {
    const t = tAtZ(m.spec.z);
    const st = new Station(t);
    const w = st.widthAt(sheerY(t) - 0.9) - 0.34;
    for (const side of [1, -1] as const) {
      oak.box(side * w, sheerY(t) - 0.85, m.spec.z, 0.1, 0.1, 1.5);
      for (let i = 0; i < n; i++) {
        const z = m.spec.z + ((i + 0.5) / n - 0.5) * 2.7;
        oak.box(side * w, sheerY(t) - 0.96, z, 0.035, 0.2, 0.035);
      }
    }
  }
}

/** Small helper shared with the boats and the head: a simple thwart plank. */
export function plank(b: MeshBuilder, x: number, y: number, z: number, hx: number, hz: number): void {
  b.box(x, y, z, hx, 0.04, hz);
}
