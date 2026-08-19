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

/**
 * Every scheduled event is placed this far ahead of `ctx.currentTime`.
 *
 * `currentTime` is the START of the last block handed to the audio thread, and
 * the thread has already rendered some way past it. An event scheduled at
 * `currentTime + 2 ms` therefore lands in the PAST, and a `setValueAtTime` in
 * the past is applied at the next sample the thread renders — so a 4 ms attack
 * ramp collapses into a step, which is a click. 55 ms clears a 128-sample
 * quantum, a 60 fps frame and a typical 'interactive' output buffer, and it is
 * far below the ~150 ms at which a delay in an ambient bed becomes noticeable.
 *
 * It also makes a main-thread stall degrade correctly: if a frame arrives 120 ms
 * late, the ramp the PREVIOUS frame scheduled is already running, so the
 * parameter glides on toward a slightly stale target instead of stepping.
 */
export const LEAD_S = 0.055;

/**
 * The only legal way to turn a frame time into an event time.
 *
 * `delay` is how far after "now" the event is wanted — a jitter, a syllable gap,
 * a flash-to-bang delay. The lead is added on top, so a caller cannot express an
 * event with insufficient lead even by accident, and the jitter it asked for
 * survives instead of being flattened by a downstream clamp.
 */
export function eventTime(now: number, delay = 0): number {
  return now + LEAD_S + (delay > 0 ? delay : 0);
}

/**
 * Shortfalls caught by the pools' backstop clamp, plus what the LIVE context
 * turns out to need.
 *
 * `late`/`worstLeadS`: every pool re-checks the lead before it schedules, because
 * being wrong here is inaudible in the offline render and a click in the game. If
 * `late` is ever non-zero, some caller computed an event time without
 * `eventTime()` and this is the proof: `scripts/audio-test.mjs` asserts on it.
 * `worstLeadS` is the smallest lead any caller asked for.
 *
 * The rest closes the hole `late` cannot see. `late` only proves the code asked
 * for LEAD_S; it cannot prove LEAD_S is *enough*, because that depends on how far
 * past `currentTime` this device's audio thread has already rendered — a quantity
 * an `OfflineAudioContext` does not have. `AudioEngine` fills these in from the
 * running context every frame (see `observeLead`) so the constant is checked
 * against the hardware instead of against itself:
 *
 *   renderQuantumS  ctx.baseLatency — how far ahead the thread renders
 *   frameGapS       the longest gap between two frames, i.e. how stale a value
 *                   may get before the next update arrives
 *   needLeadS       what LEAD_S would have to be on this device
 *   shortfall       frames where needLeadS exceeded LEAD_S. Must stay 0.
 */
export const schedule = {
  late: 0,
  worstLeadS: Infinity,
  renderQuantumS: 0,
  frameGapS: 0,
  needLeadS: 0,
  shortfall: 0,
};

/**
 * Safety factor on the observed render-ahead. Three quanta: the one being
 * rendered, the one the thread has already started, and one for jitter.
 */
const QUANTA_OF_MARGIN = 3;

/**
 * Record what the live context needs, and count it if LEAD_S is not enough.
 *
 * `gap` is this frame's `currentTime` minus the previous frame's, so a stall
 * shows up here as the largest gap. A late frame does not by itself produce a
 * late event — it reads a fresh `currentTime` and still schedules LEAD_S ahead of
 * it — so the gap is charged as staleness, not as lead. What must be covered is
 * the render-ahead plus jitter.
 */
export function observeLead(baseLatency: number, gap: number): void {
  const quantum = Number.isFinite(baseLatency) && baseLatency > 0 ? baseLatency : 128 / 48000;
  if (quantum > schedule.renderQuantumS) schedule.renderQuantumS = quantum;
  if (Number.isFinite(gap) && gap > schedule.frameGapS) schedule.frameGapS = gap;
  const need = QUANTA_OF_MARGIN * quantum;
  if (need > schedule.needLeadS) schedule.needLeadS = need;
  if (need > LEAD_S) schedule.shortfall++;
}

/** Clamp an event time to the minimum lead, recording the shortfall. */
export function notBefore(t: number, now: number): number {
  const floor = now + LEAD_S;
  if (!(t >= floor)) {
    const lead = t - now;
    if (lead < schedule.worstLeadS) schedule.worstLeadS = lead;
    schedule.late++;
    return floor;
  }
  return t;
}

/**
 * A retriggered envelope is faded to silence over this long first. Without it,
 * restarting a voice that is still sounding steps its gain straight to the floor
 * — the single loudest click this module can make.
 */
export const DECLICK_S = 0.006;

/**
 * Cancel future automation while keeping the value continuous.
 *
 * `cancelScheduledValues` alone leaves the parameter wherever the cancelled
 * curve had reached and the next `setValueAtTime` steps away from it.
 * `cancelAndHoldAtTime` is the primitive that exists for precisely this; the
 * fallback reads the live value, which is close enough when `t` is one lead
 * ahead.
 */
export function holdParam(p: AudioParam, t: number): void {
  const ext = p as AudioParam & { cancelAndHoldAtTime?: (when: number) => void };
  if (typeof ext.cancelAndHoldAtTime === 'function') {
    ext.cancelAndHoldAtTime(t);
    return;
  }
  const v = p.value;
  p.cancelScheduledValues(t);
  p.setValueAtTime(Number.isFinite(v) ? v : 0, t);
}

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
    this.p.setTargetAtTime(v, eventTime(now), this.tau);
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
 * Percussive envelope: a `DECLICK_S` fade to silence, then linear attack and
 * exponential decay. The fade is what makes the envelope safe to schedule on a
 * parameter that is still moving — it leaves the curve continuous instead of
 * stepping to the floor, which is the classic retrigger click.
 *
 * Audible sound starts at `t0 + DECLICK_S`; `envDuration` gives the total.
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
  const a = t0 + DECLICK_S;
  holdParam(g, t0);
  g.linearRampToValueAtTime(FLOOR, a);
  g.linearRampToValueAtTime(p, a + attack);
  if (hold > 0) g.setValueAtTime(p, a + attack + hold);
  g.exponentialRampToValueAtTime(FLOOR, a + attack + hold + decay);
  g.linearRampToValueAtTime(0, a + attack + hold + decay + DECLICK_S);
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
  const a = t0 + DECLICK_S;
  holdParam(g, t0);
  g.linearRampToValueAtTime(FLOOR, a);
  g.exponentialRampToValueAtTime(p, a + attack);
  g.setValueAtTime(p, a + attack + hold);
  g.exponentialRampToValueAtTime(FLOOR, a + attack + hold + release);
  g.linearRampToValueAtTime(0, a + attack + hold + release + DECLICK_S);
}

/** Wall-clock length of a `strike`/`swell`, including both de-click fades. */
export function envDuration(attack: number, hold: number, decay: number): number {
  return 2 * DECLICK_S + attack + hold + decay;
}

/**
 * Sweep a filter. Called at the moment the envelope is at its floor, so the jump
 * to `from` is inaudible; the glide after it is what the ear hears.
 */
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
