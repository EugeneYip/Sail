import * as THREE from 'three';
import type { World } from '../types';
import { clamp01, damp, makeRng, wrapPi } from '../util/math';
import { buildGull } from './creatureGeom';
import { CreaturePool } from './wpool';
import type { WorldExt } from './api';

const MAX_BIRDS = 52;

/** How long the flock stays, and how long the sea is empty between flocks. */
const MEAN_VISIT_S = 265;
const MEAN_GAP_S = 205;
/** Gulls come from the land, so a landfall makes a flock much more likely. */
const LAND_RATE_BOOST = 3.2;
const LAND_BOOST_RANGE_M = 7000;

const MODE_WHEEL = 0;
const MODE_SKIM = 1;
const MODE_SIT = 2;

interface Bird {
  active: boolean;
  leaving: boolean;
  mode: number;
  modeTimer: number;
  /** Offset from the flock centre, render space. */
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  theta: number;
  omega: number;
  radius: number;
  height: number;
  bob: number;
  flapPhase: number;
  flapAmp: number;
  yaw: number;
  pitch: number;
  roll: number;
  scale: number;
  tint: number;
  waterY: number;
}

/**
 * Seabirds. A flock of gulls that wheels over the wake, skims the wave tops and
 * occasionally settles on the sea, then leaves.
 *
 * The birds are held as offsets from a flock centre that trails the ship, so a
 * floating-origin rebase moves the whole flock with the ship for free: the
 * offsets never change and there is nothing to fix up on `origin:shift`.
 *
 * Motion is a steered orbit rather than boids. Fifty gulls of mutual repulsion
 * costs 2500 distance tests a frame to produce something a per-bird radius,
 * angular rate and height offset already produce, and the parametric version
 * cannot ever collapse into a knot.
 */
export class Birds {
  private pool: CreaturePool | null = null;
  private birds: Bird[] = [];
  private rng = makeRng(0x9e11);
  private present = false;
  private nextEvent = 0;
  private want = 0;
  private wantTimer = 0;
  private centre = new THREE.Vector3();
  private budget = MAX_BIRDS;

  init(world: World): void {
    this.pool = new CreaturePool(world, buildGull(), MAX_BIRDS, 'world-gull', 0, 0.35);
    for (let i = 0; i < MAX_BIRDS; i++) {
      this.birds.push({
        active: false, leaving: false, mode: MODE_WHEEL, modeTimer: 0,
        x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
        theta: 0, omega: 0.2, radius: 40, height: 0, bob: 0,
        flapPhase: 0, flapAmp: 0.4, yaw: 0, pitch: 0, roll: 0,
        scale: 1, tint: 1, waterY: -50,
      });
    }
    this.applySettings(world);
    // Start with a flock already aboard: a first frame with gulls over the wake
    // is a better first impression than an empty sky, and it makes the default
    // capture deterministic enough to review.
    this.arrive(world, 11);
    this.nextEvent = this.draw(MEAN_VISIT_S);
  }

  applySettings(world: World): void {
    const d = world.settings.propDensity || 1;
    this.budget = Math.max(6, Math.min(MAX_BIRDS, Math.round(MAX_BIRDS * Math.min(1.2, d))));
    if (this.want > this.budget) this.want = this.budget;
  }

  /** Exponential inter-arrival: memoryless, so an appearance never feels timed. */
  private draw(mean: number): number {
    return -mean * Math.log(1 - this.rng() * 0.999);
  }

  private arrive(world: World, count: number): void {
    this.present = true;
    this.want = Math.min(this.budget, count);
    void world;
  }

  showcase(world: World): void {
    this.arrive(world, Math.min(this.budget, 22));
    this.nextEvent = MEAN_VISIT_S * 2;
    // Put them in the air immediately rather than converging from 600 m out.
    for (let i = 0; i < this.want; i++) {
      const b = this.birds[i];
      if (!b.active) this.spawn(b, false);
    }
  }

  private spawn(b: Bird, fromAfar: boolean): void {
    const r = this.rng;
    b.active = true;
    b.leaving = false;
    b.mode = MODE_WHEEL;
    b.modeTimer = 4 + r() * 12;
    b.theta = r() * Math.PI * 2;
    b.radius = 26 + r() * 96;
    b.omega = (0.10 + r() * 0.16) * (r() < 0.5 ? -1 : 1) * (52 / b.radius);
    b.height = -16 + r() * 34;
    b.bob = r() * Math.PI * 2;
    b.flapPhase = r() * Math.PI * 2;
    b.flapAmp = 0.45;
    b.scale = 0.86 + r() * 0.34;
    b.tint = 0.88 + r() * 0.26;
    const start = fromAfar ? 320 + r() * 340 : b.radius;
    const a = fromAfar ? r() * Math.PI * 2 : b.theta;
    b.x = Math.cos(a) * start;
    b.z = Math.sin(a) * start;
    b.y = b.height + (fromAfar ? 30 + r() * 60 : 0);
    b.vx = 0;
    b.vy = 0;
    b.vz = 0;
  }

  update(world: World, dt: number): void {
    const pool = this.pool;
    if (!pool) return;

    const ship = world.ship;
    const h = ship.heading;
    const fx = Math.sin(h);
    const fz = -Math.cos(h);
    // The wheel is centred just abaft the ship, not out over the wake. Astern is
    // where the chase camera sits, and a flock centred there puts every bird
    // behind the lens: measured, 22 gulls aloft and exactly one in frame.
    this.centre.set(
      ship.position.x - fx * 8,
      ship.position.y + 27,
      ship.position.z - fz * 8,
    );

    this.tickLifecycle(world, dt);

    const ocean = world.ocean;
    const wind = world.env.windVector;
    const gust = world.env.gust;
    let live = 0;

    pool.begin();
    for (let i = 0; i < this.birds.length; i++) {
      const b = this.birds[i];
      if (!b.active) continue;
      live++;

      b.modeTimer -= dt;
      if (b.modeTimer <= 0) this.pickMode(b, world);

      // --- where this bird wants to be, relative to the flock centre
      b.theta += b.omega * dt;
      let tx: number, ty: number, tz: number;
      if (b.mode === MODE_SIT) {
        tx = b.x;
        tz = b.z;
        ty = b.waterY - this.centre.y + 0.16;
      } else {
        tx = Math.cos(b.theta) * b.radius;
        tz = Math.sin(b.theta) * b.radius;
        const bobH = Math.sin(world.time.elapsed * 0.5 + b.bob) * 4.5;
        if (b.mode === MODE_SKIM) {
          ty = b.waterY - this.centre.y + 1.5 + Math.sin(world.time.elapsed * 1.7 + b.bob) * 1.1;
        } else {
          ty = b.height + bobH;
        }
        if (b.leaving) {
          // Peel off downwind and climb out of frame.
          tx += wind.x * 520;
          tz += wind.z * 520;
          ty += 130;
        }
      }

      // --- steer. A gull cannot turn instantly, and the lag is what makes the
      // flock look like birds rather than points on a circle.
      const agility = b.mode === MODE_SIT ? 2.6 : 1.35;
      const dx = tx - b.x;
      const dy = ty - b.y;
      const dz = tz - b.z;
      const wantSpeed = b.mode === MODE_SIT ? 1.2 : 12 + gust * 3.5;
      const dl = Math.hypot(dx, dy, dz) || 1;
      const gain = Math.min(1, dl / 26);
      b.vx = damp(b.vx, (dx / dl) * wantSpeed * gain, agility, dt);
      b.vy = damp(b.vy, (dy / dl) * wantSpeed * gain * 0.7, agility * 1.4, dt);
      b.vz = damp(b.vz, (dz / dl) * wantSpeed * gain, agility, dt);
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.z += b.vz * dt;

      const wx = this.centre.x + b.x;
      const wz = this.centre.z + b.z;
      const wy = this.centre.y + b.y;
      b.waterY = ocean ? ocean.sampleHeight(wx, wz) : 0;

      // --- attitude from the velocity: heading, bank into the turn, pitch on climb
      const spd = Math.hypot(b.vx, b.vz);
      if (spd > 0.35) {
        const yaw = Math.atan2(b.vx, -b.vz);
        const turn = wrapPi(yaw - b.yaw);
        b.yaw += turn * Math.min(1, dt * 6);
        b.roll = damp(b.roll, THREE.MathUtils.clamp(turn / Math.max(dt, 1e-3) * 0.26, -1.05, 1.05), 4, dt);
        b.pitch = damp(b.pitch, THREE.MathUtils.clamp(Math.atan2(b.vy, spd) * 0.55, -0.5, 0.5), 3, dt);
      } else {
        b.roll = damp(b.roll, 0, 3, dt);
        b.pitch = damp(b.pitch, 0, 3, dt);
      }

      // --- flap. Birds beat when they climb and glide when they fall; that
      // intermittency is most of what reads as a bird at 200 m.
      let amp: number;
      if (b.mode === MODE_SIT) amp = 0.02;
      else amp = clamp01(0.16 + b.vy * 0.16 + (1 - Math.min(1, spd / 15)) * 0.42) * 1.05;
      b.flapAmp = damp(b.flapAmp, amp, 3.5, dt);
      b.flapPhase += (4.4 + b.flapAmp * 6.2) * dt;
      if (b.flapPhase > Math.PI * 2) b.flapPhase -= Math.PI * 2;

      // --- retire once it is far enough away that vanishing cannot be seen
      if (b.leaving && Math.hypot(b.x, b.z) > 640) {
        b.active = false;
        continue;
      }

      const sitting = b.mode === MODE_SIT ? 1 : 0;
      pool.push(
        wx, sitting ? b.waterY + 0.14 : wy, wz, b.yaw,
        b.pitch, b.roll, b.scale, b.flapPhase,
        b.flapAmp, 0, 0, b.tint,
        b.waterY, sitting * 0.55,
      );
    }
    pool.end();

    world.stats['world.birds'] = live;
  }

  private pickMode(b: Bird, world: World): void {
    const r = this.rng;
    const u = r();
    const calm = world.env.waveHeight < 2.4;
    if (u < 0.60) {
      b.mode = MODE_WHEEL;
      b.modeTimer = 8 + r() * 20;
      b.radius = 26 + r() * 96;
      b.omega = (0.10 + r() * 0.16) * (r() < 0.5 ? -1 : 1) * (52 / b.radius);
      b.height = -16 + r() * 34;
    } else if (u < 0.88 || !calm) {
      b.mode = MODE_SKIM;
      b.modeTimer = 4 + r() * 7;
      b.radius = 34 + r() * 78;
    } else {
      b.mode = MODE_SIT;
      b.modeTimer = 9 + r() * 18;
    }
  }

  private tickLifecycle(world: World, dt: number): void {
    this.nextEvent -= dt;
    if (this.nextEvent <= 0) {
      if (this.present) {
        this.present = false;
        this.want = 0;
        this.nextEvent = this.draw(MEAN_GAP_S);
      } else {
        const w = world.ext.world as WorldExt | undefined;
        const land = w?.nearestLand(world.ship.position.x, world.ship.position.z, LAND_BOOST_RANGE_M);
        // Near a landfall a flock is both more likely and bigger.
        const boost = land ? LAND_RATE_BOOST : 1;
        this.present = true;
        this.want = Math.min(this.budget, 5 + Math.floor(this.rng() * 19 * Math.min(1.5, boost)));
        this.nextEvent = this.draw(MEAN_VISIT_S);
      }
    }

    this.wantTimer -= dt;
    if (this.wantTimer > 0) return;
    this.wantTimer = 0.9 + this.rng() * 2.4;

    let n = 0;
    for (const b of this.birds) if (b.active && !b.leaving) n++;
    if (n < this.want) {
      for (const b of this.birds) {
        if (!b.active) {
          this.spawn(b, true);
          break;
        }
      }
    } else if (n > this.want) {
      for (const b of this.birds) {
        if (b.active && !b.leaving) {
          b.leaving = true;
          b.mode = MODE_WHEEL;
          b.modeTimer = 60;
          break;
        }
      }
    }
  }

  dispose(): void {
    this.pool?.dispose();
    this.pool = null;
  }
}
