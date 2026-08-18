/**
 * Isolate DIAGNOSIS section 8 defect 5: the dark line across the water.
 * Toggles each candidate off and crops a band around the waterline.
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const OUT = process.env.STRAY_OUT || '/tmp/stray';
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

const inventory = await p.evaluate(() => {
  const w = window.__leeward.world;
  const names = [];
  w.scene.traverse((o) => { if (o.isMesh || o.isLine || o.isPoints || o.isLineSegments) names.push(`${o.type}:${o.name || '(anon)'}`); });
  return names;
});
console.log('scene draw objects:\n' + inventory.join('\n'));

async function shot(tag) {
  await p.waitForTimeout(1400);
  await p.screenshot({ path: `${OUT}/${tag}-full.png`, animations: 'allow' });
  await p.screenshot({ path: `${OUT}/${tag}-band.png`, animations: 'allow', clip: { x: 0, y: 520, width: 1600, height: 260 } });
  console.log('wrote', tag);
}

const setVis = (matcher, v) => p.evaluate(({ matcher, v }) => {
  const w = window.__leeward.world;
  let n = 0;
  w.scene.traverse((o) => {
    if (!(o.isMesh || o.isLine || o.isPoints)) return;
    if (new RegExp(matcher).test(o.name)) { o.visible = v; n++; }
  });
  return n;
}, { matcher, v });

await shot('0-baseline');

console.log('hid ship-*:', await setVis('^ship-', false));
await shot('1-no-ship');
await setVis('^ship-', true);

console.log('hid vfx-*:', await setVis('^vfx-', false));
await shot('2-no-vfx');
await setVis('^vfx-', true);

console.log('hid ship-rigging:', await setVis('^ship-rigging$', false));
await shot('3-no-rigging');
await setVis('^ship-rigging$', true);

console.log('hid ocean:', await setVis('ocean|clipmap|water', false));
await shot('4-no-ocean');

await b.close();
