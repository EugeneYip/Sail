#!/usr/bin/env node
/**
 * Per-pass GPU cost by SLOPE, which is what survives a contended machine.
 *
 * Neither gl.finish() bracketing nor EXT_disjoint_timer_query is usable here:
 * ANGLE-on-Metal returns whole-command-buffer time for any sub-region (a 1-tap
 * blit "costs" 35 ms) and a tight synchronous bench loop drifts 60x. And the
 * box is running at load average 30-60, so a single wall-clock A/B is noise.
 *
 * So: run a pass K extra times per frame and measure median frame time for
 * several K, round-robin so drift decorrelates from K. Additive noise (other
 * processes, other passes, CPU stalls) lands in the INTERCEPT. The SLOPE is the
 * marginal GPU cost of one invocation of that pass, and it is what we want.
 *
 *   node .tmp/slope.mjs [scene] [filter]
 */
import { chromium } from 'playwright';
import process from 'node:process';

const SCENES = {
  noon: { timeOfDay: 12.7, windSpeed: 10.5, cloudCover: 0.38, cloudType: 0.8, turbidity: 2.0, rain: 0, visibility: 34000, seaState: 4, waveHeight: 2.0, choppiness: 0.6 },
  golden: { timeOfDay: 18.6, windSpeed: 7.0, cloudCover: 0.5, cloudType: 0.75, turbidity: 3.6, rain: 0, visibility: 26000, seaState: 3, waveHeight: 1.5, choppiness: 0.5 },
  storm: { timeOfDay: 15.0, windSpeed: 22.0, cloudCover: 0.98, cloudType: 0.95, turbidity: 6.0, rain: 0.85, visibility: 5200, seaState: 7, waveHeight: 6.5, choppiness: 0.85 },
};
const CAMS = { noon: { mode: 'chase', distance: 74 }, golden: { mode: 'chase', distance: 80 }, storm: { mode: 'chase', distance: 70 } };
const name = process.argv[2] ?? 'noon';
const filter = process.argv[3] ?? '';

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--force-color-profile=srgb', '--hide-scrollbars', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.setDefaultTimeout(1200000);
await page.addInitScript(() => {
  const R = window.WebSocket;
  class D extends EventTarget { constructor() { super(); this.readyState = 3; } send() {} close() {} }
  window.WebSocket = function (u, p) { return p === 'vite-hmr' ? new D() : new R(u, p); };
});
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__leeward, null, { timeout: 120000 });
await page.evaluate(({ env, cam }) => {
  const w = window.__leeward.world;
  Object.assign(w.settings, { quality: 'ultra', adaptiveResolution: false, renderScale: 1, debug: false });
  Object.assign(w.env, env);
  Object.assign(w.cam, cam);
  w.bus.emit('settings:changed');
  w.bus.emit('capture:scene', {});
}, { env: SCENES[name] ?? SCENES.noon, cam: CAMS[name] ?? CAMS.noon });
await page.waitForTimeout(10000);

/* harness: a repeatable "extra work" hook run at the tail of every tick */
await page.evaluate(() => {
  const eng = window.__leeward, w = eng.world;
  const H = { extra: null, k: 0, frames: [], collect: false, last: performance.now() };
  window.__H = H;
  const o = eng.tick.bind(eng);
  eng.tick = (now) => {
    const t0 = performance.now();
    o(now);
    if (H.extra && H.k > 0) for (let i = 0; i < H.k; i++) H.extra(w, i);
    const t1 = performance.now();
    if (H.collect) H.frames.push(t1 - t0);
  };
});

const KS = [0, 3, 6];
const ROUNDS = 4;
const WIN = 1100;

const slope = async (label, factory) => {
  const r = await page.evaluate(async ({ factory, KS, ROUNDS, WIN }) => {
    const w = window.__leeward.world, H = window.__H;
    // eslint-disable-next-line no-new-func
    const made = new Function('w', factory)(w);
    if (!made) return null;
    H.extra = made.run;
    const buckets = KS.map(() => []);
    for (let round = 0; round < ROUNDS; round++) {
      for (let i = 0; i < KS.length; i++) {
        H.k = KS[i];
        await new Promise((r) => setTimeout(r, 300));
        H.frames.length = 0; H.collect = true;
        await new Promise((r) => setTimeout(r, WIN));
        H.collect = false;
        const s = [...H.frames].sort((a, b) => a - b);
        if (s.length > 3) buckets[i].push(s[Math.floor(s.length * 0.35)]);
      }
    }
    H.k = 0; H.extra = null;
    made.dispose?.();
    const m = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
    const y = buckets.map(m);
    // least squares slope
    const n = KS.length;
    const mx = KS.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { num += (KS[i] - mx) * (y[i] - my); den += (KS[i] - mx) ** 2; }
    return { y, slope: num / den, intercept: my - (num / den) * mx };
  }, { factory, KS, ROUNDS, WIN });
  if (!r) { console.log(`  ${label.padEnd(32)}  (unavailable)`); return null; }
  console.log(`  ${label.padEnd(32)} ${r.slope.toFixed(3).padStart(8)} ms/call   [k=${KS.join(',')} -> ${r.y.map((v) => v.toFixed(1)).join(', ')}]  base ${r.intercept.toFixed(1)}`);
  return { label, slope: r.slope };
};

const TESTS = [
  ['scene render (whole)', `const t=window.__rcPipe.targets.get('scene',w.size.width,w.size.height,'rgba16f',{depth:true}); return {run:()=>{w.renderer.setRenderTarget(t); w.renderer.render(w.scene,w.camera);}};`],
  ['scene render, shadows off', `const t=window.__rcPipe.targets.get('scene',w.size.width,w.size.height,'rgba16f',{depth:true}); return {run:()=>{const a=w.renderer.shadowMap.autoUpdate; w.renderer.shadowMap.autoUpdate=false; w.renderer.setRenderTarget(t); w.renderer.render(w.scene,w.camera); w.renderer.shadowMap.autoUpdate=a;}};`],
  ['cloud march (quarter res)', `const c=window.__skyDbg.clouds; return {run:()=>c.marchPass.render(w.renderer,c.raw)};`],
  ['cloud march @ steps 24', `const c=window.__skyDbg.clouds; const o=c.marchPass.uniforms.uSteps.value; return {run:()=>{c.marchPass.uniforms.uSteps.value=24; c.marchPass.render(w.renderer,c.raw); c.marchPass.uniforms.uSteps.value=o;}, dispose:()=>{c.marchPass.uniforms.uSteps.value=o;}};`],
  ['cloud shadow slice 512^2', `const c=window.__skyDbg.clouds; return {run:()=>c.shadowPass.render(w.renderer,c.shadow)};`],
  ['cloud resolve (temporal)', `const c=window.__skyDbg.clouds; return {run:()=>c.resolvePass.render(w.renderer,c.raw)};`],
  ['envProbe equirect', `const p=window.__skyDbg.probe; return {run:()=>p.pass.render(w.renderer,p.target)};`],
  ['PMREM of envProbe', `const p=window.__skyDbg.probe; const t=window.__rcPipe.targets.get('scene',w.size.width,w.size.height,'rgba16f',{depth:true}); return {run:()=>{p.target.texture.needsPMREMUpdate=true; w.renderer.setRenderTarget(t); w.renderer.render(w.scene,w.camera);}};`],
  ['  (control: same scene draw)', `const t=window.__rcPipe.targets.get('scene',w.size.width,w.size.height,'rgba16f',{depth:true}); return {run:()=>{w.renderer.setRenderTarget(t); w.renderer.render(w.scene,w.camera);}};`],
  ['skyView LUT', `const l=window.__skyDbg.luts,s=window.__skyDbg; return {run:()=>l.updateSkyView(w.renderer,w.env.sunDirection.y,0.03,s.radiometry.solarIrradiance,s.radiometry.mieMul)};`],
  ['aerial froxel (16 slices)', `const l=window.__skyDbg.luts,s=window.__skyDbg; return {run:()=>l.updateAerial(w.renderer,s.aerialMatrix,s.camPos,w.env.sunDirection,s.radiometry.solarIrradiance,s.clouds.shadowTexture,s.clouds.shadowMatrix,1,s.radiometry.mieMul)};`],
  ['ocean: all cascades', `const oc=w.ocean; let t=0; return {run:()=>{for(const c of oc.cascades) c.update(w.renderer, t+=0.0001);}};`],
  ['ocean: foam', `const oc=w.ocean; return {run:()=>oc.foam.update(w.renderer, w.camera.position.x, w.camera.position.z, 0.0001, oc.params, w.env.windSpeed)};`],
  ['post: depthCopy', `const p=window.__rcPipe; const t=p.targets.get('sceneDepth',w.size.width,w.size.height,'r32f',{nearest:true}); return {run:()=>p.depthCopy.render(w.renderer,t)};`],
  ['post: prepare', `const p=window.__rcPipe; const t=p.targets.get('work1',w.size.width,w.size.height,'rgba16f'); return {run:()=>p.prepare.render(w.renderer,t)};`],
  ['post: velocity', `const p=window.__rcPipe; const t=p.targets.get('velocity',w.size.width,w.size.height,'rg16f',{nearest:true}); return {run:()=>p.velocity.render(w.renderer,t)};`],
  ['post: composite', `const p=window.__rcPipe; const t=p.targets.get('work1',w.size.width,w.size.height,'rgba16f'); return {run:()=>p.composite.render(w.renderer,t)};`],
  ['post: bloom chain', `const p=window.__rcPipe; const t=p.targets.get('work0',w.size.width,w.size.height,'rgba16f'); return {run:()=>p.bloom.render(w.renderer,t.texture,1.15)};`],
  ['post: exposure 3 passes', `const p=window.__rcPipe, ae=p.exposure; const t=p.targets; const lum=t.get('expLum',64,64,'r16f',{nearest:true}); const par=t.get('expPartial',64,32,'r16f',{nearest:true}); const res=t.get('expResult',1,1,'rgba32f',{nearest:true}); return {run:()=>{ae.lumPass.render(w.renderer,lum); ae.histPass.render(w.renderer,par); ae.resolvePass.render(w.renderer,res);}};`],
];

console.log(`============ PER-PASS GPU COST BY SLOPE  scene=${name}  1600x900 ultra ============\n`);
const rows = [];
for (const [label, factory] of TESTS) {
  if (filter && !label.includes(filter)) continue;
  const r = await slope(label, factory);
  if (r) rows.push(r);
}
console.log(`\n=== ranked, marginal GPU ms per invocation ===`);
for (const r of rows.sort((a, b) => b.slope - a.slope)) console.log(`  ${r.slope.toFixed(3).padStart(8)} ms   ${r.label}`);
await browser.close();
