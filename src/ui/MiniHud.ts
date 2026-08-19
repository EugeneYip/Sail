import type { World } from '../types';
import { add, el, setAttr, setClass, setText, svg, svgRoot } from './dom';
import { bearing3, bearingDeg, cardinal, deltaDeg } from './format';

/**
 * The default screen. Speed, heading, where the wind is — nothing else.
 *
 * One corner of one edge, the rest of the frame left to the sea. The type is
 * the same as the Pro instruments (Cormorant for display, Inter micro-caps for
 * labels, JetBrains Mono with tabular figures for anything that counts) so the
 * two modes read as one designer, just at different volumes.
 *
 * Cost: three change-gated strings at 10 Hz and one compositor transform per
 * frame, quantised to a degree so a steady course writes nothing at all.
 */
export class MiniHud {
  readonly root: HTMLElement;

  private speed: HTMLElement;
  private hdg: HTMLElement;
  private card: HTMLElement;
  private windArrow: SVGGElement;
  private ironsRow: HTMLElement;

  constructor() {
    this.root = el('div', 'mini');

    const line = add(this.root, el('div', 'speedline'));
    this.speed = add(line, el('span', 'speed'));
    add(line, el('span', 'speed-u', 'kn'));

    const h = add(this.root, el('div', 'mini-hdg'));
    this.hdg = add(h, el('span', 'mini-deg'));
    this.card = add(h, el('span', 'mini-card'));

    const w = add(this.root, el('div', 'mini-wind'));
    const s = add(w, svgRoot('mini-wind-g', 24, 24));
    this.windArrow = add(s, svg('g'));
    // A flow arrow — it points the way the air goes, so a headwind points aft
    // and a fair wind points ahead. Bow is up; drawn pointing up at rotation 0.
    add(this.windArrow, svg('line', { x1: 12, y1: 21, x2: 12, y2: 7, class: 'mw-stem' }));
    add(this.windArrow, svg('path', { d: 'M12 2.5 L8.6 9.6 L12 7.9 L15.4 9.6 Z', class: 'mw-head' }));
    add(w, el('span', 'mini-wind-l', 'wind'));

    this.ironsRow = add(this.root, el('div', 'mini-irons', 'in irons — bear away'));
  }

  /** Per frame. The needle is the only thing that moves smoothly. */
  updateFast(world: World): void {
    // True wind relative to the bow, then reversed: the arrow shows the flow,
    // not the source, which is what reads at 15 px.
    const rel = deltaDeg(bearingDeg(world.env.windBearing), bearingDeg(world.ship.heading));
    setAttr(this.windArrow, 'transform', `rotate(${Math.round(rel + 180)} 12 12)`);
  }

  /** ~10 Hz. */
  updateSlow(world: World): void {
    const ship = world.ship;
    setText(this.speed, ship.speedKnots.toFixed(1));
    const deg = bearingDeg(ship.heading);
    setText(this.hdg, `${bearing3(deg)}°`);
    setText(this.card, cardinal(deg));
    setClass(this.root, 'irons', ship.inIrons);
  }
}
