import * as THREE from 'three';
import type { WaveSample, World } from '../types';
import { makeRng } from '../util/math';
import { MeshBuilder, srgb, toInstanced, type Aux } from './wgeom';
import { vesselFrag, vesselVert } from './shaders/vessel';
import type { WorldExt } from './api';

const MAX_BUOYS = 4;
/** Only worth placing when there is a channel to mark. */
const LAND_RANGE_M = 4200;

interface Buoy {
  active: boolean;
  /** Absolute voyage coordinates: a channel mark does not wander. */
  ax: number;
  az: number;
  heading: number;
  scale: number;
  tint: number;
  heel: number;
  pitch: number;
}

/**
 * Channel buoys, riding the real wave field.
 *
 * This is the one thing in the world that reads `ocean.sample` rather than
 * `sampleHeight`: the surface normal is what tilts the buoy, so it does not
 * merely rise and fall, it leans into the face of each wave and rights itself
 * in the trough. A buoy that only translates vertically looks like a lift.
 */
export class Buoys {
  private mesh: THREE.Mesh | null = null;
  private material: THREE.ShaderMaterial | null = null;
  private geo: THREE.InstancedBufferGeometry | null = null;
  private xf!: THREE.InstancedBufferAttribute;
  private mo!: THREE.InstancedBufferAttribute;
  private bd!: THREE.InstancedBufferAttribute;
  private axf!: Float32Array;
  private amo!: Float32Array;
  private abd!: Float32Array;
  private buoys: Buoy[] = [];
  private rng = makeRng(0xb1a9);
  private sample: WaveSample = {
    height: 0,
    dx: 0,
    dz: 0,
    normal: new THREE.Vector3(0, 1, 0),
    velocity: new THREE.Vector3(),
  };
  private rescan = 0;

  init(world: World): void {
    const body = this.build();
    this.geo = toInstanced(body);
    body.dispose();
    this.axf = new Float32Array(MAX_BUOYS * 4);
    this.amo = new Float32Array(MAX_BUOYS * 4);
    this.abd = new Float32Array(MAX_BUOYS * 4);
    this.xf = new THREE.InstancedBufferAttribute(this.axf, 4);
    this.mo = new THREE.InstancedBufferAttribute(this.amo, 4);
    this.bd = new THREE.InstancedBufferAttribute(this.abd, 4);
    for (const a of [this.xf, this.mo, this.bd]) a.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('aXf', this.xf);
    this.geo.setAttribute('aMo', this.mo);
    this.geo.setAttribute('aBd', this.bd);
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1);

    this.material = new THREE.ShaderMaterial({
      name: 'world-buoy',
      uniforms: { ...world.uniforms },
      vertexShader: vesselVert,
      fragmentShader: vesselFrag,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(this.geo, this.material);
    this.mesh.name = 'world-buoy';
    this.mesh.visible = false;
    world.scene.add(this.mesh);

    for (let i = 0; i < MAX_BUOYS; i++) {
      this.buoys.push({ active: false, ax: 0, az: 0, heading: 0, scale: 1, tint: 1, heel: 0, pitch: 0 });
    }
  }

  /** A can buoy: 1.9 m body, cage topmark, a bell under it. */
  private build(): THREE.BufferGeometry {
    const b = new MeshBuilder();
    const paint = srgb(0xa32e26);
    const rust = srgb(0x5c3b2c);
    const iron = srgb(0x36383c);
    const aux: Aux = [0, 0, 0, 0.5];
    const rough: Aux = [0, 0, 0, 0.85];

    b.cyl(0, -1.5, 0, 0, -0.55, 0, 0.55, 0.95, 12, rust, rough);
    b.cyl(0, -0.55, 0, 0, 1.25, 0, 0.95, 0.95, 12, paint, aux);
    b.cyl(0, 1.25, 0, 0, 1.62, 0, 0.95, 0.62, 12, paint, aux);
    // Topmark on a short staff, the part you actually see at half a mile.
    b.cyl(0, 1.62, 0, 0, 3.5, 0, 0.11, 0.09, 6, iron, rough);
    for (let k = 0; k < 4; k++) {
      const th = (k / 4) * Math.PI * 2;
      b.cyl(
        Math.cos(th) * 0.42, 2.45, Math.sin(th) * 0.42,
        Math.cos(th) * 0.06, 3.45, Math.sin(th) * 0.06,
        0.055, 0.045, 4, iron, rough,
      );
    }
    b.cyl(-0.45, 3.0, 0, 0.45, 3.0, 0, 0.05, 0.05, 4, iron, rough);
    b.cyl(0, 3.5, 0, 0, 3.95, 0, 0.34, 0.1, 8, iron, rough);
    return b.finish('world-buoy');
  }

  showcase(world: World): void {
    const ship = world.ship;
    const h = ship.heading;
    for (let i = 0; i < 2; i++) {
      const bu = this.buoys[i];
      const side = i === 0 ? 1 : -1;
      const fwd = 120 + i * 40;
      bu.ax = ship.position.x + world.origin.x + Math.sin(h) * fwd + Math.cos(h) * side * 34;
      bu.az = ship.position.z + world.origin.z - Math.cos(h) * fwd + Math.sin(h) * side * 34;
      bu.heading = this.rng() * Math.PI * 2;
      bu.scale = 1;
      bu.tint = i === 0 ? 1 : 0.72;
      bu.active = true;
    }
    this.rescan = 1e6;
  }

  update(world: World, dt: number): void {
    const mesh = this.mesh;
    const geo = this.geo;
    if (!mesh || !geo) return;

    // Placement is tied to land, so it only needs rechecking now and then.
    this.rescan -= dt;
    if (this.rescan <= 0) {
      this.rescan = 6;
      const ext = world.ext.world as WorldExt | undefined;
      const land = ext?.nearestLand(world.ship.position.x, world.ship.position.z, LAND_RANGE_M);
      if (land) {
        // Two marks off the seaward side of the nearest landfall. Derived from
        // the island's own position so they are the same marks every time you
        // come back to it.
        const bx = land.position.x + world.origin.x;
        const bz = land.position.z + world.origin.z;
        const out = land.bearing + Math.PI;
        for (let i = 0; i < 2; i++) {
          const bu = this.buoys[i];
          if (bu.active) continue;
          const off = 420 + i * 260;
          const lat = (i === 0 ? 1 : -1) * 150;
          bu.ax = bx + Math.sin(out) * off + Math.cos(out) * lat;
          bu.az = bz - Math.cos(out) * off + Math.sin(out) * lat;
          bu.heading = (bu.ax * 0.7 + bu.az * 0.3) % (Math.PI * 2);
          bu.scale = 1;
          bu.tint = i === 0 ? 1 : 0.72;
          bu.active = true;
        }
      }
    }

    const ocean = world.ocean;
    let n = 0;
    let lox = Infinity, loz = Infinity, hix = -Infinity, hiz = -Infinity;

    for (const bu of this.buoys) {
      if (!bu.active) continue;
      const rx = bu.ax - world.origin.x;
      const rz = bu.az - world.origin.z;
      const d = Math.hypot(rx - world.ship.position.x, rz - world.ship.position.z);
      if (d > 9000) {
        bu.active = false;
        continue;
      }
      let y = 0;
      if (ocean) {
        const s = ocean.sample(rx, rz, this.sample);
        y = s.height;
        // The surface normal, not just the height: a mark leans into the face of
        // a wave and rights itself in the trough, and that motion is the read.
        const fx = Math.sin(bu.heading);
        const fz = -Math.cos(bu.heading);
        const sx = Math.cos(bu.heading);
        const sz = Math.sin(bu.heading);
        const nf = s.normal.x * fx + s.normal.z * fz;
        const ns = s.normal.x * sx + s.normal.z * sz;
        // A moored buoy is much less compliant than the water; 0.7 keeps it from
        // lying flat on a steep face.
        bu.pitch = -Math.asin(THREE.MathUtils.clamp(nf, -1, 1)) * 0.7;
        bu.heel = Math.asin(THREE.MathUtils.clamp(ns, -1, 1)) * 0.7;
      }
      const o = n * 4;
      this.axf[o] = rx; this.axf[o + 1] = y; this.axf[o + 2] = rz; this.axf[o + 3] = bu.heading;
      this.amo[o] = bu.heel; this.amo[o + 1] = bu.pitch; this.amo[o + 2] = bu.scale; this.amo[o + 3] = 0;
      this.abd[o] = 0; this.abd[o + 1] = 0; this.abd[o + 2] = bu.tint; this.abd[o + 3] = 0;
      n++;
      if (rx < lox) lox = rx;
      if (rz < loz) loz = rz;
      if (rx > hix) hix = rx;
      if (rz > hiz) hiz = rz;
    }

    geo.instanceCount = n;
    mesh.visible = n > 0;
    if (n === 0) return;
    this.xf.needsUpdate = true;
    this.mo.needsUpdate = true;
    this.bd.needsUpdate = true;
    const sph = geo.boundingSphere!;
    sph.center.set((lox + hix) * 0.5, 0, (loz + hiz) * 0.5);
    sph.radius = 0.5 * Math.hypot(hix - lox, hiz - loz) + 12;
    world.stats['world.buoys'] = n;
  }

  dispose(): void {
    this.mesh?.removeFromParent();
    this.geo?.dispose();
    this.material?.dispose();
    this.mesh = null;
    this.geo = null;
    this.material = null;
  }
}
