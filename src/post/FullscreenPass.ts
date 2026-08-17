import * as THREE from 'three';

/**
 * One shared fullscreen triangle for every post pass. A triangle beats a quad:
 * no diagonal seam in the rasteriser's quad packing and one fewer vertex.
 * UVs run 0..2 so the [0,1] range covers the visible half.
 */
let sharedGeometry: THREE.BufferGeometry | null = null;

function geometry(): THREE.BufferGeometry {
  if (!sharedGeometry) {
    sharedGeometry = new THREE.BufferGeometry();
    sharedGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
    );
    sharedGeometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
    // Never culled, never sorted — it is always exactly the screen.
    sharedGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  }
  return sharedGeometry;
}

export const FULLSCREEN_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/**
 * A single fragment-shader pass. Note that three compiles every `ShaderMaterial`
 * as `#version 300 es` on WebGL2 and aliases `varying`/`texture2D`, so these
 * shaders are written in GLSL1 style but may freely use ES 3.0 features
 * (`texelFetch`, `textureLod`, dynamic loop bounds, integer maths).
 */
export class FullscreenPass {
  readonly material: THREE.ShaderMaterial;
  readonly uniforms: Record<string, THREE.IUniform>;
  private readonly mesh: THREE.Mesh;
  private readonly scene = new THREE.Scene();
  private static camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  constructor(
    readonly name: string,
    fragmentShader: string,
    uniforms: Record<string, THREE.IUniform> = {},
    defines: Record<string, string | number> = {},
  ) {
    this.uniforms = uniforms;
    this.material = new THREE.ShaderMaterial({
      name: `post/${name}`,
      uniforms,
      defines,
      vertexShader: FULLSCREEN_VERT,
      fragmentShader,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      toneMapped: false,
    });
    this.mesh = new THREE.Mesh(geometry(), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.scene.add(this.mesh);
    this.scene.matrixWorldAutoUpdate = false;
  }

  /** Recompile with a changed define. No-op when the value already matches. */
  setDefine(key: string, value: string | number): void {
    const defs = this.material.defines as Record<string, string | number>;
    if (defs[key] === value) return;
    defs[key] = value;
    this.material.needsUpdate = true;
  }

  render(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget | null): void {
    renderer.setRenderTarget(target);
    renderer.render(this.scene, FullscreenPass.camera);
  }

  dispose(): void {
    this.material.dispose();
  }
}

export function disposeSharedGeometry(): void {
  sharedGeometry?.dispose();
  sharedGeometry = null;
}
