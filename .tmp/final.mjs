#!/usr/bin/env node
/** Final itemised budget: CPU per module + per-pass GPU by slope. */
import { chromium } from 'playwright';
import process from 'node:process';
const SCENES = {
  noon: { timeOfDay: 12.7, windSpeed: 10.5, cloudCover: 0.38, cloudType: 0.8, turbidity: 2.0, rain: 0, visibility: 34000, seaState: 4, waveHeight: 2.0, choppiness: 0.6 },
  storm: { timeOfDay: 15.0, windSpeed: 22.0, cloudCover: 0.98, cloudType: 0.95, turbidity: 6.0, rain: 0.85, visibility: 5200, seaState: 7, waveHeight: 6.5, choppiness: 0.85 },
};
const name = process.argv[2] ?? 'noon';
const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--force-color-profile=srgb', '--hide-scrollbars', '--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.setDefaultTimeout(1200000);
await page.addInitScript(() => { const R = window.WebSocket; class D extends EventTarget { constructor() { super(); this.readyState = 3; } send() {} close() {} } window.WebSocket = function (u, p) { return p === 'vite-hmr' ? new D() : new R(u, p); }; });
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__leeward, null, { timeout: 120000 });
await page.evaluate((env) => { const w = window.__leeward.world; Object.assign(w.settings, { quality: 'ultra', adaptiveResolution: false, renderScale: 1, debug: false }); Object.assign(w.env, env); Object.assign(w.cam, { mode: 'chase', distance: 74 }); w.bus.emit('settings:changed'); w.bus.emit('capture:scene', {}); }, SCENES[name] ?? SCENES.noon);
await page.waitForTimeout(10000);

console.log(`==== CPU: module.update(), ms/frame (debug OFF, no gl.finish), scene=${name} ====`);
const cpu = await page.evaluate(async () => {
  const eng = window.__leeward, w = eng.world, mods = eng.modules;
  const acc = new Map(); const orig = mods.map((m) => m.update.bind(m));
  mods.forEach((m, i) => { m.update = (wd) => { const t = performance.now(); orig[i](wd); const d = performance.now() - t; const a = acc.get(m.name) ?? { s: 0, n: 0, mx: 0, all: [] }; a.s += d; a.n++; a.mx = Math.max(a.mx, d); a.all.push(d); acc.set(m.name, a); }; });
  const pipe = window.__rcPipe; const oR = pipe.render.bind(pipe); const r2 = { s: 0, n: 0 };
  pipe.render = (wd) => { const t = performance.now(); oR(wd); r2.s += performance.now() - t; r2.n++; };
  const f0 = w.time.frame, t0 = performance.now();
  await new Promise((r) => setTimeout(r, 8000));
  const frames = w.time.frame - f0, wall = (performance.now() - t0) / frames;
  mods.forEach((m, i) => { m.update = orig[i]; }); pipe.render = oR;
  const out = {};
  for (const [k, a] of acc) { const s = a.all.sort((x, y) => x - y); out[k] = { avg: +(a.s / a.n).toFixed(3), p50: +s[Math.floor(s.length / 2)].toFixed(3), p95: +s[Math.floor(s.length * 0.95)].toFixed(3), max: +a.mx.toFixed(1) }; }
  return { out, hook: +(r2.s / r2.n).toFixed(3), wall: +wall.toFixed(1), frames };
});
let tot = 0;
for (const [k, v] of Object.entries(cpu.out).sort((a, b) => b[1].avg - a[1].avg)) { tot += v.avg; console.log(`  upd:${k.padEnd(14)} mean ${String(v.avg).padStart(7)}  p50 ${String(v.p50).padStart(7)}  p95 ${String(v.p95).padStart(7)}  max ${v.max}`); }
console.log(`  ${'--- modules total'.padEnd(18)} ${tot.toFixed(3)}`);
console.log(`  ${'--- render hook'.padEnd(18)} ${cpu.hook}   (CPU submission only)`);
console.log(`  ${'=== CPU per frame'.padEnd(18)} ${(tot + cpu.hook).toFixed(3)}    wall ${cpu.wall} ms over ${cpu.frames} frames`);

// ocean/vfx internals need debug on
const inner = await page.evaluate(async () => {
  const w = window.__leeward.world; w.settings.debug = true;
  await new Promise((r) => setTimeout(r, 4000));
  const pick = (re) => Object.fromEntries(Object.entries(w.stats).filter(([k]) => re.test(k)).map(([k, v]) => [k, +Number(v).toPrecision(3)]));
  const o = { ocean: pick(/^ocean[:.]/), vfx: pick(/^vfx:/), sky: pick(/^sky:/) };
  w.settings.debug = false; await new Promise((r) => setTimeout(r, 1200)); return o;
});
console.log(`\n==== subsystem internals (world.stats, debug on) ====`);
for (const g of ['ocean', 'vfx', 'sky']) console.log(`  ${g}: ` + Object.entries(inner[g]).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join('  '));

// slope harness
await page.evaluate(() => {
  const eng = window.__leeward, w = eng.world;
  const H = { extra: null, k: 0, frames: [], collect: false }; window.__H = H;
  const o = eng.tick.bind(eng);
  eng.tick = (now) => { const t0 = performance.now(); o(now); if (H.extra && H.k > 0) for (let i = 0; i < H.k; i++) H.extra(w, i); const t1 = performance.now(); if (H.collect) H.frames.push(t1 - t0); };
});
const KS = [0, 3, 6], ROUNDS = 4, WIN = 1100;
const slope = async (label, factory) => {
  const r = await page.evaluate(async ({ factory, KS, ROUNDS, WIN }) => {
    const w = window.__leeward.world, H = window.__H;
    const made = new Function('w', factory)(w); if (!made) return null;
    H.extra = made.run;
    const b = KS.map(() => []);
    for (let round = 0; round < ROUNDS; round++) for (let i = 0; i < KS.length; i++) {
      H.k = KS[i]; await new Promise((r) => setTimeout(r, 300));
      H.frames.length = 0; H.collect = true; await new Promise((r) => setTimeout(r, WIN)); H.collect = false;
      const s = [...H.frames].sort((a, b2) => a - b2); if (s.length > 3) b[i].push(s[Math.floor(s.length * 0.35)]);
    }
    H.k = 0; H.extra = null; made.dispose?.();
    const m = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
    const y = b.map(m); const n = KS.length;
    const mx = KS.reduce((a, c) => a + c, 0) / n, my = y.reduce((a, c) => a + c, 0) / n;
    let num = 0, den = 0; for (let i = 0; i < n; i++) { num += (KS[i] - mx) * (y[i] - my); den += (KS[i] - mx) ** 2; }
    return { y, slope: num / den };
  }, { factory, KS, ROUNDS, WIN });
  if (!r) { console.log(`  ${label.padEnd(30)}  (n/a)`); return null; }
  console.log(`  ${label.padEnd(30)} ${r.slope.toFixed(3).padStart(8)} ms/call   [${r.y.map((v) => v.toFixed(1)).join(', ')}]`);
  return { label, slope: r.slope };
};
console.log(`\n==== GPU per pass, marginal ms per invocation (slope method) ====`);
const T = [
  ['scene render (whole)', `const t=window.__rcPipe.targets.get('scene',w.size.width,w.size.height,'rgba16f',{depth:true}); return {run:()=>{w.renderer.setRenderTarget(t); w.renderer.render(w.scene,w.camera);}};`],
  ['scene render, shadows off', `const t=window.__rcPipe.targets.get('scene',w.size.width,w.size.height,'rgba16f',{depth:true}); return {run:()=>{const a=w.renderer.shadowMap.autoUpdate; w.renderer.shadowMap.autoUpdate=false; w.renderer.setRenderTarget(t); w.renderer.render(w.scene,w.camera); w.renderer.shadowMap.autoUpdate=a;}};`],
  ['ocean: all cascades', `const oc=w.ocean; let t=0; return {run:()=>{for(const c of oc.cascades) c.update(w.renderer, t+=0.0001);}};`],
  ['ocean: foam', `const oc=w.ocean; return {run:()=>oc.foam.update(w.renderer, w.camera.position.x, w.camera.position.z, 0.0001, oc.params, w.env.windSpeed)};`],
  ['sky: skyView LUT', `const l=window.__skyDbg.luts,s=window.__skyDbg; return {run:()=>l.updateSkyView(w.renderer,w.env.sunDirection.y,0.03,s.radiometry.solarIrradiance,s.radiometry.mieMul,true)};`],
  ['sky: aerial froxel x16', `const l=window.__skyDbg.luts,s=window.__skyDbg; return {run:()=>l.updateAerial(w.renderer,s.aerialMatrix,s.camPos,w.env.sunDirection,s.radiometry.solarIrradiance,s.clouds.shadowTexture,s.clouds.shadowMatrix,1,s.radiometry.mieMul)};`],
  ['sky: envProbe equirect', `const p=window.__skyDbg.probe; return {run:()=>p.pass.render(w.renderer,p.target)};`],
  ['cloud: shadow slice', `const c=window.__skyDbg.clouds; return {run:()=>c.shadowPass.render(w.renderer,c.shadow)};`],
  ['cloud: march', `const c=window.__skyDbg.clouds; return {run:()=>c.marchPass.render(w.renderer,c.raw)};`],
  ['cloud: resolve', `const c=window.__skyDbg.clouds; return {run:()=>c.resolvePass.render(w.renderer,c.raw)};`],
  ['post: exposure 3 passes', `const p=window.__rcPipe, ae=p.exposure, t=p.targets; const lum=t.get('expLum',64,64,'r16f',{nearest:true}), par=t.get('expPartial',64,32,'r16f',{nearest:true}), res=t.get('expResult',1,1,'rgba32f',{nearest:true}); return {run:()=>{ae.lumPass.render(w.renderer,lum); ae.histPass.render(w.renderer,par); ae.resolvePass.render(w.renderer,res);}};`],
  ['post: adapt (1x1)', `const p=window.__rcPipe, ae=p.exposure, t=p.targets; const s=t.get('expStateB',1,1,'rgba32f',{nearest:true}); return {run:()=>ae.adaptPass.render(w.renderer,s)};`],
  ['post: prepare', `const p=window.__rcPipe, t=p.targets.get('work1',w.size.width,w.size.height,'rgba16f'); return {run:()=>p.prepare.render(w.renderer,t)};`],
  ['post: depthCopy', `const p=window.__rcPipe, t=p.targets.get('sceneDepth',w.size.width,w.size.height,'r32f',{nearest:true}); return {run:()=>p.depthCopy.render(w.renderer,t)};`],
  ['post: velocity', `const p=window.__rcPipe, t=p.targets.get('velocity',w.size.width,w.size.height,'rg16f',{nearest:true}); return {run:()=>p.velocity.render(w.renderer,t)};`],
  ['post: bloom chain', `const p=window.__rcPipe, t=p.targets.get('work0',w.size.width,w.size.height,'rgba16f'); return {run:()=>p.bloom.render(w.renderer,t.texture,1.15)};`],
  ['post: composite', `const p=window.__rcPipe, t=p.targets.get('work1',w.size.width,w.size.height,'rgba16f'); return {run:()=>p.composite.render(w.renderer,t)};`],
];
const rows = [];
for (const [l, f] of T) { const r = await slope(l, f); if (r) rows.push(r); }
console.log(`\n==== ranked ====`);
for (const r of rows.sort((a, b) => b.slope - a.slope)) console.log(`  ${r.slope.toFixed(3).padStart(8)} ms   ${r.label}`);
await browser.close();
