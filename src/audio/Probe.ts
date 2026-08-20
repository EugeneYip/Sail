import type { BusName } from './Buses';
import {
  CLICK_FLOOR_DB,
  CLICK_GROUP_S,
  CLICK_GUARD_S,
  CLICK_RATIO,
  CLICK_WINDOW_S,
} from './ClickProbe';
import { LEAD_S, schedule } from './Context';
import { Rig } from './Rig';
import { createSimView, type SimSail, type SimView } from './Sim';

/**
 * Offline measurement.
 *
 * The whole rig is built against a `BaseAudioContext` and driven by a flat
 * `SimView`, so it can be rebuilt inside an `OfflineAudioContext`, fed a
 * synthetic voyage and rendered faster than real time. That is the only honest
 * way to assert things like "RMS rises monotonically with wind speed" — a live
 * `AnalyserNode` is at the mercy of whatever the game happens to be doing.
 *
 * Reached from `scripts/audio-test.mjs` via `world.ext.audio.render()`.
 */
export interface ProbeSails {
  count?: number;
  /** Area per sail, m^2. */
  area?: number;
  set?: number;
  luff?: number;
}

export interface ProbeOptions {
  seconds?: number;
  sampleRate?: number;
  /** Simulated frame rate of the driving loop. */
  fps?: number;
  /** Seconds discarded from the head of the measurement while ramps settle. */
  warmup?: number;
  /** Scalar `SimView` overrides, applied every frame. Vectors are ignored. */
  set?: Record<string, number | boolean | string>;
  /** Linear sweep of one scalar field from `from` to `to` across the render. */
  sweep?: { key: string; from: number; to: number };
  sails?: ProbeSails;
  /** Fire one strike at this distance in metres, one second in. */
  lightning?: number;
  /** Strike the bell this many times, one second in. */
  bell?: number;
  mute?: BusName[];
  /** Inverse of `mute`: silence every family EXCEPT these. Attribution tool. */
  only?: BusName[];
  voiceScale?: number;
  /** Drive heel/pitch/heave sinusoidally so the creak machinery actually runs. */
  motion?: number;
  /**
   * Simulate main-thread stalls: freeze the driving loop for `ms` every
   * `everyMs` of simulated time. The frames inside the stall are never called,
   * so the next frame sees one enormous `dt` and a target that has jumped — the
   * exact condition under which bunched-up ramps execute as steps.
   */
  stall?: { ms: number; everyMs: number };
  /** Skip the output soft clip, so the raw voice sum can be measured. */
  bypassLimiter?: boolean;
}

const ALL_BUSES: BusName[] = ['sea', 'ship', 'wind', 'wildlife', 'weather', 'music'];

export interface ProbeResult {
  seconds: number;
  sampleRate: number;
  rms: number;
  rmsDb: number;
  peak: number;
  peakDb: number;
  /** Spectral centroid over the measured window, Hz. */
  centroid: number;
  /** Fraction of POWER above 2 kHz. A flat spectrum gives 0.83 at 24 kHz. */
  highRatio: number;
  /**
   * Fraction of total power in each of `BAND_EDGES_HZ`: sub, swell, body, voice,
   * hiss, air. Bin-count-free, unlike `highRatio`, so it is the honest answer to
   * "is this a sea or a hiss" — see `BAND_NAMES`.
   */
  bands: number[];
  /** Mean sample value. Anything but ~0 means a DC offset is eating headroom. */
  dc: number;
  /** Count of NaN / Inf / denormal-flushed samples. Must be 0. */
  nonFinite: number;
  /**
   * Audible discontinuities found by `countClicks`. This is the direct measure
   * of the owner's complaint: a click IS a sample-to-sample jump the recent past
   * did not predict.
   */
  clicks: number;
  /** Clicks per second of measured audio. */
  clickRate: number;
  /** Largest such jump, dBFS. -240 when none was found. */
  worstJumpDb: number;
  /** Largest jump / local jump RMS. Under `CLICK_RATIO` by construction. */
  worstRatio: number;
  /**
   * Coefficient of variation of the 250 ms block RMS — how much the bed MOVES.
   *
   * Directive 5 asks for a sea that is "never static and never busy", which is
   * not a level, it is a shape. Near 0 is a dead drone; above ~0.5 it is pumping.
   * Measured on the envelope rather than the spectrum because that is the axis
   * the complaint is about.
   */
  envelopeCv: number;
  /**
   * Dominant modulation rate of that envelope, Hz. A swell breathes at a fifth
   * of a Hz or slower; anything approaching 1 Hz reads as a tremolo.
   */
  envelopeRateHz: number;
  liveNodes: number;
  createdNodes: number;
  usesWorklet: boolean;
  /** Wall-clock cost of the driving loop per simulated frame, ms. */
  driveMsPerFrame: number;
  /**
   * Smallest lead, in seconds, between any scheduled `AudioParam` event and the
   * `ctx.currentTime` the frame that scheduled it was given.
   *
   * An `OfflineAudioContext` cannot reproduce the bug this catches: online, the
   * audio thread has already rendered past `currentTime`, so an event scheduled
   * at `currentTime + 2 ms` lands in the PAST and is applied at the next sample —
   * turning a 4 ms attack ramp into a step. Offline nothing has been rendered
   * yet, so the same code sounds perfect and clicks in the game. Measured by
   * instrumenting the prototype instead, which is exact.
   */
  minLeadS: number;
  /** Number of automation calls seen. 0 means the instrumentation did not run. */
  paramWrites: number;
  /**
   * Bare `.value =` assignments on an `AudioParam` during the driving loop.
   *
   * `minLeadS` is structurally blind to these: an assignment carries no time, so
   * there is no lead to measure — it simply takes effect at the next sample the
   * thread renders, which makes it a step by construction and the classic click.
   * The lead invariant is only complete with this at 0, and a grep is not an
   * invariant. Build-time assignments are not counted: the spy is installed
   * after `Rig.build()` returns.
   */
  valueWrites: number;
  /**
   * Events the pools' backstop had to push forward — see `Context.schedule`.
   * Non-zero means some call site bypassed `eventTime()`. Must be 0.
   */
  late: number;
  /** The lead LEAD_S is measured against, so a caller need not import Context. */
  requiredLeadS: number;
}

const DEFAULTS = {
  seconds: 6,
  sampleRate: 24000,
  fps: 60,
  warmup: 2,
};

interface RigRender {
  buf: AudioBuffer;
  live: number;
  created: number;
  usesWorklet: boolean;
  drive: number;
  minLead: number;
  writes: number;
  valueWrites: number;
  late: number;
}

/**
 * Build the rig in an `OfflineAudioContext`, drive it, render it.
 *
 * `OfflineAudioContext` renders synchronously once started, so the whole
 * driving loop runs first, scheduling everything against a virtual clock. Every
 * component takes `now` as an argument for exactly this reason.
 */
async function renderRig(
  opts: ProbeOptions,
  seconds: number,
  sampleRate: number,
): Promise<RigRender> {
  const fps = opts.fps ?? DEFAULTS.fps;
  const ctx = new OfflineAudioContext({
    numberOfChannels: 2,
    length: Math.ceil(seconds * sampleRate),
    sampleRate,
  });
  const rig = await Rig.build(ctx, {
    analyser: false,
    mute: resolveMute(opts),
    voiceScale: opts.voiceScale ?? 1,
    bypassLimiter: opts.bypassLimiter === true,
  });

  const spy = new LeadSpy();
  const late0 = schedule.late;
  let drive = 0;
  try {
    spy.install();
    drive = drive1(rig, opts, seconds, fps, spy);
  } finally {
    spy.restore();
  }
  const buf = await ctx.startRendering();
  const out: RigRender = {
    buf,
    live: rig.nodes.live,
    created: rig.nodes.created,
    usesWorklet: rig.usesWorklet,
    drive,
    minLead: spy.minLead,
    writes: spy.writes,
    valueWrites: spy.valueWrites,
    late: schedule.late - late0,
  };
  rig.dispose();
  return out;
}

export async function renderProbe(opts: ProbeOptions = {}): Promise<ProbeResult> {
  const seconds = opts.seconds ?? DEFAULTS.seconds;
  const sampleRate = opts.sampleRate ?? DEFAULTS.sampleRate;
  const warmup = Math.min(seconds * 0.75, opts.warmup ?? DEFAULTS.warmup);
  const r = await renderRig(opts, seconds, sampleRate);

  return {
    seconds,
    sampleRate,
    ...analyse(r.buf, warmup),
    liveNodes: r.live,
    createdNodes: r.created,
    usesWorklet: r.usesWorklet,
    driveMsPerFrame: r.drive,
    minLeadS: r.minLead,
    paramWrites: r.writes,
    valueWrites: r.valueWrites,
    late: r.late,
    requiredLeadS: LEAD_S,
  };
}

/* ------------------------------------------------------------------ *
 *  Detector calibration
 * ------------------------------------------------------------------ */

export interface SensitivityStep {
  /** Injected step size, dBFS. */
  db: number;
  /** Steps added to the buffer. */
  injected: number;
  /** Steps the detector found, above the control count. */
  found: number;
}

export interface SensitivityResult {
  /** Clicks found in the UNTOUCHED render. Must be 0, or the rest means nothing. */
  falsePositives: number;
  /** Level of the signal the steps were injected into, dBFS. */
  peakDb: number;
  rmsDb: number;
  steps: SensitivityStep[];
  /**
   * Quietest step, dBFS, at which every injection was found. `+240` means the
   * detector caught nothing at any size, i.e. it is blind and every zero it has
   * ever reported is void.
   */
  thresholdDb: number;
}

const SENSITIVITY_STEPS_DB = [-12, -18, -24, -30, -36, -42, -48, -54, -60, -66, -72];

/** Steps are spaced far wider than the 21 ms analysis window, so each is judged alone. */
const INJECT_GAP_S = 0.35;
/** Decay of the injected step. A collapsed attack is a jump, then the tail plays out. */
const INJECT_TAU_S = 0.008;

/**
 * Calibrate `countClicks` against known damage — the positive control the whole
 * click measurement rests on.
 *
 * "0 clicks" is only a result if the detector can be shown to find a click when
 * one is really there. This renders the rig, counts clicks in the clean buffer
 * (which must be 0), then re-counts with `n` deliberate discontinuities of known
 * size added, sweeping the size down until they stop being found. The answer is
 * a sensitivity in dBFS, which is what turns "no clicks" into "no discontinuity
 * larger than X".
 */
export async function probeSensitivity(
  opts: ProbeOptions = {},
  stepsDb: readonly number[] = SENSITIVITY_STEPS_DB,
): Promise<SensitivityResult> {
  const seconds = opts.seconds ?? DEFAULTS.seconds;
  const sampleRate = opts.sampleRate ?? DEFAULTS.sampleRate;
  const warmup = Math.min(seconds * 0.75, opts.warmup ?? DEFAULTS.warmup);
  const { buf } = await renderRig(opts, seconds, sampleRate);
  const start = Math.min(buf.length - 1, Math.floor(warmup * sampleRate));

  const clean = buf.getChannelData(0);
  const control = countClicks(clean, start, sampleRate);

  let peak = 0;
  let sum = 0;
  for (let i = start; i < clean.length; i++) {
    const v = clean[i];
    if (!Number.isFinite(v)) continue;
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
    sum += v * v;
  }
  const n = Math.max(1, clean.length - start);

  const scratch = new Float32Array(clean.length);
  const steps: SensitivityStep[] = [];
  let thresholdDb = 240;
  for (const db of stepsDb) {
    scratch.set(clean);
    const injected = injectSteps(scratch, start, sampleRate, Math.pow(10, db / 20));
    const found = countClicks(scratch, start, sampleRate).clicks - control.clicks;
    steps.push({ db, injected, found });
    if (injected > 0 && found >= injected && db < thresholdDb) thresholdDb = db;
  }

  return {
    falsePositives: control.clicks,
    peakDb: db(peak),
    rmsDb: db(Math.sqrt(sum / n)),
    steps,
    thresholdDb,
  };
}

/**
 * Add discontinuities of exactly `amp` to `d`, spaced through the measured
 * region. Each is an instant jump followed by an exponential tail, which is what
 * an attack ramp collapsing into a step actually does to the signal — so the
 * count the detector returns is the count it would return on the real defect.
 */
function injectSteps(d: Float32Array, start: number, sampleRate: number, amp: number): number {
  const gap = Math.max(1, Math.round(INJECT_GAP_S * sampleRate));
  const tau = INJECT_TAU_S * sampleRate;
  const tail = Math.round(tau * 6);
  let count = 0;
  for (let at = start + gap; at + tail < d.length; at += gap) {
    for (let j = 0; j < tail; j++) d[at + j] += amp * Math.exp(-j / tau);
    count++;
  }
  return count;
}

/**
 * Records the smallest lead any frame gave an automation event.
 *
 * Patches `AudioParam.prototype` for the duration of one driving loop. That is a
 * global, so it is installed and removed synchronously around the loop and never
 * while anything awaits — the live game's own graph is only ever measured, not
 * scheduled, from here.
 */
class LeadSpy {
  minLead = Infinity;
  writes = 0;
  valueWrites = 0;
  private now = 0;
  private saved: [string, (...a: never[]) => unknown][] = [];
  private savedValue: PropertyDescriptor | null = null;

  /** (method name, index of the time argument). */
  private static readonly SCHEDULERS: readonly (readonly [string, number])[] = [
    ['setValueAtTime', 1],
    ['linearRampToValueAtTime', 1],
    ['exponentialRampToValueAtTime', 1],
    ['setTargetAtTime', 1],
    ['setValueCurveAtTime', 1],
  ];

  frame(now: number): void {
    this.now = now;
  }

  install(): void {
    if (typeof AudioParam === 'undefined') return;
    const proto = AudioParam.prototype as unknown as Record<string, (...a: never[]) => unknown>;
    for (const [name, idx] of LeadSpy.SCHEDULERS) {
      const orig = proto[name];
      if (typeof orig !== 'function') continue;
      this.saved.push([name, orig]);
      const spy = this;
      proto[name] = function patched(this: AudioParam, ...args: unknown[]): unknown {
        const t = args[idx];
        if (typeof t === 'number' && Number.isFinite(t)) {
          spy.writes++;
          const lead = t - spy.now;
          if (lead < spy.minLead) spy.minLead = lead;
        }
        return (orig as unknown as (...a: unknown[]) => unknown).apply(this, args);
      } as unknown as (...a: never[]) => unknown;
    }

    // `.value =` carries no time, so there is no lead to measure and `minLead`
    // cannot see it — it applies at the next sample rendered, which is a step.
    // Counting it is what makes the lead invariant complete rather than a grep.
    const desc = Object.getOwnPropertyDescriptor(AudioParam.prototype, 'value');
    if (desc && typeof desc.set === 'function') {
      this.savedValue = desc;
      const set = desc.set;
      const spy = this;
      Object.defineProperty(AudioParam.prototype, 'value', {
        configurable: true,
        enumerable: desc.enumerable === true,
        get: desc.get,
        set(this: AudioParam, v: number): void {
          spy.valueWrites++;
          set.call(this, v);
        },
      });
    }
  }

  restore(): void {
    if (typeof AudioParam === 'undefined') return;
    const proto = AudioParam.prototype as unknown as Record<string, (...a: never[]) => unknown>;
    for (const [name, orig] of this.saved) proto[name] = orig;
    this.saved.length = 0;
    if (this.savedValue) {
      Object.defineProperty(AudioParam.prototype, 'value', this.savedValue);
      this.savedValue = null;
    }
    if (this.minLead === Infinity) this.minLead = 0;
  }
}

/**
 * Node census only — no rendering. Proves the pools never allocate by running
 * the driving loop for `minutes` of simulated time at a token sample rate and
 * comparing the created-node count before and after.
 */
export async function probeCensus(
  minutes = 5,
  opts: ProbeOptions = {},
): Promise<{ afterWarmup: number; afterRun: number; live: number; frames: number }> {
  const sampleRate = 8000;
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: sampleRate, sampleRate });
  const rig = await Rig.build(ctx, { analyser: false, voiceScale: opts.voiceScale ?? 1 });

  const fps = opts.fps ?? 60;
  const sim = makeSim(opts);
  const warmupFrames = fps * 5;
  const total = Math.round(minutes * 60 * fps);
  let afterWarmup = 0;
  for (let i = 0; i < total; i++) {
    const t = i / fps;
    step(sim, opts, t, minutes * 60);
    rig.update(sim, t);
    if (i === warmupFrames) afterWarmup = rig.nodes.created;
  }
  const out = { afterWarmup, afterRun: rig.nodes.created, live: rig.nodes.live, frames: total };
  rig.dispose();
  return out;
}

/* ------------------------------------------------------------------ *
 *  Driving
 * ------------------------------------------------------------------ */

export function resolveMute(opts: ProbeOptions): BusName[] | undefined {
  if (!opts.only) return opts.mute;
  const keep = new Set(opts.only);
  const out = ALL_BUSES.filter((b) => !keep.has(b));
  for (const m of opts.mute ?? []) if (!out.includes(m)) out.push(m);
  return out;
}

/**
 * The driving loop. `stall` skips whole runs of frames, which is how a
 * main-thread hitch actually presents to the audio module: `update()` is simply
 * not called, then it is called once with a huge `dt` and a target that has
 * moved a long way. Everything downstream must degrade into a slightly stale
 * value, never a step.
 */
function drive1(rig: Rig, opts: ProbeOptions, seconds: number, fps: number, spy?: LeadSpy): number {
  const sim = makeSim(opts);
  const frames = Math.round(seconds * fps);
  const stall = opts.stall;
  const stallEvery = stall ? Math.max(1, Math.round((stall.everyMs / 1000) * fps)) : 0;
  const stallFrames = stall ? Math.max(1, Math.round((stall.ms / 1000) * fps)) : 0;
  const t0 = now();
  let lastT = 0;
  let served = 0;
  for (let i = 0; i < frames; i++) {
    const t = i / fps;
    if (stall && stallEvery > 0 && i % stallEvery >= stallEvery - stallFrames && i > fps) continue;
    step(sim, opts, t, seconds);
    // dt must reflect the real gap, or the event-rate accumulators silently
    // under-count and the stall test measures nothing.
    sim.dt = Math.max(1 / fps, t - lastT);
    lastT = t;
    served++;
    spy?.frame(t);
    rig.update(sim, t);
    if (opts.lightning !== undefined && i === fps) rig.lightning(opts.lightning, t);
    if (opts.bell !== undefined && i === fps) rig.strikeBell(opts.bell, t);
  }
  return served > 0 ? (now() - t0) / served : 0;
}

export function makeSim(opts: ProbeOptions): SimView {
  const sim = createSimView();
  sim.dt = 1 / (opts.fps ?? DEFAULTS.fps);
  const s = opts.sails;
  if (s) {
    const count = Math.max(0, Math.round(s.count ?? 12));
    const sails: SimSail[] = [];
    for (let i = 0; i < count; i++) {
      sails.push({
        id: `p${i}`,
        mast: i % 3,
        tier: i % 4,
        set: s.set ?? 1,
        brace: 0,
        area: s.area ?? 300,
        luff: s.luff ?? 0,
        force: 4000,
        triangular: i % 5 === 0,
      });
    }
    sim.sails = sails;
  }
  return sim;
}

/** Apply the scene for time `t`. Never allocates. */
export function step(sim: SimView, opts: ProbeOptions, t: number, seconds: number): void {
  sim.dt = 1 / (opts.fps ?? DEFAULTS.fps);
  sim.elapsed = t;

  if (opts.set) assignScalars(sim, opts.set);

  const sw = opts.sweep;
  if (sw) {
    const u = seconds > 0 ? Math.min(1, t / seconds) : 0;
    assignScalar(sim, sw.key, sw.from + (sw.to - sw.from) * u);
  }

  // Apparent wind follows true wind unless the caller pinned it.
  if (!opts.set || opts.set.apparentWind === undefined) {
    sim.apparentWind = sim.windSpeed + sim.speedKnots * 0.34;
  }
  sim.beaufort = beaufort(sim.windSpeed);

  let draw = 0;
  let luff = 0;
  for (const s of sim.sails) {
    const area = s.area * clamp01(s.set);
    const l = clamp01(s.luff);
    draw += area * (1 - l);
    luff += area * l;
  }
  sim.drawArea = draw;
  sim.luffArea = luff;

  const m = opts.motion ?? 0;
  if (m > 0) {
    // A 9 s roll and a 5.3 s pitch, deliberately incommensurate.
    const wr = (2 * Math.PI) / 9;
    const wp = (2 * Math.PI) / 5.3;
    sim.heel = m * 0.18 * Math.sin(wr * t);
    sim.pitch = m * 0.06 * Math.sin(wp * t + 1.1);
    sim.rollRate = m * 0.18 * wr * Math.abs(Math.cos(wr * t));
    sim.pitchRate = m * 0.06 * wp * Math.abs(Math.cos(wp * t + 1.1));
    sim.heaveRate = m * 1.6 * Math.sin(wp * t * 0.8);
    sim.heaveAccel = m * 1.6 * wp * 0.8 * Math.cos(wp * t * 0.8);
  }
}

const SCALAR = new Set(['number', 'boolean', 'string']);

function assignScalars(sim: SimView, patch: Record<string, unknown>): void {
  for (const k in patch) assignScalar(sim, k, patch[k]);
}

function assignScalar(sim: SimView, key: string, value: unknown): void {
  const target = sim as unknown as Record<string, unknown>;
  const cur = target[key];
  if (!SCALAR.has(typeof cur) || typeof cur !== typeof value) return;
  if (typeof value === 'number' && !Number.isFinite(value)) return;
  target[key] = value;
}

/** Beaufort from 10 m wind speed — the standard u = 0.836 * B^1.5 inverted. */
function beaufort(u: number): number {
  return Math.min(12, Math.pow(Math.max(0, u) / 0.836, 2 / 3));
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/* ------------------------------------------------------------------ *
 *  Analysis
 * ------------------------------------------------------------------ */

const FFT_SIZE = 4096;

/**
 * Band edges for `ProbeResult.bands`, Hz.
 *
 * Chosen against what a sea actually does, not by octaves: the swell and surge
 * live under 150 Hz, the body of moving water sits between 150 Hz and 800 Hz,
 * breaking water peaks around 1-3 kHz, and everything above 5 kHz is spray —
 * pleasant in a teaspoon and fatiguing by the bucket. `sub` should be nearly
 * empty: nobody hears it and it eats headroom.
 */
export const BAND_EDGES_HZ = [0, 35, 150, 800, 3000, 7000, Infinity];
export const BAND_NAMES = ['sub', 'swell', 'body', 'break', 'hiss', 'air'];

function analyse(
  buf: AudioBuffer,
  warmup: number,
): Omit<
  ProbeResult,
  // Supplied by the caller: the first five describe the run, and minLeadS/paramWrites
  // come from the AudioParam spy — a rendered buffer cannot reveal them.
  | 'seconds'
  | 'sampleRate'
  | 'liveNodes'
  | 'createdNodes'
  | 'usesWorklet'
  | 'driveMsPerFrame'
  | 'minLeadS'
  | 'paramWrites'
  | 'valueWrites'
  | 'late'
  | 'requiredLeadS'
> {
  const start = Math.min(buf.length - 1, Math.floor(warmup * buf.sampleRate));
  const chans: Float32Array[] = [];
  for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));

  let sum = 0;
  let dc = 0;
  let peak = 0;
  let nonFinite = 0;
  let n = 0;
  for (const d of chans) {
    for (let i = start; i < d.length; i++) {
      const v = d[i];
      if (!Number.isFinite(v)) {
        nonFinite++;
        continue;
      }
      sum += v * v;
      dc += v;
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
      n++;
    }
  }
  const rms = n > 0 ? Math.sqrt(sum / n) : 0;

  // Spectrum: Hann-windowed frames averaged across the measured region and both
  // channels. Enough resolution to see the sea move under the hull rush.
  const re = new Float32Array(FFT_SIZE);
  const im = new Float32Array(FFT_SIZE);
  const pow = new Float64Array(FFT_SIZE / 2);
  const win = new Float32Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_SIZE);

  let frames = 0;
  const hop = FFT_SIZE;
  for (const d of chans) {
    for (let o = start; o + FFT_SIZE <= d.length; o += hop) {
      for (let i = 0; i < FFT_SIZE; i++) {
        const v = d[o + i];
        re[i] = Number.isFinite(v) ? v * win[i] : 0;
        im[i] = 0;
      }
      fft(re, im);
      for (let k = 1; k < FFT_SIZE / 2; k++) pow[k] += re[k] * re[k] + im[k] * im[k];
      frames++;
    }
  }

  // Centroid is weighted by magnitude (closer to what the ear does with a
  // tilted spectrum); the band split is by power, because power adds.
  let num = 0;
  let den = 0;
  let high = 0;
  let total = 0;
  const bandPow = new Float64Array(BAND_NAMES.length);
  const binHz = buf.sampleRate / FFT_SIZE;
  for (let k = 1; k < FFT_SIZE / 2; k++) {
    const e = frames > 0 ? pow[k] / frames : 0;
    const m = Math.sqrt(e);
    const f = k * binHz;
    num += m * f;
    den += m;
    total += e;
    if (f >= 2000) high += e;
    for (let b = 0; b < BAND_NAMES.length; b++) {
      if (f >= BAND_EDGES_HZ[b] && f < BAND_EDGES_HZ[b + 1]) {
        bandPow[b] += e;
        break;
      }
    }
  }
  const bands = Array.from(bandPow, (e) => (total > 1e-30 ? e / total : 0));

  let clicks = 0;
  let worstJump = 0;
  let worstRatio = 0;
  for (const d of chans) {
    const c = countClicks(d, start, buf.sampleRate);
    clicks += c.clicks;
    if (c.worstJump > worstJump) worstJump = c.worstJump;
    if (c.worstRatio > worstRatio) worstRatio = c.worstRatio;
  }
  const measured = Math.max(1e-6, (buf.length - start) / buf.sampleRate);

  return {
    rms,
    rmsDb: db(rms),
    peak,
    peakDb: db(peak),
    centroid: den > 1e-12 ? num / den : 0,
    highRatio: total > 1e-30 ? high / total : 0,
    bands,
    dc: n > 0 ? dc / n : 0,
    nonFinite,
    clicks,
    clickRate: clicks / measured,
    worstJumpDb: db(worstJump),
    worstRatio,
    ...envelope(chans, start, buf.sampleRate),
  };
}

/** Block length for the envelope measure. Short enough to see a swell, long
 * enough that broadband noise averages out instead of contributing its own
 * variance. */
const ENVELOPE_BLOCK_S = 0.25;
/** Modulation rates scanned, Hz. The slowest sea LFO in Sea.ts is 1/41 s. */
const ENVELOPE_MIN_HZ = 0.02;
const ENVELOPE_MAX_HZ = 1.2;

/**
 * How the bed moves, as opposed to how loud it is.
 *
 * `cv` is the coefficient of variation of the block RMS. `rateHz` is the
 * strongest periodicity in that series, found by a brute-force DFT over
 * candidate rates — the series is only a few hundred points, so scanning is
 * cheaper and clearer than padding to a power of two, and it lets the scan be
 * bounded to rates a sea can plausibly have.
 */
function envelope(
  chans: Float32Array[],
  start: number,
  sampleRate: number,
): { envelopeCv: number; envelopeRateHz: number } {
  const blockLen = Math.max(1, Math.round(ENVELOPE_BLOCK_S * sampleRate));
  const n = Math.floor((chans[0].length - start) / blockLen);
  if (n < 8) return { envelopeCv: 0, envelopeRateHz: 0 };

  const env = new Float64Array(n);
  for (let b = 0; b < n; b++) {
    let sum = 0;
    let count = 0;
    for (const d of chans) {
      const o = start + b * blockLen;
      for (let i = 0; i < blockLen; i++) {
        const v = d[o + i];
        if (!Number.isFinite(v)) continue;
        sum += v * v;
        count++;
      }
    }
    env[b] = count > 0 ? Math.sqrt(sum / count) : 0;
  }

  let mean = 0;
  for (let b = 0; b < n; b++) mean += env[b];
  mean /= n;
  if (!(mean > 1e-12)) return { envelopeCv: 0, envelopeRateHz: 0 };
  let varSum = 0;
  for (let b = 0; b < n; b++) {
    const d = env[b] - mean;
    varSum += d * d;
  }
  const cv = Math.sqrt(varSum / n) / mean;

  // Strongest rate in the de-meaned envelope.
  const dt = ENVELOPE_BLOCK_S;
  const span = n * dt;
  let bestPow = 0;
  let bestHz = 0;
  const stepHz = 1 / (4 * span);
  for (let f = ENVELOPE_MIN_HZ; f <= ENVELOPE_MAX_HZ; f += stepHz) {
    let re = 0;
    let im = 0;
    for (let b = 0; b < n; b++) {
      const ang = 2 * Math.PI * f * b * dt;
      const v = env[b] - mean;
      re += v * Math.cos(ang);
      im -= v * Math.sin(ang);
    }
    const pow = re * re + im * im;
    if (pow > bestPow) {
      bestPow = pow;
      bestHz = f;
    }
  }
  return { envelopeCv: cv, envelopeRateHz: bestHz };
}

/**
 * Count audible discontinuities. The streaming twin of this runs on the audio
 * thread in `ClickProbe.ts`; both share the constants so the numbers compare.
 *
 * A click is not "a big sample-to-sample difference" — white noise is nothing
 * but big differences. A click is a difference the RECENT PAST did not predict,
 * so the threshold is the RMS of the first difference over the preceding 20 ms,
 * measured up to 1 ms before the candidate so the event cannot raise its own
 * threshold. That makes the test scale-free and, usefully, roughly
 * perceptual: the same absolute step is flagged in a narrow-band creak, where it
 * is plainly audible, and ignored under a broadband foam hiss, where it is not.
 *
 * Detections within 3 ms are one click, because one envelope step spreads over
 * a few samples once it has been through a filter.
 */
function countClicks(
  d: Float32Array,
  start: number,
  sampleRate: number,
): { clicks: number; worstJump: number; worstRatio: number } {
  const win = Math.max(16, Math.round(CLICK_WINDOW_S * sampleRate));
  const guard = Math.max(2, Math.round(CLICK_GUARD_S * sampleRate));
  const group = Math.max(4, Math.round(CLICK_GROUP_S * sampleRate));
  const floor = Math.pow(10, CLICK_FLOOR_DB / 20);
  const from = Math.max(start, 1);
  if (d.length - from < win + guard + 4) {
    return { clicks: 0, worstJump: 0, worstRatio: 0 };
  }

  // Running sum of squared first differences over [i-guard-win, i-guard).
  let sum = 0;
  const diff = (i: number): number => {
    const a = d[i];
    const b = d[i - 1];
    return Number.isFinite(a) && Number.isFinite(b) ? a - b : 0;
  };
  const head0 = from;
  for (let i = head0; i < head0 + win; i++) {
    const v = diff(i);
    sum += v * v;
  }

  let clicks = 0;
  let worstJump = 0;
  let worstRatio = 0;
  let lastAt = -1e9;
  for (let i = head0 + win + guard; i < d.length; i++) {
    const local = Math.sqrt(sum / win);
    const v = Math.abs(diff(i));
    if (v > floor && local > 1e-9 && v > CLICK_RATIO * local) {
      if (i - lastAt > group) clicks++;
      lastAt = i;
      if (v > worstJump) worstJump = v;
      const ratio = v / local;
      if (ratio > worstRatio) worstRatio = ratio;
    }
    // Slide the window forward one sample, still ending `guard` behind `i`.
    const add = diff(i - guard);
    const drop = diff(i - guard - win);
    sum += add * add - drop * drop;
    if (sum < 0) sum = 0;
  }
  return { clicks, worstJump, worstRatio };
}

function db(x: number): number {
  return x > 1e-12 ? 20 * Math.log10(x) : -240;
}

/** In-place iterative radix-2 FFT. Length must be a power of two. */
function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = a + half;
        const vr = re[b] * cr - im[b] * ci;
        const vi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - vr;
        im[b] = im[a] - vi;
        re[a] += vr;
        im[a] += vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}
