import * as THREE from 'three';
import type { InputState, Module, World } from '../types';

/**
 * Keyboard + pointer input, smoothed into analogue axes so the ship never
 * receives a step input. Also owns pointer-lock free-look.
 *
 * THE ARROW KEYS ARE THE WHOLE GAME. Left/right put the wheel over; up/down
 * are the throttle — more canvas, less canvas — which in assist mode is all the
 * sail handling there is, because the watch braces the yards and reefs on its
 * own (`physics/Trim.ts`). WASD is the same four axes for players who expect
 * it, and Q/E braces the yards by hand for anyone who wants to. Nothing else is
 * needed to sail.
 *
 * In assist mode the axes are also quicker to answer: half a second of ramp on
 * the helm is most of what makes the Pro ship feel like it is ignoring you, and
 * it is not the part of the ship's mass anyone enjoys.
 */
export class InputSystem implements Module {
  readonly name = 'input';

  private keys = new Set<string>();
  private fresh = new Set<string>();
  private consumed = new Set<string>();
  private rawSteer = 0;
  private rawTrim = 0;
  private rawBrace = 0;
  private pendingYaw = 0;
  private pendingPitch = 0;
  private pendingZoom = 0;
  private dragging = false;
  private state!: InputState;

  init(world: World): void {
    this.state = world.input;

    const dom = world.renderer.domElement;

    addEventListener('keydown', (e) => {
      if (this.isTypingTarget(e.target)) return;
      const k = e.key.toLowerCase();
      if (!this.keys.has(k)) this.fresh.add(k);
      this.keys.add(k);
      // Stop the page scrolling / browser shortcuts stealing game keys.
      if (GAME_KEYS.has(k) || e.code === 'Space') e.preventDefault();
    });

    addEventListener('keyup', (e) => {
      const k = e.key.toLowerCase();
      this.keys.delete(k);
      this.consumed.delete(k);
    });

    addEventListener('blur', () => {
      this.keys.clear();
      this.fresh.clear();
      this.dragging = false;
    });

    dom.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      this.dragging = true;
      dom.setPointerCapture(e.pointerId);
    });
    dom.addEventListener('pointerup', (e) => {
      this.dragging = false;
      if (dom.hasPointerCapture(e.pointerId)) dom.releasePointerCapture(e.pointerId);
    });
    dom.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      this.pendingYaw -= e.movementX * 0.0028;
      this.pendingPitch -= e.movementY * 0.0028;
    });
    dom.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.pendingZoom += Math.sign(e.deltaY) * Math.min(1, Math.abs(e.deltaY) / 120);
      },
      { passive: false },
    );
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  update(world: World): void {
    const dt = world.time.dt;
    const s = this.state;

    // --- analogue axes with asymmetric attack/release for a heavy-ship feel.
    const steerIn = (this.held('a') || this.held('arrowleft') ? -1 : 0) + (this.held('d') || this.held('arrowright') ? 1 : 0);
    const trimIn = (this.held('w') || this.held('arrowup') ? 1 : 0) + (this.held('s') || this.held('arrowdown') ? -1 : 0);
    const braceIn = (this.held('q') ? -1 : 0) + (this.held('e') ? 1 : 0);

    const attack = world.settings.assist ? ASSIST_STEER_ATTACK : STEER_ATTACK;
    this.rawSteer = approach(this.rawSteer, steerIn, dt, steerIn === 0 ? STEER_RELEASE : attack);
    this.rawTrim = approach(this.rawTrim, trimIn, dt, 8);
    this.rawBrace = approach(this.rawBrace, braceIn, dt, 6);

    s.steer = this.rawSteer;
    s.sailTrim = this.rawTrim;
    s.brace = this.rawBrace;

    s.lookYaw = this.pendingYaw;
    s.lookPitch = this.pendingPitch;
    s.zoom = this.pendingZoom;
    this.pendingYaw = 0;
    this.pendingPitch = 0;
    this.pendingZoom = 0;

    s.cameraNext = this.justPressedInternal('c');
    s.keys = this.keys;

    // Rotate the fresh set into "consumed" so justPressed is true for one frame.
    for (const k of this.fresh) this.consumed.add(k);
    this.fresh.clear();
  }

  /** Bound onto the InputState so modules can call world.input.pressed(). */
  bind(state: InputState): void {
    state.pressed = (code: string) => this.keys.has(code.toLowerCase());
    state.justPressed = (code: string) => this.justPressedInternal(code);
  }

  private held(k: string): boolean {
    return !this.state.uiFocus && this.keys.has(k);
  }

  private justPressedInternal(k: string): boolean {
    const key = k.toLowerCase();
    return !this.state.uiFocus && this.fresh.has(key) && !this.consumed.has(key);
  }

  private isTypingTarget(t: EventTarget | null): boolean {
    if (!(t instanceof HTMLElement)) return false;
    return t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName);
  }
}

/** Helm ramp rates, 1/s. Assist puts the wheel over in a third of the time. */
const STEER_ATTACK = 2.1;
const ASSIST_STEER_ATTACK = 6.5;
/** Coming off the key is always quicker than going on: she wants to run straight. */
const STEER_RELEASE = 3.4;

const GAME_KEYS = new Set([
  'w', 'a', 's', 'd', 'q', 'e', 'c', 'r', 'f', 'v', 'g', 'h', 'x', 'z',
  'arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' ',
]);

/** Exponential approach that is stable at any dt. */
function approach(current: number, target: number, dt: number, rate: number): number {
  return THREE.MathUtils.lerp(current, target, 1 - Math.exp(-rate * dt));
}

export function createInputState(): InputState {
  return {
    steer: 0,
    sailTrim: 0,
    brace: 0,
    cameraNext: false,
    lookYaw: 0,
    lookPitch: 0,
    zoom: 0,
    uiFocus: false,
    keys: new Set<string>(),
    pressed: () => false,
    justPressed: () => false,
  };
}
