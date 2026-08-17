import type { Module, World } from '../types';
import { add, el, setClass, setText } from './dom';
import { HudView } from './HUD';
import { PhotoMode } from './PhotoMode';
import { saveCanvasPng } from './screenshot';
import { SettingsPanel } from './SettingsPanel';
import { FirstRunCard, Title } from './Title';

/**
 * The one UI module. Owns the DOM, the key bindings, the idle fade and the
 * update rates.
 *
 * Rate plan, per frame at 60 fps:
 *   every frame  — four transform attributes (compass strip, wind needles,
 *                  clinometer, chart glyph), each gated on an epsilon
 *   10 Hz        — every text readout and the sail plan, change-gated
 *    5 Hz        — the chart track and the debug overlay
 *    4 Hz        — settings-panel sync, only while it is open
 * Measured cost lands in `world.stats['ui:ms']` whether or not debug is on.
 */

const SLOW_MS = 100;
const CHART_MS = 200;
const IDLE_MS = 9000;

export class UiLayer implements Module {
  readonly name = 'ui';

  private root!: HTMLElement;
  private hud!: HudView;
  private title!: Title;
  private firstRun!: FirstRunCard;
  private panel!: SettingsPanel;
  private photo!: PhotoMode;
  private pauseEl!: HTMLElement;
  private toastEl!: HTMLElement;

  private lastActivity = 0;
  private slowAt = 0;
  private chartAt = 0;
  private toastUntil = 0;
  private paused = false;
  private hudOff = false;
  private captureMode = false;
  private focusInUi = false;
  private uiMs = 0;
  private detach: Array<() => void> = [];
  private extState = { paused: false, hudVisible: true, panelOpen: false, photoMode: false };

  init(world: World): void {
    const host = document.getElementById('ui-root');
    if (!host) throw new Error('#ui-root missing');

    // The placeholder HUD may still be mounted after a hot reload.
    host.querySelector('.hud-debug')?.remove();

    this.root = add(host, el('div', 'ui'));
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setClass(this.root, 'still', true);
    }

    this.hud = new HudView(world);
    add(this.root, this.hud.root);

    this.panel = new SettingsPanel(world);
    add(this.root, this.panel.root);

    this.photo = new PhotoMode(world);
    add(this.root, this.photo.root);

    const menu = add(this.root, el('button', 'menu'));
    menu.type = 'button';
    menu.setAttribute('aria-label', "Open the ship's book");
    for (let i = 0; i < 3; i++) add(menu, el('span'));
    menu.addEventListener('click', () => this.panel.toggleOpen());

    this.pauseEl = add(this.root, el('div', 'pause'));
    add(this.pauseEl, el('div', 'pause-t', 'Paused'));
    add(this.pauseEl, el('div', 'pause-h', 'P to resume'));

    this.toastEl = add(this.root, el('div', 'toast'));

    this.firstRun = new FirstRunCard();
    add(this.root, this.firstRun.root);

    this.title = new Title();
    add(this.root, this.title.root);
    // The title plays over a slow drifting shot, not the chase camera.
    world.cam.mode = 'cinematic';
    this.title.onBegin = () => {
      world.cam.mode = 'chase';
      this.lastActivity = performance.now();
      this.firstRun.show();
    };

    this.panel.onPhoto = () => {
      this.panel.close();
      this.photo.enter();
    };
    this.panel.onShot = () => this.shoot(world);
    this.photo.onShot = () => this.shoot(world);

    this.bindKeys(world);
    this.bindActivity();

    this.detach.push(world.bus.on('capture:scene', () => this.enterCaptureMode()));
    this.detach.push(world.bus.on('capture:focusIsland', () => this.enterCaptureMode()));

    world.ext.ui = this.extState;
    this.lastActivity = performance.now();
  }

  /* ---------------------------------------------------------------- *
   *  frame
   * ---------------------------------------------------------------- */

  update(world: World): void {
    const t0 = performance.now();
    const s = world.settings;

    this.title.update(world);
    this.firstRun.update(world);

    if (this.paused || this.panel.hold.time) {
      // The weather system advances timeOfDay at the head of the frame; putting
      // it back here — after every consumer has run — holds the clock to within
      // a single frame of drift.
      world.env.timeOfDay = this.panel.hold.value;
    } else {
      this.panel.hold.value = world.env.timeOfDay;
    }

    const inp = world.input;
    if (
      Math.abs(inp.steer) > 0.02 || Math.abs(inp.sailTrim) > 0.02 ||
      Math.abs(inp.brace) > 0.02 || inp.lookYaw !== 0 || inp.lookPitch !== 0 || inp.zoom !== 0
    ) {
      this.lastActivity = t0;
    }

    inp.uiFocus = this.panel.isOpen || this.title.active || this.paused || this.focusInUi;

    const visible = s.showHud && !this.hudOff && !this.photo.active && !this.title.active;
    const idle = !this.captureMode && !this.panel.isOpen && t0 - this.lastActivity > IDLE_MS;
    setClass(this.hud.root, 'off', !visible);
    setClass(this.hud.root, 'faded', visible && idle);
    this.extState.hudVisible = visible && !idle;
    this.extState.paused = this.paused;
    this.extState.panelOpen = this.panel.isOpen;
    this.extState.photoMode = this.photo.active;

    if (visible && !idle) {
      this.hud.updateFast(world);

      if (t0 - this.slowAt > SLOW_MS) {
        this.slowAt = t0;
        this.hud.updateSlow(world);
        if (s.debug) this.hud.updateDebug(world);
      }
      if (t0 - this.chartAt > CHART_MS) {
        this.chartAt = t0;
        this.hud.updateChart(world);
      }
    }
    this.hud.setDebugVisible(s.debug);

    if (this.panel.isOpen) this.panel.update(t0);
    this.photo.applyOverrides(world);

    if (this.toastUntil && t0 > this.toastUntil) {
      this.toastUntil = 0;
      setClass(this.toastEl, 'on', false);
    }

    // Exponential average: one number, no allocation, readable with debug off.
    this.uiMs += (performance.now() - t0 - this.uiMs) * 0.05;
    world.stats['ui:ms'] = this.uiMs;
  }

  dispose(): void {
    for (const d of this.detach) d();
    this.detach.length = 0;
    this.root.remove();
  }

  /* ---------------------------------------------------------------- *
   *  keys
   * ---------------------------------------------------------------- */

  private bindKeys(world: World): void {
    const onKeyDown = (e: KeyboardEvent): void => {
      const inUi = this.root.contains(e.target as Node);
      // A keystroke aimed at a control must never reach the helm. InputSystem
      // listens on window in the bubble phase, so stopping here is enough.
      if (inUi) e.stopPropagation();
      this.lastActivity = performance.now();

      switch (e.key) {
        case 'Escape':
          e.stopPropagation();
          if (this.photo.active) this.photo.exit();
          else if (this.panel.isOpen) this.panel.close();
          else if (this.paused) this.setPaused(false, world);
          else if (!this.title.active) this.panel.open();
          break;

        case 'Tab':
          if (inUi) return;
          e.preventDefault();
          e.stopPropagation();
          if (!this.title.active) this.panel.toggleOpen();
          break;

        case 'h':
        case 'H': {
          if (inUi || this.title.active) return;
          e.stopPropagation();
          this.hudOff = !this.hudOff;
          if (this.hudOff) this.toast('instruments stowed — H to bring them back');
          break;
        }

        case 'p':
        case 'P':
          if (inUi || this.title.active) return;
          e.stopPropagation();
          this.setPaused(!this.paused, world);
          break;

        case 'F2':
          e.preventDefault();
          e.stopPropagation();
          if (this.title.active) return;
          this.panel.close();
          this.photo.toggle();
          break;

        case 'F3':
          e.preventDefault();
          e.stopPropagation();
          world.settings.debug = !world.settings.debug;
          world.bus.emit('settings:changed');
          break;

        case 'Enter':
        case ' ':
          if (inUi || !this.title.active) return;
          if (this.title.tryBeginFromKey()) {
            e.preventDefault();
            e.stopPropagation();
          }
          break;

        default:
          break;
      }
    };

    const onKeyUp = (e: KeyboardEvent): void => {
      if (this.root.contains(e.target as Node)) e.stopPropagation();
    };

    addEventListener('keydown', onKeyDown, { capture: true });
    addEventListener('keyup', onKeyUp, { capture: true });
    this.detach.push(() => removeEventListener('keydown', onKeyDown, { capture: true }));
    this.detach.push(() => removeEventListener('keyup', onKeyUp, { capture: true }));

    const onFocusIn = (): void => {
      this.focusInUi = true;
    };
    const onFocusOut = (): void => {
      this.focusInUi = false;
    };
    this.root.addEventListener('focusin', onFocusIn);
    this.root.addEventListener('focusout', onFocusOut);
  }

  private bindActivity(): void {
    const mark = (): void => {
      this.lastActivity = performance.now();
    };
    for (const ev of ['pointermove', 'pointerdown', 'wheel', 'touchstart'] as const) {
      addEventListener(ev, mark, { capture: true, passive: true });
      this.detach.push(() => removeEventListener(ev, mark, { capture: true }));
    }
  }

  private setPaused(on: boolean, world: World): void {
    if (this.paused === on) return;
    this.paused = on;
    if (on) this.panel.hold.value = world.env.timeOfDay;
    setClass(this.pauseEl, 'on', on);
    // Nothing honours this yet — see the report. The UI freezes the clock and
    // the helm on its own so the state is at least truthful.
    world.bus.emit('ui:pause', on);
  }

  private enterCaptureMode(): void {
    this.captureMode = true;
    this.title.dismiss(true);
    this.firstRun.hide();
    this.panel.close();
    this.photo.exit();
    this.hudOff = false;
    this.paused = false;
    setClass(this.pauseEl, 'on', false);
  }

  private shoot(world: World): void {
    saveCanvasPng(world.renderer.domElement as HTMLCanvasElement, (ok) => {
      this.toast(ok ? 'frame saved' : 'could not read the frame buffer');
    });
  }

  private toast(msg: string): void {
    setText(this.toastEl, msg);
    setClass(this.toastEl, 'on', true);
    this.toastUntil = performance.now() + 2600;
  }
}
