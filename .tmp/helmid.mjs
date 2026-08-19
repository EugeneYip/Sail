/**
 * Identify the pile of plank-like slabs that dominates the helm camera, by
 * hiding one ship bin at a time from the same pinned viewpoint.
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const OUT = process.env.HELM_OUT || '/tmp/helmid';
await mkdir(OUT, { recursive: true });

const b = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--force-color-profile=srgb', '--hide-scrollbars'],
});
const p = await b.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 });
await p.addInitScript(() => {
  const R = window.WebSocket;
  window.WebSocket = function (u, pr) {
    if (pr === 'vite-hmr') return { readyState: 3, close() {}, send() {}, addEventListener() {}, removeEventListener() {} };
    return new R(u, pr);
  };
  window.WebSocket.prototype = R.prototype;
});
await p.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded', timeout: 120000 });
await p.waitForFunction(() => !!window.__leeward, null, { timeout: 90000 });

await p.evaluate(() => {
  const w = window.__leeward.world;
  w.settings.adaptiveResolution = false;
  w.settings.renderScale = 1;
  w.settings.showHud = false;
  Object.assign(w.env, { timeOfDay: 10.4, windSpeed: 9, cloudCover: 0.3, turbidity: 2, rain: 0, visibility: 30000, seaState: 3, waveHeight: 1.4 });
  Object.assign(w.cam, { mode: 'helm' });
  w.bus.emit('settings:changed');
});
await p.waitForTimeout(9000);

const shot = async (tag) => {
  await p.waitForTimeout(800);
  await p.screenshot({ path: `${OUT}/${tag}.png`, animations: 'allow' });
  console.log('wrote', tag);
};

const setVis = (name, v) => p.evaluate(({ name, v }) => {
  const w = window.__leeward.world;
  let n = 0;
  w.scene.traverse((o) => { if (o.isMesh && o.name === name) { o.visible = v; n++; } });
  return n;
}, { name, v });

await shot('0-baseline');
for (const fam of ['oak', 'deck', 'iron', 'brass', 'buff', 'black', 'stripe', 'rigging', 'sail-cloth']) {
  const n = await setVis(`ship-${fam}`, false);
  await shot(`1-no-${fam}`);
  console.log(`  hid ship-${fam} (${n})`);
  await setVis(`ship-${fam}`, true);
}

// Report where the wheel and capstan pivots ended up, and the helm camera.
console.log(JSON.stringify(await p.evaluate(() => {
  const w = window.__leeward.world;
  return {
    camera: w.camera.position.toArray().map((v) => +v.toFixed(2)),
    shipPos: w.ship.position.toArray().map((v) => +v.toFixed(2)),
    anchors: w.ext.ship && w.ext.ship.deckAnchors
      ? Object.fromEntries(Object.entries(w.ext.ship.deckAnchors).map(
        ([k, v]) => [k, v && v.toArray ? v.toArray().map((n) => +n.toFixed(2)) : v]))
      : null,
  };
}), null, 1));

await b.close();
