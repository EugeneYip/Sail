#!/usr/bin/env node
/**
 * Same scenes as scripts/capture.mjs, but with a screenshot timeout that
 * survives this box. The shared harness allows 30 s and the machine has been
 * sitting at a load average of 240 with other agents' Chromium on it, so the
 * page cannot always produce a frame inside that and the run dies before
 * writing anything. Nothing here changes what is rendered.
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import process from 'node:process';

const OUT = process.env.OUT || 'shots';
const PREFIX = process.env.PREFIX || 'ocean-f2';
await mkdir(OUT, { recursive: true });

const SCENES = {
  noon: { env: { timeOfDay: 12.7, windSpeed: 10.5, cloudCover: 0.38, cloudType: 0.8, turbidity: 2.0, rain: 0, visibility: 34000, seaState: 4, waveHeight: 2.0, choppiness: 0.6 }, cam: { mode: 'chase', distance: 74 } },
  golden: { env: { timeOfDay: 18.6, windSpeed: 7.0, cloudCover: 0.5, cloudType: 0.75, turbidity: 3.6, rain: 0, visibility: 26000, seaState: 3, waveHeight: 1.5, choppiness: 0.5 }, cam: { mode: 'chase', distance: 80 } },
  orbit: { env: { timeOfDay: 15.6, windSpeed: 9.0, cloudCover: 0.4, cloudType: 0.75, turbidity: 2.2, rain: 0, visibility: 32000, seaState: 3, waveHeight: 1.5, choppiness: 0.55 }, cam: { mode: 'orbit', distance: 110 } },
  waterline: { env: { timeOfDay: 13.8, windSpeed: 12.0, cloudCover: 0.35, cloudType: 0.8, turbidity: 2.0, rain: 0, visibility: 34000, seaState: 5, waveHeight: 3.0, choppiness: 0.7 }, cam: { mode: 'cinematic' } },
  storm: { env: { timeOfDay: 15.0, windSpeed: 22.0, cloudCover: 0.98, cloudType: 0.95, turbidity: 6.0, rain: 0.85, visibility: 5200, seaState: 7, waveHeight: 6.5, choppiness: 0.85 }, cam: { mode: 'chase', distance: 70 } },
};
const want = (process.argv[2] ?? Object.keys(SCENES).join(',')).split(',');

const b = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--hide-scrollbars', '--mute-audio'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
await p.addInitScript(() => { const R = window.WebSocket; class D extends EventTarget { constructor() { super(); this.readyState = 3; } send() {} close() {} } window.WebSocket = function (u, pr) { return pr === 'vite-hmr' ? new D() : new R(u, pr); }; });
await p.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded', timeout: 300000 });
await p.waitForFunction(() => !!window.__leeward, null, { timeout: 300000 });

for (const name of want) {
  const s = SCENES[name];
  if (!s) continue;
  await p.evaluate((sc) => {
    const w = window.__leeward.world;
    Object.assign(w.settings, { quality: 'ultra', adaptiveResolution: false, renderScale: 1, debug: true });
    Object.assign(w.env, sc.env);
    Object.assign(w.cam, sc.cam);
    w.bus.emit('settings:changed');
    w.bus.emit('capture:scene', sc);
  }, s);
  await p.waitForTimeout(9000);
  const stats = await p.evaluate(() => {
    const w = window.__leeward.world;
    return { fps: Math.round(w.time.fps), updOcean: +Number(w.stats['upd:ocean'] ?? 0).toPrecision(3) };
  });
  await p.screenshot({ path: `${OUT}/${PREFIX}-${name}.png`, timeout: 300000 });
  console.log(`${name.padEnd(11)} fps=${stats.fps} upd:ocean=${stats.updOcean}ms -> ${OUT}/${PREFIX}-${name}.png`);
}
await b.close();
