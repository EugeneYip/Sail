import * as THREE from 'three';
import type { VfxCtx } from './Context';
import { HULL } from './Context';
import type { Particles } from './Particles';
import { KIND } from './shaders/particles';
import type { WakeField } from './WakeField';
import type { WaterProbe } from './WaterProbe';

/**
 * Black powder: the galley funnel, and the great guns.
 *
 * A 24-pounder throws roughly its own weight in smoke and the broadside rolls
 * down the ship rather than going off as one bang, so guns are queued with a
 * short stagger. Round shot leaves at ~450 m/s but we only need the splash to
 * feel connected, so the flight is timed to a plausible 300 m range.
 *
 * Keys: `z` = port broadside, `x` = starboard broadside.
 */

const MAX_PENDING = 96;
/** Seconds between successive guns in a rolling broadside. */
const GUN_STAGGER = 0.055;
/** Where the shot lands, metres abeam. */
const SHOT_RANGE = 300;
const SHOT_FLIGHT = 1.05;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _local = new THREE.Vector3();
const _fallbackPort: THREE.Vector3[] = [];
const _fallbackStbd: THREE.Vector3[] = [];
for (let i = 0; i < 13; i++) {
  const z = -16 + i * 2.9;
  _fallbackPort.push(new THREE.Vector3(-7.2, 3.4, z));
  _fallbackStbd.push(new THREE.Vector3(7.2, 3.4, z));
}

interface Pending {
  /** 0 = idle, 1 = gun waiting to fire, 2 = shot in flight. */
  kind: number;
  t: number;
  x: number;
  y: number;
  z: number;
  side: number;
}

export class Ordnance {
  private pending: Pending[] = [];
  private accFunnel = 0;
  private lastFire = -10;

  constructor() {
    for (let i = 0; i < MAX_PENDING; i++) {
      this.pending.push({ kind: 0, t: 0, x: 0, y: 0, z: 0, side: 1 });
    }
  }

  update(ctx: VfxCtx, p: Particles, probe: WaterProbe, wake: WakeField): void {
    if (!p.available) return;
    this.funnel(ctx, p);
    this.input(ctx);
    this.service(ctx, p, probe, wake);
  }

  /* ----------------------------------------------------------------- *
   *  Galley funnel
   * ----------------------------------------------------------------- */

  private funnel(ctx: VfxCtx, p: Particles): void {
    // The galley stack is a small copper funnel just abaft the foremast.
    const deck = ctx.shipExt?.deckHeight ?? 5.6;
    _local.set(0.9, deck + 1.5, -6.2);
    ctx.toWorld(_local, _a);

    this.accFunnel += 26 * ctx.density * ctx.dt;
    const n = Math.floor(this.accFunnel);
    this.accFunnel -= n;

    for (let i = 0; i < n; i++) {
      // Rising hot gas, immediately laid flat by the apparent wind. That shear
      // is the whole visual: the plume bends within a metre of the stack.
      _b.copy(ctx.windVel).multiplyScalar(0.5);
      _b.addScaledVector(ctx.world.ship.velocity, -0.35);
      _b.y += 2.1 + Math.random() * 1.1;
      _b.x += (Math.random() - 0.5) * 0.5;
      _b.z += (Math.random() - 0.5) * 0.5;
      p.spawn(
        _a.x + (Math.random() - 0.5) * 0.3,
        _a.y + Math.random() * 0.3,
        _a.z + (Math.random() - 0.5) * 0.3,
        _b.x, _b.y, _b.z,
        4.0 + Math.random() * 3.5,
        0.34 + Math.random() * 0.3,
        KIND.SMOKE,
        1.3 + Math.random() * 0.8,
      );
    }
  }

  /* ----------------------------------------------------------------- *
   *  Broadside
   * ----------------------------------------------------------------- */

  private input(ctx: VfxCtx): void {
    const input = ctx.world.input;
    const now = ctx.world.time.elapsed;
    if (now - this.lastFire < 1.2) return;
    if (input.justPressed('z')) this.fire(ctx, -1);
    else if (input.justPressed('x')) this.fire(ctx, 1);
  }

  fire(ctx: VfxCtx, side: number): void {
    const ext = ctx.shipExt;
    const guns =
      side < 0
        ? (ext?.gunPortsLocal?.length ? ext.gunPortsLocal : _fallbackPort)
        : (ext?.gunStarboardLocal?.length ? ext.gunStarboardLocal : _fallbackStbd);
    const now = ctx.world.time.elapsed;
    this.lastFire = now;
    // Fire from forward to aft, the way a broadside is actually worked.
    for (let i = 0; i < guns.length; i++) {
      const g = guns[i];
      const slot = this.take();
      if (!slot) return;
      slot.kind = 1;
      slot.t = now + i * GUN_STAGGER;
      slot.x = g.x;
      slot.y = g.y;
      slot.z = g.z;
      slot.side = side;
    }
    ctx.world.bus.emit('vfx:cannon', { side, guns: guns.length });
  }

  private take(): Pending | null {
    for (let i = 0; i < MAX_PENDING; i++) {
      if (this.pending[i].kind === 0) return this.pending[i];
    }
    return null;
  }

  private service(ctx: VfxCtx, p: Particles, probe: WaterProbe, wake: WakeField): void {
    const now = ctx.world.time.elapsed;
    for (let i = 0; i < MAX_PENDING; i++) {
      const e = this.pending[i];
      if (e.kind === 0 || now < e.t) continue;
      if (e.kind === 1) this.discharge(ctx, p, e);
      else this.splash(ctx, p, probe, wake, e);
    }
  }

  private discharge(ctx: VfxCtx, p: Particles, e: Pending): void {
    _local.set(e.x, e.y, e.z);
    ctx.toWorld(_local, _a);
    // Muzzle a little proud of the ship's side.
    _a.addScaledVector(ctx.right, e.side * 1.1);

    for (let i = 0; i < 5; i++) {
      _b.copy(ctx.right).multiplyScalar(e.side * (9 + Math.random() * 14));
      _b.y += (Math.random() - 0.3) * 3.0;
      _b.addScaledVector(ctx.fwd, (Math.random() - 0.5) * 3.0);
      p.spawn(_a.x, _a.y, _a.z, _b.x, _b.y, _b.z, 0.07 + Math.random() * 0.07,
        0.7 + Math.random() * 1.5, KIND.FLASH, 0.5);
    }

    const n = Math.round(34 * Math.min(1, ctx.density + 0.35));
    for (let i = 0; i < n; i++) {
      // A dense jet close to the muzzle that decelerates into a rolling bank.
      const jet = Math.pow(Math.random(), 1.8);
      const out = 3.0 + jet * 24;
      _b.copy(ctx.right).multiplyScalar(e.side * out);
      _b.y += (Math.random() - 0.25) * 3.4;
      _b.addScaledVector(ctx.fwd, (Math.random() - 0.5) * 4.5);
      _b.addScaledVector(ctx.world.ship.velocity, 0.7);
      p.spawn(
        _a.x + (Math.random() - 0.5) * 0.6,
        _a.y + (Math.random() - 0.5) * 0.6,
        _a.z + (Math.random() - 0.5) * 0.6,
        _b.x, _b.y, _b.z,
        3.5 + Math.random() * 4.5,
        0.55 + Math.random() * 1.2,
        KIND.SMOKE,
        0.55 + Math.random() * 1.1,
      );
    }

    // Re-purpose the slot for the fall of shot.
    ctx.toWorld(_local.set(e.x, 0, e.z), _a);
    _a.addScaledVector(ctx.right, e.side * SHOT_RANGE);
    e.kind = 2;
    e.t = ctx.world.time.elapsed + SHOT_FLIGHT;
    e.x = _a.x;
    e.z = _a.z;
  }

  private splash(ctx: VfxCtx, p: Particles, probe: WaterProbe, wake: WakeField, e: Pending): void {
    e.kind = 0;
    const x = e.x;
    const z = e.z;
    const y = probe.heightAt(x, z);

    wake.addRipple(x, z, 1.15, 34, 6.0, 1);
    wake.addFoam(x, z, 5.5, 0.85, 0.55);

    const n = Math.round(70 * Math.min(1, ctx.density + 0.3));
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * Math.PI * 2;
      const r = Math.pow(Math.random(), 0.6);
      // A tall narrow column with a low collar of torn sheet around it.
      const column = Math.random() < 0.45;
      const up = column ? 12 + Math.random() * 16 : 3 + Math.random() * 7;
      const outSp = column ? r * 2.5 : 3 + r * 9;
      p.spawn(
        x + Math.cos(ang) * r * 1.5, y + 0.2, z + Math.sin(ang) * r * 1.5,
        Math.cos(ang) * outSp + ctx.windVel.x * 0.2,
        up,
        Math.sin(ang) * outSp + ctx.windVel.z * 0.2,
        column ? 1.6 + Math.random() * 1.4 : 1.0 + Math.random() * 1.2,
        column ? 0.25 + Math.random() * 0.7 : 0.6 + Math.random() * 1.3,
        column ? KIND.DROPLET : KIND.SHEET,
        column ? 0.5 : 1.0,
      );
    }
    ctx.world.bus.emit('vfx:shotSplash', { x, z });
    void HULL;
  }
}
