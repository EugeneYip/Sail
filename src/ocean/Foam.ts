import * as THREE from 'three';
import type { FoamSource } from '../types';
import { FullScreenPass } from './Pass';
import type { WaveCascade } from './WaveCascade';
import type { SpectrumParams } from './Spectrum';

/**
 * Persistent world-space foam.
 *
 * Whitecaps are not a function of height, they are a function of the surface
 * folding: where the Jacobian of the horizontal displacement goes negative the
 * wave has overturned. That gives the instantaneous mask. Foam then has to
 * *live*: it is injected at folds, advected along the surface flow, and decays
 * exponentially, which is what makes it streak downwind and collect in troughs
 * instead of flickering on and off with the fold.
 *
 * The buffer is a camera-following window (1 km at 512, ~2 m/texel). Beyond it
 * the surface shader falls back to the instantaneous fold mask, so distant
 * whitecaps still appear — they just do not persist, which at that distance is
 * indistinguishable.
 */

const MAX_SOURCES = 8;

/** Advection velocity: this fraction of wind speed is surface drift. */
const WIND_DRIFT = 0.028;

export class FoamSim {
  private ping!: THREE.WebGLRenderTarget;
  private pong!: THREE.WebGLRenderTarget;
  private material!: THREE.ShaderMaterial;
  private res: number;
  private size: number;
  private origin = new THREE.Vector2();
  private prevOrigin = new THREE.Vector2();
  private sources: FoamSource[] = [];
  private srcData: Float32Array;
  private srcVecs: THREE.Vector4[] = [];
  private cleared = false;

  /** (originX, originZ, 1/size, 0) for the surface shader. */
  readonly window = new THREE.Vector4(0, 0, 1, 0);

  constructor(res: number, size: number, cascades: WaveCascade[]) {
    this.res = res;
    this.size = size;
    this.srcData = new Float32Array(MAX_SOURCES * 4);
    for (let i = 0; i < MAX_SOURCES; i++) this.srcVecs.push(new THREE.Vector4());
    this.build(cascades);
  }

  get texture(): THREE.Texture {
    return this.ping.texture;
  }

  private build(cascades: WaveCascade[]): void {
    const opts: THREE.RenderTargetOptions = {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.NoColorSpace,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    };
    this.ping = new THREE.WebGLRenderTarget(this.res, this.res, opts);
    this.pong = new THREE.WebGLRenderTarget(this.res, this.res, opts);

    const n = cascades.length;
    let decl = '';
    let fold = '';
    for (let i = 0; i < n; i++) {
      decl += `uniform sampler2D uDisp${i};\nuniform sampler2D uDeriv${i};\n`;
      fold += `
  {
    vec2 uv = world * uCascadeScale[${i}] + uCascadeHalfTexel[${i}];
    vec4 d0 = texture2D(uDisp${i}, uv);
    vec4 d1 = texture2D(uDeriv${i}, uv);
    dy += d0.x;
    jac += vec3(d1.y, d1.z, d1.w);
  }`;
    }

    const uniforms: Record<string, { value: unknown }> = {
      uPrev: { value: this.pong.texture },
      uRes: { value: this.res },
      uSize: { value: this.size },
      uOriginNow: { value: new THREE.Vector2() },
      uOriginPrev: { value: new THREE.Vector2() },
      uDt: { value: 1 / 60 },
      uFlowDir: { value: new THREE.Vector2(1, 0) },
      uPeakOmega: { value: 0.8 },
      uWindSpeed: { value: 8 },
      uThreshold: { value: 0.7 },
      uInject: { value: 1 },
      uSources: { value: this.srcVecs },
      uCascadeScale: { value: cascades.map((c) => 1 / c.layout.size) },
      uCascadeHalfTexel: { value: cascades.map((c) => 0.5 / c.layout.n) },
      uReset: { value: 1 },
    };
    for (let i = 0; i < n; i++) {
      uniforms[`uDisp${i}`] = { value: cascades[i].dispTex };
      uniforms[`uDeriv${i}`] = { value: cascades[i].derivTex };
    }

    this.material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: `void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: /* glsl */ `
precision highp float;
${decl}
uniform sampler2D uPrev;
uniform float uRes, uSize, uDt, uPeakOmega, uWindSpeed, uThreshold, uInject, uReset;
uniform vec2 uOriginNow, uOriginPrev, uFlowDir;
uniform vec4 uSources[${MAX_SOURCES}];
uniform float uCascadeScale[${n}];
uniform float uCascadeHalfTexel[${n}];

void main(){
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 world = uOriginNow + (uv - 0.5) * uSize;

  float dy = 0.0;
  vec3 jac = vec3(0.0);
  ${fold}
  float fold = (1.0 + jac.x) * (1.0 + jac.y) - jac.z * jac.z;

  // Deep-water linear theory: horizontal orbital velocity is omega*eta along the
  // wave direction. Crests run forward and troughs run back, so foam converges
  // into the troughs — that convergence is the streaking.
  vec2 flow = uFlowDir * (uPeakOmega * dy * 0.55 + uWindSpeed * ${WIND_DRIFT});
  vec2 srcWorld = world - flow * uDt;
  vec2 srcUv = (srcWorld - uOriginPrev) / uSize + 0.5;
  float ok = step(0.0, srcUv.x) * step(srcUv.x, 1.0) * step(0.0, srcUv.y) * step(srcUv.y, 1.0);
  vec4 prev = texture2D(uPrev, clamp(srcUv, 0.0, 1.0)) * ok * (1.0 - uReset);

  // Heavy foam is thick and lasts; a thin streak dissipates in a couple of
  // seconds.
  float tau = mix(2.4, 9.5, prev.r);
  float f = prev.r * exp(-uDt / tau);
  float age = prev.g * exp(-uDt / 14.0);

  float inject = max(0.0, uThreshold - fold) * uInject;
  for (int i = 0; i < ${MAX_SOURCES}; i++) {
    vec4 s = uSources[i];
    if (s.z <= 0.0) continue;
    float d = length(world - s.xy);
    inject += s.w * (1.0 - smoothstep(s.z * 0.35, s.z, d));
  }
  // Top up with a MAX, not by integrating a rate. Accumulating against the decay
  // made the equilibrium a runaway function of how often the fold dips, and the
  // two ends of the wind range came out nowhere near each other: measured by
  // reading this buffer back, a fresh breeze settled at 0.01% coverage and a gale
  // saturated at 54%, where Monahan asks for about 1% and 15%. A max blend makes
  // a texel mean 'this patch has broken within the last tau seconds', which is
  // what persistent foam physically is, and it cannot run away.
  f = max(f, min(1.0, inject));
  age = min(1.0, max(age, f));

  gl_FragColor = vec4(f, age, 0.0, 1.0);
}
`,
      depthTest: false,
      depthWrite: false,
    });
  }

  addSource(s: FoamSource): void {
    if (this.sources.length < MAX_SOURCES) this.sources.push(s);
  }

  update(
    renderer: THREE.WebGLRenderer,
    camX: number,
    camZ: number,
    dt: number,
    p: SpectrumParams,
    windSpeed: number,
  ): void {
    // Snap the window to whole texels so the reprojection is exact and does not
    // smear the buffer as the camera moves.
    const texel = this.size / this.res;
    this.prevOrigin.copy(this.origin);
    this.origin.set(Math.round(camX / texel) * texel, Math.round(camZ / texel) * texel);

    const u = this.material.uniforms;
    (u.uOriginNow.value as THREE.Vector2).copy(this.origin);
    (u.uOriginPrev.value as THREE.Vector2).copy(this.prevOrigin);
    u.uDt.value = Math.min(dt, 1 / 20);
    (u.uFlowDir.value as THREE.Vector2).set(p.windDirX, p.windDirZ);
    u.uPeakOmega.value = p.peakOmega;
    u.uWindSpeed.value = windSpeed;
    u.uReset.value = this.cleared ? 0 : 1;
    this.cleared = true;

    // Monahan's whitecap coverage goes as U^3.4, so calm water must have none
    // and a gale must be covered. Bias the fold threshold rather than scaling
    // the output, so what foam there is stays physically placed.
    const cover = Math.min(1, 3.84e-6 * Math.pow(Math.max(windSpeed, 0.5), 3.41) * 24);
    // The SAME threshold the surface shader uses. This is one physical question —
    // is this patch of surface breaking — and answering it two different ways gave
    // two absurd answers. Measured by reading this buffer back: the old
    // 0.54 + 0.44*cover put a fresh breeze at 0.66, below the entire fold
    // distribution (min fold 0.717), so the buffer stayed exactly empty and every
    // whitecap inside the window came out at 45% strength; and it put a gale at
    // 0.98, above half the distribution, so the buffer saturated at 60% coverage
    // where Monahan asks for about 15%.
    u.uThreshold.value = 0.79 + 0.1 * cover;
    u.uInject.value = 0.8 + 2.4 * cover;

    for (let i = 0; i < MAX_SOURCES; i++) {
      const s = this.sources[i];
      const v = this.srcVecs[i];
      if (s) v.set(s.position.x, s.position.z, s.radius, s.strength);
      else v.set(0, 0, 0, 0);
    }

    u.uPrev.value = this.ping.texture;
    FullScreenPass.run(renderer, this.material, this.pong);
    const t = this.ping;
    this.ping = this.pong;
    this.pong = t;

    this.window.set(this.origin.x, this.origin.y, 1 / this.size, 0);
  }

  /** Cascade textures changed identity — rebind. */
  rebind(cascades: WaveCascade[]): void {
    const u = this.material.uniforms;
    for (let i = 0; i < cascades.length; i++) {
      if (u[`uDisp${i}`]) u[`uDisp${i}`].value = cascades[i].dispTex;
      if (u[`uDeriv${i}`]) u[`uDeriv${i}`].value = cascades[i].derivTex;
    }
  }

  dispose(): void {
    this.ping.dispose();
    this.pong.dispose();
    this.material.dispose();
  }
}
