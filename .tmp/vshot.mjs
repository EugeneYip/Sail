/**
 * Capture + zoomed-crop harness for the VFX agent.
 *
 * Same scene table as scripts/capture.mjs, but every Playwright timeout is
 * generous (this machine runs several headless Chromiums at once and the shared
 * harness times out on `page.screenshot` at load) and it writes an upscaled crop
 * of a region next to each full frame so hull-waterline detail can be judged.
 *
 *   node .tmp/vshot.mjs --out shots/vfx-a --scene noon,orbit --settle 10
 *   node .tmp/vshot.mjs --out shots/vfx-a --scene orbit --crop 780,480,420,270
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const SCENES = {
  noon: {
    env: { timeOfDay: 12.7, windSpeed: 10.5, cloudCover: 0.38, cloudType: 0.8, turbidity: 2.0, rain: 0, visibility: 34000, seaState: 4, waveHeight: 2.0, choppiness: 0.6 },
    cam: { mode: 'chase', distance: 74 },
  },
  golden: {
    env: { timeOfDay: 18.6, windSpeed: 7.0, cloudCover: 0.5, cloudType: 0.75, turbidity: 3.6, rain: 0, visibility: 26000, seaState: 3, waveHeight: 1.5, choppiness: 0.5 },
    cam: { mode: 'chase', distance: 80 },
  },
  orbit: {
    env: { timeOfDay: 15.6, windSpeed: 9.0, cloudCover: 0.4, cloudType: 0.75, turbidity: 2.2, rain: 0, visibility: 32000, seaState: 3, waveHeight: 1.5, choppiness: 0.55 },
    cam: { mode: 'orbit', distance: 110 },
  },
  waterline: {
    env: { timeOfDay: 13.8, windSpeed: 12.0, cloudCover: 0.35, cloudType: 0.8, turbidity: 2.0, rain: 0, visibility: 34000, seaState: 5, waveHeight: 3.0, choppiness: 0.7 },
    cam: { mode: 'cinematic' },
  },
  storm: {
    env: { timeOfDay: 15.0, windSpeed: 22.0, cloudCover: 0.98, cloudType: 0.95, turbidity: 6.0, rain: 0.85, visibility: 5200, seaState: 7, waveHeight: 6.5, choppiness: 0.85 },
    cam: { mode: 'chase', distance: 70 },
  },
  close: {
    env: { timeOfDay: 14.2, windSpeed: 11.0, cloudCover: 0.35, cloudType: 0.8, turbidity: 2.0, rain: 0, visibility: 34000, seaState: 4, waveHeight: 2.2, choppiness: 0.62 },
    cam: { mode: 'orbit', distance: 46 },
  },
};

const a = { out: 'shots/vfx', scene: 'orbit', settle: 10, w: 1600, h: 900, crop: '' };
for (let i = 2; i < process.argv.length; i++) {
  const k = process.argv[i];
  if (!k.startsWith('--')) continue;
  const key = k.slice(2);
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith('--')) continue;
  i++;
  a[key] = ['settle', 'w', 'h'].includes(key) ? Number(v) : v;
}
const scenes = a.scene.split(',').map((s) => s.trim()).filter(Boolean);
await mkdir(dirname(a.out), { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader',
    '--force-color-profile=srgb', '--disable-features=CalculateNativeWinOcclusion', '--hide-scrollbars', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: a.w, height: a.h }, deviceScaleFactor: 1, colorScheme: 'dark' });
page.setDefaultTimeout(240000);
page.setDefaultNavigationTimeout(240000);
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.addInitScript(() => {
  const Real = window.WebSocket;
  window.WebSocket = function (u, pr) {
    if (pr === 'vite-hmr') return { readyState: 3, close() {}, send() {}, addEventListener() {}, removeEventListener() {} };
    return new Real(u, pr);
  };
  window.WebSocket.prototype = Real.prototype;
});
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__leeward, null, { timeout: 240000 });

const cropRects = a.crop
  ? a.crop.split(';').map((s) => s.split(',').map(Number))
  : [];

for (const name of scenes) {
  const scene = SCENES[name];
  if (!scene) { console.error('unknown scene', name); continue; }
  await page.evaluate(({ scene }) => {
    const w = window.__leeward.world;
    w.settings.adaptiveResolution = false;
    w.settings.renderScale = 1;
    w.settings.showHud = false;
    Object.assign(w.env, scene.env ?? {});
    Object.assign(w.cam, scene.cam ?? {});
    w.bus.emit('settings:changed');
    w.bus.emit('capture:scene', scene);
  }, { scene });
  await page.waitForTimeout(a.settle * 1000);
  const stats = await page.evaluate(() => {
    const w = window.__leeward.world;
    return {
      fps: Math.round(w.time.fps), dc: w.stats.drawCalls ?? 0,
      knots: +w.ship.speedKnots.toFixed(2), heel: +((w.ship.heel * 180) / Math.PI).toFixed(2),
      wake: +(w.ext.vfx?.wakeStrength ?? -1).toFixed(3),
    };
  });
  await page.screenshot({ path: `${a.out}-${name}.png`, animations: 'allow' });
  for (let i = 0; i < cropRects.length; i++) {
    const [x, y, cw, ch] = cropRects[i];
    await page.screenshot({ path: `${a.out}-${name}-c${i}.png`, animations: 'allow', clip: { x, y, width: cw, height: ch } });
  }
  console.log(`${name.padEnd(10)} fps=${String(stats.fps).padStart(3)} dc=${stats.dc} kn=${stats.knots} heel=${stats.heel} wake=${stats.wake}`);
}

await browser.close();
if (errors.length) {
  await writeFile(`${a.out}-console.log`, errors.join('\n'), 'utf8');
  console.error(`\n${errors.length} console error(s):`);
  for (const e of errors.slice(0, 12)) console.error('  ' + e);
}
console.log('done');
