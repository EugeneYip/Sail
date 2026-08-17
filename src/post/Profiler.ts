import type * as THREE from 'three';

/**
 * Per-pass timing.
 *
 * Chrome does not expose `EXT_disjoint_timer_query_webgl2` to unprivileged
 * pages, so the honest fallback is a *serialising* CPU timer: with
 * `syncMode` on we flush the pipeline between passes, which makes each
 * measurement a true GPU cost at the price of destroying overlap. That mode is
 * only ever enabled by `world.ext.post.profile()`, never in normal play.
 *
 * With `syncMode` off the numbers are submission cost only and are labelled as
 * such; they are still useful for spotting a pass that has gone quadratic.
 */
export class Profiler {
  syncMode = false;
  enabled = false;

  private gl: WebGL2RenderingContext | null = null;
  private t0 = 0;
  private current = '';
  private samples = new Map<string, { sum: number; n: number }>();
  /** Smoothed last-frame values, exposed on world.stats. */
  readonly ms = new Map<string, number>();

  attach(renderer: THREE.WebGLRenderer): void {
    const ctx = renderer.getContext();
    this.gl = (ctx as WebGL2RenderingContext).texImage3D ? (ctx as WebGL2RenderingContext) : null;
  }

  begin(name: string): void {
    if (!this.enabled) return;
    this.current = name;
    this.t0 = performance.now();
  }

  end(): void {
    if (!this.enabled || !this.current) return;
    // A finish() here is what turns submission time into GPU time.
    if (this.syncMode && this.gl) this.gl.finish();
    const dt = performance.now() - this.t0;
    const s = this.samples.get(this.current);
    if (s) {
      s.sum += dt;
      s.n++;
    } else {
      this.samples.set(this.current, { sum: dt, n: 1 });
    }
    const prev = this.ms.get(this.current) ?? dt;
    this.ms.set(this.current, prev + (dt - prev) * 0.1);
    this.current = '';
  }

  reset(): void {
    this.samples.clear();
  }

  /** Mean ms per frame for every pass measured since the last reset(). */
  report(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, v] of this.samples) out[k] = v.sum / Math.max(1, v.n);
    return out;
  }

  writeStats(stats: Record<string, number>): void {
    if (!this.enabled) return;
    let total = 0;
    for (const [k, v] of this.ms) {
      stats[`post:${k}`] = v;
      total += v;
    }
    stats['post:total'] = total;
  }
}
