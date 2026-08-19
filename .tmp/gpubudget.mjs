#!/usr/bin/env node
/**
 * Trustworthy itemised frame budget using EXT_disjoint_timer_query_webgl2.
 *
 * Real GPU timers, taken in the LIVE rAF loop (no gl.finish, no tight
 * synchronous bench loop), so nothing distorts the pipeline. TIME_ELAPSED
 * queries cannot nest, so coarse and fine regions are measured in separate runs.
 *
 *   node .tmp/gpubudget.mjs [scene] [--ablate]
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
const doAblate = process.argv.includes('--ablate');

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--force-color-profile=srgb', '--hide-scrollbars', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.setDefaultTimeout(600000);
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

/* ---- install the timer harness ---- */
await page.evaluate(() => {
  const w = window.__leeward.world, r = w.renderer, gl = r.getContext();
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const pending = [];
  const stats = new Map();
  let active = null;
  const gt = {
    ext, exclude: new Set(), enabled: false,
    begin(n) { if (!gt.enabled || active || gt.exclude.has(n)) return; const q = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, q); active = n; pending.push({ q, n }); },
    end() { if (!active) return; gl.endQuery(ext.TIME_ELAPSED_EXT); active = null; },
    poll() {
      for (let i = pending.length - 1; i >= 0; i--) {
        const e = pending[i];
        if (!gl.getQueryParameter(e.q, gl.QUERY_RESULT_AVAILABLE)) continue;
        const dis = gl.getParameter(ext.GPU_DISJOINT_EXT);
        const ns = gl.getQueryParameter(e.q, gl.QUERY_RESULT);
        gl.deleteQuery(e.q); pending.splice(i, 1);
        if (dis) continue;
        const s = stats.get(e.n) ?? { sum: 0, n: 0, max: 0 };
        s.sum += ns / 1e6; s.n++; s.max = Math.max(s.max, ns / 1e6); stats.set(e.n, s);
      }
    },
    reset() { stats.clear(); },
    report(frames) {
      const o = {};
      for (const [k, s] of stats) o[k] = { perFrame: +(s.sum / Math.max(1, frames)).toFixed(3), perCall: +(s.sum / s.n).toFixed(3), calls: s.n, max: +s.max.toFixed(2) };
      return o;
    },
  };
  window.__gt = gt;

  const wrap = (obj, key, label) => {
    if (!obj || typeof obj[key] !== 'function') return null;
    const o = obj[key].bind(obj);
    obj[key] = (...a) => { gt.begin(label); const v = o(...a); gt.end(); return v; };
    return () => { obj[key] = o; };
  };
  const pipe = window.__rcPipe, sky = window.__skyDbg;
  const mods = window.__leeward.modules;
  const m = (n) => mods.find((x) => x.name === n);
  window.__undo = [
    wrap(r, 'render', 'scene'),
    wrap(pipe.depthCopy, 'render', 'post:depthCopy'),
    wrap(pipe.exposure, 'meter', 'post:exposureMeter'),
    wrap(pipe.prepare, 'render', 'post:prepare'),
    wrap(pipe.velocity, 'render', 'post:velocity'),
    wrap(pipe.aa, 'render', 'post:aa'),
    wrap(pipe.dof, 'render', 'post:dof'),
    wrap(pipe.motionBlur, 'render', 'post:motionBlur'),
    wrap(pipe.bloom, 'render', 'post:bloom'),
    wrap(pipe.composite, 'render', 'post:composite'),
    wrap(m('ocean'), 'update', 'upd:ocean'),
    wrap(m('sky'), 'update', 'upd:sky'),
    wrap(m('vfx'), 'update', 'upd:vfx'),
    wrap(m('world'), 'update', 'upd:world'),
    wrap(m('ship'), 'update', 'upd:ship'),
    wrap(sky.clouds, 'render', 'cloud:all'),
    wrap(sky.clouds.shadowPass, 'render', 'cloud:shadow'),
    wrap(sky.clouds.marchPass, 'render', 'cloud:march'),
    wrap(sky.clouds.resolvePass, 'render', 'cloud:resolve'),
    wrap(sky.probe, 'update', 'sky:envProbe'),
    wrap(sky.luts, 'updateSkyView', 'sky:skyViewLUT'),
    wrap(sky.luts, 'updateAerial', 'sky:aerialLUT'),
    wrap(sky.luts, 'stepBake', 'sky:bakeLUT'),
  ].filter(Boolean);

  // poll once per frame from the tail of the render hook
  const pr = pipe.render.bind(pipe);
  pipe.render = (world) => { pr(world); gt.poll(); };
});

const run = async (exclude, ms, label) => {
  const out = await page.evaluate(async ({ exclude, ms }) => {
    const w = window.__leeward.world, gt = window.__gt;
    gt.exclude = new Set(exclude); gt.reset(); gt.enabled = true;
    await new Promise((r) => setTimeout(r, 600));
    gt.reset();
    const f0 = w.time.frame, t0 = performance.now();
    await new Promise((r) => setTimeout(r, ms));
    const frames = w.time.frame - f0, wall = (performance.now() - t0) / frames;
    await new Promise((r) => setTimeout(r, 400));
    gt.poll();
    const rep = gt.report(frames);
    gt.enabled = false;
    return { rep, wall: +wall.toFixed(2), frames };
  }, { exclude, ms });
  console.log(`\n--- ${label} --- wall ${out.wall} ms/frame (${(1000 / out.wall).toFixed(1)} fps) over ${out.frames} frames`);
  const rows = Object.entries(out.rep).sort((a, b) => b[1].perFrame - a[1].perFrame);
  let tot = 0;
  for (const [k, v] of rows) { tot += v.perFrame; console.log(`  ${k.padEnd(22)} ${String(v.perFrame).padStart(8)} ms/frame   ${String(v.perCall).padStart(8)} ms/call  n=${v.calls}  max ${v.max}`); }
  console.log(`  ${'SUM of timed regions'.padEnd(22)} ${tot.toFixed(3).padStart(8)} ms/frame     unaccounted ${(out.wall - tot).toFixed(2)} ms`);
  return out;
};

console.log(`================ GPU TIMER BUDGET  scene=${name}  1600x900 ultra ================`);
const coarse = await run(['cloud:all', 'cloud:shadow', 'cloud:march', 'cloud:resolve', 'sky:envProbe', 'sky:skyViewLUT', 'sky:aerialLUT', 'sky:bakeLUT'], 6000, 'RUN A: coarse regions');
const fine = await run(['scene', 'upd:sky', 'cloud:all'], 6000, 'RUN B: sky + cloud sub-passes (scene region disabled)');
const fine2 = await run(['scene', 'upd:sky', 'cloud:shadow', 'cloud:march', 'cloud:resolve'], 5000, 'RUN C: cloud total + sky LUTs');

if (doAblate) {
  console.log(`\n=== RUN D: scene-pass ablation, GPU timer on 'scene' only, live loop ===`);
  const tops = await page.evaluate(() => window.__leeward.world.scene.children.map((c, i) => ({ i, name: c.name || c.type, vis: c.visible, kids: c.children.length })));
  console.log(tops.map((t) => `  [${t.i}] ${t.name} (${t.kids} kids)${t.vis ? '' : ' HIDDEN'}`).join('\n'));
  const measureScene = async (setup, label) => {
    const out = await page.evaluate(async ({ setup }) => {
      const w = window.__leeward.world, gt = window.__gt;
      // eslint-disable-next-line no-new-func
      const undo = new Function('w', setup)(w);
      gt.exclude = new Set(['cloud:all', 'cloud:shadow', 'cloud:march', 'cloud:resolve', 'sky:envProbe', 'sky:skyViewLUT', 'sky:aerialLUT', 'sky:bakeLUT']);
      gt.reset(); gt.enabled = true;
      await new Promise((r) => setTimeout(r, 900));
      gt.reset();
      const f0 = w.time.frame, t0 = performance.now();
      await new Promise((r) => setTimeout(r, 3000));
      const frames = w.time.frame - f0, wall = (performance.now() - t0) / frames;
      await new Promise((r) => setTimeout(r, 400)); gt.poll();
      const rep = gt.report(frames); gt.enabled = false;
      if (typeof undo === 'function') undo();
      await new Promise((r) => setTimeout(r, 500));
      return { scene: rep['scene']?.perFrame ?? 0, wall: +wall.toFixed(1) };
    }, { setup });
    console.log(`  ${label.padEnd(40)} scene ${String(out.scene).padStart(7)} ms   wall ${String(out.wall).padStart(6)} ms`);
    return out;
  };
  const b = await measureScene('return null;', 'BASELINE');
  for (const t of tops) {
    if (!t.vis) continue;
    await measureScene(`const o=w.scene.children[${t.i}]; o.visible=false; return ()=>{o.visible=true;};`, `hide [${t.i}] ${t.name}`);
  }
  await measureScene(`const a=w.renderer.shadowMap.autoUpdate; w.renderer.shadowMap.autoUpdate=false; return ()=>{w.renderer.shadowMap.autoUpdate=a;};`, 'shadowMap.autoUpdate=false');
  await measureScene(`const p=window.__skyDbg.probe, o=p.update.bind(p); p.update=()=>false; return ()=>{p.update=o;};`, 'EnvProbe off (no PMREM)');
  await measureScene(`w.settings.volumetricClouds=false; w.bus.emit('settings:changed'); return ()=>{w.settings.volumetricClouds=true; w.bus.emit('settings:changed');};`, 'volumetricClouds off');
  console.log(`  baseline scene was ${b.scene} ms`);
}

await browser.close();
