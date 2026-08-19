/**
 * Positive identification of the phantom slab (DIAGNOSIS 17A).
 *
 * The differential test is defeated by the orbiting camera, so isolate instead:
 * render the same frame (a) normally, (b) with every drawable hidden except one
 * candidate, so the candidate's silhouette can be matched against the slab. Also
 * writes (c) with just the candidate hidden.
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const OUT = process.env.OUT || 'shots/iso';
await mkdir(OUT, { recursive: true });
const CAND = (process.env.CAND || 'vfx-bow-wave,vfx-hull-skirt,vfx-particles').split(',');

const b = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--force-color-profile=srgb', '--hide-scrollbars', '--mute-audio'],
});
const p = await b.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1, colorScheme: 'dark' });
p.setDefaultTimeout(240000);
p.setDefaultNavigationTimeout(240000);
await p.addInitScript(() => {
  const R = window.WebSocket;
  window.WebSocket = function (u, pr) {
    if (pr === 'vite-hmr') return { readyState: 3, close() {}, send() {}, addEventListener() {}, removeEventListener() {} };
    return new R(u, pr);
  };
  window.WebSocket.prototype = R.prototype;
});
await p.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => !!window.__leeward, null, { timeout: 240000 });
await p.evaluate(({ camMode, camDist }) => {
  const w = window.__leeward.world;
  w.settings.adaptiveResolution = false;
  w.settings.renderScale = 1;
  w.settings.showHud = false;
  const scene = {
    env: { timeOfDay: 15.6, windSpeed: 9.0, cloudCover: 0.4, cloudType: 0.75, turbidity: 2.2, rain: 0, visibility: 32000, seaState: 3, waveHeight: 1.5, choppiness: 0.55 },
    cam: { mode: camMode, distance: camDist },
  };
  Object.assign(w.env, scene.env);
  Object.assign(w.cam, scene.cam);
  w.bus.emit('settings:changed');
  w.bus.emit('capture:scene', scene);
});
await p.waitForTimeout(12000);

// Freeze the orbit so the A/B frames share a camera.
await p.evaluate(() => {
  const w = window.__leeward.world;
  w.__frozen = { ...w.cam };
  const rig = w.ext.camera;
  if (rig) w.__rig = rig;
});

const apply = (mode, cand) => p.evaluate(({ mode, cand }) => {
  const w = window.__leeward.world;
  const seen = [];
  w.scene.traverse((o) => {
    if (!(o.isMesh || o.isLine || o.isPoints)) return;
    if (o.userData.__origVis === undefined) o.userData.__origVis = o.visible;
    const isCand = o.name === cand;
    const isSky = o.name === 'sky';
    if (mode === 'all') o.visible = o.userData.__origVis;
    else if (mode === 'only') o.visible = isCand || isSky ? o.userData.__origVis : false;
    else if (mode === 'without') o.visible = isCand ? false : o.userData.__origVis;
    if (isCand) seen.push({ name: o.name, visible: o.visible });
  });
  return seen;
}, { mode, cand });

for (const cand of CAND) {
  await apply('all', cand);
  await p.waitForTimeout(700);
  await p.screenshot({ path: `${OUT}/${cand}-A-all.png`, animations: 'allow' });
  const s = await apply('only', cand);
  await p.waitForTimeout(700);
  await p.screenshot({ path: `${OUT}/${cand}-B-only.png`, animations: 'allow' });
  await apply('without', cand);
  await p.waitForTimeout(700);
  await p.screenshot({ path: `${OUT}/${cand}-C-without.png`, animations: 'allow' });
  console.log(`${cand}: ${JSON.stringify(s)}`);
}
await apply('all', '');
await b.close();
console.log('done ->', OUT);
