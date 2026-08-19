#!/usr/bin/env node
/**
 * Is the 30-vs-144 fps divergence a frame-rate bug, or is it the rig state the
 * previous run leaves behind? Run the same dt twice and compare.
 */
import { chromium } from 'playwright';

const URL = 'http://127.0.0.1:5178/';
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
await page.addInitScript(() => {
  const Real = WebSocket;
  class Dead extends EventTarget { constructor() { super(); this.readyState = 3; } send() {} close() {} }
  const P = function (u, p) {
    const vite = p === 'vite-hmr' || (Array.isArray(p) && p.includes('vite-hmr'));
    return vite ? new Dead() : new Real(u, p);
  };
  P.prototype = Real.prototype;
  Object.assign(P, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  window.WebSocket = P;
});
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => !!window.__leeward?.world?.ext?.physics, null, { timeout: 180000 });
await page.waitForTimeout(1500);

const seq = await page.evaluate(() => {
  const w = window.__leeward.world;
  const px = w.ext.physics;
  w.env.windSpeed = 9;
  w.env.gust = 1;
  w.input.steer = 0;
  px.flatSea = true;
  const heading = ((w.env.windBearing * 180) / Math.PI - 120 + 720) % 360;
  const one = (dt, wipe) => {
    px.reset(heading, 0);
    px.sailLevel = 16;
    for (const s of w.ship.sails) {
      s.set = 1;
      if (wipe) { s.luff = 0; s.camber = 0; s.brace = 0; }
    }
    const tr = px.run(150, dt);
    const l = tr[tr.length - 1];
    return { kn: l.knots, hdg: l.headingDeg, heel: l.heelDeg, area: l.sailArea };
  };
  return {
    // Same dt, back to back. Any difference here is the starting rig state.
    a30: one(1 / 30, false),
    b30: one(1 / 30, false),
    c30: one(1 / 30, false),
    a144: one(1 / 144, false),
    b144: one(1 / 144, false),
    // Now with the rig wiped to an identical state before each run.
    w30: one(1 / 30, true),
    w144: one(1 / 144, true),
    w30b: one(1 / 30, true),
    w144b: one(1 / 144, true),
  };
});

for (const [k, v] of Object.entries(seq)) {
  console.log(`  ${k.padEnd(6)} ${v.kn.toFixed(3).padStart(7)} kn  hdg ${v.hdg.toFixed(2).padStart(8)}  heel ${v.heel.toFixed(2).padStart(6)}  canvas ${v.area.toFixed(0)}`);
}
console.log('\n  same-dt spread 30 fps  :', Math.abs(seq.a30.kn - seq.b30.kn).toFixed(4), 'kn,', Math.abs(seq.a30.heel - seq.b30.heel).toFixed(3), 'deg heel');
console.log('  same-dt spread 144 fps :', Math.abs(seq.a144.kn - seq.b144.kn).toFixed(4), 'kn');
console.log('  cross-dt, dirty rig    :', Math.abs(seq.b30.kn - seq.b144.kn).toFixed(4), 'kn,', Math.abs(seq.b30.heel - seq.b144.heel).toFixed(3), 'deg heel');
console.log('  cross-dt, wiped rig    :', Math.abs(seq.w30.kn - seq.w144.kn).toFixed(4), 'kn,', Math.abs(seq.w30.heel - seq.w144.heel).toFixed(3), 'deg heel');
console.log('  cross-dt, wiped rig #2 :', Math.abs(seq.w30b.kn - seq.w144b.kn).toFixed(4), 'kn,', Math.abs(seq.w30b.heel - seq.w144b.heel).toFixed(3), 'deg heel');

await browser.close();
