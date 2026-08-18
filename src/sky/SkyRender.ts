import * as THREE from 'three';
import { SKY_FRAG, SKY_VERT } from './shaders/skyRender';

export interface SkyUniforms {
  tTransmittance: THREE.IUniform<THREE.Texture | null>;
  tSkyView: THREE.IUniform<THREE.Texture | null>;
  tStarRamp: THREE.IUniform<THREE.Texture | null>;
  tMoonAlbedo: THREE.IUniform<THREE.Texture | null>;
  uSunDirection: THREE.IUniform<THREE.Vector3>;
  uMoonDirection: THREE.IUniform<THREE.Vector3>;
  uCelestialPole: THREE.IUniform<THREE.Vector3>;
  uStarMatrix: THREE.IUniform<THREE.Matrix3>;
  uSunDiscRadiance: THREE.IUniform<THREE.Vector3>;
  uMoonDiscRadiance: THREE.IUniform<THREE.Vector3>;
  uMoonEarthshine: THREE.IUniform<THREE.Vector3>;
  uMoonGlow: THREE.IUniform<THREE.Vector3>;
  uAirglow: THREE.IUniform<THREE.Vector3>;
  uStarBrightness: THREE.IUniform<number>;
  uMilkyWay: THREE.IUniform<number>;
  uMieMul: THREE.IUniform<number>;
  uSkyTime: THREE.IUniform<number>;
  [key: string]: THREE.IUniform;
}

/**
 * Shared by the sky mesh, the environment probe and every cloud pass. They are
 * shared BY REFERENCE, so `CloudField` writing one of the cloud entries updates
 * all four materials at once — do not deep-clone them.
 */
export function createSkyUniforms(): SkyUniforms {
  return {
    tTransmittance: { value: null },
    tSkyView: { value: null },
    tStarRamp: { value: null },
    tMoonAlbedo: { value: null },
    uSunDirection: { value: new THREE.Vector3(0, 1, 0) },
    uMoonDirection: { value: new THREE.Vector3(0, -1, 0) },
    uCelestialPole: { value: new THREE.Vector3(0, 1, 0) },
    uStarMatrix: { value: new THREE.Matrix3() },
    uSunDiscRadiance: { value: new THREE.Vector3() },
    uMoonDiscRadiance: { value: new THREE.Vector3() },
    uMoonEarthshine: { value: new THREE.Vector3() },
    uMoonGlow: { value: new THREE.Vector3() },
    uAirglow: { value: new THREE.Vector3() },
    uStarBrightness: { value: 0 },
    uMilkyWay: { value: 0 },
    uMieMul: { value: 1 },
    uSkyTime: { value: 0 },

    /* --- cloud density field, written by CloudField --- */
    tCloudBase: { value: null },
    tCloudDetail: { value: null },
    tWeather: { value: null },
    uFieldOffset: { value: new THREE.Vector2() },
    uDetailOffset: { value: new THREE.Vector2() },
    uCirrusOffset: { value: new THREE.Vector2() },
    uWeatherExtent: { value: 48000 },
    uBaseScale: { value: 1 / 6000 },
    uDetailScale: { value: 1 / 750 },
    uCoverage: { value: 0 },
    uCloudType: { value: 0.7 },
    uErosion: { value: 0.4 },
    uLayerBottom: { value: 900 },
    uLayerTop: { value: 4200 },
    uShear: { value: 900 },
    uWindDir: { value: new THREE.Vector2(1, 0) },
    uDensityScale: { value: 1 },
    uCirrusAmount: { value: 0.4 },

    /* --- cloud lighting, written by Sky.publish --- */
    uCloudLightDir: { value: new THREE.Vector3(0, 1, 0) },
    uCloudLightIrradiance: { value: new THREE.Vector3() },
    uCloudAmbientTop: { value: new THREE.Vector3() },
    uCloudAmbientBottom: { value: new THREE.Vector3() },
  };
}

function fullscreenTriangle(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
  );
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  return g;
}

/**
 * The sky as a scene object rather than a pass, so the post stack's single
 * `renderer.render(scene, camera)` picks it up and everything else composites
 * over it with normal depth testing.
 *
 * It is a fullscreen triangle at the far plane with depth writes off and
 * `renderOrder = -1000`, which is cheaper and more precise than a dome: no
 * tessellation error at the horizon, no seam, exactly one fragment per pixel.
 *
 * View-dependent uniforms are written in `onBeforeRender` and NOT in the module
 * update. The camera rig runs after the sky in the module order, so anything
 * latched during update would be a frame stale and the sky would visibly swim
 * behind the ship. `onBeforeRender` also lets the same material serve the
 * environment cube camera, which has completely different matrices.
 */
export class SkyRender {
  readonly material: THREE.ShaderMaterial;
  readonly mesh: THREE.Mesh;

  private geometry = fullscreenTriangle();
  private camPos = new THREE.Vector3();

  /** Called once per draw, before uniforms are uploaded. */
  onDraw: ((camera: THREE.Camera, renderer: THREE.WebGLRenderer) => void) | null = null;

  constructor(shared: SkyUniforms, defines: Record<string, string>) {
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      defines,
      uniforms: {
        ...shared,
        uRayMatrix: { value: new THREE.Matrix4() },
        uCameraPosW: { value: new THREE.Vector3() },
        uPixelAngle: { value: 0.001 },
        tClouds: { value: null },
      },
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
      fog: false,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = 'sky';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.onBeforeRender = (renderer, _scene, camera) => {
      this.syncCamera(camera, renderer);
      this.onDraw?.(camera, renderer);
    };
  }

  /** Toggle a compile-time feature. Recompiles, so settings changes only. */
  setDefine(name: string, on: boolean): void {
    const defines = this.material.defines as Record<string, string>;
    const had = defines[name] !== undefined;
    if (on === had) return;
    if (on) defines[name] = '1';
    else delete defines[name];
    this.material.needsUpdate = true;
  }

  private syncCamera(camera: THREE.Camera, renderer: THREE.WebGLRenderer): void {
    const u = this.material.uniforms;
    const proj = camera as THREE.PerspectiveCamera;
    (u.uRayMatrix.value as THREE.Matrix4).multiplyMatrices(
      camera.matrixWorld,
      proj.projectionMatrixInverse,
    );
    this.camPos.setFromMatrixPosition(camera.matrixWorld);
    (u.uCameraPosW.value as THREE.Vector3).copy(this.camPos);

    // Angular size of one pixel: tan(fovY/2) is 1/m11 for any perspective
    // projection, jittered or not, so this stays correct under TAA.
    const target = renderer.getRenderTarget();
    const height = target ? target.height : renderer.domElement.height;
    const m11 = proj.projectionMatrix.elements[5];
    u.uPixelAngle.value = m11 > 1e-4 ? (2 * Math.atan(1 / m11)) / Math.max(1, height) : 0.001;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
