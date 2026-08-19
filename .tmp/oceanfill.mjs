#!/usr/bin/env node
/**
 * Ocean fragment cost, measured so machine drift cannot fake it.
 *
 * This box runs other agents' Chromium and tsc, so wall-clock frame time walks
 * upward during a run: a naive sequential ablation reported EVERY object as
 * negative cost because the baseline was simply measured first. So each variant
 * is bracketed by a fresh baseline and reported as a ratio, and the whole set
 * is repeated so an outlier is visible rather than averaged in.
 */
import { chromium } from 'playwright';
import process from 'node:process';

const REPS = Number(process.argv[2] ?? 3);
const ENV = { timeOfDay: 12.7, windSpeed: 10.5, cloudCover: 0.38, cloudType: 0.8, turbidity: 2, rain: 0, visibility: 34000, seaState: 4, waveHeight: 2, choppiness: 0.6 };

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
}, ENV);
await page.waitForTimeout(9000);

const frameMs = (setup) => page.evaluate(async ({ setup }) => {
  const w = window.__leeward.world;
  // eslint-disable-next-line no-new-func
  const undo = new Function('w', setup)(w);
  await new Promise((r) => setTimeout(r, 500));
  const f0 = w.time.frame, t0 = performance.now();
  await new Promise((r) => setTimeout(r, 1600));
  const dt = performance.now() - t0, df = w.time.frame - f0;
  if (typeof undo === 'function') undo();
  await new Promise((r) => setTimeout(r, 300));
  return df > 0 ? dt / df : Infinity;
}, { setup });

const VARIANTS = {
  'ocean hidden entirely': `const o = w.scene.getObjectByName('ocean'); o.visible = false; return () => { o.visible = true; };`,
  'ocean 1/4 screen area (scale mesh down)': `const g = w.scene.getObjectByName('ocean'); const s = g.scale.clone(); g.scale.set(0.02,1,0.02); return () => { g.scale.copy(s); };`,
  'sky hidden': `const o = w.scene.getObjectByName('sky'); o.visible = false; return () => { o.visible = true; };`,
  'shipRoot hidden': `const o = w.scene.getObjectByName('shipRoot'); o.visible = false; return () => { o.visible = true; };`,
  'islands hidden': `const a = w.scene.getObjectByName('island-1'), b = w.scene.getObjectByName('island-2'); a.visible = false; b.visible = false; return () => { a.visible = true; b.visible = true; };`,
  'renderScale 0.5': `w.settings.renderScale = 0.5; w.bus.emit('settings:changed'); return () => { w.settings.renderScale = 1; w.bus.emit('settings:changed'); };`,
};

const acc = new Map(Object.keys(VARIANTS).map((k) => [k, []]));
for (let r = 0; r < REPS; r++) {
  for (const [label, setup] of Object.entries(VARIANTS)) {
    const on1 = await frameMs('return null;');
    const off = await frameMs(setup);
    const on2 = await frameMs('return null;');
    const base = (on1 + on2) / 2;
    acc.get(label).push({ base, off, saved: base - off });
    process.stdout.write('.');
  }
}
console.log('\n=== ocean fill cost, baseline-bracketed (ms saved by removing it) ===');
const rows = [];
for (const [label, xs] of acc) {
  const saved = xs.map((x) => x.saved).sort((a, b) => a - b);
  const bases = xs.map((x) => x.base);
  rows.push({
    variant: label,
    'median base ms': +(bases.sort((a, b) => a - b)[bases.length >> 1]).toFixed(1),
    'median saved ms': +saved[saved.length >> 1].toFixed(1),
    'saved range': saved.map((s) => s.toFixed(1)).join(' / '),
  });
}
console.table(rows);
await browser.close();
