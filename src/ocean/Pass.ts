import * as THREE from 'three';

/**
 * Minimal full-screen pass driver. One shared triangle + camera for every
 * compute-style pass in the ocean sim, so a pass costs one draw call and no
 * per-frame allocation.
 */
export class FullScreenPass {
  /** Passes issued since the last reset. Debug only. */
  static count = 0;

  private static scene: THREE.Scene | null = null;
  private static mesh: THREE.Mesh | null = null;
  private static camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  private static ensure(): { scene: THREE.Scene; mesh: THREE.Mesh } {
    if (!FullScreenPass.scene || !FullScreenPass.mesh) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute(
        'position',
        new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
      );
      geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial());
      mesh.frustumCulled = false;
      const scene = new THREE.Scene();
      scene.add(mesh);
      FullScreenPass.scene = scene;
      FullScreenPass.mesh = mesh;
    }
    return { scene: FullScreenPass.scene, mesh: FullScreenPass.mesh };
  }

  /** Nesting depth of begin()/end(), so a batch can contain sub-batches. */
  private static batch = 0;
  private static savedTarget: THREE.WebGLRenderTarget | null = null;
  private static savedAutoClear = true;

  /**
   * Save the renderer's target and autoClear once around a run of passes.
   * Restoring them per pass costs more than the pass: at ~60 sim passes a frame
   * the redundant framebuffer binds were measurable on their own.
   */
  static begin(renderer: THREE.WebGLRenderer): void {
    if (FullScreenPass.batch++ > 0) return;
    FullScreenPass.savedTarget = renderer.getRenderTarget();
    FullScreenPass.savedAutoClear = renderer.autoClear;
    renderer.autoClear = false;
  }

  static end(renderer: THREE.WebGLRenderer): void {
    if (--FullScreenPass.batch > 0) return;
    FullScreenPass.batch = 0;
    renderer.setRenderTarget(FullScreenPass.savedTarget);
    renderer.autoClear = FullScreenPass.savedAutoClear;
    FullScreenPass.savedTarget = null;
  }

  static run(
    renderer: THREE.WebGLRenderer,
    material: THREE.Material,
    target: THREE.WebGLRenderTarget | null,
  ): void {
    const { scene, mesh } = FullScreenPass.ensure();
    FullScreenPass.count++;
    mesh.material = material;
    if (FullScreenPass.batch > 0) {
      renderer.setRenderTarget(target);
      renderer.render(scene, FullScreenPass.camera);
      return;
    }
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(target);
    renderer.render(scene, FullScreenPass.camera);
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
  }
}

/**
 * A float render target sized for the wave sim. Always nearest, never mipped.
 * `count` attachments, so one pass can carry both of a cascade's FFT chains —
 * see `Fft.ts`.
 */
export function makeSimTarget(
  n: number,
  type: THREE.TextureDataType,
  count = 1,
): THREE.WebGLRenderTarget {
  const rt = new THREE.WebGLRenderTarget(n, n, {
    count,
    type,
    format: THREE.RGBAFormat,
    colorSpace: THREE.NoColorSpace,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.RepeatWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });
  for (const t of rt.textures) t.generateMipmaps = false;
  return rt;
}

/**
 * The sampled output of a cascade: linear filtered and repeat wrapped, because
 * the surface shader tiles it across the whole clipmap. Both of a cascade's
 * output textures are attachments of one target so the final FFT pass writes
 * them together.
 */
export function makeOutputTarget(n: number, count = 1): THREE.WebGLRenderTarget {
  const rt = new THREE.WebGLRenderTarget(n, n, {
    count,
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    colorSpace: THREE.NoColorSpace,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.RepeatWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: true,
  });
  for (const t of rt.textures) {
    t.anisotropy = 4;
    t.generateMipmaps = true;
  }
  return rt;
}
