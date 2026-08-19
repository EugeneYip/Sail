import { makeRng, smoothstep } from '../util/math';
import { toWorld } from './Anchors';
import { dB, eventTime } from './Context';
import type { SimView } from './Sim';
import type { NoisePool, TonePool } from './Voices';

/**
 * Seabirds and cetaceans. Both are rare on purpose: the point of a gull cry is
 * that it makes the empty ocean feel bigger, and that only works if you have not
 * heard one for a minute or two. Gulls get commoner near land; dolphins only turn
 * up when there is a bow wave worth riding.
 */
export class Wildlife {
  private readonly rng = makeRng(0xb17d5);
  private gullTimer = 12;
  private cetTimer = 90;

  constructor(
    private readonly tones: TonePool,
    private readonly impacts: NoisePool,
    private readonly clicks: NoisePool,
  ) {}

  update(sim: SimView, now: number): void {
    const dt = Math.min(0.1, Math.max(0, sim.dt));
    const nearLand = smoothstep(4000, 400, sim.landDistance);

    this.gullTimer -= dt * (1 + 4 * nearLand);
    if (this.gullTimer <= 0) {
      this.gullTimer = 26 + this.rng() * 55;
      this.gull(sim, now, nearLand);
    }

    this.cetTimer -= dt;
    if (this.cetTimer <= 0) {
      this.cetTimer = 150 + this.rng() * 260;
      if (this.rng() < 0.45 && sim.speedKnots > 2.5) this.dolphins(sim, now);
      else this.whaleBlow(sim, now);
    }
  }

  /** Two to four descending syllables, harsh and formant-heavy. */
  private gull(sim: SimView, now: number, nearLand: number): void {
    const bearing = this.rng() * Math.PI * 2;
    const dist = 40 + this.rng() * 160 * (1 - 0.4 * nearLand);
    const p = toWorld(
      sim,
      Math.sin(bearing) * dist,
      14 + this.rng() * 45,
      -Math.cos(bearing) * dist,
    );
    const n = 2 + Math.floor(this.rng() * 3);
    const base = 950 + this.rng() * 750;
    let t = eventTime(now, 0.1);
    for (let i = 0; i < n; i++) {
      const fall = Math.pow(0.88, i);
      const req = this.tones.begin(t);
      req.gain = dB(-27) * (0.55 + 0.5 * this.rng()) * (1 - 0.12 * i);
      req.f0 = base * fall * 0.8;
      req.f1 = base * fall * 1.25;
      req.f2 = base * fall * 0.62;
      req.attack = 0.02;
      req.hold = 0.07 + 0.1 * this.rng();
      req.decay = 0.1 + 0.12 * this.rng();
      req.buzz = 0.92;
      req.breath = 0.18;
      req.fmt1 = 1500 + 700 * this.rng();
      req.fmt2 = 3100 + 900 * this.rng();
      req.fmtQ = 6;
      req.vibrato = 25 + 40 * this.rng();
      req.vibratoHz = 16 + 12 * this.rng();
      req.x = p.x;
      req.y = p.y;
      req.z = p.z;
      this.tones.fire(now);
      t += 0.22 + 0.18 * this.rng();
    }
  }

  /** A blow: a big wet exhale, low and broadband, with a long tail. */
  private whaleBlow(sim: SimView, now: number): void {
    const side = this.rng() < 0.5 ? -1 : 1;
    const dist = 25 + this.rng() * 70;
    const p = toWorld(sim, side * dist, 1, (this.rng() - 0.5) * 60);
    const req = this.impacts.begin(eventTime(now, 0.05));
    req.gain = dB(-24) * (0.6 + 0.5 * this.rng());
    req.low = 0.55;
    req.high = 0.95;
    req.type = 'bandpass';
    req.freq = 260 + 200 * this.rng();
    req.freqTo = 900 + 500 * this.rng();
    req.sweepTime = 0.4;
    req.q = 0.7;
    req.r1f = 120;
    req.r1q = 1.4;
    req.r1db = 8;
    req.soft = true;
    req.attack = 0.045;
    req.hold = 0.2 + 0.2 * this.rng();
    req.decay = 1.1 + 0.9 * this.rng();
    req.x = p.x;
    req.y = p.y;
    req.z = p.z;
    this.impacts.fire(now);
  }

  /** Click train plus a whistle, up under the bow. */
  private dolphins(sim: SimView, now: number): void {
    const p = toWorld(sim, (this.rng() - 0.5) * 12, 0.5, -24 - this.rng() * 10);
    const n = 4 + Math.floor(this.rng() * 6);
    let t = eventTime(now, 0.05);
    for (let i = 0; i < n; i++) {
      const req = this.clicks.begin(t);
      req.gain = dB(-37) * (0.5 + 0.6 * this.rng());
      req.low = 0;
      req.high = 1;
      req.type = 'bandpass';
      req.freq = 5200 + 4200 * this.rng();
      req.q = 3.5;
      req.attack = 0.0015;
      req.decay = 0.01 + 0.01 * this.rng();
      req.x = p.x;
      req.y = p.y;
      req.z = p.z;
      this.clicks.fire(now);
      t += 0.035 + 0.05 * this.rng();
    }
    const w = this.tones.begin(t + 0.05);
    const f = 5600 + this.rng() * 3200;
    w.gain = dB(-32);
    w.f0 = f * 0.7;
    w.f1 = f * 1.4;
    w.f2 = f;
    w.attack = 0.012;
    w.hold = 0.05 + 0.08 * this.rng();
    w.decay = 0.07;
    w.buzz = 0.02;
    w.breath = 0.03;
    w.fmt1 = f;
    w.fmt2 = f * 1.8;
    w.fmtQ = 8;
    w.vibrato = 120;
    w.vibratoHz = 22;
    w.x = p.x;
    w.y = p.y;
    w.z = p.z;
    this.tones.fire(now);
  }
}
