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
 * tanh soft clip. The ceiling is 0.92 rather than 1.0 because 2x oversampling
 * in the shaper can overshoot the curve by ~1% on the way back down, and the
 * whole point of this node is that the output can never reach full scale.
 */
function softClipCurve(n = 4096): Float32Array<ArrayBuffer> {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 4 - 2;
    c[i] = Math.tanh(x * 1.35) * 0.92;
  }
  return c;
}

export class Mixer {
  readonly buses: Record<BusName, Bus>;
  readonly masterPre: GainNode;
  readonly master: GainNode;
  readonly analyser: AnalyserNode;
  readonly reverb: Reverb;
  private readonly masterLevel: Ramp;
  private readonly musicVerbWet: Ramp;
  private readonly convMusic: ConvolverNode;
  private readonly musicSend: GainNode;
  private readonly timeBuf: Float32Array<ArrayBuffer>;
  private readonly freqBuf: Float32Array<ArrayBuffer>;
  /** Extra ducking applied by thunder / big slams. */
  private duckUntil = 0;
  /** 0 while the tab is hidden, so a backgrounded game fades instead of cutting. */
  private hushed = 0;
  private lastVolume = 0;

  constructor(
    private readonly nodes: Nodes,
    buffers: AudioBuffers,
    destination: AudioNode,
    withAnalyser: boolean,
  ) {
    const n = nodes;
    this.masterPre = n.gain(1);

    const limiter = n.compressor(-11, 6, 14, 0.004, 0.22);
    const clip = n.shaper(softClipCurve(), '2x');
    this.master = n.gain(0.0001);
    this.masterLevel = new Ramp(this.master.gain, 0.25, 2e-4);

    this.masterPre.connect(limiter);
    limiter.connect(clip);
    clip.connect(this.master);
    this.master.connect(destination);

    this.analyser = n.analyser(withAnalyser ? 2048 : 32);
    if (withAnalyser) this.master.connect(this.analyser);
    this.timeBuf = new Float32Array(this.analyser.fftSize);
    this.freqBuf = new Float32Array(this.analyser.frequencyBinCount);

    this.reverb = new Reverb(n, buffers, this.masterPre);

    const mk = (name: BusName, level: number, send: number): Bus => {
      const inNode = n.gain(level);
      const sendNode = n.gain(send);
      inNode.connect(this.masterPre);
      inNode.connect(sendNode);
      sendNode.connect(this.reverb.input);
      return {
        name,
        in: inNode,
        level: new Ramp(inNode.gain, 0.3, 3e-4),
        send: new Ramp(sendNode.gain, 0.5, 3e-4),
      };
    };

    this.buses = {
      sea: mk('sea', 1, 0.1),
      ship: mk('ship', 1, 0.45),
      wind: mk('wind', 1, 0.08),
      wildlife: mk('wildlife', 1, 0.7),
      weather: mk('weather', 1, 0.3),
      music: mk('music', 0.0001, 0.12),
    };

    // The music gets its own long wash so the ship does not sound like a chapel.
    this.convMusic = n.convolver(buffers.irMusic);
    this.musicSend = n.gain(0.55);
    const wet = n.gain(0.9);
    this.buses.music.in.connect(this.musicSend);
    this.musicSend.connect(this.convMusic);
    this.convMusic.connect(wet);
    wet.connect(this.masterPre);
    this.musicVerbWet = new Ramp(wet.gain, 0.6, 3e-4);
    this.musicVerbWet.snap(0.9);
  }

  /** Family trims, master volume and reverb blend. Called every frame. */
  update(sim: SimView, now: number): void {
    const trim = MODE_TRIM[sim.camMode] ?? {};
    const duck = now < this.duckUntil ? 0.55 : 1;

    this.buses.sea.level.set(dB(trim.sea ?? 0), now);
    this.buses.ship.level.set(dB(trim.ship ?? 0), now);
    this.buses.wind.level.set(dB(trim.wind ?? 0), now);
    this.buses.wildlife.level.set(dB(trim.wildlife ?? 0), now);
    this.buses.weather.level.set(dB(trim.weather ?? 0), now);

    // Wetter below the weather deck, drier out in the open.
    this.buses.ship.send.set(0.3 + 0.35 * (1 - sim.exposure), now);
    this.buses.wildlife.send.set(0.55 + 0.35 * Math.min(1, 400 / Math.max(80, sim.landDistance)), now);

    this.lastVolume = sim.masterVolume;
    this.masterLevel.set(Math.max(0.0001, sim.masterVolume * (1 - this.hushed)), now);
    this.musicVerbWet.set(0.9 * duck, now);
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

  /** Momentary dip on the music bus so thunder and slams have room. */
  duck(now: number, seconds: number): void {
    this.duckUntil = Math.max(this.duckUntil, now + seconds);
  }

  isDucking(now: number): boolean {
    return now < this.duckUntil;
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
    this.slots = [mk(buffers.irSea, 0.6), mk(buffers.irDeck, 0.55), mk(buffers.irCliff, 0.85)];
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
