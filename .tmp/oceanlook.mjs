#!/usr/bin/env node
/**
 * Why does the water read flat and milky? Dumps the uniforms the surface shader
 * actually receives, the real amplitude of the wave field, and the rendered
 * pixel contrast down a vertical strip of water — so "hazy" and "flat" become
 * numbers instead of adjectives.
 */
import { chromium } from 'playwright';
import process from 'node:process';

const SCENES = {
  noon: { timeOfDay: 12.7, windSpeed: 10.5, cloudCover: 0.38, cloudType: 0.8, turbidity: 2, rain: 0, visibility: 34000, seaState: 4, waveHeight: 2, choppiness: 0.6 },
  golden: { timeOfDay: 18.6, windSpeed: 8, cloudCover: 0.45, cloudType: 0.6, turbidity: 3, rain: 0, visibility: 26000, seaState: 3, waveHeight: 1.5, choppiness: 0.55 },
  storm: { timeOfDay: 15, windSpeed: 22, cloudCover: 0.98, cloudType: 1, turbidity: 6, rain: 0.9, visibility: 5200, seaState: 7, waveHeight: 6.5, choppiness: 0.85 },
};
const want = (process.argv[2] ?? 'noon,golden,storm').split(',');

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--hide-scrollbars', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.addInitScript(() => {
  const R = window.WebSocket;
  class D extends EventTarget { constructor() { super(); this.readyState = 3; } send() {} close() {} }
  window.WebSocket = function (u, p) { return p === 'vite-hmr' ? new D() : new R(u, p); };
});
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded', timeout: 240000 });
await page.waitForFunction(() => !!window.__leeward, null, { timeout: 240000 });

for (const name of want) {
  await page.evaluate((env) => {
    const w = window.__leeward.world;
    Object.assign(w.settings, { quality: 'ultra', adaptiveResolution: false, renderScale: 1, debug: true });
    Object.assign(w.env, env);
    Object.assign(w.cam, { mode: 'chase', distance: 74 });
    w.bus.emit('settings:changed');
    w.bus.emit('capture:scene', {});
  }, SCENES[name]);
  await page.waitForTimeout(8000);

  const out = await page.evaluate(() => {
    const w = window.__leeward.world;
    const oc = w.ocean;
    const u = w.uniforms;
    const v3 = (x) => x && x.isVector3 ? [+x.x.toFixed(4), +x.y.toFixed(4), +x.z.toFixed(4)] : x;
    const col = (c) => c && c.isColor ? [+c.r.toFixed(4), +c.g.toFixed(4), +c.b.toFixed(4)] : v3(c);
    const g = (k) => (u[k] ? (typeof u[k].value === 'number' ? +u[k].value.toPrecision(4) : col(u[k].value)) : 'MISSING');

    // Real amplitude of the field the shader is displacing by.
    const N = 96, span = 400;
    let mn = 1e9, mx = -1e9, sum = 0, sum2 = 0;
    const cp = w.camera.position;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const h = oc.sampleHeight(cp.x + (i / N - 0.5) * span, cp.z + (j / N - 0.5) * span);
      mn = Math.min(mn, h); mx = Math.max(mx, h); sum += h; sum2 += h * h;
    }
    const n = N * N, mean = sum / n;
    const rms = Math.sqrt(Math.max(sum2 / n - mean * mean, 0));

    return {
      uniforms: {
        uSunIntensity: g('uSunIntensity'), uSunColor: g('uSunColor'),
        uSkyColor: g('uSkyColor'), uFogColor: g('uFogColor'),
        uFogDensity: g('uFogDensity'), uVisibility: g('uVisibility'),
        uExposure: g('uExposure'), uWetness: g('uWetness'),
        uSunDirY: +u.uSunDirection.value.y.toFixed(4),
      },
      field: {
        'env.waveHeight': w.env.waveHeight,
        'params.hs (targeted)': +oc.params.hs.toFixed(3),
        'sampled 4*rms (= Hs)': +(4 * rms).toFixed(3),
        'sampled peak-to-trough': +(mx - mn).toFixed(3),
        'maxHeight() bound': +w.ext.ocean.maxHeight().toFixed(3),
        slopeRms: +oc.params.slopeRms.toFixed(4),
        choppiness: +oc.params.choppiness.toFixed(3),
        camY: +cp.y.toFixed(2),
      },
      // Koschmieder transmittance the shader computes, at real distances.
      haze: (() => {
        const ext = Math.max(u.uFogDensity.value, 3.912 / Math.max(u.uVisibility.value, 200));
        const at = (d) => +(1 - Math.exp(-d * ext)).toFixed(4);
        return { ext: +ext.toPrecision(3), 'fog@30m': at(30), 'fog@100m': at(100), 'fog@500m': at(500), 'fog@2km': at(2000) };
      })(),
    };
  });

  // Rendered contrast down a strip of water, away from ship and HUD.
  const shot = await page.screenshot({ clip: { x: 180, y: 380, width: 240, height: 500 }, timeout: 120000 });
  const strip = await page.evaluate(async (b64) => {
    const img = new Image();
    await new Promise((r) => { img.onload = r; img.src = 'data:image/png;base64,' + b64; });
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const rows = [];
    for (let y = 0; y < c.height; y += 100) {
      let r = 0, g = 0, bb = 0, n = 0, lmin = 1e9, lmax = -1e9;
      for (let x = 0; x < c.width; x++) {
        const o = (y * c.width + x) * 4;
        r += d[o]; g += d[o + 1]; bb += d[o + 2]; n++;
        const l = 0.2126 * d[o] + 0.7152 * d[o + 1] + 0.0722 * d[o + 2];
        lmin = Math.min(lmin, l); lmax = Math.max(lmax, l);
      }
      rows.push({ row: y, sRGB: [Math.round(r / n), Math.round(g / n), Math.round(bb / n)],
        'B-R': Math.round((bb - r) / n), 'local contrast (max-min L)': Math.round(lmax - lmin) });
    }
    return rows;
  }, shot.toString('base64'));

  console.log(`\n================ ${name} ================`);
  console.log('uniforms:', out.uniforms);
  console.log('wave field:', out.field);
  console.log('haze the ocean shader applies:', out.haze);
  console.log('rendered water strip (x 180-420, sRGB 0-255; row 0 = near horizon):');
  console.table(strip);
}
await browser.close();
