import { makeRng } from '../util/math';

/**
 * Every sample the game ever plays is generated here, once, at init. There are
 * no audio files. Four looping noise beds plus four impulse responses is enough
 * raw material for the whole mix — everything else is filtering, enveloping and
 * resonance applied to these.
 *
 * Loops are crossfade-wrapped: a heavily low-passed noise loop with a raw splice
 * point ticks once per period, which is the most obvious tell of cheap
 * procedural audio.
 */
export interface AudioBuffers {
  /** Flat spectrum, decorrelated channels. Hiss, foam, transients. */
  white: AudioBuffer;
  /** -3 dB/oct. The workhorse for beds — wind, water, sail rumble. */
  pink: AudioBuffer;
  /** Red/brown noise for swell rumble and thunder. */
  dark: AudioBuffer;
  /** Sparse impulsive clicks — rain on the deck, granular by construction. */
  patter: AudioBuffer;
  /** Fibrous 1/f-modulated noise for rope, canvas and wind buffeting. */
  fibre: AudioBuffer;
  irSea: AudioBuffer;
  irDeck: AudioBuffer;
  irCliff: AudioBuffer;
  irMusic: AudioBuffer;
}

type Rng = () => number;

/** Crossfade the head of a buffer with the tail so it loops without a click. */
function wrapLoop(src: Float32Array, out: Float32Array, fade: number): void {
  const n = out.length;
  for (let i = 0; i < n; i++) out[i] = src[i];
  for (let i = 0; i < fade; i++) {
    const w = i / fade;
    out[i] = src[i] * w + src[n + i] * (1 - w);
  }
}

/** Paul Kellett's 7-pole pink filter — flat to within 0.05 dB from 10 Hz up. */
function pinkFilter(): (w: number) => number {
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  let b4 = 0;
  let b5 = 0;
  let b6 = 0;
  return (w: number) => {
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    const out = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
    b6 = w * 0.115926;
    return out * 0.11;
  };
}

function fillWhite(dst: Float32Array, rng: Rng): void {
  for (let i = 0; i < dst.length; i++) dst[i] = rng() * 2 - 1;
}

function fillPink(dst: Float32Array, rng: Rng): void {
  const f = pinkFilter();
  for (let i = 0; i < dst.length; i++) dst[i] = f(rng() * 2 - 1);
}

/** Leaky-integrated white with the DC wander removed. */
function fillBrown(dst: Float32Array, rng: Rng): void {
  let y = 0;
  let dc = 0;
  for (let i = 0; i < dst.length; i++) {
    y = 0.995 * y + (rng() * 2 - 1) * 0.08;
    dc += (y - dc) * 0.0004;
    dst[i] = (y - dc) * 3.2;
  }
}

function normalise(dst: Float32Array, targetPeak: number): void {
  let peak = 1e-9;
  for (let i = 0; i < dst.length; i++) {
    const a = Math.abs(dst[i]);
    if (a > peak) peak = a;
  }
  const k = targetPeak / peak;
  for (let i = 0; i < dst.length; i++) dst[i] *= k;
}

/**
 * Scale so that sqrt(sum x^2) == `targetGain`.
 *
 * For an impulse response that sum IS the RMS gain the convolver will apply to a
 * broadband signal, so normalising the energy is the only normalisation that
 * makes a wet-send gain mean anything. See `IrSpec.gain`.
 */
function normaliseEnergy(dst: Float32Array, targetGain: number): void {
  let sum = 0;
  for (let i = 0; i < dst.length; i++) sum += dst[i] * dst[i];
  const k = targetGain / (Math.sqrt(sum) || 1e-9);
  for (let i = 0; i < dst.length; i++) dst[i] *= k;
}

/* ------------------------------------------------------------------ *
 *  Impulse responses
 * ------------------------------------------------------------------ */

export interface IrSpec {
  seconds: number;
  /** Per-band decay time constants, seconds. HF always dies first in air. */
  tailLow: number;
  tailMid: number;
  tailHigh: number;
  /** Direct-to-diffuse gap, seconds. */
  predelay: number;
  /** Discrete early reflections as [time s, gain]. */
  reflections?: readonly (readonly [number, number])[];
  /** Diffuse-field build-up time constant, seconds. */
  buildup?: number;
  /**
   * The RMS gain the convolver applies to a broadband signal — sqrt(sum h^2).
   * 1 is power-neutral, which is what all four spaces use: the send gain and the
   * wet gain in `Buses.ts` are then the ONLY level controls, and they mean what
   * they say.
   *
   * This used to be a target RMS, which is a different quantity by a factor of
   * sqrt(length x sampleRate). Measured consequences: the 3.6 s music wash
   * returned x18.7 (+25.4 dB) at 48 kHz and the 0.34 s sea haze x2.55 (+8.1 dB),
   * so "a 0.55 send into a 0.9 wet" was really nine times the dry signal — and
   * every number was 3 dB lower at the probe's 24 kHz than in the game's 48 kHz,
   * so the offline suite could not see it.
   */
  gain: number;
  /** Extra inter-channel time offset, seconds. */
  width: number;
}

/**
 * An IR is exponentially decaying filtered noise. Splitting into three bands
 * with different decay constants is what separates a believable space from a
 * "reverb-shaped hiss": a wooden cabin loses its treble in 100 ms and keeps a
 * low thump for half a second.
 */
function makeIr(ctx: BaseAudioContext, spec: IrSpec, seed: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const n = Math.max(64, Math.floor(spec.seconds * sr));
  const buf = ctx.createBuffer(2, n, sr);
  const rng = makeRng(seed);

  const aLow = 1 - Math.exp((-2 * Math.PI * 300) / sr);
  const aHigh = 1 - Math.exp((-2 * Math.PI * 2200) / sr);
  const buildup = spec.buildup ?? 0.004;

  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    const pre = Math.floor((spec.predelay + (ch === 1 ? spec.width : 0)) * sr);
    let lp1 = 0;
    let lp2 = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const w = rng() * 2 - 1;
      lp1 += aLow * (w - lp1);
      lp2 += aHigh * (w - lp2);
      const low = lp1;
      const mid = lp2 - lp1;
      const high = w - lp2;
      const env = 1 - Math.exp(-t / buildup);
      const v =
        low * Math.exp(-t / spec.tailLow) * 1.9 +
        mid * Math.exp(-t / spec.tailMid) +
        high * Math.exp(-t / spec.tailHigh) * 0.8;
      const j = i + pre;
      if (j < n) d[j] += v * env;
    }
    for (const [rt, rg] of spec.reflections ?? []) {
      const start = Math.floor((rt + (ch === 1 ? spec.width * 2.3 : 0)) * sr);
      const len = Math.floor(0.012 * sr);
      for (let i = 0; i < len && start + i < n; i++) {
        const e = Math.exp(-i / (len * 0.28));
        d[start + i] += (rng() * 2 - 1) * rg * e;
      }
    }
    normaliseEnergy(d, spec.gain);
  }
  return buf;
}

/** Almost dry. At sea there is nothing to reflect off but a little haze. */
const IR_SEA: IrSpec = {
  seconds: 0.34,
  tailLow: 0.09,
  tailMid: 0.055,
  tailHigh: 0.02,
  predelay: 0.006,
  gain: 1,
  width: 0.0021,
  buildup: 0.01,
};

/** Small, woody, boxy. Comb-spaced reflections off deckhead and bulkheads. */
const IR_DECK: IrSpec = {
  seconds: 0.62,
  tailLow: 0.2,
  tailMid: 0.1,
  tailHigh: 0.03,
  predelay: 0.0035,
  reflections: [
    [0.0068, 0.5],
    [0.0112, 0.38],
    [0.0173, 0.3],
    [0.0241, 0.22],
    [0.0342, 0.16],
  ],
  gain: 1,
  width: 0.0009,
  buildup: 0.006,
};

/** Harbour wall / cliff. Two real slapbacks at 58 m and 105 m, then a tail. */
const IR_CLIFF: IrSpec = {
  seconds: 2.3,
  tailLow: 0.62,
  tailMid: 0.4,
  tailHigh: 0.12,
  predelay: 0.34,
  reflections: [
    [0.338, 0.85],
    [0.352, 0.4],
    [0.612, 0.42],
    [0.641, 0.2],
    [0.95, 0.14],
  ],
  gain: 1,
  width: 0.0072,
  buildup: 0.12,
};

/** Not a real space — a long dark wash for the generative music only. */
const IR_MUSIC: IrSpec = {
  seconds: 3.6,
  tailLow: 1.35,
  tailMid: 0.85,
  tailHigh: 0.22,
  predelay: 0.03,
  gain: 1,
  width: 0.011,
  buildup: 0.09,
};

/* ------------------------------------------------------------------ *
 *  Assembly
 * ------------------------------------------------------------------ */

function stereoNoise(
  ctx: BaseAudioContext,
  seconds: number,
  fill: (dst: Float32Array, rng: Rng) => void,
  fadeSeconds: number,
  peak: number,
  seed: number,
): AudioBuffer {
  const sr = ctx.sampleRate;
  const n = Math.floor(seconds * sr);
  const fade = Math.floor(fadeSeconds * sr);
  const buf = ctx.createBuffer(2, n, sr);
  const tmp = new Float32Array(n + fade);
  for (let ch = 0; ch < 2; ch++) {
    fill(tmp, makeRng(seed + ch * 7919));
    const d = buf.getChannelData(ch);
    wrapLoop(tmp, d, fade);
    normalise(d, peak);
  }
  return buf;
}

/**
 * Rain. Baking the grains into the buffer instead of firing a node per drop is
 * the difference between 800 voices/second and zero.
 */
function pattern(ctx: BaseAudioContext, seed: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const seconds = 3;
  const n = Math.floor(seconds * sr);
  const fade = Math.floor(0.05 * sr);
  const buf = ctx.createBuffer(2, n, sr);
  const dropsPerSecond = 1100;
  for (let ch = 0; ch < 2; ch++) {
    const rng = makeRng(seed + ch * 104729);
    const tmp = new Float32Array(n + fade);
    const count = Math.floor(dropsPerSecond * (seconds + 0.05));
    for (let k = 0; k < count; k++) {
      const at = Math.floor(rng() * (n + fade));
      const big = rng() < 0.07;
      const tau = (big ? 0.004 + rng() * 0.008 : 0.0004 + rng() * 0.0016) * sr;
      const amp = (big ? 0.6 : 0.16) * Math.pow(rng(), 2) + 0.02;
      const len = Math.min(Math.floor(tau * 6), n + fade - at);
      let lp = 0;
      const a = big ? 0.35 : 0.9;
      for (let i = 0; i < len; i++) {
        lp += a * (rng() * 2 - 1 - lp);
        tmp[at + i] += lp * amp * Math.exp(-i / tau);
      }
    }
    const d = buf.getChannelData(ch);
    wrapLoop(tmp, d, fade);
    normalise(d, 0.85);
  }
  return buf;
}

/** White noise with a 1/f amplitude envelope — rope fibres, luffing canvas. */
function fibrous(ctx: BaseAudioContext, seed: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const n = Math.floor(4 * sr);
  const fade = Math.floor(0.08 * sr);
  const buf = ctx.createBuffer(2, n, sr);
  for (let ch = 0; ch < 2; ch++) {
    const rng = makeRng(seed + ch * 15485863);
    const tmp = new Float32Array(n + fade);
    // Three octaves of slow amplitude wander multiplied together.
    let m1 = 0;
    let m2 = 0;
    let m3 = 0;
    for (let i = 0; i < n + fade; i++) {
      m1 += 0.0008 * (rng() * 2 - 1 - m1);
      m2 += 0.006 * (rng() * 2 - 1 - m2);
      m3 += 0.04 * (rng() * 2 - 1 - m3);
      const mod = 0.25 + Math.abs(m1 * 24 + m2 * 9 + m3 * 3.5);
      tmp[i] = (rng() * 2 - 1) * Math.min(2.2, mod);
    }
    const d = buf.getChannelData(ch);
    wrapLoop(tmp, d, fade);
    normalise(d, 0.9);
  }
  return buf;
}

export function createBuffers(ctx: BaseAudioContext): AudioBuffers {
  return {
    white: stereoNoise(ctx, 4, fillWhite, 0.01, 0.9, 0x5eed01),
    pink: stereoNoise(ctx, 5, fillPink, 0.03, 0.9, 0x5eed02),
    dark: stereoNoise(ctx, 6, fillBrown, 0.25, 0.9, 0x5eed03),
    patter: pattern(ctx, 0x5eed04),
    fibre: fibrous(ctx, 0x5eed05),
    irSea: makeIr(ctx, IR_SEA, 0x10),
    irDeck: makeIr(ctx, IR_DECK, 0x11),
    irCliff: makeIr(ctx, IR_CLIFF, 0x12),
    irMusic: makeIr(ctx, IR_MUSIC, 0x13),
  };
}
