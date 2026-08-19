import type { Module, World } from '../types';
import { DebugOverlay } from './Debug';
import { add, el, setClass, setText } from './dom';
import { HudView } from './HUD';
import { MiniHud } from './MiniHud';
import { type HudMode, readExternalMode, writeExternalMode } from './mode';
import { ModeSwitch } from './ModeSwitch';
import { PhotoMode } from './PhotoMode';
import { saveCanvasPng } from './screenshot';
import { SettingsPanel } from './SettingsPanel';
import { FirstRunCard, Title } from './Title';
import { TouchControls } from './TouchControls';

/**
 * The one UI module. Owns the DOM, the key bindings, the idle fade and the
 * update rates.
 *
 * Two modes share one root, one scrim and one fade. `minimal` is the default —
 * speed, heading, wind, and the rest of the frame left alone. `pro` is the full
 * instrument set, built the first time it is asked for so a default session
 * never pays for a compass strip it will not draw.
 *
 * Rate plan, per frame at 60 fps:
 *   every frame  — one transform in minimal (the wind arrow), four in Pro,
 *                  each gated on an epsilon
 *   10 Hz        — every text readout, change-gated
 *    5 Hz        — the chart track, the mode bridge and the debug overlay
 *    4 Hz        — settings-panel sync, only while it is open
 * Measured cost lands in `world.stats['ui:ms']` whether or not debug is on.
 */

const SLOW_MS = 100;
const CHART_MS = 200;
const IDLE_MS = 9000;

export class UiLayer implements Module {
  readonly name = 'ui';

  private root!: HTMLElement;
  private hudRoot!: HTMLElement;
  private mini!: MiniHud;
  private hud: HudView | null = null;
  private dbg!: DebugOverlay;
  private modeSw!: ModeSwitch;
  private touch!: TouchControls;
  private title!: Title;
  private firstRun!: FirstRunCard;
  private panel!: SettingsPanel;
  private photo!: PhotoMode;
  private pauseEl!: HTMLElement;
  private toastEl!: HTMLElement;

  private mode: HudMode = 'minimal';
  private lastExternal: HudMode | null = null;
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
  private extState = {
    paused: false, hudVisible: true, panelOpen: false, photoMode: false,
    mode: 'minimal' as HudMode, touch: false,
  };

  init(world: World): void {
    const host = document.getElementById('ui-root');
    if (!host) throw new Error('#ui-root missing');

    // The placeholder HUD may still be mounted after a hot reload.
    host.querySelector('.hud-debug')?.remove();

    this.root = add(host, el('div', 'ui'));
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setClass(this.root, 'still', true);
    }

    this.hudRoot = add(this.root, el('div', 'hud'));
    add(this.hudRoot, el('div', 'hud-scrim'));
    this.mini = new MiniHud();
    add(this.hudRoot, this.mini.root);
    this.dbg = new DebugOverlay();
    add(this.hudRoot, this.dbg.root);

    this.panel = new SettingsPanel(world);
    add(this.root, this.panel.root);

    this.photo = new PhotoMode(world);
    add(this.root, this.photo.root);

    this.modeSw = new ModeSwitch();
    add(this.root, this.modeSw.root);
    this.modeSw.onPick = (m) => this.setMode(m, world, true);

    const menu = add(this.root, el('button', 'menu'));
    menu.type = 'button';
    menu.setAttribute('aria-label', "Open the ship's book");
    for (let i = 0; i < 3; i++) add(menu, el('span'));
    menu.addEventListener('pointerdown', (e) => e.preventDefault());
    menu.addEventListener('click', () => this.panel.toggleOpen());

    this.touch = new TouchControls();
    add(this.root, this.touch.root);
    this.touch.watch(() => {
      // NOT 'touch' — the layer itself is .touch, and a bare class match on the
      // root would hit `.touch { display: none }` and hide the entire UI.
      setClass(this.root, 'has-touch', true);
      this.extState.touch = true;
    });

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
      this.firstRun.show(this.mode, this.touch.active);
    };

    this.panel.onPhoto = () => {
      this.panel.close();
      this.photo.enter();
    };
    this.panel.onShot = () => this.shoot(world);
    this.photo.onShot = () => this.shoot(world);
    this.panel.getMode = () => this.mode;
    this.panel.setMode = (m) => this.setMode(m, world, true);

    // A persisted choice is the player's; the handling layer's flag is only
    // consulted when there is no choice on record yet.
    this.applyMode(world.settings.hudMode ?? readExternalMode(world) ?? 'minimal', world);
    writeExternalMode(world, this.mode);
    this.lastExternal = readExternalMode(world);

    this.bindKeys(world);
    this.bindActivity();

    this.detach.push(world.bus.on('capture:scene', () => this.enterCaptureMode()));
    this.detach.push(world.bus.on('capture:focusIsland', () => this.enterCaptureMode()));
    this.detach.push(world.bus.on('settings:changed', () => {
      const want = world.settings.hudMode;
      if (want && want !== this.mode) this.applyMode(want, world);
    }));

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
    setClass(this.hudRoot, 'off', !visible);
    setClass(this.hudRoot, 'faded', visible && idle);
    setClass(this.modeSw.root, 'off', !visible);
    setClass(this.modeSw.root, 'faded', visible && idle);
    // The helm is not an instrument: hiding the readouts must not strand a
    // player who has no keyboard to press H with.
    setClass(this.touch.root, 'off', this.title.active || this.photo.active || this.paused);
    setClass(this.hudRoot, 'show-dbg', s.debug);
    this.extState.hudVisible = visible && !idle;
    this.extState.paused = this.paused;
    this.extState.panelOpen = this.panel.isOpen;
    this.extState.photoMode = this.photo.active;

    if (visible && !idle) {
      const pro = this.mode === 'pro' && this.hud;
      if (pro) this.hud!.updateFast(world);
      else this.mini.updateFast(world);

      if (t0 - this.slowAt > SLOW_MS) {
        this.slowAt = t0;
        if (pro) this.hud!.updateSlow(world);
        else this.mini.updateSlow(world);
        if (s.debug) this.dbg.update(world);
      }
      if (t0 - this.chartAt > CHART_MS) {
        this.chartAt = t0;
        if (pro) this.hud!.updateChart(world);
        this.syncExternalMode(world);
      }
    }

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
    this.touch.dispose();
    this.root.remove();
  }

  /* ---------------------------------------------------------------- *
   *  mode
   * ---------------------------------------------------------------- */

  /** Change the mode and tell everyone else. */
  private setMode(mode: HudMode, world: World, announce: boolean): void {
    if (mode === this.mode) return;
    this.applyMode(mode, world);
    writeExternalMode(world, mode);
    this.lastExternal = readExternalMode(world);
    // Persists the choice and lets the handling layer re-read it.
    world.bus.emit('settings:changed');
    if (announce) {
      this.toast(mode === 'pro' ? 'full instruments — I for simple' : 'simple instruments — I for full');
    }
  }

  /** Change the mode without broadcasting — used when someone else set it. */
  private applyMode(mode: HudMode, world: World): void {
    this.mode = mode;
    world.settings.hudMode = mode;
    if (mode === 'pro' && !this.hud) {
      this.hud = new HudView(world);
      add(this.hudRoot, this.hud.root);
    }
    setClass(this.hudRoot, 'm-pro', mode === 'pro');
    setClass(this.root, 'm-pro', mode === 'pro');
    this.modeSw.set(mode);
    this.extState.mode = mode;
    this.slowAt = 0;
    this.chartAt = 0;
  }

  /** 5 Hz: adopt a mode the handling layer changed under us. */
  private syncExternalMode(world: World): void {
    const ext = readExternalMode(world);
    if (!ext || ext === this.lastExternal) return;
    this.lastExternal = ext;
    if (ext !== this.mode) this.applyMode(ext, world);
  }

  /* ---------------------------------------------------------------- *
   *  keys
   * ---------------------------------------------------------------- */

  private bindKeys(world: World): void {
    const onKeyDown = (e: KeyboardEvent): void => {
      const t = e.target;
      const inUi = t instanceof Node && this.root.contains(t);
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

        case 'i':
        case 'I':
          if (inUi || this.title.active) return;
          e.stopPropagation();
          this.setMode(this.mode === 'pro' ? 'minimal' : 'pro', world, true);
          break;

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
      const t = e.target;
      if (t instanceof Node && this.root.contains(t)) e.stopPropagation();
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
