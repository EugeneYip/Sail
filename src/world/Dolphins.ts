import * as THREE from 'three';
import type { World } from '../types';
import { damp, makeRng, toKnots } from '../util/math';
import { buildDolphin } from './creatureGeom';
import { CreaturePool } from './wpool';

const MAX_DOLPHINS = 10;

/** Mean seconds between pods, and how long one stays. */
const MEAN_GAP_S = 275;
const MEAN_VISIT_S = 72;
/** Dolphins ride a pressure wave, so there has to be one. */
const MIN_RIDE_KNOTS = 3.4;

interface Dolphin {
  active: boolean;
  /** Station in ship-local metres: +X starboard, -Z forward. */
  sx: number;
  sz: number;
  /** How much of the station has been taken up, 0 = still closing from abeam. */
  join: number;
  /** Cycle position 0..1 and its period, seconds. */
  u: number;
  period: number;
  weave: number;
  breach: number;
  scale: number;
  tint: number;
  beat: number;
  y: number;
  pitch: number;
  roll: number;
  waterY: number;
}

/**
 * A pod riding the bow wave. The best thing a sailing game can put in front of
 * a player, and it is nearly free: the animals hold station in ship-local
 * coordinates a few metres ahead of the stem, so they inherit the ship's motion
 * and a floating-origin rebase needs no handling at all.
 *
 * The surfacing arc is the whole effect. A dolphin runs submerged, breaks the
 * surface nose-first, rolls its back clear and slides under again; the pitch is
 * the derivative of that height, which is why it looks right without a single
 * keyframe.
 */
export class Dolphins {
  private pool: CreaturePool | null = null;
  private pod: Dolphin[] = [];
  private rng = makeRng(0x2b17);
  private nextEvent = 0;
  private present = false;
  private leaving = false;
  private want = 0;
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();

  init(world: World): void {
    this.pool = new CreaturePool(world, buildDolphin(), MAX_DOLPHINS, 'world-dolphin', 3.1, 0);
    for (let i = 0; i < MAX_DOLPHINS; i++) {
      this.pod.push({
        active: false, sx: 0, sz: 0, join: 0, u: 0, period: 2.2, weave: 0,
        breach: 0, scale: 1, tint: 1, beat: 0, y: 0, pitch: 0, roll: 0, waterY: 0,
      });
    }
    this.nextEvent = this.draw(MEAN_GAP_S * 0.4);
  }

  private draw(mean: number): number {
    return -mean * Math.log(1 - this.rng() * 0.999);
  }

  showcase(): void {
    this.arrive(6 + Math.floor(this.rng() * 4));
    this.nextEvent = MEAN_VISIT_S * 6;
    for (const d of this.pod) if (d.active) d.join = 1;
  }

  private arrive(count: number): void {
    this.present = true;
    this.leaving = false;
    this.want = Math.min(MAX_DOLPHINS, count);
    const r = this.rng;
    for (let i = 0; i < this.want; i++) {
      const d = this.pod[i];
      d.active = true;
      // Two loose ranks off either bow, where the pressure wave actually is.
      const side = i % 2 === 0 ? 1 : -1;
      d.sx = side * (3.2 + r() * 8.5);
      d.sz = -30 - r() * 13 - Math.floor(i / 2) * 2.6;
      d.join = 0;
      d.u = r();
      d.period = 1.9 + r() * 1.5;
      d.weave = r() * Math.PI * 2;
      d.breach = 0;
      d.scale = 0.9 + r() * 0.26;
      d.tint = 0.9 + r() * 0.2;
      d.beat = r() * Math.PI * 2;
    }
    for (let i = this.want; i < MAX_DOLPHINS; i++) this.pod[i].active = false;
  }

  update(world: World, dt: number): void {
    const pool = this.pool;
    if (!pool) return;

    const ship = world.ship;
    const knots = toKnots(ship.velocity.length());

    this.nextEvent -= dt;
    if (this.nextEvent <= 0) {
      if (this.present) {
        if (!this.leaving) {
          this.leaving = true;
          this.nextEvent = 9;
        } else {
          this.present = false;
          this.leaving = false;
          for (const d of this.pod) d.active = false;
          this.nextEvent = this.draw(MEAN_GAP_S);
        }
      } else if (knots >= MIN_RIDE_KNOTS && world.env.waveHeight < 5.5) {
        this.arrive(4 + Math.floor(this.rng() * 6));
        this.nextEvent = this.draw(MEAN_VISIT_S);
        world.bus.emit('world:dolphins', ship.position);
      } else {
        // Nothing to ride: try again shortly rather than burning the encounter.
        this.nextEvent = 12;
      }
    }
    // A ship that stops loses her escort.
    if (this.present && !this.leaving && knots < MIN_RIDE_KNOTS - 0.9) {
      this.leaving = true;
      this.nextEvent = 9;
    }

    const ocean = world.ocean;
    const heading = ship.heading;
    this.q.copy(ship.quaternion);
    let live = 0;

    pool.begin();
    for (const d of this.pod) {
      if (!d.active) continue;
      live++;

      d.join = damp(d.join, this.leaving ? 0 : 1, 0.5, dt);
      d.u += dt / d.period;
      if (d.u >= 1) {
        d.u -= 1;
        // A breach is rare enough to be a moment rather than a habit.
        d.breach = this.rng() < 0.07 ? 1 : 0;
      }
      d.weave += dt * 0.55;

      // Station, widening back out to abeam as the pod joins or leaves.
      const spread = 1 + (1 - d.join) * 5.5;
      const lx = d.sx * spread + Math.sin(d.weave) * 1.35;
      const lz = d.sz + (1 - d.join) * 34 + Math.cos(d.weave * 0.7) * 1.6;

      this.v.set(lx, 0, lz).applyQuaternion(this.q);
      const wx = ship.position.x + this.v.x;
      const wz = ship.position.z + this.v.z;
      d.waterY = ocean ? ocean.sampleHeight(wx, wz) : 0;

      // The arc: submerged most of the cycle, back clear at the top.
      const a = d.u * Math.PI * 2;
      const s = Math.sin(a);
      const lift = s > 0 ? Math.pow(s, 1.75) : 0;
      const height = d.breach > 0 ? 3.4 : 1.5;
      const yTarget = d.waterY - 0.9 + lift * height;
      d.y = yTarget;
      // Pitch is the slope of that arc; nose up on the way out, down on entry.
      const slope = Math.cos(a) * (s > 0 ? 1 : 0.22) * (d.breach > 0 ? 1.35 : 0.75);
      d.pitch = damp(d.pitch, THREE.MathUtils.clamp(slope, -1.1, 1.1), 9, dt);
      d.roll = damp(d.roll, Math.sin(d.weave) * 0.28 + (d.breach > 0 ? Math.sin(a) * 0.3 : 0), 6, dt);

      // Tail beat: hard while submerged and driving, eased while airborne.
      d.beat += dt * (7.2 - lift * 3.4);
      if (d.beat > Math.PI * 2) d.beat -= Math.PI * 2;

      const yaw = heading + Math.sin(d.weave) * 0.10;
      pool.push(
        wx, d.y, wz, yaw,
        d.pitch, d.roll, d.scale, d.beat,
        0, 0.13 * (1 - lift * 0.55), 0, d.tint,
        d.waterY, 1,
      );
    }
    pool.end();

    world.stats['world.dolphins'] = live;
  }

  dispose(): void {
    this.pool?.dispose();
    this.pool = null;
  }
}
