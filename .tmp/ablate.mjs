#!/usr/bin/env node
/**
 * Where does the frame actually go? Toggles `.visible` on each top-level scene
 * object and reports the wall-clock frame time with it gone. Purely
 * subtractive, so it attributes GPU fill cost, which no `upd:` counter sees.
 */
import { chromium } from 'playwright';
import process from 'node:process';

const scene = process.argv[2] ?? 'noon';
const SCENES = {
  noon: { timeOfDay: 12.7, windSpeed: 10.5, cloudCover: 0.38, cloudType: 0.8, turbidity: 2, rain: 0, visibility: 34000, seaState: 4, waveHeight: 2, choppiness: 0.6 },
  storm: { timeOfDay: 15, windSpeed: 22, cloudCover: 0.98, cloudType: 1, turbidity: 6, rain: 0.9, visibility: 5200, seaState: 7, waveHeight: 6.5, choppiness: 0.85 },
};

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
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(() => !!window.__leeward, null, { timeout: 60000 });
await page.evaluate((env) => {
  const w = window.__leeward.world;
  Object.assign(w.settings, { quality: 'ultra', adaptiveResolution: false, renderScale: 1, debug: false });
  Object.assign(w.env, env);
  Object.assign(w.cam, { mode: 'chase', distance: 74 });
  w.bus.emit('settings:changed');
  w.bus.emit('capture:scene', {});
}, SCENES[scene] ?? SCENES.noon);
await page.waitForTimeout(9000);

const measure = async (label, setup) => {
  const ms = await page.evaluate(async ({ setup }) => {
    const w = window.__leeward.world;
    // eslint-disable-next-line no-new-func
    const undo = new Function('w', setup)(w);
    await new Promise((r) => setTimeout(r, 700));
    const f0 = w.time.frame, t0 = performance.now();
    await new Promise((r) => setTimeout(r, 2200));
    const dt = performance.now() - t0, df = w.time.frame - f0;
    if (typeof undo === 'function') undo();
    await new Promise((r) => setTimeout(r, 400));
    return df > 0 ? dt / df : Infinity;
  }, { setup });
  console.log(`  ${label.padEnd(46)} ${ms.toFixed(1)} ms/frame  (${(1000 / ms).toFixed(1)} fps)`);
  return ms;
};

const tops = await page.evaluate(() => window.__leeward.world.scene.children.map((c, i) => ({
  i, name: c.name || '(unnamed)', type: c.type, visible: c.visible,
  kids: c.children.length,
})));
console.log(`=== ${scene}: top-level scene objects ===`);
console.table(tops);

console.log(`\n=== ablation (higher ms = that object is expensive) ===`);
const base = await measure('BASELINE (everything on)', 'return null;');
for (const t of tops) {
  if (!t.visible) continue;
  await measure(`without [${t.i}] ${t.name} ${t.type}`,
    `const o = w.scene.children[${t.i}]; o.visible = false; return () => { o.visible = true; };`);
}
await measure('ocean clipmap: only 2 innermost levels',
  `const lv = w.ocean.mesh.levels; const hid = lv.slice(2); for (const l of hid) l.mesh.visible = false; return () => { for (const l of hid) l.mesh.visible = true; };`);
await measure('ocean: half render scale',
  `w.settings.renderScale = 0.5; w.bus.emit('settings:changed'); return () => { w.settings.renderScale = 1; w.bus.emit('settings:changed'); };`);
console.log(`\nbaseline was ${base.toFixed(1)} ms`);
await browser.close();
