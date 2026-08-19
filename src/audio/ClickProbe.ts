/**
 * Online discontinuity detector.
 *
 * `Probe.ts` measures an `OfflineAudioContext`, which is deterministic and fast
 * but structurally blind to the defect that actually reaches the player: offline,
 * nothing has been rendered when the driving loop runs, so an event scheduled at
 * `currentTime + 2 ms` is comfortably in the future. Online the audio thread has
 * already rendered past `currentTime`, the same event lands in the PAST, and an
 * attack ramp collapses into a step. The offline render sounds perfect and the
 * game clicks.
 *
 * So the acceptance test has to listen to the LIVE graph. This taps the master
 * output with an `AudioWorkletNode` that runs the same detector as
 * `Probe.countClicks`, per sample, on the audio thread — the only place with
 * access to every sample the player actually hears. It is created on demand by
 * `scripts/audio-test.mjs` (`world.ext.audio.watch(true)`) and is not part of the
 * rig: nothing here runs in a normal session.
 */

/**
 * A jump this many times the local jump RMS counts as a click.
 *
 * For band-limited noise the first difference is Gaussian, so the largest value
 * in a five-second window at 48 kHz sits near 5 sigma. 12 leaves a wide margin
 * against false positives while still catching an envelope that steps by a few
 * percent of a narrow-band signal.
 *
 * Shared with `Probe.ts` so the offline and online counts mean the same thing.
 */
export const CLICK_RATIO = 12;

/** Jumps quieter than this are inaudible under a sea bed. */
export const CLICK_FLOOR_DB = -66;

/** Analysis window for the local jump RMS, seconds. */
export const CLICK_WINDOW_S = 0.02;
/** The window stops this far behind the candidate so it cannot raise its own threshold. */
export const CLICK_GUARD_S = 0.001;
/** Detections closer together than this are one click. */
export const CLICK_GROUP_S = 0.003;

export interface WatchStats {
  /** Seconds of audio examined, per channel. */
  seconds: number;
  /** Discontinuities found, summed over channels. */
  clicks: number;
  clickRate: number;
  /** Largest flagged jump, dBFS. -240 when none was found. */
  worstJumpDb: number;
  /** Largest jump / local jump RMS. */
  worstRatio: number;
  peak: number;
  peakDb: number;
  /** Samples at or above full scale. Must be 0. */
  clipped: number;
  /** Mean sample value. Anything but ~0 is a DC offset eating headroom. */
  dc: number;
  /** NaN / Inf samples. Must be 0. */
  nonFinite: number;
  /** Subnormal samples — not audible, but they cost the audio thread dearly. */
  denormal: number;
  /** The first few detections: seconds since reset, and how far over threshold. */
  events: { t: number; ratio: number; db: number }[];
}

const WORKLET_NAME = 'click-probe';

const SRC = `
const RATIO = ${CLICK_RATIO};
const FLOOR = ${Math.pow(10, CLICK_FLOOR_DB / 20)};
const WIN_S = ${CLICK_WINDOW_S};
const GUARD_S = ${CLICK_GUARD_S};
const GROUP_S = ${CLICK_GROUP_S};
const MAX_EVENTS = 16;

class ClickProbeProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.win = Math.max(16, Math.round(WIN_S * sampleRate));
    this.guard = Math.max(2, Math.round(GUARD_S * sampleRate));
    this.group = Math.max(4, Math.round(GROUP_S * sampleRate));
    this.ringLen = this.win + this.guard + 4;
    this.ch = [];
    this.reset();
    this.port.onmessage = (e) => {
      const msg = e.data;
      if (msg === 'get' || (msg && msg.cmd === 'get')) {
        this.port.postMessage(this.stats());
        if (msg && msg.reset) this.reset();
      } else if (msg === 'reset' || (msg && msg.cmd === 'reset')) {
        this.reset();
      }
    };
  }

  channel() {
    return {
      prev: 0,
      ring: new Float32Array(this.ringLen),
      i: 0,
      sum: 0,
      lastAt: -1e9,
      clicks: 0,
      worstJump: 0,
      worstRatio: 0,
    };
  }

  reset() {
    for (const c of this.ch) Object.assign(c, this.channel());
    this.n = 0;
    this.peak = 0;
    this.dc = 0;
    this.clipped = 0;
    this.nonFinite = 0;
    this.denormal = 0;
    this.events = [];
  }

  stats() {
    let clicks = 0;
    let worstJump = 0;
    let worstRatio = 0;
    for (const c of this.ch) {
      clicks += c.clicks;
      if (c.worstJump > worstJump) worstJump = c.worstJump;
      if (c.worstRatio > worstRatio) worstRatio = c.worstRatio;
    }
    const seconds = this.n / sampleRate;
    return {
      seconds,
      clicks,
      clickRate: seconds > 1e-6 ? clicks / seconds : 0,
      worstJumpDb: worstJump > 1e-12 ? 20 * Math.log10(worstJump) : -240,
      worstRatio,
      peak: this.peak,
      peakDb: this.peak > 1e-12 ? 20 * Math.log10(this.peak) : -240,
      clipped: this.clipped,
      dc: this.n > 0 ? this.dc / (this.n * Math.max(1, this.ch.length)) : 0,
      nonFinite: this.nonFinite,
      denormal: this.denormal,
      events: this.events,
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const out = outputs[0];
    // Output silence: this node is only pulled because it is connected onward.
    for (let c = 0; c < out.length; c++) out[c].fill(0);
    if (!input || input.length === 0 || !input[0]) return true;

    while (this.ch.length < input.length) this.ch.push(this.channel());
    const frames = input[0].length;

    for (let c = 0; c < input.length; c++) {
      const d = input[c];
      const st = this.ch[c];
      const ring = st.ring;
      const len = this.ringLen;
      const win = this.win;
      const guard = this.guard;
      for (let i = 0; i < frames; i++) {
        let v = d[i];
        if (!Number.isFinite(v)) {
          this.nonFinite++;
          v = 0;
        } else {
          const a = v < 0 ? -v : v;
          if (a > this.peak) this.peak = a;
          if (a >= 1) this.clipped++;
          // 2^-126: below this a float is subnormal and the FPU takes a slow path.
          if (a > 0 && a < 1.1754944e-38) this.denormal++;
          this.dc += v;
        }
        const diff = v - st.prev;
        st.prev = v;
        ring[st.i] = diff;

        const local = Math.sqrt(st.sum / win);
        const mag = diff < 0 ? -diff : diff;
        const t = this.n + i;
        if (t > win + guard && mag > FLOOR && local > 1e-9 && mag > RATIO * local) {
          if (t - st.lastAt > this.group) {
            st.clicks++;
            if (this.events.length < MAX_EVENTS) {
              this.events.push({
                t: t / sampleRate,
                ratio: mag / local,
                db: 20 * Math.log10(mag),
              });
            }
          }
          st.lastAt = t;
          if (mag > st.worstJump) st.worstJump = mag;
          const ratio = mag / local;
          if (ratio > st.worstRatio) st.worstRatio = ratio;
        }

        // Slide the window forward one sample, still ending 'guard' behind.
        const add = ring[(st.i - guard + len) % len];
        const drop = ring[(st.i - guard - win + len) % len];
        st.sum += add * add - drop * drop;
        if (st.sum < 0) st.sum = 0;
        st.i = st.i + 1 === len ? 0 : st.i + 1;
      }
    }
    this.n += frames;
    return true;
  }
}

registerProcessor('${WORKLET_NAME}', ClickProbeProcessor);
`;

const registered = new WeakMap<BaseAudioContext, Promise<boolean>>();

/** Register the detector once per context. Never throws. */
function register(ctx: BaseAudioContext): Promise<boolean> {
  const existing = registered.get(ctx);
  if (existing) return existing;
  const p = (async () => {
    if (typeof AudioWorkletNode === 'undefined' || !ctx.audioWorklet) return false;
    let url = '';
    try {
      url = URL.createObjectURL(new Blob([SRC], { type: 'text/javascript' }));
      await ctx.audioWorklet.addModule(url);
      return true;
    } catch {
      return false;
    } finally {
      if (url) URL.revokeObjectURL(url);
    }
  })();
  registered.set(ctx, p);
  return p;
}

/**
 * A detector tapped off `tap`.
 *
 * Its nodes are created straight from the context rather than through `Nodes`,
 * deliberately: this is an instrument, not part of the rig, and counting it would
 * make the node-census assertions depend on whether a test happened to be
 * watching. It is silent — the output is zeroed and then multiplied by zero
 * again on the way to the destination, which is only there because a worklet is
 * not pulled unless something downstream asks for it.
 */
export class ClickWatcher {
  private constructor(
    private readonly node: AudioWorkletNode,
    private readonly sink: GainNode,
    private readonly tap: AudioNode,
  ) {}

  static async attach(ctx: AudioContext, tap: AudioNode): Promise<ClickWatcher | null> {
    if (!(await register(ctx))) return null;
    try {
      const node = new AudioWorkletNode(ctx, WORKLET_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 2,
        channelCountMode: 'explicit',
        channelInterpretation: 'discrete',
      });
      const sink = ctx.createGain();
      sink.gain.value = 0;
      tap.connect(node);
      node.connect(sink);
      sink.connect(ctx.destination);
      return new ClickWatcher(node, sink, tap);
    } catch {
      return null;
    }
  }

  /** Read the counters. `reset` starts a fresh measurement window afterwards. */
  stats(reset = false): Promise<WatchStats> {
    return new Promise<WatchStats>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.node.port.onmessage = null;
        reject(new Error('click probe did not answer'));
      }, 2000);
      this.node.port.onmessage = (e: MessageEvent): void => {
        clearTimeout(timer);
        this.node.port.onmessage = null;
        resolve(e.data as WatchStats);
      };
      this.node.port.postMessage({ cmd: 'get', reset });
    });
  }

  reset(): void {
    this.node.port.postMessage({ cmd: 'reset' });
  }

  detach(): void {
    try {
      this.tap.disconnect(this.node);
    } catch {
      /* already detached */
    }
    try {
      this.node.disconnect();
      this.sink.disconnect();
    } catch {
      /* already detached */
    }
  }
}
