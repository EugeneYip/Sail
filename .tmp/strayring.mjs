/**
 * Decisive owner test for the stray waterline line. Camera is pinned (no orbit
 * drift) at the framing that shows the line, the ship is hidden throughout, and
 * the ocean's clipmap rings are toggled one at a time.
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const OUT = process.env.STRAY_OUT || '/tmp/strayring';
await mkdir(OUT, { recursive: true });

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
await p.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => !!window.__leeward, null, { timeout: 60000 });

await p.evaluate(() => {
  const w = window.__leeward.world;
  w.settings.adaptiveResolution = false;
  w.settings.renderScale = 1;
  w.settings.showHud = false;
  Object.assign(w.env, { timeOfDay: 15.6, windSpeed: 9.0, cloudCover: 0.4, cloudType: 0.75, turbidity: 2.2, rain: 0, visibility: 32000, seaState: 3, waveHeight: 1.5, choppiness: 0.55 });
  Object.assign(w.cam, { mode: 'orbit', distance: 110 });
  w.bus.emit('settings:changed');
});
await p.waitForTimeout(9000);

// Freeze the camera so every frame is comparable, and hide the whole ship.
await p.evaluate(() => {
  const w = window.__leeward.world;
  let i = 0;
  w.scene.traverse((o) => {
    if (o.isMesh || o.isLine || o.isPoints) {
      o.userData.__sid = i++;
      if (/^ship-|^vfx-/.test(o.name)) o.visible = false;
    }
  });
  // Pin the chase camera by freezing its orbit rate.
  if (w.cam) { w.cam.orbitSpeed = 0; w.cam.autoOrbit = false; }
});
await p.waitForTimeout(1500);

const shot = async (tag) => {
  await p.waitForTimeout(900);
  await p.screenshot({ path: `${OUT}/${tag}.png`, animations: 'allow', clip: { x: 0, y: 470, width: 1600, height: 300 } });
  console.log('wrote', tag);
};

const vis = (sid, v) => p.evaluate(({ sid, v }) => {
  const w = window.__leeward.world;
  let hit = null;
  w.scene.traverse((o) => {
    if ((o.isMesh || o.isLine || o.isPoints) && o.userData.__sid === sid) {
      o.visible = v;
      hit = `${o.name || '(anon)'} tris=${o.geometry.index ? o.geometry.index.count / 3 : 0}`;
    }
  });
  return hit;
}, { sid, v });

await shot('A-ship-hidden-all-ocean');

for (let sid = 13; sid <= 23; sid++) {
  const who = await vis(sid, false);
  await shot(`B-also-without-sid${sid}`);
  console.log(`  sid ${sid} = ${who} (left hidden)`);
}
await shot('C-all-ocean-rings-hidden');

await b.close();
