import { makeRng, smoothstep } from '../util/math';
import { ANCHOR, anchorWorld, toWorld } from './Anchors';
import type { AudioBuffers } from './Buffers';
import type { Bus } from './Buses';
import { dB, freqRamp, Nodes, PanRamp, Ramp } from './Context';
import type { SimSail, SimView } from './Sim';
import type { NoisePool, TonePool } from './Voices';

const MAST_ANCHORS = [ANCHOR.mastFore, ANCHOR.mastMain, ANCHOR.mastMizzen, ANCHOR.bowsprit];

/** Where a creak can come from, ship-local. Weighted toward the working parts. */
const CREAK_SPOTS: readonly (readonly [number, number, number])[] = [
  [-5, 2, -8],
  [5, 2, -8],
  [-6, 1.5, 6],
  [6, 1.5, 6],
  [0, 3, -20],
  [0, 3.5, 18],
  [0, 12, 0],
  [-3, 9, -12],
  [3, 9, 12],
  [0, 6, 22],
];

/**
 * Hull, rig and gear.
 *
 * Creaks are modelled as struck wood: a very short noise burst through two
 * high-Q formants, which is what a plank under load actually does — a stick-slip
 * release exciting the timber's resonances. They fire stochastically at a rate
 * set by the RATE OF CHANGE of structural load (roll rate, pitch rate, heave
 * acceleration, rig load), not the load itself, and in clusters, so the ship
 * groans as it rolls through a wave and goes quiet at the extremes.
 *
 * Sails get a drawing rumble per mast (taut cloth, mostly under 300 Hz) and
 * flogging cracks when they luff, at a rate that climbs with luff and wind.
 */
export class ShipSounds {
  private readonly rng = makeRng(0x5417c0de);
  private readonly sailGain: Ramp[] = [];
  private readonly sailLp: Ramp[] = [];
  private readonly sailPan: PanRamp[] = [];
  private readonly ropeGain: Ramp[] = [];
  private readonly ropeFreq: Ramp[] = [];
  private readonly ropePan: PanRamp[] = [];
  private readonly squealGain: Ramp;
  private readonly squealFreq: Ramp;
  private readonly squealVib: Ramp;
  private readonly squealPan: PanRamp;

  private creakAccum = 0;
  private flapAccum = 0;
  private clickAccum = 0;
  private crewTimer = 22;
  private prevLuff = new Map<string, number>();

  constructor(
    nodes: Nodes,
    buffers: AudioBuffers,
    bus: Bus,
    private readonly wood: NoisePool,
    private readonly canvas: NoisePool,
    private readonly tones: TonePool,
  ) {
    // --- drawing canvas, one voice per mast
    const cloth = nodes.loop(buffers.fibre, 0.55);
    for (let i = 0; i < 3; i++) {
      const lp = nodes.biquad('lowpass', 240, 1.1);
      const peak = nodes.biquad('peaking', 96 + i * 14, 1.6, 8);
      const g = nodes.gain(0.0001);
      const pan = nodes.panner(30, 0.9, false);
      cloth.connect(lp);
      lp.connect(peak);
      peak.connect(g);
      g.connect(pan);
      pan.connect(bus.in);
      this.sailGain.push(new Ramp(g.gain, 0.5, 2e-4));
      this.sailLp.push(freqRamp(lp.frequency, 0.6));
      this.sailPan.push(new PanRamp(pan, 0.14));
    }

    // --- running rigging: index 0 = sheets and halyards on deck, 1 = tiller ropes
    for (let i = 0; i < 2; i++) {
      const src = nodes.loop(buffers.fibre, i === 0 ? 1.0 : 0.8);
      const bp = nodes.biquad('bandpass', 900, 1.5);
      const g = nodes.gain(0.0001);
      const pan = nodes.panner(12, 1.1, false);
      src.connect(bp);
      bp.connect(g);
      g.connect(pan);
      pan.connect(bus.in);
      this.ropeGain.push(new Ramp(g.gain, 0.25, 2e-4));
      this.ropeFreq.push(freqRamp(bp.frequency, 0.3));
      this.ropePan.push(new PanRamp(pan, 0.1));
    }

    // --- a block squealing under load: a tone, not noise
    {
      const osc = nodes.osc('triangle', 1200);
      const lfo = nodes.osc('sine', 11);
      const lfoGain = nodes.gain(0);
      const bp = nodes.biquad('bandpass', 1600, 3.5);
      const g = nodes.gain(0.0001);
      const pan = nodes.panner(12, 1.1, false);
      lfo.connect(lfoGain);
      lfoGain.connect(osc.frequency);
      osc.connect(bp);
      bp.connect(g);
      g.connect(pan);
      pan.connect(bus.in);
      this.squealGain = new Ramp(g.gain, 0.12, 2e-4);
      this.squealFreq = freqRamp(osc.frequency, 0.25);
      this.squealVib = new Ramp(lfoGain.gain, 0.3, 0.5);
      this.squealPan = new PanRamp(pan, 0.1);
    }
  }

  update(sim: SimView, now: number): void {
    const dt = Math.min(0.1, Math.max(0, sim.dt));
    this.sails(sim, now);
    this.gear(sim, now, dt);
    this.creaks(sim, now, dt);
    this.flaps(sim, now, dt);
    this.crew(sim, now, dt);
  }

  /** Taut cloth rumble per mast. */
  private sails(sim: SimView, now: number): void {
    const aw = Math.max(0, sim.apparentWind);
    const press = smoothstep(1.5, 20, aw);
    const totals = [0, 0, 0];
    for (const s of sim.sails) {
      const m = s.mast === 3 ? 0 : Math.min(2, Math.max(0, s.mast));
      totals[m] += s.area * clamp01(s.set) * (1 - clamp01(s.luff));
    }
    for (let i = 0; i < 3; i++) {
      const frac = Math.min(1.4, totals[i] / 700);
      this.sailGain[i].set(dB(-33) * frac * press, now);
      this.sailLp[i].set(180 + 320 * press, now);
      this.sailPan[i].set(anchorWorld(sim, MAST_ANCHORS[i]), now);
    }
  }

  /** Sheets, halyards, tiller ropes, blocks, wheel. */
  private gear(sim: SimView, now: number, dt: number): void {
    const trim = Math.min(1, sim.setRate * 3.5 + sim.braceRate * 1.2);
    const steer = Math.min(1, sim.rudderRate * 5.5);

    this.ropeGain[0].set(dB(-24) * trim, now);
    this.ropeFreq[0].set(700 + 900 * trim, now);
    this.ropePan[0].set(anchorWorld(sim, ANCHOR.deck), now);

    this.ropeGain[1].set(dB(-27) * steer, now);
    this.ropeFreq[1].set(420 + 500 * steer, now);
    this.ropePan[1].set(anchorWorld(sim, ANCHOR.wheel), now);

    // Blocks squeal when a yard is actually swinging.
    const load = Math.min(1, sim.braceRate * 2.2);
    this.squealGain.set(dB(-38) * load, now);
    this.squealFreq.set(900 + 1100 * load, now);
    this.squealVib.set(30 + 90 * load, now);
    this.squealPan.set(anchorWorld(sim, ANCHOR.deck), now);

    // Wheel pawl clicks and sheave knocks.
    const clickRate = steer * 9 + trim * 5;
    this.clickAccum += clickRate * dt;
    while (this.clickAccum > 1) {
      this.clickAccum -= 1;
      const r = this.rng();
      const atWheel = steer > trim;
      const a = atWheel ? ANCHOR.wheel : ANCHOR.deck;
      const p = toWorld(sim, a[0] + (r - 0.5) * 3, a[1], a[2] + (this.rng() - 0.5) * 6);
      const req = this.wood.begin(now + r * 0.03);
      req.gain = dB(-34) * (0.5 + 0.5 * r);
      req.low = 0.3;
      req.high = 0.7;
      req.type = 'bandpass';
      req.freq = 1400 + 2200 * r;
      req.q = 1.6;
      req.r1f = 320 + 260 * r;
      req.r1q = 11;
      req.r1db = 10;
      req.attack = 0.001;
      req.decay = 0.035 + 0.05 * r;
      req.x = p.x;
      req.y = p.y;
      req.z = p.z;
      this.wood.fire(now);
    }
  }

  /**
   * Structural creaking. `stress` is the load; what we listen to is `dStress`,
   * because timber is silent while it sits at a constant strain and talks while
   * the strain changes.
   */
  private creaks(sim: SimView, now: number, dt: number): void {
    const rigLoad = Math.min(1, (sim.drawArea / 2600) * smoothstep(2, 22, sim.apparentWind));
    const dStress =
      sim.rollRate * 2.4 +
      sim.pitchRate * 1.7 +
      sim.yawRate * 0.5 +
      Math.abs(sim.heaveAccel) * 0.035 +
      rigLoad * 0.06;

    const rate = Math.min(9, 0.35 + 26 * dStress);
    this.creakAccum += rate * dt;
    if (this.creakAccum <= 1) return;
    this.creakAccum = 0;

    // A cluster: the hull works several joints in quick succession.
    const heavy = smoothstep(0.06, 0.5, dStress);
    const count = 1 + Math.floor(this.rng() * (1 + 3 * heavy));
    for (let k = 0; k < count; k++) {
      const r = this.rng();
      const spot = CREAK_SPOTS[Math.floor(this.rng() * CREAK_SPOTS.length)];
      const p = toWorld(sim, spot[0] + (r - 0.5) * 2, spot[1], spot[2] + (this.rng() - 0.5) * 4);
      const size = (0.4 + 0.6 * this.rng()) * (0.55 + 0.75 * heavy) * (1 - 0.55 * (k / count));
      const long = this.rng() < 0.18 + 0.3 * heavy;
      const req = this.wood.begin(now + k * (0.02 + 0.14 * this.rng()));
      req.gain = dB(-27) * size;
      req.low = 0.6;
      req.high = 0.3;
      req.type = 'lowpass';
      req.freq = 1500 + 1400 * r;
      req.q = 0.9;
      // Two woody formants. White oak frames ring low and long.
      req.r1f = 130 + 210 * this.rng();
      req.r1q = 9 + 8 * this.rng();
      req.r1db = 14;
      req.r2f = 480 + 950 * this.rng();
      req.r2q = 7 + 8 * this.rng();
      req.r2db = 10;
      req.attack = long ? 0.05 : 0.003;
      req.hold = long ? 0.1 + 0.3 * this.rng() : 0;
      req.decay = long ? 0.5 + 0.9 * this.rng() : 0.1 + 0.35 * this.rng();
      req.soft = long;
      req.x = p.x;
      req.y = p.y;
      req.z = p.z;
      this.wood.fire(now);
    }
  }

  /** Flogging canvas. Loud, violent, and the loudest thing on the ship. */
  private flaps(sim: SimView, now: number, dt: number): void {
    const total = sim.drawArea + sim.luffArea;
    if (total < 1) return;
    const luffFrac = sim.luffArea / Math.max(1, total);
    const wind = Math.max(0, sim.windSpeed);
    const rate = Math.min(16, luffFrac * (1.4 + 0.5 * wind));
    this.flapAccum += rate * dt;

    // Which mast is flogging worst — the crack should come from there.
    let worst: SimSail | null = null;
    let worstScore = 0;
    for (const s of sim.sails) {
      const score = clamp01(s.luff) * s.area * clamp01(s.set);
      if (score > worstScore) {
        worstScore = score;
        worst = s;
      }
      const prev = this.prevLuff.get(s.id) ?? s.luff;
      // A sail breaking loose from drawing to flogging is a single big report.
      if (s.luff - prev > 0.22 && s.area * clamp01(s.set) > 120) {
        this.crack(sim, now, s, 1.25, wind);
      }
      this.prevLuff.set(s.id, s.luff);
    }

    while (this.flapAccum > 1) {
      this.flapAccum -= 1;
      if (!worst) break;
      this.crack(sim, now, worst, 0.35 + 0.65 * this.rng(), wind);
    }
  }

  private crack(sim: SimView, now: number, sail: SimSail, size: number, wind: number): void {
    const r = this.rng();
    const a = MAST_ANCHORS[Math.min(3, Math.max(0, sail.mast))];
    const tier = 0.6 + 0.25 * sail.tier;
    const p = toWorld(sim, (r - 0.5) * 14, a[1] * tier, a[2] + (this.rng() - 0.5) * 8);
    // Dynamic pressure on the cloth sets how violent the report is.
    const force = Math.min(1.5, (wind * wind) / 320) * size * Math.min(1.3, sail.area / 300);
    const req = this.canvas.begin(now + r * 0.02);
    req.gain = dB(-17) * force;
    req.low = 0.35 + 0.3 * size;
    req.high = 0.95;
    req.type = 'bandpass';
    req.freq = 400 + 900 * r;
    req.freqTo = 180 + 160 * r;
    req.sweepTime = 0.1 + 0.12 * size;
    req.q = 1.0 + 0.9 * r;
    req.r1f = 150 + 90 * r;
    req.r1q = 1.8;
    req.r1db = 5 + 6 * size;
    req.r2f = 2400 + 1800 * r;
    req.r2q = 1.1;
    req.r2db = 4;
    req.attack = 0.0015;
    req.decay = 0.05 + 0.28 * size;
    req.x = p.x;
    req.y = p.y;
    req.z = p.z;
    this.canvas.fire(now);

    // Big reports come as a double crack — the cloth snaps back.
    if (size > 0.75 && this.rng() < 0.6) {
      const q = this.canvas.begin(now + 0.028 + 0.03 * this.rng());
      q.gain = dB(-20) * force;
      q.low = 0.3;
      q.high = 0.9;
      q.type = 'bandpass';
      q.freq = 700 + 700 * this.rng();
      q.freqTo = 260;
      q.sweepTime = 0.08;
      q.q = 1.3;
      q.attack = 0.001;
      q.decay = 0.06 + 0.14 * size;
      q.x = p.x;
      q.y = p.y;
      q.z = p.z;
      this.canvas.fire(now);
    }
  }

  /**
   * Crew. Deliberately very sparse — one gesture every 40-110 s, and only when
   * the camera is close enough to plausibly hear a person.
   */
  private crew(sim: SimView, now: number, dt: number): void {
    if (sim.camDistance > 140) return;
    this.crewTimer -= dt;
    if (this.crewTimer > 0) return;
    this.crewTimer = 40 + this.rng() * 70;

    const roll = this.rng();
    const night = sim.sunAltitude < -0.05;
    if (roll < 0.5) this.footsteps(sim, now);
    else if (roll < 0.78 && !night) this.hail(sim, now);
    else this.pipe(sim, now);
  }

  private footsteps(sim: SimView, now: number): void {
    const n = 3 + Math.floor(this.rng() * 5);
    const x0 = (this.rng() - 0.5) * 9;
    const z0 = (this.rng() - 0.5) * 30;
    const dz = (this.rng() - 0.5) * 1.6;
    const gap = 0.3 + this.rng() * 0.16;
    for (let i = 0; i < n; i++) {
      const p = toWorld(sim, x0 + (this.rng() - 0.5) * 0.6, 4.6, z0 + dz * i * 2);
      const req = this.wood.begin(now + 0.1 + i * gap);
      req.gain = dB(-33) * (0.7 + 0.5 * this.rng());
      req.low = 0.85;
      req.high = 0.25;
      req.type = 'lowpass';
      req.freq = 700 + 500 * this.rng();
      req.q = 0.8;
      req.r1f = 105 + 60 * this.rng();
      req.r1q = 5;
      req.r1db = 11;
      req.r2f = 900;
      req.r2q = 3;
      req.r2db = 4;
      req.attack = 0.002;
      req.decay = 0.075 + 0.05 * this.rng();
      req.x = p.x;
      req.y = p.y;
      req.z = p.z;
      this.wood.fire(now);
    }
  }

  /** A shouted word or two, formant-filtered. Never intelligible, just human. */
  private hail(sim: SimView, now: number): void {
    const p = toWorld(sim, (this.rng() - 0.5) * 10, 6, (this.rng() - 0.5) * 34);
    const syllables = 1 + Math.floor(this.rng() * 2);
    let t = now + 0.15;
    for (let i = 0; i < syllables; i++) {
      const base = 110 + this.rng() * 70;
      const req = this.tones.begin(t);
      req.gain = dB(-30) * (0.7 + 0.5 * this.rng());
      req.f0 = base;
      req.f1 = base * (1.15 + 0.2 * this.rng());
      req.f2 = base * 0.82;
      req.attack = 0.03;
      req.hold = 0.1 + 0.16 * this.rng();
      req.decay = 0.14 + 0.12 * this.rng();
      req.buzz = 0.85;
      req.breath = 0.1;
      // Roughly /a/ and /o/ formants.
      req.fmt1 = i === 0 ? 700 : 520;
      req.fmt2 = i === 0 ? 1180 : 900;
      req.fmtQ = 4.5;
      req.vibrato = 3;
      req.vibratoHz = 5.5;
      req.x = p.x;
      req.y = p.y;
      req.z = p.z;
      this.tones.fire(now);
      t += 0.3 + 0.16 * this.rng();
    }
  }

  /** A bosun's call: two notes and a trill. */
  private pipe(sim: SimView, now: number): void {
    const p = toWorld(sim, (this.rng() - 0.5) * 6, 5.5, 8 + this.rng() * 10);
    const f = 1900 + this.rng() * 700;
    const req = this.tones.begin(now + 0.1);
    req.gain = dB(-34);
    req.f0 = f * 0.72;
    req.f1 = f;
    req.f2 = f * 1.02;
    req.attack = 0.05;
    req.hold = 0.42;
    req.decay = 0.12;
    req.buzz = 0.06;
    req.breath = 0.42;
    req.fmt1 = f;
    req.fmt2 = f * 2;
    req.fmtQ = 9;
    req.vibrato = 90;
    req.vibratoHz = 13;
    req.x = p.x;
    req.y = p.y;
    req.z = p.z;
    this.tones.fire(now);

    const up = this.tones.begin(now + 0.72);
    up.gain = dB(-35);
    up.f0 = f;
    up.f1 = f * 1.5;
    up.f2 = f * 1.48;
    up.attack = 0.04;
    up.hold = 0.3;
    up.decay = 0.16;
    up.buzz = 0.06;
    up.breath = 0.4;
    up.fmt1 = f * 1.5;
    up.fmt2 = f * 3;
    up.fmtQ = 9;
    up.vibrato = 70;
    up.vibratoHz = 12;
    up.x = p.x;
    up.y = p.y;
    up.z = p.z;
    this.tones.fire(now);
  }
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
