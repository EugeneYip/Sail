import * as THREE from 'three';
import type { World } from '../types';
import { damp, makeRng } from '../util/math';
import { buildWhale } from './creatureGeom';
import { CreaturePool, SpoutPool } from './wpool';

const MAX_WHALES = 3;
const MAX_PUFFS = 18;

/**
 * Rare on purpose. A whale every thirty seconds is scenery; a whale every
 * quarter of an hour is an event, and the owner asked for an event.
 */
const MEAN_GAP_S = 900;
const MEAN_VISIT_S = 145;

const AT_SURFACE = 0;
const SOUNDING = 1;
const DOWN = 2;
const RISING = 3;

interface Whale {
  active: boolean;
  x: number;
  z: number;
  heading: number;
  speed: number;
  scale: number;
  tint: number;
  state: number;
  stateTimer: number;
  blowsLeft: number;
  blowTimer: number;
  depth: number;
  pitch: number;
  roll: number;
  beat: number;
  waterY: number;
}

interface Puff {
  life: number;
  ttl: number;
  x: number;
  y: number;
  z: number;
  size: number;
  seed: number;
  lean: number;
}

/**
 * Whales. Two or three animals holding their own course, blowing at the surface
 * for a minute or two and then sounding — flukes up, gone.
 *
 * Positions are render-space and are rebased on `origin:shift`, unlike the
 * islands, which keep absolute coordinates. A whale lives for two minutes and
 * has no identity worth preserving across a 4 km rebase, so three additions per
 * shift is cheaper than an absolute-to-render conversion every frame.
 *
 * The distant encounter is deliberately placed at 1.2-3.2 km rather than at the
 * true horizon: a 7 m spout subtends less than a pixel at 6 km, so a whale out
 * there is not "far away", it is "absent".
 */
export class Whales {
  private pool: CreaturePool | null = null;
  private spouts: SpoutPool | null = null;
  private whales: Whale[] = [];
  private puffs: Puff[] = [];
  private rng = makeRng(0x77a3);
  private nextEvent = 0;
  private present = false;
  private offShift: (() => void) | null = null;

  init(world: World): void {
    this.pool = new CreaturePool(world, buildWhale(), MAX_WHALES, 'world-whale', 2.0, 0);
    this.spouts = new SpoutPool(world, MAX_PUFFS);
    for (let i = 0; i < MAX_WHALES; i++) {
      this.whales.push({
        active: false, x: 0, z: 0, heading: 0, speed: 2.4, scale: 1, tint: 1,
        state: AT_SURFACE, stateTimer: 0, blowsLeft: 0, blowTimer: 0,
        depth: 0, pitch: 0, roll: 0, beat: 0, waterY: 0,
      });
    }
    for (let i = 0; i < MAX_PUFFS; i++) {
      this.puffs.push({ life: 0, ttl: 1, x: 0, y: 0, z: 0, size: 1, seed: 0, lean: 0 });
    }
    this.nextEvent = this.draw(MEAN_GAP_S * 0.55);
    this.offShift = world.bus.on('origin:shift', (p) => {
      const d = p as THREE.Vector3 | undefined;
      if (!d) return;
      for (const w of this.whales) {
        w.x += d.x;
        w.z += d.z;
      }
      for (const q of this.puffs) {
        q.x += d.x;
        q.z += d.z;
      }
    });
  }

  private draw(mean: number): number {
    return -mean * Math.log(1 - this.rng() * 0.999);
  }

  showcase(world: World, close: boolean): void {
    this.arrive(world, close ? 260 : 1450);
    this.nextEvent = MEAN_VISIT_S * 6;
    for (const w of this.whales) {
      if (!w.active) continue;
      w.state = AT_SURFACE;
      w.blowTimer = 0.4 + this.rng() * 1.6;
      w.blowsLeft = 9;
    }
  }

  private arrive(world: World, forcedRange: number): void {
    const r = this.rng;
    this.present = true;
    const n = 1 + (r() < 0.42 ? 1 : 0) + (r() < 0.12 ? 1 : 0);
    // Sixty per cent of encounters are a spout on the horizon; the rest are
    // close aboard, which is what makes the horizon ones worth watching for.
    const range = forcedRange > 0 ? forcedRange : r() < 0.6 ? 1200 + r() * 2000 : 160 + r() * 420;
    const bearing = world.ship.heading + (r() - 0.5) * 1.5;
    const bx = world.ship.position.x + Math.sin(bearing) * range;
    const bz = world.ship.position.z - Math.cos(bearing) * range;
    const course = r() * Math.PI * 2;
    for (let i = 0; i < n; i++) {
      const w = this.whales[i];
      w.active = true;
      w.x = bx + (r() - 0.5) * 90;
      w.z = bz + (r() - 0.5) * 90;
      w.heading = course + (r() - 0.5) * 0.3;
      w.speed = 1.9 + r() * 1.5;
      w.scale = 0.82 + r() * 0.34;
      w.tint = 0.92 + r() * 0.16;
      w.state = AT_SURFACE;
      w.stateTimer = 20 + r() * 45;
      w.blowsLeft = 3 + Math.floor(r() * 4);
      w.blowTimer = r() * 6;
      w.depth = 0;
      w.pitch = 0;
      w.beat = r() * Math.PI * 2;
    }
    for (let i = n; i < MAX_WHALES; i++) this.whales[i].active = false;
  }

  private blow(world: World, w: Whale): void {
    const r = this.rng;
    // Blowhole: a little aft of the snout, on the crown of the head.
    const fx = Math.sin(w.heading);
    const fz = -Math.cos(w.heading);
    const bx = w.x + fx * 4.3 * w.scale;
    const bz = w.z + fz * 4.3 * w.scale;
    const by = w.waterY + 0.55 * w.scale;
    const wind = world.env.windVector;
    for (const q of this.puffs) {
      if (q.life > 0) continue;
      q.life = 1e-4;
      q.ttl = 3.4 + r() * 1.8;
      q.x = bx;
      q.y = by;
      q.z = bz;
      q.size = (4.2 + r() * 2.4) * w.scale;
      q.seed = r() * 40;
      q.lean = (wind.x * fx + wind.z * fz) * 0.3 + (r() - 0.5) * 0.4;
      world.bus.emit('world:whaleBlow', { x: bx, y: by, z: bz });
      return;
    }
  }

  update(world: World, dt: number): void {
    const pool = this.pool;
    const spouts = this.spouts;
    if (!pool || !spouts) return;

    this.nextEvent -= dt;
    if (this.nextEvent <= 0) {
      if (this.present) {
        this.present = false;
        for (const w of this.whales) {
          // Never vanish in plain sight: retire only once the animal is down.
          if (w.state === DOWN || w.state === SOUNDING) w.active = false;
          else w.blowsLeft = 0;
        }
        this.nextEvent = this.draw(MEAN_GAP_S);
      } else {
        this.arrive(world, 0);
        this.nextEvent = this.draw(MEAN_VISIT_S);
        world.bus.emit('world:whale', null);
      }
    }

    const ocean = world.ocean;
    const shipX = world.ship.position.x;
    const shipZ = world.ship.position.z;
    let live = 0;

    pool.begin();
    for (const w of this.whales) {
      if (!w.active) continue;

      const fx = Math.sin(w.heading);
      const fz = -Math.cos(w.heading);
      w.x += fx * w.speed * dt;
      w.z += fz * w.speed * dt;
      w.waterY = ocean ? ocean.sampleHeight(w.x, w.z) : 0;
      w.beat += dt * (1.05 + (w.state === SOUNDING ? 0.7 : 0));
      if (w.beat > Math.PI * 2) w.beat -= Math.PI * 2;

      w.stateTimer -= dt;
      switch (w.state) {
        case AT_SURFACE:
          w.blowTimer -= dt;
          if (w.blowTimer <= 0 && w.blowsLeft > 0) {
            this.blow(world, w);
            w.blowsLeft--;
            w.blowTimer = 13 + this.rng() * 9;
          }
          if (w.blowsLeft <= 0 && w.blowTimer < 9) {
            w.state = SOUNDING;
            w.stateTimer = 7.5;
          }
          w.depth = damp(w.depth, 0, 1.2, dt);
          w.pitch = damp(w.pitch, 0, 1.2, dt);
          break;
        case SOUNDING:
          // Pitching nose-down lifts the flukes clear all by itself, which is
          // the whole picture of a sounding whale.
          w.pitch = damp(w.pitch, -0.95, 0.55, dt);
          w.depth = damp(w.depth, 13 * w.scale, 0.42, dt);
          if (w.stateTimer <= 0) {
            w.state = DOWN;
            w.stateTimer = 55 + this.rng() * 95;
            if (!this.present) w.active = false;
          }
          break;
        case DOWN:
          w.depth = damp(w.depth, 22 * w.scale, 0.4, dt);
          w.pitch = damp(w.pitch, 0, 0.5, dt);
          if (w.stateTimer <= 0) {
            w.state = RISING;
            w.stateTimer = 12;
            w.heading += (this.rng() - 0.5) * 1.1;
          }
          break;
        default:
          w.pitch = damp(w.pitch, 0.28, 0.6, dt);
          w.depth = damp(w.depth, 0, 0.36, dt);
          if (w.stateTimer <= 0) {
            w.state = AT_SURFACE;
            w.stateTimer = 20 + this.rng() * 45;
            w.blowsLeft = 3 + Math.floor(this.rng() * 4);
            w.blowTimer = 0.6;
          }
          break;
      }
      w.roll = damp(w.roll, Math.sin(w.beat * 0.6) * 0.12, 1.5, dt);

      if (!w.active) continue;
      // Retire once it is over the horizon rather than in front of the player.
      if (Math.hypot(w.x - shipX, w.z - shipZ) > 5200) {
        w.active = false;
        continue;
      }
      live++;

      // The back sits just proud of the water when up; `depth` takes it under.
      const y = w.waterY + 1.05 * w.scale - w.depth;
      pool.push(
        w.x, y, w.z, w.heading,
        w.pitch, w.roll, w.scale * 1.0, w.beat,
        0, 0.42 * w.scale, 0, w.tint,
        w.waterY, 1,
      );
    }
    pool.end();

    spouts.begin(world);
    for (const q of this.puffs) {
      if (q.life <= 0) continue;
      q.life += dt;
      if (q.life >= q.ttl) {
        q.life = 0;
        continue;
      }
      const age = q.life / q.ttl;
      // Rises fast, then hangs and drifts. The lean grows with age.
      const rise = Math.min(1, age * 3.2);
      spouts.push(
        q.x, q.y + rise * 0.6, q.z,
        q.size * (0.55 + age * 0.9),
        age,
        q.lean * age * 1.6,
        q.seed,
        1,
      );
    }
    spouts.end();

    world.stats['world.whales'] = live;
  }

  dispose(): void {
    this.offShift?.();
    this.offShift = null;
    this.pool?.dispose();
    this.spouts?.dispose();
    this.pool = null;
    this.spouts = null;
  }
}
