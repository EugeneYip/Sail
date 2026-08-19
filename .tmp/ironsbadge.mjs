#!/usr/bin/env node
/**
 * Is the "IN IRONS" badge on screen telling the truth?
 *
 * Driving Pro mode left the HUD reading "5.4 KN IN IRONS Broad reach" — three
 * statements that cannot all be true. `ship.inIrons` is a latch in
 * ShipDynamics and it clears at TWA >= 62 deg or 1.6 m/s of water speed, so
 * either the flag is stuck (physics, mine) or the badge is stale (UI, not mine).
 * This tells the two apart by reading the flag and the DOM on the same frame.
 */
import { chromium } from 'playwright';

const URL = 'http://127.0.0.1:5178/';
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1000, height: 620 } });
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
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => !!window.__leeward?.world?.ext?.physics, null, { timeout: 180000 });
await page.waitForTimeout(2000);
for (let i = 0; i < 12 && (await page.evaluate(() => window.__leeward.world.input.uiFocus)); i++) {
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
}

/** flag + what the player can actually read, sampled together. */
const sample = (label) =>
  page.evaluate((label) => {
    const w = window.__leeward.world;
    const R = 180 / Math.PI;
    const text = document.body.innerText.replace(/\s+/g, ' ');
    // innerText includes `opacity: 0` text, so matching it is NOT a visibility
    // test — `.irons-tag` is opacity 0 until the parent gets `.irons`. Measure
    // the rendered opacity instead, or every HUD dump reports a stuck badge.
    const visible = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return 'absent';
      const cs = getComputedStyle(el);
      return cs.display === 'none' || cs.visibility === 'hidden'
        ? 'hidden'
        : `opacity ${(+cs.opacity).toFixed(2)}`;
    };
    return {
      label,
      assist: w.settings.assist,
      inIrons: w.ship.inIrons,
      badgeInText: /IN IRONS|in irons/i.test(text),
      tag: visible('.irons-tag'),
      mini: visible('.mini-irons'),
      kn: +w.ship.speedKnots.toFixed(2),
      twa: +((((w.env.windBearing - w.ship.heading) * R + 540) % 360) - 180).toFixed(0),
      pos: w.ship.pointOfSail,
    };
  }, label);

const show = (s) =>
  console.log(
    `${s.label.padEnd(34)} assist=${String(s.assist).padEnd(5)} inIrons=${String(s.inIrons).padEnd(5)} ` +
      `inText=${String(s.badgeInText).padEnd(5)} tag[${s.tag}] mini[${s.mini}] ` +
      `${String(s.kn).padStart(5)} kn  TWA ${String(s.twa).padStart(4)}  ${s.pos}`,
  );

// Put her in irons for real: Pro, head to wind, no way on.
await page.evaluate(() => {
  const w = window.__leeward.world;
  const R = 180 / Math.PI;
  Object.assign(w.env, { windSpeed: 10, gust: 1 });
  w.settings.assist = false;
  w.ext.physics.reset((w.env.windBearing * R - 10 + 720) % 360, 0);
});
await page.waitForTimeout(6000);
show(await sample('1. Pro, head to wind, at rest'));

// Now bear away onto a broad reach, still in Pro, and give her time to clear.
await page.evaluate(() => {
  const w = window.__leeward.world;
  const R = 180 / Math.PI;
  w.ext.physics.reset((w.env.windBearing * R - 120 + 720) % 360, 7);
});
await page.waitForTimeout(8000);
show(await sample('2. Pro, broad reach, 7 kn entry'));

// And switch to assist, which must clear the latch unconditionally.
await page.evaluate(() => { window.__leeward.world.settings.assist = true; });
await page.waitForTimeout(3000);
show(await sample('3. assist on, same broad reach'));

await browser.close();
