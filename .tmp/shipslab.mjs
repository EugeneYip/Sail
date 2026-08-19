#!/usr/bin/env node
/**
 * Attribute the "bracket" slab off the starboard bow (DIAGNOSIS 17 defect A) by
 * TOGGLING VISIBILITY, not by reasoning. Bounding boxes cannot find it: every
 * candidate (ocean clipmap, bow wave, hull skirt, the sails) is displaced in the
 * vertex shader, so its CPU-side AABB is a flat unit quad.
 *
 * Method: screenshot the region with everything on, then with one group hidden
 * at a time, and report the fraction of region pixels that changed. Whichever
 * toggle makes the slab vanish owns it.
 *
 *   node .tmp/shipslab.mjs
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import process from 'node:process';

const OUT = process.argv[2] || 'shots/shipslab';
await mkdir(OUT, { recursive: true });

/** The crop DIAGNOSIS 17 used to confirm the defect. */
const CLIP = { x: 700, y: 430, width: 560, height: 380 };

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
await p.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded', timeout: 300000 });
await p.waitForFunction(() => !!window.__leeward, null, { timeout: 300000 });

// A deterministic, still frame: no wind sway, no waves moving under the slab.
await p.evaluate(() => {
  const w = window.__leeward.world;
  Object.assign(w.settings, { quality: 'ultra', adaptiveResolution: false, renderScale: 1, showHud: false, taa: false });
  Object.assign(w.env, {
    timeOfDay: 15.6, windSpeed: 9.0, cloudCover: 0.4, cloudType: 0.75, turbidity: 2.2,
    rain: 0, visibility: 32000, seaState: 3, waveHeight: 1.5, choppiness: 0.55,
  });
  Object.assign(w.cam, { mode: 'orbit', distance: 110 });
  w.bus.emit('settings:changed');
  // Index every drawable so a toggle can be addressed by name from node.
  w.scene.traverse((o) => { if (o.isMesh || o.isLine || o.isPoints) o.userData.__wasVisible = o.visible; });
});
await p.waitForTimeout(11000);

const names = await p.evaluate(() => {
  const w = window.__leeward.world;
  const out = [];
  w.scene.traverse((o) => {
    if (!(o.isMesh || o.isLine || o.isPoints)) return;
    if (!o.visible) return;
    out.push(o.name || `(anon:${o.uuid.slice(0, 6)})`);
    o.userData.__key = out[out.length - 1];
  });
  return out;
});
console.log('visible drawables:', names.join(', '));

const setHidden = (keys) => p.evaluate((ks) => {
  const w = window.__leeward.world;
  w.scene.traverse((o) => {
    if (!(o.isMesh || o.isLine || o.isPoints)) return;
    if (o.userData.__wasVisible === undefined) return;
    const k = o.userData.__key;
    o.visible = o.userData.__wasVisible && !(k && ks.includes(k));
  });
}, keys);

const shots = [];
async function shot(label, keys) {
  await setHidden(keys);
  await p.waitForTimeout(2200);
  const buf = await p.screenshot({ clip: CLIP, timeout: 240000, animations: 'allow' });
  await writeFile(`${OUT}/${label}.png`, buf);
  shots.push({ label, b64: buf.toString('base64') });
  console.log('shot', label, keys.length ? `(hidden: ${keys.join(',')})` : '(baseline)');
}

const shipKeys = names.filter((n) => n.startsWith('ship-'));
const vfxKeys = names.filter((n) => n.startsWith('vfx-'));
const oceanKeys = names.filter((n) => n.startsWith('(anon'));

await shot('00-baseline', []);
await shot('01-no-ship', shipKeys);
await shot('02-no-vfx', vfxKeys);
await shot('03-no-ocean', oceanKeys);
for (const k of shipKeys) await shot(`ship--${k}`, [k]);
for (const k of vfxKeys) await shot(`vfx--${k}`, [k]);

// Diff every shot against the baseline inside a scratch page.
const diffs = await p.evaluate(async (list) => {
  const load = (b64) => new Promise((res) => {
    const i = new Image();
    i.onload = () => res(i);
    i.src = `data:image/png;base64,${b64}`;
  });
  const imgs = [];
  for (const s of list) imgs.push({ label: s.label, img: await load(s.b64) });
  const c = document.createElement('canvas');
  c.width = imgs[0].img.naturalWidth;
  c.height = imgs[0].img.naturalHeight;
  const g = c.getContext('2d', { willReadFrequently: true });
  const data = imgs.map(({ label, img }) => {
    g.clearRect(0, 0, c.width, c.height);
    g.drawImage(img, 0, 0);
    return { label, px: g.getImageData(0, 0, c.width, c.height).data };
  });
  const base = data[0].px;
  return data.slice(1).map(({ label, px }) => {
    let changed = 0;
    let sum = 0;
    for (let i = 0; i < base.length; i += 4) {
      const d = Math.abs(px[i] - base[i]) + Math.abs(px[i + 1] - base[i + 1]) + Math.abs(px[i + 2] - base[i + 2]);
      sum += d;
      if (d > 18) changed++;
    }
    const n = base.length / 4;
    return { label, changedPct: +(100 * changed / n).toFixed(2), meanDelta: +(sum / n / 3).toFixed(2) };
  });
}, shots);

console.log('\n=== region ' + JSON.stringify(CLIP) + ' ===');
console.log('toggle                          changed%   meanDelta');
for (const d of diffs.sort((a, x) => x.changedPct - a.changedPct)) {
  console.log(d.label.padEnd(32), String(d.changedPct).padStart(7), String(d.meanDelta).padStart(10));
}
await b.close();
