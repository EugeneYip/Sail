#!/usr/bin/env node
/** Why is dawn 3x slower than noon? Interleaved ablation on frame period. */
import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--force-color-profile=srgb', '--hide-scrollbars', '--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.setDefaultTimeout(900000);
await page.addInitScript(() => { const R = window.WebSocket; class D extends EventTarget { constructor() { super(); this.readyState = 3; } send() {} close() {} } window.WebSocket = function (u, p) { return p === 'vite-hmr' ? new D() : new R(u, p); }; });
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__leeward, null, { timeout: 120000 });
await page.evaluate(() => { const w = window.__leeward.world; Object.assign(w.settings, { quality: 'ultra', adaptiveResolution: false, renderScale: 1, debug: false }); Object.assign(w.env, { timeOfDay: 5.9, windSpeed: 3.2, cloudCover: 0.3, cloudType: 0.45, turbidity: 3.4, rain: 0, visibility: 30000, seaState: 2, waveHeight: 0.6, choppiness: 0.35 }); Object.assign(w.cam, { mode: 'chase', distance: 82 }); w.bus.emit('settings:changed'); w.bus.emit('capture:scene', {}); });
await page.waitForTimeout(11000);
console.log(JSON.stringify(await page.evaluate(() => { const w = window.__leeward.world; return { sunY: +w.env.sunDirection.y.toFixed(4), sunInt: +w.uniforms.uSunIntensity.value.toFixed(4), moonInt: +w.uniforms.uMoonIntensity.value.toFixed(4), sunVisible: window.__skyDbg.light.sun.visible, exposure: +w.uniforms.uExposure.value.toFixed(3), shadowRadius: window.__skyDbg.light.sun.shadow.camera.right }; })));
await page.evaluate(() => {
  const eng = window.__leeward; const H = { per: [], collect: false, prev: 0 }; window.__H = H;
  const o = eng.tick.bind(eng);
  eng.tick = (n) => { const t0 = performance.now(); o(n); if (H.collect && H.prev) H.per.push(t0 - H.prev); H.prev = t0; };
});
const ab = async (label, setup, cycles = 3) => {
  const r = await page.evaluate(async ({ setup, cycles }) => {
    const w = window.__leeward.world, H = window.__H;
    const on = [], off = [];
    const win = async (b) => { H.per.length = 0; H.collect = true; await new Promise((r) => setTimeout(r, 2500)); H.collect = false; const s = [...H.per].sort((a, c) => a - c); if (s.length > 6) b.push([s[Math.floor(s.length * 0.25)], s[Math.floor(s.length * 0.5)]]); };
    for (let i = 0; i < cycles; i++) {
      await new Promise((r) => setTimeout(r, 400)); await win(on);
      const undo = new Function('w', setup)(w);
      await new Promise((r) => setTimeout(r, 900)); await win(off);
      if (typeof undo === 'function') undo();
    }
    const m = (a, i) => { const s = a.map((x) => x[i]).sort((x, y) => x - y); return +s[Math.floor(s.length / 2)].toFixed(1); };
    return { on25: m(on, 0), on50: m(on, 1), off25: m(off, 0), off50: m(off, 1) };
  }, { setup, cycles });
  console.log(`  ${label.padEnd(36)} p25 ${String(r.on25).padStart(6)} -> ${String(r.off25).padStart(6)} (saves ${(r.on25 - r.off25).toFixed(1)})   p50 ${String(r.on50).padStart(6)} -> ${String(r.off50).padStart(6)} (${(r.on50 - r.off50).toFixed(1)})`);
};
console.log('\n==== DAWN ablation (rAF cap 16.6) ====');
await ab('shadowMap.autoUpdate off', `w.renderer.shadowMap.autoUpdate=false; return ()=>{w.renderer.shadowMap.autoUpdate=true;};`);
await ab('cloud shaft march off (uShafts=0)', `const c=window.__skyDbg.clouds; const o=c.marchPass.uniforms.uShafts.value; c.marchPass.uniforms.uShafts.value=0; return ()=>{c.marchPass.uniforms.uShafts.value=o;};`);
await ab('cloud render off', `const c=window.__skyDbg.clouds,o=c.render.bind(c); c.render=()=>{}; return ()=>{c.render=o;};`);
await ab('aerial froxel off', `const l=window.__skyDbg.luts,o=l.updateAerial.bind(l); l.updateAerial=()=>{}; return ()=>{l.updateAerial=o;};`);
await ab('skyView LUT off', `const l=window.__skyDbg.luts,o=l.updateSkyView.bind(l); l.updateSkyView=()=>false; return ()=>{l.updateSkyView=o;};`);
await ab('EnvProbe off', `const p=window.__skyDbg.probe,o=p.update.bind(p); p.update=()=>false; return ()=>{p.update=o;};`);
await ab('hide sky mesh', `const o=w.scene.getObjectByName('sky'); o.visible=false; return ()=>{o.visible=true;};`);
await ab('hide ocean', `const o=w.scene.children.find(c=>/ocean/i.test(c.name)); o.visible=false; return ()=>{o.visible=true;};`);
await ab('ocean module off', `const m=window.__leeward.modules.find(x=>x.name==='ocean'); const o=m.update.bind(m); m.update=()=>{}; return ()=>{m.update=o;};`);
await ab('vfx module off', `const m=window.__leeward.modules.find(x=>x.name==='vfx'); const o=m.update.bind(m); m.update=()=>{}; return ()=>{m.update=o;};`);
await ab('world module off', `const m=window.__leeward.modules.find(x=>x.name==='world'); const o=m.update.bind(m); m.update=()=>{}; return ()=>{m.update=o;};`);
await browser.close();
