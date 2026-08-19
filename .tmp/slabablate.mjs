/**
 * Attribute the phantom slab (DIAGNOSIS 17A) by ablation, not by reasoning.
 *
 * Renders the `orbit` scene, then hides one drawable at a time and measures how
 * much of the slab region changes. The slab is a bright, low-saturation, hard
 * edged region over water, so "slab pixels" are scored as (luma high AND
 * saturation low) inside the crop; the object whose removal collapses that count
 * owns it. Writes a PNG per ablation so the result can also be eyeballed.
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const OUT = process.env.OUT || 'shots/ablate';
const CLIP = (process.env.CLIP || '260,700,900,200').split(',').map(Number);
await mkdir(OUT, { recursive: true });

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
await p.evaluate(() => {
  const w = window.__leeward.world;
  w.settings.adaptiveResolution = false;
  w.settings.renderScale = 1;
  w.settings.showHud = false;
  Object.assign(w.env, { timeOfDay: 15.6, windSpeed: 9.0, cloudCover: 0.4, cloudType: 0.75, turbidity: 2.2, rain: 0, visibility: 32000, seaState: 3, waveHeight: 1.5, choppiness: 0.55 });
  Object.assign(w.cam, { mode: 'orbit', distance: 110 });
  w.bus.emit('settings:changed');
});
await p.waitForTimeout(12000);

const names = await p.evaluate(() => {
  const w = window.__leeward.world;
  const out = [];
  let i = 0;
  w.scene.traverse((o) => {
    if (!(o.isMesh || o.isLine || o.isPoints)) return;
    o.userData.__sid = i;
    if (o.visible) out.push({ sid: i, name: o.name || '(anon)', parent: o.parent?.name || o.parent?.type || '' });
    i++;
  });
  return out;
});

const setVis = (sid, v) => p.evaluate(({ sid, v }) => {
  const w = window.__leeward.world;
  let hit = 0;
  w.scene.traverse((o) => { if (o.userData.__sid === sid) { o.visible = v; hit++; } });
  return hit;
}, { sid, v });

async function score(tag) {
  await p.waitForTimeout(900);
  const [x, y, width, height] = CLIP;
  const buf = await p.screenshot({ animations: 'allow', clip: { x, y, width, height }, path: `${OUT}/${tag}.png` });
  const url = `data:image/png;base64,${buf.toString('base64')}`;
  return p.evaluate(async (url) => {
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const cx = c.getContext('2d', { willReadFrequently: true });
    cx.drawImage(img, 0, 0);
    const d = cx.getImageData(0, 0, c.width, c.height).data;
    let pale = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], bb = d[i + 2];
      const mx = Math.max(r, g, bb), mn = Math.min(r, g, bb);
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * bb;
      // The slab is bright and near-neutral; sea is bright-ish but strongly blue.
      if (lum > 150 && (mx - mn) < 42) pale++;
    }
    return pale / (c.width * c.height);
  }, url);
}

const base = await score('00-baseline');
console.log(`baseline pale fraction = ${base.toFixed(4)}  clip=${CLIP.join(',')}`);
const rows = [];
for (const n of names) {
  const hit = await setVis(n.sid, false);
  if (!hit) continue;
  const s = await score(`sid${String(n.sid).padStart(2, '0')}-${n.name.replace(/[^\w-]/g, '')}`);
  rows.push({ ...n, s, drop: base - s });
  await setVis(n.sid, true);
}
rows.sort((a, b2) => b2.drop - a.drop);
console.log('\ndrop  pale   sid  name                  parent');
for (const r of rows) {
  console.log(`${r.drop >= 0 ? '+' : '-'}${Math.abs(r.drop).toFixed(4)} ${r.s.toFixed(4)} ${String(r.sid).padStart(4)}  ${r.name.padEnd(20)} ${r.parent}`);
}
await b.close();
