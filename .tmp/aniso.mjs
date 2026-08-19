#!/usr/bin/env node
/**
 * A/B temporal probe for the flickering horizontal bands.
 *
 * Freezes the camera, drives N fixed-dt frames, reads the back buffer each frame
 * and reports, per screen row:
 *   px      mean per-pixel |frame-to-frame delta|      (how much it boils)
 *   coh     sqrt(Ncols) * std_f(rowMean) / mean_x std_f(px)   (1 = incoherent
 *           per-pixel noise, >>1 = the WHOLE ROW moves together = a band)
 *   dist    ground distance of that row, metres
 *
 * Then re-runs the same measurement with a runtime patch applied to the ocean
 * fragment shader, so the A/B is one process, one camera, one wave phase.
 *
 * node .tmp/aniso.mjs <scene> <frames> <patch...>
 *   patch: none | aniso | aniso05 | lod0 | nofoam | noenv | flatN
 */
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';

const scene = process.argv[2] ?? 'noon';
const FRAMES = Number(process.argv[3] ?? 10);
const patches = process.argv.slice(4);
if (!patches.length) patches.push('none');

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
await page.waitForTimeout(9000);

// Install the measurement harness + patcher in the page.
await page.evaluate(() => {
  const eng = window.__leeward;
  const w = eng.world;

  window.__oceanMats = () => {
    const out = new Set();
    w.scene.traverse((o) => {
      const m = o.material;
      if (m && m.name === 'ocean-surface') out.add(m);
    });
    return [...out];
  };
  window.__origFrag = window.__oceanMats()[0].fragmentShader;

  window.__patch = (kind) => {
    const mats = window.__oceanMats();
    for (const m of mats) {
      let f = window.__origFrag;
      if (kind === 'aniso' || kind === 'aniso05' || kind === 'aniso075') {
        const k = kind === 'aniso' ? '1.0' : kind === 'aniso075' ? '0.75' : '0.5';
        f = f.replace(
          'float pxWorld = max(dist * uPixelAngle, 1e-3);',
          'float pxWorld = max(dist * uPixelAngle, 1e-3);\n' +
          '  float grz = max(abs(normalize(uCameraPos - P).y), 0.008);\n' +
          `  pxWorld = pxWorld * pow(1.0 / grz, ${k});`,
        );
      } else if (kind === 'lod0') {
        f = f.replace(/float lod = max\(0\.0, log2\(pxWorld \* uCascadeTexels\[\d\]\)\);/g, 'float lod = 0.0;');
      } else if (kind === 'lodmax') {
        f = f.replace(/float lod = max\(0\.0, log2\(pxWorld \* uCascadeTexels\[(\d)\]\)\);/g,
          'float lod = 12.0;');
      } else if (kind === 'nofoam') {
        f = f.replace('float foam = max(instant, persistent * inWindow);', 'float foam = 0.0;');
      } else if (kind === 'noripple') {
        f = f.replace('if (uWetness > 0.01) slope += rainRipple(vAbs, uWetness).xz;', '');
      } else if (kind === 'nospec') {
        f = f.replace('col += sunSpec * (1.0 - foam * 0.55);', '');
      } else if (kind === 'norefl') {
        f = f.replace('col = mix(col, reflection * (0.5 + 0.5 * trough), fres * (1.0 - foam * 0.72));', '');
      } else if (kind === 'nodetail') {
        f = f.replace('float breakup = mix(fd.r, fd2.r, 0.5);', 'float breakup = 0.5;')
             .replace('N = normalize(N + vec3(fd.g - 0.5, 0.0, fd.b - 0.5) * foam * 1.1);', '');
      }
      m.fragmentShader = f;
      m.needsUpdate = true;
    }
    return kind;
  };

  window.__measure = (FRAMES) => {
    const gl = w.renderer.getContext();
    const stubbed = [];
    for (const m of eng.modules) {
      if (m.name === 'camera') { stubbed.push([m, m.update]); m.update = () => {}; }
    }
    eng.stop();
    const W = w.size.width, H = w.size.height;
    const buf = new Uint8Array(W * H * 4);
    const xa = 40, xb = 520, xc = 1120, xd = 1560;
    const cols = [];
    for (let x = xa; x < xb; x += 2) cols.push(x);
    for (let x = xc; x < xd; x += 2) cols.push(x);
    const NC = cols.length;
    const frames = [];
    const t0 = performance.now();
    for (let f = 0; f < FRAMES; f++) {
      eng.lastTime = t0 + f * 16.6667;
      eng.tick(t0 + (f + 1) * 16.6667);
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
    }
    eng.start();
    for (const [m, u] of stubbed) m.update = u;

    // per row: mean luminance, per-pixel temporal std, row-mean temporal std
    const meanL = new Float64Array(H);
    const pxStd = new Float64Array(H);
    const rowStd = new Float64Array(H);
    const pxAbsD = new Float64Array(H);
    for (let y = 0; y < H; y++) {
      let sM = 0;
      let sPxVar = 0;
      let sAbsD = 0;
      const rowMeans = new Float64Array(FRAMES);
      for (let f = 0; f < FRAMES; f++) {
        let s = 0;
        for (let c = 0; c < NC; c++) s += frames[f][y * NC + c];
        rowMeans[f] = s / NC;
        sM += rowMeans[f] / FRAMES;
      }
      for (let c = 0; c < NC; c++) {
        let m1 = 0, m2 = 0;
        for (let f = 0; f < FRAMES; f++) { const v = frames[f][y * NC + c]; m1 += v; m2 += v * v; }
        m1 /= FRAMES; m2 /= FRAMES;
        sPxVar += Math.max(m2 - m1 * m1, 0);
        for (let f = 1; f < FRAMES; f++) sAbsD += Math.abs(frames[f][y * NC + c] - frames[f - 1][y * NC + c]);
      }
      let rm = 0, rm2 = 0;
      for (let f = 0; f < FRAMES; f++) { rm += rowMeans[f]; rm2 += rowMeans[f] * rowMeans[f]; }
      rm /= FRAMES; rm2 /= FRAMES;
      meanL[y] = sM;
      pxStd[y] = Math.sqrt(sPxVar / NC);
      rowStd[y] = Math.sqrt(Math.max(rm2 - rm * rm, 0));
      pxAbsD[y] = sAbsD / NC / (FRAMES - 1);
    }
    const coh = new Float64Array(H);
    for (let y = 0; y < H; y++) coh[y] = pxStd[y] > 1e-4 ? (rowStd[y] / pxStd[y]) * Math.sqrt(NC) : 0;

    // geometry: distance of each TOP-DOWN screen row on a flat sea. readPixels
    // hands back bottom-up rows, so every array is reversed on the way out.
    const cam = w.camera;
    const pitch = Math.asin(Math.max(-1, Math.min(1, -cam.matrixWorld.elements[9])));
    const th = Math.tan((cam.fov * Math.PI) / 360);
    const dist = new Float64Array(H);
    for (let y = 0; y < H; y++) {
      const dep = pitch + Math.atan(((y + 0.5 - H / 2) / (H / 2)) * th);
      dist[y] = dep > 1e-4 ? Math.min(99999, cam.position.y / Math.tan(dep)) : -1;
    }
    const rev = (a) => Array.from(a).reverse();
    return {
      H, NC,
      meanL: rev(meanL).map((v) => +v.toFixed(2)),
      pxAbsD: rev(pxAbsD).map((v) => +v.toFixed(3)),
      pxStd: rev(pxStd).map((v) => +v.toFixed(3)),
      coh: rev(coh).map((v) => +v.toFixed(2)),
      dist: Array.from(dist).map((v) => +v.toFixed(0)),
      camY: +cam.position.y.toFixed(2), fov: cam.fov,
    };
  };
});

const runs = {};
for (const p of patches) {
  await page.evaluate((k) => window.__patch(k), p);
  await page.waitForTimeout(1200);
  runs[p] = await page.evaluate((n) => window.__measure(n), FRAMES);
  console.log(`measured patch=${p}`);
}
if (errs.length) console.log('ERRORS', errs.slice(0, 6));

const ref = runs[patches[0]];
const H = ref.H;
console.log(`\nscene=${scene} camY=${ref.camY} fov=${ref.fov} cols=${ref.NC} frames=${FRAMES}`);
const hdr = ['row', 'dist'].concat(patches.flatMap((p) => [`${p}:px`, `${p}:coh`]));
console.log(hdr.map((s) => s.padStart(11)).join(''));
for (let y = 356; y < H; y += 12) {
  const cells = [String(y), String(ref.dist[y])];
  for (const p of patches) { cells.push(runs[p].pxAbsD[y].toFixed(2)); cells.push(runs[p].coh[y].toFixed(1)); }
  console.log(cells.map((s) => s.padStart(11)).join(''));
}

// band summaries
function band(r, a, b, key) {
  let s = 0, n = 0;
  for (let y = a; y <= b; y++) { s += r[key][y]; n++; }
  return s / n;
}
console.log('\nband means of per-pixel |frame delta| (0-255 luma):');
const bands = [[356, 400, 'far  6km-400m'], [400, 470, 'mid  400-160m'], [470, 560, 'near 160-95m'], [560, 700, 'close 95-40m'], [700, 899, 'foreground']];
for (const [a, b, label] of bands) {
  console.log('  ' + label.padEnd(16) + patches.map((p) => `${p}=${band(runs[p], a, b, 'pxAbsD').toFixed(2)}`).join('  '));
}
console.log('\nband means of row coherence (1 = per-pixel noise, >3 = whole-row band):');
for (const [a, b, label] of bands) {
  console.log('  ' + label.padEnd(16) + patches.map((p) => `${p}=${band(runs[p], a, b, 'coh').toFixed(2)}`).join('  '));
}
console.log('\nband means of mean luminance:');
for (const [a, b, label] of bands) {
  console.log('  ' + label.padEnd(16) + patches.map((p) => `${p}=${band(runs[p], a, b, 'meanL').toFixed(1)}`).join('  '));
}
await writeFile(`/tmp/aniso-${scene}.json`, JSON.stringify(runs));
await browser.close();
