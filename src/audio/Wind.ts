import { smoothstep } from '../util/math';
import { ANCHOR, anchorWorld } from './Anchors';
import type { AudioBuffers } from './Buffers';
import type { Bus } from './Buses';
import { dB, freqRamp, Nodes, PanRamp, Ramp } from './Context';
import { RiggingBank } from './RiggingWorklet';
import type { SimView } from './Sim';

/**
 * Wind. Four things happening at once:
 *
 *  bed      pink noise, low-passed. Level AND cutoff both rise with wind speed,
 *           so a gust is heard as a swell and a brightening, not just louder.
 *  hiss     a separate high band that comes up faster than the bed, which is
 *           what makes gusts read as "sharp".
 *  buffet   low, chaotic, amplitude-modulated rumble — pressure on the ear.
 *           Scaled by camera exposure: strong at the masthead, gone at the helm.
 *  gunports two narrow resonances that only appear when you are down behind the
 *           bulwarks in a blow — air whistling past the ports.
 *
 * plus the rigging resonator bank (see RiggingWorklet.ts).
 */
export class Wind {
  readonly rigging: RiggingBank;
  private readonly bedGain: Ramp;
  private readonly bedLp: Ramp;
  private readonly bedHp: Ramp;
  private readonly hissGain: Ramp;
  private readonly hissHp: Ramp;
  private readonly buffetGain: Ramp;
  private readonly buffetLp: Ramp;
  private readonly portGain: Ramp[] = [];
  private readonly portFreq: Ramp[] = [];
  private readonly riggingPan: PanRamp;
  private readonly riggingDirect: Ramp;
  private readonly riggingPoint: Ramp;

  constructor(nodes: Nodes, buffers: AudioBuffers, bus: Bus, workletReady: boolean) {
    // --- broadband bed
    const src = nodes.loop(buffers.pink, 1.0);
    const hp = nodes.biquad('highpass', 70, 0.7);
    const lp = nodes.biquad('lowpass', 700, 0.8);
    const bed = nodes.gain(0.0001);
    src.connect(hp);
    hp.connect(lp);
    lp.connect(bed);
    bed.connect(bus.in);
    this.bedGain = new Ramp(bed.gain, 0.45, 2e-4);
    this.bedLp = freqRamp(lp.frequency, 0.5);
    this.bedHp = freqRamp(hp.frequency, 0.8);

    // --- high band, fed off the same source pre-lowpass
    const hiss = nodes.gain(0.0001);
    const hissHp = nodes.biquad('highpass', 2200, 0.7);
    src.connect(hissHp);
    hissHp.connect(hiss);
    hiss.connect(bus.in);
    this.hissGain = new Ramp(hiss.gain, 0.35, 2e-4);
    this.hissHp = freqRamp(hissHp.frequency, 0.5);

    // --- buffeting
    const bsrc = nodes.loop(buffers.fibre, 0.7);
    const blp = nodes.biquad('lowpass', 200, 2.4);
    const buffet = nodes.gain(0.0001);
    bsrc.connect(blp);
    blp.connect(buffet);
    buffet.connect(bus.in);
    this.buffetGain = new Ramp(buffet.gain, 0.5, 2e-4);
    this.buffetLp = freqRamp(blp.frequency, 0.7);

    // --- gunport whistles
    for (let i = 0; i < 2; i++) {
      const bp = nodes.biquad('bandpass', i === 0 ? 430 : 690, 13);
      const g = nodes.gain(0.0001);
      const pan = nodes.stereoPan(i === 0 ? -0.5 : 0.45);
      hp.connect(bp);
      bp.connect(g);
      g.connect(pan);
      pan.connect(bus.in);
      this.portFreq.push(freqRamp(bp.frequency, 0.8));
      this.portGain.push(new Ramp(g.gain, 0.7, 2e-4));
    }

    // --- rigging: mostly localised at the main masthead, with a wide component
    // so it still feels like it surrounds the whole rig.
    const rigSum = nodes.gain(1);
    const pointG = nodes.gain(0.75);
    const directG = nodes.gain(0.3);
    const pan = nodes.panner(26, 0.9, true);
    rigSum.connect(pointG);
    pointG.connect(pan);
    pan.connect(bus.in);
    rigSum.connect(directG);
    directG.connect(bus.in);
    this.riggingPan = new PanRamp(pan, 0.12);
    this.riggingPoint = new Ramp(pointG.gain, 0.5, 3e-4);
    this.riggingDirect = new Ramp(directG.gain, 0.5, 3e-4);
    this.rigging = new RiggingBank(nodes, buffers, rigSum, workletReady);
  }

  update(sim: SimView, now: number): void {
    const u = sim.windSpeed;
    const exposure = sim.exposure;
    const gustBright = 0.75 + 0.45 * Math.min(1.6, sim.gust);

    // Level rises with speed but never saturates — the sweep test asserts
    // monotonicity all the way to 25 m/s.
    //
    // The range used to be dB(-53) to dB(-19.9) — only 33 dB across the whole
    // Beaufort scale — and at the -13 dB bus trim that left a full gale QUIETER
    // than a sea-state-3 swell: measured, the whole mix moved 0.5 dB from 0 to
    // 25 m/s with the sea pinned, so the wind was inaudible at every speed. A
    // gale you cannot hear is not subordinate, it is broken. 51 dB of range now,
    // hung lower at the bottom and higher at the top, so light air is genuinely
    // nothing and a gale genuinely arrives.
    const base = dB(-62 + 51 * smoothstep(0.5, 27, u));
    const shelter = 0.5 + 0.85 * exposure;
    this.bedGain.set(base * shelter, now);
    this.bedLp.set((320 + 1500 * smoothstep(0, 26, u)) * gustBright * (0.7 + 0.4 * exposure), now);
    this.bedHp.set(58 + 40 * exposure, now);

    // The high band lags at low wind and overtakes in a blow.
    this.hissGain.set(dB(-70 + 48 * smoothstep(3, 28, u)) * shelter * gustBright, now);
    this.hissHp.set(3200 - 1100 * smoothstep(4, 24, u), now);

    const buffeting = smoothstep(0.25, 0.95, exposure) * smoothstep(3, 22, u);
    this.buffetGain.set(dB(-44 + 22 * smoothstep(4, 26, u)) * buffeting, now);
    this.buffetLp.set(140 + 260 * smoothstep(6, 26, u), now);

    const ports = smoothstep(9, 24, u) * (1 - exposure) * (1 - 0.5 * sim.rain);
    for (let i = 0; i < this.portGain.length; i++) {
      this.portGain[i].set(dB(-40) * ports, now);
      this.portFreq[i].set((i === 0 ? 430 : 690) * (0.85 + 0.25 * smoothstep(6, 26, u)), now);
    }

    // Rigging. Rain wets and damps the lines; distance thins the localised part.
    const d = Math.max(1, sim.camDistance);
    const near = 1 / (1 + d / 90);
    // The bank is summed into the bus TWICE — localised at the masthead and a
    // wide direct component — so its level has to account for both or the song
    // arrives 1 dB hotter than it reads. Subordinate, per AGENTS.md directive 5:
    // audible as the ship's own voice, never as the thing you are listening to.
    this.rigging.set(
      {
        wind: u,
        level: dB(-22) * (0.55 + 0.6 * exposure),
        shriek: smoothstep(15, 27, u),
        damp: sim.rain,
      },
      now,
    );
    this.riggingPoint.set(0.8, now);
    this.riggingDirect.set(0.24 * near, now);
    this.riggingPan.set(anchorWorld(sim, ANCHOR.mastMain), now);
  }
}
