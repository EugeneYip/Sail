import * as THREE from 'three';
import { clamp01, smoothstep } from '../util/math';
import { HULL, type VfxCtx } from './Context';
import type { Particles } from './Particles';
import { KIND } from './shaders/particles';
import type { WakeField } from './WakeField';
import type { WaterProbe } from './WaterProbe';

/**
 * Everything the sea throws into the air.
 *
 * Emission rates are all "particles per second", accumulated into fractional
 * counters so a rate below one per frame still produces the right average. All
 * scratch vectors are module fields — `update` allocates nothing.
 *
 * The physical story, which is what the numbers encode:
 *   - a fine bow entry at speed peels a thin sheet off each bow, which the
 *     apparent wind immediately tears into droplets and carries aft;
 *   - when the bow falls off a crest and slams, that sheet becomes a solid
 *     curtain of water thrown forward and up, then blown back over the deck;
 *   - above about force 6 the wind starts stripping the crests themselves and
 *     the whole surface begins to smoke to leeward;
 *   - in a real gale the troughs fill with a metre or two of hanging mist.
 */

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _local = new THREE.Vector3();
const _cell = new THREE.Vector4();

/** Wind speed, m/s, at which crests start to be blown off. Force 6-ish. */
const SPINDRIFT_ONSET = 11.5;
/** Wind speed at which the whole surface is smoking. Force 9. */
const SPINDRIFT_FULL = 23;

/**
 * Emission integrates a rate against dt, so a slow frame asks for proportionally
 * more particles — which makes the frame slower still. Clamp the integration
 * step: at 30 fps and below we deliberately under-emit rather than spiral.
 */
const MAX_EMIT_DT = 1 / 30;

export class Spray {
  private accBow = 0;
  private accSheet = 0;
  private accStern = 0;
  private accFleck = 0;
  private accDrift = 0;
  private accMist = 0;
  private slamArmed = true;
  private lastSlamT = -10;
  private driftCell = 0;

  update(ctx: VfxCtx, p: Particles, probe: WaterProbe, wake: WakeField): void {
    if (!p.available) return;
    const dt = Math.min(ctx.dt, MAX_EMIT_DT);
    const d = ctx.density;

    this.bowSpray(ctx, p, probe, dt, d);
    this.slam(ctx, p, probe, wake, d);
    this.sternWash(ctx, p, probe, dt, d);
    this.wakeFlecks(ctx, p, dt, d);
    this.spindrift(ctx, p, probe, dt, d);
    this.troughMist(ctx, p, probe, dt, d);
  }

  /* ----------------------------------------------------------------- *
   *  Bow
   * ----------------------------------------------------------------- */

  /** Ship-local point on the waterline at parameter `t`, side ±1, into `out`. */
  private hullPoint(ctx: VfxCtx, t: number, side: number, out: THREE.Vector3): THREE.Vector3 {
    const hb = ctx.halfBeam(t);
    _local.set(side * hb, 0, t * HULL.lwl - HULL.lwl * 0.5);
    return ctx.toWorld(_local, out);
  }

  private bowSpray(ctx: VfxCtx, p: Particles, probe: WaterProbe, dt: number, d: number): void {
    const sN = ctx.speedN;
    if (sN < 0.16) return;

    const chop = ctx.world.env.choppiness;
    const seaway = clamp01(ctx.world.env.waveHeight / 4.5);
    // Wave-making rises steeply with Froude number; a short steep sea and a
    // falling bow both multiply it.
    const drive = Math.pow(sN, 2.2) * (0.55 + 1.5 * seaway + 0.5 * chop);
    // RATES. Measured against the `waterline` capture: at 2600 + 380 per second
    // the pool held ~4000 sprites in a 40 m envelope around the bow and rendered
    // as one opaque white mass that hid the entire forward half of the hull. A
    // frigate at 11 kn in a rough sea throws a visible FAN of spray off each bow,
    // through which you can still see the topsides. Sheets are the expensive ones
    // visually — they grow to ~2 m and are shaded as a scattering slab — so they
    // are the deepest cut.
    const rate = 850 * drive * d;
    const sheetRate = 85 * drive * d;

    this.accBow += rate * dt;
    this.accSheet += sheetRate * dt;
    let nDrops = Math.floor(this.accBow);
    let nSheet = Math.floor(this.accSheet);
    this.accBow -= nDrops;
    this.accSheet -= nSheet;
    // The bow is the most important emitter, so it gets first call on the
    // frame's budget, but it still must not overrun it.
    const room = p.room;
    if (nDrops + nSheet > room) {
      nSheet = Math.min(nSheet, Math.max(1, room >> 3));
      nDrops = Math.max(0, room - nSheet);
    }
    if (nDrops === 0 && nSheet === 0) return;

    const stag = (ctx.speed * ctx.speed) / 19.62;
    const heel = ctx.heel;

    for (let i = 0; i < nDrops + nSheet; i++) {
      const sheet = i >= nDrops;
      // The lee bow is buried and throws far more water than the weather bow.
      const bias = 0.5 + THREE.MathUtils.clamp(heel * 2.6, -0.34, 0.34);
      const side = Math.random() < bias ? 1 : -1;
      const lee = Math.sign(heel) === side ? 1 : 0;
      const gain = 1 + lee * Math.min(Math.abs(heel) * 4.0, 1.0);

      // Along the forward third of the waterline, bunched at the shoulder.
      const t = 0.012 + Math.pow(Math.random(), 1.7) * 0.30;
      this.hullPoint(ctx, t, side, _a);
      _a.y = probe.heightAt(_a.x, _a.z) + (0.25 + Math.random() * 1.4) * gain;

      // Outboard from the hull, up on the stagnation rise, and carried aft in
      // the ship's own frame by the apparent wind.
      const out = 1.2 + Math.random() * 2.6 + sN * 2.4;
      const up = (1.4 + Math.random() * 2.2 + stag * 0.42) * gain;
      _b.copy(ctx.right).multiplyScalar(side * out * gain);
      _b.y += up;
      _b.addScaledVector(ctx.fwd, 1.0 + Math.random() * 3.0 + ctx.speed * 0.22);
      // Sheets keep more of the hull's own momentum; droplets are torn free.
      _b.addScaledVector(ctx.world.ship.velocity, sheet ? 0.42 : 0.2);

      if (sheet) {
        p.spawn(
          _a.x, _a.y, _a.z, _b.x, _b.y, _b.z,
          0.6 + Math.random() * 0.7,
          0.45 + Math.random() * 0.75,
          KIND.SHEET, 0.9 + Math.random(),
        );
      } else {
        const fine = Math.random();
        p.spawn(
          _a.x, _a.y, _a.z, _b.x, _b.y, _b.z,
          0.85 + Math.random() * 1.4,
          0.045 + fine * fine * 0.30,
          KIND.DROPLET, 0.45 + fine * 2.6,
        );
      }
    }
  }

  /**
   * Bow slam. `ship.bowSlam` is vertical acceleration at the stem; when the
   * forefoot re-enters after a fall it spikes, and that is what throws a real
   * curtain of water. One burst per event, not one per frame.
   */
  private slam(ctx: VfxCtx, p: Particles, probe: WaterProbe, wake: WakeField, d: number): void {
    const g = 9.81;
    const mag = ctx.slam;
    const now = ctx.world.time.elapsed;
    if (mag < g * 0.55) {
      this.slamArmed = true;
      return;
    }
    if (!this.slamArmed || now - this.lastSlamT < 0.35) return;
    this.slamArmed = false;
    this.lastSlamT = now;

    const power = clamp01((mag - g * 0.55) / (g * 2.2));
    const sN = Math.max(ctx.speedN, 0.12);
    const n = Math.min(Math.floor((55 + 230 * power) * (0.4 + sN) * d), p.room);
    const stag = (ctx.speed * ctx.speed) / 19.62;

    ctx.toWorld(_local.set(0, 0, -HULL.lwl * 0.5 + 1.5), _c);
    const wy = probe.heightAt(_c.x, _c.z);

    for (let i = 0; i < n; i++) {
      const side = Math.random() < 0.5 ? -1 : 1;
      const t = 0.006 + Math.pow(Math.random(), 2.0) * 0.22;
      this.hullPoint(ctx, t, side, _a);
      _a.y = probe.heightAt(_a.x, _a.z) + Math.random() * 0.8;

      const out = 2.5 + Math.random() * 7.5 * power;
      const up = 4.5 + Math.random() * (9 + stag * 1.1) * (0.5 + power);
      _b.copy(ctx.right).multiplyScalar(side * out);
      _b.y += up;
      _b.addScaledVector(ctx.fwd, 2.0 + Math.random() * 7.0);
      _b.addScaledVector(ctx.world.ship.velocity, 0.45);

      const sheet = Math.random() < 0.24;
      p.spawn(
        _a.x, _a.y, _a.z, _b.x, _b.y, _b.z,
        sheet ? 0.8 + Math.random() * 0.8 : 1.3 + Math.random() * 1.8,
        sheet ? 0.7 + Math.random() * 1.1 : 0.06 + Math.random() * 0.34,
        sheet ? KIND.SHEET : KIND.DROPLET,
        sheet ? 0.8 : 0.5 + Math.random() * 2.4,
      );
    }

    // The impact itself: a ring in the fine field and a foam patch that stays.
    wake.addRipple(_c.x, _c.z, 0.9 * power, 26, 7.5, 1);
    wake.addFoam(_c.x, _c.z, 7 + 9 * power, 0.55 * power, 0.75);
    void wy;
  }

  /* ----------------------------------------------------------------- *
   *  Stern and wake
   * ----------------------------------------------------------------- */

  private sternWash(ctx: VfxCtx, p: Particles, probe: WaterProbe, dt: number, d: number): void {
    const sN = ctx.speedN;
    if (sN < 0.22) return;
    const rudder = Math.abs(ctx.rudder);
    const drive = Math.pow(sN, 2.4) * (1 + rudder * 1.6);
    this.accStern += 240 * drive * d * dt;
    let n = Math.floor(this.accStern);
    this.accStern -= n;
    n = Math.min(n, p.room);

    for (let i = 0; i < n; i++) {
      const across = (Math.random() * 2 - 1) * ctx.world.ship.beam * 0.42 - ctx.rudder * 3.0;
      _local.set(across, 0, HULL.lwl * 0.5 + Math.random() * 5.5);
      ctx.toWorld(_local, _a);
      _a.y = probe.heightAt(_a.x, _a.z) + Math.random() * 0.7;

      _b.copy(ctx.fwd).multiplyScalar(-(1.5 + Math.random() * 3.5));
      _b.y += 1.2 + Math.random() * 3.6 * sN;
      _b.addScaledVector(ctx.right, (Math.random() * 2 - 1) * 1.8 - ctx.rudder * 2.5);
      _b.addScaledVector(ctx.world.ship.velocity, 0.55);

      p.spawn(
        _a.x, _a.y, _a.z, _b.x, _b.y, _b.z,
        0.8 + Math.random() * 1.2,
        0.07 + Math.random() * 0.32,
        Math.random() < 0.18 ? KIND.SHEET : KIND.DROPLET,
        0.6 + Math.random() * 2.0,
      );
    }
  }

  /** Aerated foam riding the surface in the turbulent core astern. */
  private wakeFlecks(ctx: VfxCtx, p: Particles, dt: number, d: number): void {
    const sN = ctx.speedN;
    if (sN < 0.14) return;
    this.accFleck += 340 * Math.pow(sN, 1.6) * d * dt;
    let n = Math.floor(this.accFleck);
    this.accFleck -= n;
    n = Math.min(n, p.room);

    const beam = ctx.world.ship.beam;
    for (let i = 0; i < n; i++) {
      const xi = Math.pow(Math.random(), 1.6) * 130;
      const spread = beam * 0.45 + xi * 0.10;
      const across = (Math.random() * 2 - 1) * spread;
      _local.set(across, 0, HULL.lwl * 0.5 + xi);
      ctx.toWorld(_local, _a);
      // Flecks are pinned to the surface by the sim; only XZ drift matters.
      _b.copy(ctx.windVel).multiplyScalar(0.10);
      _b.addScaledVector(ctx.fwd, -0.4 - Math.random() * 0.8);
      _b.y = 0;
      p.spawn(
        _a.x, _a.y, _a.z, _b.x, 0, _b.z,
        2.5 + Math.random() * 4.0,
        0.28 + Math.random() * 0.85,
        KIND.FLECK, 0.05,
      );
    }
  }

  /* ----------------------------------------------------------------- *
   *  Weather-driven
   * ----------------------------------------------------------------- */

  /**
   * Spindrift: wind shearing the tops off breaking crests. Found by walking the
   * water probe's crest channel, so it lands on real wave tops rather than on a
   * guessed grid.
   */
  private spindrift(ctx: VfxCtx, p: Particles, probe: WaterProbe, dt: number, d: number): void {
    const w = ctx.windSpeed;
    if (w < SPINDRIFT_ONSET) return;
    const f = smoothstep(SPINDRIFT_ONSET, SPINDRIFT_FULL, w);
    this.accDrift += 950 * f * f * d * dt;
    let n = Math.floor(this.accDrift);
    this.accDrift -= n;
    if (n === 0) return;
    n = Math.min(n, 180, p.room);

    const res = probe.res;
    const cells = res * res;
    const wind = ctx.windDir;
    let tries = 0;
    let made = 0;
    while (made < n && tries < n * 4) {
      tries++;
      // Halton-ish stride so successive frames sweep the whole window.
      this.driftCell = (this.driftCell + 9973) % cells;
      const i = this.driftCell % res;
      const j = (this.driftCell - i) / res;
      if (!probe.sampleCell(i, j, _cell)) continue;
      const crest = _cell.w;
      if (Math.random() > crest * 1.4) continue;
      made++;

      const jx = (Math.random() - 0.5) * probe.worldSize / res;
      const jz = (Math.random() - 0.5) * probe.worldSize / res;
      const px = _cell.x + jx;
      const pz = _cell.z + jz;
      const py = _cell.y + 0.15 + Math.random() * 0.5;

      // Torn off the crest: launched downwind and up over the back of the wave.
      const speed = w * (0.35 + Math.random() * 0.5);
      _b.copy(wind).multiplyScalar(speed);
      _b.y += 1.0 + Math.random() * 3.4 * f;
      _b.x += (Math.random() - 0.5) * 2.2;
      _b.z += (Math.random() - 0.5) * 2.2;

      // Spindrift is overwhelmingly *streaks* — long thin ribbons of torn foam
      // running downwind off the crest. Only a small fraction atomises into a
      // cloud, and it stays small: fat mist puffs read as weather, not as sea.
      const streak = Math.random() < 0.92;
      p.spawn(
        px, py, pz, _b.x, _b.y, _b.z,
        streak ? 0.7 + Math.random() * 1.1 : 1.0 + Math.random() * 1.2,
        streak ? 0.07 + Math.random() * 0.20 : 0.35 + Math.random() * 0.7,
        streak ? KIND.SPINDRIFT : KIND.MIST,
        streak ? 1.8 + Math.random() * 2.6 : 3.0 + Math.random() * 2.0,
      );
    }
  }

  /**
   * Sea smoke hanging in the troughs once it is really blowing.
   *
   * Deliberately sparse and low. This used to spawn 5 m puffs that inflate to
   * 15 m within 12 m of the lens, which filled the whole lower frame with an
   * opaque bank of cloud; the effect only works as a thin veil that lets the
   * wave structure through.
   */
  private troughMist(ctx: VfxCtx, p: Particles, probe: WaterProbe, dt: number, d: number): void {
    const w = ctx.windSpeed;
    const f = smoothstep(14, 26, w) * (0.45 + 0.55 * clamp01(ctx.world.env.waveHeight / 6));
    if (f < 0.01) return;
    this.accMist += 55 * f * d * dt;
    let n = Math.floor(this.accMist);
    this.accMist -= n;
    n = Math.min(n, p.room);
    if (n === 0) return;

    const cam = ctx.world.camera.position;
    const trough = -ctx.world.env.waveHeight * 0.14;
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * Math.PI * 2;
      // Keep it off the lens: nothing inside 30 m, most of it in the middle
      // distance where it reads as haze lying in the troughs.
      const r = 30 + Math.pow(Math.random(), 0.45) * 170;
      const px = cam.x + Math.cos(ang) * r;
      const pz = cam.z + Math.sin(ang) * r;
      const wy = probe.heightAt(px, pz);
      // Only the troughs hold mist; crests are swept clean.
      if (wy > trough) continue;
      _b.copy(ctx.windVel).multiplyScalar(0.55 + Math.random() * 0.3);
      _b.y += Math.random() * 0.35;
      p.spawn(
        px, wy + 0.3 + Math.random() * 0.9, pz, _b.x, _b.y, _b.z,
        3.0 + Math.random() * 3.0,
        0.9 + Math.random() * 1.5,
        KIND.MIST, 1.2 + Math.random(),
      );
    }
  }
}
