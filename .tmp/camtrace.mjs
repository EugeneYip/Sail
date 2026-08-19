#!/usr/bin/env node
/**
 * Per-frame trace of the free-look accumulator through a drag.
 *
 *   node .tmp/camtrace.mjs
 *
 * `.tmp/camdrag.mjs` showed `chase` registering only 0.615 rad of a 0.840 rad
 * drag right and 0.259 rad of the same drag left, while the first-person modes
 * registered 0.840 exactly. Two explanations fit that: the rig's output springs
 * had not settled by the time the sample was taken, or the mode's auto-recentre
 * was eating look angle. They are distinguishable per frame, so trace it:
 *
 *   - a spring that has not settled leaves `ext.camera.lookYaw` BELOW the angle
 *     the drag put in, and it keeps climbing toward it;
 *   - a recentre pulls `ext.camera.lookYaw` back DOWN once the drag has stopped.
 *
 * The sampler is appended to the engine's own module list, so it runs after the
 * camera rig in the same tick and reads exactly the values that frame solved
 * with — a `requestAnimationFrame` sampler would race the engine's own loop.
 */

import { chromium } from 'playwright';
import process from 'node:process';

const URL = 'http://127.0.0.1:5178/';
const W = 1600;
const H = 900;
const CX = W / 2;
const CY = H / 2;
const DRAG = 300;

const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist',
    '--enable-unsafe-swiftshader', '--force-color-profile=srgb',
    '--hide-scrollbars', '--mute-audio',
  ],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, colorScheme: 'dark' });
page.setDefaultTimeout(180000);
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

await page.addInitScript(() => {
  const Real = window.WebSocket;
  class Dead {
    constructor() {
      this.readyState = 3;
      this.close = () => {}; this.send = () => {};
      this.addEventListener = () => {}; this.removeEventListener = () => {};
    }
  }
  window.WebSocket = function (url, protocols) {
    return protocols === 'vite-hmr' ? new Dead() : new Real(url, protocols);
  };
  window.WebSocket.prototype = Real.prototype;
});

await page.goto(URL, { waitUntil: 'domcontentloaded' });
try {
  await page.waitForFunction(() => !!window.__leeward, null, { timeout: 420000 });
} catch {
  console.error('ENGINE NEVER BOOTED');
  for (const m of pageErrors.slice(0, 10)) console.error('  ' + m);
  await browser.close();
  process.exit(1);
}
await page.evaluate(() => {
  const w = window.__leeward.world;
  w.settings.adaptiveResolution = false;
  w.settings.renderScale = 1;
  Object.assign(w.env, {
    timeOfDay: 12.7, windSpeed: 10.5, cloudCover: 0.38, cloudType: 0.8,
    turbidity: 2.0, rain: 0, visibility: 34000, seaState: 4, waveHeight: 2.0,
    choppiness: 0.6,
  });
  w.bus.emit('settings:changed');
});
await page.waitForSelector('.intro.ready', { timeout: 420000 });
await page.click('.intro-begin');
await page.waitForTimeout(1600);

// Sampler module, appended so it runs last in the tick.
await page.evaluate(() => {
  const eng = window.__leeward;
  const w = eng.world;
  window.__trace = [];
  window.__traceOn = false;
  eng.modules.push({
    name: 'trace',
    init() {},
    update(world) {
      if (!window.__traceOn) return;
      window.__trace.push([
        +world.time.elapsed.toFixed(3),
        +world.time.rawDt.toFixed(4),
        +world.input.lookYaw.toFixed(4),
        +world.ext.camera.lookYaw.toFixed(4),
        +world.ext.camera.lookPitch.toFixed(4),
      ]);
    },
  });
  void w;
});

async function enter(name) {
  await page.evaluate((n) => {
    window.__leeward.world.cam.mode = n === 'chase' ? 'orbit' : 'chase';
  }, name);
  await page.waitForTimeout(300);
  await page.evaluate((n) => { window.__leeward.world.cam.mode = n; }, name);
  await page.waitForTimeout(1500);
}

async function run(mode, dx, hold = 0) {
  await enter(mode);
  await page.evaluate(() => { window.__trace = []; window.__traceOn = true; });
  await page.mouse.move(CX, CY);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(CX + (dx * i) / 12, CY);
  if (hold > 0) await page.waitForTimeout(hold); // still holding the button
  await page.mouse.up();
  await page.waitForTimeout(3000);
  const t = await page.evaluate(() => { window.__traceOn = false; return window.__trace; });

  console.log(`\n--- ${mode}, drag ${dx > 0 ? '+' : ''}${dx} px, button held still ${hold} ms`);
  console.log('  elapsed   rawDt   inYaw   lookYaw');
  let peak = 0;
  for (const [e, d, i, y] of t) {
    if (Math.abs(y) > Math.abs(peak)) peak = y;
  }
  // print every frame up to 40, then every 3rd
  t.forEach(([e, d, i, y], k) => {
    if (k < 40 || k % 3 === 0) {
      console.log(
        `  ${String(e).padStart(8)} ${String(d).padStart(7)} ${String(i).padStart(7)} ${String(y).padStart(9)}`,
      );
    }
  });
  const last = t.length ? t[t.length - 1][3] : 0;
  const inTotal = t.reduce((s, r) => s + r[2], 0);
  console.log(
    `  frames ${t.length}  input total ${inTotal.toFixed(3)} rad  peak lookYaw ${peak.toFixed(3)}  final ${last.toFixed(3)}  ` +
      `decay from peak ${(100 * (1 - Math.abs(last) / Math.max(1e-6, Math.abs(peak)))).toFixed(1)}%`,
  );
}

for (const m of (process.env.TRACE_MODES || 'chase,helm').split(',')) {
  await run(m, DRAG, Number(process.env.TRACE_HOLD || 0));
}

await browser.close();
if (pageErrors.length) {
  console.error(`\n${pageErrors.length} page error(s):`);
  for (const e of pageErrors.slice(0, 8)) console.error('  ' + e);
}
