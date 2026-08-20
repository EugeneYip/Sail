import * as THREE from 'three';
import type { World } from '../types';
import { makeRng } from '../util/math';
import { MeshBuilder, mixRGB, srgb, type Aux, type RGB } from './wgeom';
import { vesselFrag, vesselVert } from './shaders/vessel';

/**
 * Boston, from seaward, about 1800.
 *
 * The ship is the Constitution, so this is her home port and it is worth doing
 * as a recognisable landfall rather than as generic buildings. What a master
 * actually saw coming up the outer harbour, and what is modelled here:
 *
 *   - the Brewsters and the outer drumlins, low green humps in a line
 *   - Boston Light on the outermost of them, white, tapered, 1783
 *   - Castle Island with its low fort commanding the channel
 *   - the Trimountain behind the town: Beacon Hill in the middle, Copp's Hill
 *     to the north, Fort Hill to the south
 *   - Bulfinch's new State House on the crest of Beacon Hill, 1798, its dome
 *     still shingled and pale rather than gilded
 *   - church spires, Old North's the tallest and northernmost
 *   - Long Wharf running half a kilometre into the harbour, and the thicket of
 *     masts alongside it, which is the single most legible thing about a
 *     seaport of this date
 *
 * Built in slices of about 1.5 ms so the landfall never costs a hitch, and held
 * in ABSOLUTE voyage coordinates — unlike the wildlife, a harbour is a place,
 * and it has to still be there when you come back for it.
 */

const BUILD_BUDGET_MS = 1.5;
/** Town scale. Real Boston peninsula is about 3 km on its long axis. */
const TOWN_LEN = 2600;
/**
 * Beacon Hill, exaggerated. The Trimountain summits were nearer 45-60 m, and a
 * faithful 74 m hill measures EIGHT PIXELS at 9 km — the first capture put the
 * town on the horizon and the horizon stayed dead flat. So the hills are pushed
 * to 90 m and, more importantly, the landfall is placed at 4-8 km rather than
 * 12-21 km, which is where a low brick town actually becomes a place.
 */
const BEACON_H = 90;

interface Slice {
  label: string;
  run: (b: MeshBuilder, rng: () => number) => void;
}

export class Boston {
  private mesh: THREE.Mesh | null = null;
  private material: THREE.ShaderMaterial | null = null;
  private builder: MeshBuilder | null = null;
  private slices: Slice[] = [];
  private sliceIndex = 0;
  private rng = makeRng(0xb05104);

  /** Absolute voyage coordinates of the town centre, or null when not placed. */
  private absX = 0;
  private absZ = 0;
  private placed = false;
  private bearing = 0;
  private nextEvent = 0;
  private world!: World;
  private xf!: THREE.InstancedBufferAttribute;
  private mo!: THREE.InstancedBufferAttribute;
  private bd!: THREE.InstancedBufferAttribute;

  /**
   * Mean seconds between landfalls. Long: a harbour on the horizon should be
   * something you remember from a voyage, not a thing that happens every lap.
   */
  private static readonly MEAN_GAP_S = 1100;
  private static readonly RETIRE_M = 46000;

  init(world: World): void {
    this.world = world;
    this.nextEvent = -1;
    void this.nextEvent;
    this.nextEvent = Boston.MEAN_GAP_S * 0.7;
  }

  showcase(world: World): void {
    this.place(world, 4200);
    this.nextEvent = 1e6;
  }

  private draw(mean: number): number {
    return -mean * Math.log(1 - this.rng() * 0.999);
  }

  /** Put the town on the horizon at `range` metres, roughly on the bow. */
  private place(world: World, range: number): void {
    const r = this.rng;
    const b = world.ship.heading + (r() - 0.5) * 0.7;
    this.absX = world.ship.position.x + world.origin.x + Math.sin(b) * range;
    this.absZ = world.ship.position.z + world.origin.z - Math.cos(b) * range;
    // The town faces the sea, so its axis is across the approach.
    this.bearing = b + Math.PI * 0.5;
    this.placed = true;
    if (!this.builder && !this.mesh) this.beginBuild();
    world.bus.emit('world:landfall', { name: 'Boston', range });
  }

  private beginBuild(): void {
    this.builder = new MeshBuilder();
    this.sliceIndex = 0;
    this.slices = [
      { label: 'peninsula', run: (b, r) => this.buildLand(b, r) },
      { label: 'islands', run: (b, r) => this.buildIslands(b, r) },
      { label: 'town1', run: (b, r) => this.buildTown(b, r, 90) },
      { label: 'town2', run: (b, r) => this.buildTown(b, r, 90) },
      { label: 'town3', run: (b, r) => this.buildTown(b, r, 90) },
      { label: 'town4', run: (b, r) => this.buildTown(b, r, 80) },
      { label: 'landmarks', run: (b, r) => this.buildLandmarks(b, r) },
      { label: 'wharf', run: (b, r) => this.buildWharf(b, r) },
    ];
  }

  /* ---------------------------------------------------------------- *
   *  geometry
   * ---------------------------------------------------------------- */

  /**
   * The peninsula: three hills on a low neck, lofted as a ridge of
   * cross-sections so the skyline is a silhouette rather than a box.
   */
  private buildLand(b: MeshBuilder, rng: () => number): void {
    const grass = srgb(0x54603a);
    const dry = srgb(0x6d6b46);
    const beach = srgb(0xb9ac8b);
    const aux: Aux = [0, 0, 0, 0.9];

    const nx = 40;
    const nz = 12;
    const halfL = TOWN_LEN * 0.5;
    const depth = 900;
    const rows: number[][] = [];
    for (let j = 0; j < nz; j++) {
      const v = j / (nz - 1);
      // v = 0 is the waterfront, v = 1 is inland.
      const z = -depth * 0.15 + v * depth;
      const row: number[] = [];
      for (let i = 0; i < nx; i++) {
        const u = i / (nx - 1);
        const x = -halfL + u * TOWN_LEN;
        row.push(b.vert(x, this.landHeight(x, z, rng), z, this.landColour(x, z, grass, dry, beach), aux));
      }
      rows.push(row);
    }
    b.tube(rows, false);

    // A skirt down to the seabed, so the town is never a floating slab seen
    // from a wave trough.
    const front = rows[0];
    const skirt: number[] = [];
    for (let i = 0; i < nx; i++) {
      const u = i / (nx - 1);
      const x = -halfL + u * TOWN_LEN;
      skirt.push(b.vert(x, -26, -depth * 0.15 - 60, mixRGB(beach, srgb(0x2c3a34), 0.7), aux));
    }
    b.tube([skirt, front], false);
  }

  private landHeight(x: number, z: number, rng: () => number): number {
    const halfL = TOWN_LEN * 0.5;
    const t = x / halfL;
    // Copp's Hill, Beacon Hill, Fort Hill: the Trimountain.
    const hills =
      BEACON_H * Math.exp(-Math.pow((t + 0.05) / 0.26, 2)) +
      BEACON_H * 0.62 * Math.exp(-Math.pow((t + 0.62) / 0.18, 2)) +
      BEACON_H * 0.55 * Math.exp(-Math.pow((t - 0.55) / 0.2, 2));
    // Inland the ground rises away from the waterfront.
    const inland = Math.max(0, z / 700);
    const shore = Math.min(1, Math.max(0, (z + 60) / 150));
    const jitter = (rng() - 0.5) * 2.4;
    return (hills * (0.35 + 0.65 * inland) + 6 * inland) * shore + jitter * shore;
  }

  private landColour(x: number, z: number, grass: RGB, dry: RGB, beach: RGB): RGB {
    if (z < 10) return beach;
    const t = Math.min(1, Math.max(0, (z - 10) / 260));
    return mixRGB(mixRGB(beach, grass, t), dry, 0.25 + 0.2 * Math.sin(x * 0.004));
  }

  /** The harbour islands: low drumlins in a line seaward of the town. */
  private buildIslands(b: MeshBuilder, rng: () => number): void {
    const grass = srgb(0x4d5a36);
    const rock = srgb(0x5b5952);
    const aux: Aux = [0, 0, 0, 0.92];
    const spots = [
      [-1500, -2600, 340, 26],
      [-450, -3150, 300, 21],
      [700, -2500, 260, 18],
      [1700, -3000, 420, 31],
      [1150, -1350, 220, 12],
      [-1900, -1500, 200, 14],
    ];
    for (const [cx, cz, rad, h] of spots) {
      const ringN = 14;
      const rings: number[][] = [];
      for (let k = 0; k < 5; k++) {
        const s = k / 4;
        const rr = rad * Math.cos(s * Math.PI * 0.5);
        const y = h * Math.sin(s * Math.PI * 0.5) * (0.7 + 0.3 * s);
        const ring: number[] = [];
        for (let j = 0; j < ringN; j++) {
          const th = (j / ringN) * Math.PI * 2;
          const wob = 0.78 + 0.34 * Math.sin(th * 3 + cx * 0.01);
          ring.push(
            b.vert(
              cx + Math.cos(th) * rr * wob,
              y - 3 + (rng() - 0.5) * 1.2,
              cz + Math.sin(th) * rr * wob * 0.72,
              mixRGB(rock, grass, Math.min(1, y / Math.max(1, h * 0.5))),
              aux,
            ),
          );
        }
        rings.push(ring);
      }
      b.tube(rings, true);
      const cap = b.vert(cx, h, cz, grass, aux);
      const top = rings[rings.length - 1];
      for (let j = 0; j < ringN; j++) b.tri(cap, top[j], top[(j + 1) % ringN]);
    }
  }

  /** Brick and clapboard, packed on the slopes and thinning inland. */
  private buildTown(b: MeshBuilder, rng: () => number, count: number): void {
    const brick = srgb(0x7a4a3a);
    const clap = srgb(0xa9a494);
    const slate = srgb(0x4a4c52);
    const aux: Aux = [0, 0, 0, 0.86];
    const halfL = TOWN_LEN * 0.5;

    for (let n = 0; n < count; n++) {
      const u = rng();
      // Densest on the waterfront and up the near slope of Beacon Hill.
      const x = -halfL * 0.86 + u * TOWN_LEN * 0.86;
      const z = 10 + Math.pow(rng(), 1.5) * 640;
      const ground = this.landHeight(x, z, rng);
      if (ground < 0.6) continue;
      const w = 7 + rng() * 13;
      const d = 7 + rng() * 12;
      const h = 6 + rng() * 9 + (z < 160 ? 3 : 0);
      const wall = rng() < 0.62 ? brick : clap;
      b.box(x, ground + h * 0.5, z, w * 0.5, h * 0.5, d * 0.5, wall, aux);
      // A darker, slightly smaller cap reads as a pitched slate roof at range.
      b.box(x, ground + h + 1.6, z, w * 0.44, 1.7, d * 0.44, slate, aux);
    }
  }

  /** The things that make it Boston and not a town. */
  private buildLandmarks(b: MeshBuilder, rng: () => number): void {
    const aux: Aux = [0, 0, 0, 0.8];
    // Deliberately near-white: at 5 km the aerial perspective eats everything
    // that is not much brighter than the haze, and the spires and the dome are
    // the only parts of the silhouette a player can actually name.
    const stone = srgb(0xdcd6c2);
    const white = srgb(0xf4f1e6);
    const lead = srgb(0xb6b8b6);
    const halfL = TOWN_LEN * 0.5;

    // --- the State House on the crest of Beacon Hill
    const shX = -halfL * 0.05;
    const shZ = 300;
    const shY = this.landHeight(shX, shZ, rng);
    b.box(shX, shY + 11, shZ, 34, 11, 15, srgb(0x8d5a44), aux);
    b.box(shX, shY + 24, shZ, 13, 3, 13, stone, aux);
    // Drum and dome. Bulfinch's was shingled in 1798, so pale, not gold.
    b.cyl(shX, shY + 27, shZ, shX, shY + 34, shZ, 9, 8.4, 12, stone, aux);
    const domeRings: number[][] = [];
    for (let k = 0; k <= 5; k++) {
      const s = k / 5;
      const rr = 8.4 * Math.cos(s * Math.PI * 0.5);
      const yy = shY + 34 + 11 * Math.sin(s * Math.PI * 0.5);
      const ring: number[] = [];
      for (let j = 0; j < 12; j++) {
        const th = (j / 12) * Math.PI * 2;
        ring.push(b.vert(shX + Math.cos(th) * rr, yy, shZ + Math.sin(th) * rr, lead, aux));
      }
      domeRings.push(ring);
    }
    b.tube(domeRings, true);
    b.cyl(shX, shY + 45, shZ, shX, shY + 52, shZ, 0.9, 0.3, 5, stone, aux);

    // --- spires. Old North is the tall one, and it is northernmost.
    const spires = [
      [-halfL * 0.66, 130, 58],
      [-halfL * 0.3, 210, 44],
      [halfL * 0.06, 150, 40],
      [halfL * 0.34, 240, 46],
      [halfL * 0.62, 170, 38],
    ];
    for (const [sx, sz, sh] of spires) {
      const g = this.landHeight(sx, sz, rng);
      b.box(sx, g + sh * 0.3, sz, 5.5, sh * 0.3, 5.5, white, aux);
      b.cyl(sx, g + sh * 0.6, sz, sx, g + sh, sz, 4.2, 0.25, 6, white, aux);
    }

    // --- Boston Light on the outermost drumlin, and the fort on Castle Island
    b.cyl(1700, 26, -3000, 1700, 26 + 24, -3000, 4.6, 3.2, 10, white, aux);
    b.cyl(1700, 50, -3000, 1700, 54, -3000, 3.6, 3.2, 10, srgb(0x2f3338), aux);

    const fx = 1150;
    const fz = -1350;
    const fy = 12;
    for (let j = 0; j < 5; j++) {
      const th = (j / 5) * Math.PI * 2;
      const nth = ((j + 1) / 5) * Math.PI * 2;
      const r0 = 105;
      b.box(
        fx + Math.cos((th + nth) * 0.5) * r0 * 0.82,
        fy + 4,
        fz + Math.sin((th + nth) * 0.5) * r0 * 0.82,
        26,
        4.5,
        13,
        srgb(0x8a7f68),
        aux,
      );
    }
    b.box(fx, fy + 6, fz, 30, 6, 30, srgb(0x7d7360), aux);
  }

  /**
   * Long Wharf and the shipping. A forest of masts alongside a quay is the most
   * legible thing about a seaport, and at 8 km it is the only thing you can
   * read apart from the hills.
   */
  private buildWharf(b: MeshBuilder, rng: () => number): void {
    const aux: Aux = [0, 0, 0, 0.85];
    const timber = srgb(0x6b5a44);
    const spar = srgb(0xa8834e);
    const stone = srgb(0x8b8474);

    // The wharf itself: half a kilometre out into the harbour.
    b.box(60, 2.4, -230, 17, 2.4, 250, stone, aux);
    b.box(60, 5.5, -60, 12, 4.5, 40, timber, aux);
    // Other quays either side.
    b.box(-420, 2.0, -120, 90, 2.0, 26, stone, aux);
    b.box(520, 2.0, -140, 110, 2.0, 24, stone, aux);

    // Masts. Two ranks either side of Long Wharf plus a scatter in the roads.
    for (let n = 0; n < 64; n++) {
      const alongWharf = n < 44;
      const side = n % 2 === 0 ? 1 : -1;
      const x = alongWharf ? 60 + side * (26 + rng() * 10) : -700 + rng() * 1500;
      const z = alongWharf ? -430 + rng() * 380 : -700 - rng() * 900;
      const h = 16 + rng() * 24;
      const r = 0.30 + rng() * 0.14;
      b.cyl(x, 0.5, z, x + (rng() - 0.5) * 1.4, h, z, r, r * 0.3, 5, spar, aux);
      // One or two yards: without them a mast is a stick, not a ship.
      const yards = 1 + (rng() < 0.55 ? 1 : 0);
      for (let k = 0; k < yards; k++) {
        const yy = h * (0.42 + k * 0.26);
        const hs = 3.5 + rng() * 4.5;
        b.cyl(x - hs, yy, z, x + hs, yy, z, r * 0.36, r * 0.36, 4, spar, aux);
      }
      // A dark hull under her, just proud of the water.
      b.box(x, 1.1, z, 3.4, 1.5, 8 + rng() * 7, srgb(0x2a2722), aux);
    }
  }

  /* ---------------------------------------------------------------- *
   *  frame
   * ---------------------------------------------------------------- */

  update(world: World, dt: number): void {
    // --- appearance
    this.nextEvent -= dt;
    if (this.nextEvent <= 0) {
      if (this.placed) {
        this.nextEvent = this.draw(Boston.MEAN_GAP_S);
      } else {
        this.place(world, 5000 + this.rng() * 3600);
        this.nextEvent = this.draw(Boston.MEAN_GAP_S * 1.6);
      }
    }

    // --- time-sliced build
    if (this.builder) {
      const t0 = performance.now();
      while (this.sliceIndex < this.slices.length && performance.now() - t0 < BUILD_BUDGET_MS) {
        this.slices[this.sliceIndex].run(this.builder, this.rng);
        this.sliceIndex++;
      }
      world.stats['world.bostonBuildMs'] = performance.now() - t0;
      if (this.sliceIndex >= this.slices.length) {
        this.commit(world, this.builder);
        this.builder = null;
        this.slices.length = 0;
      }
      return;
    }

    const mesh = this.mesh;
    if (!mesh || !this.placed) return;

    // Absolute -> render space, exactly as the islands do it, so a rebase costs
    // nothing and a landfall you sail away from is still where you left it.
    const rx = this.absX - world.origin.x;
    const rz = this.absZ - world.origin.z;
    const d = Math.hypot(rx - world.ship.position.x, rz - world.ship.position.z);
    if (d > Boston.RETIRE_M) {
      this.placed = false;
      mesh.visible = false;
      return;
    }
    mesh.visible = true;
    this.xf.setXYZW(0, rx, 0, rz, this.bearing);
    this.xf.needsUpdate = true;
    (mesh.geometry.boundingSphere as THREE.Sphere).center.set(rx, 120, rz);
    world.stats['world.bostonRangeM'] = Math.round(d);
  }

  private commit(world: World, b: MeshBuilder): void {
    const body = b.finish('world-boston');
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', body.getAttribute('position'));
    geo.setAttribute('normal', body.getAttribute('normal'));
    geo.setAttribute('aCol', body.getAttribute('aCol'));
    geo.setAttribute('aAux', body.getAttribute('aAux'));
    geo.setIndex(body.getIndex());
    geo.instanceCount = 1;
    this.xf = new THREE.InstancedBufferAttribute(new Float32Array([0, 0, 0, 0]), 4);
    this.mo = new THREE.InstancedBufferAttribute(new Float32Array([0, 0, 1, 0]), 4);
    this.bd = new THREE.InstancedBufferAttribute(new Float32Array([0, 0, 1, 0]), 4);
    this.xf.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aXf', this.xf);
    geo.setAttribute('aMo', this.mo);
    geo.setAttribute('aBd', this.bd);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), TOWN_LEN);

    this.material = new THREE.ShaderMaterial({
      name: 'world-boston',
      uniforms: { ...world.uniforms },
      vertexShader: vesselVert,
      fragmentShader: vesselFrag,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'world-boston';
    this.mesh.visible = false;
    world.scene.add(this.mesh);
    world.stats['world.bostonTris'] = (body.getIndex()?.count ?? 0) / 3;
  }

  dispose(): void {
    this.mesh?.removeFromParent();
    this.mesh?.geometry.dispose();
    this.material?.dispose();
    this.mesh = null;
    this.material = null;
    this.builder = null;
  }
}
