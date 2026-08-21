import * as THREE from 'three';
import type { FoamSource, World } from '../types';
import { damp, makeRng, smoothstep, wrapPi } from '../util/math';
import { buildVessel, STRIPE_COLOUR, VESSEL_SPECS, type VesselSpec } from './vesselGeom';
import { vesselFrag, vesselShared, vesselVert } from './shaders/vessel';
import { srgb, toInstanced } from './wgeom';
import type { WorldExt } from './api';

/**
 * Blending on a material that is NOT in the transparent list.
 *
 * The whole hull, her spars and her canvas write alpha 1, so with these factors
 * they composite to exactly the pixels an opaque draw produced; only a rope
 * writes a partial alpha, and it needs to blend or the coverage filter has
 * nothing to give its ink to. `transparent: false` is what keeps the mesh in
 * the opaque list — three only consults `transparent` when it decides which
 * list an object joins, and applies `blending` either way — so the sort order,
 * the depth write and the aerial-perspective maths are all untouched. The
 * `renderOrder` puts her after the sea and the land she may be blended against.
 */
const ROPE_BLEND = {
  transparent: false,
  depthWrite: true,
  blending: THREE.CustomBlending,
  blendSrc: THREE.SrcAlphaFactor,
  blendDst: THREE.OneMinusSrcAlphaFactor,
  blendSrcAlpha: THREE.OneFactor,
  blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
} as const;

/** The painted band and her gunports, for the fragment shader's box filter. */
function paintUniforms(spec: VesselSpec): Record<string, { value: THREE.Vector4 }> {
  const c = srgb(STRIPE_COLOUR);
  const period = spec.ports > 0 ? spec.loa / spec.ports : 0;
  return {
    uStripe: { value: new THREE.Vector4(c[0], c[1], c[2], spec.stripeH) },
    // Ports are roughly square and stop short of the stem and the transom.
    uPorts: { value: new THREE.Vector4(period, spec.stripeH * 0.62, spec.stripeH * 0.66, spec.loa * 0.34) },
  };
}

const MAX_VESSELS = 4;
/** Mean seconds between one sail appearing and the next. */
const MEAN_GAP_S = 215;
const RETIRE_M = 12500;
/**
 * Closest a stranger's helmsman will let her come. The avoidance term used to
 * start at three times this and carry a gain of 0.85, which meant a vessel
 * 400 m off was throwing 50 degrees of helm to dodge a ship that was never
 * going to hit her — measured, it swung a brig from broadside to nearly
 * stern-on and her square sails went edge-on and vanished.
 */
const AVOID_M = 260;
const AVOID_START = AVOID_M * 1.6;
/** How close she has to be before it is worth spending an ocean foam slot. */
const FOAM_RANGE_M = 430;

/** Beating: the closest a square-rigger will lie to the true wind. */
const CLOSE_HAULED = 0.82;
const NO_GO = 0.62;

type Flavour = 'crossing' | 'reciprocal' | 'overhaul' | 'distant';

interface Vessel {
  active: boolean;
  type: number;
  flavour: Flavour;
  x: number;
  z: number;
  y: number;
  heading: number;
  speed: number;
  /** Where she actually wants to go, if the wind allowed it. */
  course: number;
  /** +1 = starboard tack, -1 = port. */
  tack: number;
  tackTimer: number;
  heel: number;
  pitch: number;
  /** Set by the review hook: hold this course, do not dodge, do not tack. */
  held: boolean;
  /**
   * Review hook: keep station on the player instead of sailing.
   *
   * A close pass is the event this whole module exists for, and it cannot be
   * A/B'd from a capture unless the range is a constant. Left to sail, a
   * showcase vessel placed 420 m off closes to 259 m in the nine seconds a
   * capture settles for, which is a 62 per cent change of pixel scale between
   * two runs of identical code. `stationR` metres at `stationRel` radians off
   * the bow, re-asserted every frame, makes the crop repeatable.
   */
  station: boolean;
  stationRel: number;
  stationR: number;
  stationHead: number;
  brace: number;
  sheet: number;
  bulge: number;
  scale: number;
  tint: number;
}

/**
 * A pool of one hull type, built the first time that type is wanted.
 */
class VesselBatch {
  readonly mesh: THREE.Mesh;
  private geo: THREE.InstancedBufferGeometry;
  private material: THREE.ShaderMaterial;
  private xf: THREE.InstancedBufferAttribute;
  private mo: THREE.InstancedBufferAttribute;
  private bd: THREE.InstancedBufferAttribute;
  private axf: Float32Array;
  private amo: Float32Array;
  private abd: Float32Array;
  private n = 0;
  private lo = new THREE.Vector3();
  private hi = new THREE.Vector3();
  private radius: number;

  constructor(world: World, spec: VesselSpec, max: number) {
    const body = buildVessel(spec);
    this.radius = body.boundingSphere?.radius ?? spec.loa;
    this.geo = toInstanced(body);
    body.dispose();
    this.axf = new Float32Array(max * 4);
    this.amo = new Float32Array(max * 4);
    this.abd = new Float32Array(max * 4);
    this.xf = new THREE.InstancedBufferAttribute(this.axf, 4);
    this.mo = new THREE.InstancedBufferAttribute(this.amo, 4);
    this.bd = new THREE.InstancedBufferAttribute(this.abd, 4);
    for (const a of [this.xf, this.mo, this.bd]) a.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('aXf', this.xf);
    this.geo.setAttribute('aMo', this.mo);
    this.geo.setAttribute('aBd', this.bd);
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1);

    this.material = new THREE.ShaderMaterial({
      name: `world-vessel-${spec.key}`,
      uniforms: { ...world.uniforms, ...vesselShared, ...paintUniforms(spec) },
      vertexShader: vesselVert,
      fragmentShader: vesselFrag,
      side: THREE.DoubleSide,
      ...ROPE_BLEND,
    });
    this.mesh = new THREE.Mesh(this.geo, this.material);
    this.mesh.name = `world-vessel-${spec.key}`;
    this.mesh.renderOrder = 1;
    this.mesh.visible = false;
    // The hull metrics, for a probe that wants to sample the ship's side at a
    // known height rather than guess a box from the vertex buffer.
    this.mesh.userData.spec = spec;
    world.scene.add(this.mesh);
  }

  begin(): void {
    this.n = 0;
    this.lo.set(Infinity, Infinity, Infinity);
    this.hi.set(-Infinity, -Infinity, -Infinity);
  }

  push(v: Vessel): void {
    const o = this.n * 4;
    if (o + 3 >= this.axf.length) return;
    this.n++;
    this.axf[o] = v.x; this.axf[o + 1] = v.y; this.axf[o + 2] = v.z; this.axf[o + 3] = v.heading;
    this.amo[o] = v.heel; this.amo[o + 1] = v.pitch; this.amo[o + 2] = v.scale; this.amo[o + 3] = v.brace;
    this.abd[o] = v.sheet; this.abd[o + 1] = v.bulge; this.abd[o + 2] = v.tint; this.abd[o + 3] = 0;
    if (v.x < this.lo.x) this.lo.x = v.x;
    if (v.y < this.lo.y) this.lo.y = v.y;
    if (v.z < this.lo.z) this.lo.z = v.z;
    if (v.x > this.hi.x) this.hi.x = v.x;
    if (v.y > this.hi.y) this.hi.y = v.y;
    if (v.z > this.hi.z) this.hi.z = v.z;
  }

  end(): void {
    this.geo.instanceCount = this.n;
    this.mesh.visible = this.n > 0;
    if (this.n === 0) return;
    this.xf.needsUpdate = true;
    this.mo.needsUpdate = true;
    this.bd.needsUpdate = true;
    const s = this.geo.boundingSphere!;
    s.center.set((this.lo.x + this.hi.x) * 0.5, (this.lo.y + this.hi.y) * 0.5, (this.lo.z + this.hi.z) * 0.5);
    s.radius =
      0.5 * Math.hypot(this.hi.x - this.lo.x, this.hi.y - this.lo.y, this.hi.z - this.lo.z) +
      this.radius * 1.5;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geo.dispose();
    this.material.dispose();
  }
}

/**
 * Other vessels, actually sailing.
 *
 * Every one of them is on a real point of sail: her speed comes off a polar,
 * she cannot lie closer than 47 degrees to the wind, she beats and goes about
 * when her course is dead to windward, her yards are braced to the wind she
 * has, and she heels to leeward in proportion to it. That is the difference
 * between company and scenery — a static prop on the horizon is worse than an
 * empty sea, because it tells the player the world is a painting.
 *
 * The `overhaul` flavour is the one worth waiting for: she is put three
 * kilometres ahead making a knot less than you, so you spend four or five
 * minutes creeping up on her.
 */
export class Vessels {
  private batches: (VesselBatch | null)[] = [];
  private vessels: Vessel[] = [];
  private rng = makeRng(0x5c0f);
  private nextEvent = 0;
  private cap = 3;
  private pendingBuild = -1;
  private foam: FoamSource | null = null;
  private offShift: (() => void) | null = null;
  private world!: World;

  init(world: World): void {
    this.world = world;
    for (let i = 0; i < VESSEL_SPECS.length; i++) this.batches.push(null);
    for (let i = 0; i < MAX_VESSELS; i++) {
      this.vessels.push({
        active: false, type: 0, flavour: 'crossing', x: 0, z: 0, y: 0,
        heading: 0, speed: 0, course: 0, tack: 1, tackTimer: 0,
        heel: 0, pitch: 0, held: false,
        station: false, stationRel: 0, stationR: 0, stationHead: 0,
        brace: 0, sheet: 0, bulge: 0, scale: 1, tint: 1,
      });
    }
    this.applySettings(world);
    this.nextEvent = this.draw(MEAN_GAP_S * 0.25);

    if (world.ocean?.addFoamSource) {
      // One of the ocean's eight foam slots, used only for a vessel inside
      // 430 m. Outside that the source is switched off with strength 0.
      this.foam = { position: new THREE.Vector3(0, 0, 0), radius: 14, strength: 0 };
      world.ocean.addFoamSource(this.foam);
    }

    this.offShift = world.bus.on('origin:shift', (p) => {
      const d = p as THREE.Vector3 | undefined;
      if (!d) return;
      for (const v of this.vessels) {
        v.x += d.x;
        v.z += d.z;
      }
    });
  }

  applySettings(world: World): void {
    const q = world.settings.quality;
    this.cap = q === 'low' ? 1 : q === 'medium' ? 2 : 3;
  }

  private draw(mean: number): number {
    return -mean * Math.log(1 - this.rng() * 0.999);
  }

  showcase(world: World): void {
    this.spawn(world, 'overhaul', 1);
    this.spawn(world, 'reciprocal', 0);
    this.spawn(world, 'distant', 2);
    this.nextEvent = MEAN_GAP_S * 4;
  }

  /**
   * Put one of each hull close aboard, on the beam, so a reviewer can actually
   * look at the construction instead of a three-pixel silhouette.
   */
  showcaseNear(world: World, scale = 1): void {
    // NOT beam-on. A square-rigger's yards are athwartships, so her beam is
    // exactly the angle from which every sail is edge-on and the rig reads as
    // two bare poles — which is what the first review crop showed. Put her on a
    // near-reciprocal course instead, so we look at her from about 35 degrees
    // off the bow and see the faces of the canvas whatever the brace.
    //
    // The ranges are from the SHIP; the chase camera sits about 74 m astern of
    // her, so these put all three hulls 150-165 m from the lens, which is the
    // range a close pass is judged at.
    const ranges = [80, 88, 85];
    const rels = [0.0, 0.34, -0.45];
    for (let t = 0; t < VESSEL_SPECS.length; t++) {
      const slot = this.vessels.find((v) => !v.active);
      if (!slot) break;
      const side = rels[t] >= 0 ? 1 : -1;
      // The two rigs want opposite viewing angles and there is no compromise:
      // a square yard is athwartships, so her sails face you from ahead or
      // astern; a gaff sail lies along the keel, so hers face you from abeam.
      // Get it wrong and the canvas is edge-on and she looks bare-poled.
      const foreAndAft = VESSEL_SPECS[t].masts.every((m) => m.squares === 0);
      slot.type = t;
      slot.flavour = 'crossing';
      slot.station = true;
      slot.stationRel = rels[t];
      slot.stationR = ranges[t] * scale;
      slot.stationHead = foreAndAft
        ? rels[t] + Math.PI * 0.5
        : rels[t] + Math.PI - side * 0.62;
      slot.tack = 1;
      slot.tackTimer = 1e6;
      slot.speed = VESSEL_SPECS[t].topSpeed * 0.6;
      slot.heel = 0;
      slot.pitch = 0;
      slot.held = true;
      slot.scale = 1;
      slot.tint = 1;
      slot.active = true;
      if (!this.batches[t]) this.pendingBuild = t;
    }
    this.nextEvent = MEAN_GAP_S * 8;
  }

  private ensureBatch(type: number): boolean {
    if (this.batches[type]) return true;
    // One hull built per frame at most: the whole geometry is well under a
    // millisecond, but two at once during a landfall is not worth the risk.
    if (this.pendingBuild >= 0 && this.pendingBuild !== type) return false;
    this.batches[type] = new VesselBatch(this.world, VESSEL_SPECS[type], MAX_VESSELS);
    this.pendingBuild = -1;
    return true;
  }

  private spawn(world: World, flavour: Flavour, forceType: number): void {
    const r = this.rng;
    const slot = this.vessels.find((v) => !v.active);
    if (!slot) return;

    const ship = world.ship;
    const h = ship.heading;
    let range: number;
    let bearing: number;
    let course: number;

    switch (flavour) {
      case 'reciprocal':
        range = 5200 + r() * 3800;
        bearing = h + (r() - 0.5) * 0.34;
        // Reciprocal course with a lateral offset, so she passes rather than rams.
        course = h + Math.PI + (r() - 0.5) * 0.22;
        break;
      case 'overhaul':
        range = 2600 + r() * 2100;
        bearing = h + (r() - 0.5) * 0.30;
        course = h + (r() - 0.5) * 0.16;
        break;
      case 'distant':
        range = 7000 + r() * 4200;
        bearing = h + (r() - 0.5) * 2.4;
        course = r() * Math.PI * 2;
        break;
      default:
        range = 4200 + r() * 3600;
        bearing = h + (r() < 0.5 ? -1 : 1) * (0.7 + r() * 1.5);
        course = h + Math.PI * 0.5 + (r() - 0.5) * 1.2;
        break;
    }

    slot.type = forceType;
    slot.flavour = flavour;
    slot.x = ship.position.x + Math.sin(bearing) * range;
    slot.z = ship.position.z - Math.cos(bearing) * range;
    slot.course = course;
    slot.heading = course;
    slot.tack = r() < 0.5 ? 1 : -1;
    slot.tackTimer = 60 + r() * 130;
    slot.speed = 2;
    slot.heel = 0;
    slot.pitch = 0;
    slot.scale = 0.94 + r() * 0.12;
    slot.tint = 0.9 + r() * 0.2;
    slot.held = false;
    slot.station = false;
    slot.active = true;
    if (!this.batches[slot.type]) this.pendingBuild = slot.type;
    world.bus.emit('world:sail', { type: VESSEL_SPECS[slot.type].label, range });
  }

  private pickType(world: World, flavour: Flavour): number {
    const r = this.rng();
    if (flavour === 'distant') return r < 0.55 ? 2 : 1;
    const w = world.ext.world as WorldExt | undefined;
    const land = w?.nearestLand(world.ship.position.x, world.ship.position.z, 9000);
    // Working boats belong near the land they work out of.
    if (land && r < 0.62) return 0;
    if (r < 0.34) return 0;
    if (r < 0.88) return 1;
    return 2;
  }

  update(world: World, dt: number): void {
    let live = 0;
    for (const v of this.vessels) if (v.active) live++;

    this.nextEvent -= dt;
    if (this.nextEvent <= 0) {
      this.nextEvent = this.draw(MEAN_GAP_S);
      if (live < this.cap) {
        const u = this.rng();
        const flavour: Flavour =
          u < 0.3 ? 'crossing' : u < 0.55 ? 'reciprocal' : u < 0.8 ? 'overhaul' : 'distant';
        this.spawn(world, flavour, this.pickType(world, flavour));
      }
    }

    for (const b of this.batches) b?.begin();

    const env = world.env;
    const ocean = world.ocean;
    const shipX = world.ship.position.x;
    const shipZ = world.ship.position.z;
    let nearest: Vessel | null = null;
    let nearestD = Infinity;

    for (const v of this.vessels) {
      if (!v.active) continue;
      const spec = VESSEL_SPECS[v.type];

      // --- helm: sail the course she wants, or beat if it is to windward
      v.tackTimer -= dt;
      const wantOff = wrapPi(env.windBearing - v.course);
      let steer = v.course;
      if (!v.held && Math.abs(wantOff) < CLOSE_HAULED) {
        if (v.tackTimer <= 0) {
          v.tack = -v.tack;
          v.tackTimer = 70 + this.rng() * 150;
        }
        steer = env.windBearing - v.tack * CLOSE_HAULED;
      }

      // Give the player room: nobody sails straight through you. Deliberately
      // weak and short-ranged so it nudges rather than steers.
      let dxs = v.x - shipX;
      let dzs = v.z - shipZ;
      let ds = Math.hypot(dxs, dzs);
      if (!v.held && ds < AVOID_START) {
        const away = Math.atan2(dxs, -dzs);
        steer += wrapPi(away - steer) * (1 - ds / AVOID_START) * 0.5;
      }

      if (v.station) {
        const bear = world.ship.heading + v.stationRel;
        v.x = shipX + Math.sin(bear) * v.stationR;
        v.z = shipZ - Math.cos(bear) * v.stationR;
        v.heading = world.ship.heading + v.stationHead;
        dxs = v.x - shipX;
        dzs = v.z - shipZ;
        ds = v.stationR;
      } else {
        v.heading += wrapPi(steer - v.heading) * Math.min(1, dt * 0.22);
      }

      // --- polar. No-go zone, then a broad peak on a reach.
      const twa = wrapPi(env.windBearing - v.heading);
      const a = Math.abs(twa);
      const drive = smoothstep(NO_GO, 1.15, a);
      const shape = 0.58 + 0.42 * Math.exp(-Math.pow((a - 2.0) / 1.15, 2));
      const windK = THREE.MathUtils.clamp((env.windSpeed * env.gust) / 9, 0.22, 1.3);
      const slower = v.flavour === 'overhaul' ? 0.74 : 1;
      const target = spec.topSpeed * drive * shape * windK * slower;
      const fx = Math.sin(v.heading);
      const fz = -Math.cos(v.heading);
      if (!v.station) {
        v.speed = damp(v.speed, target, 0.09, dt);
        v.x += fx * v.speed * dt;
        v.z += fz * v.speed * dt;
      }

      // --- attitude. Heel to leeward, pitch from the wave she is actually on.
      // A three-decker is stiffer than a fishing boat, so `stiffness` divides.
      const heelMag = Math.min(0.34, Math.pow(env.windSpeed * env.gust, 2) * 2.6e-3 * Math.sin(a)) /
        spec.stiffness;
      v.heel = damp(v.heel, -Math.sign(twa || 1) * heelMag, 1.2, dt);

      if (ocean) {
        const hb = ocean.sampleHeight(v.x + fx * spec.loa * 0.42, v.z + fz * spec.loa * 0.42);
        const hs = ocean.sampleHeight(v.x - fx * spec.loa * 0.42, v.z - fz * spec.loa * 0.42);
        v.y = (hb + hs) * 0.5;
        v.pitch = damp(v.pitch, Math.atan2(hb - hs, spec.loa * 0.84), 6, dt);
      } else {
        v.y = 0;
      }

      // --- rig. Yards braced to the wind she has, sheets eased as she bears away.
      const s = Math.sign(twa || 1);
      v.brace = damp(v.brace, -s * (1 - a / Math.PI) * 0.95, 0.9, dt);
      v.sheet = damp(v.sheet, s * (0.16 + (a / Math.PI) * 1.05), 0.9, dt);
      // Cloth is never a flat sheet, even luffing, so the belly has a floor.
      v.bulge = damp(v.bulge, Math.cos(twa) * (0.42 + env.windSpeed * 0.07) * (0.4 + 0.6 * drive), 1.5, dt);

      // A stationed hull sits upright: the point of the hook is to see how she
      // is built, and 0.15 rad of heel moves her side by 0.6 m on a 1.65 m
      // freeboard, which is most of a hull's worth of sampling error for
      // anything trying to measure her paint.
      if (v.station) {
        v.heel = 0;
        v.pitch = 0;
      }

      if (ds > RETIRE_M) {
        v.active = false;
        continue;
      }
      if (ds < nearestD) {
        nearestD = ds;
        nearest = v;
      }
      if (this.ensureBatch(v.type)) this.batches[v.type]!.push(v);
    }

    for (const b of this.batches) b?.end();

    if (this.foam) {
      if (nearest && nearestD < FOAM_RANGE_M) {
        const spec = VESSEL_SPECS[nearest.type];
        this.foam.position.set(nearest.x, 0, nearest.z);
        this.foam.radius = spec.loa * 0.42;
        this.foam.strength = Math.min(1, nearest.speed / 3) * (1 - nearestD / FOAM_RANGE_M);
      } else {
        this.foam.strength = 0;
      }
    }

    world.stats['world.vessels'] = live;
  }

  dispose(): void {
    this.offShift?.();
    this.offShift = null;
    if (this.foam) this.foam.strength = 0;
    for (const b of this.batches) b?.dispose();
    this.batches.length = 0;
  }
}
