import { DECLICK_S, envDuration, LEAD_S, Nodes, strike, swell, sweep } from './Context';

/**
 * Pooled one-shot voices.
 *
 * The pool never creates a node after init. Each pool owns two permanently
 * looping noise sources (brown + white) shared by all its voices; a "one-shot"
 * re-tunes a voice's filters while its envelope gain is at zero, then opens the
 * envelope. That is what keeps node creation off the main thread entirely and
 * makes the live node count constant — see scripts/audio-test.mjs.
 *
 * Requests are filled into a single reusable struct (`begin()`) rather than an
 * object literal, because allocating per creak in a gale is exactly the kind of
 * garbage that shows up as a frame hitch.
 */
export interface NoiseRequest {
  /** Absolute context time to start. */
  t: number;
  gain: number;
  attack: number;
  decay: number;
  hold: number;
  /** Mix of the brown and white sources, 0..1 each. */
  low: number;
  high: number;
  type: BiquadFilterType;
  freq: number;
  /** Sweep destination; equal to `freq` for no sweep. */
  freqTo: number;
  sweepTime: number;
  q: number;
  r1f: number;
  r1q: number;
  r1db: number;
  r2f: number;
  r2q: number;
  r2db: number;
  x: number;
  y: number;
  z: number;
  /** Use a swelling (whoosh) envelope instead of a percussive one. */
  soft: boolean;
}

interface NoiseVoice {
  lowGain: GainNode;
  highGain: GainNode;
  bp: BiquadFilterNode;
  r1: BiquadFilterNode;
  r2: BiquadFilterNode;
  env: GainNode;
  pan: PannerNode;
  busyUntil: number;
}

export class NoisePool {
  private readonly voices: NoiseVoice[] = [];
  private readonly req: NoiseRequest = {
    t: 0,
    gain: 0.2,
    attack: 0.004,
    decay: 0.3,
    hold: 0,
    low: 0.5,
    high: 0.5,
    type: 'bandpass',
    freq: 600,
    freqTo: 600,
    sweepTime: 0.2,
    q: 1.2,
    r1f: 0,
    r1q: 6,
    r1db: 0,
    r2f: 0,
    r2q: 6,
    r2db: 0,
    x: 0,
    y: 2,
    z: 0,
    soft: false,
  };
  private cursor = 0;

  constructor(
    nodes: Nodes,
    count: number,
    dark: AudioBuffer,
    white: AudioBuffer,
    out: AudioNode,
    hrtf: boolean,
    refDistance = 14,
  ) {
    const darkSrc = nodes.loop(dark);
    const whiteSrc = nodes.loop(white);
    for (let i = 0; i < count; i++) {
      const lowGain = nodes.gain(0);
      const highGain = nodes.gain(0);
      const bp = nodes.biquad('bandpass', 600, 1.2);
      const r1 = nodes.biquad('peaking', 400, 6, 0);
      const r2 = nodes.biquad('peaking', 900, 6, 0);
      const env = nodes.gain(0);
      const pan = nodes.panner(refDistance, 1.05, hrtf);
      darkSrc.connect(lowGain);
      whiteSrc.connect(highGain);
      lowGain.connect(bp);
      highGain.connect(bp);
      bp.connect(r1);
      r1.connect(r2);
      r2.connect(env);
      env.connect(pan);
      pan.connect(out);
      this.voices.push({ lowGain, highGain, bp, r1, r2, env, pan, busyUntil: 0 });
    }
  }

  /** Reset and return the shared request struct. */
  begin(t: number): NoiseRequest {
    const r = this.req;
    r.t = t;
    r.gain = 0.2;
    r.attack = 0.004;
    r.decay = 0.3;
    r.hold = 0;
    r.low = 0.5;
    r.high = 0.5;
    r.type = 'bandpass';
    r.freq = 600;
    r.freqTo = 600;
    r.sweepTime = 0.2;
    r.q = 1.2;
    r.r1f = 0;
    r.r1q = 6;
    r.r1db = 0;
    r.r2f = 0;
    r.r2q = 6;
    r.r2db = 0;
    r.x = 0;
    r.y = 2;
    r.z = 0;
    r.soft = false;
    return r;
  }

  /**
   * Play the pending request into a voice that is already silent, or drop it.
   *
   * It USED to steal the voice finishing soonest, which restarted an envelope
   * mid-decay and stepped its gain to the floor. That is the loudest click this
   * module can produce, it fired several times a second in any real sea, and it
   * is the measured cause of the reported popping — `scripts/audio-test.mjs`
   * counts 5.1 discontinuities/s on the ship bus with stealing enabled and none
   * without. A dropped creak is silence; a stolen one is a bang.
   *
   * `busyUntil <= now` (not `<= t`) is deliberate: `v.bp.type` below is a plain
   * property, not an `AudioParam`, so it cannot be scheduled and takes effect the
   * instant this runs. Only a voice that is ALREADY silent may be retuned.
   */
  fire(now: number): boolean {
    const r = this.req;
    if (!(r.gain > 1e-4) || !Number.isFinite(r.t)) return false;

    let best = -1;
    for (let i = 0; i < this.voices.length; i++) {
      const idx = (this.cursor + i) % this.voices.length;
      if (this.voices[idx].busyUntil <= now) {
        best = idx;
        break;
      }
    }
    if (best < 0) return false;
    this.cursor = (best + 1) % this.voices.length;
    const v = this.voices[best];
    // Never in the past: see LEAD_S. An envelope scheduled behind the audio
    // thread's render position executes as a step, attack and all.
    const t = Math.max(r.t, now + LEAD_S);
    const attack = Math.max(r.soft ? 0.01 : 0.001, r.attack);
    v.busyUntil = t + envDuration(attack, r.hold, r.decay);
    // The envelope is at its floor from `te` onward, so retuning there is silent.
    const te = t + DECLICK_S;

    v.lowGain.gain.setValueAtTime(r.low, te);
    v.highGain.gain.setValueAtTime(r.high, te);
    v.bp.type = r.type;
    v.bp.Q.setValueAtTime(r.q, te);
    if (Math.abs(r.freqTo - r.freq) > 1) {
      sweep(v.bp.frequency, te, r.freq, r.freqTo, r.sweepTime > 0 ? r.sweepTime : r.decay);
    } else {
      v.bp.frequency.setValueAtTime(Math.max(20, r.freq), te);
    }
    v.r1.frequency.setValueAtTime(Math.max(20, r.r1f || 400), te);
    v.r1.Q.setValueAtTime(r.r1q, te);
    v.r1.gain.setValueAtTime(r.r1f > 0 ? r.r1db : 0, te);
    v.r2.frequency.setValueAtTime(Math.max(20, r.r2f || 900), te);
    v.r2.Q.setValueAtTime(r.r2q, te);
    v.r2.gain.setValueAtTime(r.r2f > 0 ? r.r2db : 0, te);
    v.pan.positionX.setValueAtTime(r.x, te);
    v.pan.positionY.setValueAtTime(r.y, te);
    v.pan.positionZ.setValueAtTime(r.z, te);

    if (r.soft) swell(v.env.gain, t, r.gain, attack, r.hold, r.decay);
    else strike(v.env.gain, t, r.gain, attack, r.decay, r.hold);
    return true;
  }

  /** How many voices are free right now — lets callers skip cheap extras. */
  free(now: number): number {
    let c = 0;
    for (const v of this.voices) if (v.busyUntil <= now) c++;
    return c;
  }
}

/* ------------------------------------------------------------------ *
 *  Tonal voices: gull cries, hails, bosun's calls, dolphin whistles
 * ------------------------------------------------------------------ */

export interface ToneRequest {
  t: number;
  gain: number;
  /** Pitch contour, Hz. */
  f0: number;
  f1: number;
  f2: number;
  attack: number;
  hold: number;
  decay: number;
  /** Sawtooth (voiced, harsh) vs sine (whistle) balance, 0..1. */
  buzz: number;
  /** Breath noise amount. */
  breath: number;
  /** Formant 1/2 centres and Q. */
  fmt1: number;
  fmt2: number;
  fmtQ: number;
  /** Vibrato/trill depth in cents and rate in Hz. */
  vibrato: number;
  vibratoHz: number;
  x: number;
  y: number;
  z: number;
}

interface ToneVoice {
  saw: OscillatorNode;
  sine: OscillatorNode;
  sawGain: GainNode;
  sineGain: GainNode;
  breath: GainNode;
  f1: BiquadFilterNode;
  f2: BiquadFilterNode;
  env: GainNode;
  pan: PannerNode;
  lfo: OscillatorNode;
  lfoGain: GainNode;
  busyUntil: number;
}

export class TonePool {
  private readonly voices: ToneVoice[] = [];
  private readonly req: ToneRequest = {
    t: 0,
    gain: 0.1,
    f0: 900,
    f1: 1400,
    f2: 700,
    attack: 0.02,
    hold: 0.06,
    decay: 0.2,
    buzz: 0.6,
    breath: 0.2,
    fmt1: 1600,
    fmt2: 3000,
    fmtQ: 5,
    vibrato: 0,
    vibratoHz: 6,
    x: 0,
    y: 8,
    z: 0,
  };
  private cursor = 0;

  constructor(nodes: Nodes, count: number, white: AudioBuffer, out: AudioNode) {
    const whiteSrc = nodes.loop(white);
    for (let i = 0; i < count; i++) {
      const saw = nodes.osc('sawtooth', 900);
      const sine = nodes.osc('sine', 900);
      const sawGain = nodes.gain(0);
      const sineGain = nodes.gain(0);
      const breath = nodes.gain(0);
      const f1 = nodes.biquad('bandpass', 1600, 5);
      const f2 = nodes.biquad('peaking', 3000, 4, 6);
      const env = nodes.gain(0);
      const pan = nodes.panner(20, 1.0, true);
      const lfo = nodes.osc('sine', 6);
      const lfoGain = nodes.gain(0);
      lfo.connect(lfoGain);
      lfoGain.connect(saw.frequency);
      lfoGain.connect(sine.frequency);
      saw.connect(sawGain);
      sine.connect(sineGain);
      whiteSrc.connect(breath);
      sawGain.connect(f1);
      sineGain.connect(f1);
      breath.connect(f1);
      f1.connect(f2);
      f2.connect(env);
      env.connect(pan);
      pan.connect(out);
      this.voices.push({
        saw,
        sine,
        sawGain,
        sineGain,
        breath,
        f1,
        f2,
        env,
        pan,
        lfo,
        lfoGain,
        busyUntil: 0,
      });
    }
  }

  begin(t: number): ToneRequest {
    const r = this.req;
    r.t = t;
    r.gain = 0.1;
    r.f0 = 900;
    r.f1 = 1400;
    r.f2 = 700;
    r.attack = 0.02;
    r.hold = 0.06;
    r.decay = 0.2;
    r.buzz = 0.6;
    r.breath = 0.2;
    r.fmt1 = 1600;
    r.fmt2 = 3000;
    r.fmtQ = 5;
    r.vibrato = 0;
    r.vibratoHz = 6;
    r.x = 0;
    r.y = 8;
    r.z = 0;
    return r;
  }

  fire(now: number): boolean {
    const r = this.req;
    if (!(r.gain > 1e-4)) return false;
    let best = -1;
    for (let i = 0; i < this.voices.length; i++) {
      const idx = (this.cursor + i) % this.voices.length;
      if (this.voices[idx].busyUntil <= now) {
        best = idx;
        break;
      }
    }
    if (best < 0) return false;
    this.cursor = (best + 1) % this.voices.length;
    const v = this.voices[best];
    const t = Math.max(r.t, now + LEAD_S);
    const attack = Math.max(0.01, r.attack);
    const dur = attack + r.hold + r.decay;
    v.busyUntil = t + envDuration(attack, r.hold, r.decay);
    const te = t + DECLICK_S;

    // Pitch contour: rise into the syllable, fall away. Set at `te`, where the
    // envelope is at its floor, so the jump onto the contour is inaudible.
    for (const p of [v.saw.frequency, v.sine.frequency]) {
      p.cancelScheduledValues(te);
      p.setValueAtTime(Math.max(30, r.f0), te);
      p.exponentialRampToValueAtTime(Math.max(30, r.f1), te + attack + r.hold * 0.6);
      p.exponentialRampToValueAtTime(Math.max(30, r.f2), te + dur);
    }
    v.lfo.frequency.setValueAtTime(r.vibratoHz, te);
    v.lfoGain.gain.setValueAtTime(r.vibrato, te);
    v.sawGain.gain.setValueAtTime(r.buzz * 0.5, te);
    v.sineGain.gain.setValueAtTime((1 - r.buzz) * 0.5, te);
    v.breath.gain.setValueAtTime(r.breath, te);
    v.f1.frequency.setValueAtTime(r.fmt1, te);
    v.f1.Q.setValueAtTime(r.fmtQ, te);
    v.f2.frequency.setValueAtTime(r.fmt2, te);
    v.pan.positionX.setValueAtTime(r.x, te);
    v.pan.positionY.setValueAtTime(r.y, te);
    v.pan.positionZ.setValueAtTime(r.z, te);
    swell(v.env.gain, t, r.gain, attack, r.hold, r.decay);
    return true;
  }
}
