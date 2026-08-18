/**
 * The USS Constitution.
 *
 * Assembly only: every surface is built by `build/*` into one `MeshBuilder` per
 * paint/material family, then merged into a single BufferGeometry per family.
 * That is what keeps a ship with ~26 gun ports, three tops, thirteen yards and
 * several hundred ropes inside the draw-call budget — nine opaque meshes for the
 * hull and rig, one instanced draw for all the rigging, one for the sails.
 *
 * Anything that moves lives in the same merged geometry and is transformed in
 * the vertex shader from an `aPart` slot; see `Parts.ts` and `shaders/parts.ts`.
 */

import * as THREE from 'three';
import type { Module, QualityTier, World } from '../types';
import { PART_COUNT } from './dims';
import { PartRig } from './Parts';
import { createShipExt, type ShipExt } from './ext';
import { buildHull, createBins, type Bins, type HullResult } from './build/hull';
import { buildMasts, type RigFrame } from './build/masts';
import { buildDeckFurniture, type DeckResult } from './build/deck';
import { buildRigging, type RiggingResult } from './build/rigging';
import { buildSails, type SailResult } from './build/sails';
import {
  createPartUniforms, makeDepthFor, makeShipMaterial, type PartUniforms,
} from './materials/materials';
import {
  disposeTextures, makeBrass, makeBuff, makeCanvas, makeCopper, makeDeck, makeHullBlack,
  makeIron, makeOak, makeRope, makeStripeWhite, type TexSet,
} from './materials/textures';

function qualityLevel(q: QualityTier): number {
  return q === 'low' ? 0 : q === 'medium' ? 1 : q === 'high' ? 2 : 3;
}

export class Ship implements Module {
  readonly name = 'ship';

  private root = new THREE.Group();
  private parts!: PartUniforms;
  private rig!: PartRig;
  private ext!: ShipExt;
  private meshes: THREE.Mesh[] = [];
  private materials: THREE.Material[] = [];
  private geometries: THREE.BufferGeometry[] = [];
  private rigging: RiggingResult | null = null;
  private sails: SailResult | null = null;

  init(world: World): void {
    const t0 = performance.now();
    const q = qualityLevel(world.settings.quality);
    const big = q >= 2 ? 512 : 256;
    const mid = q >= 2 ? 256 : 128;

    this.parts = createPartUniforms(PART_COUNT);
    this.rig = new PartRig(this.parts);

    const tex = {
      oak: makeOak(big),
      black: makeHullBlack(big),
      stripe: makeStripeWhite(mid * 2),
      buff: makeBuff(mid),
      deck: makeDeck(big),
      copper: makeCopper(mid),
      iron: makeIron(mid),
      brass: makeBrass(128),
      rope: makeRope(128),
      canvas: makeCanvas(big),
    };

    const bins = createBins();
    const hull = buildHull(bins, q);
    const frame = buildMasts(bins, q);
    const deck = buildDeckFurniture(bins, hull, frame, q);
    this.rig.build(world.ship.sails);
    this.rig.setWheel(deck.wheelPivot);
    this.rig.setCapstan(deck.capstanPivot);

    this.addBins(world, bins, tex);

    this.rigging = buildRigging(world, this.parts, tex.rope, hull, frame, q);
    this.root.add(this.rigging.mesh);
    this.sails = buildSails(world, this.parts, tex.canvas, frame, q);
    this.root.add(this.sails.group);

    world.shipRoot.add(this.root);
    this.publish(world, hull, frame, deck);

    world.stats['ship:buildMs'] = performance.now() - t0;
    world.stats['ship:tris'] = this.geometries.reduce(
      (n, g) => n + (g.index ? g.index.count : 0) / 3, 0,
    );
  }

  /** One merged geometry, one material, one draw call per family. */
  private addBins(world: World, bins: Bins, tex: Record<string, TexSet>): void {
    const depth = makeDepthFor(this.parts);
    const add = (
      b: Bins[keyof Bins],
      set: TexSet,
      opts: Parameters<typeof makeShipMaterial>[2],
      name: string,
    ) => {
      if (b.triangleCount === 0) return;
      const g = b.toGeometry();
      // three's aoMap reads uv1; our builders emit a single spiled UV set.
      g.setAttribute('uv1', g.getAttribute('uv'));
      const m = makeShipMaterial(world.uniforms, this.parts, opts);
      const mesh = new THREE.Mesh(g, m);
      mesh.name = `ship-${name}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.customDepthMaterial = depth;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this.root.add(mesh);
      this.meshes.push(mesh);
      this.materials.push(m);
      this.geometries.push(g);
      void set;
    };

    add(bins.copper, tex.copper, { tex: tex.copper, grime: 0.15, env: 1.1 }, 'copper');
    add(bins.black, tex.black, { tex: tex.black, grime: 0.55, env: 0.9 }, 'black');
    add(bins.stripe, tex.stripe, { tex: tex.stripe, grime: 0.5, env: 0.75 }, 'stripe');
    add(bins.buff, tex.buff, { tex: tex.buff, grime: 0.45, env: 0.7 }, 'buff');
    add(bins.deck, tex.deck, { tex: tex.deck, grime: 0.7, env: 0.6 }, 'deck');
    add(bins.oak, tex.oak, { tex: tex.oak, grime: 0.5, env: 0.7 }, 'oak');
    add(bins.iron, tex.iron, { tex: tex.iron, grime: 0.4, env: 1.3 }, 'iron');
    add(bins.brass, tex.brass, { tex: tex.brass, grime: 0.3, env: 1.5 }, 'brass');
    add(
      bins.glass,
      tex.brass,
      { tex: tex.brass, grime: 0, env: 3.2, roughness: 0.06, metalness: 0.1, color: 0x1b2a33 },
      'glass',
    );
    this.materials.push(depth);
  }

  private publish(world: World, hull: HullResult, frame: RigFrame, deck: DeckResult): void {
    const ext = createShipExt(this.root);
    ext.hullPoints = hull.hullPoints;
    for (const m of frame.masts) {
      ext.mastTops.push(m.lower(m.platformY));
      ext.mastTrucks.push(m.tg(m.spec.truck));
    }
    ext.deckAnchors = deck.anchors;
    for (const p of hull.ports) {
      if (!p.gunDeck) continue;
      const y = 3.2;
      ext.gunStarboardLocal.push(new THREE.Vector3(7.2, y, p.z));
      ext.gunPortsLocal.push(new THREE.Vector3(-7.2, y, p.z));
    }
    ext.sailMeshes = this.sails ? this.sails.meshes : [];
    this.ext = ext;
    world.ext.ship = ext;
  }

  update(world: World): void {
    world.shipRoot.position.copy(world.ship.position);
    world.shipRoot.quaternion.copy(world.ship.quaternion);
    world.shipRoot.updateMatrixWorld();

    this.rig.update(world.ship, world.time.dt);
    this.rigging?.update(world, this.root);
    this.sails?.update(world);
    void this.ext;
  }

  applySettings(world: World): void {
    const q = qualityLevel(world.settings.quality);
    this.rigging?.applySettings(q);
    this.sails?.applySettings(q);
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    this.rigging?.dispose();
    this.sails?.dispose();
    disposeTextures();
  }
}
