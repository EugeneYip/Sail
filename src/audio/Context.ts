/**
 * Node factory, parameter helpers and autoplay handling.
 *
 * Two rules the rest of the module lives by:
 *  1. Every node is created through `Nodes`, so the live-node count is a fact we
 *     can assert on rather than a hope. Nothing in the graph is created after
 *     `Rig.build()` returns — one-shots reuse pooled, permanently-running
 *     sources gated by their envelope.
 *  2. No running parameter is ever assigned with `.value =`. Continuous values
 *     go through `Ramp` (setTargetAtTime with a dead-band so we do not spam the
 *     automation timeline), envelopes through the helpers at the bottom.
 */

export const dB = (db: number): number => Math.pow(10, db / 20);

/** Nodes created per-context, with a live count for leak assertions. */
export class Nodes {
  live = 0;
  created = 0;
  private all: AudioNode[] = [];

  constructor(readonly ctx: BaseAudioContext) {}

  private track<T extends AudioNode>(n: T): T {
    this.live++;
    this.created++;
    this.all.push(n);
    return n;
  }

  gain(v = 1): GainNode {
    const n = this.ctx.createGain();
    n.gain.value = v;
    return this.track(n);
  }

  biquad(type: BiquadFilterType, freq: number, q = 0.7071, gainDb = 0): BiquadFilterNode {
    const n = this.ctx.createBiquadFilter();
    n.type = type;
    n.frequency.value = freq;
    n.Q.value = q;
    n.gain.value = gainDb;
    return this.track(n);
  }

  /** A looping buffer source. Started once and never stopped — see rule 1. */
  loop(buffer: AudioBuffer, rate = 1, offset = -1): AudioBufferSourceNode {
    const n = this.ctx.createBufferSource();
    n.buffer = buffer;
    n.loop = true;
    n.playbackRate.value = rate;
    this.track(n);
    // Random phase so two voices on the same buffer are decorrelated.
    const off = offset < 0 ? Math.random() * buffer.duration : offset;
    n.start(0, off);
    return n;
  }

  osc(type: OscillatorType, freq: number): OscillatorNode {
    const n = this.ctx.createOscillator();
    n.type = type;
    n.frequency.value = freq;
    this.track(n);
    n.start(0);
    return n;
  }

  panner(refDistance = 12, rolloff = 1.1, hrtf = false): PannerNode {
    const n = this.ctx.createPanner();
    n.panningModel = hrtf ? 'HRTF' : 'equalpower';
    n.distanceModel = 'inverse';
    n.refDistance = refDistance;
    n.rolloffFactor = rolloff;
    n.maxDistance = 4000;
    n.coneInnerAngle = 360;
    n.positionX.value = 0;
    n.positionY.value = 2;
    n.positionZ.value = 0;
    return this.track(n);
  }

  stereoPan(v = 0): StereoPannerNode {
    const n = this.ctx.createStereoPanner();
    n.pan.value = v;
    return this.track(n);
  }

  delay(max: number, time: number): DelayNode {
    const n = this.ctx.createDelay(max);
    n.delayTime.value = time;
    return this.track(n);
  }

  convolver(ir: AudioBuffer): ConvolverNode {
    const n = this.ctx.createConvolver();
    // We normalise our own IRs, so the levels below are predictable.
    n.normalize = false;
    n.buffer = ir;
    return this.track(n);
  }

  compressor(threshold: number, knee: number, ratio: number, attack: number, release: number): DynamicsCompressorNode {
    const n = this.ctx.createDynamicsCompressor();
    n.threshold.value = threshold;
    n.knee.value = knee;
    n.ratio.value = ratio;
    n.attack.value = attack;
    n.release.value = release;
    return this.track(n);
  }

  shaper(curve: Float32Array<ArrayBuffer>, oversample: OverSampleType = '2x'): WaveShaperNode {
    const n = this.ctx.createWaveShaper();
    n.curve = curve;
    n.oversample = oversample;
    return this.track(n);
  }

  analyser(fftSize = 2048): AnalyserNode {
    const n = this.ctx.createAnalyser();
    n.fftSize = fftSize;
    n.smoothingTimeConstant = 0.4;
    return this.track(n);
  }

  worklet(name: string, options: AudioWorkletNodeOptions): AudioWorkletNode {
    return this.track(new AudioWorkletNode(this.ctx as AudioContext, name, options));
  }

  /** Disconnect everything and drop the references. */
  disposeAll(): void {
    for (const n of this.all) {
      try {
        n.disconnect();
        const src = n as AudioScheduledSourceNode;
        if (typeof src.stop === 'function') src.stop();
      } catch {
        /* already stopped or disconnected */
      }
    }
    this.live = 0;
    this.all.length = 0;
  }
}

/**
 * A smoothed parameter. `setTargetAtTime` every frame is the correct way to move
 * a running parameter, but it is also a main-thread cost and a timeline entry, so
 * skip the call when the target has not meaningfully moved.
 */
export class Ramp {
  private last = NaN;

  constructor(
    private readonly p: AudioParam,
    public tau = 0.12,
    private readonly eps = 5e-4,
  ) {}

  set(v: number, now: number): void {
    if (!Number.isFinite(v)) return;
    if (Math.abs(v - this.last) < this.eps) return;
    this.last = v;
    this.p.setTargetAtTime(v, now, this.tau);
  }

  /** Only legal before the graph is audible. */
  snap(v: number): void {
    this.p.value = v;
    this.last = v;
  }

  get value(): number {
    return this.p.value;
  }
}

/** A frequency ramp: 1 Hz dead-band, since nobody hears 1 Hz of cutoff drift. */
export const freqRamp = (p: AudioParam, tau = 0.15): Ramp => new Ramp(p, tau, 1);

/** Smoothed panner position with a 5 cm dead-band. */
export class PanRamp {
  private readonly x: Ramp;
  private readonly y: Ramp;
  private readonly z: Ramp;

  constructor(pan: PannerNode, tau = 0.06) {
    this.x = new Ramp(pan.positionX, tau, 0.05);
    this.y = new Ramp(pan.positionY, tau, 0.05);
    this.z = new Ramp(pan.positionZ, tau, 0.05);
  }

  set(p: { x: number; y: number; z: number }, now: number): void {
    this.x.set(p.x, now);
    this.y.set(p.y, now);
    this.z.set(p.z, now);
  }
}

/* ------------------------------------------------------------------ *
 *  Envelopes — used by pooled voices, always on a silent gain
 * ------------------------------------------------------------------ */

const FLOOR = 1e-4;

/**
 * Percussive envelope: linear attack then exponential decay to silence.
 * `cancelScheduledValues` + an explicit start value is what keeps a retriggered
 * voice from stepping (and therefore clicking).
 */
export function strike(
  g: AudioParam,
  t0: number,
  peak: number,
  attack: number,
  decay: number,
  hold = 0,
): void {
  const p = Math.max(FLOOR * 2, peak);
  g.cancelScheduledValues(t0);
  g.setValueAtTime(FLOOR, t0);
  g.linearRampToValueAtTime(p, t0 + attack);
  if (hold > 0) g.setValueAtTime(p, t0 + attack + hold);
  g.exponentialRampToValueAtTime(FLOOR, t0 + attack + hold + decay);
  g.setValueAtTime(0, t0 + attack + hold + decay + 0.001);
}

/** Swelling envelope for whooshes, blows and bowed notes. */
export function swell(
  g: AudioParam,
  t0: number,
  peak: number,
  attack: number,
  hold: number,
  release: number,
): void {
  const p = Math.max(FLOOR * 2, peak);
  g.cancelScheduledValues(t0);
  g.setValueAtTime(FLOOR, t0);
  g.exponentialRampToValueAtTime(p, t0 + attack);
  g.setValueAtTime(p, t0 + attack + hold);
  g.exponentialRampToValueAtTime(FLOOR, t0 + attack + hold + release);
  g.setValueAtTime(0, t0 + attack + hold + release + 0.001);
}

/** Sweep a filter while the voice is still silent, then glide it. */
export function sweep(p: AudioParam, t0: number, from: number, to: number, dur: number): void {
  p.cancelScheduledValues(t0);
  p.setValueAtTime(Math.max(20, from), t0);
  p.exponentialRampToValueAtTime(Math.max(20, to), t0 + Math.max(0.01, dur));
}

/* ------------------------------------------------------------------ *
 *  Autoplay
 * ------------------------------------------------------------------ */

interface NavExt {
  getAutoplayPolicy?: (type: string) => string;
  userActivation?: { hasBeenActive: boolean; isActive: boolean };
}

/**
 * True when an `AudioContext` may be constructed without emitting Chrome's
 * "was not allowed to start" console warning. We deliberately do not construct
 * one to find out — construction while blocked is exactly what logs the warning.
 */
export function autoplayAllowed(): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as NavExt;
  if (nav.userActivation?.hasBeenActive) return true;
  if (typeof nav.getAutoplayPolicy === 'function') {
    try {
      if (nav.getAutoplayPolicy('audiocontext') === 'allowed') return true;
    } catch {
      /* not supported for this argument */
    }
  }
  return false;
}

const GESTURES = ['pointerdown', 'mousedown', 'touchstart', 'keydown'] as const;

/** Run `fn` once, on the first real user gesture. Returns a detach function. */
export function onFirstGesture(fn: () => void): () => void {
  let done = false;
  const handler = (): void => {
    if (done) return;
    done = true;
    detach();
    fn();
  };
  const detach = (): void => {
    for (const g of GESTURES) removeEventListener(g, handler, true);
  };
  for (const g of GESTURES) addEventListener(g, handler, { capture: true, passive: true });
  return detach;
}
