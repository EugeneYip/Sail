import { Bell } from './Bell';
import { createBuffers } from './Buffers';
import type { BusName } from './Buses';
import { Mixer } from './Buses';
import { eventTime, Nodes, Ramp } from './Context';
import { Music } from './Music';
import { registerRigging } from './RiggingWorklet';
import { Sea } from './Sea';
import { ShipSounds } from './ShipSounds';
import type { SimView } from './Sim';
import { Weather } from './Weather';
import { Wildlife } from './Wildlife';
import { NoisePool, TonePool } from './Voices';

export interface RigOptions {
  /** Usually `ctx.destination`. */
  destination?: AudioNode;
  /** Tap an AnalyserNode off the master for live measurement. */
  analyser?: boolean;
  /** Families to silence — used by the offline tests to isolate a variable. */
  mute?: BusName[];
  /** 1 = full voice counts, 0.6 = reduced (low/medium quality tiers). */
  voiceScale?: number;
  /**
   * Offline only: route `masterPre` straight to the destination, skipping the
   * output soft clip. The point is to measure the raw voice sum: a ceiling that
   * never stops working is itself a distortion source, so the test compares the
   * two and fails if the difference is more than a fraction of a dB.
   */
  bypassLimiter?: boolean;
}

/**
 * The whole audio graph. Deliberately knows nothing about `World`: it is built
 * against a `BaseAudioContext` and driven by a `SimView`, which is what lets
 * scripts/audio-test.mjs rebuild it inside an OfflineAudioContext and measure it.
 */
export class Rig {
  readonly nodes: Nodes;
  readonly mixer: Mixer;
  private readonly sea: Sea;
  private readonly wind: import('./Wind').Wind;
  private readonly ship: ShipSounds;
  private readonly bell: Bell;
  private readonly weather: Weather;
  private readonly wildlife: Wildlife;
  private readonly music: Music;
  private readonly listenerRamps: Ramp[] | null;
  private readonly legacyListener: {
    setPosition?: (x: number, y: number, z: number) => void;
    setOrientation?: (
      fx: number,
      fy: number,
      fz: number,
      ux: number,
      uy: number,
      uz: number,
    ) => void;
  } | null;

  private constructor(
    readonly ctx: BaseAudioContext,
    opts: RigOptions,
    workletReady: boolean,
    WindCtor: typeof import('./Wind').Wind,
  ) {
    const nodes = new Nodes(ctx);
    this.nodes = nodes;
    const buffers = createBuffers(ctx);
    const scale = opts.voiceScale ?? 1;
    const n = (x: number): number => Math.max(2, Math.round(x * scale));

    this.mixer = new Mixer(
      nodes,
      buffers,
      opts.destination ?? ctx.destination,
      opts.analyser !== false,
      opts.bypassLimiter === true,
    );
    const b = this.mixer.buses;

    // Three pools, split by family so a gale of sail cracks cannot starve the
    // creaks, and so each pool can use the panning model it deserves.
    // No pool steals a sounding voice any more (see NoisePool.fire), so the count
    // is a hard cap on concurrency: too few and wanted events are dropped, never
    // clipped. `impacts` is the shared one — sea slams, spray, thunder, whales.
    const impacts = new NoisePool(nodes, n(10), buffers.dark, buffers.white, b.sea.in, false, 20);
    const wood = new NoisePool(nodes, n(12), buffers.dark, buffers.white, b.ship.in, true, 11);
    const canvas = new NoisePool(nodes, n(8), buffers.dark, buffers.white, b.ship.in, false, 26);
    const tones = new TonePool(nodes, n(6), buffers.white, b.wildlife.in);

    this.sea = new Sea(nodes, buffers, b.sea, impacts);
    this.wind = new WindCtor(nodes, buffers, b.wind, workletReady);
    this.ship = new ShipSounds(nodes, buffers, b.ship, wood, canvas, tones);
    this.bell = new Bell(nodes, buffers, b.ship);
    this.weather = new Weather(nodes, buffers, b.weather, impacts, wood, this.mixer);
    this.wildlife = new Wildlife(tones, impacts, wood);
    this.music = new Music(nodes, b.music, this.mixer);

    for (const m of opts.mute ?? []) this.mixer.mute(m);

    // Listener: AudioParams where available (everything current), the deprecated
    // setters otherwise.
    const l = ctx.listener;
    if ('positionX' in l) {
      this.listenerRamps = [
        // tau 0.02 was shorter than one stalled frame, so a late update arrived
        // as a simultaneous step in every panner gain in the graph.
        new Ramp(l.positionX, 0.09, 0.03),
        new Ramp(l.positionY, 0.09, 0.03),
        new Ramp(l.positionZ, 0.09, 0.03),
        new Ramp(l.forwardX, 0.09, 0.004),
        new Ramp(l.forwardY, 0.09, 0.004),
        new Ramp(l.forwardZ, 0.09, 0.004),
        new Ramp(l.upX, 0.12, 0.01),
        new Ramp(l.upY, 0.12, 0.01),
        new Ramp(l.upZ, 0.12, 0.01),
      ];
      this.legacyListener = null;
    } else {
      this.listenerRamps = null;
      this.legacyListener = l as unknown as NonNullable<typeof this.legacyListener>;
    }
  }

  static async build(ctx: BaseAudioContext, opts: RigOptions = {}): Promise<Rig> {
    const [ready, wind] = await Promise.all([registerRigging(ctx), import('./Wind')]);
    return new Rig(ctx, opts, ready, wind.Wind);
  }

  /** One frame. `now` must be `ctx.currentTime`. */
  update(sim: SimView, now: number): void {
    this.listener(sim, now);
    this.mixer.update(sim, now);
    this.sea.update(sim, now);
    this.wind.update(sim, now);
    this.ship.update(sim, now);
    this.bell.update(sim, now);
    this.weather.update(sim, now);
    this.wildlife.update(sim, now);
    this.music.update(sim, now);
  }

  /** True when the rigging bank is the per-sample worklet, not the biquad fallback. */
  get usesWorklet(): boolean {
    return this.wind.rigging.usesWorklet;
  }

  /** Fade out/in from outside the frame loop — see `Mixer.hush`. */
  hush(on: boolean, now: number): void {
    this.mixer.hush(on, now);
  }

  lightning(distanceMetres: number, now: number): void {
    this.weather.onLightning(distanceMetres, now);
  }

  strikeBell(count: number, now: number): void {
    let t = eventTime(now, 0.2);
    for (let i = 0; i < Math.max(1, Math.min(8, count)); i++) {
      this.bell.strikeOne(t, 1);
      t += i % 2 === 0 ? 0.34 : 0.86;
    }
  }

  private listener(sim: SimView, now: number): void {
    const p = sim.listenerPos;
    const f = sim.listenerFwd;
    const u = sim.listenerUp;
    const r = this.listenerRamps;
    if (r) {
      r[0].set(p.x, now);
      r[1].set(p.y, now);
      r[2].set(p.z, now);
      r[3].set(f.x, now);
      r[4].set(f.y, now);
      r[5].set(f.z, now);
      r[6].set(u.x, now);
      r[7].set(u.y, now);
      r[8].set(u.z, now);
    } else if (this.legacyListener) {
      this.legacyListener.setPosition?.(p.x, p.y, p.z);
      this.legacyListener.setOrientation?.(f.x, f.y, f.z, u.x, u.y, u.z);
    }
  }

  dispose(): void {
    this.wind.rigging.dispose();
    this.nodes.disposeAll();
  }
}
