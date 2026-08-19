#!/usr/bin/env node
/**
 * Close-range material inspection for the ship.
 *
 * The defect (DIAGNOSIS 17 D) is invisible at full-frame scale, so this forces a
 * very narrow FOV. Texture LOD is chosen from screen-space UV derivatives, so a
 * 3-degree lens at 110 m puts exactly as many texels per pixel on the hull as a
 * 60-degree lens at 5 m — i.e. it is a true "walk up to it" test, not a crop of
 * a distant frame. fov is pinned with a property override because the camera rig
 * rewrites it every frame.
 *
 *   node .tmp/shipzoom.mjs [outDir]
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import process from 'node:process';

const OUT = process.argv[2] || 'shots/shipzoom';
await mkdir(OUT, { recursive: true });

const BASE_ENV = {
  timeOfDay: 15.6, windSpeed: 9.0, cloudCover: 0.4, cloudType: 0.75,
  turbidity: 2.2, rain: 0, visibility: 32000, seaState: 3, waveHeight: 1.5,
  choppiness: 0.55,
};

/** fov: null keeps the rig's own lens. */
const SHOTS = {
  // Full-frame references.
  orbit:      { cam: { mode: 'orbit', distance: 110 }, fov: null },
  helm:       { cam: { mode: 'helm' }, fov: null, env: { timeOfDay: 10.4 } },
  // Magnified: hull topsides + wale + copper, then the deck, then canvas.
  hull_x8:    { cam: { mode: 'orbit', distance: 110 }, fov: 7.5 },
  hull_x20:   { cam: { mode: 'orbit', distance: 110 }, fov: 3.0 },
  deck_x6:    { cam: { mode: 'helm' }, fov: 10, env: { timeOfDay: 10.4 } },
  deck_x14:   { cam: { mode: 'helm' }, fov: 4.2, env: { timeOfDay: 10.4 } },
  sail_x6:    { cam: { mode: 'masthead' }, fov: 10, env: { timeOfDay: 11.4 } },
  sail_x14:   { cam: { mode: 'masthead' }, fov: 4.2, env: { timeOfDay: 11.4 } },
  bow_x6:     { cam: { mode: 'bowsprit' }, fov: 10 },
  rope_x10:   { cam: { mode: 'masthead' }, fov: 6, env: { timeOfDay: 11.4 } },
};

const want = (process.env.SHOTS ?? Object.keys(SHOTS).join(',')).split(',');

const b = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--hide-scrollbars', '--mute-audio', '--force-color-profile=srgb'],
});
const p = await b.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
await p.addInitScript(() => {
  const R = window.WebSocket;
  class D extends EventTarget { constructor() { super(); this.readyState = 3; } send() {} close() {} }
  window.WebSocket = function (u, pr) { return pr === 'vite-hmr' ? new D() : new R(u, pr); };
});
const errs = [];
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 300)); });
p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 300)));
await p.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded', timeout: 300000 });
await p.waitForFunction(() => !!window.__leeward, null, { timeout: 300000 });

for (const name of want) {
  const s = SHOTS[name];
  if (!s) continue;
  await p.evaluate((sc) => {
    const w = window.__leeward.world;
    Object.assign(w.settings, { quality: 'ultra', adaptiveResolution: false, renderScale: 1, showHud: false });
    Object.assign(w.env, sc.env);
    Object.assign(w.cam, sc.cam);
    const cam = w.camera;
    // Undo any previous pin, then pin this one.
    if (cam.__pinned) { delete cam.fov; cam.__pinned = false; }
    if (sc.fov) {
      Object.defineProperty(cam, 'fov', { get: () => sc.fov, set: () => {}, configurable: true });
      cam.__pinned = true;
    }
    cam.updateProjectionMatrix();
    w.bus.emit('settings:changed');
  }, { ...s, env: { ...BASE_ENV, ...(s.env ?? {}) } });
  await p.waitForTimeout(9000);
  const stats = await p.evaluate(() => {
    const w = window.__leeward.world;
    return {
      dc: w.stats.drawCalls ?? 0,
      fov: +w.camera.fov.toFixed(2),
      buildMs: +(w.stats['ship:buildMs'] ?? 0).toFixed(1),
      tris: Math.round(w.stats['ship:tris'] ?? 0),
    };
  });
  await p.screenshot({ path: `${OUT}/${name}.png`, timeout: 240000, animations: 'allow' });
  console.log(`${name.padEnd(10)} fov=${String(stats.fov).padStart(5)}  dc=${stats.dc}  shipTris=${stats.tris}  buildMs=${stats.buildMs}`);
}

if (errs.length) {
  console.log(`\n${errs.length} console error(s):`);
  for (const e of errs.slice(0, 12)) console.log('  ' + e);
}
await b.close();
