import { makeRng } from '../util/math';
import { ANCHOR, anchorWorld } from './Anchors';
import type { AudioBuffers } from './Buffers';
import type { Bus } from './Buses';
import { dB, eventTime, notBefore, Nodes, PanRamp, strike } from './Context';
import type { SimView } from './Sim';

/**
 * The ship's bell, struck for the watch.
 *
 * Physical model rather than a sample: a bell is a handful of INHARMONIC partials
 * with wildly different decay rates — the hum note rings for seconds while the
 * upper partials are gone in half of one. The nominal is deliberately a detuned
 * pair, because real bells have doublet modes and the resulting slow beat is
 * most of what makes a bell sound like metal instead of an organ.
 *
 * Ratios are the classic bell set: hum, prime, minor tierce, quint, nominal,
 * superquint. The perceived strike note is the nominal, an octave above prime.
 */
const PARTIALS: readonly { ratio: number; gain: number; tau: number }[] = [
  { ratio: 0.5, gain: 0.5, tau: 2.7 },
  { ratio: 1.0, gain: 0.75, tau: 1.9 },
  { ratio: 1.19, gain: 0.42, tau: 1.2 },
  { ratio: 1.5, gain: 0.3, tau: 0.8 },
  { ratio: 2.0, gain: 1.0, tau: 1.6 },
  { ratio: 2.0056, gain: 0.85, tau: 1.5 },
  { ratio: 2.61, gain: 0.22, tau: 0.35 },
];

/** Longest partial, times a margin: how long a struck voice stays unavailable. */
const RING_S = 2.7 * 1.15 + 0.05;

/** Prime of the ship's bell, Hz. Strike note is heard an octave up. */
const BELL_PRIME_HZ = 540;

/**
 * Five, because the watch is struck in pairs 0.34 s apart with 0.86 s between
 * pairs, so up to five bells are ringing at once. A sixth strike used to steal a
 * ringing voice and restart its envelope, which turned eight bells into eight
 * bells and five cracks.
 */
const VOICES = 5;

interface BellVoice {
  oscs: OscillatorNode[];
  gains: GainNode[];
  clapper: GainNode;
  out: GainNode;
  busyUntil: number;
}

export class Bell {
  private readonly rng = makeRng(0xbe11);
  private readonly voices: BellVoice[] = [];
  private readonly pan: PanRamp;
  private cursor = 0;
  private lastHalfHour = -1;
  private lastNow = 0;

  constructor(nodes: Nodes, buffers: AudioBuffers, bus: Bus) {
    const white = nodes.loop(buffers.white, 1.0);
    const pan = nodes.panner(16, 1.0, true);
    pan.connect(bus.in);
    this.pan = new PanRamp(pan, 0.1);

    for (let v = 0; v < VOICES; v++) {
      const out = nodes.gain(1);
      out.connect(pan);
      const oscs: OscillatorNode[] = [];
      const gains: GainNode[] = [];
      for (const p of PARTIALS) {
        const osc = nodes.osc('sine', BELL_PRIME_HZ * p.ratio);
        const g = nodes.gain(0);
        osc.connect(g);
        g.connect(out);
        oscs.push(osc);
        gains.push(g);
      }
      // The clapper: a bright transient, which is what tells the ear the bell
      // was struck rather than faded in.
      const hp = nodes.biquad('highpass', 2600, 0.8);
      const clapper = nodes.gain(0);
      white.connect(clapper);
      clapper.connect(hp);
      hp.connect(out);
      this.voices.push({ oscs, gains, clapper, out, busyUntil: 0 });
    }
  }

  update(sim: SimView, now: number): void {
    this.lastNow = now;
    this.pan.set(anchorWorld(sim, ANCHOR.belfry), now);

    const half = Math.floor(sim.timeOfDay * 2);
    if (this.lastHalfHour < 0) {
      this.lastHalfHour = half;
      return;
    }
    if (half === this.lastHalfHour) return;
    // A scene patch can move the clock by hours; do not strike a whole day.
    const jumped = Math.abs(half - this.lastHalfHour) > 1;
    this.lastHalfHour = half;
    if (jumped) return;

    const n = half % 8 === 0 ? 8 : half % 8;
    this.strikeWatch(now, n);
  }

  /** One bell per half hour of the watch, struck in pairs. */
  private strikeWatch(now: number, count: number): void {
    let t = eventTime(now, 0.2);
    for (let i = 0; i < count; i++) {
      this.strikeOne(t, 0.85 + 0.3 * this.rng());
      t += i % 2 === 0 ? 0.34 : 0.86;
    }
  }

  strikeOne(t0: number, gain: number): void {
    const t = notBefore(t0, this.lastNow);
    let best = -1;
    for (let i = 0; i < this.voices.length; i++) {
      const idx = (this.cursor + i) % this.voices.length;
      if (this.voices[idx].busyUntil <= t) {
        best = idx;
        break;
      }
    }
    // Drop it rather than restart a ringing voice. See VOICES.
    if (best < 0) return;
    this.cursor = (best + 1) % this.voices.length;
    const v = this.voices[best];
    v.busyUntil = t + RING_S;

    // Strike-to-strike variation: never twice the same bell.
    const detune = 1 + (this.rng() - 0.5) * 0.006;
    const bright = 0.75 + 0.5 * this.rng();
    for (let i = 0; i < PARTIALS.length; i++) {
      const p = PARTIALS[i];
      v.oscs[i].frequency.setValueAtTime(BELL_PRIME_HZ * p.ratio * detune, t);
      const g = p.gain * dB(-19) * gain * (p.ratio > 1.4 ? bright : 1);
      strike(v.gains[i].gain, t, g, 0.004, p.tau * (0.85 + 0.3 * this.rng()));
    }
    strike(v.clapper.gain, t, dB(-26) * gain * bright, 0.0008, 0.02);
  }
}
