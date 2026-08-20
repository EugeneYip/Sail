import type { CameraModeName } from '../types';
import type { AudioBuffers } from './Buffers';
import { dB, Nodes, Ramp } from './Context';
import type { SimView } from './Sim';

/**
 * per-source -> family bus -> master. Families exist so the camera can rebalance
 * the whole mix with six numbers, and so the reverb send is set once per family
 * rather than per voice.
 */
export interface Bus {
  readonly name: string;
  /** Connect sources here (directly for beds, via a PannerNode for points). */
  readonly in: GainNode;
  readonly level: Ramp;
  readonly send: Ramp;
}

export type BusName = 'sea' | 'ship' | 'wind' | 'wildlife' | 'weather' | 'music';

/**
 * Static family balance, dB.
 *
 * The whole mix used to run into the limiter continuously: measured RMS was
 * -9.6 dBFS becalmed and -8.3 dBFS in a gale, i.e. a full gale was 1.3 dB louder
 * than a flat calm, because the compressor was doing the mixing. Everything below
 * unity here so the limiter is a seat belt and the dynamics are real.
 *
 * The sea leads. Everything else is subordinate and quiet — AGENTS.md directive 5.
 */
const BASE_TRIM: Record<BusName, number> = {
  sea: -9,
  ship: -15,
  wind: -8,
  wildlife: -16,
  weather: -14,
  music: -14,
};

/** Per-camera-mode family trim, dB. The mix is the camera's job as much as the rig's. */
const MODE_TRIM: Record<CameraModeName, Partial<Record<BusName, number>>> = {
  helm: { sea: -2, ship: 3, wind: -5, weather: 1 },
  chase: {},
  bowsprit: { sea: 2.5, ship: 1, wind: 2 },
  masthead: { sea: -5, ship: 1, wind: 5.5, weather: 2 },
  orbit: { sea: 2, ship: -6, wind: -3 },
  cinematic: { sea: 2, ship: -5, wind: -2 },
  free: {},
};

/**
 * Ceiling for the output soft clip. 0.92 rather than 1.0 because 2x oversampling
 * in the shaper can overshoot the curve by ~1% on the way back down.
 */
const CEILING = 0.92;

/** Wet level of the music-only wash, as a fraction of the dry music bus. */
const MUSIC_WET = 0.5;

/**
 * tanh soft clip with UNITY small-signal gain.
 *
 * A `WaveShaperNode` maps input -1..+1 linearly onto the whole curve array, so
 * the curve index is the input. The previous version built the curve over
 * x = -2..+2 and applied `tanh(x * 1.35) * 0.92`, which means an input of u was
 * shaped as `tanh(2.7u) * 0.92` — a slope of 2.48 at the origin, i.e. the "soft
 * clip" was a +7.9 dB amplifier that then saturated. Measured: a -22 dBFS
 * programme came out at -13 dBFS with the shaper permanently in compression.
 * That is the reported distortion.
 *
 * `C * tanh(u / C)` has slope exactly 1 at the origin and asymptote C, so it is
 * inaudible until the programme approaches the ceiling and hard-bounded after.
 * Verified against the built curve: -0.01 dB at 0.05, -0.21 dB at 0.25,
 * -0.80 dB at 0.5, and a hard ceiling of 0.7321 = -2.71 dBFS at full scale.
 *
 * `n` is ODD so that index (n-1)/2 is exactly u = 0 and silence maps to exactly
 * zero. With an even length the shaper interpolates between two symmetric
 * neighbours, which is still zero but only by cancellation.
 */
function softClipCurve(n = 4097): Float32Array<ArrayBuffer> {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const u = (i / (n - 1)) * 2 - 1;
    c[i] = CEILING * Math.tanh(u / CEILING);
  }
  return c;
}

export class Mixer {
  readonly buses: Record<BusName, Bus>;
  readonly masterPre: GainNode;
  readonly master: GainNode;
  /**
   * The last node before the destination — after the fader AND after the
   * ceiling. Anything measuring what the player actually hears must tap this,
   * not `master`.
   */
  readonly out: GainNode;
  readonly analyser: AnalyserNode;
  readonly reverb: Reverb;
  private readonly masterLevel: Ramp;
  private readonly musicVerbWet: Ramp;
  private readonly convMusic: ConvolverNode;
  private readonly musicSend: GainNode;
  private readonly timeBuf: Float32Array<ArrayBuffer>;
  private readonly freqBuf: Float32Array<ArrayBuffer>;
  /** Extra ducking applied by thunder / big slams — the window [from, until). */
  private duckFrom = Infinity;
  private duckUntil = 0;
  /** 0 while the tab is hidden, so a backgrounded game fades instead of cutting. */
  private hushed = 0;
  private lastVolume = 0;

  constructor(
    private readonly nodes: Nodes,
    buffers: AudioBuffers,
    destination: AudioNode,
    withAnalyser: boolean,
    bypassLimiter = false,
  ) {
    const n = nodes;
    this.masterPre = n.gain(1);

    this.master = n.gain(0.0001);
    this.masterLevel = new Ramp(this.master.gain, 0.25, 2e-4);

    // Infrasonic guard, two poles of it. The brown-noise swell bed carries real
    // energy below 20 Hz, which nobody hears but which ate headroom the audible
    // band could have used and left a measurable DC offset. One 2nd-order stage
    // is only -24 dB at a quarter of the corner; two are -48 dB.
    const dcBlock = n.biquad('highpass', 30, 0.7);
    const dcBlock2 = n.biquad('highpass', 30, 0.7);
    this.masterPre.connect(dcBlock);
    dcBlock.connect(dcBlock2);

    // The ceiling goes AFTER the fader, which is the second gain-staging bug
    // found: with the shaper in front of `master`, the amount of saturation was
    // set by the raw pre-fader sum, so turning the game's volume down could not
    // make it any cleaner — it only made the distortion quieter. Last in the
    // chain, the fader is a real attenuator again and the shaper only works when
    // the mix genuinely asks for it.
    this.out = n.gain(1);
    dcBlock2.connect(this.master);
    if (bypassLimiter) {
      this.master.connect(this.out);
    } else {
      // A seat belt, and nothing else. There USED to be a DynamicsCompressorNode
      // in front of the shaper. Blink's implementation applies an unconditional
      // "makeup gain" derived from the threshold and ratio — about +3 dB here —
      // so the seat belt was quietly turning the whole mix up whether or not
      // anything needed catching, and (with the shaper bug above) the programme
      // ran permanently in saturation. A limiter whose gain is a browser's
      // private empirical formula cannot be made honest, so it is gone: the
      // soft clip alone is transparent below the ceiling and bounded above it.
      const clip = n.shaper(softClipCurve(), '2x');
      this.master.connect(clip);
      clip.connect(this.out);
    }
    this.out.connect(destination);

    this.analyser = n.analyser(withAnalyser ? 2048 : 32);
    if (withAnalyser) this.out.connect(this.analyser);
    this.timeBuf = new Float32Array(this.analyser.fftSize);
    this.freqBuf = new Float32Array(this.analyser.frequencyBinCount);

    this.reverb = new Reverb(n, buffers, this.masterPre);

    // Each bus is BUILT at its trim. It used to be built at unity and only
    // ramped down to BASE_TRIM on the first frame, so for the first second —
    // exactly while the master fades in — every family ran 9 to 17 dB hot into
    // the ceiling. That is a burst of saturation on every start, every resume
    // and every unhide, which is the first half of the reported popping.
    const mk = (name: BusName, send: number): Bus => {
      const level = dB(BASE_TRIM[name]);
      const inNode = n.gain(level);
      const sendNode = n.gain(send);
      inNode.connect(this.masterPre);
      inNode.connect(sendNode);
      sendNode.connect(this.reverb.input);
      const bus: Bus = {
        name,
        in: inNode,
        level: new Ramp(inNode.gain, 0.3, 3e-4),
        send: new Ramp(sendNode.gain, 0.5, 3e-4),
      };
      bus.level.snap(level);
      return bus;
    };

    this.buses = {
      sea: mk('sea', 0.1),
      ship: mk('ship', 0.45),
      wind: mk('wind', 0.08),
      wildlife: mk('wildlife', 0.7),
      weather: mk('weather', 0.3),
      music: mk('music', 0.12),
    };

    // The music gets its own long wash so the ship does not sound like a chapel.
    // The IRs are energy-normalised (see `IrSpec.gain`), so 0.5 x 0.55 really is
    // a wash at 28% of the dry level and not, as it was, nine times it.
    this.convMusic = n.convolver(buffers.irMusic);
    this.musicSend = n.gain(0.55);
    const wet = n.gain(MUSIC_WET);
    this.buses.music.in.connect(this.musicSend);
    this.musicSend.connect(this.convMusic);
    this.convMusic.connect(wet);
    wet.connect(this.masterPre);
    this.musicVerbWet = new Ramp(wet.gain, 0.6, 3e-4);
    this.musicVerbWet.snap(MUSIC_WET);
  }

  /** Family trims, master volume and reverb blend. Called every frame. */
  update(sim: SimView, now: number): void {
    const trim = MODE_TRIM[sim.camMode] ?? {};
    const duck = now < this.duckUntil ? 0.55 : 1;

    this.buses.sea.level.set(dB(BASE_TRIM.sea + (trim.sea ?? 0)), now);
    this.buses.ship.level.set(dB(BASE_TRIM.ship + (trim.ship ?? 0)), now);
    this.buses.wind.level.set(dB(BASE_TRIM.wind + (trim.wind ?? 0)), now);
    this.buses.wildlife.level.set(dB(BASE_TRIM.wildlife + (trim.wildlife ?? 0)), now);
    this.buses.weather.level.set(dB(BASE_TRIM.weather + (trim.weather ?? 0)), now);
    this.buses.music.level.set(dB(BASE_TRIM.music) * (sim.musicVolume > 1e-3 ? 1 : 1e-4), now);

    // Wetter below the weather deck, drier out in the open.
    this.buses.ship.send.set(0.3 + 0.35 * (1 - sim.exposure), now);
    this.buses.wildlife.send.set(0.55 + 0.35 * Math.min(1, 400 / Math.max(80, sim.landDistance)), now);

    this.lastVolume = sim.masterVolume;
    this.masterLevel.set(Math.max(0.0001, sim.masterVolume * (1 - this.hushed)), now);
    this.musicVerbWet.set(MUSIC_WET * duck, now);
    this.reverb.update(sim, now);
  }

  /**
   * Fade the whole rig out (and back) outside the frame loop — `update()` stops
   * being called the moment the tab is hidden, so this cannot wait for a frame.
   */
  hush(on: boolean, now: number): void {
    this.hushed = on ? 1 : 0;
    this.masterLevel.tau = on ? 0.06 : 0.25;
    this.masterLevel.set(Math.max(0.0001, this.lastVolume * (1 - this.hushed)), now);
  }

  /**
   * Permanently detach a family. Used only by the offline probe to isolate one
   * variable; disconnecting rather than zeroing a gain means the per-frame trim
   * in `update()` cannot quietly undo it.
   */
  mute(name: BusName): void {
    try {
      this.buses[name].in.disconnect();
    } catch {
      /* already detached */
    }
  }

  /**
   * Momentary dip on the music bus so thunder and slams have room. `at` is when
   * the sound ARRIVES, which for thunder is up to ten seconds after the strike:
   * the window is [at, at + seconds), not [now, at + seconds), or the music
   * ducked for a bang that had not happened yet.
   */
  duck(at: number, seconds: number): void {
    if (at < this.duckFrom || this.duckUntil <= at) this.duckFrom = at;
    this.duckUntil = Math.max(this.duckUntil, at + seconds);
  }

  isDucking(now: number): boolean {
    return now >= this.duckFrom && now < this.duckUntil;
  }

  /** Live measurement off the master tap — used by the audio test smoke check. */
  measure(): { rms: number; peak: number; brightness: number } {
    const a = this.analyser;
    if (a.fftSize < 256) return { rms: 0, peak: 0, brightness: 0 };
    a.getFloatTimeDomainData(this.timeBuf);
    let sum = 0;
    let peak = 0;
    for (let i = 0; i < this.timeBuf.length; i++) {
      const v = this.timeBuf[i];
      sum += v * v;
      const av = Math.abs(v);
      if (av > peak) peak = av;
    }
    a.getFloatFrequencyData(this.freqBuf);
    const nyquist = this.nodes.ctx.sampleRate / 2;
    let num = 0;
    let den = 0;
    for (let i = 1; i < this.freqBuf.length; i++) {
      const mag = Math.pow(10, this.freqBuf[i] / 20);
      num += mag * ((i / this.freqBuf.length) * nyquist);
      den += mag;
    }
    return {
      rms: Math.sqrt(sum / this.timeBuf.length),
      peak,
      brightness: den > 1e-12 ? num / den : 0,
    };
  }
}

/* ------------------------------------------------------------------ *
 *  Reverb
 * ------------------------------------------------------------------ */

interface Slot {
  conv: ConvolverNode;
  wet: Ramp;
  gate: GainNode;
  connected: boolean;
  quietSince: number;
  peak: number;
}

/**
 * Three procedurally generated spaces, crossfaded: open sea (barely there),
 * below deck (small and woody) and a cliff/harbour wall with a real slapback.
 * An unused convolver is disconnected rather than fed silence — convolution is
 * the most expensive thing in this graph.
 */
export class Reverb {
  readonly input: GainNode;
  private readonly slots: Slot[];

  constructor(nodes: Nodes, buffers: AudioBuffers, out: AudioNode) {
    this.input = nodes.gain(1);
    const mk = (ir: AudioBuffer, peak: number): Slot => {
      const gate = nodes.gain(1);
      const conv = nodes.convolver(ir);
      const wetGain = nodes.gain(0.0001);
      gate.connect(conv);
      conv.connect(wetGain);
      wetGain.connect(out);
      this.input.connect(gate);
      return {
        conv,
        gate,
        wet: new Ramp(wetGain.gain, 0.8, 2e-4),
        connected: true,
        quietSince: 0,
        peak,
      };
    };
    // `peak` is now a true wet/dry ratio, because the IRs are energy-normalised.
    // The old numbers looked like these but multiplied by the convolvers' own
    // x1.8 / x6.1 / x7.1 (at 24 kHz; x2.6 / x8.6 / x10.0 at 48 kHz), so the
    // cliff wall returned six times the signal that was sent to it.
    this.slots = [mk(buffers.irSea, 0.45), mk(buffers.irDeck, 0.5), mk(buffers.irCliff, 0.7)];
  }

  update(sim: SimView, now: number): void {
    // Below-deck colour bleeds in at the helm, which sits under the poop deck.
    const enclosed = sim.camMode === 'helm' ? 0.45 : sim.camMode === 'bowsprit' ? 0.1 : 0.06;
    const cliff = smoothstep(700, 130, sim.landDistance);
    const open = 1 - 0.6 * enclosed;
    const w = [open, enclosed, cliff];
    for (let i = 0; i < 3; i++) {
      const target = w[i] * this.slots[i].peak;
      const s = this.slots[i];
      s.wet.set(Math.max(0.0001, target), now);
      if (target < 0.004) {
        if (s.quietSince === 0) s.quietSince = now;
        if (s.connected && now - s.quietSince > 2) {
          try {
            s.gate.disconnect(s.conv);
          } catch {
            /* already detached */
          }
          s.connected = false;
        }
      } else {
        s.quietSince = 0;
        if (!s.connected) {
          s.gate.connect(s.conv);
          s.connected = true;
        }
      }
    }
  }
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  if (!Number.isFinite(x)) return edge1 > edge0 ? 0 : 0;
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
