import type { BusName } from './Buses';
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
  voiceScale?: number;
  /** Drive heel/pitch/heave sinusoidally so the creak machinery actually runs. */
  motion?: number;
}

export interface ProbeResult {
  seconds: number;
  sampleRate: number;
  rms: number;
  rmsDb: number;
  peak: number;
  peakDb: number;
  /** Spectral centroid over the measured window, Hz. */
  centroid: number;
  /** Fraction of spectral energy above 2 kHz. */
  highRatio: number;
  /** Mean sample value. Anything but ~0 means a DC offset is eating headroom. */
  dc: number;
  /** Count of NaN / Inf / denormal-flushed samples. Must be 0. */
  nonFinite: number;
  liveNodes: number;
  createdNodes: number;
  usesWorklet: boolean;
  /** Wall-clock cost of the driving loop per simulated frame, ms. */
  driveMsPerFrame: number;
}

const DEFAULTS = {
  seconds: 6,
  sampleRate: 24000,
  fps: 60,
  warmup: 2,
};

/**
 * `OfflineAudioContext` renders synchronously once started, so the whole
 * driving loop runs first, scheduling everything against a virtual clock. Every
 * component takes `now` as an argument for exactly this reason.
 */
export async function renderProbe(opts: ProbeOptions = {}): Promise<ProbeResult> {
  const seconds = opts.seconds ?? DEFAULTS.seconds;
  const sampleRate = opts.sampleRate ?? DEFAULTS.sampleRate;
  const fps = opts.fps ?? DEFAULTS.fps;
  const warmup = Math.min(seconds * 0.75, opts.warmup ?? DEFAULTS.warmup);

  const ctx = new OfflineAudioContext({
    numberOfChannels: 2,
    length: Math.ceil(seconds * sampleRate),
    sampleRate,
  });
  const rig = await Rig.build(ctx, {
    analyser: false,
    mute: opts.mute,
    voiceScale: opts.voiceScale ?? 1,
  });

  const drive = drive1(rig, opts, seconds, fps);
  const buf = await ctx.startRendering();
  const stats = analyse(buf, warmup);
  rig.dispose();

  return {
    seconds,
    sampleRate,
    ...stats,
    liveNodes: rig.nodes.live,
    createdNodes: rig.nodes.created,
    usesWorklet: rig.usesWorklet,
    driveMsPerFrame: drive,
  };
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

function drive1(rig: Rig, opts: ProbeOptions, seconds: number, fps: number): number {
  const sim = makeSim(opts);
  const frames = Math.round(seconds * fps);
  const t0 = now();
  for (let i = 0; i < frames; i++) {
    const t = i / fps;
    step(sim, opts, t, seconds);
    rig.update(sim, t);
    if (opts.lightning !== undefined && i === fps) rig.lightning(opts.lightning, t);
    if (opts.bell !== undefined && i === fps) rig.strikeBell(opts.bell, t);
  }
  return frames > 0 ? (now() - t0) / frames : 0;
}

function makeSim(opts: ProbeOptions): SimView {
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
function step(sim: SimView, opts: ProbeOptions, t: number, seconds: number): void {
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

function analyse(
  buf: AudioBuffer,
  warmup: number,
): Omit<ProbeResult, 'seconds' | 'sampleRate' | 'liveNodes' | 'createdNodes' | 'usesWorklet' | 'driveMsPerFrame'> {
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
  const mag = new Float64Array(FFT_SIZE / 2);
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
      for (let k = 1; k < FFT_SIZE / 2; k++) mag[k] += Math.hypot(re[k], im[k]);
      frames++;
    }
  }

  let num = 0;
  let den = 0;
  let high = 0;
  const binHz = buf.sampleRate / FFT_SIZE;
  for (let k = 1; k < FFT_SIZE / 2; k++) {
    const m = frames > 0 ? mag[k] / frames : 0;
    const f = k * binHz;
    num += m * f;
    den += m;
    if (f >= 2000) high += m;
  }

  return {
    rms,
    rmsDb: db(rms),
    peak,
    peakDb: db(peak),
    centroid: den > 1e-12 ? num / den : 0,
    highRatio: den > 1e-12 ? high / den : 0,
    dc: n > 0 ? dc / n : 0,
    nonFinite,
  };
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
