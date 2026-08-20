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
import { buildEnsign, type EnsignResult } from './build/ensign';
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
  private ensign: EnsignResult | null = null;

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
    this.rig.build(world.ship.sails, frame);
    this.rig.setWheel(deck.wheelPivot);
    this.rig.setCapstan(deck.capstanPivot);

    this.addBins(world, bins, tex);

    // Sails first: the rigging material evaluates the cloth's own
    // `lwSailPoint`, so it needs the sail uniforms to bind buntlines to.
    this.sails = buildSails(world, this.parts, tex.canvas, frame, q);
    this.rigging = buildRigging(
      world, this.parts, tex.rope, hull, frame, this.sails.uniforms, q,
    );
    this.root.add(this.rigging.mesh);
    this.root.add(this.sails.group);
    this.ensign = buildEnsign(world, this.parts, frame, q);
    this.root.add(this.ensign.mesh);

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

    add(
      bins.copper, tex.copper,
      {
        tex: tex.copper, grime: 0.15, env: 1.1,
        // No wood here: rings off, and the fibre tier becomes the fine draw
        // marks left in rolled sheet copper.
        detail: {
          fibrePitch: 0.0022, fibreRelief: 0.00012, fibreAlbedo: 0.05, fibreRough: 0.1,
          // Planishing: the overlapping hammer dishes left in a beaten sheet.
          figurePitch: 0.03, figureAlbedo: 0.06, figureRelief: 0.0008, figureRough: 0.13,
          // PLATE SEAMS. A sheet of sheathing is 4 ft by 14 in, tacked on with
          // its edges lapped, and the lap is the only hard line on a coppered
          // bottom — the thing that says "plated" rather than "painted brown".
          // The baked map fades one in over 32 mm so it survives minification;
          // the crisp 2 mm core is here, where it can be one antialiased pixel
          // at eighty metres and a real edge at two. `plankPitch` and
          // `boardLen` are the plate's own dimensions, and they line up with
          // the 4-across, 3-along layout `makeCopper` bakes.
          plankPitch: 0.32, boardLen: 1.07, boardJitter: 0.0,
          seamWidth: 0.002, seamDark: 0.34, plankTone: 0.055, plankRough: 0.06,
        },
      },
      'copper',
    );
    add(
      bins.black, tex.black,
      {
        tex: tex.black, grime: 0.55, env: 0.9,
        // Paint fills the grain but does not hide it: a shallow ring figure
        // telegraphs through, and the seams are payed rather than caulked.
        detail: {
          ringPitch: 0.011, ringAlbedo: 0.055, ringRelief: 0.00022, ringRough: 0.11,
          plankPitch: 0.32, seamWidth: 0.0035, seamDark: 0.45, plankTone: 0.035,
          boardLen: 8.4, boardJitter: 3.0,
          fibrePitch: 0.0019, fibreRelief: 0.00009, fibreAlbedo: 0.05,
          fibreRough: 0.06, plankRough: 0.035,
          figurePitch: 0.05, figureAlbedo: 0.06, figureRelief: 0.0009, figureRough: 0.1,
        },
      },
      'black',
    );
    add(
      bins.stripe, tex.stripe,
      {
        tex: tex.stripe, grime: 0.5, env: 0.75,
        detail: {
          ringPitch: 0.011, ringAlbedo: 0.05, ringRelief: 0.0002, ringRough: 0.1,
          plankPitch: 0.32, seamWidth: 0.0035, seamDark: 0.4, plankTone: 0.03,
          boardLen: 8.4, boardJitter: 3.0,
          fibrePitch: 0.0019, fibreRelief: 0.00008, fibreAlbedo: 0.045,
          fibreRough: 0.06, plankRough: 0.03,
          figurePitch: 0.05, figureAlbedo: 0.055, figureRelief: 0.00085, figureRough: 0.095,
        },
      },
      'stripe',
    );
    add(
      bins.buff, tex.buff,
      {
        tex: tex.buff, grime: 0.45, env: 0.7,
        detail: {
          ringPitch: 0.0105, ringAlbedo: 0.05, ringRelief: 0.0002, ringRough: 0.1,
          plankPitch: 0.29, seamWidth: 0.003, seamDark: 0.38, plankTone: 0.032,
          fibrePitch: 0.0018, fibreRelief: 0.00009, fibreAlbedo: 0.05,
          fibreRough: 0.06, plankRough: 0.03,
          figurePitch: 0.048, figureAlbedo: 0.058, figureRelief: 0.00085, figureRough: 0.095,
        },
      },
      'buff',
    );
    add(
      bins.deck, tex.deck,
      {
        tex: tex.deck, grime: 0.45, env: 0.6,
        // The deck is the surface the player stares at from the helm, so it
        // gets the strongest grain, real caulk at 3 mm each side of the seam,
        // and the traffic wear that scrubs the paths pale and smooth.
        detail: {
          ringPitch: 0.0095, ringAlbedo: 0.135, ringRelief: 0.00055, ringRough: 0.2,
          plankPitch: 0.32, seamWidth: 0.0032, seamDark: 0.82, plankTone: 0.12,
          // Deck boards run six to eight metres between butts.
          boardLen: 6.1, boardJitter: 2.0,
          fibrePitch: 0.0015, fibreRelief: 0.00016, fibreAlbedo: 0.075, wear: 0.16,
          fibreRough: 0.11, plankRough: 0.11,
          // The tier that actually carries the deck at the two metres the helm
          // camera sits at: ray fleck, colour streaking and holystone scrub.
          // Amplitudes set by measurement, not by eye — see shaders/detail.ts.
          figurePitch: 0.042, figureAlbedo: 0.17, figureRelief: 0.0016, figureRough: 0.2,
        },
      },
      'deck',
    );
    add(
      bins.oak, tex.oak,
      {
        tex: tex.oak, grime: 0.5, env: 0.7,
        // Bare oiled oak: spars, boats, capstan, wheel. Rings and pores read
        // hardest of all here because there is no paint over them.
        detail: {
          ringPitch: 0.0105, ringAlbedo: 0.115, ringRelief: 0.0005, ringRough: 0.19,
          plankPitch: 0, fibrePitch: 0.0014, fibreRelief: 0.00015, fibreAlbedo: 0.07,
          fibreRough: 0.1,
          figurePitch: 0.038, figureAlbedo: 0.19, figureRelief: 0.0017, figureRough: 0.21,
        },
      },
      'oak',
    );
    add(
      bins.iron, tex.iron,
      {
        tex: tex.iron, grime: 0.4, env: 1.3,
        // Hammer draw marks on wrought iron: fine, directional, and mostly a
        // roughness effect — that is what makes a forged fitting read as metal
        // rather than as dark plastic.
        detail: {
          fibrePitch: 0.0018, fibreRelief: 0.00018, fibreAlbedo: 0.06, fibreRough: 0.16,
          // Mill scale and the dents of the smith's hammer, at the 2-3 cm the
          // hammer face actually leaves.
          figurePitch: 0.028, figureAlbedo: 0.08, figureRelief: 0.001, figureRough: 0.18,
        },
      },
      'iron',
    );
    add(
      bins.brass, tex.brass,
      {
        tex: tex.brass, grime: 0.3, env: 1.5,
        detail: {
          fibrePitch: 0.0012, fibreRelief: 0.00007, fibreAlbedo: 0.03, fibreRough: 0.08,
          figurePitch: 0.022, figureAlbedo: 0.02, figureRelief: 0.00025, figureRough: 0.05,
        },
      },
      'brass',
    );
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
    this.ensign?.update(world);
    void this.ext;
  }

  applySettings(world: World): void {
    const q = qualityLevel(world.settings.quality);
    this.rigging?.applySettings(q);
    this.sails?.applySettings(q);
    this.ensign?.applySettings(q);
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    this.rigging?.dispose();
    this.sails?.dispose();
    this.ensign?.dispose();
    disposeTextures();
  }
}
