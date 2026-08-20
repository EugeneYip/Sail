import type { Module, QualityTier, World } from '../types';
import { ClickWatcher, type LeadSweepRow, type WatchStats } from './ClickProbe';
import { autoplayAllowed, LEAD_S, observeLead, onFirstGesture, schedule } from './Context';
import type { ProbeOptions, ProbeResult } from './Probe';
import { Rig } from './Rig';
import { createSimView, SimTracker, type SimView } from './Sim';

export type AudioStatus =
  /** No context yet: waiting for a gesture, or for autoplay to be permitted. */
  | 'idle'
  /** Context created, buffers and worklet still building. */
  | 'starting'
  | 'running'
  /** Backgrounded tab, or the browser suspended us. */
  | 'suspended'
  /** Construction threw. The game runs silent; we do not retry. */
  | 'failed';

/**
 * Published on `world.ext.audio`. Read it defensively — it exists from `init()`
 * but reports `status: 'idle'` until a user gesture unblocks the context.
 *
 *   const a = world.ext.audio as AudioExt | undefined;
 *   a?.measure().rms
 *
 * `render()` builds a second, independent rig inside an `OfflineAudioContext`
 * and renders it faster than real time. It is how `scripts/audio-test.mjs` gets
 * deterministic numbers; it does not disturb the live graph.
 */
export interface AudioExt {
  readonly status: AudioStatus;
  /** False when the browser refused `audioWorklet` and the biquad fallback is in use. */
  readonly usesWorklet: boolean;
  /** Smoothed main-thread cost of the last audio frame, ms. */
  readonly costMs: number;
  context(): BaseAudioContext | null;
  /** Live measurement off the master analyser tap. */
  measure(): { rms: number; peak: number; brightness: number };
  /** Live vs. ever-created node count. Equal after warm-up == nothing leaks. */
  census(): { live: number; created: number };
  /** Force a start. Only succeeds from a user gesture on a blocking browser. */
  start(): Promise<boolean>;
  lightning(distanceMetres: number): void;
  bell(count: number): void;
  render(opts?: ProbeOptions): Promise<ProbeResult>;
  /** Run the driving loop for `minutes` of simulated time and count nodes. */
  stress(minutes?: number, opts?: ProbeOptions): Promise<CensusResult>;
  /**
   * Tap a per-sample discontinuity detector off the master. This is the only
   * measurement that can see a scheduling defect, because the bug only exists
   * when there is a real audio thread that has already rendered past
   * `currentTime` — see `ClickProbe.ts`. Off by default; nothing is created
   * until a test asks.
   */
  watch(on: boolean): Promise<boolean>;
  /** Read the detector. `reset` restarts the measurement window. */
  watched(reset?: boolean): Promise<WatchStats | null>;
  /**
   * Positive control for `watch`, and the price of LEAD_S on real hardware.
   *
   * Injects deliberate attack envelopes at each of `leads` seconds of lead and
   * returns what the detector counted — see `ClickWatcher.inject`. Too little
   * lead must produce one click per envelope; LEAD_S must produce none. Without
   * this, "0 clicks" is indistinguishable from a blind instrument, which is the
   * failure mode DIAGNOSIS.md §25 records ten times over. Requires `watch(true)`.
   */
  leadSweep(leads: number[], count?: number): Promise<LeadSweepRow[] | null>;
  /**
   * The scheduling-lead invariant, both halves of it.
   *
   * `late` / `worstLeadS`: events the backstop had to push forward because a
   * caller built a time without `eventTime()`. Must stay 0 / Infinity.
   *
   * `renderQuantumS` / `frameGapS` / `needLeadS` / `shortfall`: what the LIVE
   * context turned out to require. `late` can only prove the code asked for
   * `LEAD_S`; these prove `LEAD_S` was enough on the machine it ran on, which no
   * offline render can. `shortfall` must stay 0.
   */
  lateEvents(): {
    late: number;
    worstLeadS: number;
    leadS: number;
    renderQuantumS: number;
    frameGapS: number;
    needLeadS: number;
    shortfall: number;
    outputLatencyS: number;
  };
}

export interface CensusResult {
  afterWarmup: number;
  afterRun: number;
  live: number;
  frames: number;
}

/**
 * Lightning event names we accept from the VFX agent, in preference order.
 * `src/vfx/index.ts` is still a placeholder and documents no event, so this
 * listens for every plausible spelling and takes whichever arrives first.
 * Payload may be a number (metres), `{distance|distanceMetres|range}`, or
 * `{position:{x,z}}` — anything else is treated as a strike at 1.2 km.
 */
const LIGHTNING_EVENTS = ['vfx:lightning', 'weather:lightning', 'env:lightning', 'lightning'];

const VOICE_SCALE: Record<QualityTier, number> = { low: 0.5, medium: 0.7, high: 1, ultra: 1 };

/** How long the tab must stay hidden before we suspend the context, ms. */
const SUSPEND_DELAY_MS = 900;

export class AudioEngine implements Module {
  readonly name = 'audio';

  private world: World | null = null;
  private ctx: AudioContext | null = null;
  private rig: Rig | null = null;
  private readonly sim: SimView = createSimView();
  private readonly tracker = new SimTracker();
  private status: AudioStatus = 'idle';
  private costMs = 0;
  private starting = false;
  private hidden = false;
  private suspendTimer = 0;
  private readonly detach: (() => void)[] = [];
  private warned = false;
  /** Previous frame's `ctx.currentTime`, for the scheduling-lead observation. */
  private lastCtxTime = 0;
  /** Only ever non-null while `scripts/audio-test.mjs` is measuring. */
  private watcher: ClickWatcher | null = null;

  init(world: World): void {
    this.world = world;
    this.tracker.update(world, this.sim);
    world.ext.audio = this.ext();

    for (const name of LIGHTNING_EVENTS) {
      this.detach.push(world.bus.on(name, (p) => this.onLightning(p)));
    }
    // A settings change can turn the volume up from zero, which on a blocking
    // browser is also a gesture — a good moment to try starting.
    this.detach.push(world.bus.on('settings:changed', () => void this.start()));

    const onVisibility = (): void => this.onVisibility(document.hidden);
    document.addEventListener('visibilitychange', onVisibility);
    this.detach.push(() => document.removeEventListener('visibilitychange', onVisibility));

    if (autoplayAllowed()) void this.start();
    else this.detach.push(onFirstGesture(() => void this.start()));
  }

  update(world: World): void {
    const t0 = performance.now();
    // The tracker owns every differentiator in the sim view, so it must run even
    // while we are silent — otherwise the first audible frame after a resume
    // sees a frame-sized jump in heel and fires a burst of creaks.
    this.tracker.update(world, this.sim);

    const ctx = this.ctx;
    const rig = this.rig;
    if (rig && ctx) {
      if (ctx.state === 'running') {
        this.status = 'running';
        const t = ctx.currentTime;
        // Check LEAD_S against this device before using it, not after.
        observeLead(ctx.baseLatency, this.lastCtxTime > 0 ? t - this.lastCtxTime : 0);
        this.lastCtxTime = t;
        rig.update(this.sim, t);
      } else if (this.status !== 'failed') {
        this.status = 'suspended';
      }
    }

    const ms = performance.now() - t0;
    this.costMs += (ms - this.costMs) * 0.05;
    world.stats['audio:ms'] = this.costMs;
    if (rig) {
      world.stats['audio:nodes'] = rig.nodes.live;
      world.stats['audio:created'] = rig.nodes.created;
    }
  }

  applySettings(): void {
    // Volumes and the quality tier reach the graph through the SimView every
    // frame; nothing here needs rebuilding. Voice counts are fixed at build time
    // on purpose — reallocating pools mid-session is exactly the kind of churn
    // the pooling exists to avoid.
  }

  dispose(): void {
    for (const d of this.detach) d();
    this.detach.length = 0;
    clearTimeout(this.suspendTimer);
    this.watcher?.detach();
    this.watcher = null;
    this.rig?.dispose();
    this.rig = null;
    const ctx = this.ctx;
    this.ctx = null;
    this.status = 'idle';
    if (ctx) void ctx.close().catch(() => undefined);
    if (this.world) delete this.world.ext.audio;
  }

  /* ---------------------------------------------------------------- *
   *  Start-up
   * ---------------------------------------------------------------- */

  /**
   * Create the context and build the graph. Safe to call repeatedly: it is a
   * no-op once running, and it never constructs an `AudioContext` while the
   * browser would block it, because constructing a blocked context is precisely
   * what logs Chrome's "was not allowed to start" warning.
   */
  private async start(): Promise<boolean> {
    if (this.status === 'failed') return false;
    if (this.ctx) {
      if (this.ctx.state === 'suspended' && !this.hidden) {
        await this.ctx.resume().catch(() => undefined);
      }
      return this.ctx.state === 'running';
    }
    if (this.starting) return false;
    if (!autoplayAllowed()) return false;
    this.starting = true;
    this.status = 'starting';

    try {
      const ctx = new AudioContext({ latencyHint: 'interactive' });
      this.ctx = ctx;
      if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined);
      const settings = this.world?.settings;
      this.rig = await Rig.build(ctx, {
        analyser: true,
        voiceScale: VOICE_SCALE[settings?.quality ?? 'high'],
      });
      this.status = ctx.state === 'running' ? 'running' : 'suspended';
      return this.status === 'running';
    } catch (err) {
      this.status = 'failed';
      if (!this.warned) {
        this.warned = true;
        // One line, once. A silent game is not worth a wall of console noise.
        console.warn('[audio] disabled:', err instanceof Error ? err.message : String(err));
      }
      return false;
    } finally {
      this.starting = false;
    }
  }

  /**
   * A hidden tab stops `requestAnimationFrame`, so the graph would otherwise
   * keep playing whatever it was playing at the moment we lost focus. Fade, then
   * suspend so the worklet stops burning a core in the background.
   */
  private onVisibility(hidden: boolean): void {
    this.hidden = hidden;
    clearTimeout(this.suspendTimer);
    const ctx = this.ctx;
    if (!ctx || !this.rig) return;
    this.rig.hush(hidden, ctx.currentTime);
    if (hidden) {
      this.suspendTimer = setTimeout(() => {
        if (this.hidden && this.ctx) void this.ctx.suspend().catch(() => undefined);
      }, SUSPEND_DELAY_MS) as unknown as number;
    } else if (ctx.state === 'suspended') {
      void ctx.resume().catch(() => undefined);
    }
  }

  /* ---------------------------------------------------------------- *
   *  Events
   * ---------------------------------------------------------------- */

  private onLightning(payload: unknown): void {
    this.strike(lightningDistance(payload, this.sim.shipPos));
  }

  private strike(distance: number): void {
    const ctx = this.ctx;
    if (!this.rig || !ctx || ctx.state !== 'running') return;
    this.rig.lightning(distance, ctx.currentTime);
  }

  private ext(): AudioExt {
    const self = this;
    return {
      get status(): AudioStatus {
        return self.status;
      },
      get usesWorklet(): boolean {
        return self.rig?.usesWorklet ?? false;
      },
      get costMs(): number {
        return self.costMs;
      },
      context: () => self.ctx,
      measure: () => self.rig?.mixer.measure() ?? { rms: 0, peak: 0, brightness: 0 },
      census: () => ({ live: self.rig?.nodes.live ?? 0, created: self.rig?.nodes.created ?? 0 }),
      start: () => self.start(),
      lightning: (d: number) => self.strike(d),
      bell: (n: number) => {
        const ctx = self.ctx;
        if (self.rig && ctx && ctx.state === 'running') self.rig.strikeBell(n, ctx.currentTime);
      },
      render: async (opts?: ProbeOptions) => {
        const { renderProbe } = await import('./Probe');
        return renderProbe(opts ?? {});
      },
      stress: async (minutes?: number, opts?: ProbeOptions) => {
        const { probeCensus } = await import('./Probe');
        return probeCensus(minutes ?? 5, opts ?? {});
      },
      watch: (on: boolean) => self.watch(on),
      watched: async (reset?: boolean) => (await self.watcher?.stats(reset === true)) ?? null,
      leadSweep: (leads: number[], count?: number) => self.leadSweep(leads, count),
      lateEvents: () => ({
        late: schedule.late,
        worstLeadS: schedule.worstLeadS,
        leadS: LEAD_S,
        renderQuantumS: schedule.renderQuantumS,
        frameGapS: schedule.frameGapS,
        needLeadS: schedule.needLeadS,
        shortfall: schedule.shortfall,
        outputLatencyS: self.ctx?.outputLatency ?? 0,
      }),
    };
  }

  /** Each lead measured on a freshly reset detector, so the rows are independent. */
  private async leadSweep(leads: number[], count = 8): Promise<LeadSweepRow[] | null> {
    const w = this.watcher;
    if (!w) return null;
    const rows: LeadSweepRow[] = [];
    for (const leadS of leads) {
      await w.stats(true);
      rows.push(await w.inject({ leadS, count }));
    }
    await w.stats(true);
    return rows;
  }

  private async watch(on: boolean): Promise<boolean> {
    if (!on) {
      this.watcher?.detach();
      this.watcher = null;
      return false;
    }
    if (this.watcher) return true;
    const ctx = this.ctx;
    if (!ctx || !this.rig || ctx.state !== 'running') return false;
    // `out`, not `master`: the ceiling now sits after the fader, so tapping
    // `master` would measure the mix before its last stage.
    this.watcher = await ClickWatcher.attach(ctx, this.rig.mixer.out);
    return this.watcher !== null;
  }
}

const DEFAULT_STRIKE_M = 1200;

function lightningDistance(payload: unknown, shipPos: { x: number; z: number }): number {
  if (typeof payload === 'number') return Number.isFinite(payload) ? payload : DEFAULT_STRIKE_M;
  if (!payload || typeof payload !== 'object') return DEFAULT_STRIKE_M;
  const o = payload as Record<string, unknown>;
  for (const key of ['distance', 'distanceMetres', 'distanceM', 'range', 'dist']) {
    const v = o[key];
    if (typeof v === 'number' && Number.isFinite(v)) return Math.max(50, v);
  }
  const p = (o.position ?? o.pos ?? o.origin) as { x?: number; z?: number } | undefined;
  if (p && typeof p.x === 'number' && typeof p.z === 'number') {
    return Math.max(50, Math.hypot(p.x - shipPos.x, p.z - shipPos.z));
  }
  return DEFAULT_STRIKE_M;
}
