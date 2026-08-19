import { makeRng, smoothstep } from '../util/math';
import { ANCHOR, anchorWorld, toWorld } from './Anchors';
import type { AudioBuffers } from './Buffers';
import type { Bus } from './Buses';
import { dB, eventTime, freqRamp, Nodes, PanRamp, Ramp } from './Context';
import type { SimView } from './Sim';
import type { NoisePool } from './Voices';

/**
 * The sea. Four continuous layers plus discrete impacts:
 *
 *  swell   brown noise under 130 Hz, amplitude-modulated at the wave period
 *  rush    pink noise around 500 Hz, the body of moving water
 *  crests  white noise above 2 kHz, the hiss of breaking water
 *  hull    the sound of THIS ship moving through water — level and centre
 *          frequency both track speed, which makes it the ear's speedometer
 *  wake    foam hiss trailing aft
 *
 * Impacts come from the shared impact pool: bow slams detected from vertical
 * motion (or `ship.bowSlam` when physics publishes it), plus wave slaps along
 * the hull at a rate set by sea state and speed.
 */

/** Peak-period estimate for a wind sea, seconds. Hs in metres. */
function wavePeriod(hs: number): number {
  return 2.6 + 2.4 * Math.sqrt(Math.max(0.05, hs));
}

interface Layer {
  gain: Ramp;
  freq: Ramp;
  q?: Ramp;
  shelf?: Ramp;
}

export class Sea {
  private readonly rng = makeRng(0xbea75ea);
  private readonly swell: Layer[] = [];
  private readonly swellLfoRate: Ramp[] = [];
  private readonly swellLfoDepth: Ramp[] = [];
  private readonly rush: Layer;
  private readonly crest: Layer;
  private readonly crestDepth: Ramp;
  private readonly hull: Layer[] = [];
  private readonly hullPan: PanRamp[] = [];
  private readonly wake: Layer;
  private readonly wakePan: PanRamp;
  private readonly nearLp: Ramp;
  private readonly nearGain: Ramp;

  private slamCooldown = 0;
  private prevHeave = 0;
  private slapAccum = 0;
  private bigAccum = 0;

  constructor(
    nodes: Nodes,
    buffers: AudioBuffers,
    bus: Bus,
    private readonly impacts: NoisePool,
  ) {
    // Ship-relative water (hull rush, wake) goes through a shared air-absorption
    // filter so a distant camera hears a dull hull rather than a crisp one.
    const near = nodes.gain(1);
    const nearLp = nodes.biquad('lowpass', 20000, 0.7);
    near.connect(nearLp);
    nearLp.connect(bus.in);
    this.nearGain = new Ramp(near.gain, 0.4, 3e-4);
    this.nearLp = freqRamp(nearLp.frequency, 0.5);

    // --- swell: two decorrelated brown-noise voices at different rates
    for (let i = 0; i < 2; i++) {
      const src = nodes.loop(buffers.dark, i === 0 ? 0.83 : 1.19);
      const lp = nodes.biquad('lowpass', 110, 0.9);
      const peak = nodes.biquad('peaking', 46 + i * 9, 1.3, 7);
      const g = nodes.gain(0.0001);
      const lfo = nodes.osc('sine', 0.2);
      const depth = nodes.gain(0);
      src.connect(lp);
      lp.connect(peak);
      peak.connect(g);
      g.connect(bus.in);
      lfo.connect(depth);
      depth.connect(g.gain);
      this.swell.push({ gain: new Ramp(g.gain, 0.9, 2e-4), freq: freqRamp(lp.frequency, 1.2) });
      this.swellLfoRate.push(freqRamp(lfo.frequency, 2));
      this.swellLfoDepth.push(new Ramp(depth.gain, 1.2, 2e-4));
    }

    // --- mid-band rush
    {
      const src = nodes.loop(buffers.pink, 1.0);
      const bp = nodes.biquad('bandpass', 480, 0.55);
      const shelf = nodes.biquad('highshelf', 1800, 0.7, -6);
      const g = nodes.gain(0.0001);
      src.connect(bp);
      bp.connect(shelf);
      shelf.connect(g);
      g.connect(bus.in);
      this.rush = {
        gain: new Ramp(g.gain, 0.7, 2e-4),
        freq: freqRamp(bp.frequency, 0.9),
        shelf: new Ramp(shelf.gain, 0.9, 0.05),
      };
    }

    // --- breaking crests
    {
      const src = nodes.loop(buffers.white, 0.97);
      const hp = nodes.biquad('highpass', 2400, 0.6);
      const peak = nodes.biquad('peaking', 5200, 0.8, 4);
      const g = nodes.gain(0.0001);
      const lfo = nodes.osc('sine', 0.09);
      const depth = nodes.gain(0);
      src.connect(hp);
      hp.connect(peak);
      peak.connect(g);
      g.connect(bus.in);
      lfo.connect(depth);
      depth.connect(g.gain);
      this.crest = { gain: new Ramp(g.gain, 0.8, 2e-4), freq: freqRamp(hp.frequency, 1.1) };
      this.crestDepth = new Ramp(depth.gain, 1.5, 2e-4);
    }

    // --- water along the hull: one voice at the bow, one amidships
    for (let i = 0; i < 2; i++) {
      const src = nodes.loop(buffers.pink, i === 0 ? 1.07 : 0.91);
      const bp = nodes.biquad('bandpass', 320, 0.75);
      const shelf = nodes.biquad('highshelf', 2600, 0.7, -12);
      const g = nodes.gain(0.0001);
      const pan = nodes.panner(18, 1.0, false);
      src.connect(bp);
      bp.connect(shelf);
      shelf.connect(g);
      g.connect(pan);
      pan.connect(near);
      this.hull.push({
        gain: new Ramp(g.gain, 0.35, 2e-4),
        freq: freqRamp(bp.frequency, 0.4),
        q: new Ramp(bp.Q, 0.5, 0.01),
        shelf: new Ramp(shelf.gain, 0.4, 0.05),
      });
      this.hullPan.push(new PanRamp(pan));
    }

    // --- wake foam astern
    {
      const src = nodes.loop(buffers.white, 1.03);
      const bp = nodes.biquad('bandpass', 3200, 0.5);
      const hp = nodes.biquad('highpass', 1100, 0.7);
      const g = nodes.gain(0.0001);
      const pan = nodes.panner(24, 0.95, false);
      src.connect(hp);
      hp.connect(bp);
      bp.connect(g);
      g.connect(pan);
      pan.connect(near);
      this.wake = { gain: new Ramp(g.gain, 0.5, 2e-4), freq: freqRamp(bp.frequency, 0.6) };
      this.wakePan = new PanRamp(pan);
    }
  }

  update(sim: SimView, now: number): void {
    const seaState = Math.max(0, sim.seaState);
    const hs = Math.max(0.05, sim.waveHeight);
    const period = wavePeriod(hs);

    // --- swell. Level tracks Hs; modulation depth tracks chop.
    const swellLevel = dB(-21 + 20 * smoothstep(0, 7, hs));
    for (let i = 0; i < this.swell.length; i++) {
      const s = this.swell[i];
      s.gain.set(swellLevel * (i === 0 ? 1 : 0.7), now);
      s.freq.set(74 + 30 * smoothstep(0.5, 6, hs), now);
      // One voice on the swell period, one at 0.41 of it: the beat between them
      // is a long, irregular rise and fall instead of a metronome. A real sea is
      // never static and never busy.
      this.swellLfoRate[i].set((1 / period) * (i === 0 ? 1 : 0.41), now);
      this.swellLfoDepth[i].set(
        swellLevel * (0.3 + 0.34 * sim.choppiness) * (i === 0 ? 1 : 0.62),
        now,
      );
    }

    // --- mid rushing water: the body of the bed, and the loudest layer
    this.rush.gain.set(dB(-24 + 15 * smoothstep(0, 7, seaState)), now);
    this.rush.freq.set(330 + 300 * smoothstep(1, 7, seaState), now);
    this.rush.shelf?.set(-11 + 10 * smoothstep(2, 8, seaState), now);

    // --- fine foam hiss. Whitecaps begin around force 4 / sea state 3, and the
    // wave height decides how much water is actually falling over.
    const breaking =
      smoothstep(2.2, 7.5, seaState) * smoothstep(3, 12, sim.windSpeed) * (0.45 + 0.55 * smoothstep(0.4, 5, hs));
    const foamLevel = dB(-40 + 24 * breaking);
    this.crest.gain.set(foamLevel, now);
    this.crest.freq.set(2600 - 900 * breaking, now);
    // Deep, slow modulation: foam arrives in sheets, it does not sit there.
    this.crestDepth.set(foamLevel * 0.62, now);

    // --- hull water: THE speedometer. Level ~ v^1.4, centre frequency and
    // brightness both climb, because faster water is a brighter rush.
    const v = Math.min(1, sim.speedKnots / 13);
    const vs = Math.pow(v, 1.4);
    for (let i = 0; i < this.hull.length; i++) {
      const h = this.hull[i];
      const trim = i === 0 ? 1 : 0.62;
      h.gain.set(dB(-38 + 28 * vs) * trim, now);
      h.freq.set((250 + 1150 * Math.pow(v, 0.85)) * (i === 0 ? 1 : 0.72), now);
      h.q?.set(0.85 - 0.25 * v, now);
      h.shelf?.set(-14 + 20 * v, now);
    }
    this.hullPan[0].set(anchorWorld(sim, ANCHOR.bow), now);
    this.hullPan[1].set(anchorWorld(sim, ANCHOR.hullStbd), now);

    // --- wake foam
    const foam = Math.min(1, vs * 1.1 + 0.25 * smoothstep(3, 7, seaState));
    this.wake.gain.set(dB(-42 + 25 * foam), now);
    this.wake.freq.set(2400 + 1600 * v, now);
    this.wakePan.set(anchorWorld(sim, ANCHOR.wake), now);

    // Air absorption + level for the ship-relative water.
    const d = Math.max(1, sim.camDistance);
    this.nearGain.set(1, now);
    this.nearLp.set(20000 / (1 + d / 110), now);

    this.events(sim, now);
  }

  /** Bow slams and hull slaps. */
  private events(sim: SimView, now: number): void {
    const dt = Math.min(0.1, Math.max(0, sim.dt));
    this.slamCooldown -= dt;

    const hs = Math.max(0.05, sim.waveHeight);
    const v = Math.min(1.4, sim.speedKnots / 13);

    // Detector: the ship falls into a trough then the bow arrests. Prefer the
    // solver's own bowSlam when it publishes one.
    let mag = 0;
    if (sim.bowSlam > 2) mag = Math.min(1.4, sim.bowSlam / 14);
    if (this.prevHeave < -0.9 && sim.heaveRate > this.prevHeave + 0.35) {
      mag = Math.max(mag, Math.min(1.3, -this.prevHeave / 2.6));
    }
    this.prevHeave = sim.heaveRate;

    // Baseline: in a real sea the bow is working constantly, and the placeholder
    // physics barely heaves, so drive a rate from sea state as well.
    const bigRate = smoothstep(1.2, 6, hs) * (0.07 + 0.04 * v) + smoothstep(4, 8, sim.seaState) * 0.07;
    this.bigAccum = Math.min(1.6, this.bigAccum + bigRate * dt);
    if (this.bigAccum > 1) {
      this.bigAccum -= 1;
      mag = Math.max(mag, 0.35 + 0.65 * this.rng() * smoothstep(1, 6.5, hs));
    }

    if (mag > 0.08 && this.slamCooldown <= 0) {
      this.slam(sim, now, mag);
      this.slamCooldown = 1.1 + 1.4 * this.rng();
    }

    // Hull slaps. This used to run at (0.25 + 0.42*seaState)*... — about five a
    // second in a gale, into a pool shared with slams, spray, thunder and whales,
    // which is what exhausted it. The mid-band rush and the foam hiss carry the
    // same information continuously and without transients, so the slaps are now
    // occasional punctuation: at most one per frame, and never banked up.
    const slapRate = (0.1 + 0.075 * sim.seaState) * (0.5 + 0.5 * v) * (0.6 + 0.6 * sim.choppiness);
    this.slapAccum = Math.min(1.6, this.slapAccum + slapRate * dt);
    if (this.slapAccum > 1) {
      this.slapAccum -= 1;
      this.slap(sim, now, hs);
    }
  }

  private slam(sim: SimView, now: number, mag: number): void {
    const r = this.rng;
    const side = r() < 0.5 ? -1 : 1;
    const p = toWorld(sim, side * 4.5, 1.2, -22 - r() * 8);
    const req = this.impacts.begin(eventTime(now, 0.005 + r() * 0.02));
    req.gain = dB(-26) * Math.min(1.35, mag);
    req.low = 0.95;
    req.high = 0.45 + 0.3 * mag;
    req.type = 'lowpass';
    req.freq = 900 + 700 * mag;
    req.freqTo = 150;
    req.sweepTime = 0.3 + 0.25 * mag;
    req.q = 0.9;
    req.r1f = 78 + 22 * r();
    req.r1q = 1.5;
    req.r1db = 8;
    req.r2f = 2400;
    req.r2q = 0.8;
    req.r2db = 3 + 4 * mag;
    req.attack = 0.016;
    req.decay = 0.45 + 0.7 * mag;
    req.x = p.x;
    req.y = p.y;
    req.z = p.z;
    this.impacts.fire(now);

    // Spray sheet thrown up and blown aft — a swelling hiss, not a transient.
    const sp = toWorld(sim, side * 3, 5 + 4 * mag, -18);
    const s = this.impacts.begin(eventTime(now, 0.05 + 0.06 * r()));
    s.gain = dB(-31) * mag;
    s.low = 0;
    s.high = 1;
    s.type = 'highpass';
    s.freq = 900;
    s.freqTo = 2600;
    s.sweepTime = 0.5;
    s.q = 0.6;
    s.r2f = 5000;
    s.r2q = 0.7;
    s.r2db = 4;
    s.soft = true;
    s.attack = 0.07;
    s.hold = 0.1 + 0.2 * mag;
    s.decay = 0.5 + 0.8 * mag;
    s.x = sp.x;
    s.y = sp.y;
    s.z = sp.z;
    this.impacts.fire(now);
  }

  private slap(sim: SimView, now: number, hs: number): void {
    const r = this.rng;
    const side = r() < 0.5 ? -1 : 1;
    const p = toWorld(sim, side * 6.6, 0.6, -20 + r() * 42);
    const size = 0.3 + 0.7 * r() * smoothstep(0.3, 5, hs);
    const req = this.impacts.begin(eventTime(now, r() * 0.06));
    req.gain = dB(-36) * size;
    req.low = 0.55;
    req.high = 0.8;
    req.type = 'bandpass';
    req.freq = 500 + 700 * r();
    req.freqTo = 260;
    req.sweepTime = 0.18;
    req.q = 1.0 + r();
    req.r1f = 160;
    req.r1q = 1.2;
    req.r1db = 5 * size;
    req.attack = 0.014;
    req.decay = 0.2 + 0.3 * size;
    req.x = p.x;
    req.y = p.y;
    req.z = p.z;
    this.impacts.fire(now);
  }
}
