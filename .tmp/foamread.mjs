#!/usr/bin/env node
/**
 * Read the persistent foam buffer back and report its actual coverage.
 *
 * The surface shader inside the foam window uses max(persistent, ...), so if
 * this buffer is full the sea must show whitecaps and the bug is downstream; if
 * it is empty the fold threshold in Foam.ts is the culprit. Screenshots keep
 * timing out under machine load, so this is measured numerically instead.
 */
import { chromium } from 'playwright';
import process from 'node:process';

const SCENES = {
  noon: { timeOfDay: 12.7, windSpeed: 10.5, cloudCover: 0.38, cloudType: 0.8, turbidity: 2, rain: 0, visibility: 34000, seaState: 4, waveHeight: 2, choppiness: 0.6 },
  storm: { timeOfDay: 15, windSpeed: 22, cloudCover: 0.98, cloudType: 0.95, turbidity: 6, rain: 0.85, visibility: 5200, seaState: 7, waveHeight: 6.5, choppiness: 0.85 },
};
const want = (process.argv[2] ?? 'noon,storm').split(',');

const b = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--hide-scrollbars', '--mute-audio'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
await p.addInitScript(() => { const R = window.WebSocket; class D extends EventTarget { constructor() { super(); this.readyState = 3; } send() {} close() {} } window.WebSocket = function (u, pr) { return pr === 'vite-hmr' ? new D() : new R(u, pr); }; });
await p.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded', timeout: 240000 });
await p.waitForFunction(() => !!window.__leeward, null, { timeout: 240000 });

for (const name of want) {
  await p.evaluate((e) => {
    const w = window.__leeward.world;
    Object.assign(w.settings, { quality: 'ultra', adaptiveResolution: false, renderScale: 1 });
    Object.assign(w.env, e);
    Object.assign(w.cam, { mode: 'chase', distance: 70 });
    w.bus.emit('settings:changed');
    w.bus.emit('capture:scene', {});
  }, SCENES[name]);
  await p.waitForTimeout(11000);

  const out = await p.evaluate(() => {
    const w = window.__leeward.world;
    const oc = w.ocean;
    const r = w.renderer;
    const rt = oc.foam.ping;
    const n = rt.width;
    // The target is HalfFloatType. Reading it into a Float32Array does NOT
    // convert — it returns zeros without throwing, which is how this tool first
    // reported an empty buffer with readOk true. Read the raw halves and decode.
    const h2f = (h) => {
      const s = (h & 0x8000) ? -1 : 1;
      const e = (h & 0x7c00) >> 10;
      const f = h & 0x03ff;
      if (e === 0) return s * Math.pow(2, -14) * (f / 1024);
      if (e === 0x1f) return f ? NaN : s * Infinity;
      return s * Math.pow(2, e - 15) * (1 + f / 1024);
    };
    const raw = new Uint16Array(n * n * 4);
    let readOk = true;
    try { r.readRenderTargetPixels(rt, 0, 0, n, n, raw); } catch (e) { readOk = 'ERR ' + e.message; }
    // Keep the broken path alongside so the difference is on the record.
    const bad = new Float32Array(n * n * 4);
    try { r.readRenderTargetPixels(rt, 0, 0, n, n, bad); } catch (e) { /* ignore */ }
    let badSum = 0;
    for (let i = 0; i < n * n; i++) badSum += bad[i * 4];
    let cov = 0, sum = 0, mx = 0;
    const hist = {};
    for (let i = 0; i < n * n; i++) {
      const v = h2f(raw[i * 4]);
      sum += v; if (v > mx) mx = v;
      if (v > 0.2) cov++;
      const k = (Math.floor(v * 10) / 10).toFixed(1);
      hist[k] = (hist[k] ?? 0) + 1;
    }
    const mu = oc.material.uniforms;
    return {
      readOk,
      float32PathMeanForComparison: +(badSum / (n * n)).toFixed(4),
      foamBuffer: {
        res: n,
        windowMetres: oc.foam.size,
        meanCoverage: +(sum / (n * n)).toFixed(4),
        fractionAbove0_2: +(cov / (n * n)).toFixed(4),
        max: +mx.toFixed(3),
        histogram: hist,
      },
      surfaceUniforms: {
        uFoamThreshold: +mu.uFoamThreshold.value.toFixed(3),
        uFoamSoftness: +mu.uFoamSoftness.value.toFixed(3),
        uFoamAmount: +mu.uFoamAmount.value.toFixed(3),
      },
      foamSimUniforms: {
        uThreshold: +oc.foam.material.uniforms.uThreshold.value.toFixed(3),
        uInject: +oc.foam.material.uniforms.uInject.value.toFixed(3),
      },
    };
  });
  console.log(`\n========= ${name} =========`);
  console.log(JSON.stringify(out, null, 2));
}
await b.close();
