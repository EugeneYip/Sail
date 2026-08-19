#!/usr/bin/env node
/**
 * Honest frame attribution: wall-clock A/B in the LIVE rAF loop.
 *
 * EXT_disjoint_timer_query on ANGLE/Metal returns the whole command buffer's
 * duration for any sub-region (a 1-tap blit "costs" 35 ms), and gl.finish()
 * micro-benching in a tight synchronous loop drifts by 60x. Neither can be
 * trusted here. Subtractive wall-clock over multi-second windows can.
 *
 * Baseline is re-measured every few tests so drift is visible rather than
 * silently folded into the deltas.
 *
 *   node .tmp/wallab.mjs [scene]
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

const measure = async (label, setup) => {
  const ms = await page.evaluate(async ({ setup }) => {
    const w = window.__leeward.world;
    // eslint-disable-next-line no-new-func
    const undo = new Function('w', setup)(w);
    await new Promise((r) => setTimeout(r, 1400));
    const f0 = w.time.frame, t0 = performance.now();
    await new Promise((r) => setTimeout(r, 3600));
    const v = (performance.now() - t0) / (w.time.frame - f0);
    if (typeof undo === 'function') undo();
    await new Promise((r) => setTimeout(r, 900));
    return v;
  }, { setup });
  return { label, ms };
};

const out = [];
let baseline = 0;
const TESTS = [
  ['-- resolution --', null],
  ['renderScale 0.71 (half the pixels)', `w.settings.renderScale=0.7071; w.bus.emit('settings:changed'); return ()=>{w.settings.renderScale=1; w.bus.emit('settings:changed');};`],
  ['renderScale 0.5 (quarter the pixels)', `w.settings.renderScale=0.5; w.bus.emit('settings:changed'); return ()=>{w.settings.renderScale=1; w.bus.emit('settings:changed');};`],
  ['-- scene objects --', null],
  ['hide ocean', `const o=w.scene.getObjectByName('ocean')||w.scene.children.find(c=>/ocean/i.test(c.name)); if(!o) return null; o.visible=false; return ()=>{o.visible=true;};`],
  ['hide sky mesh', `const o=w.scene.getObjectByName('sky'); if(!o) return null; o.visible=false; return ()=>{o.visible=true;};`],
  ['hide shipRoot', `const o=w.shipRoot; o.visible=false; return ()=>{o.visible=true;};`],
  ['hide everything except sky+ocean', `const keep=new Set(['sky','ocean']); const hid=w.scene.children.filter(c=>c.visible&&!keep.has(c.name)); for(const c of hid) c.visible=false; return ()=>{for(const c of hid) c.visible=true;};`],
  ['hide ALL scene children (post only)', `const hid=w.scene.children.filter(c=>c.visible); for(const c of hid) c.visible=false; return ()=>{for(const c of hid) c.visible=true;};`],
  ['-- sky / clouds --', null],
  ['volumetricClouds off', `w.settings.volumetricClouds=false; w.bus.emit('settings:changed'); return ()=>{w.settings.volumetricClouds=true; w.bus.emit('settings:changed');};`],
  ['cloud march+resolve skipped', `const c=window.__skyDbg.clouds, o=c.render.bind(c); c.render=()=>{}; return ()=>{c.render=o;};`],
  ['cloud shadow slice skipped', `const c=window.__skyDbg.clouds, p=c.shadowPass, o=p.render.bind(p); p.render=()=>{}; return ()=>{p.render=o;};`],
  ['cloudSteps 80 -> 24', `const c=window.__skyDbg.clouds; const o=c.marchPass.uniforms.uSteps.value; c.marchPass.uniforms.uSteps.value=24; return ()=>{c.marchPass.uniforms.uSteps.value=o;};`],
  ['EnvProbe off entirely', `const p=window.__skyDbg.probe,o=p.update.bind(p); p.update=()=>false; return ()=>{p.update=o;};`],
  ['EnvProbe renders, PMREM suppressed', `const p=window.__skyDbg.probe,o=p.update.bind(p); p.update=(wd,f)=>{const b=p.target.texture.needsPMREMUpdate; const r=o(wd,f); p.target.texture.needsPMREMUpdate=b; return r;}; return ()=>{p.update=o;};`],
  ['aerial froxel LUT off', `const l=window.__skyDbg.luts,o=l.updateAerial.bind(l); l.updateAerial=()=>{}; return ()=>{l.updateAerial=o;};`],
  ['skyView LUT off', `const l=window.__skyDbg.luts,o=l.updateSkyView.bind(l); l.updateSkyView=()=>{}; return ()=>{l.updateSkyView=o;};`],
  ['-- post --', null],
  ['exposure meter off', `const a=window.__rcPipe.exposure,o=a.meter.bind(a); a.meter=()=>{}; return ()=>{a.meter=o;};`],
  ['exposure readback off (passes stay)', `const a=window.__rcPipe.exposure,o=a.readback.bind(a); a.readback=()=>{}; return ()=>{a.readback=o;};`],
  ['bloom off', `w.settings.bloom=false; w.bus.emit('settings:changed'); return ()=>{w.settings.bloom=true; w.bus.emit('settings:changed');};`],
  ['dof off', `w.settings.depthOfField=false; w.bus.emit('settings:changed'); return ()=>{w.settings.depthOfField=true; w.bus.emit('settings:changed');};`],
  ['motionBlur off', `w.settings.motionBlur=false; w.bus.emit('settings:changed'); return ()=>{w.settings.motionBlur=true; w.bus.emit('settings:changed');};`],
  ['antialias taa -> off', `const o=w.settings.antialias; w.settings.antialias='off'; w.bus.emit('settings:changed'); return ()=>{w.settings.antialias=o; w.bus.emit('settings:changed');};`],
  ['depthCopy off', `const p=window.__rcPipe.depthCopy,o=p.render.bind(p); p.render=()=>{}; return ()=>{p.render=o;};`],
  ['-- other subsystems --', null],
  ['ocean module update skipped', `const m=window.__leeward.modules.find(x=>x.name==='ocean'); const o=m.update.bind(m); m.update=()=>{}; return ()=>{m.update=o;};`],
  ['vfx module update skipped', `const m=window.__leeward.modules.find(x=>x.name==='vfx'); const o=m.update.bind(m); m.update=()=>{}; return ()=>{m.update=o;};`],
  ['shadowMap.autoUpdate off', `const a=w.renderer.shadowMap.autoUpdate; w.renderer.shadowMap.autoUpdate=false; return ()=>{w.renderer.shadowMap.autoUpdate=a;};`],
  ['shadowMap.enabled off', `const a=w.renderer.shadowMap.enabled; w.renderer.shadowMap.enabled=false; return ()=>{w.renderer.shadowMap.enabled=a;};`],
];

console.log(`================ WALL-CLOCK ABLATION  scene=${name}  1600x900 ultra ================`);
let sinceBase = 99;
for (const [label, setup] of TESTS) {
  if (setup === null) { console.log(`\n${label}`); continue; }
  if (sinceBase >= 4) {
    const b = await measure('BASELINE', 'return null;');
    baseline = b.ms;
    console.log(`  ${'BASELINE'.padEnd(38)} ${b.ms.toFixed(1).padStart(7)} ms  ${(1000 / b.ms).toFixed(1).padStart(5)} fps`);
    sinceBase = 0;
  }
  const r = await measure(label, setup);
  sinceBase++;
  const saved = baseline - r.ms;
  out.push({ label, ms: r.ms, saved });
  console.log(`  ${label.padEnd(38)} ${r.ms.toFixed(1).padStart(7)} ms  ${(1000 / r.ms).toFixed(1).padStart(5)} fps   saves ${saved >= 0 ? '+' : ''}${saved.toFixed(1)} ms`);
}

console.log(`\n=== ranked by ms saved ===`);
for (const r of out.sort((a, b) => b.saved - a.saved)) {
  if (Math.abs(r.saved) < 0.8) continue;
  console.log(`  ${r.saved >= 0 ? '+' : ''}${r.saved.toFixed(1).padStart(7)} ms   ${r.label}`);
}
await browser.close();
