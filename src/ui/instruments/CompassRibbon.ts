import { add, el, setAttr, setText, setTransform, svg, svgRoot } from '../dom';
import { bearing3, bearingDeg, cardinal, normDeg } from '../format';

/**
 * A ribbon compass — a linear strip of the compass card seen through a fixed
 * index at the top centre of the screen.
 *
 * A ribbon beats a rose at this size. At 3 px/deg a 520 px window shows 173
 * degrees of card, so 5-degree ticks sit 15 px apart and every label is set at
 * a real reading size. A rose small enough to live in a HUD corner (~104 px
 * across) has 0.9 px per degree at the rim: the ticks collide and the labels
 * have to shrink under 8 px. The ribbon also shares one horizontal axis with
 * the wind marker, so "the wind is 40 degrees off my port bow" is a distance
 * you can read directly. The rose belongs on the chart, where north-up,
 * all-round awareness is the job — and that is where we put one.
 */

const PX_PER_DEG = 3;
/** The strip carries 560 deg of card so a 180 deg window never runs off it. */
const STRIP_MIN = -100;
const STRIP_MAX = 460;
const STRIP_W = (STRIP_MAX - STRIP_MIN) * PX_PER_DEG;
const STRIP_H = 40;
const BASELINE = 29.5;

function stripX(deg: number): number {
  return (deg - STRIP_MIN) * PX_PER_DEG;
}

export class CompassRibbon {
  readonly root: HTMLElement;
  private strip: HTMLElement;
  private windMarks: SVGGElement[] = [];
  private headingText: SVGTextElement;
  private cardinalText: SVGTextElement;
  private lastHeading = NaN;
  private lastWind = NaN;

  constructor() {
    this.root = el('div', 'compass');

    const window_ = add(this.root, el('div', 'compass-window'));
    this.strip = add(window_, el('div', 'compass-strip'));

    const s = add(this.strip, svgRoot('compass-svg', STRIP_W, STRIP_H));
    s.style.width = `${STRIP_W}px`;

    add(s, svg('line', {
      class: 'cmp-base',
      x1: 0, y1: BASELINE, x2: STRIP_W, y2: BASELINE,
    }));

    for (let d = STRIP_MIN; d <= STRIP_MAX; d += 5) {
      const x = stripX(d);
      const major = normDeg(d) % 30 === 0;
      add(s, svg('line', {
        class: major ? 'cmp-tick-major' : 'cmp-tick',
        x1: x, y1: major ? 18 : 23, x2: x, y2: BASELINE,
      }));
      if (!major) continue;

      const n = normDeg(d);
      const isCardinal = n % 90 === 0;
      const label = add(s, svg('text', {
        class: isCardinal ? 'cmp-card' : 'cmp-num',
        x: x, y: 13, 'text-anchor': 'middle',
      }));
      // Tens-of-degrees on the numeric marks, the way a compass card is drawn.
      label.textContent = isCardinal ? cardinal(n) : String(n / 10).padStart(2, '0');
    }

    // Three copies of the wind mark, 360 deg apart, so whichever the window
    // happens to be over is already in place — no wrap arithmetic per frame.
    const windLayer = add(s, svg('g', { class: 'cmp-wind' }));
    for (let i = 0; i < 3; i++) {
      const g = add(windLayer, svg('g'));
      add(g, svg('path', { class: 'cmp-wind-mark', d: 'M0 30 L4.6 38 L-4.6 38 Z' }));
      add(g, svg('line', { class: 'cmp-wind-stem', x1: 0, y1: 23, x2: 0, y2: 30 }));
      this.windMarks.push(g);
    }

    // Static index + read-out, outside the scrolling strip.
    const idx = add(this.root, svgRoot('compass-index', 60, 66));
    add(idx, svg('path', { class: 'cmp-idx', d: 'M30 0 L34.4 7 L25.6 7 Z' }));
    add(idx, svg('line', { class: 'cmp-idx-line', x1: 30, y1: 7, x2: 30, y2: 32 }));
    this.headingText = add(idx, svg('text', {
      class: 'cmp-hdg', x: 30, y: 52, 'text-anchor': 'middle',
    }));
    this.cardinalText = add(idx, svg('text', {
      class: 'cmp-hdg-card', x: 30, y: 63, 'text-anchor': 'middle',
    }));
  }

  /** Per-frame: one compositor transform. */
  updateFast(headingRad: number): void {
    const hdg = bearingDeg(headingRad);
    if (Math.abs(hdg - this.lastHeading) < 0.02) return;
    this.lastHeading = hdg;
    setTransform(this.strip, `translate3d(${(-stripX(hdg)).toFixed(1)}px,0,0)`);
  }

  /** Throttled: text and the wind mark position. */
  updateSlow(headingRad: number, windBearingRad: number): void {
    const hdg = bearingDeg(headingRad);
    setText(this.headingText, `${bearing3(hdg)}°`);
    setText(this.cardinalText, cardinal(hdg));

    const wind = bearingDeg(windBearingRad);
    if (Math.abs(wind - this.lastWind) > 0.05) {
      this.lastWind = wind;
      for (let i = 0; i < 3; i++) {
        setAttr(this.windMarks[i], 'transform', `translate(${stripX(wind + (i - 1) * 360)},0)`);
      }
    }
  }
}
