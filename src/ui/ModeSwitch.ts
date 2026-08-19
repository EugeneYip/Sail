import { add, el, setAttr } from './dom';
import type { HudMode } from './mode';

/**
 * The one piece of chrome a new player has to find: two words at the top right,
 * beside the menu rule. Reading "minimal · pro" tells you both that there is
 * another mode and which one you are in, which a single icon never does.
 *
 * It never takes focus from a pointer press — a dead helm after a click on the
 * HUD would be exactly the "tripping over it" we are avoiding — but it stays
 * fully keyboard reachable.
 */
export class ModeSwitch {
  readonly root: HTMLElement;
  onPick: (mode: HudMode) => void = () => {};

  private btns: Partial<Record<HudMode, HTMLButtonElement>> = {};

  constructor() {
    this.root = el('div', 'modesw');
    this.root.setAttribute('role', 'radiogroup');
    this.root.setAttribute('aria-label', 'Instruments');

    this.btns.minimal = this.button('minimal', 'Simple instruments — speed and heading');
    add(this.root, el('span', 'modesw-d'));
    this.btns.pro = this.button('pro', 'Full instruments — compass, wind, sail plan, chart');
  }

  private button(mode: HudMode, title: string): HTMLButtonElement {
    const b = add(this.root, el('button', 'modesw-b', mode));
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.title = `${title}  (I)`;
    // Pressing a button focuses it, which sets input.uiFocus and kills the
    // helm until something else takes focus. Suppress the focus, keep the click.
    b.addEventListener('pointerdown', (e) => e.preventDefault());
    b.addEventListener('click', () => this.onPick(mode));
    return b;
  }

  set(mode: HudMode): void {
    for (const k of ['minimal', 'pro'] as const) {
      const b = this.btns[k];
      if (!b) continue;
      const on = k === mode;
      setAttr(b, 'aria-checked', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    }
  }
}
