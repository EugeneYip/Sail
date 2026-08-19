#!/usr/bin/env node
/** CPU per module + frame decomposition on the storm scene. */
import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--force-color-profile=srgb', '--hide-scrollbars', '--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.setDefaultTimeout(600000);
await page.addInitScript(() => { const R = window.WebSocket; class D extends EventTarget { constructor() { super(); this.readyState = 3; } send() {} close() {} } window.WebSocket = function (u, p) { return p === 'vite-hmr' ? new D() : new R(u, p); }; });
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__leeward, null, { timeout: 120000 });
await page.evaluate(() => { const w = window.__leeward.world; Object.assign(w.settings, { quality: 'ultra', adaptiveResolution: false, renderScale: 1, debug: false }); Object.assign(w.env, { timeOfDay: 15.0, windSpeed: 22.0, cloudCover: 0.98, cloudType: 0.95, turbidity: 6.0, rain: 0.85, visibility: 5200, seaState: 7, waveHeight: 6.5, choppiness: 0.85 }); Object.assign(w.cam, { mode: 'chase', distance: 70 }); w.bus.emit('settings:changed'); w.bus.emit('capture:scene', {}); });
await page.waitForTimeout(11000);
const cpu = await page.evaluate(async () => {
  const eng = window.__leeward, w = eng.world, mods = eng.modules;
  const acc = new Map(); const orig = mods.map((m) => m.update.bind(m));
  mods.forEach((m, i) => { m.update = (wd) => { const t = performance.now(); orig[i](wd); const d = performance.now() - t; const a = acc.get(m.name) ?? { s: 0, n: 0, mx: 0, all: [] }; a.s += d; a.n++; a.mx = Math.max(a.mx, d); a.all.push(d); acc.set(m.name, a); }; });
  const pipe = window.__rcPipe; const oR = pipe.render.bind(pipe); const r2 = { s: 0, n: 0 };
  pipe.render = (wd) => { const t = performance.now(); oR(wd); r2.s += performance.now() - t; r2.n++; };
  const per = []; let prev = 0;
  const oT = eng.tick.bind(eng); eng.tick = (n) => { const t0 = performance.now(); oT(n); if (prev) per.push(t0 - prev); prev = t0; };
  const f0 = w.time.frame, t0 = performance.now();
  await new Promise((r) => setTimeout(r, 9000));
  const frames = w.time.frame - f0, wall = (performance.now() - t0) / frames;
  mods.forEach((m, i) => { m.update = orig[i]; }); pipe.render = oR; eng.tick = oT;
  const out = {};
  for (const [k, a] of acc) { const s = a.all.sort((x, y) => x - y); out[k] = { avg: +(a.s / a.n).toFixed(3), p50: +s[Math.floor(s.length / 2)].toFixed(3), p95: +s[Math.floor(s.length * 0.95)].toFixed(3), max: +a.mx.toFixed(1) }; }
  const ps = per.sort((a, b) => a - b);
  return { out, hook: +(r2.s / r2.n).toFixed(3), wall: +wall.toFixed(1), frames, pP25: +ps[Math.floor(ps.length * 0.25)].toFixed(1), pP50: +ps[Math.floor(ps.length * 0.5)].toFixed(1) };
});
console.log('==== STORM: CPU per module, ms/frame ====');
let tot = 0;
for (const [k, v] of Object.entries(cpu.out).sort((a, b) => b[1].avg - a[1].avg)) { tot += v.avg; console.log(`  upd:${k.padEnd(14)} mean ${String(v.avg).padStart(7)}  p50 ${String(v.p50).padStart(7)}  p95 ${String(v.p95).padStart(7)}  max ${v.max}`); }
console.log(`  modules total ${tot.toFixed(3)}   render hook ${cpu.hook}   CPU/frame ${(tot + cpu.hook).toFixed(3)}`);
console.log(`  frame period: mean ${cpu.wall}  p25 ${cpu.pP25}  p50 ${cpu.pP50}  (rAF cap 16.6)`);
const ab = async (label, setup) => {
  const r = await page.evaluate(async ({ setup }) => {
    const w = window.__leeward.world; const eng = window.__leeward;
    const per = []; let prev = 0; const oT = eng.tick.bind(eng);
    const undo = new Function('w', setup)(w);
    eng.tick = (n) => { const t0 = performance.now(); oT(n); if (prev) per.push(t0 - prev); prev = t0; };
    await new Promise((r) => setTimeout(r, 1500)); per.length = 0;
    await new Promise((r) => setTimeout(r, 5000));
    eng.tick = oT; if (typeof undo === 'function') undo();
    const s = per.sort((a, b) => a - b);
    return { p25: +s[Math.floor(s.length * 0.25)].toFixed(1), p50: +s[Math.floor(s.length * 0.5)].toFixed(1) };
  }, { setup });
  console.log(`  ${label.padEnd(34)} p25 ${String(r.p25).padStart(6)}  p50 ${String(r.p50).padStart(6)}`);
};
console.log('\n==== storm ablation (frame period) ====');
await ab('BASELINE', 'return null;');
await ab('vfx module off', `const m=window.__leeward.modules.find(x=>x.name==='vfx'); const o=m.update.bind(m); m.update=()=>{}; return ()=>{m.update=o;};`);
await ab('ocean module off', `const m=window.__leeward.modules.find(x=>x.name==='ocean'); const o=m.update.bind(m); m.update=()=>{}; return ()=>{m.update=o;};`);
await ab('hide vfx-particles', `const o=w.scene.children.find(c=>/vfx/i.test(c.name)); if(!o) return null; o.visible=false; return ()=>{o.visible=true;};`);
await ab('hide ocean mesh', `const o=w.scene.children.find(c=>/ocean/i.test(c.name)); if(!o) return null; o.visible=false; return ()=>{o.visible=true;};`);
await ab('BASELINE (drift check)', 'return null;');
await browser.close();
