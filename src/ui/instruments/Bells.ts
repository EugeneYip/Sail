import { add, setAttr, svg, svgRoot } from '../dom';

/**
 * Ship's bells written the way they are struck: in pairs, with the odd bell
 * standing alone. Four bells reads as two beats of two.
 */
export class Bells {
  readonly root: SVGSVGElement;
  private dots: SVGCircleElement[] = [];
  private last = -1;

  constructor() {
    this.root = svgRoot('bells', 52, 8);
    for (let i = 0; i < 8; i++) {
      const pair = i >> 1;
      const x = 2 + pair * 13 + (i % 2) * 4.6;
      this.dots.push(add(this.root, svg('circle', { cx: x, cy: 4, r: 1.7 })));
    }
  }

  update(bells: number): void {
    if (bells === this.last) return;
    this.last = bells;
    for (let i = 0; i < 8; i++) setAttr(this.dots[i], 'class', i < bells ? 'bell on' : 'bell');
  }
}
