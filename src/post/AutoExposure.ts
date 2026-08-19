import * as THREE from 'three';
import type { World } from '../types';
import { damp } from '../util/math';
import { FullscreenPass } from './FullscreenPass';
import type { Targets } from './Targets';
import {
  EXPOSURE_ADAPT_FRAG,
  EXPOSURE_BINS,
  EXPOSURE_LUM_SIZE,
  EXPOSURE_MAX_LOG,
  EXPOSURE_MIN_LOG,
  EXPOSURE_STRIPS,
  HISTOGRAM_FRAG,
  HISTOGRAM_RESOLVE_FRAG,
  LUM_REDUCE_FRAG,
} from './shaders/exposure';

/**
 * Histogram auto-exposure, entirely GPU-resident.
 *
 * Three tiny passes build a centre-weighted log-luminance histogram of the frame
 * and resolve a **weighted percentile band**, not a mean. That distinction is
 * the whole point on an ocean: the sky is two thirds of most frames and several
 * stops brighter than the ship, so a plain average meters for the sky and
 * leaves the hull a silhouette. Discarding the brightest 20% (sky, sun glitter)
 * and the darkest 45% (shadowed sea) meters for the subject.
 *
 * A fourth one-fragment pass then does the adaptation itself and keeps the
 * result in a 1x1 RGBA32F texture that ping-pongs with itself. `prepare`, TAA
 * and the underwater pass sample that texture. **Nothing is ever read back to
 * the CPU**, which is the difference between a 6 ms frame and an 80 ms one:
 *
 * | readback variant | ms per call, idle box | ms per call, load average 100 |
 * |---|---|---|
 * | `readRenderTargetPixels`, 1x1 | 0.18 | (not measured, same class) |
 * | fenced PBO + `getBufferSubData` | ~0.2 | **117** |
 * | nothing — sample the texture | 0 | 0 |
 *
 * The fence was never the problem. `getBufferSubData` is a *synchronous IPC
 * round trip to Chrome's GPU process*, so its latency is set by how contended
 * the machine is, not by whether the GPU has finished. It also produced 160-200
 * `READ-usage buffer was written, then fenced, but written again before being
 * read back` warnings per capture. Both are gone with the readback itself.
 *
 * `exposure` on this class is therefore a CPU **estimate**, derived from the sky
 * model, for the HUD, `world.uniforms.uExposure` and diagnostic probes. It
 * tracks the GPU value to within about a stop and nothing visual depends on it.
 * Under `settings.debug` it is reconciled against the real value every
 * `DEBUG_READBACK_INTERVAL` frames, which costs a stall and is why it is
 * debug-only.
 *
 * Adaptation is asymmetric and *compressive*. Full compensation would map a
 * moonlit sea to the same middle grey as noon, which is exactly the "night is
 * grey mush" failure; above a knee the compensation is only partially applied,
 * so a six-stop-darker scene ends up about two and a half stops darker on
 * screen instead of identical. The curve lives in the shader; these constants
 * are its single source of truth and are uploaded as uniforms.
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
/**
 * Frames between measurements. The three metering passes are tiny in shading
 * terms but each is a separate render pass, which on a tile-based GPU costs a
 * fixed setup + flush no matter how few pixels it touches. The fastest
 * adaptation constant here is 0.4 s, so measuring at 20 Hz is already ~8x
 * faster than anything the adaptation can follow; every frame was pure waste.
 * The adapt pass itself still runs every frame, so the exposure ramp stays
 * smooth no matter how coarsely the histogram is refreshed.
 */
const METER_INTERVAL = 3;
/** Frames between the debug-only reconciliation read. Stalls, so keep it rare. */
const DEBUG_READBACK_INTERVAL = 60;

export class AutoExposure {
  /**
   * CPU **estimate** of the applied exposure, for the HUD and for probes. The
   * authoritative value is `texture`; see the class comment.
   */
  exposure = 1;

  /** 1x1 RGBA32F: (adaptedStops, exposure, previousExposure, measuredLog2). */
  get texture(): THREE.Texture {
    return this.state[this.current].texture;
  }

  private lumPass: FullscreenPass;
  private histPass: FullscreenPass;
  private resolvePass: FullscreenPass;
  private adaptPass: FullscreenPass;

  private state: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget] | null = null;
  private current = 0;
  private reset = true;

  private readonly readBuffer = new Float32Array(4);
  private debugCountdown = 0;

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
    this.resolvePass = new FullscreenPass('exposure/resolve', HISTOGRAM_RESOLVE_FRAG, {
      tPartial: { value: null },
      uBins: { value: EXPOSURE_BINS },
      uStrips: { value: EXPOSURE_STRIPS },
      uRange: { value: new THREE.Vector2(EXPOSURE_MIN_LOG, EXPOSURE_MAX_LOG) },
      uPercentile: { value: new THREE.Vector2(PERCENTILE_LOW, PERCENTILE_HIGH) },
    });
    this.adaptPass = new FullscreenPass('exposure/adapt', EXPOSURE_ADAPT_FRAG, {
      tState: { value: null },
      tResult: { value: null },
      uRange: { value: new THREE.Vector2(EXPOSURE_MIN_LOG, EXPOSURE_MAX_LOG) },
      uCurve: {
        value: new THREE.Vector4(Math.log2(KEY_VALUE), COMPENSATION_KNEE, COMPENSATION_SLOPE, 0),
      },
      uClamp: { value: new THREE.Vector2(MIN_GAIN_STOPS, MAX_GAIN_STOPS) },
      uRate: { value: new THREE.Vector2(RATE_BRIGHTEN, RATE_DARKEN) },
      uDt: { value: 1 / 60 },
      uBias: { value: 1 },
      uAuto: { value: 1 },
      uSeedLog: { value: -1 },
      uReset: { value: 1 },
    });
  }

  /** Throw the adaptation away on the next frame. Call after a cut. */
  invalidate(): void {
    this.reset = true;
    this.seeded = false;
  }

  /**
   * Meter the frame and advance the adaptation. `scene` is the pre-exposure HDR
   * colour; metering the already-exposed buffer would be a feedback loop with a
   * one-frame delay, which oscillates.
   *
   * Must run before `prepare`, which samples the state this writes.
   */
  run(world: World, scene: THREE.WebGLRenderTarget): void {
    const r = world.renderer;
    const t = this.targets;
    const s = world.settings;

    const result = t.get('expResult', 1, 1, 'rgba32f', { nearest: true });

    if (s.autoExposure && world.time.frame % METER_INTERVAL === 0) {
      const lum = t.get('expLum', EXPOSURE_LUM_SIZE, EXPOSURE_LUM_SIZE, 'r16f', { nearest: true });
      const partial = t.get('expPartial', EXPOSURE_BINS, EXPOSURE_STRIPS, 'r16f', { nearest: true });

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

      this.resolvePass.uniforms.tPartial.value = partial.texture;
      this.resolvePass.render(r, result);
    }

    this.adapt(world, result);
    if (s.debug) this.reconcile(r);
  }

  /** One fragment: fold this frame's measurement into the GPU-side state. */
  private adapt(world: World, result: THREE.WebGLRenderTarget): void {
    const s = world.settings;
    const st = this.ensureState();
    const next = this.current ^ 1;

    const u = this.adaptPass.uniforms;
    u.tState.value = st[this.current].texture;
    u.tResult.value = result.texture;
    u.uDt.value = Math.min(world.time.dt, 0.1);
    u.uBias.value = Math.pow(2, s.exposureBias);
    u.uAuto.value = s.autoExposure ? 1 : 0;
    u.uSeedLog.value = this.seedLog(world);
    u.uReset.value = this.reset ? 1 : 0;
    this.adaptPass.render(world.renderer, st[next]);

    this.current = next;
    this.reset = false;
  }

  private ensureState(): [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget] {
    if (!this.state) {
      this.state = [
        this.targets.get('expStateA', 1, 1, 'rgba32f', { nearest: true }),
        this.targets.get('expStateB', 1, 1, 'rgba32f', { nearest: true }),
      ];
    }
    return this.state;
  }

  /**
   * CPU mirror of the adaptation, run on the sky model rather than the frame.
   *
   * This is what `world.uniforms.uExposure` and the HUD see. It uses the same
   * curve as the shader so it tracks the real value across the day, but it
   * cannot see the ship, the foam or the inside of a hull, so treat it as an
   * estimate. Publishing it costs nothing and keeps every CPU-side consumer and
   * every diagnostic probe working without a readback.
   */
  update(world: World): void {
    const s = world.settings;
    const bias = Math.pow(2, s.exposureBias);

    if (!s.autoExposure) {
      this.exposure = bias;
      world.uniforms.uExposure.value = this.exposure;
      return;
    }

    const target = this.seedLog(world);
    if (!this.seeded) {
      this.measuredLog = target;
      this.adaptedStops = this.stopsFor(target);
      this.seeded = true;
    } else {
      this.measuredLog = damp(this.measuredLog, target, 4, Math.min(world.time.dt, 0.1));
    }

    const stops = this.stopsFor(this.measuredLog);
    const rate = stops > this.adaptedStops ? RATE_BRIGHTEN : RATE_DARKEN;
    this.adaptedStops = damp(this.adaptedStops, stops, rate, Math.min(world.time.dt, 0.1));

    this.exposure = Math.pow(2, this.adaptedStops) * bias;
    world.uniforms.uExposure.value = this.exposure;
    world.stats['post:exposureStops'] = this.adaptedStops;
    world.stats['post:sceneLog2Lum'] = this.measuredLog;
  }

  /** The shader's curve, in TypeScript. Keep the two in step. */
  private stopsFor(measuredLog: number): number {
    let stops = Math.log2(KEY_VALUE) - measuredLog;
    if (stops > COMPENSATION_KNEE) {
      stops = COMPENSATION_KNEE + (stops - COMPENSATION_KNEE) * COMPENSATION_SLOPE;
    }
    return Math.min(Math.max(stops, MIN_GAIN_STOPS), MAX_GAIN_STOPS);
  }

  /**
   * Scene log2 luminance predicted from the atmosphere. The sky agent publishes
   * absolute luminances when it is up; both reads are optional, and the shared
   * uniforms are the fallback because every scene fills those in.
   */
  private seedLog(world: World): number {
    const sky = world.ext.sky as { skyLuminance?: number; sunLuminance?: number } | undefined;
    let lum = typeof sky?.skyLuminance === 'number' && sky.skyLuminance > 0 ? sky.skyLuminance : 0;
    if (lum <= 0) {
      const u = world.uniforms;
      lum = Math.max(1e-4, u.uSunIntensity.value * 0.12 + u.uMoonIntensity.value * 0.02 + 0.02);
    }
    return Math.min(Math.max(Math.log2(Math.max(lum, 1e-6)), EXPOSURE_MIN_LOG), EXPOSURE_MAX_LOG);
  }

  /**
   * Debug only. Pulls the real GPU state back so probes and DIAGNOSIS see the
   * value that is actually on screen rather than the sky-model estimate. This
   * is a full pipeline + IPC stall — 0.2 ms idle, 117 ms on a loaded box — so
   * it is rate limited and never runs outside `settings.debug`.
   */
  private reconcile(r: THREE.WebGLRenderer): void {
    if (--this.debugCountdown > 0 || !this.state) return;
    this.debugCountdown = DEBUG_READBACK_INTERVAL;
    try {
      r.readRenderTargetPixels(this.state[this.current], 0, 0, 1, 1, this.readBuffer);
      const [stops, exposure, , measured] = this.readBuffer;
      if (Number.isFinite(exposure) && exposure > 0) {
        this.exposure = exposure;
        this.adaptedStops = stops;
        this.measuredLog = measured;
      }
    } catch {
      /* diagnostic only; the render path does not depend on this */
    }
  }

  dispose(): void {
    this.lumPass.dispose();
    this.histPass.dispose();
    this.resolvePass.dispose();
    this.adaptPass.dispose();
    this.state = null;
  }
}
