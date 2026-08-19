/**
 * Is the slab the ship's?
 *
 * The per-mesh ablation cannot answer this, because hiding one ocean clipmap
 * ring changes every pixel over water whether the slab is there or not. This
 * hides the WHOLE ship instead — every mesh under the ship root plus the sails
 * and the rigging — in a frozen frame, and captures the same view. If the slab
 * is still there with no ship in the scene at all, it is not the ship's.
 *
 * Groups are hidden by name prefix rather than by traversing the ship root, so
 * a stray mesh that was parented to the scene by mistake is still caught.
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const OUT = process.env.OUT || '/tmp/noship';
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
p.setDefaultNavigationTimeout(240000);
p.setDefaultTimeout(120000);
await p.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => !!window.__leeward, null, { timeout: 120000 });

await p.evaluate(() => {
  const w = window.__leeward.world;
  Object.assign(w.settings, {
    adaptiveResolution: false, renderScale: 1, showHud: false, antialias: 'off',
    filmGrain: false, motionBlur: false, depthOfField: false,
    chromaticAberration: false, screenSpaceReflections: false, lensDirt: false,
  });
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

const grab = async (f) => { await p.evaluate(() => window.__step(3)); await p.screenshot({ path: `${OUT}/${f}.png` }); };
await grab('00-base');

// Every drawable whose name marks it as the ship's, plus anything parented under
// the ship root, plus the vfx meshes so the wake and skirt cannot be mistaken
// for it either.
const hidden = await p.evaluate(() => {
  const out = [];
  window.__leeward.world.scene.traverse((o) => {
    if (!(o.isMesh || o.isLine || o.isPoints)) return;
    let anc = o, ship = false;
    while (anc) { if (/^ship/.test(anc.name || '')) { ship = true; break; } anc = anc.parent; }
    if (ship || /^vfx/.test(o.name || '')) {
      o.userData.__om = o.layers.mask; o.layers.mask = 0;
      out.push(o.name || `(anon under ${o.parent && o.parent.name})`);
    }
  });
  return out;
});
console.log(`hidden ${hidden.length}:`, hidden.join(', '));
await grab('01-noship');

// And now with the ocean gone as well, to prove which of the two owns it.
const oc = await p.evaluate(() => {
  const out = [];
  window.__leeward.world.scene.traverse((o) => {
    if (!(o.isMesh || o.isLine || o.isPoints)) return;
    if (/ocean/.test(o.name || '') || /ocean/.test((o.material && o.material.name) || '')) {
      o.userData.__om2 = o.layers.mask; o.layers.mask = 0; out.push(o.name || o.material.name);
    }
  });
  return out;
});
console.log(`ocean hidden ${oc.length}`);
await grab('02-noship-noocean');
await b.close();
console.log('done ->', OUT);
