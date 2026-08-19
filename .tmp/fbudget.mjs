#!/usr/bin/env node
/**
 * Itemised frame budget: every CPU module and every GPU pass, in ms.
 *
 * Method
 *  A. wall-clock ms/frame with ZERO instrumentation  (ground truth)
 *  B. CPU per module: module.update wrapped by the probe, no gl.finish, debug
 *     OFF so the sky's own serialising timers do not distort it
 *  C. GPU per post pass: pipeline profiler in syncMode (gl.finish per pass)
 *  D. GPU inside the scene pass: subtractive ablation, gl.finish bracketed
 *  E. GPU for sky/cloud passes called directly, gl.finish bracketed
 *
 * Usage: node .tmp/fbudget.mjs [scene]
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
const W = 1600, H = 900;

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--force-color-profile=srgb', '--hide-scrollbars', '--mute-audio', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: W, height: H } });
page.setDefaultTimeout(300000);
const warn = new Map();
page.on('console', (m) => {
  const t = m.text();
  let k = t.slice(0, 80);
  if (/fenced/.test(t)) k = 'ANGLE READ-usage fenced-buffer warning';
  else if (/defines/.test(t)) k = 'THREE defines undefined';
  else if (/glGetProgramiv/.test(t)) k = 'glGetProgramiv INVALID_VALUE';
  warn.set(k, (warn.get(k) ?? 0) + 1);
});
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

/* ---------- A. ground-truth wall clock ---------- */
const wall = async (ms = 4000) => page.evaluate(async (ms) => {
  const w = window.__leeward.world;
  const f0 = w.time.frame, t0 = performance.now();
  await new Promise((r) => setTimeout(r, ms));
  return (performance.now() - t0) / (w.time.frame - f0);
}, ms);

const wallClean = await wall();

/* ---------- B. CPU per module, uninstrumented engine ---------- */
const cpu = await page.evaluate(async () => {
  const eng = window.__leeward, w = eng.world;
  const mods = eng.modules;
  const acc = new Map();
  const orig = mods.map((m) => m.update.bind(m));
  mods.forEach((m, i) => {
    m.update = (world) => {
      const t = performance.now();
      orig[i](world);
      const d = performance.now() - t;
      const a = acc.get(m.name) ?? { sum: 0, n: 0, max: 0 };
      a.sum += d; a.n++; a.max = Math.max(a.max, d);
      acc.set(m.name, a);
    };
  });
  // also time the render hook
  const pipe = window.__rcPipe;
  const origRender = pipe.render.bind(pipe);
  const racc = { sum: 0, n: 0 };
  pipe.render = (world) => { const t = performance.now(); origRender(world); racc.sum += performance.now() - t; racc.n++; };

  const f0 = w.time.frame, t0 = performance.now();
  await new Promise((r) => setTimeout(r, 5000));
  const frames = w.time.frame - f0, wallMs = (performance.now() - t0) / frames;

  mods.forEach((m, i) => { m.update = orig[i]; });
  pipe.render = origRender;

  const out = {};
  for (const [k, a] of acc) out[k] = { avg: a.sum / a.n, max: a.max };
  return { out, renderHook: racc.sum / racc.n, wallMs, frames };
});

/* ---------- ocean/vfx internal breakdown (needs debug on) ---------- */
const inner = await page.evaluate(async () => {
  const w = window.__leeward.world;
  w.settings.debug = true;
  await new Promise((r) => setTimeout(r, 3000));
  const pick = (re) => Object.fromEntries(Object.entries(w.stats).filter(([k]) => re.test(k)).map(([k, v]) => [k, +Number(v).toPrecision(4)]));
  const o = { ocean: pick(/^ocean[:.]/), vfx: pick(/^vfx:/), sky: pick(/^sky:/), upd: pick(/^upd:/) };
  w.settings.debug = false;
  await new Promise((r) => setTimeout(r, 1500));
  return o;
});

/* ---------- C. post pass GPU (serialising) ---------- */
const prof = await page.evaluate(() => window.__leeward.world.ext.post.profile(150));

/* ---------- D+E. scene-pass ablation and direct sky pass benches ---------- */
const gpu = await page.evaluate(async () => {
  const w = window.__leeward.world, r = w.renderer, gl = r.getContext();
  const pipe = window.__rcPipe, sky = window.__skyDbg;
  const bench = (fn, n = 8, k = 5) => {
    const runs = [];
    for (let j = 0; j < k; j++) { fn(); const t0 = performance.now(); for (let i = 0; i < n; i++) fn(); runs.push((performance.now() - t0) / n); }
    runs.sort((a, b) => a - b);
    return +runs[Math.floor(k / 2)].toPrecision(4); // median of k
  };
  const target = pipe.targets.get('scene', w.size.width, w.size.height, 'rgba16f', { depth: true });
  const cam = w.camera;
  // The cloud march self-guards on world.time.frame, so a repeated scene render
  // does NOT re-march: this measures the scene minus the cloud passes.
  const drawScene = () => { r.setRenderTarget(target); r.clear(true, true, true); r.render(w.scene, cam); gl.finish(); };

  const res = {};
  res['finish only (floor)'] = bench(() => gl.finish(), 20, 5);
  res['scene: FULL (no cloud march)'] = bench(drawScene);

  const tops = w.scene.children.map((c, i) => ({ i, name: c.name || c.type, vis: c.visible }));
  const abl = {};
  for (const t of tops) {
    if (!t.vis) continue;
    const o = w.scene.children[t.i];
    o.visible = false;
    abl[`${t.name}`] = bench(drawScene);
    o.visible = true;
  }
  // shadow map cost
  const wasAuto = r.shadowMap.autoUpdate;
  r.shadowMap.autoUpdate = false;
  abl['[shadowMap off]'] = bench(drawScene);
  r.shadowMap.autoUpdate = wasAuto;

  // cloud passes, called directly
  const c = sky.clouds;
  const cl = {};
  cl['cloud shadow slice'] = bench(() => { c.shadowPass.render(r, c.shadow); gl.finish(); }, 10, 5);
  cl['cloud march (quarter-res)'] = bench(() => { c.marchPass.render(r, c.raw); gl.finish(); }, 10, 5);
  cl['cloud resolve (temporal)'] = bench(() => { c.resolvePass.render(r, c.history[c.current ^ 1]); gl.finish(); }, 10, 5);
  cl['cloud ALL THREE'] = bench(() => { c.lastFrame = -1; c.render(w, cam, r); gl.finish(); }, 8, 5);

  // env probe: the equirect render, and separately the PMREM three does for it
  const probe = sky.probe;
  cl['envProbe equirect render'] = bench(() => { probe.pass.render(r, probe.target); gl.finish(); }, 8, 5);
  cl['envProbe + PMREM (scene draw)'] = bench(() => {
    probe.pass.render(r, probe.target);
    probe.target.texture.needsPMREMUpdate = true;
    drawScene();
  }, 5, 5);

  // atmosphere LUTs
  cl['skyView LUT'] = bench(() => { sky.luts.updateSkyView(r, w.env.sunDirection.y, 0.03, sky.radiometry.solarIrradiance, sky.radiometry.mieMul); gl.finish(); }, 10, 5);
  cl['aerial froxel volume (16 slices)'] = bench(() => {
    sky.luts.updateAerial(r, sky.aerialMatrix, sky.camPos, w.env.sunDirection, sky.radiometry.solarIrradiance, sky.clouds.shadowTexture, sky.clouds.shadowMatrix, 1, sky.radiometry.mieMul);
    gl.finish();
  }, 6, 5);

  r.setRenderTarget(null);
  return {
    res, abl, cl,
    dc: w.stats.drawCalls, tri: w.stats.triangles, prog: w.stats.programs,
    size: [w.size.width, w.size.height],
    cloudRes: [c.width, c.height],
    vram: w.ext.post.vram(),
    settings: { cloudSteps: w.settings.cloudSteps, quality: w.settings.quality, aa: w.settings.antialias, ssr: w.settings.ssr, dof: w.settings.depthOfField, mb: w.settings.motionBlur, bloom: w.settings.bloom, volClouds: w.settings.volumetricClouds },
  };
});

/* ---------- report ---------- */
const f = (v) => (v === undefined ? '   -  ' : v.toFixed(3).padStart(7));
console.log(`\n================ FRAME BUDGET  scene=${name}  ${gpu.size[0]}x${gpu.size[1]} ultra ================`);
console.log(`wall clock, no instrumentation : ${wallClean.toFixed(2)} ms/frame  (${(1000 / wallClean).toFixed(1)} fps)`);
console.log(`wall clock, probe-wrapped      : ${cpu.wallMs.toFixed(2)} ms/frame  over ${cpu.frames} frames`);
console.log(`draw calls ${gpu.dc}  tris ${(gpu.tri / 1e6).toFixed(2)}M  programs ${gpu.prog}  cloudBuf ${gpu.cloudRes.join('x')}`);
console.log(`settings: ${JSON.stringify(gpu.settings)}`);

console.log(`\n--- A. CPU: module.update(), ms/frame (debug OFF, no finish) ---`);
const rows = Object.entries(cpu.out).sort((a, b) => b[1].avg - a[1].avg);
let cpuTotal = 0;
for (const [k, v] of rows) { cpuTotal += v.avg; if (v.avg > 0.02) console.log(`  ${k.padEnd(22)} ${f(v.avg)}   (max ${v.max.toFixed(1)})`); }
console.log(`  ${'--- module total'.padEnd(22)} ${f(cpuTotal)}`);
console.log(`  ${'renderHook (submit+GPU)'.padEnd(22)} ${f(cpu.renderHook)}`);
console.log(`  ${'=== CPU frame total'.padEnd(22)} ${f(cpuTotal + cpu.renderHook)}`);

console.log(`\n--- B. GPU: post pipeline passes, serialising (ms/frame) ---`);
let postTotal = 0;
for (const [k, v] of Object.entries(prof).sort((a, b) => b[1] - a[1])) { postTotal += v; console.log(`  ${k.padEnd(22)} ${f(v)}`); }
console.log(`  ${'=== post total'.padEnd(22)} ${f(postTotal)}`);

console.log(`\n--- C. GPU: scene-pass ablation (ms, median-of-5; lower = that object was expensive) ---`);
const base = gpu.res['scene: FULL (no cloud march)'];
console.log(`  ${'BASELINE full scene'.padEnd(34)} ${f(base)}`);
for (const [k, v] of Object.entries(gpu.abl).sort((a, b) => a[1] - b[1])) {
  console.log(`  ${('without ' + k).padEnd(34)} ${f(v)}   delta ${(base - v).toFixed(3)}`);
}
console.log(`  ${'gl.finish() floor'.padEnd(34)} ${f(gpu.res['finish only (floor)'])}`);

console.log(`\n--- D. GPU: sky + cloud passes, direct (ms) ---`);
for (const [k, v] of Object.entries(gpu.cl).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(34)} ${f(v)}`);

console.log(`\n--- E. internal stats (debug on, so these include their own finishes) ---`);
for (const g of ['ocean', 'vfx', 'sky', 'upd']) {
  const e = Object.entries(inner[g]).sort((a, b) => b[1] - a[1]);
  if (e.length) console.log(`  ${g}: ` + e.map(([k, v]) => `${k}=${v}`).join('  '));
}

console.log(`\nvram ${gpu.vram.total.toFixed(1)} MB`);
console.log(gpu.vram.targets.slice(0, 8).map((t) => `   ${t.key} ${t.w}x${t.h} ${t.kind} ${t.mb.toFixed(2)}MB`).join('\n'));
console.log(`\n--- console messages ---`);
for (const [k, v] of [...warn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${String(v).padStart(5)} x ${k}`);
await browser.close();
