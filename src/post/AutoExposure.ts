import * as THREE from 'three';
import type { World } from '../types';
import { damp } from '../util/math';
import { FullscreenPass } from './FullscreenPass';
import type { Targets } from './Targets';
import {
  EXPOSURE_BINS,
  EXPOSURE_LUM_SIZE,
  EXPOSURE_MAX_LOG,
  EXPOSURE_MIN_LOG,
  EXPOSURE_STRIPS,
  HISTOGRAM_FRAG,
  HISTOGRAM_REDUCE_FRAG,
  HISTOGRAM_RESOLVE_FRAG,
  LUM_REDUCE_FRAG,
} from './shaders/exposure';

/**
 * Histogram auto-exposure.
 *
 * Four tiny passes build a centre-weighted log-luminance histogram of the frame
 * and resolve a **weighted percentile band**, not a mean. That distinction is
 * the whole point on an ocean: the sky is two thirds of most frames and several
 * stops brighter than the ship, so a plain average meters for the sky and
 * leaves the hull a silhouette. Discarding the brightest 20% (sky, sun glitter)
 * and the darkest 45% (shadowed sea) meters for the subject.
 *
 * The result comes back to the CPU through an asynchronous 1x1 readback, so the
 * pipeline never stalls; the two-frame latency is nothing against a 0.4 s
 * adaptation. The scalar is published on `world.uniforms.uExposure` and applied
 * by the prepare pass, which means forward materials can read it but must not
 * pre-multiply by it.
 *
 * Adaptation is asymmetric and *compressive*. Full compensation would map a
 * moonlit sea to the same middle grey as noon, which is exactly the "night is
 * grey mush" failure; above a knee the compensation is only partially applied,
 * so a six-stop-darker scene ends up about two and a half stops darker on
 * screen instead of identical.
 */

/** Reflectance the metered band is exposed to. Middle grey. */
const KEY_VALUE = 0.18;
/** Percentile band kept by the resolve. */
const PERCENTILE_LOW = 0.45;
const PERCENTILE_HIGH = 0.8;
/** Stops of gain above which compensation stops being one-for-one. */
const COMPENSATION_KNEE = 1.4;
const COMPENSATION_SLOPE = 0.45;
const MAX_GAIN_STOPS = 4.5;
const MIN_GAIN_STOPS = -7.0;
/** Per-second damping rates. 1/rate is the 63% response time. */
const RATE_BRIGHTEN = 1 / 0.4;
const RATE_DARKEN = 1 / 1.5;

export class AutoExposure {
  /** Latest applied exposure multiplier, scene-linear. */
  exposure = 1;
  /** Exposure applied on the previous frame — the TAA history rescale. */
  previous = 1;

  private lumPass: FullscreenPass;
  private histPass: FullscreenPass;
  private reducePass: FullscreenPass;
  private resolvePass: FullscreenPass;

  private readonly readBuffer = new Float32Array(4);
  private reading = false;
  private asyncFailed = false;
  private syncCountdown = 0;

  private measuredLog = -1;
  private adaptedStops = 0;
  private seeded = false;

  constructor(private readonly targets: Targets) {
    this.lumPass = new FullscreenPass('exposure/lum', LUM_REDUCE_FRAG, {
      tScene: { value: null },
      uSceneTexel: { value: new THREE.Vector2() },
      uFootprint: { value: new THREE.Vector2() },
    });
    this.histPass = new FullscreenPass('exposure/histogram', HISTOGRAM_FRAG, {
      tLum: { value: null },
      uBins: { value: EXPOSURE_BINS },
      uStrips: { value: EXPOSURE_STRIPS },
      uLumSize: { value: EXPOSURE_LUM_SIZE },
      uRange: { value: new THREE.Vector2(EXPOSURE_MIN_LOG, EXPOSURE_MAX_LOG) },
    });
    this.reducePass = new FullscreenPass('exposure/reduce', HISTOGRAM_REDUCE_FRAG, {
      tPartial: { value: null },
      uStrips: { value: EXPOSURE_STRIPS },
    });
    this.resolvePass = new FullscreenPass('exposure/resolve', HISTOGRAM_RESOLVE_FRAG, {
      tHistogram: { value: null },
      uBins: { value: EXPOSURE_BINS },
      uRange: { value: new THREE.Vector2(EXPOSURE_MIN_LOG, EXPOSURE_MAX_LOG) },
      uPercentile: { value: new THREE.Vector2(PERCENTILE_LOW, PERCENTILE_HIGH) },
    });
  }

  /**
   * Meter the frame. `scene` is the pre-exposure HDR colour; metering the
   * already-exposed buffer would be a feedback loop with a one-frame delay,
   * which oscillates.
   */
  meter(world: World, scene: THREE.WebGLRenderTarget): void {
    const r = world.renderer;
    const t = this.targets;

    const lum = t.get('expLum', EXPOSURE_LUM_SIZE, EXPOSURE_LUM_SIZE, 'r16f', { nearest: true });
    const partial = t.get('expPartial', EXPOSURE_BINS, EXPOSURE_STRIPS, 'r16f', { nearest: true });
    const hist = t.get('expHist', EXPOSURE_BINS, 1, 'r16f', { nearest: true });
    const result = t.get('expResult', 1, 1, 'rgba32f', { nearest: true });

    const lu = this.lumPass.uniforms;
    lu.tScene.value = scene.texture;
    (lu.uSceneTexel.value as THREE.Vector2).set(1 / scene.width, 1 / scene.height);
    (lu.uFootprint.value as THREE.Vector2).set(
      scene.width / EXPOSURE_LUM_SIZE,
      scene.height / EXPOSURE_LUM_SIZE,
    );
    this.lumPass.render(r, lum);

    this.histPass.uniforms.tLum.value = lum.texture;
    this.histPass.render(r, partial);

    this.reducePass.uniforms.tPartial.value = partial.texture;
    this.reducePass.render(r, hist);

    this.resolvePass.uniforms.tHistogram.value = hist.texture;
    this.resolvePass.render(r, result);

    this.readback(r, result);
  }

  private readback(r: THREE.WebGLRenderer, result: THREE.WebGLRenderTarget): void {
    if (this.asyncFailed) {
      // Sync fallback: a 1x1 read still flushes the pipeline, so throttle hard.
      if (--this.syncCountdown > 0) return;
      this.syncCountdown = 6;
      try {
        r.readRenderTargetPixels(result, 0, 0, 1, 1, this.readBuffer);
        this.accept(this.readBuffer[0], this.readBuffer[1]);
      } catch {
        /* metering unavailable; adaptation freezes at the last good value */
      }
      return;
    }
    if (this.reading) return;
    this.reading = true;
    r.readRenderTargetPixelsAsync(result, 0, 0, 1, 1, this.readBuffer)
      .then(() => {
        this.accept(this.readBuffer[0], this.readBuffer[1]);
        this.reading = false;
      })
      .catch(() => {
        this.asyncFailed = true;
        this.reading = false;
      });
  }

  private accept(meanLog: number, weight: number): void {
    if (!Number.isFinite(meanLog) || weight <= 0) return;
    this.measuredLog = Math.min(Math.max(meanLog, EXPOSURE_MIN_LOG), EXPOSURE_MAX_LOG);
  }

  /** Fold this frame's measurement into the adaptation and publish it. */
  update(world: World): void {
    const s = world.settings;
    const bias = Math.pow(2, s.exposureBias);

    if (!s.autoExposure) {
      this.previous = this.exposure;
      this.exposure = bias;
      world.uniforms.uExposure.value = this.exposure;
      return;
    }

    if (!this.seeded) this.seed(world);

    let stops = Math.log2(KEY_VALUE) - this.measuredLog;
    if (stops > COMPENSATION_KNEE) {
      stops = COMPENSATION_KNEE + (stops - COMPENSATION_KNEE) * COMPENSATION_SLOPE;
    }
    stops = Math.min(Math.max(stops, MIN_GAIN_STOPS), MAX_GAIN_STOPS);

    // Asymmetric: the image brightens in ~0.4 s and darkens in ~1.5 s, so
    // ducking below deck reads immediately and coming back up gives the
    // momentary flare a real eye does.
    const rate = stops > this.adaptedStops ? RATE_BRIGHTEN : RATE_DARKEN;
    this.adaptedStops = damp(this.adaptedStops, stops, rate, Math.min(world.time.dt, 0.1));

    this.previous = this.exposure;
    this.exposure = Math.pow(2, this.adaptedStops) * bias;
    world.uniforms.uExposure.value = this.exposure;
    world.stats['post:exposureStops'] = this.adaptedStops;
    world.stats['post:sceneLog2Lum'] = this.measuredLog;
  }

  /**
   * First-frame seed. Without it the first visible frame is metered from a
   * black histogram and flashes. The sky agent publishes absolute luminances
   * when it is up; both reads are optional.
   */
  private seed(world: World): void {
    const sky = world.ext.sky as { skyLuminance?: number; sunLuminance?: number } | undefined;
    let lum = typeof sky?.skyLuminance === 'number' && sky.skyLuminance > 0 ? sky.skyLuminance : 0;
    if (lum <= 0) {
      // Fall back to the shared uniforms, which every scene fills in.
      const u = world.uniforms;
      lum = Math.max(1e-4, u.uSunIntensity.value * 0.12 + u.uMoonIntensity.value * 0.02 + 0.02);
    }
    this.measuredLog = Math.log2(Math.max(lum, 1e-6));
    this.adaptedStops = Math.min(
      Math.max(Math.log2(KEY_VALUE) - this.measuredLog, MIN_GAIN_STOPS),
      MAX_GAIN_STOPS,
    );
    this.exposure = Math.pow(2, this.adaptedStops);
    this.previous = this.exposure;
    this.seeded = true;
  }

  dispose(): void {
    this.lumPass.dispose();
    this.histPass.dispose();
    this.reducePass.dispose();
    this.resolvePass.dispose();
  }
}
