import type { World } from '../../types';
import { add, el, setAttr, setText, svg, svgRoot } from '../dom';
import { bearingDeg, RAD2DEG } from '../format';

/**
 * A pocket chart: north-up, ship-centred, with the track astern.
 *
 * Land comes from `world.ext.world`, which nothing publishes yet — every
 * accessor is duck-typed and null-checked, and the chart is perfectly happy
 * showing open sea. Three shapes are understood, whichever the world agent
 * lands on: an `islands` array, a `sampleTerrainHeight(x, z)` probe, or a
 * `nearestLand(x, z)` query.
 */

const VB = 156;
const C = VB / 2;
const RIM = 68;
const METRES_PER_NM = 1852;

/** Track point every this many metres of progress. */
const TRACK_STEP_M = 26;
const TRACK_MAX = 220;

/** Coarse land probe grid, refreshed a slice at a time. */
const GRID = 13;
const PROBE_PER_TICK = 22;

interface WorldExt {
  sampleTerrainHeight?: (x: number, z: number) => number;
  nearestLand?: (x: number, z: number) => unknown;
  islands?: unknown;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export class Chart {
  readonly root: HTMLElement;
  private ship: SVGGElement;
  private wind: SVGGElement;
  private swell: SVGGElement;
  private track: SVGPolylineElement;
  private land: SVGPathElement;
  private landfall: SVGGElement;
  private landfallText: SVGTextElement;
  private scaleText: HTMLElement;
  private madeGoodText: HTMLElement;

  private rangeM = 4000;
  private xs = new Float64Array(TRACK_MAX);
  private zs = new Float64Array(TRACK_MAX);
  private n = 0;
  private head = 0;
  private lastX = NaN;
  private lastZ = NaN;
  private pts: string[] = [];

  private grid = new Uint8Array(GRID * GRID);
  private probeI = 0;
  private hasLand = false;

  constructor() {
    this.root = el('div', 'chart');

    const s = add(this.root, svgRoot('chart-svg', VB, VB));
    add(s, svg('rect', { class: 'ch-field', x: 4, y: 4, width: VB - 8, height: VB - 8, rx: 2 }));

    add(s, svg('circle', { class: 'ch-grid', cx: C, cy: C, r: RIM * 0.5 }));
    add(s, svg('line', { class: 'ch-grid', x1: C, y1: C - RIM, x2: C, y2: C + RIM }));
    add(s, svg('line', { class: 'ch-grid', x1: C - RIM, y1: C, x2: C + RIM, y2: C }));

    this.land = add(s, svg('path', { class: 'ch-land', d: '' }));

    for (const [lab, dx, dy] of [['N', 0, -1], ['E', 1, 0], ['S', 0, 1], ['W', -1, 0]] as const) {
      const t = add(s, svg('text', {
        class: 'ch-rose',
        x: C + dx * (RIM + 8), y: C + dy * (RIM + 8) + 3,
        'text-anchor': 'middle',
      }));
      t.textContent = lab;
    }

    this.track = add(s, svg('polyline', { class: 'ch-track', points: '' }));

    this.landfall = add(s, svg('g', { class: 'ch-landfall' }));
    add(this.landfall, svg('line', { x1: C, y1: C - RIM - 1, x2: C, y2: C - RIM + 6 }));
    this.landfallText = add(this.landfall, svg('text', { x: C, y: C - RIM - 5, 'text-anchor': 'middle' }));

    this.swell = add(s, svg('g', { class: 'ch-swell' }));
    add(this.swell, svg('path', { d: `M${C} ${C - RIM - 4} l3 5 l-6 0 Z` }));

    this.wind = add(s, svg('g', { class: 'ch-wind' }));
    add(this.wind, svg('line', { x1: C, y1: C - RIM + 2, x2: C, y2: C - RIM + 15 }));
    add(this.wind, svg('path', { d: `M${C} ${C - RIM + 20} l3.4 -6 l-6.8 0 Z` }));

    this.ship = add(s, svg('g', { class: 'ch-ship' }));
    add(this.ship, svg('path', { d: `M${C} ${C - 6.5} L${C + 3.6} ${C + 5} L${C} ${C + 2.6} L${C - 3.6} ${C + 5} Z` }));

    const cap = add(this.root, el('div', 'chart-cap'));
    this.madeGoodText = add(cap, el('span', 'chart-cap-l'));
    this.scaleText = add(cap, el('span', 'chart-cap-r'));
  }

  /** Per-frame: one rotate on the ship glyph. */
  updateFast(headingRad: number): void {
    setAttr(this.ship, 'transform', `rotate(${(headingRad * RAD2DEG).toFixed(1)} ${C} ${C})`);
  }

  /** Throttled to ~5 Hz. */
  updateSlow(world: World): void {
    const px = world.origin.x + world.ship.position.x;
    const pz = world.origin.z + world.ship.position.z;

    if (!Number.isFinite(this.lastX)) this.pushPoint(px, pz);
    else if (Math.hypot(px - this.lastX, pz - this.lastZ) > TRACK_STEP_M) this.pushPoint(px, pz);

    const k = RIM / this.rangeM;
    this.pts.length = 0;
    for (let i = 0; i < this.n; i++) {
      const j = (this.head - this.n + i + TRACK_MAX * 2) % TRACK_MAX;
      const dx = (this.xs[j] - px) * k;
      const dz = (this.zs[j] - pz) * k;
      if (Math.abs(dx) > RIM + 4 || Math.abs(dz) > RIM + 4) continue;
      this.pts.push(`${(C + dx).toFixed(1)},${(C + dz).toFixed(1)}`);
    }
    setAttr(this.track, 'points', this.pts.join(' '));

    setAttr(this.wind, 'transform', `rotate(${bearingDeg(world.env.windBearing).toFixed(1)} ${C} ${C})`);
    setAttr(this.swell, 'transform', `rotate(${bearingDeg(world.env.swellBearing).toFixed(1)} ${C} ${C})`);

    const nm = world.origin.length() / METRES_PER_NM;
    setText(this.madeGoodText, `${nm < 10 ? nm.toFixed(2) : nm.toFixed(1)} nm made good`);
    setText(this.scaleText, `${(this.rangeM / 1000).toFixed(0)} km`);

    this.updateLand(world, px, pz, k);
  }

  setRange(metres: number): void {
    this.rangeM = metres;
  }

  private pushPoint(x: number, z: number): void {
    this.xs[this.head] = x;
    this.zs[this.head] = z;
    this.head = (this.head + 1) % TRACK_MAX;
    if (this.n < TRACK_MAX) this.n++;
    this.lastX = x;
    this.lastZ = z;
  }

  private updateLand(world: World, px: number, pz: number, k: number): void {
    const ext = world.ext.world as WorldExt | undefined | null;
    if (!ext) return;

    if (Array.isArray(ext.islands)) {
      this.drawIslands(ext.islands, px, pz, k);
    } else if (typeof ext.sampleTerrainHeight === 'function') {
      this.probeGrid(ext.sampleTerrainHeight, px, pz);
    }

    if (typeof ext.nearestLand === 'function') {
      const hit = ext.nearestLand(px, pz) as Record<string, unknown> | null | undefined;
      const dist = hit ? num(hit.distance) : null;
      const brg = hit ? num(hit.bearing) : null;
      if (dist !== null && brg !== null) {
        setAttr(this.landfall, 'transform', `rotate(${bearingDeg(brg).toFixed(1)} ${C} ${C})`);
        setText(this.landfallText, `${(dist / METRES_PER_NM).toFixed(1)}`);
        setAttr(this.landfall, 'opacity', '1');
        return;
      }
    }
    setAttr(this.landfall, 'opacity', '0');
  }

  private drawIslands(list: unknown[], px: number, pz: number, k: number): void {
    let d = '';
    for (const raw of list) {
      const o = raw as Record<string, unknown>;
      const pos = o.position as Record<string, unknown> | undefined;
      const x = num(o.x) ?? (pos ? num(pos.x) : null);
      const z = num(o.z) ?? (pos ? num(pos.z) : null);
      const r = num(o.radius) ?? 400;
      if (x === null || z === null) continue;
      const cx = C + (x - px) * k;
      const cy = C + (z - pz) * k;
      const rr = Math.max(1.5, r * k);
      if (Math.abs(cx - C) - rr > RIM || Math.abs(cy - C) - rr > RIM) continue;
      d += `M${(cx - rr).toFixed(1)} ${cy.toFixed(1)}a${rr.toFixed(1)} ${rr.toFixed(1)} 0 1 0 ${(rr * 2).toFixed(1)} 0a${rr.toFixed(1)} ${rr.toFixed(1)} 0 1 0 ${(-rr * 2).toFixed(1)} 0`;
    }
    setAttr(this.land, 'd', d);
  }

  /**
   * Sample a slice of the grid per tick — a full sweep costs 169 probes spread
   * over about a second, instead of a spike.
   */
  private probeGrid(probe: (x: number, z: number) => number, px: number, pz: number): void {
    const step = (this.rangeM * 2) / (GRID - 1);
    for (let c = 0; c < PROBE_PER_TICK; c++) {
      const i = this.probeI % (GRID * GRID);
      const gx = i % GRID;
      const gz = (i / GRID) | 0;
      const wx = px + (gx - (GRID - 1) / 2) * step;
      const wz = pz + (gz - (GRID - 1) / 2) * step;
      let h = 0;
      try {
        h = probe(wx, wz);
      } catch {
        return;
      }
      this.grid[i] = h > 0.5 ? 1 : 0;
      this.probeI++;
      if (this.probeI % (GRID * GRID) === 0) this.hasLand = true;
    }
    if (!this.hasLand) return;

    const cell = (RIM * 2) / (GRID - 1);
    let d = '';
    for (let i = 0; i < this.grid.length; i++) {
      if (!this.grid[i]) continue;
      const x = C - RIM + (i % GRID) * cell - cell / 2;
      const y = C - RIM + ((i / GRID) | 0) * cell - cell / 2;
      d += `M${x.toFixed(1)} ${y.toFixed(1)}h${cell.toFixed(1)}v${cell.toFixed(1)}h${(-cell).toFixed(1)}Z`;
    }
    setAttr(this.land, 'd', d);
  }
}
