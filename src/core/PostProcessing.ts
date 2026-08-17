import * as THREE from 'three';
import type { World } from '../types';
import type { RenderHook } from './Engine';

/**
 * BASELINE render pipeline — scene -> HDR float target -> composite.
 * Owned by the post-processing agent; will grow bloom, TAA, DoF, motion blur,
 * grain, lens dirt and grading. The contract with the Engine is `RenderHook`.
 */
export class PostProcessing implements RenderHook {
  private hdr!: THREE.WebGLRenderTarget;
  private quad!: THREE.Mesh;
  private fsScene = new THREE.Scene();
  private fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private material!: THREE.ShaderMaterial;

  constructor(world: World) {
    this.hdr = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.LinearSRGBColorSpace,
      depthBuffer: true,
      stencilBuffer: false,
      samples: 0,
    });
    this.hdr.texture.minFilter = THREE.LinearFilter;
    this.hdr.texture.magFilter = THREE.LinearFilter;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tScene: { value: this.hdr.texture },
        uExposure: { value: 1 },
        uVignette: { value: 0.32 },
        uGrain: { value: 0.035 },
        uTime: { value: 0 },
        uResolution: { value: new THREE.Vector2(1, 1) },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D tScene;
        uniform float uExposure, uVignette, uGrain, uTime;
        uniform vec2 uResolution;

        // ACES filmic approximation (Narkowicz) on scene-linear input.
        vec3 aces(vec3 x) {
          const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
          return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
        }
        float hash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
        }
        void main() {
          vec3 col = texture2D(tScene, vUv).rgb * uExposure;
          col = aces(col);
          // vignette
          vec2 q = vUv - 0.5;
          float v = 1.0 - uVignette * dot(q, q) * 2.4;
          col *= v;
          // grain
          col += (hash(vUv * uResolution + uTime) - 0.5) * uGrain;
          // linear -> sRGB
          col = max(col, vec3(0.0));
          col = mix(col * 12.92, pow(col, vec3(1.0 / 2.4)) * 1.055 - 0.055, step(0.0031308, col));
          gl_FragColor = vec4(col, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
    });

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
    this.quad = new THREE.Mesh(geo, this.material);
    this.quad.frustumCulled = false;
    this.fsScene.add(this.quad);

    void world;
  }

  resize(world: World): void {
    const { width, height } = world.size;
    this.hdr.setSize(width, height);
    this.material.uniforms.uResolution.value.set(width, height);
  }

  render(world: World): void {
    const r = world.renderer;
    r.setRenderTarget(this.hdr);
    r.clear(true, true, true);
    r.render(world.scene, world.camera);

    this.material.uniforms.uExposure.value =
      world.uniforms.uExposure.value * Math.pow(2, world.settings.exposureBias);
    this.material.uniforms.uTime.value = world.time.elapsed;
    this.material.uniforms.uVignette.value = world.settings.vignette ? 0.32 : 0;
    this.material.uniforms.uGrain.value = world.settings.filmGrain ? 0.035 : 0;

    r.setRenderTarget(null);
    r.clear(true, true, true);
    r.render(this.fsScene, this.fsCam);
  }
}
