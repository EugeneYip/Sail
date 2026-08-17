import * as THREE from 'three';
import { FullScreenPass } from './Pass';

/**
 * GPU inverse FFT, radix-2 Cooley–Tukey driven by a precomputed butterfly
 * texture. Two complex fields ride in one RGBA texel (xy and zw), so a single
 * chain of 2·log2(N) passes transforms four real output fields at once.
 *
 * Convention: no 1/N normalisation and a +i twiddle, i.e. this computes
 *   f(x_j) = sum_n  h_n exp(+2*pi*i*n*j/N)
 * which is exactly what the wave sum needs with k_n = 2*pi*n/L and x_j = j*L/N.
 * The CPU mirror in `CpuFft.ts` uses the same convention.
 */

const FFT_SHADER = /* glsl */ `
precision highp float;
precision highp sampler2D;
uniform sampler2D uSrc;
uniform sampler2D uButterfly;
uniform float uStage;
uniform float uVertical;

vec2 cmul(vec2 a, vec2 b){ return vec2(a.x*b.x - a.y*b.y, a.x*b.y + a.y*b.x); }

void main(){
  ivec2 p = ivec2(gl_FragCoord.xy);
  int idx = uVertical > 0.5 ? p.y : p.x;
  vec4 bf = texelFetch(uButterfly, ivec2(int(uStage), idx), 0);
  int ia = int(bf.z);
  int ib = int(bf.w);
  ivec2 pa = uVertical > 0.5 ? ivec2(p.x, ia) : ivec2(ia, p.y);
  ivec2 pb = uVertical > 0.5 ? ivec2(p.x, ib) : ivec2(ib, p.y);
  vec4 a = texelFetch(uSrc, pa, 0);
  vec4 b = texelFetch(uSrc, pb, 0);
  gl_FragColor = vec4(a.xy + cmul(bf.xy, b.xy), a.zw + cmul(bf.xy, b.zw));
}
`;

function bitReverse(value: number, bits: number): number {
  let r = 0;
  for (let i = 0; i < bits; i++) r |= ((value >> i) & 1) << (bits - 1 - i);
  return r;
}

/** (twiddle.re, twiddle.im, indexA, indexB) per (stage, output index). */
export function buildButterflyData(n: number): Float32Array {
  const stages = Math.log2(n) | 0;
  const data = new Float32Array(stages * n * 4);
  for (let s = 0; s < stages; s++) {
    const m = 1 << (s + 1);
    const half = m >> 1;
    for (let y = 0; y < n; y++) {
      const j = y % m;
      const upper = j < half;
      let top = upper ? y : y - half;
      let bot = upper ? y + half : y;
      const jj = upper ? j : j - half;
      // Inverse transform: +2*pi*i*jj/m. Lower wing carries the minus sign so
      // both wings evaluate as a + w*b.
      const ang = (2 * Math.PI * jj) / m;
      const sign = upper ? 1 : -1;
      if (s === 0) {
        top = bitReverse(top, stages);
        bot = bitReverse(bot, stages);
      }
      const o = (s * n + y) * 4;
      data[o] = sign * Math.cos(ang);
      data[o + 1] = sign * Math.sin(ang);
      data[o + 2] = top;
      data[o + 3] = bot;
    }
  }
  return data;
}

export class GpuFft {
  readonly n: number;
  readonly stages: number;
  private butterfly: THREE.DataTexture;
  private material: THREE.ShaderMaterial;

  constructor(n: number) {
    this.n = n;
    this.stages = Math.log2(n) | 0;
    this.butterfly = new THREE.DataTexture(
      buildButterflyData(n),
      this.stages,
      n,
      THREE.RGBAFormat,
      THREE.FloatType,
    );
    this.butterfly.minFilter = THREE.NearestFilter;
    this.butterfly.magFilter = THREE.NearestFilter;
    this.butterfly.generateMipmaps = false;
    this.butterfly.needsUpdate = true;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uSrc: { value: null },
        uButterfly: { value: this.butterfly },
        uStage: { value: 0 },
        uVertical: { value: 0 },
      },
      vertexShader: `void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: FFT_SHADER,
      depthTest: false,
      depthWrite: false,
    });
  }

  /**
   * Transform the contents of `a` through the ping-pong pair, landing the last
   * pass directly in `out` so the mipmapped sampling target is written once.
   */
  run(
    renderer: THREE.WebGLRenderer,
    a: THREE.WebGLRenderTarget,
    b: THREE.WebGLRenderTarget,
    out: THREE.WebGLRenderTarget,
  ): void {
    let src = a;
    let dst = b;
    const u = this.material.uniforms;
    const total = this.stages * 2;
    for (let i = 0; i < total; i++) {
      u.uVertical.value = i < this.stages ? 0 : 1;
      u.uStage.value = i % this.stages;
      u.uSrc.value = src.texture;
      const last = i === total - 1;
      FullScreenPass.run(renderer, this.material, last ? out : dst);
      if (!last) {
        const t = src;
        src = dst;
        dst = t;
      }
    }
  }

  dispose(): void {
    this.butterfly.dispose();
    this.material.dispose();
  }
}
