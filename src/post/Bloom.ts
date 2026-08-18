import * as THREE from 'three';
import { FullscreenPass } from './FullscreenPass';
import type { Targets } from './Targets';
import { BLOOM_DOWN_FRAG, BLOOM_UP_FRAG } from './shaders/bloom';

/**
 * Progressive dual-filter bloom pyramid.
 *
 * Six levels starting at half resolution, so the coarsest is ~14 px tall and
 * the widest halo covers roughly a third of the screen — that width is the
 * difference between "the sun is glowing" and "everything has an outline".
 * There is no threshold anywhere in the chain; see `shaders/bloom.ts`.
 *
 * The upsample blends in place with SrcAlpha/1-SrcAlpha rather than adding, so
 * level 0 has the same mean brightness as the source and the composite's
 * `mix(scene, bloom, 0.05)` really does move 5% of the light.
 */
const MAX_LEVELS = 7;
/** Stop subdividing when the coarsest level gets this small. */
const MIN_LEVEL_PX = 14;

export class BloomChain {
  /** Texture to sample in the composite. Null until the first resize. */
  texture: THREE.Texture | null = null;

  private downFirst: FullscreenPass;
  private down: FullscreenPass;
  private up: FullscreenPass;
  private rts: THREE.WebGLRenderTarget[] = [];
  private width = 0;
  private height = 0;

  constructor(private readonly targets: Targets) {
    const downUniforms = (): Record<string, THREE.IUniform> => ({
      tSource: { value: null },
      uSourceTexel: { value: new THREE.Vector2() },
    });
    // The Karis average only belongs on the first downsample: it is there to
    // stop one specular pixel on a wave from pumping, and applying it further
    // down the chain would keep dimming the bright parts we want to keep.
    this.downFirst = new FullscreenPass('bloom/down0', BLOOM_DOWN_FRAG, downUniforms(), {
      BLOOM_KARIS: 1,
    });
    this.down = new FullscreenPass('bloom/down', BLOOM_DOWN_FRAG, downUniforms());
    this.up = new FullscreenPass('bloom/up', BLOOM_UP_FRAG, {
      tSource: { value: null },
      uSourceTexel: { value: new THREE.Vector2() },
      uRadius: { value: 1.15 },
      uBlend: { value: 0.5 },
    });
    const m = this.up.material;
    m.transparent = true;
    m.blending = THREE.CustomBlending;
    m.blendSrc = THREE.SrcAlphaFactor;
    m.blendDst = THREE.OneMinusSrcAlphaFactor;
    m.blendEquation = THREE.AddEquation;
    m.blendSrcAlpha = THREE.OneFactor;
    m.blendDstAlpha = THREE.ZeroFactor;
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.rts.length = 0;

    let w = Math.max(1, width >> 1);
    let h = Math.max(1, height >> 1);
    for (let i = 0; i < MAX_LEVELS; i++) {
      this.rts.push(this.targets.get(`bloom${i}`, w, h, 'rgba16f'));
      if (Math.min(w, h) <= MIN_LEVEL_PX * 2) {
        // Anything finer than this is a level we will never need again.
        for (let j = i + 1; j < MAX_LEVELS; j++) this.targets.release(`bloom${j}`);
        break;
      }
      w = Math.max(1, w >> 1);
      h = Math.max(1, h >> 1);
    }
    this.texture = this.rts[0].texture;
  }

  release(): void {
    for (let i = 0; i < MAX_LEVELS; i++) this.targets.release(`bloom${i}`);
    this.rts.length = 0;
    this.texture = null;
  }

  render(renderer: THREE.WebGLRenderer, source: THREE.Texture, radius: number): void {
    if (this.rts.length === 0) return;

    let srcW = this.width;
    let srcH = this.height;
    let srcTex = source;
    for (let i = 0; i < this.rts.length; i++) {
      const pass = i === 0 ? this.downFirst : this.down;
      pass.uniforms.tSource.value = srcTex;
      (pass.uniforms.uSourceTexel.value as THREE.Vector2).set(1 / srcW, 1 / srcH);
      const rt = this.rts[i];
      pass.render(renderer, rt);
      srcW = rt.width;
      srcH = rt.height;
      srcTex = rt.texture;
    }

    this.up.uniforms.uRadius.value = radius;
    for (let i = this.rts.length - 1; i > 0; i--) {
      const src = this.rts[i];
      this.up.uniforms.tSource.value = src.texture;
      (this.up.uniforms.uSourceTexel.value as THREE.Vector2).set(1 / src.width, 1 / src.height);
      this.up.render(renderer, this.rts[i - 1]);
    }

    this.texture = this.rts[0].texture;
  }

  dispose(): void {
    this.downFirst.dispose();
    this.down.dispose();
    this.up.dispose();
  }
}
