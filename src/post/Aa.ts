import * as THREE from 'three';
import type { Settings } from '../types';
import { FullscreenPass } from './FullscreenPass';
import type { Targets } from './Targets';
import { FXAA_FRAG } from './shaders/fxaa';
import { SHARPEN_FRAG, TAA_FRAG } from './shaders/taa';
import { SMAA_BLEND_FRAG, SMAA_EDGES_FRAG, SMAA_WEIGHTS_FRAG } from './shaders/smaa';
import {
  SMAA_AREA_SIZE,
  SMAA_MAX_DISTANCE,
  SMAA_SEARCH_SIZE,
  makeSmaaAreaTexture,
  makeSmaaSearchTexture,
} from './luts/SmaaLuts';

export type AaMode = Settings['antialias'];

/**
 * Anti-aliasing. One of four modes, all reading exposed scene-linear colour and
 * writing the same, so the rest of the stack does not care which ran.
 *
 * Passes are built lazily. Compiling FXAA, three SMAA passes and TAA at boot
 * costs a few hundred milliseconds of shader compilation for two paths the
 * player will never take; the cost of switching modes at runtime is one hitch.
 *
 * TAA is the default. Its two settings that actually matter on water:
 *
 *   `varianceGamma` — how many standard deviations of the 3x3 neighbourhood the
 *   history is allowed to sit outside before it is clipped back. The ocean's
 *   specular glitter is uncorrelated frame to frame, so a loose box (1.5+) lets
 *   last frame's glint survive into this frame and the sea grows comet tails.
 *   1.05 is tight enough to kill that and still wide enough to accumulate real
 *   detail on the rigging.
 *
 *   `feedbackMax` — 0.92 is eight frames of effective history, which resolves a
 *   backstay cleanly. Higher looks better on a static frame and smears the
 *   moment the ship rolls.
 */
export class AntiAliasing {
  /** Set by the pipeline when history must be thrown away this frame. */
  reset = true;

  private mode: AaMode = 'off';
  private taa: FullscreenPass | null = null;
  private sharpen: FullscreenPass | null = null;
  private fxaa: FullscreenPass | null = null;
  private smaaEdges: FullscreenPass | null = null;
  private smaaWeights: FullscreenPass | null = null;
  private smaaBlend: FullscreenPass | null = null;
  private areaTex: THREE.DataTexture | null = null;
  private searchTex: THREE.DataTexture | null = null;

  private historyIndex = 0;
  private width = 1;
  private height = 1;

  constructor(private readonly targets: Targets) {}

  /** True when the projection matrix must be jittered this frame. */
  get needsJitter(): boolean {
    return this.mode === 'taa';
  }

  /** True when a velocity buffer must exist this frame. */
  get needsVelocity(): boolean {
    return this.mode === 'taa';
  }

  setMode(mode: AaMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.reset = true;
    if (mode !== 'taa') {
      this.targets.release('taaHistory0');
      this.targets.release('taaHistory1');
    }
    if (mode !== 'smaa') {
      this.targets.release('smaaEdges');
      this.targets.release('smaaWeights');
    }
    this.allocate();
  }

  resize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.reset = true;
    this.allocate();
  }

  private allocate(): void {
    if (this.mode === 'taa') {
      this.targets.get('taaHistory0', this.width, this.height, 'rgba16f');
      this.targets.get('taaHistory1', this.width, this.height, 'rgba16f');
    } else if (this.mode === 'smaa') {
      this.targets.get('smaaEdges', this.width, this.height, 'rg8');
      this.targets.get('smaaWeights', this.width, this.height, 'rgba8');
    }
  }

  /**
   * Resolve `source` into `dst`. Returns the texture the rest of the chain
   * should read — `dst.texture` for every mode except `off`, where the input
   * is passed straight through so we do not pay for a full-res copy.
   */
  render(
    renderer: THREE.WebGLRenderer,
    settings: Settings,
    source: THREE.Texture,
    depth: THREE.Texture | null,
    velocity: THREE.Texture | null,
    dst: THREE.WebGLRenderTarget,
    jitterPixels: THREE.Vector2,
    exposureTex: THREE.Texture,
  ): THREE.Texture {
    const tx = 1 / this.width;
    const ty = 1 / this.height;

    switch (this.mode) {
      case 'off':
        return source;

      case 'fxaa': {
        const p = this.getFxaa();
        p.uniforms.tColor.value = source;
        (p.uniforms.uTexelSize.value as THREE.Vector2).set(tx, ty);
        p.render(renderer, dst);
        return dst.texture;
      }

      case 'smaa': {
        const edges = this.targets.get('smaaEdges', this.width, this.height, 'rg8');
        const weights = this.targets.get('smaaWeights', this.width, this.height, 'rgba8');
        const e = this.getSmaaEdges();
        e.uniforms.tColor.value = source;
        (e.uniforms.uTexelSize.value as THREE.Vector2).set(tx, ty);
        // The edge pass only ever writes the pixels it finds edges on, so the
        // target has to start clean.
        renderer.setRenderTarget(edges);
        renderer.clear(true, false, false);
        e.render(renderer, edges);

        const w = this.getSmaaWeights();
        w.uniforms.tEdges.value = edges.texture;
        (w.uniforms.uTexelSize.value as THREE.Vector2).set(tx, ty);
        renderer.setRenderTarget(weights);
        renderer.clear(true, false, false);
        w.render(renderer, weights);

        const b = this.getSmaaBlend();
        b.uniforms.tColor.value = source;
        b.uniforms.tBlend.value = weights.texture;
        (b.uniforms.uTexelSize.value as THREE.Vector2).set(tx, ty);
        b.render(renderer, dst);
        return dst.texture;
      }

      case 'taa': {
        const histNext = this.targets.get(
          `taaHistory${this.historyIndex}`,
          this.width,
          this.height,
          'rgba16f',
        );
        const histPrev = this.targets.get(
          `taaHistory${1 - this.historyIndex}`,
          this.width,
          this.height,
          'rgba16f',
        );
        this.historyIndex = 1 - this.historyIndex;

        const p = this.getTaa();
        const u = p.uniforms;
        u.tCurrent.value = source;
        u.tHistory.value = histPrev.texture;
        u.tVelocity.value = velocity;
        u.tDepth.value = depth;
        (u.uTexelSize.value as THREE.Vector2).set(tx, ty);
        (u.uResolution.value as THREE.Vector2).set(this.width, this.height);
        (u.uJitterPixels.value as THREE.Vector2).copy(jitterPixels);
        u.tExposure.value = exposureTex;
        u.uReset.value = this.reset ? 1 : 0;
        p.render(renderer, histNext);

        const s = this.getSharpen();
        s.uniforms.tColor.value = histNext.texture;
        (s.uniforms.uTexelSize.value as THREE.Vector2).set(tx, ty);
        s.uniforms.uAmount.value = settings.quality === 'low' ? 0.2 : 0.38;
        s.render(renderer, dst);

        this.reset = false;
        return dst.texture;
      }
    }
  }

  /* ---- lazy pass construction ------------------------------------------ */

  private getTaa(): FullscreenPass {
    if (!this.taa) {
      this.taa = new FullscreenPass('aa/taa', TAA_FRAG, {
        tCurrent: { value: null },
        tHistory: { value: null },
        tVelocity: { value: null },
        tDepth: { value: null },
        uTexelSize: { value: new THREE.Vector2() },
        uResolution: { value: new THREE.Vector2() },
        uJitterPixels: { value: new THREE.Vector2() },
        uFeedbackMin: { value: 0.7 },
        uFeedbackMax: { value: 0.92 },
        uVarianceGamma: { value: 1.05 },
        uFilterWidth: { value: 0.85 },
        tExposure: { value: null },
        uReset: { value: 1 },
      });
    }
    return this.taa;
  }

  private getSharpen(): FullscreenPass {
    if (!this.sharpen) {
      this.sharpen = new FullscreenPass('aa/sharpen', SHARPEN_FRAG, {
        tColor: { value: null },
        uTexelSize: { value: new THREE.Vector2() },
        uAmount: { value: 0.38 },
      });
    }
    return this.sharpen;
  }

  private getFxaa(): FullscreenPass {
    if (!this.fxaa) {
      this.fxaa = new FullscreenPass('aa/fxaa', FXAA_FRAG, {
        tColor: { value: null },
        uTexelSize: { value: new THREE.Vector2() },
        uSubpix: { value: 0.7 },
        uEdgeThreshold: { value: 0.125 },
        uEdgeThresholdMin: { value: 0.032 },
      });
    }
    return this.fxaa;
  }

  private getSmaaEdges(): FullscreenPass {
    if (!this.smaaEdges) {
      this.smaaEdges = new FullscreenPass('aa/smaaEdges', SMAA_EDGES_FRAG, {
        tColor: { value: null },
        uTexelSize: { value: new THREE.Vector2() },
        uThreshold: { value: 0.055 },
      });
    }
    return this.smaaEdges;
  }

  private getSmaaWeights(): FullscreenPass {
    if (!this.smaaWeights) {
      this.areaTex = makeSmaaAreaTexture();
      this.searchTex = makeSmaaSearchTexture();
      this.smaaWeights = new FullscreenPass('aa/smaaWeights', SMAA_WEIGHTS_FRAG, {
        tEdges: { value: null },
        tArea: { value: this.areaTex },
        tSearch: { value: this.searchTex },
        uTexelSize: { value: new THREE.Vector2() },
        uMaxDistance: { value: SMAA_MAX_DISTANCE },
        uAreaSize: { value: SMAA_AREA_SIZE },
        uAreaBlock: { value: SMAA_MAX_DISTANCE + 1 },
        uSearchScale: {
          value: new THREE.Vector2(
            (SMAA_SEARCH_SIZE - 1) / SMAA_SEARCH_SIZE,
            0.5 / SMAA_SEARCH_SIZE,
          ),
        },
      });
    }
    return this.smaaWeights;
  }

  private getSmaaBlend(): FullscreenPass {
    if (!this.smaaBlend) {
      this.smaaBlend = new FullscreenPass('aa/smaaBlend', SMAA_BLEND_FRAG, {
        tColor: { value: null },
        tBlend: { value: null },
        uTexelSize: { value: new THREE.Vector2() },
      });
    }
    return this.smaaBlend;
  }

  dispose(): void {
    this.taa?.dispose();
    this.sharpen?.dispose();
    this.fxaa?.dispose();
    this.smaaEdges?.dispose();
    this.smaaWeights?.dispose();
    this.smaaBlend?.dispose();
    this.areaTex?.dispose();
    this.searchTex?.dispose();
  }
}
