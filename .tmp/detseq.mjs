#!/usr/bin/env node
/** Replicate physics-test sections 4 (roll decay) then 5 (determinism) exactly. */
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

// Section 4: free roll decay, exactly as physics-test does it.
await page.evaluate(() => {
  const w = window.__leeward.world;
  const px = w.ext.physics;
  w.env.windSpeed = 0;
  w.env.gust = 1;
  w.input.steer = 0;
  px.flatSea = true;
  px.sailLevel = 0;
  for (const s of w.ship.sails) s.set = 0;
  px.reset(0, 0, 20);
  px.run(80, 1 / 120, true);
});

// Section 5: determinism, exactly as physics-test does it.
const fr = await page.evaluate(() => {
  const w = window.__leeward.world;
  const px = w.ext.physics;
  w.env.windSpeed = 9;
  w.env.gust = 1;
  w.input.steer = 0;
  px.flatSea = true;
  const heading = ((w.env.windBearing * 180) / Math.PI - 120 + 720) % 360;
  const one = (dt) => {
    px.reset(heading, 0);
    px.sailLevel = 16;
    for (const s of w.ship.sails) s.set = 1;
    const tr = px.run(150, dt);
    return tr[tr.length - 1];
  };
  const slow = one(1 / 30);
  const fast = one(1 / 144);
  const again = one(1 / 30);
  return { slow, fast, again };
});
console.log(`   30 fps: ${fr.slow.knots.toFixed(3)} kn  heading ${fr.slow.headingDeg.toFixed(2)}  heel ${fr.slow.heelDeg.toFixed(2)}`);
console.log(`  144 fps: ${fr.fast.knots.toFixed(3)} kn  heading ${fr.fast.headingDeg.toFixed(2)}  heel ${fr.fast.heelDeg.toFixed(2)}`);
console.log(`   30 again: ${fr.again.knots.toFixed(3)} kn  heel ${fr.again.heelDeg.toFixed(2)}   <- same dt, clean rig`);
console.log(`  delta 30-vs-144: ${Math.abs(fr.slow.knots - fr.fast.knots).toFixed(4)} kn, ${Math.abs(fr.slow.heelDeg - fr.fast.heelDeg).toFixed(3)} deg heel`);
console.log(`  delta 30-vs-30 : ${Math.abs(fr.slow.knots - fr.again.knots).toFixed(4)} kn, ${Math.abs(fr.slow.heelDeg - fr.again.heelDeg).toFixed(3)} deg heel`);
await browser.close();
