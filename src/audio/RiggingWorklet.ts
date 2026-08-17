import type { AudioBuffers } from './Buffers';
import { freqRamp, Nodes, Ramp } from './Context';

/**
 * Wind in the standing rigging — the signature sound of a square-rigger, and the
 * one thing worth per-sample synthesis.
 *
 * Physics: a taut line in a cross-flow sheds vortices at the Strouhal frequency
 * f = St*U/d (St ~= 0.2). When that lands near a natural mode of the line, the
 * two lock in and the line sings at that mode. So: a bank of very narrow
 * resonators, excited by broadband turbulence, whose centre frequencies rise
 * linearly with wind speed but snap to each line's harmonic series, and whose Q
 * climbs with wind speed. Light air gives a quiet, breathy hum; a gale gives the
 * moaning shriek you can hear through a hull.
 *
 * The resonators are harmonically unrelated ACROSS lines (each line has its own
 * diameter and fundamental) which is what stops the bank sounding like a chord.
 *
 * The worklet source is inlined and registered from a Blob URL — no extra file
 * to fetch, and it degrades to a BiquadFilterNode bank if AudioWorklet is
 * unavailable.
 */
const RIGGING_SRC = `
const ST = 0.2;              // Strouhal number for a circular cylinder
const LOCKIN = 0.18;         // fractional bandwidth over which the line locks in

class RiggingProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'wind',   defaultValue: 6,  minValue: 0, maxValue: 90, automationRate: 'k-rate' },
      { name: 'level',  defaultValue: 0,  minValue: 0, maxValue: 6,  automationRate: 'k-rate' },
      { name: 'shriek', defaultValue: 0,  minValue: 0, maxValue: 1,  automationRate: 'k-rate' },
      { name: 'damp',   defaultValue: 0,  minValue: 0, maxValue: 1,  automationRate: 'k-rate' },
    ];
  }

  constructor(options) {
    super();
    const opt = (options && options.processorOptions) || {};
    const count = opt.strings || 16;
    let seed = (opt.seed || 12345) >>> 0;
    const rnd = () => {
      seed = (seed + 0x6d2b79f5) >>> 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    this.nz = seed | 7;
    this.lines = [];
    for (let i = 0; i < count; i++) {
      const u = i / Math.max(1, count - 1);
      // Tarred hemp: 10 mm signal halyards up to 36 mm lower shrouds.
      const dia = 0.009 + 0.027 * Math.pow(u, 1.25);
      // Fundamental of the line itself. Thicker, longer lines sit lower.
      const f1 = 26 + 96 * (1 - u) * (0.7 + 0.6 * rnd());
      this.lines.push({
        dia,
        f1,
        pan: (rnd() * 2 - 1) * 0.85,
        trim: 0.5 + 0.5 * rnd(),
        wob: rnd() * 6.283,
        wobRate: 0.05 + 0.22 * rnd(),
        amp: 0,
        y1: 0,
        y2: 0,
        a: 0,
        b1: 0,
        b2: 0,
      });
    }
    this.dcL = 0;
    this.dcR = 0;
    this.t = 0;
    this.dead = false;
    this.port && (this.port.onmessage = (e) => { if (e.data === 'stop') this.dead = true; });
  }

  noise() {
    // xorshift32 -> [-1,1)
    let x = this.nz;
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5; x >>>= 0;
    this.nz = x;
    return x / 2147483648 - 1;
  }

  process(_inputs, outputs, params) {
    const out = outputs[0];
    const L = out[0];
    const R = out.length > 1 ? out[1] : out[0];
    const n = L.length;
    const U = params.wind[0];
    const level = params.level[0];
    const shriek = params.shriek[0];
    const damp = params.damp[0];

    if (this.dead) return false;
    if (level <= 0.00005 || U < 1.2) {
      for (let i = 0; i < n; i++) { L[i] = 0; if (R !== L) R[i] = 0; }
      this.t += n / sampleRate;
      return true;
    }

    const sr = sampleRate;
    const lines = this.lines;
    // Excitation grows with dynamic pressure; nothing sings below a light breeze.
    const drive = Math.pow(Math.max(0, U - 2.2) / 11, 1.9);
    // Coherence: in a gale the shedding is strong and the line rings hard.
    const q = (14 + 210 * Math.min(1, Math.max(0, (U - 5) / 19)) + 120 * shriek) * (1 - 0.55 * damp);
    this.t += n / sr;

    for (let k = 0; k < lines.length; k++) {
      const ln = lines[k];
      // Slow wander so the song breathes instead of sitting still.
      const wob = 1 + 0.06 * Math.sin(this.t * 6.283 * ln.wobRate + ln.wob);
      let f = ST * U * wob / ln.dia;
      // Lock-in: snap toward the nearest mode of the line.
      const mode = Math.max(1, Math.round(f / ln.f1));
      const target = mode * ln.f1;
      if (Math.abs(f - target) < target * LOCKIN) f += (target - f) * 0.8;
      f = Math.min(sr * 0.44, Math.max(22, f));

      const bw = Math.max(0.6, f / q);
      const r = Math.exp((-Math.PI * bw) / sr);
      const theta = (2 * Math.PI * f) / sr;
      ln.b1 = 2 * r * Math.cos(theta);
      ln.b2 = r * r;
      ln.a = (1 - r * r) * Math.sin(theta) * 0.5;
      ln.amp = drive * ln.trim * level;
    }

    for (let i = 0; i < n; i++) {
      let l = 0;
      let rr = 0;
      const e1 = this.noise();
      const e2 = this.noise();
      for (let k = 0; k < lines.length; k++) {
        const ln = lines[k];
        const x = (k & 1) === 0 ? e1 : e2;
        const y = ln.a * x + ln.b1 * ln.y1 - ln.b2 * ln.y2;
        ln.y2 = ln.y1;
        ln.y1 = y;
        const v = y * ln.amp;
        l += v * (1 - ln.pan) * 0.5;
        rr += v * (1 + ln.pan) * 0.5;
      }
      // DC block, then a soft ceiling: high-Q resonators must never be able to
      // hand the graph a spike.
      this.dcL += 0.0004 * (l - this.dcL);
      this.dcR += 0.0004 * (rr - this.dcR);
      L[i] = Math.tanh((l - this.dcL) * 1.4) * 0.7;
      if (R !== L) R[i] = Math.tanh((rr - this.dcR) * 1.4) * 0.7;
    }
    return true;
  }
}

registerProcessor('rigging', RiggingProcessor);
`;

const registered = new WeakMap<BaseAudioContext, Promise<boolean>>();

/** Register the worklet once per context. Never throws. */
export function registerRigging(ctx: BaseAudioContext): Promise<boolean> {
  const existing = registered.get(ctx);
  if (existing) return existing;
  const p = (async () => {
    if (typeof AudioWorkletNode === 'undefined' || !ctx.audioWorklet) return false;
    let url = '';
    try {
      url = URL.createObjectURL(new Blob([RIGGING_SRC], { type: 'text/javascript' }));
      await ctx.audioWorklet.addModule(url);
      return true;
    } catch {
      return false;
    } finally {
      if (url) URL.revokeObjectURL(url);
    }
  })();
  registered.set(ctx, p);
  return p;
}

export interface RiggingParams {
  wind: number;
  level: number;
  shriek: number;
  damp: number;
}

/**
 * The resonator bank. Uses the worklet when available; otherwise an eight-strong
 * BiquadFilterNode bandpass bank driven from the shared white-noise loop, which
 * is the same idea at lower resolution (fixed Q ceiling, no lock-in snapping).
 */
export class RiggingBank {
  readonly usesWorklet: boolean;
  private worklet: AudioWorkletNode | null = null;
  private pWind: AudioParam | null = null;
  private pLevel: AudioParam | null = null;
  private pShriek: AudioParam | null = null;
  private pDamp: AudioParam | null = null;
  private rWind: Ramp | null = null;
  private rLevel: Ramp | null = null;
  private rShriek: Ramp | null = null;
  private rDamp: Ramp | null = null;
  private fbFreq: Ramp[] = [];
  private fbQ: Ramp[] = [];
  private fbGain: Ramp[] = [];
  private fbDia: number[] = [];
  private fbF1: number[] = [];

  constructor(nodes: Nodes, buffers: AudioBuffers, out: AudioNode, workletReady: boolean) {
    this.usesWorklet = workletReady;
    if (workletReady) {
      const node = nodes.worklet('rigging', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: { strings: 16, seed: 0x5a11 },
      });
      node.connect(out);
      this.worklet = node;
      this.pWind = node.parameters.get('wind') ?? null;
      this.pLevel = node.parameters.get('level') ?? null;
      this.pShriek = node.parameters.get('shriek') ?? null;
      this.pDamp = node.parameters.get('damp') ?? null;
      if (this.pWind) this.rWind = new Ramp(this.pWind, 0.35, 0.02);
      if (this.pLevel) this.rLevel = new Ramp(this.pLevel, 0.4, 2e-4);
      if (this.pShriek) this.rShriek = new Ramp(this.pShriek, 0.6, 2e-3);
      if (this.pDamp) this.rDamp = new Ramp(this.pDamp, 1.5, 2e-3);
      return;
    }

    const src = nodes.loop(buffers.white, 1.0);
    for (let i = 0; i < 8; i++) {
      const u = i / 7;
      this.fbDia.push(0.009 + 0.027 * Math.pow(u, 1.25));
      this.fbF1.push(26 + 96 * (1 - u));
      const bp = nodes.biquad('bandpass', 200, 30);
      const g = nodes.gain(0.0001);
      const pan = nodes.stereoPan((u * 2 - 1) * 0.8);
      src.connect(bp);
      bp.connect(g);
      g.connect(pan);
      pan.connect(out);
      this.fbFreq.push(freqRamp(bp.frequency, 0.3));
      this.fbQ.push(new Ramp(bp.Q, 0.5, 0.5));
      this.fbGain.push(new Ramp(g.gain, 0.4, 2e-4));
    }
  }

  set(p: RiggingParams, now: number): void {
    if (this.worklet) {
      this.rWind?.set(p.wind, now);
      this.rLevel?.set(p.level, now);
      this.rShriek?.set(p.shriek, now);
      this.rDamp?.set(p.damp, now);
      return;
    }
    const drive = Math.pow(Math.max(0, p.wind - 2.2) / 11, 1.9);
    const q = (14 + 210 * Math.min(1, Math.max(0, (p.wind - 5) / 19)) + 120 * p.shriek) * (1 - 0.55 * p.damp);
    for (let i = 0; i < this.fbFreq.length; i++) {
      let f = (0.2 * p.wind) / this.fbDia[i];
      const mode = Math.max(1, Math.round(f / this.fbF1[i]));
      const target = mode * this.fbF1[i];
      if (Math.abs(f - target) < target * 0.18) f += (target - f) * 0.8;
      this.fbFreq[i].set(Math.min(9000, Math.max(22, f)), now);
      this.fbQ[i].set(Math.min(220, q), now);
      // A biquad bandpass has unity peak gain, so compensate for the narrow band.
      this.fbGain[i].set(drive * p.level * 0.55, now);
    }
  }

  dispose(): void {
    this.worklet?.port.postMessage('stop');
  }
}
