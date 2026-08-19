#!/usr/bin/env node
/**
 * Is the rig helping or fighting her, in assist, on the headings the assist
 * invented?
 *
 * Driving her dead upwind showed 2500 m^2 "drawing" at TWA 0 and only ~640 m^2
 * close-hauled — backwards from what a square-rigger should do. `sailArea` is
 * `area * set * (1 - luff)`, and `luff` goes to zero at HIGH incidence as well
 * as being zero when a sail is properly full: a squared yard with the wind on
 * the nose is not shivering, it is a drag device. So the number is honest about
 * the model and misleading about the ship.
 *
 * The signed forward component of the rig force is private, so measure it the
 * way a player could: sail the same heading with a full press and then under
 * bare poles. If she is FASTER with no sails set, the rig is a brake.
 */
import { chromium } from 'playwright';

const URL = 'http://127.0.0.1:5178/';
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 700, height: 440 } });
await page.addInitScript(() => {
  const Real = WebSocket;
  class Dead extends EventTarget {
    constructor() { super(); this.readyState = 3; }
    send() {} close() {}
  }
  const P = function (u, p) {
    const vite = p === 'vite-hmr' || (Array.isArray(p) && p.includes('vite-hmr'));
    return vite ? new Dead() : new Real(u, p);
  };
  P.prototype = Real.prototype;
  Object.assign(P, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  window.WebSocket = P;
});
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => !!window.__leeward?.world?.ext?.physics, null, { timeout: 240000 });
await page.waitForTimeout(1500);

/** Settle on a heading with a given press of canvas and report what she does. */
const hold = (twa, level, seconds = 200) =>
  page.evaluate(
    ({ twa, level, seconds }) => {
      const w = window.__leeward.world;
      const px = w.ext.physics;
      const R = 180 / Math.PI;
      w.env.windSpeed = 10;
      w.env.gust = 1;
      w.input.steer = 0;
      w.input.sailTrim = 0;
      px.flatSea = true;
      px.reset((w.env.windBearing * R - twa + 720) % 360, 6);
      // AFTER the reset, never before: `reset()` deliberately lands in Pro, so
      // setting the mode first measures the wrong ship. The first run of this
      // probe did exactly that and reproduced the Pro polar to two decimals.
      px.assist = true;
      px.sailLevel = level;
      for (const s of w.ship.sails) s.set = level > 0 ? 1 : 0;
      const tr = px.run(seconds, 1 / 60);
      const last = tr[tr.length - 1];
      return {
        kn: last.knots,
        vmg: last.vmgKnots,
        held: last.twaDeg,
        area: w.ship.sailArea,
        drive: px.assistDrive / 1e3,
        rig: px.rigForce / 1e3,
        resist: px.resistance / 1e3,
      };
    },
    { twa, level, seconds },
  );

console.log('assist, 10 m/s, flat sea. "full" = 16 sails, "bare" = no canvas at all.');
console.log('TWA   full kn   bare kn   delta    drawing m^2   assist drive kN   rig force kN');
for (const twa of [0, 30, 45, 70, 90, 135]) {
  const full = await hold(twa, 16);
  const bare = await hold(twa, 0);
  const d = full.kn - bare.kn;
  console.log(
    `${String(twa).padStart(3)}   ${full.kn.toFixed(2).padStart(7)}   ${bare.kn.toFixed(2).padStart(7)}   ` +
      `${((d >= 0 ? '+' : '') + d.toFixed(2)).padStart(6)}   ${full.area.toFixed(0).padStart(11)}   ` +
      `${full.drive.toFixed(0).padStart(15)}   ${full.rig.toFixed(0).padStart(12)}`,
  );
}
if (errs.length) console.log(`\npage errors: ${[...new Set(errs)].slice(0, 4).join(' | ')}`);
await browser.close();
