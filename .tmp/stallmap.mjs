#!/usr/bin/env node
/**
 * Is the storm p95/max tail ONE shared stall, or four independent module bugs?
 *
 * DIAGNOSIS.md section 16 records that ocean, vfx, sky and weather all show
 * 50-155 ms maxima in the SAME storm run, and warns each owner not to optimise
 * their own p95 before checking whether it is really theirs. This decides it.
 *
 * Engine.tick already writes world.stats['upd:<module>'] per frame when
 * settings.debug is on. This samples every one of those, plus the frame period,
 * plus the JS heap size, for every frame of a long storm run, and then asks:
 *
 *   - in the slowest frames, is ONE module elevated, and is it the SAME module
 *     every time?  -> a real per-module bug
 *   - is the elevated module DIFFERENT every time, or is the overage in 'rest'
 *     (render + browser), or does the heap DROP on that frame?
 *     -> one shared pause (GC / compile) landing wherever it falls
 *
 * 'rest' = frame period - sum(all module updates). It contains the scene render,
 * the post chain, compositing, and any pause the browser took outside our code.
 *
 *   node .tmp/stallmap.mjs [scene] [frames]
 */
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';

const scene = process.argv[2] ?? 'storm';
const FRAMES = Number(process.argv[3] ?? 900);
const SCENES = {
  noon: { timeOfDay: 12.7, windSpeed: 10.5, cloudCover: 0.38, cloudType: 0.8, turbidity: 2.0, rain: 0, visibility: 34000, seaState: 4, waveHeight: 2.0, choppiness: 0.6 },
  storm: { timeOfDay: 15.0, windSpeed: 22.0, cloudCover: 0.98, cloudType: 0.95, turbidity: 6.0, rain: 0.85, visibility: 5200, seaState: 7, waveHeight: 6.5, choppiness: 0.85 },
};

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader',
    '--force-color-profile=srgb', '--hide-scrollbars', '--mute-audio', '--enable-precise-memory-info'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(300000);
await page.addInitScript(() => {
  const Real = window.WebSocket;
  class Dead { constructor() { this.readyState = 3; this.close = () => {}; this.send = () => {}; this.addEventListener = () => {}; this.removeEventListener = () => {}; } }
  window.WebSocket = function (u, p) { return p === 'vite-hmr' ? new Dead() : new Real(u, p); };
  window.WebSocket.prototype = Real.prototype;
});
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded', timeout: 300000 });
await page.waitForFunction(() => !!window.__leeward, null, { timeout: 300000 });
await page.evaluate((env) => {
  const w = window.__leeward.world;
  w.settings.quality = 'ultra';
  w.settings.adaptiveResolution = false;
  w.settings.renderScale = 1;
  w.settings.showHud = false;
  w.settings.debug = true;          // enables the per-module upd: stats
  Object.assign(w.env, env);
  w.cam.mode = 'chase';
  w.cam.distance = 70;
  w.bus.emit('settings:changed');
}, SCENES[scene]);
await page.waitForTimeout(12000);

/**
 * A/B the instrumentation itself, in ONE page, back to back, so machine load
 * cannot explain the difference: `settings.debug` is the only thing that
 * changes, and it is what enables AutoExposure.reconcile()'s synchronous
 * readRenderTargetPixels every DEBUG_READBACK_INTERVAL (=60) frames.
 */
const ab = async (dbg, N) => {
  await page.evaluate((d) => { window.__leeward.world.settings.debug = d; }, dbg);
  await page.waitForTimeout(800);
  const rows = await page.evaluate((n) => new Promise((resolve) => {
    const out = [];
    let last = performance.now();
    const step = () => {
      const now = performance.now();
      out.push(+(now - last).toFixed(2));
      last = now;
      if (out.length < n) requestAnimationFrame(step);
      else resolve(out);
    };
    requestAnimationFrame(step);
  }), N);
  const s = [...rows].sort((a, b) => a - b);
  const q = (f) => s[Math.min(s.length - 1, Math.floor(s.length * f))];
  const over = rows.filter((x) => x > 100).length;
  console.log(`  debug=${String(dbg).padEnd(5)} p25 ${q(0.25).toFixed(1).padStart(6)}  p50 ${q(0.5).toFixed(1).padStart(6)}  p75 ${q(0.75).toFixed(1).padStart(6)}  p95 ${q(0.95).toFixed(1).padStart(6)}  max ${s[s.length - 1].toFixed(1).padStart(6)}  frames>100ms ${over}/${rows.length}`);
  return rows;
};
if (process.env.SM_AB) {
  console.log(`\nA/B of settings.debug — scene=${scene}, one page, back to back`);
  await ab(true, 400); await ab(false, 400); await ab(true, 400); await ab(false, 400);
  await browser.close();
  process.exit(0);
}

const data = await page.evaluate((N) => new Promise((resolve) => {
  const w = window.__leeward.world;
  const rows = [];
  let last = performance.now();
  const step = () => {
    const now = performance.now();
    const s = w.stats;
    const mods = {};
    for (const k in s) if (k.startsWith('upd:')) mods[k.slice(4)] = +s[k].toFixed(2);
    rows.push({
      p: +(now - last).toFixed(2),
      mods,
      heap: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : -1,
    });
    last = now;
    if (rows.length < N) requestAnimationFrame(step);
    else resolve(rows);
  };
  requestAnimationFrame(step);
}), FRAMES);

const per = data.map((r) => r.p).sort((a, b) => a - b);
const q = (f) => per[Math.min(per.length - 1, Math.floor(per.length * f))];
const names = [...new Set(data.flatMap((r) => Object.keys(r.mods)))];
console.log(`scene=${scene} frames=${data.length}`);
console.log(`period  p25 ${q(0.25).toFixed(1)}  p50 ${q(0.5).toFixed(1)}  p75 ${q(0.75).toFixed(1)}  p95 ${q(0.95).toFixed(1)}  max ${per[per.length - 1].toFixed(1)} ms`);

console.log('\nper-module update cost (ms)');
console.log('  module        mean    p50    p95    max   frames>25ms');
for (const n of names) {
  const v = data.map((r) => r.mods[n] ?? 0).sort((a, b) => a - b);
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const big = v.filter((x) => x > 25).length;
  console.log(`  ${n.padEnd(12)}${mean.toFixed(2).padStart(6)}${v[Math.floor(v.length * 0.5)].toFixed(2).padStart(7)}${v[Math.floor(v.length * 0.95)].toFixed(2).padStart(7)}${v[v.length - 1].toFixed(2).padStart(7)}${String(big).padStart(9)}`);
}
const rest = data.map((r) => r.p - Object.values(r.mods).reduce((a, b) => a + b, 0));
const rs = [...rest].sort((a, b) => a - b);
console.log(`  ${'rest(render)'.padEnd(12)}${(rs.reduce((a, b) => a + b, 0) / rs.length).toFixed(2).padStart(6)}${rs[Math.floor(rs.length * 0.5)].toFixed(2).padStart(7)}${rs[Math.floor(rs.length * 0.95)].toFixed(2).padStart(7)}${rs[rs.length - 1].toFixed(2).padStart(7)}${String(rs.filter((x) => x > 25).length).padStart(9)}`);

// Slowest frames: who owns the overage?
const idx = data.map((_, i) => i).sort((a, b) => data[b].p - data[a].p).slice(0, 14);
console.log('\nslowest 14 frames — period, heap(MB), heapDelta, and the module overage');
for (const i of idx.sort((a, b) => a - b)) {
  const r = data[i];
  const top = Object.entries(r.mods).sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([k, v]) => `${k}=${v.toFixed(1)}`).join(' ');
  const dh = i > 0 ? r.heap - data[i - 1].heap : 0;
  console.log(`  f${String(i).padStart(4)}  ${r.p.toFixed(1).padStart(7)} ms  heap ${String(r.heap).padStart(4)}  d${String(dh).padStart(4)}  rest=${rest[i].toFixed(1).padStart(6)}  ${top}`);
}
// Which module is the largest single contributor in each slow frame?
const own = {};
for (const i of data.map((_, k) => k).filter((k) => data[k].p > q(0.95))) {
  const e = Object.entries(data[i].mods).sort((a, b) => b[1] - a[1])[0];
  const who = rest[i] > (e?.[1] ?? 0) ? 'rest(render)' : e[0];
  own[who] = (own[who] ?? 0) + 1;
}
console.log('\nin frames slower than p95, the largest single contributor was:');
for (const [k, v] of Object.entries(own).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(14)}${v}`);
const heaps = data.map((r) => r.heap);
console.log(`\nheap ${Math.min(...heaps)} -> ${Math.max(...heaps)} MB, ${heaps.filter((h, i) => i > 0 && h < heaps[i - 1] - 4).length} drops >4MB (GC events)`);
await writeFile(`/tmp/stallmap-${scene}.json`, JSON.stringify(data));
await browser.close();
