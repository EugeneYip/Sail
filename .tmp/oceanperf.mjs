#!/usr/bin/env node
/**
 * Trustworthy `upd:*` numbers. Samples world.stats over N real frames and
 * reports the median, and it does NOTHING ELSE — no benching, no extra
 * renderer calls, no readbacks. Benching inside the page backs up the GPU
 * queue and inflates the very `upd:` values you then read (measured: upd:ocean
 * 1.3 -> 11.9 ms with a bench pass in front of it), and driving cpu.update()
 * with its own clock desynchronises the CPU mirror from the GPU.
 */
import { chromium } from 'playwright';
import process from 'node:process';

const SCENES = {
  noon: { timeOfDay: 12.7, windSpeed: 10.5, cloudCover: 0.38, cloudType: 0.8, turbidity: 2, rain: 0, visibility: 34000, seaState: 4, waveHeight: 2, choppiness: 0.6 },
  golden: { timeOfDay: 18.6, windSpeed: 8, cloudCover: 0.45, cloudType: 0.6, turbidity: 3, rain: 0, visibility: 28000, seaState: 3, waveHeight: 1.5, choppiness: 0.55 },
  storm: { timeOfDay: 15, windSpeed: 22, cloudCover: 0.98, cloudType: 1, turbidity: 6, rain: 0.9, visibility: 5200, seaState: 7, waveHeight: 6.5, choppiness: 0.85 },
};
const scene = process.argv[2] ?? 'noon';
const FRAMES = Number(process.argv[3] ?? 180);

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--hide-scrollbars', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.addInitScript(() => {
  const R = window.WebSocket;
  class D extends EventTarget { constructor() { super(); this.readyState = 3; } send() {} close() {} }
  window.WebSocket = function (u, p) { return p === 'vite-hmr' ? new D() : new R(u, p); };
});
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 160)); });
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message.slice(0, 160)));
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__leeward, null, { timeout: 60000 });
await page.evaluate((env) => {
  const w = window.__leeward.world;
  Object.assign(w.settings, { quality: 'ultra', adaptiveResolution: false, renderScale: 1, debug: true });
  Object.assign(w.env, env);
  Object.assign(w.cam, { mode: 'chase', distance: 74 });
  w.bus.emit('settings:changed');
  w.bus.emit('capture:scene', {});
}, SCENES[scene] ?? SCENES.noon);
await page.waitForTimeout(9000);

const out = await page.evaluate(async (frames) => {
  const w = window.__leeward.world;
  const keys = Object.keys(w.stats).filter((k) => /^(upd:|ocean:)/.test(k));
  const series = new Map(keys.map((k) => [k, []]));
  const f0 = w.time.frame;
  const t0 = performance.now();
  await new Promise((done) => {
    let n = 0;
    const tick = () => {
      for (const k of keys) series.get(k).push(Number(w.stats[k]) || 0);
      if (++n >= frames) return done();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const wall = performance.now() - t0;
  const frameCount = w.time.frame - f0;
  const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
  const p95 = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]; };
  const rows = keys.map((k) => ({ key: k, med: +med(series.get(k)).toFixed(2), p95: +p95(series.get(k)).toFixed(2) }));
  rows.sort((a, b) => b.med - a.med);
  return {
    rows,
    fps: +((frameCount * 1000) / wall).toFixed(1),
    drawCalls: w.stats.drawCalls,
    tris: w.stats.triangles,
    passes: w.stats['ocean:passes'],
  };
}, FRAMES);

console.log(`=== ${scene} — median of ${FRAMES} sampled frames, 1600x900 ultra ===`);
console.log(`fps=${out.fps}  drawCalls=${out.drawCalls}  tris=${out.tris}  ocean:passes=${out.passes}`);
console.table(out.rows);
if (errs.length) console.log(`\nCONSOLE ERRORS (${errs.length}):\n` + [...new Set(errs)].slice(0, 8).join('\n'));
else console.log('\nno console errors');
await browser.close();
