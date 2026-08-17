import type { World } from '../types';
import { add, el, setClass, setText, statRow } from './dom';
import {
  bearing3, bearingDeg, beaufortFromSpeed, beaufortName, deltaDeg, groupedInt,
  RAD2DEG, seaStateName, sentenceCase, shipTime, toKnots, visibilityText,
} from './format';
import { Bells } from './instruments/Bells';
import { Chart } from './instruments/Chart';
import { CompassRibbon } from './instruments/CompassRibbon';
import { Inclinometer } from './instruments/Inclinometer';
import { SailPlan } from './instruments/SailPlan';
import { WindRose } from './instruments/WindRose';

/**
 * The sailing HUD. Six regions around an empty centre.
 *
 * Nothing here rebuilds DOM. `updateFast` writes only transforms (compositor
 * work, gated on an epsilon); `updateSlow` runs at 10 Hz and every write goes
 * through the change-gated `setText`/`setAttr` in dom.ts, so a steady readout
 * costs one string compare.
 */
export class HudView {
  readonly root: HTMLElement;

  private compass = new CompassRibbon();
  private rose = new WindRose();
  private incl = new Inclinometer();
  private bells = new Bells();
  private chart = new Chart();
  private sailPlan!: SailPlan;

  private clock!: HTMLElement;
  private watch!: HTMLElement;
  private weather!: HTMLElement;
  private seaState!: HTMLElement;
  private waveH!: HTMLElement;
  private vis!: HTMLElement;

  private speed!: HTMLElement;
  private pos!: HTMLElement;
  private speedBlock!: HTMLElement;
  private heel!: HTMLElement;
  private pitch!: HTMLElement;

  private awa!: HTMLElement;
  private tw!: HTMLElement;
  private gust!: HTMLElement;
  private force!: HTMLElement;

  private sailCap!: HTMLElement;
  private debug!: HTMLElement;
  private nominalArea = 1;

  constructor(world: World) {
    this.root = el('div', 'hud');
    add(this.root, el('div', 'hud-scrim'));

    this.buildTopLeft();
    add(this.root, this.wrap('r-top-c', this.compass.root));
    this.buildTopRight();
    this.buildBottomLeft(world);
    this.buildBottomCentre(world);
    this.buildBottomRight();

    for (const s of world.ship.sails) this.nominalArea += s.area;
  }

  private wrap(cls: string, child: Element): HTMLElement {
    const w = add(this.root, el('div', `region ${cls}`));
    w.appendChild(child);
    return w;
  }

  private buildTopLeft(): void {
    const r = add(this.root, el('div', 'region r-top-l'));
    this.clock = add(r, el('div', 'clock'));
    this.watch = add(r, el('div', 'watch'));
    add(r, this.bells.root);
    this.debug = add(r, el('pre', 'dbg'));
  }

  private buildTopRight(): void {
    const r = add(this.root, el('div', 'region r-top-r'));
    this.weather = add(r, el('div', 'weather'));
    const t = add(r, el('div', 'stats'));
    this.seaState = statRow(t, 'Sea');
    this.waveH = statRow(t, 'Hs');
    this.vis = statRow(t, 'Vis');
  }

  private buildBottomLeft(world: World): void {
    const r = add(this.root, el('div', 'region r-bot-l'));
    add(r, this.chart.root);

    this.speedBlock = add(r, el('div', 'speedblock'));
    const line = add(this.speedBlock, el('div', 'speedline'));
    this.speed = add(line, el('span', 'speed'));
    add(line, el('span', 'speed-u', 'kn'));
    add(line, el('span', 'irons-tag', 'in irons'));
    this.pos = add(this.speedBlock, el('div', 'pos'));

    const inc = add(this.speedBlock, el('div', 'inclblock'));
    add(inc, this.incl.root);
    const t = add(inc, el('div', 'stats'));
    this.heel = statRow(t, 'Heel');
    this.pitch = statRow(t, 'Pitch');
    void world;
  }

  private buildBottomCentre(world: World): void {
    const r = add(this.root, el('div', 'region r-bot-c'));
    this.sailPlan = new SailPlan(world.ship.sails);
    add(r, this.sailPlan.root);
    this.sailCap = add(r, el('div', 'sailcap'));
  }

  private buildBottomRight(): void {
    const r = add(this.root, el('div', 'region r-bot-r'));
    const row = add(r, el('div', 'windrow'));
    const t = add(row, el('div', 'stats windstats'));
    this.awa = statRow(t, 'Apparent');
    this.tw = statRow(t, 'True');
    this.gust = statRow(t, 'Gust');
    add(row, this.rose.root);
    this.force = add(r, el('div', 'force'));
  }

  /* ---------------------------------------------------------------- *
   *  per-frame — transforms only
   * ---------------------------------------------------------------- */

  updateFast(world: World): void {
    const ship = world.ship;
    this.compass.updateFast(ship.heading);
    this.chart.updateFast(ship.heading);
    this.incl.update(ship.heel, ship.pitch);
    this.rose.updateFast(
      ship.apparentWindAngle,
      deltaDeg(bearingDeg(world.env.windBearing), bearingDeg(ship.heading)),
      ship.inIrons,
    );
  }

  /* ---------------------------------------------------------------- *
   *  ~10 Hz — text
   * ---------------------------------------------------------------- */

  updateSlow(world: World): void {
    const { ship, env } = world;

    const st = shipTime(env.timeOfDay);
    setText(this.clock, st.clock);
    setText(this.watch, `${st.watch} — ${st.bellText}`);
    this.bells.update(st.bells);

    setText(this.weather, env.weatherLabel);
    setText(this.seaState, `${Math.round(env.seaState)} · ${seaStateName(env.seaState)}`);
    setText(this.waveH, `${env.waveHeight.toFixed(1)} m`);
    setText(this.vis, visibilityText(env.visibility));

    setText(this.speed, ship.speedKnots.toFixed(1));
    setText(this.pos, sentenceCase(ship.inIrons ? 'in irons' : ship.pointOfSail));
    setClass(this.speedBlock, 'irons', ship.inIrons);

    const heelDeg = ship.heel * RAD2DEG;
    setText(this.heel, `${Math.abs(heelDeg).toFixed(1)}° ${heelDeg >= 0 ? 'stbd' : 'port'}`);
    setText(this.pitch, `${ship.pitch >= 0 ? '+' : '−'}${Math.abs(ship.pitch * RAD2DEG).toFixed(1)}°`);

    const awaDeg = ship.apparentWindAngle * RAD2DEG;
    setText(this.awa, `${bearing3(Math.abs(awaDeg))}° ${awaDeg >= 0 ? 'stbd' : 'port'} · ${toKnots(ship.apparentWindSpeed).toFixed(1)} kn`);
    setText(this.tw, `${bearing3(bearingDeg(env.windBearing))}° · ${toKnots(env.windSpeed).toFixed(1)} kn`);
    setText(this.gust, `×${env.gust.toFixed(2)}`);

    const force = env.beaufort || beaufortFromSpeed(env.windSpeed);
    setText(this.force, `Force ${Math.round(force)} — ${beaufortName(force)}`);

    this.sailPlan.update(ship.sails);
    // Physics owns sailArea; fall back to the trim sum while it is still zero.
    let area = ship.sailArea;
    if (area <= 0) for (const s of ship.sails) area += s.area * Math.max(0, Math.min(1, s.set));
    setText(this.sailCap, `${groupedInt(area)} m² drawing · ${Math.round((area / this.nominalArea) * 100)}%`);
  }

  /** ~5 Hz — the chart is the only thing that walks an array. */
  updateChart(world: World): void {
    this.chart.updateSlow(world);
  }

  updateDebug(world: World): void {
    const s = world.stats;
    let out = `${world.time.fps.toFixed(0)} fps   ${(s.drawCalls ?? 0) | 0} dc   ${((s.triangles ?? 0) / 1e6).toFixed(2)} Mtri   ${(s.programs ?? 0) | 0} prog\n`;
    out += `scale ${world.settings.renderScale.toFixed(2)}   ${world.size.width}×${world.size.height}\n`;
    const keys: string[] = [];
    for (const k in s) if (k.startsWith('upd:')) keys.push(k);
    keys.sort((a, b) => s[b] - s[a]);
    for (const k of keys.slice(0, 8)) out += `${k.slice(4).padEnd(9)} ${s[k].toFixed(2)} ms\n`;
    if (s['ui:ms'] !== undefined) out += `ui(self)  ${s['ui:ms'].toFixed(3)} ms`;
    setText(this.debug, out);
  }

  setDebugVisible(on: boolean): void {
    setClass(this.root, 'show-dbg', on);
  }
}
