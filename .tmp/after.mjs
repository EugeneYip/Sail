#!/usr/bin/env node
/** Before/after: frame-period decomposition + remaining sync GL round-trips. */
import { chromium } from 'playwright';
import process from 'node:process';
const SCENES = {
  noon: { timeOfDay: 12.7, windSpeed: 10.5, cloudCover: 0.38, cloudType: 0.8, turbidity: 2.0, rain: 0, visibility: 34000, seaState: 4, waveHeight: 2.0, choppiness: 0.6 },
  storm: { timeOfDay: 15.0, windSpeed: 22.0, cloudCover: 0.98, cloudType: 0.95, turbidity: 6.0, rain: 0.85, visibility: 5200, seaState: 7, waveHeight: 6.5, choppiness: 0.85 },
};
const name = process.argv[2] ?? 'noon';
const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--force-color-profile=srgb', '--hide-scrollbars', '--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.setDefaultTimeout(600000);
const warn = new Map();
page.on('console', (m) => { const t = m.text(); let k = t.slice(0, 70); if (/fenced/.test(t)) k = 'ANGLE READ-usage fenced-buffer'; else if (/defines/.test(t)) k = 'THREE defines undefined'; else if (/glGetProgramiv/.test(t)) k = 'glGetProgramiv INVALID_VALUE'; warn.set(k, (warn.get(k) ?? 0) + 1); });
await page.addInitScript(() => { const R = window.WebSocket; class D extends EventTarget { constructor() { super(); this.readyState = 3; } send() {} close() {} } window.WebSocket = function (u, p) { return p === 'vite-hmr' ? new D() : new R(u, p); }; });
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__leeward, null, { timeout: 120000 });
await page.evaluate((env) => { const w = window.__leeward.world; Object.assign(w.settings, { quality: 'ultra', adaptiveResolution: false, renderScale: 1, debug: false }); Object.assign(w.env, env); Object.assign(w.cam, { mode: 'chase', distance: 74 }); w.bus.emit('settings:changed'); w.bus.emit('capture:scene', {}); }, SCENES[name] ?? SCENES.noon);
await page.waitForTimeout(10000);
await page.evaluate(() => {
  const eng = window.__leeward; const H = { tick: [], period: [], collect: false, prev: 0 }; window.__H = H;
  const o = eng.tick.bind(eng);
  eng.tick = (now) => { const t0 = performance.now(); o(now); const t1 = performance.now(); if (H.collect) { H.tick.push(t1 - t0); if (H.prev) H.period.push(t0 - H.prev); } H.prev = t0; };
});
const go = async (label, setup) => {
  const r = await page.evaluate(async ({ setup }) => {
    const w = window.__leeward.world, H = window.__H;
    const undo = new Function('w', setup)(w);
    await new Promise((r) => setTimeout(r, 1500));
    H.tick.length = 0; H.period.length = 0; H.collect = true;
    await new Promise((r) => setTimeout(r, 7000));
    H.collect = false; if (typeof undo === 'function') undo();
    const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? +s[Math.floor(s.length * p)].toFixed(1) : NaN; };
    const mn = (a) => a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : NaN;
    return { n: H.period.length, pMean: mn(H.period), pP25: q(H.period, 0.25), pP50: q(H.period, 0.5), tMean: mn(H.tick), tP50: q(H.tick, 0.5), tP10: q(H.tick, 0.1), tP90: q(H.tick, 0.9), tP99: q(H.tick, 0.99) };
  }, { setup });
  console.log(`  ${label.padEnd(38)} period mean ${String(r.pMean).padStart(7)} p25 ${String(r.pP25).padStart(6)} p50 ${String(r.pP50).padStart(6)} | tick mean ${String(r.tMean).padStart(6)} p10 ${String(r.tP10).padStart(5)} p50 ${String(r.tP50).padStart(6)} p90 ${String(r.tP90).padStart(6)} p99 ${String(r.tP99).padStart(6)}`);
  return r;
};
console.log(`==== AFTER: frame decomposition, scene=${name} (rAF cap is 16.6 ms) ====`);
await go('as shipped (post-fix)', 'return null;');
await go('all modules + render stubbed', `const e=window.__leeward; const p=e.renderHook, o=p.render.bind(p); p.render=()=>{}; const ms=e.modules.map(m=>[m,m.update.bind(m)]); for(const [m] of ms) m.update=()=>{}; return ()=>{p.render=o; for(const [m,u] of ms) m.update=u;};`);
await go('render hook stubbed', `const e=window.__leeward; const p=e.renderHook, o=p.render.bind(p); p.render=()=>{}; return ()=>{p.render=o;};`);
await go('shadowMap.autoUpdate off', `w.renderer.shadowMap.autoUpdate=false; return ()=>{w.renderer.shadowMap.autoUpdate=true;};`);
console.log('\n==== remaining synchronous GL round-trips ====');
const sync = await page.evaluate(async () => {
  const gl = window.__leeward.world.renderer.getContext();
  const names = ['getBufferSubData', 'readPixels', 'clientWaitSync', 'finish', 'getError', 'checkFramebufferStatus', 'getQueryParameter', 'fenceSync'];
  const acc = {}, orig = {};
  for (const n of names) { if (typeof gl[n] !== 'function') continue; orig[n] = gl[n].bind(gl); acc[n] = { sum: 0, n: 0, max: 0 }; gl[n] = (...a) => { const t = performance.now(); const v = orig[n](...a); const d = performance.now() - t; const s = acc[n]; s.sum += d; s.n++; s.max = Math.max(s.max, d); return v; }; }
  const w = window.__leeward.world; const f0 = w.time.frame;
  await new Promise((r) => setTimeout(r, 6000));
  const frames = w.time.frame - f0;
  for (const n of Object.keys(orig)) gl[n] = orig[n];
  const out = {};
  for (const [k, s] of Object.entries(acc)) if (s.n) out[k] = { perFrame: +(s.sum / frames).toFixed(2), calls: +(s.n / frames).toFixed(2), perCall: +(s.sum / s.n).toFixed(3), max: +s.max.toFixed(1) };
  return out;
});
const e = Object.entries(sync).sort((a, b) => b[1].perFrame - a[1].perFrame);
if (!e.length) console.log('  none');
for (const [k, v] of e) console.log(`  ${k.padEnd(24)} ${String(v.perFrame).padStart(8)} ms/frame  ${String(v.calls).padStart(6)} calls/frame  ${String(v.perCall).padStart(8)} ms/call  max ${v.max}`);
console.log('\n==== console ====');
for (const [k, v] of [...warn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`  ${String(v).padStart(5)} x ${k}`);
await browser.close();
