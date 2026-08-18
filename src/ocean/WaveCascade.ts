import * as THREE from 'three';
import { GpuFft } from './Fft';
import { FullScreenPass, makeOutputTarget, makeSimTarget } from './Pass';
import { H0_SHADER, PROPAGATE_SHADER } from './shaders/spectrum';
import type { SpectralNoise } from './Noise';
import type { CascadeLayout, SpectrumParams } from './Spectrum';

/**
 * One band-limited FFT cascade.
 *
 * Two RGBA chains, each carrying two complex fields, give eight real outputs per
 * cascade. Both chains ride the same passes as two colour attachments, so a
 * cascade costs 1 + 2*log2(N) passes rather than 2 + 4*log2(N):
 *   dispTex:  (Dy, Dx, Dz, dDy/dx)
 *   derivTex: (dDy/dz, dDx/dx, dDz/dz, dDx/dz)
 */
export class WaveCascade {
  readonly layout: CascadeLayout;
  readonly dispTex: THREE.Texture;
  readonly derivTex: THREE.Texture;

  private fft: GpuFft;
  private h0: THREE.WebGLRenderTarget;
  private ping: THREE.WebGLRenderTarget;
  private pong: THREE.WebGLRenderTarget;
  private out: THREE.WebGLRenderTarget;
  private h0Mat: THREE.ShaderMaterial;
  private propMat: THREE.ShaderMaterial;

  constructor(layout: CascadeLayout, noise: SpectralNoise) {
    this.layout = layout;
    const n = layout.n;
    this.fft = new GpuFft(n);
    // h0 spans four orders of magnitude across the band; half float would flush
    // the tail to zero, so this one target stays full float.
    this.h0 = makeSimTarget(n, THREE.FloatType);
    this.ping = makeSimTarget(n, THREE.HalfFloatType, 2);
    this.pong = makeSimTarget(n, THREE.HalfFloatType, 2);
    this.out = makeOutputTarget(n, 2);
    this.dispTex = this.out.textures[0];
    this.derivTex = this.out.textures[1];

    this.h0Mat = new THREE.ShaderMaterial({
      ...H0_SHADER,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uNoise: { value: noise.texture },
        uN: { value: n },
        uSize: { value: layout.size },
        uKMin: { value: layout.kMin },
        uKMax: { value: Number.isFinite(layout.kMax) ? layout.kMax : -1 },
        uOmegaWind: { value: 1 },
        uOmegaSwell: { value: 1 },
        uVarWind: { value: 0 },
        uVarSwell: { value: 0 },
        uWindDir: { value: new THREE.Vector2(1, 0) },
        uSwellDir: { value: new THREE.Vector2(1, 0) },
      },
    });

    this.propMat = new THREE.ShaderMaterial({
      ...PROPAGATE_SHADER,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uH0: { value: this.h0.texture },
        uN: { value: n },
        uSize: { value: layout.size },
        uTime: { value: 0 },
        uLambda: { value: 1 },
      },
    });
  }

  /** Regenerate the static spectrum. Only on a real weather change. */
  bake(renderer: THREE.WebGLRenderer, p: SpectrumParams): void {
    const u = this.h0Mat.uniforms;
    u.uOmegaWind.value = p.omegaPeakWind;
    u.uOmegaSwell.value = p.omegaPeakSwell;
    u.uVarWind.value = p.varScaleWind;
    u.uVarSwell.value = p.varScaleSwell;
    (u.uWindDir.value as THREE.Vector2).set(p.windDirX, p.windDirZ);
    (u.uSwellDir.value as THREE.Vector2).set(p.swellDirX, p.swellDirZ);
    this.propMat.uniforms.uLambda.value = p.choppiness;
    FullScreenPass.run(renderer, this.h0Mat, this.h0);
  }

  update(renderer: THREE.WebGLRenderer, time: number): void {
    this.propMat.uniforms.uTime.value = time;
    FullScreenPass.begin(renderer);
    FullScreenPass.run(renderer, this.propMat, this.ping);
    this.fft.run(renderer, this.ping, this.pong, this.out);
    FullScreenPass.end(renderer);
  }

  dispose(): void {
    this.fft.dispose();
    this.h0.dispose();
    this.ping.dispose();
    this.pong.dispose();
    this.out.dispose();
    this.h0Mat.dispose();
    this.propMat.dispose();
  }
}
