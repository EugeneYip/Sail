import * as THREE from 'three';
import type { FoamSource, IOcean, Module, WaveSample, World } from '../types';
import { CpuWaves } from './CpuWaves';
import { FoamSim } from './Foam';
import { SpectralNoise } from './Noise';
import { OceanMesh } from './OceanMesh';
import { FullScreenPass } from './Pass';
import {
  buildCascades,
  cascadeSlopeVariance,
  solveSpectrum,
  type CascadeLayout,
  type SpectrumParams,
} from './Spectrum';
import { WaveCascade } from './WaveCascade';
import { surfaceShaders } from './shaders/surface';
import { makeFoamDetail, makeStubTexture } from './textures';

/**
 * The ocean.
 *
 * Sim: N band-limited FFT cascades on the GPU (`WaveCascade`), a CPU mirror of
 * the same modes for physics (`CpuWaves`), and a camera-following persistent
 * foam buffer (`FoamSim`).
 *
 * Render: one camera-centred geometry clipmap (`OceanMesh`) with a single
 * material (`shaders/surface.ts`), so the whole sea is 12 draw calls.
 *
 * COORDINATE SPACE — read this before touching a uniform.
 * Everything the wave field is sampled with is *wrapped-absolute* XZ:
 *   wrappedAbs = worldXZ + (origin.xz mod coarsestTileSize)
 * Absolute voyage coordinates would lose float32 precision after a few hundred
 * km, and every tile size divides the coarsest one exactly, so reducing the
 * floating-origin offset modulo that tile leaves every cascade's phase
 * untouched. `sample()` takes plain world XZ and does the wrap internally.
 */

/** Clipmap grid cells per side, by quality tier. Cost is O(m^2) triangles. */
const GRID_BY_TIER: Record<string, number> = { low: 64, medium: 96, high: 128, ultra: 128 };

/** Persistent-foam window: resolution and world size in metres, by tier. */
const FOAM_BY_TIER: Record<string, [number, number]> = {
  low: [256, 700],
  medium: [256, 700],
  high: [512, 900],
  ultra: [512, 900],
};

/** Outer band of each clipmap level that morphs toward the coarser level. */
const MORPH_START = 0.74;

/**
 * A cascade stops displacing geometry once even its longest wave is below the
 * local cell size; between these multiples of that wavelength it fades out.
 * Everything shorter is handled by the mip chain, which band-limits the
 * displacement to the cell instead of aliasing it.
 */
const CELL_FADE_LO = 0.22;
const CELL_FADE_HI = 0.9;

/**
 * Re-solve the spectrum when the weather has actually moved this much. A rebake
 * rewrites every mode's amplitude on both the CPU and the GPU, so it is the most
 * expensive thing the ocean ever does; the thresholds are set so that what it
 * costs buys a change nobody can see. At these values the worst case is the
 * spectrum lagging a squall by ~0.05 m of Hs, i.e. 2.5% at sea state 4.
 */
const REBAKE_WIND = 0.4; // m/s
const REBAKE_HS = 0.05; // m
const REBAKE_BEARING = 0.05; // rad
const REBAKE_CHOP = 0.03;
const REBAKE_MIN_INTERVAL = 1.1; // s

/** Shape published on `world.ext.ocean`. Every field is stable for the app's life. */
export interface OceanExt {
  /** The ocean draws its own statistical sun-glitter lobe; do not add another. */
  readonly hasSunGlitter: true;
  /** Persistent foam coverage, R = coverage 0..1, G = age. Camera-following window. */
  readonly foamTexture: THREE.Texture;
  /** (windowOriginX, windowOriginZ, 1/windowSize, 0), wrapped-absolute XZ. */
  readonly foamWindow: THREE.Vector4;
  /** Finest cascade's displacement, for anything that just wants "the water texture". */
  readonly displacementTexture: THREE.Texture;
  /** Per cascade, coarsest first. RGBA = (Dy, Dx, Dz, dDy/dx). */
  readonly displacementTextures: THREE.Texture[];
  /** Per cascade. RGBA = (dDy/dz, dDx/dx, dDz/dz, dDx/dz). */
  readonly derivativeTextures: THREE.Texture[];
  /** 1 / tileSize per cascade — multiply wrapped-absolute XZ by this to get uv. */
  readonly cascadeScales: number[];
  /** 0.5 / fftResolution per cascade — add to the uv above to hit texel centres. */
  readonly cascadeHalfTexels: number[];
  /** Tile size in metres per cascade. */
  readonly cascadeSizes: number[];
  /** Add this to a world XZ to get the wrapped-absolute XZ the textures use. */
  readonly originWrap: THREE.Vector2;
  /** Significant wave height currently rendered, metres. */
  readonly waveHeight: number;
  /** RMS surface slope of the whole spectrum. */
  readonly slopeRms: number;
  /** Dominant wave direction of travel and angular frequency. */
  readonly peakDir: THREE.Vector2;
  readonly peakOmega: number;
  /** Conservative bound on |displacement.y| right now, metres. */
  maxHeight(): number;
  /** Persistent foam coverage at a world XZ, 0..1. CPU-side estimate. */
  foamAt(x: number, z: number): number;
  /** Register a moving foam source (wake, splash). Up to 8. */
  addFoamSource(s: FoamSource): void;
  /** One-shot GPU readback: how far the CPU sampler is from the rendered surface. */
  debugCompare(count?: number): CompareReport;
}

export interface CompareReport {
  /** Metres. */
  rmsHeight: number;
  maxHeight: number;
  /** Dimensionless slope. */
  rmsSlope: number;
  /** RMS elevation of each field on its own, m. Equal means equal energy. */
  rmsGpuField: number;
  rmsCpuField: number;
  /** Pearson correlation of the two elevation fields. 1 means same field. */
  correlation: number;
  samples: number;
  /** Per cascade: CPU grid vs GPU grid, and whether the band is fully covered. */
  cascades: { size: number; gpu: number; cpu: number; exact: boolean }[];
}

export class Ocean implements Module, IOcean {
  readonly name = 'ocean';
  readonly seaLevel = 0;

  private world!: World;
  private noise!: SpectralNoise;
  private layouts: CascadeLayout[] = [];
  private cascades: WaveCascade[] = [];
  private cpu!: CpuWaves;
  private foam!: FoamSim;
  private mesh!: OceanMesh;
  private material!: THREE.ShaderMaterial;
  private foamDetail!: THREE.DataTexture;
  private stub!: THREE.DataTexture;
  private params!: SpectrumParams;

  private simTime = 0;
  private sinceRebake = 1e9;
  private baked = { wind: -1, hs: -1, bearing: -1, swell: -1, chop: -1 };
  private gridM = 128;
  private tileWrap = 2048;
  private originWrap = new THREE.Vector2();
  private hasWake = false;

  /** Scratch — `update()` must never allocate. */
  private tmpMatrix = new THREE.Matrix4();
  private tmpVec2 = new THREE.Vector2();
  private compareRt: THREE.WebGLRenderTarget | null = null;
  private compareMat: THREE.ShaderMaterial | null = null;

  init(world: World): void {
    this.world = world;
    this.noise = new SpectralNoise(0x5ea1);
    this.foamDetail = makeFoamDetail();
    this.stub = makeStubTexture();
    this.cpu = new CpuWaves(this.noise);
    this.build(world);
    world.ocean = this;
  }

  /* ------------------------------------------------------------------ *
   *  construction
   * ------------------------------------------------------------------ */

  private build(world: World): void {
    const s = world.settings;
    this.layouts = buildCascades(s.oceanCascades, s.oceanResolution);
    this.tileWrap = this.layouts[0].size;
    this.cascades = this.layouts.map((l) => new WaveCascade(l, this.noise));
    this.cpu.build(this.layouts);

    const [foamRes, foamSize] = FOAM_BY_TIER[s.quality] ?? FOAM_BY_TIER.high;
    this.foam = new FoamSim(foamRes, foamSize, this.cascades);

    this.gridM = GRID_BY_TIER[s.quality] ?? 128;
    this.material = this.makeMaterial(world);
    this.mesh = new OceanMesh(this.gridM, this.material);
    world.scene.add(this.mesh.group);

    this.solve(world, true);
    this.publish(world);
  }

  private makeMaterial(world: World): THREE.ShaderMaterial {
    const n = this.layouts.length;
    const src = surfaceShaders(n, this.hasWake);

    const uniforms: Record<string, { value: unknown }> = {
      ...world.uniforms,
      uOceanOrigin: { value: this.originWrap },
      uCascadeScale: { value: this.layouts.map((l) => 1 / l.size) },
      uCascadeHalfTexel: { value: this.layouts.map((l) => 0.5 / l.n) },
      uCascadeTexels: { value: this.layouts.map((l) => l.n / l.size) },
      uCascadeCellFade: { value: this.layouts.map(() => new THREE.Vector2(1, 2)) },
      uCascadePxFade: { value: this.layouts.map(() => new THREE.Vector2(1, 4)) },
      uCascadeSlopeVar: { value: this.layouts.map(() => 0) },
      uGridM: { value: this.gridM },
      uMorphStart: { value: MORPH_START },
      uFoam: { value: this.foam.texture },
      uFoamDetail: { value: this.foamDetail },
      uReflection: { value: this.stub },
      uEnvMap: { value: this.stub },
      uHasEnv: { value: 0 },
      uFoamWindow: { value: this.foam.window },
      uResolution: { value: new THREE.Vector2(world.size.width, world.size.height) },
      uPixelAngle: { value: 0.002 },
      uSlopeRms: { value: 0.1 },
      uSlopeVarTail: { value: 0 },
      uWaveHeight: { value: 1 },
      uHasReflection: { value: 0 },
      uFoamAmount: { value: 1 },
      uWake: { value: this.stub },
      uWakeMatrix: { value: new THREE.Matrix3() },
      uWakeStrength: { value: 0 },
      uWakeAnchor: { value: new THREE.Vector3(0, 0, 400) },
    };
    for (let i = 0; i < n; i++) {
      uniforms[`uDisp${i}`] = { value: this.cascades[i].dispTex };
      uniforms[`uDeriv${i}`] = { value: this.cascades[i].derivTex };
    }

    const mat = new THREE.ShaderMaterial({
      name: 'ocean-surface',
      uniforms,
      vertexShader: src.vertexShader,
      fragmentShader: src.fragmentShader,
      side: THREE.DoubleSide,
      transparent: false,
      depthWrite: true,
      depthTest: true,
      fog: false,
      lights: false,
    });

    // Cascade texel size sets both fade schedules: the cell fade is geometry,
    // the pixel fade is where the normal map stops resolving and its variance
    // has to become roughness instead.
    const cellFade = mat.uniforms.uCascadeCellFade.value as THREE.Vector2[];
    const pxFade = mat.uniforms.uCascadePxFade.value as THREE.Vector2[];
    for (let i = 0; i < n; i++) {
      const l = this.layouts[i];
      const texel = l.size / l.n;
      // Longest wave the cascade carries. The coarsest has no lower band edge,
      // so it is the tile itself.
      const lambdaMax = l.kMin > 0 ? (2 * Math.PI) / l.kMin : l.size;
      cellFade[i].set(lambdaMax * CELL_FADE_LO, lambdaMax * CELL_FADE_HI);
      pxFade[i].set(texel * 1.1, texel * 4.5);
    }
    return mat;
  }

  /* ------------------------------------------------------------------ *
   *  spectrum
   * ------------------------------------------------------------------ */

  private solve(world: World, force: boolean): void {
    const env = world.env;
    if (!force) {
      if (this.sinceRebake < REBAKE_MIN_INTERVAL) return;
      const b = this.baked;
      const moved =
        Math.abs(env.windSpeed - b.wind) > REBAKE_WIND ||
        Math.abs(env.waveHeight - b.hs) > REBAKE_HS ||
        Math.abs(env.windBearing - b.bearing) > REBAKE_BEARING ||
        Math.abs(env.swellBearing - b.swell) > REBAKE_BEARING ||
        Math.abs(env.choppiness - b.chop) > REBAKE_CHOP;
      if (!moved) return;
    }
    this.sinceRebake = 0;
    this.baked.wind = env.windSpeed;
    this.baked.hs = env.waveHeight;
    this.baked.bearing = env.windBearing;
    this.baked.swell = env.swellBearing;
    this.baked.chop = env.choppiness;

    this.params = solveSpectrum(env, this.layouts, this.params);
    for (const c of this.cascades) c.bake(world.renderer, this.params);
    this.cpu.setParams(this.params);

    const slopeVar = this.material.uniforms.uCascadeSlopeVar.value as number[];
    for (let i = 0; i < this.layouts.length; i++) {
      slopeVar[i] = cascadeSlopeVariance(this.params, this.layouts[i]);
    }
    this.material.uniforms.uSlopeRms.value = this.params.slopeRms;
    this.material.uniforms.uSlopeVarTail.value = this.params.slopeVarTail;
    this.material.uniforms.uWaveHeight.value = this.params.hs;
    // Monahan: whitecap coverage grows as U^3.4. Below a fresh breeze there
    // simply are no whitecaps, and the fold mask must not invent any.
    const cover = Math.min(1, 3.84e-6 * Math.pow(Math.max(env.windSpeed, 0.5), 3.41) * 24);
    this.material.uniforms.uFoamAmount.value = 0.18 + 1.9 * cover;
  }

  /* ------------------------------------------------------------------ *
   *  frame
   * ------------------------------------------------------------------ */

  update(world: World): void {
    const dt = world.time.dt;
    const prof = world.settings.debug;
    const stats = world.stats;
    let t0 = prof ? performance.now() : 0;
    FullScreenPass.count = 0;
    this.simTime += dt;
    this.sinceRebake += dt;

    // Reduce the floating-origin offset onto the coarsest tile. Every finer
    // tile size divides it, so no cascade's phase changes.
    const w = this.tileWrap;
    this.originWrap.set(
      ((world.origin.x % w) + w) % w,
      ((world.origin.z % w) + w) % w,
    );
    this.cpu.setOrigin(this.originWrap.x, this.originWrap.y);

    this.solve(world, false);
    if (prof) {
      const t = performance.now();
      stats['ocean:solve'] = t - t0;
      t0 = t;
    }

    FullScreenPass.begin(world.renderer);
    for (const c of this.cascades) c.update(world.renderer, this.simTime);
    FullScreenPass.end(world.renderer);
    if (prof) {
      const t = performance.now();
      stats['ocean:gpu'] = t - t0;
      t0 = t;
    }

    this.cpu.update(this.simTime);
    if (prof) {
      const t = performance.now();
      stats['ocean:cpu'] = t - t0;
      t0 = t;
    }

    const cam = world.camera.position;
    this.foam.update(
      world.renderer,
      cam.x + this.originWrap.x,
      cam.z + this.originWrap.y,
      dt,
      this.params,
      world.env.windSpeed * world.env.gust,
    );
    this.material.uniforms.uFoam.value = this.foam.texture;
    if (prof) {
      const t = performance.now();
      stats['ocean:foam'] = t - t0;
      t0 = t;
    }

    this.updateClipmap(cam.x, cam.z);
    this.updateWake(world);
    this.updateSky(world);

    const u = this.material.uniforms;
    (u.uResolution.value as THREE.Vector2).set(world.size.width, world.size.height);
    // World metres per pixel per metre of distance — drives every "can this
    // still be resolved" decision in the fragment shader.
    u.uPixelAngle.value =
      (2 * Math.tan((world.camera.fov * Math.PI) / 360)) / Math.max(world.size.height, 1);

    if (prof) {
      stats['ocean:tail'] = performance.now() - t0;
      stats['ocean:passes'] = FullScreenPass.count;
    }
    world.stats['ocean.hs'] = this.params.hs;
  }

  /**
   * Snap each clipmap level to its own grid. The snap must be to two cells, not
   * one, or the CDLOD morph flips parity as the camera moves and the surface
   * shimmers along every level boundary.
   */
  private updateClipmap(camX: number, camZ: number): void {
    for (const lv of this.mesh.levels) {
      const cell = lv.cell;
      const snap = cell * 2;
      const x = Math.round(camX / snap) * snap;
      const z = Math.round(camZ / snap) * snap;
      const m = lv.mesh.matrixWorld;
      m.makeScale(cell, 1, cell);
      m.elements[12] = x;
      m.elements[14] = z;
      lv.mesh.matrix.copy(m);
    }
  }

  /**
   * The VFX agent may publish a wake field on `world.ext.vfx`. Its documented
   * shape is a torus-mapped RGBA16F where R = persistent foam, G = wake height
   * in metres, BA = the world-space slope of that height, addressed by
   * `uv = fract(matrix * vec3(worldX, worldZ, 1))`. Everything here is
   * optional and null-checked; the ocean must render identically without it.
   */
  private updateWake(world: World): void {
    const ext = world.ext.vfx as
      | {
          wakeTexture?: THREE.Texture;
          wakeMatrix?: THREE.Matrix3;
          wakeStrength?: number;
          wakeWorldSize?: number;
        }
      | undefined;
    const tex = ext?.wakeTexture ?? null;
    const mat = ext?.wakeMatrix ?? null;
    const present = !!(tex && mat);
    if (present !== this.hasWake) {
      this.hasWake = present;
      this.rebuildMaterial(world);
    }
    if (!present) return;
    const u = this.material.uniforms;
    u.uWake.value = tex;
    (u.uWakeMatrix.value as THREE.Matrix3).copy(mat as THREE.Matrix3);
    u.uWakeStrength.value = ext?.wakeStrength ?? 1;
    // The field wraps at wakeWorldSize, so anything past about half of that is
    // the wake showing through from the far side. Fade it before then.
    const p = world.ship.position;
    (u.uWakeAnchor.value as THREE.Vector3).set(p.x, p.z, (ext?.wakeWorldSize ?? 1024) * 0.45);
  }

  /**
   * The sky's own radiance probe, if it has published one. This is the single
   * biggest quality lever the ocean has: reflecting the real sky, clouds
   * included, is what stops water reading as a tinted plane. Optional and
   * null-checked — the sea falls back to the analytic gradient without it.
   *
   * Cloud shadows need no plumbing: they are shared uniforms the sky writes
   * every frame, sampled through `lwCloudShadow()`.
   *
   * The aerial-perspective froxel volume is deliberately NOT sampled; see the
   * note in the aerial-perspective block of `shaders/surface.ts`.
   */
  private updateSky(world: World): void {
    const sky = world.ext.sky as { envMap?: THREE.Texture } | undefined;
    const env = sky?.envMap ?? null;
    const u = this.material.uniforms;
    u.uEnvMap.value = env ?? this.stub;
    u.uHasEnv.value = env ? 1 : 0;
  }

  private rebuildMaterial(world: World): void {
    const next = this.makeMaterial(world);
    const old = this.material;
    this.material = next;
    for (const lv of this.mesh.levels) lv.mesh.material = next;
    this.solve(world, true);
    old.dispose();
  }

  /* ------------------------------------------------------------------ *
   *  IOcean
   * ------------------------------------------------------------------ */

  sampleHeight(x: number, z: number): number {
    return this.cpu.height(x, z);
  }

  sample(x: number, z: number, out: WaveSample): WaveSample {
    return this.cpu.sample(x, z, out);
  }

  addFoamSource(source: FoamSource): void {
    this.foam.addSource(source);
  }

  /* ------------------------------------------------------------------ *
   *  lifecycle
   * ------------------------------------------------------------------ */

  resize(world: World): void {
    // Engine.applyResize() runs before init(), so this fires once with nothing
    // built yet.
    if (!this.material) return;
    (this.material.uniforms.uResolution.value as THREE.Vector2).set(
      world.size.width,
      world.size.height,
    );
  }

  applySettings(world: World): void {
    if (!this.material) return;
    const s = world.settings;
    const layouts = buildCascades(s.oceanCascades, s.oceanResolution);
    const sameCascades =
      layouts.length === this.layouts.length &&
      layouts.every((l, i) => l.size === this.layouts[i].size && l.n === this.layouts[i].n);
    const grid = GRID_BY_TIER[s.quality] ?? 128;
    if (sameCascades && grid === this.gridM) {
      this.solve(world, true);
      return;
    }
    this.teardown(world);
    this.build(world);
  }

  private teardown(world: World): void {
    world.scene.remove(this.mesh.group);
    this.mesh.dispose();
    this.material.dispose();
    for (const c of this.cascades) c.dispose();
    this.foam.dispose();
    this.cascades = [];
  }

  dispose(): void {
    this.teardown(this.world);
    this.noise.dispose();
    this.foamDetail.dispose();
    this.stub.dispose();
    this.compareRt?.dispose();
    this.compareMat?.dispose();
  }

  /* ------------------------------------------------------------------ *
   *  published handle
   * ------------------------------------------------------------------ */

  private publish(world: World): void {
    const oceanRef = this;
    const ext: OceanExt = {
      hasSunGlitter: true,
      foamTexture: this.foam.texture,
      foamWindow: this.foam.window,
      displacementTexture: this.cascades[this.cascades.length - 1].dispTex,
      displacementTextures: this.cascades.map((c) => c.dispTex),
      derivativeTextures: this.cascades.map((c) => c.derivTex),
      cascadeScales: this.layouts.map((l) => 1 / l.size),
      cascadeHalfTexels: this.layouts.map((l) => 0.5 / l.n),
      cascadeSizes: this.layouts.map((l) => l.size),
      originWrap: this.originWrap,
      get waveHeight() {
        return oceanRef.params.hs;
      },
      get slopeRms() {
        return oceanRef.params.slopeRms;
      },
      get peakDir() {
        return oceanRef.tmpVec2.set(oceanRef.params.windDirX, oceanRef.params.windDirZ);
      },
      get peakOmega() {
        return oceanRef.params.peakOmega;
      },
      maxHeight: () => this.cpu.maxHeight(),
      foamAt: (x, z) => this.cpu.foamAt(x, z),
      addFoamSource: (s) => this.foam.addSource(s),
      debugCompare: (count) => this.debugCompare(count),
    };
    world.ext.ocean = ext;
  }

  /* ------------------------------------------------------------------ *
   *  verification
   * ------------------------------------------------------------------ */

  /**
   * Read the GPU displacement back and compare it with what `sample()` returns
   * at the same points. Synchronous and slow — a debug tool, never called from
   * `update()`.
   */
  debugCompare(count = 4096): CompareReport {
    const renderer = this.world.renderer;
    if (!this.compareMat) {
      // texelFetch does not exist in GLSL ES 1.00, so this has to address texel
      // centres by uv instead. Getting that wrong makes the blit fail to compile
      // and the readback silently return zeros, which reads as "the CPU mirror
      // is completely wrong" rather than "the debug tool is broken".
      this.compareMat = new THREE.ShaderMaterial({
        uniforms: { uSrc: { value: null }, uN: { value: 1 } },
        vertexShader: 'void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }',
        fragmentShader:
          'precision highp float; uniform sampler2D uSrc; uniform float uN;' +
          ' void main(){ gl_FragColor = texture2D(uSrc, gl_FragCoord.xy / uN); }',
        depthTest: false,
        depthWrite: false,
      });
    }

    // Pull every cascade into float buffers first.
    const disp: Float32Array[] = [];
    const deriv: Float32Array[] = [];
    for (const c of this.cascades) {
      const n = c.layout.n;
      if (!this.compareRt || this.compareRt.width !== n) {
        this.compareRt?.dispose();
        this.compareRt = new THREE.WebGLRenderTarget(n, n, {
          type: THREE.FloatType,
          format: THREE.RGBAFormat,
          colorSpace: THREE.NoColorSpace,
          minFilter: THREE.NearestFilter,
          magFilter: THREE.NearestFilter,
          depthBuffer: false,
          stencilBuffer: false,
          generateMipmaps: false,
        });
      }
      const rt = this.compareRt;
      const buf = new Float32Array(n * n * 4);
      this.compareMat.uniforms.uN.value = n;
      this.compareMat.uniforms.uSrc.value = c.dispTex;
      renderFullscreen(renderer, this.compareMat, rt);
      renderer.readRenderTargetPixels(rt, 0, 0, n, n, buf);
      disp.push(buf);
      const buf2 = new Float32Array(n * n * 4);
      this.compareMat.uniforms.uSrc.value = c.derivTex;
      renderFullscreen(renderer, this.compareMat, rt);
      renderer.readRenderTargetPixels(rt, 0, 0, n, n, buf2);
      deriv.push(buf2);
    }

    const sample: WaveSample = createWaveSample();
    const dispTap = new Float32Array(4);
    const derivTap = new Float32Array(4);
    let sumH = 0;
    let maxH = 0;
    let sumS = 0;
    let sumG = 0;
    let sumC = 0;
    let sumGG = 0;
    let sumCC = 0;
    let sumGC = 0;
    const side = Math.max(2, Math.round(Math.sqrt(count)));
    const span = this.layouts[0].size;
    for (let j = 0; j < side; j++) {
      for (let i = 0; i < side; i++) {
        // Irrational offsets: a grid aligned to the coarsest tile lands on texel
        // centres of every finer cascade at once and hides exactly the
        // interpolation error this is meant to find.
        const x = ((i + 0.3183) / side) * span;
        const z = ((j + 0.7071) / side) * span;
        let gy = 0;
        let gsx = 0;
        let gsz = 0;
        for (let ci = 0; ci < this.cascades.length; ci++) {
          const l = this.layouts[ci];
          const d = bilinear(disp[ci], l.n, x / l.size, z / l.size, dispTap);
          const e = bilinear(deriv[ci], l.n, x / l.size, z / l.size, derivTap);
          gy += d[0];
          gsx += d[3];
          gsz += e[0];
        }
        // The CPU sampler works in wrapped-absolute space too, so undo the wrap.
        this.cpu.sample(x - this.originWrap.x, z - this.originWrap.y, sample);
        const dh = sample.height - gy;
        sumH += dh * dh;
        if (Math.abs(dh) > maxH) maxH = Math.abs(dh);
        sumG += gy;
        sumC += sample.height;
        sumGG += gy * gy;
        sumCC += sample.height * sample.height;
        sumGC += gy * sample.height;
        // Reconstruct the CPU's slope from its normal.
        const csx = -sample.normal.x / Math.max(sample.normal.y, 1e-3);
        const csz = -sample.normal.z / Math.max(sample.normal.y, 1e-3);
        sumS += (csx - gsx) * (csx - gsx) + (csz - gsz) * (csz - gsz);
      }
    }
    const total = side * side;
    const varG = sumGG / total - (sumG / total) ** 2;
    const varC = sumCC / total - (sumC / total) ** 2;
    const cov = sumGC / total - (sumG / total) * (sumC / total);
    return {
      rmsHeight: Math.sqrt(sumH / total),
      maxHeight: maxH,
      rmsSlope: Math.sqrt(sumS / (2 * total)),
      rmsGpuField: Math.sqrt(Math.max(varG, 0)),
      rmsCpuField: Math.sqrt(Math.max(varC, 0)),
      correlation: cov / Math.sqrt(Math.max(varG * varC, 1e-12)),
      samples: total,
      cascades: this.layouts.map((l, i) => ({
        size: l.size,
        gpu: l.n,
        cpu: this.cpu.gridSize(i),
        exact: this.cpu.gridSize(i) >= l.n,
      })),
    };
  }
}

/* ------------------------------------------------------------------ *
 *  helpers
 * ------------------------------------------------------------------ */

/**
 * Same reconstruction the shader gets from a LinearFilter fetch, written into a
 * caller-owned `out`. It used to return a single shared scratch array, which
 * meant two live samples aliased each other: the displacement read turned into
 * the derivative read and `debugCompare` reported a 46 cm CPU-vs-GPU
 * disagreement that did not exist.
 */
function bilinear(
  buf: Float32Array,
  n: number,
  u: number,
  v: number,
  out: Float32Array,
): Float32Array {
  // texel centres sit at (i + 0.5) / n, matching uCascadeHalfTexel.
  const fx = u * n;
  const fz = v * n;
  let i0 = Math.floor(fx);
  let j0 = Math.floor(fz);
  const tx = fx - i0;
  const tz = fz - j0;
  i0 = ((i0 % n) + n) % n;
  j0 = ((j0 % n) + n) % n;
  const i1 = (i0 + 1) % n;
  const j1 = (j0 + 1) % n;
  const a = (j0 * n + i0) * 4;
  const b = (j0 * n + i1) * 4;
  const c = (j1 * n + i0) * 4;
  const d = (j1 * n + i1) * 4;
  const w00 = (1 - tx) * (1 - tz);
  const w10 = tx * (1 - tz);
  const w01 = (1 - tx) * tz;
  const w11 = tx * tz;
  for (let k = 0; k < 4; k++) {
    out[k] = buf[a + k] * w00 + buf[b + k] * w10 + buf[c + k] * w01 + buf[d + k] * w11;
  }
  return out;
}

let fsScene: THREE.Scene | null = null;
let fsMesh: THREE.Mesh | null = null;
const fsCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

function renderFullscreen(
  renderer: THREE.WebGLRenderer,
  material: THREE.Material,
  target: THREE.WebGLRenderTarget,
): void {
  if (!fsScene || !fsMesh) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
    );
    fsMesh = new THREE.Mesh(geo, material);
    fsMesh.frustumCulled = false;
    fsScene = new THREE.Scene();
    fsScene.add(fsMesh);
  }
  fsMesh.material = material;
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(target);
  renderer.render(fsScene, fsCamera);
  renderer.setRenderTarget(prev);
}

/**
 * Physics imports this to build its reusable sample struct. Keep the signature —
 * `src/physics/ShipDynamics.ts` depends on it.
 */
export function createWaveSample(): WaveSample {
  return {
    height: 0,
    dx: 0,
    dz: 0,
    normal: new THREE.Vector3(0, 1, 0),
    velocity: new THREE.Vector3(),
  };
}
