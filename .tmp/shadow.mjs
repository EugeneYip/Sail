#!/usr/bin/env node
/** Shadow-map cost: interleaved A/B on frame period p25/p50 (robust to load). */
import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--force-color-profile=srgb', '--hide-scrollbars', '--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.setDefaultTimeout(900000);
await page.addInitScript(() => { const R = window.WebSocket; class D extends EventTarget { constructor() { super(); this.readyState = 3; } send() {} close() {} } window.WebSocket = function (u, p) { return p === 'vite-hmr' ? new D() : new R(u, p); }; });
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__leeward, null, { timeout: 120000 });
await page.evaluate(() => { const w = window.__leeward.world; Object.assign(w.settings, { quality: 'ultra', adaptiveResolution: false, renderScale: 1, debug: false }); Object.assign(w.env, { timeOfDay: 12.7, windSpeed: 10.5, cloudCover: 0.38, cloudType: 0.8, turbidity: 2, visibility: 34000, seaState: 4, waveHeight: 2, choppiness: 0.6 }); Object.assign(w.cam, { mode: 'chase', distance: 74 }); w.bus.emit('settings:changed'); w.bus.emit('capture:scene', {}); });
await page.waitForTimeout(10000);
await page.evaluate(() => {
  const eng = window.__leeward; const H = { period: [], collect: false, prev: 0 }; window.__H = H;
  const o = eng.tick.bind(eng);
  eng.tick = (n) => { const t0 = performance.now(); o(n); if (H.collect && H.prev) H.period.push(t0 - H.prev); H.prev = t0; };
});
/** ON/OFF alternated so machine drift cancels. Reports p25 (least contaminated). */
const ab = async (label, setup, cycles = 4) => {
  const r = await page.evaluate(async ({ setup, cycles }) => {
    const w = window.__leeward.world, H = window.__H;
    const on = [], off = [];
    const take = (bucket) => { const s = [...H.period].sort((a, b) => a - b); if (s.length > 8) bucket.push([s[Math.floor(s.length * 0.25)], s[Math.floor(s.length * 0.5)]]); };
    const win = async (bucket) => { H.period.length = 0; H.collect = true; await new Promise((r) => setTimeout(r, 2200)); H.collect = false; take(bucket); };
    for (let i = 0; i < cycles; i++) {
      await new Promise((r) => setTimeout(r, 500)); await win(on);
      const undo = new Function('w', setup)(w);
      await new Promise((r) => setTimeout(r, 900)); await win(off);
      if (typeof undo === 'function') undo();
    }
    const m = (a, i) => { const s = a.map((x) => x[i]).sort((x, y) => x - y); return +s[Math.floor(s.length / 2)].toFixed(1); };
    return { on25: m(on, 0), on50: m(on, 1), off25: m(off, 0), off50: m(off, 1) };
  }, { setup, cycles });
  console.log(`  ${label.padEnd(40)} p25 ${String(r.on25).padStart(6)} -> ${String(r.off25).padStart(6)} (${(r.on25 - r.off25).toFixed(1)})   p50 ${String(r.on50).padStart(6)} -> ${String(r.off50).padStart(6)} (${(r.on50 - r.off50).toFixed(1)})`);
};
console.log('==== shadow map cost (ON = as shipped 4096 VSM, OFF = variant). rAF cap 16.6 ====');
await ab('shadowMap.autoUpdate = false', `w.renderer.shadowMap.autoUpdate=false; return ()=>{w.renderer.shadowMap.autoUpdate=true;};`);
await ab('mapSize 4096 -> 2048', `const s=w.settings.shadowMapSize; w.settings.shadowMapSize=2048; w.bus.emit('settings:changed'); return ()=>{w.settings.shadowMapSize=s; w.bus.emit('settings:changed');};`);
await ab('mapSize 4096 -> 1536', `const s=w.settings.shadowMapSize; w.settings.shadowMapSize=1536; w.bus.emit('settings:changed'); return ()=>{w.settings.shadowMapSize=s; w.bus.emit('settings:changed');};`);
await ab('blurSamples 8 -> 4', `const l=window.__skyDbg.light.sun.shadow; const b=l.blurSamples; l.blurSamples=4; l.map?.dispose(); l.map=null; return ()=>{l.blurSamples=b; l.map?.dispose(); l.map=null;};`);
await ab('VSM -> PCFSoft', `const t=w.renderer.shadowMap.type; w.renderer.shadowMap.type=1; w.renderer.shadowMap.needsUpdate=true; const sc=w.scene; sc.traverse(o=>{if(o.material)o.material.needsUpdate=true;}); return ()=>{w.renderer.shadowMap.type=t; w.renderer.shadowMap.needsUpdate=true; sc.traverse(o=>{if(o.material)o.material.needsUpdate=true;});};`);
await browser.close();
