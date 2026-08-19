#!/usr/bin/env node
/**
 * Is the gale case's peak heel a property of the SHIP, or of which wave
 * snapshot it happened to be frozen on?
 *
 * `px.run()` steps the solver but never ticks the ocean, so all 36 000 frames of
 * the 10-minute gale sail through ONE frozen wave field — the one that happened
 * to be current when `run()` was called. The ocean's phase only advances on real
 * frames, so it is a function of wall-clock time since page load, i.e. of how
 * long every test before this one took.
 *
 * Run the identical gale case eight times, waiting between them so the live loop
 * advances the ocean, and print the peak heel each time. If the ship is the
 * variable, these are all the same number. If the snapshot is, they are not.
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

const GALE = `
  const w = window.__leeward.world;
  const px = w.ext.physics;
  const RAD = 180 / Math.PI;
  w.env.windSpeed = 24;
  w.env.gust = 1.25;
  w.env.waveHeight = 7;
  w.env.seaState = 8;
  w.input.steer = 0;
  px.flatSea = false;
  px.reset(((w.env.windBearing * RAD) - 130 + 720) % 360, 6);
  px.sailLevel = 16;
  for (const s of w.ship.sails) s.set = 1;
  const tr = px.run(600, 1 / 60, true);
  let maxHeel = 0, tPeak = 0, maxKn = 0, bad = 0;
  for (const s of tr) {
    const h = Math.abs(s.heelDeg);
    if (h > maxHeel) { maxHeel = h; tPeak = s.t; }
    maxKn = Math.max(maxKn, s.knots);
    for (const k in s) if (!Number.isFinite(s[k])) bad++;
  }
  return { maxHeel, tPeak, maxKn, bad, oceanTime: w.time.elapsed };
`;

const rows = [];
for (let i = 0; i < 8; i++) {
  // Let the live loop advance the ocean between cases. This is the only thing
  // that differs from one iteration to the next.
  if (i > 0) await page.waitForTimeout(1700);
  const r = await page.evaluate(new Function(GALE));
  rows.push(r);
  console.log(
    `  run ${i + 1}  ocean t=${r.oceanTime.toFixed(1).padStart(6)} s   ` +
      `peak heel ${r.maxHeel.toFixed(1).padStart(5)} deg at ${r.tPeak.toFixed(0).padStart(3)} s   ` +
      `peak ${r.maxKn.toFixed(2)} kn   ${r.bad} non-finite`,
  );
}

const heels = rows.map((r) => r.maxHeel);
const lo = Math.min(...heels);
const hi = Math.max(...heels);
console.log('\nSPREAD');
console.log(`  peak heel over 8 identical gale runs: ${lo.toFixed(1)} .. ${hi.toFixed(1)} deg`);
console.log(`  the suite asserts < 55 deg; ${heels.filter((h) => h >= 55).length}/8 of these fail it`);
console.log(
  `  ship state was identical every time — only w.time.elapsed (the frozen wave\n` +
    `  snapshot) differed, by ${(rows[7].oceanTime - rows[0].oceanTime).toFixed(1)} s across the set.`,
);

await browser.close();
