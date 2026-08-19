import type { World } from '../types';
import { FIRST_RUN } from './bindings';
import { add, el, setClass, setTransform, svg, svgRoot } from './dom';
import type { HudMode } from './mode';

const SEEN_KEY = 'leeward.ui.seen.v1';
/** The controls card gives up on its own if the player just watches. */
const FIRST_RUN_MAX_S = 18;

/**
 * Title card over the live scene, then a controls card on a first voyage.
 *
 * The loading state is real: it tracks web fonts, the first frames actually
 * rendered (which is when shader compilation stalls show up) and the ocean
 * handle appearing on the blackboard. "Begin" only appears once all three are
 * in, so nobody is invited aboard mid-hitch.
 */
export class Title {
  readonly root: HTMLElement;
  onBegin: () => void = () => {};

  private bar: HTMLElement;
  private begin: HTMLButtonElement;
  private loadRow: HTMLElement;
  private fontsReady = false;
  private ready = false;
  private dismissed = false;
  private lastP = -1;

  constructor() {
    this.root = el('div', 'intro');
    const inner = add(this.root, el('div', 'intro-in'));

    add(inner, el('div', 'intro-eyebrow', 'Leeward'));
    add(inner, el('h1', 'intro-title', 'Constitution'));
    add(inner, el('div', 'intro-rule'));
    add(inner, el('p', 'intro-flavour',
      'Forty-four guns, three masts of flax, and the whole Atlantic to leeward.'));

    this.begin = add(inner, el('button', 'intro-begin'));
    this.begin.type = 'button';
    add(this.begin, el('span', 'intro-begin-t', 'Begin'));
    add(this.begin, el('span', 'intro-begin-h', 'enter'));
    this.begin.addEventListener('click', () => this.dismiss());

    this.loadRow = add(inner, el('div', 'intro-load'));
    const track = add(this.loadRow, el('div', 'intro-track'));
    this.bar = add(track, el('div', 'intro-bar'));
    add(this.loadRow, el('span', 'intro-load-t', 'Making sail'));

    void document.fonts?.ready.then(() => (this.fontsReady = true));
    // A browser without the Font Loading API must not stall the door shut.
    if (!document.fonts) this.fontsReady = true;
  }

  get active(): boolean {
    return !this.dismissed;
  }

  update(world: World): void {
    if (this.dismissed || this.ready) return;

    const p = (
      (this.fontsReady ? 1 : 0) +
      Math.min(1, world.time.frame / 14) +
      (world.ocean ? 1 : 0)
    ) / 3;

    if (Math.abs(p - this.lastP) > 0.01) {
      this.lastP = p;
      setTransform(this.bar, `scaleX(${p.toFixed(3)})`);
    }
    if (p >= 0.999) {
      this.ready = true;
      setClass(this.root, 'ready', true);
      this.begin.focus({ preventScroll: true });
    }
  }

  dismiss(instant = false): void {
    if (this.dismissed) return;
    this.dismissed = true;
    setClass(this.root, 'gone', true);
    if (instant) this.root.style.display = 'none';
    else setTimeout(() => (this.root.style.display = 'none'), 1100);
    this.onBegin();
  }

  /** Enter/Space anywhere is the same as pressing Begin. */
  tryBeginFromKey(): boolean {
    if (this.dismissed || !this.ready) return false;
    this.dismiss();
    return true;
  }
}

/**
 * The whole tutorial: two arrow keys and one line of italic.
 *
 * It is built at `show()`, not in the constructor, because what it has to say
 * depends on the mode the player is actually in and on whether they have a
 * keyboard at all. It gives up as soon as the helm moves.
 */
export class FirstRunCard {
  readonly root: HTMLElement;
  private shown = false;
  private done = false;
  private built = false;
  private t = 0;

  constructor() {
    this.root = el('div', 'firstrun');
  }

  get needed(): boolean {
    try {
      return localStorage.getItem(SEEN_KEY) === null;
    } catch {
      return true;
    }
  }

  show(mode: HudMode, touch: boolean): void {
    if (this.done || !this.needed) {
      this.done = true;
      return;
    }
    if (!this.built) {
      this.built = true;
      if (mode === 'pro') this.buildPro();
      else this.buildMinimal(touch);
    }
    this.shown = true;
    setClass(this.root, 'on', true);
  }

  private buildMinimal(touch: boolean): void {
    setClass(this.root, 'firstrun-min', true);
    const row = add(this.root, el('div', 'chip'));
    if (touch) {
      for (const d of ['M15 5 L8.5 12 L15 19', 'M9 5 L15.5 12 L9 19']) {
        const s = add(add(row, el('span', 'chip-k chip-g')), svgRoot('chip-svg', 24, 24));
        add(s, svg('path', { d, class: 'pad-c' }));
      }
      add(row, el('span', 'chip-l', 'steer'));
    } else {
      add(row, el('span', 'chip-k', '←'));
      add(row, el('span', 'chip-k', '→'));
      add(row, el('span', 'chip-l', 'steer'));
    }
    add(this.root, el('div', 'chip chip-note', 'the watch will see to the sails'));
  }

  private buildPro(): void {
    for (const b of FIRST_RUN) {
      const chip = add(this.root, el('div', 'chip'));
      const keys = add(chip, el('span', 'chip-k'));
      keys.textContent = b.keys.join(' ');
      add(chip, el('span', 'chip-l', b.label));
    }
    add(this.root, el('div', 'chip chip-note', 'take the helm when you are ready'));
  }

  update(world: World): void {
    if (!this.shown || this.done) return;
    this.t += world.time.dt;
    const moved =
      Math.abs(world.input.steer) > 0.12 ||
      Math.abs(world.input.sailTrim) > 0.12 ||
      Math.abs(world.input.brace) > 0.12;
    if (this.t > 1.2 && (moved || this.t > FIRST_RUN_MAX_S)) this.hide();
  }

  hide(): void {
    if (this.done) return;
    this.done = true;
    this.shown = false;
    setClass(this.root, 'on', false);
    try {
      localStorage.setItem(SEEN_KEY, '1');
    } catch {
      /* private mode — the card simply shows again next time */
    }
    setTimeout(() => (this.root.style.display = 'none'), 900);
  }
}

