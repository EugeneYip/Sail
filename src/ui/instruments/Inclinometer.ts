import { add, setAttr, svg, svgRoot } from '../dom';

/**
 * Ball clinometer — the brass-and-glass instrument bolted to a bulkhead. The
 * ball runs downhill in a curved tube, so its position *is* the low side: no
 * sign convention to remember. Ticks every 5 degrees, numbered every 10.
 */

const CX = 64;
const CY = 4;
const R = 46;
const SPAN = 34;

function polar(deg: number, r: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [CX + Math.sin(a) * r, CY + Math.cos(a) * r];
}

export class Inclinometer {
  readonly root: SVGSVGElement;
  private ball: SVGGElement;
  private deck: SVGGElement;
  private lastHeel = NaN;
  private lastPitch = NaN;

  constructor() {
    this.root = svgRoot('incl', 128, 66);

    const [ax, ay] = polar(-SPAN, R);
    const [bx, by] = polar(SPAN, R);
    add(this.root, svg('path', {
      class: 'in-tube', d: `M${ax} ${ay} A${R} ${R} 0 0 1 ${bx} ${by}`,
    }));

    for (let d = -30; d <= 30; d += 5) {
      const major = d % 10 === 0;
      const [x1, y1] = polar(d, R - (major ? 5.5 : 3));
      const [x2, y2] = polar(d, R + (major ? 4 : 2));
      add(this.root, svg('line', {
        class: major ? 'in-tick-major' : 'in-tick', x1, y1, x2, y2,
      }));
      if (!major || d === 0) continue;
      const [tx, ty] = polar(d, R + 12);
      const t = add(this.root, svg('text', {
        class: 'in-num', x: tx, y: ty + 2.6, 'text-anchor': 'middle',
      }));
      t.textContent = String(Math.abs(d));
    }

    add(this.root, svg('path', { class: 'in-idx', d: `M${CX} 6 L${CX + 3.4} 0.6 L${CX - 3.4} 0.6 Z` }));

    // Pitch: the deck line seen from abeam, bow to the left.
    this.deck = add(this.root, svg('g'));
    add(this.deck, svg('line', { class: 'in-deck', x1: CX - 15, y1: 30, x2: CX + 15, y2: 30 }));
    add(this.deck, svg('path', { class: 'in-bow', d: `M${CX - 15} 30 L${CX - 20} 27.5 L${CX - 15} 33 Z` }));

    this.ball = add(this.root, svg('g'));
    add(this.ball, svg('circle', { class: 'in-ball', cx: CX, cy: CY + R, r: 3.6 }));
  }

  /** Per-frame: two rotate attributes. */
  update(heelRad: number, pitchRad: number): void {
    const heel = Math.max(-SPAN, Math.min(SPAN, (heelRad * 180) / Math.PI));
    if (Math.abs(heel - this.lastHeel) > 0.03) {
      this.lastHeel = heel;
      // Rotating a point below the pivot clockwise moves it to port, so negate
      // to send the ball to the rail that is actually down.
      setAttr(this.ball, 'transform', `rotate(${-heel} ${CX} ${CY})`);
    }
    const pitch = Math.max(-20, Math.min(20, (pitchRad * 180) / Math.PI));
    if (Math.abs(pitch - this.lastPitch) > 0.03) {
      this.lastPitch = pitch;
      setAttr(this.deck, 'transform', `rotate(${pitch} ${CX} 30)`);
    }
  }
}
