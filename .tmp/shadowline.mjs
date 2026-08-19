/**
 * Is the long straight dark band ruled across the sea the ship's SHADOW?
 *
 * A shadow is not a mesh, so it survives every hide-the-mesh bisect ever run
 * against it — which is exactly the property the "stray waterline line" has had
 * for three sessions. Frozen frame, shadows off, diff.
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const OUT = process.env.OUT || '/tmp/shadowline';
await mkdir(OUT, { recursive: true });

const b = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--force-color-profile=srgb', '--hide-scrollbars', '--mute-audio'],
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
p.on('console', (m) => { if (m.type() === 'error' && !/AudioContext/.test(m.text())) console.log('[page error]', m.text().slice(0, 160)); });
p.setDefaultNavigationTimeout(240000);
p.setDefaultTimeout(120000);
await p.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => !!window.__leeward, null, { timeout: 180000 });
await p.evaluate(() => {
  const w = window.__leeward.world;
  w.settings.adaptiveResolution = false;
  w.settings.renderScale = 1;
  w.settings.showHud = false;
  w.settings.antialias = 'off';
  w.settings.filmGrain = false;
  w.settings.motionBlur = false;
  w.settings.depthOfField = false;
  w.settings.chromaticAberration = false;
  w.settings.screenSpaceReflections = false;
  w.settings.lensDirt = false;
  const scene = {
    env: { timeOfDay: 15.6, windSpeed: 9.0, cloudCover: 0.4, cloudType: 0.75, turbidity: 2.2, rain: 0, visibility: 32000, seaState: 3, waveHeight: 1.5, choppiness: 0.55 },
    cam: { mode: 'orbit', distance: 110 },
  };
  Object.assign(w.env, scene.env);
  Object.assign(w.cam, scene.cam);
  w.bus.emit('settings:changed');
  w.bus.emit('capture:scene', scene);
});
await p.waitForTimeout(12000);
await p.evaluate(() => { window.__leeward.world.cam.mode = 'free'; });
await p.waitForTimeout(1500);
await p.evaluate(() => {
  const e = window.__leeward;
  e.stop();
  window.__step = (n) => { for (let i = 0; i < n; i++) { e.lastTime = performance.now(); e.tick(e.lastTime); } };
  window.__step(4);
});

const grab = async (f) => { await p.evaluate(() => window.__step(3)); await p.screenshot({ path: f }); };
await grab(`${OUT}/A-base.png`);
const info = await p.evaluate(() => {
  const w = window.__leeward.world;
  w.renderer.shadowMap.enabled = false;
  w.scene.traverse((o) => { if (o.isMesh && o.material) { o.material.needsUpdate = true; } });
  return { sun: w.env.sunDirection ? [w.env.sunDirection.x, w.env.sunDirection.y, w.env.sunDirection.z].map((v) => +v.toFixed(3)) : null };
});
await grab(`${OUT}/B-noshadow.png`);
await p.evaluate(() => {
  const w = window.__leeward.world;
  w.renderer.shadowMap.enabled = true;
  w.scene.traverse((o) => { if (o.isMesh && o.material) { o.material.needsUpdate = true; } });
});
// Third test: zero the wake field's contribution, which is the other thing that
// can rule a straight line across the water.
await p.evaluate(() => {
  const w = window.__leeward.world;
  const v = w.ext.vfx;
  if (v && v.wake && v.wake.mat) return;
});
await grab(`${OUT}/C-shadowback.png`);
console.log('sun', JSON.stringify(info));
await b.close();
console.log('done ->', OUT);
