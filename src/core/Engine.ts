import * as THREE from 'three';
import type { CameraRigState, FrameTime, Module, Settings, World } from '../types';
import { createEventBus } from './EventBus';
import { createSharedUniforms } from './SharedUniforms';
import { createEnvironment, createShipState } from './State';
import { applyQualityPreset, guessQuality, loadSettings, saveSettings } from './Settings';
import { createInputState } from '../input/Input';

export interface RenderHook {
  /** Called instead of `renderer.render(scene, camera)` when present. */
  render(world: World): void;
  resize?(world: World): void;
}

/**
 * Owns the renderer, the blackboard, the module list and the frame loop.
 *
 * Module authors: register in `main.ts` and implement `Module`. Do not reach
 * into the Engine from a module — everything you need is on `World`.
 */
export class Engine {
  readonly world: World;
  private modules: Module[] = [];
  private renderHook: RenderHook | null = null;
  private running = false;
  private lastTime = 0;
  private fpsAccum = 0;
  private fpsFrames = 0;
  private resizePending = true;
  /** Rolling average of GPU-bound frame cost for adaptive resolution. */
  private frameCostAvg = 16.6;
  private adaptCooldown = 0;

  constructor(canvas: HTMLCanvasElement) {
    const settings = loadSettings();

    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false, // we do our own AA in post
      alpha: false,
      stencil: false,
      depth: true,
      powerPreference: 'high-performance',
      // A float HDR buffer is created explicitly by the post stack; the
      // default framebuffer only ever receives tonemapped sRGB.
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
    });

    renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Tone mapping happens in our own composite pass so that bloom, DoF and
    // grain all operate on scene-linear radiance. Keep three's own off.
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.VSMShadowMap;
    renderer.shadowMap.autoUpdate = true;
    renderer.autoClear = false;
    renderer.info.autoReset = false;

    if (!settings.quality || !localStorage.getItem('leeward.settings.v1')) {
      applyQualityPreset(settings, guessQuality(renderer));
    }

    const scene = new THREE.Scene();
    scene.matrixWorldAutoUpdate = true;

    const camera = new THREE.PerspectiveCamera(settings.fov, 1, 0.25, 60000);
    camera.position.set(0, 24, 78);
    camera.lookAt(0, 12, 0);

    const shipRoot = new THREE.Object3D();
    shipRoot.name = 'shipRoot';
    scene.add(shipRoot);

    const time: FrameTime = { dt: 0, rawDt: 0, elapsed: 0, frame: 0, fps: 60 };
    const cam: CameraRigState = {
      mode: 'chase',
      distance: 76,
      shake: 0,
      focusDistance: 80,
      aperture: 2.8,
      locked: false,
    };

    this.world = {
      renderer,
      scene,
      camera,
      size: { width: 1, height: 1, dpr: 1 },
      time,
      env: createEnvironment(),
      ship: createShipState(),
      input: createInputState(),
      settings,
      cam,
      ocean: null,
      shipRoot,
      origin: new THREE.Vector3(),
      bus: createEventBus(),
      stats: {},
      uniforms: createSharedUniforms(),
      ext: {},
    };

    addEventListener('resize', () => (this.resizePending = true));
    addEventListener('orientationchange', () => (this.resizePending = true));
    document.addEventListener('visibilitychange', () => {
      // Avoid a giant dt spike when the tab comes back.
      if (!document.hidden) this.lastTime = performance.now();
    });

    this.world.bus.on('settings:changed', () => {
      saveSettings(this.world.settings);
      this.resizePending = true;
      for (const m of this.modules) m.applySettings?.(this.world);
      this.renderHook?.resize?.(this.world);
      camera.fov = this.world.settings.fov;
      camera.updateProjectionMatrix();
    });
  }

  use(...modules: Module[]): this {
    this.modules.push(...modules);
    return this;
  }

  setRenderHook(hook: RenderHook): this {
    this.renderHook = hook;
    return this;
  }

  async init(): Promise<void> {
    this.applyResize();
    for (const m of this.modules) {
      const t0 = performance.now();
      await m.init(this.world);
      this.world.stats[`init:${m.name}`] = performance.now() - t0;
    }
    this.renderHook?.resize?.(this.world);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    const loop = (now: number) => {
      if (!this.running) return;
      this.tick(now);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
  }

  private tick(now: number): void {
    const world = this.world;
    const time = world.time;

    const raw = (now - this.lastTime) / 1000;
    this.lastTime = now;
    time.rawDt = raw;
    // Clamp: a long stall must never teleport the ship or blow up the solver.
    time.dt = Math.min(Math.max(raw, 0), 0.1);
    time.elapsed += time.dt;
    time.frame++;

    this.fpsAccum += raw;
    this.fpsFrames++;
    if (this.fpsAccum >= 0.25) {
      time.fps = this.fpsFrames / this.fpsAccum;
      this.fpsAccum = 0;
      this.fpsFrames = 0;
    }

    if (this.resizePending) this.applyResize();

    // --- shared uniforms that everything depends on
    const u = world.uniforms;
    u.uTime.value = time.elapsed;
    u.uDt.value = time.dt;
    u.uCameraPos.value.setFromMatrixPosition(world.camera.matrixWorld);
    u.uOrigin.value.copy(world.origin);

    // --- modules
    const debug = world.settings.debug;
    for (const m of this.modules) {
      if (debug) {
        const t0 = performance.now();
        m.update(world);
        world.stats[`upd:${m.name}`] = performance.now() - t0;
      } else {
        m.update(world);
      }
    }

    // --- render
    world.renderer.info.reset();
    if (this.renderHook) this.renderHook.render(world);
    else {
      world.renderer.clear();
      world.renderer.render(world.scene, world.camera);
    }

    world.stats.drawCalls = world.renderer.info.render.calls;
    world.stats.triangles = world.renderer.info.render.triangles;
    world.stats.programs = world.renderer.info.programs?.length ?? 0;

    this.adaptResolution(raw);
  }

  /**
   * Adaptive internal resolution. Keeps a target frame budget by scaling the
   * render target, never by dropping effects — effect popping is far more
   * visible than a small resolution change.
   */
  private adaptResolution(rawDt: number): void {
    const s = this.world.settings;
    if (!s.adaptiveResolution) return;

    const ms = rawDt * 1000;
    // Ignore obvious hitches (GC, shader compile) so they do not force a drop.
    if (ms < 200) this.frameCostAvg += (ms - this.frameCostAvg) * 0.06;

    this.adaptCooldown -= rawDt;
    if (this.adaptCooldown > 0) return;

    const budget = 1000 / s.targetFps;
    const prev = s.renderScale;
    if (this.frameCostAvg > budget * 1.22) {
      s.renderScale = Math.max(0.62, s.renderScale - 0.06);
    } else if (this.frameCostAvg < budget * 0.82) {
      s.renderScale = Math.min(1, s.renderScale + 0.03);
    }
    if (Math.abs(s.renderScale - prev) > 1e-4) {
      this.adaptCooldown = 0.6;
      this.resizePending = true;
    }
  }

  private applyResize(): void {
    this.resizePending = false;
    const world = this.world;
    const s = world.settings;

    const cssW = Math.max(1, Math.floor(innerWidth));
    const cssH = Math.max(1, Math.floor(innerHeight));
    const dpr = Math.min(devicePixelRatio || 1, s.maxPixelRatio) * s.renderScale;

    world.renderer.setPixelRatio(1);
    world.renderer.setSize(cssW, cssH, true);
    // We drive the backing store ourselves so renderScale is exact.
    const bw = Math.max(1, Math.floor(cssW * dpr));
    const bh = Math.max(1, Math.floor(cssH * dpr));
    world.renderer.domElement.width = bw;
    world.renderer.domElement.height = bh;
    world.renderer.setViewport(0, 0, bw, bh);

    world.size.width = bw;
    world.size.height = bh;
    world.size.dpr = dpr;

    world.camera.aspect = cssW / cssH;
    world.camera.fov = s.fov;
    world.camera.updateProjectionMatrix();

    for (const m of this.modules) m.resize?.(world);
    this.renderHook?.resize?.(world);
    world.bus.emit('resize');
  }
}

export type { Settings };
