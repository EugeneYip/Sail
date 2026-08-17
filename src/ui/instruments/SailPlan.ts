import type { SailState } from '../../types';
import { add, setAttr, setClass, svg, svgRoot } from '../dom';

/**
 * Sail plan as a side elevation, bow to the left — the drawing a sailing master
 * would recognise. Every sail in `ship.sails` gets one shape.
 *
 * Set/reef is a `scale` on a wrapper group, never a regenerated path: a square
 * sail grows down from its yard, a headsail is hoisted up its stay from the
 * tack, the spanker brails out from the mizzen. Luffing is a CSS keyframe
 * animation on a separate nesting level so it composes with the set scale
 * instead of fighting it, and costs nothing per frame.
 */

const VB_W = 336;
const VB_H = 150;
const DECK_Y = 124;

interface MastGeom {
  x: number;
  truckY: number;
  /** Yard height for tiers 0..3. */
  yards: number[];
  /** Sail drop for tiers 0..3. */
  drops: number[];
  halfWidths: number[];
  label: string;
}

const TIER_F = [0.24, 0.46, 0.66, 0.83];
const BASE_HALF = [27, 25, 19, 13.5];

function mast(x: number, truckY: number, widthScale: number, label: string): MastGeom {
  const h = DECK_Y - truckY;
  const yards = TIER_F.map((f) => DECK_Y - h * f);
  const drops = yards.map((y, i) => ((i < 3 ? y - yards[i + 1] : y - truckY) * 0.86));
  return { x, truckY, yards, drops, halfWidths: BASE_HALF.map((w) => w * widthScale), label };
}

// Real proportions: main 67 m, fore 60 m, mizzen 52 m above the waterline.
const MASTS: MastGeom[] = [
  mast(112, 34, 1.0, 'Fore'),
  mast(186, 22, 1.08, 'Main'),
  mast(258, 46, 0.86, 'Mizzen'),
];

/** head, tack, clew for each fore-and-aft sail, by id. */
const TRIANGLES: Record<string, [number, number, number, number, number, number]> = {
  'fore-staysail': [112, 76, 74, 118, 110, 124],
  'inner-jib': [112, 60, 56, 115, 98, 124],
  'outer-jib': [110, 46, 38, 112, 84, 124],
  'flying-jib': [108, 33, 18, 109, 70, 124],
  spanker: [258, 68, 258, 124, 320, 124],
};

interface SailNode {
  id: string;
  cloth: SVGGElement;
  flutter: SVGGElement;
  canvas: SVGPathElement;
  /** 'y' = grow down from the yard, 's' = hoist from the tack, 'x' = brail out. */
  axis: 'y' | 's' | 'x';
  /** Fixed part of the transform, prepended to the set scale. */
  pre: string;
  post: string;
  lastSet: number;
  lastLuff: number;
}

export class SailPlan {
  readonly root: SVGSVGElement;
  private nodes: SailNode[] = [];

  constructor(sails: SailState[]) {
    this.root = svgRoot('sailplan', VB_W, VB_H);

    add(this.root, svg('path', {
      class: 'sp-hull',
      d: `M100 120 C 160 118 260 118 322 121 L 317 131 C 250 133 160 133 108 130 Z`,
    }));
    add(this.root, svg('line', { class: 'sp-spar', x1: 110, y1: 122, x2: 10, y2: 107 }));
    add(this.root, svg('line', { class: 'sp-spar', x1: 258, y1: 124, x2: 322, y2: 124 }));
    add(this.root, svg('line', { class: 'sp-spar', x1: 258, y1: 68, x2: 318, y2: 90 }));
    for (const m of MASTS) {
      add(this.root, svg('line', {
        class: 'sp-mast', x1: m.x, y1: DECK_Y, x2: m.x, y2: m.truckY - 5,
      }));
    }

    // Square sails first so headsails and the spanker layer over them.
    const square = add(this.root, svg('g'));
    const fore = add(this.root, svg('g'));

    for (const s of sails) {
      const tri = TRIANGLES[s.id];
      if (s.triangular && tri) this.addTriangle(fore, s, tri);
      else if (!s.triangular && s.mast < 3) this.addSquare(square, s);
      else this.addTriangle(fore, s, TRIANGLES['fore-staysail']);
    }

    for (const m of MASTS) {
      const t = add(this.root, svg('text', {
        class: 'sp-label', x: m.x, y: 145, 'text-anchor': 'middle',
      }));
      t.textContent = m.label;
    }
    const jibs = add(this.root, svg('text', {
      class: 'sp-label', x: 56, y: 145, 'text-anchor': 'middle',
    }));
    jibs.textContent = 'Jibs';
  }

  private addSquare(parent: SVGGElement, s: SailState): void {
    const m = MASTS[s.mast];
    const y = m.yards[s.tier];
    const w = m.halfWidths[s.tier];
    const d = m.drops[s.tier];

    const g = add(parent, svg('g', { transform: `translate(${m.x} ${y.toFixed(2)})` }));
    const flutter = add(g, svg('g', { class: 'sp-flutter' }));
    const cloth = add(flutter, svg('g'));
    // Foot cut with a little bunt, clews hauled in from the yard arms.
    const canvas = add(cloth, svg('path', {
      class: 'sp-canvas',
      d: `M${-w} 0 L${w} 0 L${(w * 0.84).toFixed(2)} ${d.toFixed(2)}
          Q0 ${(d * 1.14).toFixed(2)} ${(-w * 0.84).toFixed(2)} ${d.toFixed(2)} Z`,
    }));
    add(cloth, svg('line', {
      class: 'sp-reef',
      x1: -w * 0.9, y1: d * 0.66, x2: w * 0.9, y2: d * 0.66,
    }));
    add(g, svg('line', {
      class: 'sp-yard', x1: -w - 3.5, y1: 0, x2: w + 3.5, y2: 0,
    }));

    this.push(s.id, cloth, flutter, canvas, 'y', '', '');
  }

  private addTriangle(
    parent: SVGGElement,
    s: SailState,
    t: [number, number, number, number, number, number],
  ): void {
    const [hx, hy, tx, ty, cx, cy] = t;
    const brail = s.id === 'spanker';

    const g = add(parent, svg('g'));
    const flutter = add(g, svg('g', { class: 'sp-flutter' }));
    const cloth = add(flutter, svg('g'));
    const canvas = add(cloth, svg('path', {
      class: 'sp-canvas',
      d: `M${hx} ${hy} L${tx} ${ty} L${cx} ${cy} Z`,
    }));
    add(cloth, svg('line', {
      class: 'sp-reef',
      x1: (hx + tx) / 2, y1: (hy + ty) / 2, x2: (hx + cx) / 2, y2: (hy + cy) / 2,
    }));

    // Hoisted sails grow out of the tack; the spanker brails in to the mast.
    const ox = brail ? hx : tx;
    const oy = brail ? hy : ty;
    this.push(
      s.id, cloth, flutter, canvas, brail ? 'x' : 's',
      `translate(${ox} ${oy}) `, ` translate(${-ox} ${-oy})`,
    );
  }

  private push(
    id: string,
    cloth: SVGGElement,
    flutter: SVGGElement,
    canvas: SVGPathElement,
    axis: SailNode['axis'],
    pre: string,
    post: string,
  ): void {
    // Stagger the flutter so the rig does not shiver in lockstep.
    flutter.style.animationDelay = `${(this.nodes.length * 47) % 330}ms`;
    this.nodes.push({ id, cloth, flutter, canvas, axis, pre, post, lastSet: NaN, lastLuff: NaN });
  }

  /**
   * Throttled. Set and luff move on the order of seconds, so 10 Hz with
   * quantised change detection means almost every call writes nothing.
   */
  update(sails: SailState[]): void {
    for (let i = 0; i < this.nodes.length && i < sails.length; i++) {
      const n = this.nodes[i];
      const s = sails[i].id === n.id ? sails[i] : sails.find((x) => x.id === n.id);
      if (!s) continue;

      const set = Math.round(Math.max(0, Math.min(1, s.set)) * 48) / 48;
      if (set !== n.lastSet) {
        n.lastSet = set;
        const sc = n.axis === 'y' ? `scale(1 ${set})`
          : n.axis === 'x' ? `scale(${set} 1)`
            : `scale(${set})`;
        setAttr(n.cloth, 'transform', `${n.pre}${sc}${n.post}`);
        setClass(n.cloth, 'reefed', set > 0.08 && set < 0.72);
        setClass(n.cloth, 'furled', set <= 0.08);
      }

      const luff = Math.round(Math.max(0, Math.min(1, s.luff)) * 16) / 16;
      if (luff !== n.lastLuff) {
        n.lastLuff = luff;
        const drawing = set > 0.08;
        setClass(n.flutter, 'shiver', drawing && luff > 0.3);
        setClass(n.flutter, 'shiver-hard', drawing && luff > 0.68);
        setAttr(n.canvas, 'fill-opacity', (0.055 + 0.17 * (1 - luff * 0.72)).toFixed(3));
        setAttr(n.canvas, 'stroke-opacity', (0.26 + 0.24 * luff).toFixed(3));
      }
    }
  }
}
