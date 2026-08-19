#!/usr/bin/env node
/**
 * Clipmap-ring / mip-band probe, v2.
 *
 * Everything except the ocean sim is frozen; the ocean sim time is RESET to the
 * same value before every variant, so each variant renders the same wave phase
 * from the same camera. Then per screen row:
 *   band  = |L(y) - (L(y-3)+L(y+3))/2|   horizontal-line energy of the row mean
 *   px    = mean per-pixel |frame-to-frame delta|
 * and the predicted clipmap ring rows (48 * 2^k metres) are called out.
 *
 * Also writes a "band map" PNG per variant: the same vertical high-pass, x8,
 * so a horizontal line is visible as a bright row.
 *
 * node .tmp/bands2.mjs <scene> <frames> <variant...>
 */
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';

const scene = process.argv[2] ?? 'noon';
const FRAMES = Number(process.argv[3] ?? 8);
const variants = process.argv.slice(4);
if (!variants.length) variants.push('none');

const SCENES = {
  noon: { env: { timeOfDay: 12.7, windSpeed: 10.5, cloudCover: 0.38, cloudType: 0.8, turbidity: 2.0, rain: 0, visibility: 34000, seaState: 4, waveHeight: 2.0, choppiness: 0.6 }, cam: { mode: 'chase', distance: 74 } },
  golden: { env: { timeOfDay: 18.6, windSpeed: 7.0, cloudCover: 0.5, cloudType: 0.75, turbidity: 3.6, rain: 0, visibility: 26000, seaState: 3, waveHeight: 1.5, choppiness: 0.5 }, cam: { mode: 'chase', distance: 80 } },
  storm: { env: { timeOfDay: 15.0, windSpeed: 22.0, cloudCover: 0.98, cloudType: 0.95, turbidity: 6.0, rain: 0.85, visibility: 5200, seaState: 7, waveHeight: 6.5, choppiness: 0.85 }, cam: { mode: 'chase', distance: 70 } },
  waterline: { env: { timeOfDay: 13.8, windSpeed: 12.0, cloudCover: 0.35, cloudType: 0.8, turbidity: 2.0, rain: 0, visibility: 34000, seaState: 5, waveHeight: 3.0, choppiness: 0.7 }, cam: { mode: 'cinematic' } },
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
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded', timeout: 240000 });
await page.waitForFunction(() => !!window.__leeward, null, { timeout: 300000 });
await page.evaluate((s) => {
  const w = window.__leeward.world;
  w.settings.quality = 'ultra';
  w.settings.adaptiveResolution = false;
  w.settings.renderScale = 1;
  w.settings.showHud = false;
  Object.assign(w.env, s.env);
  Object.assign(w.cam, s.cam);
  w.bus.emit('settings:changed');
}, SCENES[scene]);
await page.waitForTimeout(10000);

await page.evaluate(() => {
  const eng = window.__leeward;
  const w = eng.world;
  const mats = () => {
    const s = new Set();
    w.scene.traverse((o) => { if (o.material && o.material.name === 'ocean-surface') s.add(o.material); });
    return [...s];
  };
  window.__mats = mats;
  window.__orig = { v: mats()[0].vertexShader, f: mats()[0].fragmentShader };

  // Freeze everything but the ocean, permanently, so every variant sees the
  // same camera, the same ship, the same wake and the same sky.
  window.__frozen = [];
  for (const m of eng.modules) {
    if (m.name !== 'ocean') { window.__frozen.push([m, m.update]); m.update = () => {}; }
  }
  window.__ocean = eng.modules.find((m) => m.name === 'ocean');
  eng.stop();

  window.__apply = (kind) => {
    for (const m of window.__mats()) {
      let v = window.__orig.v;
      let f = window.__orig.f;
      if (kind === 'contcell' || kind === 'both') {
        v = v.replace('float effCell = max(cell, 2.0 * cheb / uGridM);',
          'float effCell = isSkirt > 0.5 ? cell : 2.0 * cheb / uGridM;');
      }
      if (kind === 'aniso' || kind === 'both') {
        f = f.replace('float pxWorld = max(dist * uPixelAngle, 1e-3);',
          'float pxWorld = max(dist * uPixelAngle, 1e-3);\n' +
          '  {\n' +
          '    float grz = max(abs(normalize(uCameraPos - P).y), 0.004);\n' +
          '    float cellHere = 2.0 * max(abs(P.x - uCameraPos.x), abs(P.z - uCameraPos.z)) / 128.0;\n' +
          '    pxWorld = max(pxWorld, min(pxWorld / grz, max(cellHere, pxWorld)));\n' +
          '  }');
      }
      m.vertexShader = v;
      m.fragmentShader = f;
      m.needsUpdate = true;
    }
    return kind;
  };

  window.__run = (FRAMES) => {
    const gl = w.renderer.getContext();
    // same wave phase every variant
    window.__ocean.simTime = 400;
    const t0 = performance.now();
    let tk = t0;
    for (let i = 0; i < 25; i++) { eng.lastTime = tk; tk += 16.6667; eng.tick(tk); }
    const W = w.size.width, H = w.size.height;
    const buf = new Uint8Array(W * H * 4);
    const xa = 40, xb = 520, xc = 1120, xd = 1560;
    const cols = [];
    for (let x = xa; x < xb; x += 2) cols.push(x);
    for (let x = xc; x < xd; x += 2) cols.push(x);
    const NC = cols.length;
    const frames = [];
    let bandPng = null;
    for (let f = 0; f < FRAMES; f++) {
      eng.lastTime = tk; tk += 16.6667; eng.tick(tk);
      w.renderer.setRenderTarget(null);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      const lum = new Float32Array(H * NC);
      for (let y = 0; y < H; y++) {
        const base = y * W * 4;
        for (let c = 0; c < NC; c++) {
          const o = base + cols[c] * 4;
          lum[y * NC + c] = 0.2126 * buf[o] + 0.7152 * buf[o + 1] + 0.0722 * buf[o + 2];
        }
      }
      frames.push(lum);
      if (f === 0) {
        const cv = document.createElement('canvas');
        cv.width = W; cv.height = H;
        const ctx = cv.getContext('2d');
        const img = ctx.createImageData(W, H);
        for (let y = 0; y < H; y++) {
          const yy = H - 1 - y;              // top-down
          for (let x = 0; x < W; x++) {
            const c0 = ((yy) * W + x) * 4;
            const cm = ((Math.min(H - 1, yy + 3)) * W + x) * 4;
            const cp = ((Math.max(0, yy - 3)) * W + x) * 4;
            const L = (o) => 0.2126 * buf[o] + 0.7152 * buf[o + 1] + 0.0722 * buf[o + 2];
            const hp = L(c0) - 0.5 * (L(cm) + L(cp));
            const v = Math.min(255, Math.abs(hp) * 14);
            const d = (y * W + x) * 4;
            img.data[d] = img.data[d + 1] = img.data[d + 2] = v;
            img.data[d + 3] = 255;
          }
        }
        ctx.putImageData(img, 0, 0);
        bandPng = cv.toDataURL('image/png');
      }
    }
    // top-down row stats
    const meanL = new Float64Array(H);
    const pxAbsD = new Float64Array(H);
    for (let yy = 0; yy < H; yy++) {
      const y = H - 1 - yy;
      let sM = 0, sD = 0;
      for (let f = 0; f < FRAMES; f++) {
        let s = 0;
        for (let c = 0; c < NC; c++) s += frames[f][y * NC + c];
        sM += s / NC / FRAMES;
      }
      for (let c = 0; c < NC; c++)
        for (let f = 1; f < FRAMES; f++) sD += Math.abs(frames[f][y * NC + c] - frames[f - 1][y * NC + c]);
      meanL[yy] = sM;
      pxAbsD[yy] = sD / NC / (FRAMES - 1);
    }
    const band = new Float64Array(H);
    for (let y = 3; y < H - 3; y++) band[y] = Math.abs(meanL[y] - 0.5 * (meanL[y - 3] + meanL[y + 3]));

    // row -> flat-sea distance, and the clipmap ring rows
    const cam = w.camera;
    const pitchDown = -Math.asin(Math.max(-1, Math.min(1, -cam.matrixWorld.elements[9])));
    const th = Math.tan((cam.fov * Math.PI) / 360);
    const rowOf = (d) => {
      const dep = Math.atan(cam.position.y / d);
      return Math.round(450 + (450 * Math.tan(dep - pitchDown)) / th);
    };
    const rings = [];
    for (let k = 0; k < 10; k++) { const d = 48 * 2 ** k; rings.push([d, rowOf(d)]); }
    const dist = [];
    for (let y = 0; y < H; y++) {
      const dep = pitchDown + Math.atan(((y + 0.5 - H / 2) / (H / 2)) * th);
      dist.push(dep > 1e-5 ? Math.round(Math.min(99999, cam.position.y / Math.tan(dep))) : -1);
    }
    return {
      H, NC, rings, dist,
      camY: +cam.position.y.toFixed(2), pitch: +pitchDown.toFixed(4), fov: cam.fov,
      meanL: Array.from(meanL).map((v) => +v.toFixed(3)),
      band: Array.from(band).map((v) => +v.toFixed(3)),
      pxAbsD: Array.from(pxAbsD).map((v) => +v.toFixed(3)),
      bandPng,
    };
  };
});

const runs = {};
for (const v of variants) {
  await page.evaluate((k) => window.__apply(k), v);
  await page.waitForTimeout(900);
  const r = await page.evaluate((n) => window.__run(n), FRAMES);
  await writeFile(`/tmp/bandmap-${scene}-${v}.png`, Buffer.from(r.bandPng.split(',')[1], 'base64'));
  delete r.bandPng;
  runs[v] = r;
  console.log(`ran ${v}`);
}
if (errs.length) console.log('ERRORS', errs.slice(0, 6));

const ref = runs[variants[0]];
console.log(`\nscene=${scene} camY=${ref.camY} pitchDown=${ref.pitch} fov=${ref.fov} frames=${FRAMES}`);
console.log('predicted clipmap ring rows (metres -> row):', ref.rings.map(([d, r]) => `${d}m@${r}`).join('  '));

console.log('\nband = |rowMean(y) - mean(rowMean(y-3),rowMean(y+3))|   AT the predicted ring rows:');
console.log('  ring       row   ' + variants.map((v) => v.padStart(9)).join(''));
for (const [d, r] of ref.rings) {
  if (r < 340 || r > 899) continue;
  console.log(`  ${String(d).padStart(6)}m ${String(r).padStart(6)}   ` +
    variants.map((v) => {
      let mx = 0;
      for (let y = r - 2; y <= r + 2; y++) mx = Math.max(mx, runs[v].band[y] ?? 0);
      return mx.toFixed(2).padStart(9);
    }).join(''));
}
console.log('  ' + 'MEDIAN row (sea)'.padStart(14) + '   ' + variants.map((v) => {
  const a = runs[v].band.slice(360, 890).filter((x) => x > 0).sort((p, q) => p - q);
  return a[Math.floor(a.length / 2)].toFixed(2).padStart(9);
}).join(''));
console.log('  ' + 'P95 row (sea)'.padStart(14) + '   ' + variants.map((v) => {
  const a = runs[v].band.slice(360, 890).filter((x) => x > 0).sort((p, q) => p - q);
  return a[Math.floor(a.length * 0.95)].toFixed(2).padStart(9);
}).join(''));

console.log('\nper-pixel |frame delta| by distance band:');
const bands = [[356, 392, 'far   >600m'], [392, 440, '600-240m'], [440, 500, '240-130m'], [500, 580, '130-85m'], [580, 700, '85-55m'], [700, 899, '<55m']];
for (const [a, b, label] of bands) {
  console.log('  ' + label.padEnd(12) + variants.map((v) => {
    let s = 0; for (let y = a; y < b; y++) s += runs[v].pxAbsD[y];
    return `${v}=${(s / (b - a)).toFixed(2)}`;
  }).join('  '));
}
console.log('\nmean luminance by distance band:');
for (const [a, b, label] of bands) {
  console.log('  ' + label.padEnd(12) + variants.map((v) => {
    let s = 0; for (let y = a; y < b; y++) s += runs[v].meanL[y];
    return `${v}=${(s / (b - a)).toFixed(1)}`;
  }).join('  '));
}
console.log('\ntop 14 band rows per variant:');
for (const v of variants) {
  const idx = [];
  for (let y = 356; y < 890; y++) idx.push(y);
  idx.sort((a, b) => runs[v].band[b] - runs[v].band[a]);
  console.log(`  ${v.padEnd(9)} ` + idx.slice(0, 14).sort((a, b) => a - b)
    .map((y) => `${y}(${ref.dist[y]}m,${runs[v].band[y].toFixed(1)})`).join(' '));
}
await writeFile(`/tmp/bands2-${scene}.json`, JSON.stringify(runs));
await browser.close();
