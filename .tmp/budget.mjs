#!/usr/bin/env node
/** Itemised frame budget. Serialising GPU timers, so absolute ms are real. */
import { chromium } from 'playwright';
import process from 'node:process';

const W = 1600, H = 900;
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--force-color-profile=srgb', '--hide-scrollbars', '--mute-audio', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: W, height: H } });
await page.addInitScript(() => {
  const Real = window.WebSocket;
  class Dead extends EventTarget { constructor() { super(); this.readyState = 3; } send() {} close() {} }
  window.WebSocket = function (u, p) { return p === 'vite-hmr' ? new Dead() : new Real(u, p); };
});
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 120)); });
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__leeward, null, { timeout: 60000 });

const scene = process.argv[2] ?? 'noon';
const SCENES = {
  noon: { timeOfDay: 12.7, windSpeed: 10.5, cloudCover: 0.38, cloudType: 0.8, turbidity: 2.0, rain: 0, visibility: 34000, seaState: 4, waveHeight: 2.0, choppiness: 0.6 },
  night: { timeOfDay: 23.4, windSpeed: 6.5, cloudCover: 0.2, cloudType: 0.5, turbidity: 2.0, rain: 0, visibility: 30000, seaState: 3, waveHeight: 1.1, choppiness: 0.5 },
};
await page.evaluate((env) => {
  const w = window.__leeward.world;
  w.settings.quality = 'ultra';
  w.settings.adaptiveResolution = false;
  w.settings.renderScale = 1;
  w.settings.debug = true;
  Object.assign(w.env, env);
  Object.assign(w.cam, { mode: 'chase', distance: 74 });
  w.bus.emit('settings:changed');
  w.bus.emit('capture:scene', {});
}, SCENES[scene] ?? SCENES.noon);

await page.waitForTimeout(9000);

// Wall-clock frame rate, measured with nothing else touching the page.
const a = await page.evaluate(() => ({ f: window.__leeward.world.time.frame, t: performance.now() }));
await page.waitForTimeout(4000);
const b = await page.evaluate(() => ({ f: window.__leeward.world.time.frame, t: performance.now() }));
console.log(`scene=${scene}  wall fps (debug on, serialising sky timers) = ${(((b.f - a.f) * 1000) / (b.t - a.t)).toFixed(1)}`);

const stats = await page.evaluate(() => {
  const w = window.__leeward.world;
  const f = (v) => +Number(v).toPrecision(4);
  return {
    sky: Object.fromEntries(Object.entries(w.stats).filter(([k]) => k.startsWith('sky:')).map(([k, v]) => [k, f(v)])),
    upd: Object.fromEntries(Object.entries(w.stats).filter(([k]) => k.startsWith('upd:')).map(([k, v]) => [k, f(v)])),
    post: Object.fromEntries(Object.entries(w.stats).filter(([k]) => k.startsWith('post:')).map(([k, v]) => [k, f(v)])),
    dc: w.stats.drawCalls, tri: w.stats.triangles, prog: w.stats.programs,
    vram: w.ext.post.vram(),
  };
});
console.log('\n-- sky (serialising, real GPU ms) --'); console.log(stats.sky);
console.log('\n-- module update CPU ms --');
console.log(Object.entries(stats.upd).sort((x, y) => y[1] - x[1]).slice(0, 12));
console.log('\n-- post (submission ms) --'); console.log(stats.post);
console.log(`\ndrawCalls=${stats.dc} tris=${stats.tri} programs=${stats.prog}`);
console.log(`vram total=${stats.vram.total.toFixed(1)} MB`);
console.log(stats.vram.targets.slice(0, 10).map((t) => `${t.key} ${t.w}x${t.h} ${t.kind} ${t.mb.toFixed(2)}MB`).join('\n'));

// Serialising per-pass post timing.
const prof = await page.evaluate(() => window.__leeward.world.ext.post.profile(150));
console.log('\n-- post passes, serialising GPU ms --');
console.log(Object.entries(prof).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k.padEnd(14)} ${v.toFixed(3)}`).join('\n'));
console.log(`\npost total = ${Object.values(prof).reduce((s, v) => s + v, 0).toFixed(3)} ms`);
if (errs.length) console.log(`\n${errs.length} console errors`);
await browser.close();
