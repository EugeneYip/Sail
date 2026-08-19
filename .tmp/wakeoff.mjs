/**
 * Ownership test for the long thin lines ruled across the water (DIAGNOSIS 8.5,
 * "owner unknown"). Renders the golden scene four ways:
 *   a  baseline
 *   b  ocean's tap on `world.ext.vfx.wakeStrength` pinned to 0 by an accessor
 *      that swallows VFX's own per-frame write  -> isolates the whole wake field
 *   c  every `vfx-*` mesh hidden                -> isolates the hull-water meshes
 *   d  both
 * If the lines survive all of these they are not vfx's.
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const OUT = process.env.OUT || '/tmp/wakeoff';
const SCENE = process.env.SCENE || 'golden';
await mkdir(OUT, { recursive: true });

const SCENES = {
  golden: {
    env: { timeOfDay: 18.6, windSpeed: 7.0, cloudCover: 0.5, cloudType: 0.75, turbidity: 3.6, rain: 0, visibility: 26000, seaState: 3, waveHeight: 1.5, choppiness: 0.5 },
    cam: { mode: 'chase', distance: 80 },
  },
  noon: {
    env: { timeOfDay: 12.7, windSpeed: 10.5, cloudCover: 0.38, cloudType: 0.8, turbidity: 2.0, rain: 0, visibility: 34000, seaState: 4, waveHeight: 2.0, choppiness: 0.6 },
    cam: { mode: 'chase', distance: 74 },
  },
  storm: {
    env: { timeOfDay: 15.0, windSpeed: 22.0, cloudCover: 0.98, cloudType: 0.95, turbidity: 6.0, rain: 0.85, visibility: 5200, seaState: 7, waveHeight: 6.5, choppiness: 0.85 },
    cam: { mode: 'chase', distance: 70 },
  },
  // Same gale with the haze pulled back, so "flat because fogged" and "flat
  // because the surface really has no relief" stop looking identical.
  stormclear: {
    env: { timeOfDay: 15.0, windSpeed: 22.0, cloudCover: 0.98, cloudType: 0.95, turbidity: 2.0, rain: 0, visibility: 34000, seaState: 7, waveHeight: 6.5, choppiness: 0.85 },
    cam: { mode: 'chase', distance: 70 },
  },
  waterline: {
    env: { timeOfDay: 13.8, windSpeed: 12.0, cloudCover: 0.35, cloudType: 0.8, turbidity: 2.0, rain: 0, visibility: 34000, seaState: 5, waveHeight: 3.0, choppiness: 0.7 },
    cam: { mode: 'cinematic' },
  },
};

const b = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--force-color-profile=srgb', '--hide-scrollbars'],
});
const p = await b.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
await p.addInitScript(() => {
  const R = window.WebSocket;
  window.WebSocket = function (u, pr) {
    if (pr === 'vite-hmr') return { readyState: 3, close() {}, send() {}, addEventListener() {}, removeEventListener() {} };
    return new R(u, pr);
  };
  window.WebSocket.prototype = R.prototype;
});
await p.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded', timeout: 180000 });
await p.waitForFunction(() => !!window.__leeward, null, { timeout: 180000 });
await p.evaluate((scene) => {
  const w = window.__leeward.world;
  w.settings.adaptiveResolution = false;
  w.settings.renderScale = 1;
  w.settings.showHud = false;
  Object.assign(w.env, scene.env);
  Object.assign(w.cam, scene.cam);
  w.bus.emit('settings:changed');
  w.bus.emit('capture:scene', scene);
}, SCENES[SCENE]);
await p.waitForTimeout(12000);
await p.screenshot({ path: `${OUT}/a-baseline.png` });

await p.evaluate(() => {
  const ext = window.__leeward.world.ext.vfx;
  Object.defineProperty(ext, 'wakeStrength', { get: () => 0, set() {}, configurable: true });
});
await p.waitForTimeout(2500);
await p.screenshot({ path: `${OUT}/b-wakefield-off.png` });

const hidden = await p.evaluate(() => {
  let n = 0;
  window.__leeward.world.scene.traverse((o) => {
    if ((o.isMesh || o.isPoints) && /^vfx-/.test(o.name)) { o.visible = false; n++; }
  });
  return n;
});
await p.waitForTimeout(2000);
await p.screenshot({ path: `${OUT}/c-all-vfx-off.png` });
console.log('hid vfx meshes:', hidden, '->', OUT);
await b.close();
