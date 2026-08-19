import { add, el, setClass, svg, svgRoot } from './dom';

type Dir = 'left' | 'right' | 'up' | 'down';

const CHEVRON: Record<Dir, string> = {
  left: 'M15 5 L8.5 12 L15 19',
  right: 'M9 5 L15.5 12 L9 19',
  up: 'M5 15 L12 8.5 L19 15',
  down: 'M5 9 L12 15.5 L19 9',
};

const KEY: Record<Dir, string> = {
  left: 'ArrowLeft',
  right: 'ArrowRight',
  up: 'ArrowUp',
  down: 'ArrowDown',
};

/**
 * The arrow keys, for a thumb.
 *
 * If arrow keys are the whole control scheme then a phone needs the same four
 * keys, so these pads do not talk to the blackboard at all — they synthesise
 * the very keystrokes they are drawn as. One control path, no second input
 * model to keep in agreement, and `world.input` smoothing applies unchanged.
 *
 * Steering lives in the two bottom corners where thumbs already are. The sail
 * pair only exists in Pro mode: in the default mode the watch trims for you.
 */
export class TouchControls {
  readonly root: HTMLElement;

  private held = new Set<Dir>();
  private detach: Array<() => void> = [];
  private enabled = false;

  constructor() {
    this.root = el('div', 'touch');
    this.pad('left', 'pad pad-l', 'Helm to port');
    this.pad('right', 'pad pad-r', 'Helm to starboard');
    const sail = add(this.root, el('div', 'pad-sail'));
    this.pad('up', 'pad pad-u', 'Make sail', sail);
    this.pad('down', 'pad pad-d', 'Take in sail', sail);

    const onBlur = (): void => this.releaseAll();
    addEventListener('blur', onBlur);
    this.detach.push(() => removeEventListener('blur', onBlur));
  }

  /**
   * Shown on a touch device, and on anything else the moment a finger actually
   * lands — a laptop with a touchscreen should not carry thumb pads it will
   * never use. Returns true the first time it turns on.
   */
  watch(onEnable: () => void): void {
    const coarse = matchMedia('(pointer: coarse)');
    if (coarse.matches || (navigator.maxTouchPoints > 0 && matchMedia('(hover: none)').matches)) {
      this.enabled = true;
      onEnable();
      return;
    }
    const first = (e: PointerEvent): void => {
      if (e.pointerType !== 'touch' || this.enabled) return;
      this.enabled = true;
      onEnable();
    };
    addEventListener('pointerdown', first, { capture: true, passive: true });
    this.detach.push(() => removeEventListener('pointerdown', first, { capture: true }));
  }

  get active(): boolean {
    return this.enabled;
  }

  dispose(): void {
    this.releaseAll();
    for (const d of this.detach) d();
    this.detach.length = 0;
  }

  private pad(dir: Dir, cls: string, label: string, parent?: HTMLElement): void {
    const b = add(parent ?? this.root, el('div', cls));
    b.setAttribute('role', 'button');
    b.setAttribute('aria-label', label);
    const s = add(b, svgRoot('pad-g', 24, 24));
    add(s, svg('path', { d: CHEVRON[dir], class: 'pad-c' }));

    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      capture(b, e.pointerId, true);
      this.press(dir, b, true);
    });
    const up = (e: PointerEvent): void => {
      capture(b, e.pointerId, false);
      this.press(dir, b, false);
    };
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
    b.addEventListener('lostpointercapture', () => this.press(dir, b, false));
    b.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private press(dir: Dir, node: HTMLElement, down: boolean): void {
    if (this.held.has(dir) === down) return;
    if (down) this.held.add(dir);
    else this.held.delete(dir);
    setClass(node, 'on', down);
    key(down ? 'keydown' : 'keyup', KEY[dir]);
  }

  private releaseAll(): void {
    for (const dir of this.held) key('keyup', KEY[dir]);
    this.held.clear();
    for (const n of this.root.querySelectorAll('.pad')) setClass(n, 'on', false);
  }
}

/** Capture keeps a slide off the pad from leaving the helm hard over. */
function capture(node: HTMLElement, id: number, on: boolean): void {
  try {
    if (on) node.setPointerCapture(id);
    else if (node.hasPointerCapture(id)) node.releasePointerCapture(id);
  } catch {
    /* a synthetic or already-released pointer id — the press still counts */
  }
}

/**
 * Dispatched on the document element rather than window: the input system reads
 * `e.target` and window is not a Node.
 */
function key(type: 'keydown' | 'keyup', name: string): void {
  document.documentElement.dispatchEvent(
    new KeyboardEvent(type, { key: name, code: name, bubbles: true, cancelable: true }),
  );
}
