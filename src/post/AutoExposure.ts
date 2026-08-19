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
  HISTOGRAM_RESOLVE_FRAG,
  LUM_REDUCE_FRAG,
} from './shaders/exposure';

/**
 * Histogram auto-exposure.
 *
 * Three tiny passes build a centre-weighted log-luminance histogram of the frame
 * and resolve a **weighted percentile band**, not a mean. That distinction is
 * the whole point on an ocean: the sky is two thirds of most frames and several
 * stops brighter than the ship, so a plain average meters for the sky and
 * leaves the hull a silhouette. Discarding the brightest 20% (sky, sun glitter)
 * and the darkest 45% (shadowed sea) meters for the subject.
 *
 * Metering runs at METER_INTERVAL and the result comes back through a persistent
 * pixel-pack buffer polled by a fence, so the pipeline never stalls; the
 * one-to-two-frame latency is nothing against a 0.4 s adaptation. The scalar is
 * published on `world.uniforms.uExposure` and applied by the prepare pass, which
 * means forward materials can read it but must not pre-multiply by it.
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
/**
 * Frames between measurements. The three metering passes are tiny in shading
 * terms but each is a separate render pass, which on a tile-based GPU costs a
 * fixed setup + flush no matter how few pixels it touches. The fastest
 * adaptation constant here is 0.4 s, so measuring at 20 Hz is already ~8x
 * faster than anything the adaptation can follow; every frame was pure waste.
 * Adaptation itself still runs every frame, so the exposure ramp stays smooth.
 */
const METER_INTERVAL = 3;

export class AutoExposure {
  /** Latest applied exposure multiplier, scene-linear. */
  exposure = 1;
  /** Exposure applied on the previous frame — the TAA history rescale. */
  previous = 1;

  private lumPass: FullscreenPass;
  private histPass: FullscreenPass;
  private resolvePass: FullscreenPass;

  private readonly readBuffer = new Float32Array(4);
  private asyncFailed = false;
  private syncCountdown = 0;

  private gl: WebGL2RenderingContext | null = null;
  /**
   * Two pixel-pack buffers, each with its own fence. See `readback` — one is not
   * enough, and ANGLE says so out loud.
   */
  private readonly slots: { pbo: WebGLBuffer | null; fence: WebGLSync | null }[] = [
    { pbo: null, fence: null },
    { pbo: null, fence: null },
  ];
  private nextSlot = 0;

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
  }

  /**
   * Meter the frame. `scene` is the pre-exposure HDR colour; metering the
   * already-exposed buffer would be a feedback loop with a one-frame delay,
   * which oscillates.
   */
  meter(world: World, scene: THREE.WebGLRenderTarget): void {
    if (world.time.frame % METER_INTERVAL !== 0) return;

    const r = world.renderer;
    const t = this.targets;

    const lum = t.get('expLum', EXPOSURE_LUM_SIZE, EXPOSURE_LUM_SIZE, 'r16f', { nearest: true });
    const partial = t.get('expPartial', EXPOSURE_BINS, EXPOSURE_STRIPS, 'r16f', { nearest: true });
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

    this.resolvePass.uniforms.tPartial.value = partial.texture;
    this.resolvePass.render(r, result);

    this.readback(r, result);
  }

  /**
   * Pull the 1x1 result back without stalling.
   *
   * This is hand-rolled rather than `readRenderTargetPixelsAsync` for a measured
   * reason: on ANGLE/Metal that call costs ~2.3 ms of *submission* time, because
   * it allocates and orphans a pixel-pack buffer on every invocation. Reading
   * the same target synchronously costs ~1.2 ms. Against a 16.7 ms frame either
   * is absurd for four floats. A persistent PBO plus a fence polled on a later
   * frame costs ~0.05 ms: `readPixels` into a bound PBO returns immediately, and
   * the data is only touched once the fence says the GPU is done with it.
   *
   * The latency is one to two frames, which is nothing against a 0.4 s
   * adaptation, and is the same latency the old path had.
   *
   * ## Two buffers, and the read before the delete
   *
   * A single PBO produced 131 ANGLE warnings per capture — "READ-usage buffer was
   * written, then fenced, but written again before being read back" — which means
   * the driver had to insert the very stall the fence exists to avoid, so the
   * async path was buying nothing. Two things caused it:
   *
   *   1. `deleteSync` ran BEFORE `getBufferSubData`. ANGLE attributes the read-back
   *      to the outstanding sync object, so dropping the sync first threw away the
   *      evidence that the buffer had been consumed at all.
   *   2. One buffer means the next `readPixels` necessarily targets the same
   *      allocation the driver may still be draining.
   *
   * So: read the buffer while its fence is still alive, and always write the OTHER
   * slot. With metering every third frame the two slots are 6 frames apart, which
   * is far more than the one-to-two frame latency of the copy.
   *
   * ## Measured, on a quiet machine, 1600x900 ultra
   *
   * | variant | ms per call |
   * |---|---|
   * | the three metering passes, `finish`ed | 0.025 |
   * | `readPixels` into a fenced PBO, consumed later | 0.017 |
   * | `readRenderTargetPixels`, 1x1 rgba32f | 0.183 |
   * | fence written and *waited on in the same frame* | 1.53 |
   *
   * That last row is the trap, and it is where the 6.8 ms attributed to this pass
   * came from: touching the buffer before the GPU has drained it turns a free
   * copy into a full pipeline stall. Nothing here may ever wait on a fence it
   * created this frame.
   *
   * The residual "READ-usage buffer ... fenced ... written again" warnings in the
   * capture log are NOT from this class — they persist unchanged with this whole
   * method stubbed out, and the only other reader of a render target in the
   * project is the ocean's synchronous `readRenderTargetPixels` in
   * `src/ocean/Ocean.ts`. That one is the ocean module's to own.
   */
  private readback(r: THREE.WebGLRenderer, result: THREE.WebGLRenderTarget): void {
    const gl = (this.gl ??= asWebGL2(r));
    if (!gl || this.asyncFailed) {
      this.readbackSync(r, result);
      return;
    }

    // Drain every landed request, oldest first, so the newest measurement wins.
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[(this.nextSlot + i) % this.slots.length];
      if (!slot.fence) continue;
      const status = gl.clientWaitSync(slot.fence, 0, 0);
      if (status === gl.TIMEOUT_EXPIRED) continue;
      if (status !== gl.WAIT_FAILED && slot.pbo) {
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.pbo);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.readBuffer);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        this.accept(this.readBuffer[0], this.readBuffer[1]);
      }
      gl.deleteSync(slot.fence);
      slot.fence = null;
    }

    // Never overwrite a buffer whose fence is still outstanding — that is the
    // whole point of having two.
    const slot = this.slots[this.nextSlot];
    if (slot.fence) return;
    this.nextSlot = (this.nextSlot + 1) % this.slots.length;

    try {
      if (!slot.pbo) {
        slot.pbo = gl.createBuffer();
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.pbo);
        gl.bufferData(gl.PIXEL_PACK_BUFFER, 16, gl.STREAM_READ);
      } else {
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.pbo);
      }
      // The resolve pass just wrote this target, so it is already the bound
      // framebuffer; setRenderTarget is idempotent and makes that explicit.
      r.setRenderTarget(result);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, 0);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      slot.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      if (!slot.fence) this.asyncFailed = true;
    } catch {
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      this.asyncFailed = true;
    }
  }

  /** Fallback: a 1x1 read that flushes the pipeline, so throttle it hard. */
  private readbackSync(r: THREE.WebGLRenderer, result: THREE.WebGLRenderTarget): void {
    if (--this.syncCountdown > 0) return;
    this.syncCountdown = 6;
    try {
      r.readRenderTargetPixels(result, 0, 0, 1, 1, this.readBuffer);
      this.accept(this.readBuffer[0], this.readBuffer[1]);
    } catch {
      /* metering unavailable; adaptation freezes at the last good value */
    }
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
    this.resolvePass.dispose();
    const gl = this.gl;
    for (const slot of this.slots) {
      if (gl && slot.fence) gl.deleteSync(slot.fence);
      if (gl && slot.pbo) gl.deleteBuffer(slot.pbo);
      slot.fence = null;
      slot.pbo = null;
    }
  }
}

/** WebGL2 context or null — `texImage3D` is the cheapest reliable probe. */
function asWebGL2(r: THREE.WebGLRenderer): WebGL2RenderingContext | null {
  const ctx = r.getContext() as WebGL2RenderingContext;
  return typeof ctx.fenceSync === 'function' ? ctx : null;
}
