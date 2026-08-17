/**
 * Minimal DOM/SVG construction helpers plus write-gating.
 *
 * Every mutation in the HUD goes through `setText` / `setAttr`, which cache the
 * last written value on the node itself. A cache hit costs one string compare;
 * the DOM is only touched when the *displayed* value actually changed. This is
 * what keeps the UI off the frame budget — see UiLayer for the rate strategy.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

type Cache = Record<string, string | undefined>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  if (attrs) for (const k in attrs) node.setAttribute(k, String(attrs[k]));
  return node;
}

/** An <svg> root sized by viewBox, scaled by CSS. */
export function svgRoot(className: string, w: number, h: number): SVGSVGElement {
  const s = svg('svg', { viewBox: `0 0 ${w} ${h}`, 'aria-hidden': 'true', focusable: 'false' });
  s.setAttribute('class', className);
  return s;
}

export function add<T extends Node>(parent: Node, child: T): T {
  parent.appendChild(child);
  return child;
}

/** Write textContent only when the string differs from the last write. */
export function setText(node: Element, value: string): void {
  const c = node as unknown as { __t?: string };
  if (c.__t === value) return;
  c.__t = value;
  node.textContent = value;
}

/** Write an attribute only when it differs from the last write. */
export function setAttr(node: Element, name: string, value: string | number): void {
  const n = node as unknown as { __a?: Cache };
  const cache = n.__a ?? (n.__a = {});
  const v = typeof value === 'number' ? fixed2(value) : value;
  if (cache[name] === v) return;
  cache[name] = v;
  node.setAttribute(name, v);
}

/** CSS transform on an HTMLElement — compositor path, gated the same way. */
export function setTransform(node: HTMLElement, value: string): void {
  const c = node as unknown as { __x?: string };
  if (c.__x === value) return;
  c.__x = value;
  node.style.transform = value;
}

export function setClass(node: Element, name: string, on: boolean): void {
  const c = node as unknown as { __c?: Record<string, boolean> };
  const cache = c.__c ?? (c.__c = {});
  if (cache[name] === on) return;
  cache[name] = on;
  node.classList.toggle(name, on);
}

/** Two decimals max, no trailing zeros — keeps attribute strings short. */
function fixed2(v: number): string {
  const r = Math.round(v * 100) / 100;
  return Object.is(r, -0) ? '0' : String(r);
}

/** Label + value row used by every readout block in the HUD. */
export function statRow(parent: Element, label: string): HTMLElement {
  const row = add(parent, el('div', 'stat'));
  add(row, el('span', 'stat-k', label));
  return add(row, el('span', 'stat-v'));
}
