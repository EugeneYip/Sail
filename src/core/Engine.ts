import * as THREE from 'three';
import type { CameraRigState, FrameTime, Module, Settings, World } from '../types';
import { createEventBus } from './EventBus';
import { createSharedUniforms } from './SharedUniforms';
import { createEnvironment, createShipState } from './State';
import { applyQualityPreset, guessQuality, loadSettings, saveSettings } from './Settings';
import { createInputState } from '../input/Input';
import type { AdaptState } from './AdaptiveResolution';
import {
  ADAPT_OPENING_MPX,
  ADAPT_SETTLE,
  SCALE_LADDER,
  adaptFrame,
  createAdaptState,
  resetAdaptWindow,
  seedOpeningLevel,
  syncAdaptLevel,
} from './AdaptiveResolution';

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
  /** See `src/core/AdaptiveResolution.ts` — the control law lives there. */
  private adapt: AdaptState = createAdaptState();
  private adaptSeeded = false;

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
   *
   * The decision is in `src/core/AdaptiveResolution.ts`, as a pure function of
   * frame periods, because a vsync-driven controller cannot be tested by
   * rendering in a headless browser: rAF here is a 60 Hz rate limiter, so a
   * 20 ms frame reports a 20 ms period where a real panel would present it at
   * 33.3 ms. `.tmp/adaptsim.mjs` imports that module and drives it with frame
   * costs measured by a fixed-scale sweep, quantised as a display would.
   */
  private adaptResolution(rawDt: number): void {
    const s = this.world.settings;
    if (!s.adaptiveResolution) {
      // Re-enabling mid-session must start from clean evidence, not from
      // whatever the window held when it was switched off.
      resetAdaptWindow(this.adapt, ADAPT_SETTLE);
      return;
    }

    // Re-anchor first: the settings panel, a quality preset or a probe may have
    // set `renderScale` directly, and a controller that ignored that would yank
    // the picture back to its own idea of the level.
    if (syncAdaptLevel(this.adapt, s.renderScale)) {
      s.renderScale = SCALE_LADDER[this.adapt.level];
      this.resizePending = true;
    }

    if (adaptFrame(this.adapt, rawDt * 1000, s.targetFps)) {
      s.renderScale = SCALE_LADDER[this.adapt.level];
      this.resizePending = true;
    }

    const a = this.adapt;
    this.world.stats['adapt:level'] = a.level;
    this.world.stats['adapt:scale'] = SCALE_LADDER[a.level];
    this.world.stats['adapt:hitRate'] = a.hitRate;
    this.world.stats['adapt:meanMs'] = a.meanMs;
    this.world.stats['adapt:intervals'] = a.intervals;
    this.world.stats['adapt:hold'] = a.hold;
    this.world.stats['adapt:probeHold'] = a.probeHold;
    this.world.stats['adapt:failLevel'] = a.failLevel;
    this.world.stats['adapt:windows'] = a.windows;
    this.world.stats['adapt:steps'] = a.steps;
  }

  private applyResize(): void {
    this.resizePending = false;
    const world = this.world;
    const s = world.settings;

    const cssW = Math.max(1, Math.floor(innerWidth));
    const cssH = Math.max(1, Math.floor(innerHeight));

    /*
     * The opening bid. A first-run Retina machine at `ultra` opens at
     * 3200x1800 = 5.76 Mpx — measured at 0% of frames inside one vsync and a
     * p50 90 ms period — and the controller needs a boot grace plus one window
     * before it can act. Without a cap the first seconds of every session, the
     * title screen the owner reported as the worst part, are the worst frames
     * in it. This caps only the OPENING size; the controller climbs straight
     * back out if the machine can take it, and at dpr 1 (1.44 Mpx) it does
     * nothing at all.
     */
    if (!this.adaptSeeded) {
      this.adaptSeeded = true;
      if (s.adaptiveResolution) {
        const pr = Math.min(devicePixelRatio || 1, s.maxPixelRatio);
        this.adapt.level = seedOpeningLevel(cssW * cssH * pr * pr);
        s.renderScale = SCALE_LADDER[this.adapt.level];
        world.stats['adapt:openingMpx'] = ADAPT_OPENING_MPX;
      }
    }

    const dpr = Math.min(devicePixelRatio || 1, s.maxPixelRatio) * s.renderScale;

    world.renderer.setPixelRatio(1);
    world.renderer.setSize(cssW, cssH, true);
    // We drive the backing store ourselves so renderScale is exact.
    const bw = Math.max(1, Math.floor(cssW * dpr));
    const bh = Math.max(1, Math.floor(cssH * dpr));
    world.renderer.domElement.width = bw;
    world.renderer.domElement.height = bh;
    world.renderer.setViewport(0, 0, bw, bh);

    // Any change of backing store reallocates the post stack, whoever asked for
    // it — the controller, a settings change, or the player dragging the window
    // edge. Throw the decision window away so a reallocation is never read as
    // evidence about resolution.
    if (bw !== world.size.width || bh !== world.size.height) {
      resetAdaptWindow(this.adapt, ADAPT_SETTLE);
    }

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
