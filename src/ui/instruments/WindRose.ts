import { add, setAttr, setClass, svg, svgRoot } from '../dom';

/**
 * Bow-relative wind clock. The hull points up; the heavy needle is the
 * apparent wind, the hairline needle the true wind. The shaded wedge at the
 * head is the no-go zone, so "am I pinched" is a shape, not a number.
 */

const C = 55;
const R = 45;
/** A square-rigger will not point closer than this. */
const NO_GO_DEG = 38;

function polar(deg: number, r: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [C + Math.sin(a) * r, C - Math.cos(a) * r];
}

export class WindRose {
  readonly root: SVGSVGElement;
  private apparent: SVGGElement;
  private trueWind: SVGGElement;
  private noGo: SVGPathElement;
  private lastAw = NaN;
  private lastTw = NaN;

  constructor() {
    this.root = svgRoot('rose', 110, 110);

    const [nx1, ny1] = polar(-NO_GO_DEG, R);
    const [nx2, ny2] = polar(NO_GO_DEG, R);
    this.noGo = add(this.root, svg('path', {
      class: 'rose-nogo',
      d: `M${C} ${C} L${nx1} ${ny1} A${R} ${R} 0 0 1 ${nx2} ${ny2} Z`,
    }));

    add(this.root, svg('circle', { class: 'rose-ring', cx: C, cy: C, r: R }));

    for (let d = 0; d < 360; d += 15) {
      const major = d % 45 === 0;
      const [x1, y1] = polar(d, R);
      const [x2, y2] = polar(d, R - (major ? 6.5 : 3.5));
      add(this.root, svg('line', {
        class: major ? 'rose-tick-major' : 'rose-tick', x1, y1, x2, y2,
      }));
    }

    // Best-course marks: where a square-rigger actually draws close-hauled.
    for (const d of [-NO_GO_DEG - 12, NO_GO_DEG + 12]) {
      const [x1, y1] = polar(d, R + 1);
      const [x2, y2] = polar(d, R + 5.5);
      add(this.root, svg('line', { class: 'rose-best', x1, y1, x2, y2 }));
    }

    // Hull silhouette, bow up — the frame of reference.
    add(this.root, svg('path', {
      class: 'rose-hull',
      d: `M${C} 27 C ${C + 6.4} 39 ${C + 7} 60 ${C + 4.4} 76
          L${C - 4.4} 76 C ${C - 7} 60 ${C - 6.4} 39 ${C} 27 Z`,
    }));
    add(this.root, svg('line', {
      class: 'rose-keel', x1: C, y1: 24, x2: C, y2: 80,
    }));

    this.trueWind = add(this.root, svg('g', { class: 'rose-true' }));
    add(this.trueWind, svg('line', { x1: C, y1: C - R + 2, x2: C, y2: C - 14 }));
    add(this.trueWind, svg('circle', { cx: C, cy: C - R + 2, r: 1.8 }));

    this.apparent = add(this.root, svg('g', { class: 'rose-app' }));
    add(this.apparent, svg('line', { x1: C, y1: C - R + 3, x2: C, y2: C - 21 }));
    add(this.apparent, svg('path', {
      d: `M${C} ${C - 12} L${C + 4} ${C - 21} L${C - 4} ${C - 21} Z`,
    }));
  }

  /** Per-frame: two rotate attributes. */
  updateFast(apparentRad: number, trueRelDeg: number, inIrons: boolean): void {
    const aw = (apparentRad * 180) / Math.PI;
    if (Math.abs(aw - this.lastAw) > 0.05) {
      this.lastAw = aw;
      setAttr(this.apparent, 'transform', `rotate(${aw} ${C} ${C})`);
    }
    if (Math.abs(trueRelDeg - this.lastTw) > 0.05) {
      this.lastTw = trueRelDeg;
      setAttr(this.trueWind, 'transform', `rotate(${trueRelDeg} ${C} ${C})`);
    }
    setClass(this.noGo, 'hot', inIrons);
  }
}
