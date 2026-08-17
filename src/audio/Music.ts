import { makeRng, smoothstep } from '../util/math';
import type { Bus, Mixer } from './Buses';
import { dB, freqRamp, Nodes, Ramp, strike, swell } from './Context';
import type { SimView } from './Sim';

/**
 * Generative ambience. Never loops, never arrives, mostly not there.
 *
 * A three-voice drone whose partial balance drifts on slow independent LFOs, plus
 * single notes from a pentatonic set fired at random intervals into a long reverb.
 * The whole thing is gated by an intensity that is near zero in fair weather and
 * only opens up in a gale or at the edges of the day — the sea is the music the
 * rest of the time.
 */

/** D minor pentatonic plus the ninth, in semitones from the root. */
const DEGREES = [0, 3, 5, 7, 10, 14];
/** Root drift stays inside the mode. */
const ROOT_STEPS = [0, -5, -3, 2, 4, -7];
const BASE_ROOT_HZ = 73.416; // D2

interface Drone {
  gain: Ramp;
  lp: Ramp;
  oscs: OscillatorNode[];
  ratio: number;
}

interface Pluck {
  a: OscillatorNode;
  b: OscillatorNode;
  lp: BiquadFilterNode;
  env: GainNode;
  pan: StereoPannerNode;
  busyUntil: number;
}

export class Music {
  private readonly rng = makeRng(0x11f7);
  private readonly drones: Drone[] = [];
  private readonly plucks: Pluck[] = [];
  private readonly level: Ramp;
  private readonly out: GainNode;
  private nextNote = 4;
  private rootIndex = 0;
  private rootTimer = 30;
  private cursor = 0;
  private intensity = 0;

  constructor(
    nodes: Nodes,
    private readonly bus: Bus,
    private readonly mixer: Mixer,
  ) {
    this.out = nodes.gain(0.0001);
    this.out.connect(bus.in);
    this.level = new Ramp(this.out.gain, 2.5, 2e-4);

    const ratios = [1, 1.5, 2.0049];
    for (let i = 0; i < ratios.length; i++) {
      const lp = nodes.biquad('lowpass', 700, 0.9);
      const g = nodes.gain(0.0001);
      const a = nodes.osc('sine', BASE_ROOT_HZ * ratios[i]);
      const b = nodes.osc('triangle', BASE_ROOT_HZ * ratios[i] * 1.0013);
      const bg = nodes.gain(0.12);
      a.connect(lp);
      b.connect(bg);
      bg.connect(lp);
      lp.connect(g);
      g.connect(this.out);
      // Each voice breathes on its own slow cycle, so the chord never settles.
      const lfo = nodes.osc('sine', 0.017 + 0.013 * i);
      const depth = nodes.gain(0.28);
      lfo.connect(depth);
      depth.connect(g.gain);
      this.drones.push({
        gain: new Ramp(g.gain, 3, 2e-4),
        lp: freqRamp(lp.frequency, 3),
        oscs: [a, b],
        ratio: ratios[i],
      });
    }

    for (let i = 0; i < 5; i++) {
      const a = nodes.osc('sine', 220);
      const b = nodes.osc('triangle', 220.3);
      const ag = nodes.gain(0.75);
      const bg = nodes.gain(0.22);
      const lp = nodes.biquad('lowpass', 1800, 0.8);
      const env = nodes.gain(0);
      const pan = nodes.stereoPan(0);
      a.connect(ag);
      b.connect(bg);
      ag.connect(lp);
      bg.connect(lp);
      lp.connect(env);
      env.connect(pan);
      pan.connect(this.out);
      this.plucks.push({ a, b, lp, env, pan, busyUntil: 0 });
    }
  }

  update(sim: SimView, now: number): void {
    const dt = Math.min(0.1, Math.max(0, sim.dt));
    const off = sim.musicVolume < 1e-3;

    // Storm and the edges of the day are the only times this is allowed to grow.
    const storm = smoothstep(11, 25, sim.windSpeed) * 0.6 + smoothstep(3, 7, sim.seaState) * 0.4;
    const golden = Math.exp(-Math.pow(sim.sunAltitude / 0.14, 2));
    const night = smoothstep(0.04, -0.25, sim.sunAltitude);
    const want = Math.min(1.1, 0.1 + 0.55 * storm + 0.5 * golden + 0.12 * night);
    this.intensity += (want - this.intensity) * (1 - Math.exp(-0.06 * dt));

    const duck = this.mixer.isDucking(now) ? 0.45 : 1;
    const level = off ? 0.0001 : sim.musicVolume * dB(-15) * (0.22 + 0.78 * this.intensity) * duck;
    this.level.set(level, now);
    this.bus.level.set(1, now);

    if (off) {
      for (const d of this.drones) d.gain.set(0.0001, now);
      return;
    }

    this.rootTimer -= dt;
    if (this.rootTimer <= 0) {
      this.rootTimer = 45 + this.rng() * 70;
      this.rootIndex = Math.floor(this.rng() * ROOT_STEPS.length);
      const root = BASE_ROOT_HZ * Math.pow(2, ROOT_STEPS[this.rootIndex] / 12);
      for (const d of this.drones) {
        // Long glissando between roots — you should never hear a note change.
        d.oscs[0].frequency.setTargetAtTime(root * d.ratio, now, 6);
        d.oscs[1].frequency.setTargetAtTime(root * d.ratio * 1.0013, now, 6);
      }
    }

    for (let i = 0; i < this.drones.length; i++) {
      const d = this.drones[i];
      d.gain.set(0.42 * (i === 0 ? 1 : i === 1 ? 0.6 : 0.4), now);
      d.lp.set(320 + 900 * this.intensity, now);
    }

    if (now >= this.nextNote) {
      this.note(now);
      const gap = (3.4 + this.rng() * 9) / (0.55 + this.intensity);
      this.nextNote = now + gap;
    }
  }

  private note(now: number): void {
    let best = -1;
    for (let i = 0; i < this.plucks.length; i++) {
      const idx = (this.cursor + i) % this.plucks.length;
      if (this.plucks[idx].busyUntil <= now) {
        best = idx;
        break;
      }
    }
    if (best < 0) return;
    this.cursor = (best + 1) % this.plucks.length;
    const p = this.plucks[best];

    const root = BASE_ROOT_HZ * Math.pow(2, ROOT_STEPS[this.rootIndex] / 12);
    const degree = DEGREES[Math.floor(this.rng() * DEGREES.length)];
    const octave = 2 + Math.floor(this.rng() * 2.4);
    const f = root * Math.pow(2, degree / 12 + octave);
    const bowed = this.rng() < 0.3;
    const t = now + 0.02;

    p.a.frequency.setValueAtTime(f, t);
    p.b.frequency.setValueAtTime(f * 1.0013, t);
    p.pan.pan.setValueAtTime((this.rng() * 2 - 1) * 0.55, t);
    p.lp.frequency.setValueAtTime(f * (bowed ? 3.5 : 6) + 300, t);

    if (bowed) {
      const dur = 1.6 + this.rng() * 1.4;
      swell(p.env.gain, t, 0.28, 1.3 + this.rng(), dur, 2.6 + this.rng() * 2);
      p.busyUntil = t + 1.3 + dur + 4.6;
    } else {
      const decay = 2.6 + this.rng() * 3.4;
      strike(p.env.gain, t, 0.34, 0.012, decay);
      p.busyUntil = t + decay + 0.1;
    }
  }
}
