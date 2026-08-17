import * as THREE from 'three';
import { PASS_VERT } from './shaders/lutPasses';

let sharedGeometry: THREE.BufferGeometry | null = null;

function fullscreenTriangle(): THREE.BufferGeometry {
  if (sharedGeometry) return sharedGeometry;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
  sharedGeometry = g;
  return g;
}

const passCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

/**
 * A single fullscreen shader pass. Nested `renderer.render` calls are safe —
 * three keeps a render-state stack for exactly this (it is how Reflector works) —
 * but the previous render target has to be restored by hand because the sky
 * pre-passes run from inside the main scene render.
 */
export class SkyPass {
  readonly material: THREE.ShaderMaterial;
  private mesh: THREE.Mesh;
  private scene = new THREE.Scene();

  constructor(
    fragmentShader: string,
    uniforms: Record<string, THREE.IUniform>,
    defines?: Record<string, string>,
  ) {
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: PASS_VERT,
      fragmentShader,
      uniforms,
      defines,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
    this.mesh = new THREE.Mesh(fullscreenTriangle(), this.material);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
    this.scene.matrixWorldAutoUpdate = false;
    this.mesh.updateMatrix();
    this.mesh.updateMatrixWorld();
  }

  get uniforms(): Record<string, THREE.IUniform> {
    return this.material.uniforms;
  }

  render(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget | null, layer = 0): void {
    const prev = renderer.getRenderTarget();
    const prevFace = renderer.getActiveCubeFace();
    const prevMip = renderer.getActiveMipmapLevel();
    renderer.setRenderTarget(target, layer);
    renderer.render(this.scene, passCamera);
    renderer.setRenderTarget(prev, prevFace, prevMip);
  }

  /** Render only rows [y0, y0+h) — used to spread an expensive bake over frames. */
  renderRows(
    renderer: THREE.WebGLRenderer,
    target: THREE.WebGLRenderTarget,
    y0: number,
    h: number,
  ): void {
    const prev = renderer.getRenderTarget();
    const prevFace = renderer.getActiveCubeFace();
    const prevMip = renderer.getActiveMipmapLevel();
    renderer.setRenderTarget(target);
    renderer.setViewport(0, 0, target.width, target.height);
    renderer.setScissor(0, y0, target.width, h);
    renderer.setScissorTest(true);
    renderer.render(this.scene, passCamera);
    renderer.setScissorTest(false);
    renderer.setRenderTarget(prev, prevFace, prevMip);
  }

  dispose(): void {
    this.material.dispose();
  }
}

/** RGBA16F, clamped, no mips — the shape every sky LUT wants. */
export function makeLut(width: number, height: number): THREE.WebGLRenderTarget {
  const rt = new THREE.WebGLRenderTarget(width, height, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    colorSpace: THREE.LinearSRGBColorSpace,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });
  return rt;
}
