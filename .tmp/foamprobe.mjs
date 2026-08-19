#!/usr/bin/env node
/**
 * Why does a full gale render with no whitecaps?
 *
 * The CPU fold histogram says 18% of the surface is below the breaking
 * threshold, which is what Monahan asks for, yet nothing turns white. This
 * bisects the foam path in the page: force the threshold far above the whole
 * fold distribution and see whether the sea goes white at all. If it does the
 * mask is simply mistuned; if it does not, something downstream of the mask is
 * eating it.
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const OUT = process.env.OUT || '/tmp/foamprobe';
await mkdir(OUT, { recursive: true });
const ENV = { timeOfDay: 15, windSpeed: 22, cloudCover: 0.98, cloudType: 0.95, turbidity: 6, rain: 0.85, visibility: 5200, seaState: 7, waveHeight: 6.5, choppiness: 0.85 };

const b = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--hide-scrollbars', '--mute-audio'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
await p.addInitScript(() => { const R = window.WebSocket; class D extends EventTarget { constructor() { super(); this.readyState = 3; } send() {} close() {} } window.WebSocket = function (u, pr) { return pr === 'vite-hmr' ? new D() : new R(u, pr); }; });
await p.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded', timeout: 240000 });
await p.waitForFunction(() => !!window.__leeward, null, { timeout: 240000 });
await p.evaluate((e) => {
  const w = window.__leeward.world;
  Object.assign(w.settings, { quality: 'ultra', adaptiveResolution: false, renderScale: 1, showHud: false });
  Object.assign(w.env, e);
  Object.assign(w.cam, { mode: 'chase', distance: 70 });
  w.bus.emit('settings:changed');
  w.bus.emit('capture:scene', {});
}, ENV);
await p.waitForTimeout(11000);

const live = await p.evaluate(() => {
  const mu = window.__leeward.world.ocean.material.uniforms;
  return {
    uFoamThreshold: mu.uFoamThreshold.value,
    uFoamSoftness: mu.uFoamSoftness ? mu.uFoamSoftness.value : 'MISSING',
    uFoamAmount: mu.uFoamAmount.value,
    uWaveHeight: mu.uWaveHeight.value,
  };
});
console.log('live foam uniforms:', live);

// Freeze the sim so the four variants differ only by the uniform under test.
const shot = async (label, mutate) => {
  await p.evaluate((m) => {
    const mu = window.__leeward.world.ocean.material.uniforms;
    // eslint-disable-next-line no-new-func
    new Function('u', m)(mu);
  }, mutate);
  await p.waitForTimeout(1200);
  await p.screenshot({ path: `${OUT}/${label}.png` });
  console.log('  wrote', label);
};

await shot('a-live', 'return;');
await shot('b-threshold-1.5', 'u.uFoamThreshold.value = 1.5;');
await shot('c-threshold-1.5-soft-0.05', 'u.uFoamThreshold.value = 1.5; u.uFoamSoftness.value = 0.05;');
await shot('d-back-to-live-thr-0.98', 'u.uFoamThreshold.value = 0.98; u.uFoamSoftness.value = 0.12;');
await b.close();
