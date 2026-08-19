#!/usr/bin/env node
/**
 * TEMPORAL band probe.
 *
 * Freezes the camera, drives the engine one frame at a time with a synthetic
 * fixed dt, reads the back buffer after every tick and reports, per screen row:
 *   - mean luminance (static profile, finds static bands)
 *   - mean |frame-to-frame delta| (temporal profile, finds FLICKER)
 * plus a laplacian of each so a band shows up as a spike rather than a slope.
 *
 * Usage: node .tmp/bandprobe.mjs [scene] [mode] [frames]
 *   mode: live | frozenwaves | frozenall
 */
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';

const scene = process.argv[2] ?? 'noon';
const mode = process.argv[3] ?? 'live';
const FRAMES = Number(process.argv[4] ?? 12);

const SCENES = {
  noon: { timeOfDay: 12.7, windSpeed: 10.5, cloudCover: 0.38, cloudType: 0.8, turbidity: 2.0, rain: 0, visibility: 34000, seaState: 4, waveHeight: 2.0, choppiness: 0.6 },
  golden: { timeOfDay: 18.6, windSpeed: 7.0, cloudCover: 0.5, cloudType: 0.75, turbidity: 3.6, rain: 0, visibility: 26000, seaState: 3, waveHeight: 1.5, choppiness: 0.5 },
  storm: { timeOfDay: 15.0, windSpeed: 22.0, cloudCover: 0.98, cloudType: 0.95, turbidity: 6.0, rain: 0.85, visibility: 5200, seaState: 7, waveHeight: 6.5, choppiness: 0.85 },
  waterline: { timeOfDay: 13.8, windSpeed: 12.0, cloudCover: 0.35, cloudType: 0.8, turbidity: 2.0, rain: 0, visibility: 34000, seaState: 5, waveHeight: 3.0, choppiness: 0.7 },
};
const CAMS = {
  noon: { mode: 'chase', distance: 74 },
  golden: { mode: 'chase', distance: 80 },
  storm: { mode: 'chase', distance: 70 },
  waterline: { mode: 'cinematic' },
};

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader',
    '--force-color-profile=srgb', '--hide-scrollbars', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await page.addInitScript(() => {
  const Real = window.WebSocket;
  class Dead { constructor() { this.readyState = 3; this.close = () => {}; this.send = () => {}; this.addEventListener = () => {}; this.removeEventListener = () => {}; } }
  window.WebSocket = function (u, p) { return p === 'vite-hmr' ? new Dead() : new Real(u, p); };
  window.WebSocket.prototype = Real.prototype;
});
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => !!window.__leeward, null, { timeout: 90000 });

await page.evaluate(({ env, cam }) => {
  const w = window.__leeward.world;
  w.settings.quality = 'ultra';
  w.settings.adaptiveResolution = false;
  w.settings.renderScale = 1;
  w.settings.showHud = false;
  Object.assign(w.env, env);
  Object.assign(w.cam, cam);
  w.bus.emit('settings:changed');
}, { env: SCENES[scene], cam: CAMS[scene] });

await page.waitForTimeout(9000);

const res = await page.evaluate(async ({ FRAMES, mode }) => {
  const eng = window.__leeward;
  const w = eng.world;
  const gl = w.renderer.getContext();

  // Freeze the camera (and optionally more) by stubbing module updates.
  const stub = (names) => {
    for (const m of eng.modules) {
      if (names.includes(m.name)) { m.__u = m.update; m.update = () => {}; }
    }
  };
  const freezeAll = mode === 'frozenall';
  const names = ['camera'];
  if (mode !== 'live') names.push('physics', 'ship', 'vfx', 'weather', 'environment', 'env', 'world', 'audio', 'ui');
  if (freezeAll) names.push('ocean', 'sky');
  stub(names);

  eng.stop();
  const W = w.size.width, H = w.size.height;
  const buf = new Uint8Array(W * H * 4);
  const rowMean = [];        // per frame: Float64Array(H)
  const kept = [];
  const t0 = performance.now();
  // Column ranges that are open sea in a chase shot: left and right thirds.
  const xa = 40, xb = 520, xc = 1120, xd = 1560;
  for (let f = 0; f < FRAMES; f++) {
    eng.lastTime = t0 + f * 16.6667;
    eng.tick(t0 + (f + 1) * 16.6667);
    w.renderer.setRenderTarget(null);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    const rm = new Float64Array(H);
    for (let y = 0; y < H; y++) {
      let s = 0, n = 0;
      const base = y * W * 4;
      for (let x = xa; x < xb; x++) { const o = base + x * 4; s += 0.2126 * buf[o] + 0.7152 * buf[o + 1] + 0.0722 * buf[o + 2]; n++; }
      for (let x = xc; x < xd; x++) { const o = base + x * 4; s += 0.2126 * buf[o] + 0.7152 * buf[o + 1] + 0.0722 * buf[o + 2]; n++; }
      rm[y] = s / n;
    }
    rowMean.push(Array.from(rm));
    kept.push(new Uint8Array(buf));   // gl rows are bottom-up
  }

  // Temporal: mean |delta| per row, and max over frames.
  const dRow = new Float64Array(H);
  const dRowMax = new Float64Array(H);
  const pxDelta = new Float64Array(H);   // per-pixel |delta| averaged over row
  for (let f = 1; f < FRAMES; f++) {
    const a = kept[f - 1], b = kept[f];
    for (let y = 0; y < H; y++) {
      const d = Math.abs(rowMean[f][y] - rowMean[f - 1][y]);
      dRow[y] += d / (FRAMES - 1);
      if (d > dRowMax[y]) dRowMax[y] = d;
      let s = 0, n = 0;
      const base = y * W * 4;
      for (let x = xa; x < xd; x += 3) {
        const o = base + x * 4;
        s += Math.abs((0.2126 * a[o] + 0.7152 * a[o + 1] + 0.0722 * a[o + 2]) -
                      (0.2126 * b[o] + 0.7152 * b[o + 1] + 0.0722 * b[o + 2]));
        n++;
      }
      pxDelta[y] += s / n / (FRAMES - 1);
    }
  }

  // Amplified diff image of the two most-different consecutive frames.
  let worst = 1, worstV = -1;
  for (let f = 1; f < FRAMES; f++) {
    let s = 0;
    for (let y = 0; y < H; y++) s += Math.abs(rowMean[f][y] - rowMean[f - 1][y]);
    if (s > worstV) { worstV = s; worst = f; }
  }
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(W, H);
  const a = kept[worst - 1], b = kept[worst];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const src = ((H - 1 - y) * W + x) * 4;   // flip to top-down
      const dst = (y * W + x) * 4;
      for (let k = 0; k < 3; k++) img.data[dst + k] = Math.min(255, Math.abs(a[src + k] - b[src + k]) * 12);
      img.data[dst + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const diffPng = c.toDataURL('image/png');

  // Mean frame, for the static profile picture.
  const meanRow = new Float64Array(H);
  for (let y = 0; y < H; y++) { let s = 0; for (let f = 0; f < FRAMES; f++) s += rowMean[f][y]; meanRow[y] = s / FRAMES; }

  eng.start();
  for (const m of eng.modules) if (m.__u) { m.update = m.__u; delete m.__u; }

  const oc = w.ext.ocean;
  return {
    W, H, worst,
    // rows are bottom-up from readPixels; convert to top-down screen rows
    meanRow: Array.from(meanRow).reverse(),
    dRow: Array.from(dRow).reverse(),
    dRowMax: Array.from(dRowMax).reverse(),
    pxDelta: Array.from(pxDelta).reverse(),
    diffPng,
    info: {
      camY: +w.camera.position.y.toFixed(2),
      pitch: +Math.asin(-w.camera.matrixWorld.elements[9]).toFixed(4),
      fov: w.camera.fov,
      hs: +oc.waveHeight.toFixed(3),
      slopeRms: +oc.slopeRms.toFixed(4),
      cascadeSizes: oc.cascadeSizes,
      renderScale: w.settings.renderScale,
      sizeH: w.size.height,
    },
  };
}, { FRAMES, mode });

const { H, meanRow, dRow, dRowMax, pxDelta, info } = res;
console.log(`scene=${scene} mode=${mode} frames=${FRAMES}`, JSON.stringify(info));
if (errs.length) console.log('ERRORS:', errs.slice(0, 5));

// second derivative of the static row profile — a hard band is a spike
function lap(a) {
  const o = new Float64Array(a.length);
  for (let i = 2; i < a.length - 2; i++) o[i] = a[i - 2] + a[i + 2] - 2 * a[i];
  return o;
}
const L = lap(meanRow);
// rank rows by temporal delta of the ROW MEAN (a whole row moving together)
const rows = [];
for (let y = 0; y < H; y++) rows.push({ y, mean: meanRow[y], d: dRow[y], dmax: dRowMax[y], px: pxDelta[y], lap: L[y] });
const sorted = [...rows].sort((a, b) => b.d - a.d).slice(0, 24).sort((a, b) => a.y - b.y);
console.log('\nTop 24 rows by |row-mean frame-to-frame delta|  (row-coherent flicker):');
console.log('  row   meanL    dRow   dMax   pxDelta   lap');
for (const r of sorted) {
  console.log(`  ${String(r.y).padStart(4)}  ${r.mean.toFixed(2).padStart(6)}  ${r.d.toFixed(3).padStart(6)}  ${r.dmax.toFixed(3).padStart(6)}  ${r.px.toFixed(3).padStart(7)}  ${r.lap.toFixed(2).padStart(7)}`);
}
const lapSorted = [...rows].sort((a, b) => Math.abs(b.lap) - Math.abs(a.lap)).slice(0, 20).sort((a, b) => a.y - b.y);
console.log('\nTop 20 rows by |laplacian of static row profile| (hard static bands):');
for (const r of lapSorted) console.log(`  ${String(r.y).padStart(4)}  meanL ${r.mean.toFixed(2).padStart(6)}  lap ${r.lap.toFixed(2).padStart(7)}  dRow ${r.d.toFixed(3)}`);

// coarse profile so the shape is visible in the log
console.log('\nRow profile every 10 rows: row | meanL | dRow(x100) | pxDelta(x100)');
let out = '';
for (let y = 0; y < H; y += 10) {
  out += `${String(y).padStart(4)} ${meanRow[y].toFixed(1).padStart(6)} ${(dRow[y] * 100).toFixed(1).padStart(6)} ${(pxDelta[y] * 100).toFixed(0).padStart(6)}   `;
  if ((y / 10) % 4 === 3) { console.log(out); out = ''; }
}
if (out) console.log(out);

await writeFile(`/tmp/band-${scene}-${mode}-diff.png`, Buffer.from(res.diffPng.split(',')[1], 'base64'));
console.log(`\nwrote /tmp/band-${scene}-${mode}-diff.png (|delta| x12, frames ${res.worst - 1}->${res.worst})`);
await browser.close();
