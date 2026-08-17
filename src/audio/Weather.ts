import { makeRng, smoothstep } from '../util/math';
import { ANCHOR, anchorWorld, toWorld } from './Anchors';
import type { AudioBuffers } from './Buffers';
import type { Bus, Mixer } from './Buses';
import { dB, freqRamp, Nodes, PanRamp, Ramp } from './Context';
import type { SimView } from './Sim';
import type { NoisePool } from './Voices';

/** Speed of sound in air, m/s — sets the flash-to-bang delay. */
const SOUND_SPEED = 343;

/**
 * Rain and thunder.
 *
 * Rain is three things: a broad hiss where it hits the water, a granular patter
 * where it hits the deck (the grains are baked into a looping buffer rather than
 * fired as 900 voices a second), and occasional drips off the rigging.
 *
 * Thunder is a long low-passed rumble delayed by distance/343, built from three
 * overlapping swells so it rolls rather than thumps, plus a crack layer that only
 * survives close strikes. Distance is applied as gain and low-pass rather than
 * through the panner, because inverse-distance at 4 km would make it silent.
 */
export class Weather {
  private readonly rng = makeRng(0xc10d);
  private readonly hissGain: Ramp;
  private readonly hissFreq: Ramp;
  private readonly patterGain: Ramp;
  private readonly patterFreq: Ramp;
  private readonly patterRate: Ramp;
  private readonly patterPan: PanRamp;
  private dripAccum = 0;
  private autoTimer = 8;
  /** Set once the VFX module sends us a real lightning event. */
  private externalLightning = false;

  constructor(
    nodes: Nodes,
    buffers: AudioBuffers,
    bus: Bus,
    private readonly impacts: NoisePool,
    private readonly wood: NoisePool,
    private readonly mixer: Mixer,
  ) {
    // --- hiss on the water
    const white = nodes.loop(buffers.white, 1.0);
    const bp = nodes.biquad('bandpass', 4200, 0.45);
    const hiss = nodes.gain(0.0001);
    white.connect(bp);
    bp.connect(hiss);
    hiss.connect(bus.in);
    this.hissGain = new Ramp(hiss.gain, 0.8, 2e-4);
    this.hissFreq = freqRamp(bp.frequency, 1);

    // --- patter on the deck
    const psrc = nodes.loop(buffers.patter, 1.0);
    const pbp = nodes.biquad('bandpass', 2600, 0.7);
    const pg = nodes.gain(0.0001);
    const pan = nodes.panner(14, 0.9, false);
    psrc.connect(pbp);
    pbp.connect(pg);
    pg.connect(pan);
    pan.connect(bus.in);
    this.patterGain = new Ramp(pg.gain, 0.7, 2e-4);
    this.patterFreq = freqRamp(pbp.frequency, 1);
    this.patterRate = new Ramp(psrc.playbackRate, 1.5, 0.01);
    this.patterPan = new PanRamp(pan, 0.15);
  }

  /** Subscribed to the bus by Rig. 'distance' in metres if the emitter says. */
  onLightning(distance: number, now: number): void {
    this.externalLightning = true;
    this.thunder(distance, now);
  }

  update(sim: SimView, now: number): void {
    const dt = Math.min(0.1, Math.max(0, sim.dt));
    const rain = Math.max(0, Math.min(1, sim.rain));

    this.hissGain.set(dB(-46 + 30 * smoothstep(0, 1, rain)) * (rain > 0.001 ? 1 : 0), now);
    this.hissFreq.set(3200 + 2200 * rain, now);

    const shelter = 0.55 + 0.6 * (1 - sim.exposure * 0.5);
    this.patterGain.set(dB(-40 + 26 * rain) * (rain > 0.001 ? shelter : 0), now);
    this.patterFreq.set(1900 + 1600 * rain, now);
    this.patterRate.set(0.85 + 0.3 * rain, now);
    this.patterPan.set(anchorWorld(sim, ANCHOR.deck), now);

    // Drips off the rigging, after the rain has had time to wet it.
    if (rain > 0.12) {
      this.dripAccum += (0.6 + 5 * rain) * dt;
      while (this.dripAccum > 1) {
        this.dripAccum -= 1;
        this.drip(sim, now);
      }
    }

    // If nothing is publishing lightning, make our own weather in a real storm.
    if (!this.externalLightning && rain > 0.45 && sim.cloudCover > 0.85) {
      this.autoTimer -= dt;
      if (this.autoTimer <= 0) {
        this.autoTimer = 9 + this.rng() * 26;
        this.thunder(600 + this.rng() * 3400, now);
      }
    }
  }

  private drip(sim: SimView, now: number): void {
    const r = this.rng();
    const p = toWorld(sim, (r - 0.5) * 12, 4.5 + this.rng() * 3, (this.rng() - 0.5) * 40);
    const req = this.wood.begin(now + this.rng() * 0.08);
    req.gain = dB(-38) * (0.4 + 0.7 * this.rng());
    req.low = 0.15;
    req.high = 0.85;
    req.type = 'bandpass';
    req.freq = 1400 + 2600 * this.rng();
    req.q = 2.5;
    // A drip is a tiny resonator: a bright click with one strong ringing mode.
    req.r1f = 900 + 2400 * this.rng();
    req.r1q = 16;
    req.r1db = 13;
    req.attack = 0.0008;
    req.decay = 0.03 + 0.05 * this.rng();
    req.x = p.x;
    req.y = p.y;
    req.z = p.z;
    this.wood.fire(now);
  }

  /**
   * Thunder at 'distance' metres. Near strikes crack then roll; distant ones are
   * pure rumble arriving up to ten seconds late.
   */
  thunder(distance: number, now: number): void {
    const d = Math.max(60, Math.min(6000, distance));
    const delay = d / SOUND_SPEED;
    const near = smoothstep(2600, 200, d);
    const level = dB(-13) / (1 + d / 1100);
    // Air absorbs the top end over kilometres; that is the whole character.
    const cut = 1 / (1 + d / 900);
    const bearing = this.rng() * Math.PI * 2;
    const px = Math.sin(bearing) * 90;
    const pz = -Math.cos(bearing) * 90;

    if (near > 0.02) {
      const c = this.impacts.begin(now + delay);
      c.gain = level * near * 1.1;
      c.low = 0.5;
      c.high = 1;
      c.type = 'bandpass';
      c.freq = 700 + 1400 * near;
      c.freqTo = 260;
      c.sweepTime = 0.25;
      c.q = 0.6;
      c.r1f = 90;
      c.r1q = 1.1;
      c.r1db = 9;
      c.attack = 0.002;
      c.decay = 0.35 + 0.5 * near;
      c.x = px;
      c.y = 24;
      c.z = pz;
      this.impacts.fire(now);
    }

    // Three overlapping swells: the roll.
    const rolls = 3;
    for (let i = 0; i < rolls; i++) {
      const off = i === 0 ? 0.06 : 0.4 + i * (0.7 + this.rng() * 0.9);
      const w = i === 0 ? 1 : 0.72 - 0.18 * i;
      const r = this.impacts.begin(now + delay + off);
      r.gain = level * w;
      r.low = 1;
      r.high = 0.22 * near;
      r.type = 'lowpass';
      r.freq = (240 + 700 * cut) * (1 - 0.2 * i);
      r.freqTo = 90 + 120 * cut;
      r.sweepTime = 1.6 + 2 * this.rng();
      r.q = 0.8;
      r.r1f = 52 + 26 * this.rng();
      r.r1q = 1.2;
      r.r1db = 10;
      r.soft = true;
      r.attack = 0.15 + 0.5 * this.rng() + 0.6 * (1 - near);
      r.hold = 0.3 + 0.8 * this.rng();
      r.decay = 1.6 + 3.4 * this.rng();
      r.x = px * (1 + 0.2 * i);
      r.y = 20;
      r.z = pz * (1 + 0.2 * i);
      this.impacts.fire(now);
    }

    this.mixer.duck(now + delay, 5 + 4 * near);
  }
}
