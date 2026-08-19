#!/usr/bin/env node
/**
 * Frame attribution that survives a loaded machine.
 *
 * ONE EXT_disjoint_timer_query around the WHOLE engine tick gives total GPU ms
 * per frame. That number barely moves when the CPU is oversubscribed, unlike
 * wall clock. Each feature is then toggled ON/OFF/ON/OFF... in ~0.9 s windows
 * so slow drift cancels; the reported delta is median(ON) - median(OFF).
 *
 *   node .tmp/gpuab.mjs [scene] [only-substring]
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
const only = process.argv[3] ?? '';

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--force-color-profile=srgb', '--hide-scrollbars', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.setDefaultTimeout(900000);
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

/* whole-tick GPU timer */
await page.evaluate(() => {
  const eng = window.__leeward, w = eng.world, gl = w.renderer.getContext();
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const pend = [];
  const fq = { ms: [], wall: [], collect: false, last: performance.now() };
  window.__fq = fq;
  const poll = () => {
    for (let i = pend.length - 1; i >= 0; i--) {
      const q = pend[i];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) continue;
      const dis = gl.getParameter(ext.GPU_DISJOINT_EXT);
      const ns = gl.getQueryParameter(q, gl.QUERY_RESULT);
      gl.deleteQuery(q); pend.splice(i, 1);
      if (!dis && fq.collect) fq.ms.push(ns / 1e6);
    }
  };
  const o = eng.tick.bind(eng);
  eng.tick = (now) => {
    poll();
    const t = performance.now();
    if (fq.collect) fq.wall.push(t - fq.last);
    fq.last = t;
    const q = gl.createQuery();
    gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
    o(now);
    gl.endQuery(ext.TIME_ELAPSED_EXT);
    pend.push(q);
  };
});

const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };

/** Alternate ON/OFF `cycles` times, `winMs` each, return {on, off} medians. */
const ab = async (setup, cycles = 5, winMs = 900) => {
  const res = await page.evaluate(async ({ setup, cycles, winMs }) => {
    const w = window.__leeward.world, fq = window.__fq;
    const on = [], off = [], onW = [], offW = [];
    const sample = async (bucket, bucketW) => {
      fq.ms.length = 0; fq.wall.length = 0; fq.collect = true;
      await new Promise((r) => setTimeout(r, winMs));
      fq.collect = false;
      const s = [...fq.ms].sort((a, b) => a - b), sw = [...fq.wall].sort((a, b) => a - b);
      if (s.length) bucket.push(s[Math.floor(s.length / 2)]);
      if (sw.length) bucketW.push(sw[Math.floor(sw.length / 2)]);
    };
    for (let i = 0; i < cycles; i++) {
      await new Promise((r) => setTimeout(r, 350));
      await sample(on, onW);
      // eslint-disable-next-line no-new-func
      const undo = new Function('w', setup)(w);
      await new Promise((r) => setTimeout(r, 500));
      await sample(off, offW);
      if (typeof undo === 'function') undo();
    }
    const m = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
    return { on: m(on), off: m(off), onW: m(onW), offW: m(offW), n: on.length };
  }, { setup, cycles, winMs });
  return res;
};

const TESTS = [
  ['renderScale 0.5 (1/4 pixels)', `w.settings.renderScale=0.5; w.bus.emit('settings:changed'); return ()=>{w.settings.renderScale=1; w.bus.emit('settings:changed');};`],
  ['hide ALL scene children', `const h=w.scene.children.filter(c=>c.visible); for(const c of h) c.visible=false; return ()=>{for(const c of h) c.visible=true;};`],
  ['hide ocean', `const o=w.scene.children.find(c=>/ocean/i.test(c.name)); if(!o) return null; o.visible=false; return ()=>{o.visible=true;};`],
  ['hide sky mesh', `const o=w.scene.getObjectByName('sky'); if(!o) return null; o.visible=false; return ()=>{o.visible=true;};`],
  ['hide shipRoot', `w.shipRoot.visible=false; return ()=>{w.shipRoot.visible=true;};`],
  ['shadowMap.autoUpdate=false', `w.renderer.shadowMap.autoUpdate=false; return ()=>{w.renderer.shadowMap.autoUpdate=true;};`],
  ['cloud march+resolve+shadow off', `const c=window.__skyDbg.clouds,o=c.render.bind(c); c.render=()=>{}; return ()=>{c.render=o;};`],
  ['cloud shadow slice only off', `const p=window.__skyDbg.clouds.shadowPass,o=p.render.bind(p); p.render=()=>{}; return ()=>{p.render=o;};`],
  ['cloud march only off', `const p=window.__skyDbg.clouds.marchPass,o=p.render.bind(p); p.render=()=>{}; return ()=>{p.render=o;};`],
  ['cloud resolve only off', `const p=window.__skyDbg.clouds.resolvePass,o=p.render.bind(p); p.render=()=>{}; return ()=>{p.render=o;};`],
  ['cloudSteps 80 -> 24', `const c=window.__skyDbg.clouds; const o=c.marchPass.uniforms.uSteps.value; c.marchPass.uniforms.uSteps.value=24; return ()=>{c.marchPass.uniforms.uSteps.value=o;};`],
  ['EnvProbe off (render+PMREM)', `const p=window.__skyDbg.probe,o=p.update.bind(p); p.update=()=>false; return ()=>{p.update=o;};`],
  ['EnvProbe PMREM suppressed only', `const p=window.__skyDbg.probe,o=p.update.bind(p); p.update=(a,b)=>{const q=p.target.texture.needsPMREMUpdate; const r=o(a,b); p.target.texture.needsPMREMUpdate=q; return r;}; return ()=>{p.update=o;};`],
  ['aerial froxel LUT off', `const l=window.__skyDbg.luts,o=l.updateAerial.bind(l); l.updateAerial=()=>{}; return ()=>{l.updateAerial=o;};`],
  ['skyView LUT off', `const l=window.__skyDbg.luts,o=l.updateSkyView.bind(l); l.updateSkyView=()=>{}; return ()=>{l.updateSkyView=o;};`],
  ['exposure meter (3 passes) off', `const a=window.__rcPipe.exposure,o=a.meter.bind(a); a.meter=()=>{}; return ()=>{a.meter=o;};`],
  ['exposure readback only off', `const a=window.__rcPipe.exposure,o=a.readback.bind(a); a.readback=()=>{}; return ()=>{a.readback=o;};`],
  ['bloom off', `w.settings.bloom=false; w.bus.emit('settings:changed'); return ()=>{w.settings.bloom=true; w.bus.emit('settings:changed');};`],
  ['dof off', `w.settings.depthOfField=false; w.bus.emit('settings:changed'); return ()=>{w.settings.depthOfField=true; w.bus.emit('settings:changed');};`],
  ['motionBlur off', `w.settings.motionBlur=false; w.bus.emit('settings:changed'); return ()=>{w.settings.motionBlur=true; w.bus.emit('settings:changed');};`],
  ['taa off', `const o=w.settings.antialias; w.settings.antialias='off'; w.bus.emit('settings:changed'); return ()=>{w.settings.antialias=o; w.bus.emit('settings:changed');};`],
  ['depthCopy off', `const p=window.__rcPipe.depthCopy,o=p.render.bind(p); p.render=()=>{}; return ()=>{p.render=o;};`],
  ['ocean update off', `const m=window.__leeward.modules.find(x=>x.name==='ocean'); const o=m.update.bind(m); m.update=()=>{}; return ()=>{m.update=o;};`],
  ['ocean cascades only off', `const oc=w.ocean; const cs=oc.cascades.map(c=>[c,c.update.bind(c)]); for(const [c] of cs) c.update=()=>{}; return ()=>{for(const [c,o] of cs) c.update=o;};`],
  ['ocean foam only off', `const f=w.ocean.foam,o=f.update.bind(f); f.update=()=>{}; return ()=>{f.update=o;};`],
  ['vfx update off', `const m=window.__leeward.modules.find(x=>x.name==='vfx'); const o=m.update.bind(m); m.update=()=>{}; return ()=>{m.update=o;};`],
];

console.log(`============ GPU-TIMER A/B  scene=${name}  1600x900 ultra ============`);
console.log(`(whole-tick TIME_ELAPSED query; ON = as shipped, OFF = feature removed)\n`);
console.log(`  ${'test'.padEnd(34)} ${'GPU on'.padStart(8)} ${'GPU off'.padStart(8)} ${'dGPU'.padStart(8)}   ${'wall on'.padStart(8)} ${'wall off'.padStart(8)}`);
const rows = [];
for (const [label, setup] of TESTS) {
  if (only && !label.includes(only)) continue;
  const r = await ab(setup);
  const d = r.on - r.off;
  rows.push({ label, d, on: r.on, off: r.off });
  console.log(`  ${label.padEnd(34)} ${r.on.toFixed(2).padStart(8)} ${r.off.toFixed(2).padStart(8)} ${d.toFixed(2).padStart(8)}   ${r.onW.toFixed(1).padStart(8)} ${r.offW.toFixed(1).padStart(8)}`);
}
console.log(`\n=== ranked: GPU ms attributable to each feature ===`);
for (const r of rows.sort((a, b) => b.d - a.d)) console.log(`  ${r.d.toFixed(2).padStart(8)} ms   ${r.label}`);
await browser.close();
