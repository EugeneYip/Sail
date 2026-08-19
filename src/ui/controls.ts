import { add, el, setAttr, setText } from './dom';

/**
 * The control vocabulary: slider, switch, segmented choice, action, readout.
 *
 * Every control owns a `sync()` that pulls from the live blackboard, so a
 * value the simulation is moving on its own (time of day, render scale) stays
 * truthful in the panel. `sync()` refuses to fight the pointer: a control that
 * is focused or mid-drag is left alone.
 */

export interface Ctl {
  readonly el: HTMLElement;
  sync(): void;
}

let uid = 0;
const nextId = (): string => `lw-c${++uid}`;

function head(parent: Element, label: string, id?: string): HTMLElement {
  const h = add(parent, el('div', 'ctl-head'));
  const k = add(h, el(id ? 'label' : 'span', 'ctl-k', label));
  if (id) (k as HTMLLabelElement).htmlFor = id;
  return add(h, el('span', 'ctl-v'));
}

export interface SliderOpts {
  label: string;
  min: number;
  max: number;
  step: number;
  get(): number;
  set(v: number): void;
  fmt(v: number): string;
}

export function slider(parent: Element, o: SliderOpts, commit: () => void): Ctl {
  const id = nextId();
  const box = add(parent, el('div', 'ctl'));
  const val = head(box, o.label, id);

  const input = add(box, el('input', 'rng'));
  input.type = 'range';
  input.id = id;
  input.min = String(o.min);
  input.max = String(o.max);
  input.step = String(o.step);
  input.setAttribute('aria-label', o.label);

  let dragging = false;
  input.addEventListener('pointerdown', () => (dragging = true));
  input.addEventListener('pointerup', () => (dragging = false));
  input.addEventListener('pointercancel', () => (dragging = false));
  input.addEventListener('input', () => {
    const v = Number(input.value);
    o.set(v);
    setText(val, o.fmt(v));
    fill(input, o.min, o.max, v);
    commit();
  });

  const sync = (): void => {
    if (dragging || document.activeElement === input) return;
    const v = o.get();
    // Compare as numbers: the element snaps to the step grid, so a string
    // compare against an off-grid simulation value would rewrite every tick.
    if (Math.abs(input.valueAsNumber - v) > o.step * 0.5) input.value = String(v);
    setText(val, o.fmt(v));
    fill(input, o.min, o.max, v);
  };
  sync();
  return { el: box, sync };
}

/** The filled part of the track, as a CSS custom property. */
function fill(input: HTMLInputElement, min: number, max: number, v: number): void {
  const t = max === min ? 0 : (v - min) / (max - min);
  input.style.setProperty('--t', `${(t * 100).toFixed(2)}%`);
}

export interface ToggleOpts {
  label: string;
  get(): boolean;
  set(v: boolean): void;
}

export function toggle(parent: Element, o: ToggleOpts, commit: () => void): Ctl {
  const box = add(parent, el('div', 'ctl ctl-inline'));
  add(box, el('span', 'ctl-k', o.label));
  const btn = add(box, el('button', 'sw'));
  btn.type = 'button';
  btn.setAttribute('role', 'switch');
  btn.setAttribute('aria-label', o.label);
  add(btn, el('span', 'sw-dot'));

  btn.addEventListener('click', () => {
    o.set(!o.get());
    sync();
    commit();
  });

  const sync = (): void => setAttr(btn, 'aria-checked', o.get() ? 'true' : 'false');
  sync();
  return { el: box, sync };
}

export interface ChoiceOpts<T extends string | number> {
  label: string;
  options: readonly { v: T; t: string }[];
  get(): T;
  set(v: T): void;
}

export function choice<T extends string | number>(
  parent: Element,
  o: ChoiceOpts<T>,
  commit: () => void,
): Ctl {
  const box = add(parent, el('div', 'ctl'));
  add(add(box, el('div', 'ctl-head')), el('span', 'ctl-k', o.label));
  const seg = add(box, el('div', 'seg'));
  seg.setAttribute('role', 'radiogroup');
  seg.setAttribute('aria-label', o.label);

  const btns: HTMLButtonElement[] = [];
  o.options.forEach((opt, i) => {
    const b = add(seg, el('button'));
    b.type = 'button';
    b.textContent = opt.t;
    b.setAttribute('role', 'radio');
    b.addEventListener('click', () => {
      o.set(opt.v);
      sync();
      commit();
    });
    // Arrow keys walk a radiogroup, as they should.
    b.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      const t = btns[(i + d + btns.length) % btns.length];
      t.focus();
      t.click();
    });
    btns.push(b);
  });

  const sync = (): void => {
    const cur = o.get();
    o.options.forEach((opt, i) => {
      const on = opt.v === cur;
      setAttr(btns[i], 'aria-checked', on ? 'true' : 'false');
      btns[i].tabIndex = on ? 0 : -1;
    });
  };
  sync();
  return { el: box, sync };
}

export function action(parent: Element, label: string, text: string, onClick: () => void): Ctl {
  const box = add(parent, el('div', 'ctl ctl-inline'));
  add(box, el('span', 'ctl-k', label));
  const b = add(box, el('button', 'btn', text));
  b.type = 'button';
  b.addEventListener('click', onClick);
  return { el: box, sync: () => {} };
}

export function readout(parent: Element, label: string, get: () => string): Ctl {
  const box = add(parent, el('div', 'ctl ctl-inline'));
  add(box, el('span', 'ctl-k', label));
  const v = add(box, el('span', 'ctl-v'));
  const sync = (): void => setText(v, get());
  sync();
  return { el: box, sync };
}

/** A line of prose under a control — no value, no interaction. */
export function note(parent: Element, get: () => string): Ctl {
  const box = add(parent, el('div', 'ctl-note'));
  const sync = (): void => setText(box, get());
  sync();
  return { el: box, sync };
}

export function group(parent: Element, title: string): HTMLElement {
  const sec = add(parent, el('section', 'grp'));
  add(sec, el('h2', 'grp-t', title));
  return sec;
}
