#!/usr/bin/env node
/**
 * Where does the 62 deg knockdown in physics-test section 6 come from?
 *
 * Runs the gale case three ways on one page:
 *   isolated   nothing before it but the page load
 *   suiteOrder preceded by sections 4 and 5, as the suite does
 *   squared    yards deliberately left squared at the start, i.e. the OLD
 *              pre-Trim.reset() initial condition
 *
 * and reports WHEN the peak heel happens plus the canvas history, so we can
 * tell an initial over-press from a mid-run wave broach.
 */
import { chromium } from 'playwright';

const URL = 'http://127.0.0.1:5178/';
const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-angle=metal',
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    '--enable-unsafe-swiftshader',
    '--mute-audio',
  ],
});
const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
await page.addInitScript(() => {
  const Real = WebSocket;
  class Dead extends EventTarget {
    constructor() {
      super();
      this.readyState = 3;
    }
    send() {}
    close() {}
  }
  const P = function (u, p) {
    const vite = p === 'vite-hmr' || (Array.isArray(p) && p.includes('vite-hmr'));
    return vite ? new Dead() : new Real(u, p);
  };
  P.prototype = Real.prototype;
  Object.assign(P, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  window.WebSocket = P;
});
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => !!window.__leeward?.world?.ext?.physics, null, {
  timeout: 180000,
});
await page.waitForTimeout(1500);

const out = await page.evaluate(() => {
  const w = window.__leeward.world;
  const px = w.ext.physics;
  const RAD = 180 / Math.PI;

  const gale = (squareYards) => {
    w.env.windSpeed = 24;
    w.env.gust = 1.25;
    w.env.waveHeight = 7;
    w.env.seaState = 8;
    w.input.steer = 0;
    px.flatSea = false;
    const heading = ((w.env.windBearing * RAD) - 130 + 720) % 360;
    px.reset(heading, 6);
    px.sailLevel = 16;
    for (const s of w.ship.sails) s.set = 1;
    if (squareYards) for (const s of w.ship.sails) s.brace = 0;
    let brace0 = 0;
    for (const s of w.ship.sails) brace0 += Math.abs(s.brace);
    const tr = px.run(600, 1 / 60, true);
    let maxHeel = 0;
    let tPeak = 0;
    let maxHeelAfter60 = 0;
    let tPeakAfter60 = 0;
    let maxKn = 0;
    const heelBySeg = [];
    for (const s of tr) {
      const h = Math.abs(s.heelDeg);
      maxKn = Math.max(maxKn, s.knots);
      if (h > maxHeel) {
        maxHeel = h;
        tPeak = s.t;
      }
      if (s.t > 60 && h > maxHeelAfter60) {
        maxHeelAfter60 = h;
        tPeakAfter60 = s.t;
      }
    }
    // Peak heel and canvas in each 60 s block, to see the watch reefing.
    for (let seg = 0; seg < 10; seg++) {
      let h = 0;
      let area = 0;
      let n = 0;
      for (const s of tr) {
        if (s.t >= seg * 60 && s.t < (seg + 1) * 60) {
          h = Math.max(h, Math.abs(s.heelDeg));
          area += s.sailArea;
          n++;
        }
      }
      heelBySeg.push({ seg, heel: h, area: n ? area / n : 0 });
    }
    return {
      maxHeel,
      tPeak,
      maxHeelAfter60,
      tPeakAfter60,
      maxKn,
      brace0: brace0 * RAD,
      heelBySeg,
    };
  };

  // Sections 4 + 5, to reproduce suite order.
  const before = () => {
    w.env.windSpeed = 0;
    w.env.gust = 1;
    px.flatSea = true;
    px.sailLevel = 0;
    for (const s of w.ship.sails) s.set = 0;
    px.reset(0, 0, 20);
    px.run(80, 1 / 120, true);
    w.env.windSpeed = 9;
    px.flatSea = true;
    const heading = ((w.env.windBearing * RAD) - 120 + 720) % 360;
    for (const dt of [1 / 30, 1 / 144]) {
      px.reset(heading, 0);
      px.sailLevel = 16;
      for (const s of w.ship.sails) s.set = 1;
      px.run(150, dt);
    }
  };

  const isolated = gale(false);
  before();
  const suiteOrder = gale(false);
  const squared = gale(true);
  return { isolated, suiteOrder, squared };
});

const show = (label, r) => {
  console.log(`\n${label}`);
  console.log(
    `  peak heel ${r.maxHeel.toFixed(1)} deg at t=${r.tPeak.toFixed(1)} s   ` +
      `peak after 60 s: ${r.maxHeelAfter60.toFixed(1)} deg at t=${r.tPeakAfter60.toFixed(1)} s`,
  );
  console.log(`  peak speed ${r.maxKn.toFixed(2)} kn, yards at start ${r.brace0.toFixed(1)} deg`);
  console.log(
    '  per-minute peak heel / mean canvas: ' +
      r.heelBySeg.map((s) => `${s.heel.toFixed(0)}deg/${s.area.toFixed(0)}m2`).join('  '),
  );
};

show('ISOLATED (fresh page, nothing before)', out.isolated);
show('SUITE ORDER (after roll decay + determinism)', out.suiteOrder);
show('YARDS SQUARED AT START (the old initial condition)', out.squared);

console.log('\nVERDICT');
const orderDelta = Math.abs(out.isolated.maxHeel - out.suiteOrder.maxHeel);
console.log(`  isolated vs suite order: ${orderDelta.toFixed(2)} deg of peak heel apart`);
console.log(
  `  correctly braced vs squared: ${out.isolated.maxHeel.toFixed(1)} vs ${out.squared.maxHeel.toFixed(1)} deg`,
);

await browser.close();
