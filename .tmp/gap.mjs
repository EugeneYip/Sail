#!/usr/bin/env node
/**
 * Frame-period decomposition: how much of the frame is our tick, and how much
 * is the browser not calling us back?
 *
 *   period = tick + gap        (gap = rAF scheduling + compositing + present)
 *
 * Also reports the tick-time DISTRIBUTION, because the exposure readback makes
 * it bimodal and a mean hides that completely.
 */
import { chromium } from 'playwright';
import process from 'node:process';

const SCENES = {
  noon: { timeOfDay: 12.7, windSpeed: 10.5, cloudCover: 0.38, cloudType: 0.8, turbidity: 2.0, rain: 0, visibility: 34000, seaState: 4, waveHeight: 2.0, choppiness: 0.6 },
  storm: { timeOfDay: 15.0, windSpeed: 22.0, cloudCover: 0.98, cloudType: 0.95, turbidity: 6.0, rain: 0.85, visibility: 5200, seaState: 7, waveHeight: 6.5, choppiness: 0.85 },
};
const name = process.argv[2] ?? 'noon';

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
await page.evaluate((env) => {
  const w = window.__leeward.world;
  Object.assign(w.settings, { quality: 'ultra', adaptiveResolution: false, renderScale: 1, debug: false });
  Object.assign(w.env, env);
  Object.assign(w.cam, { mode: 'chase', distance: 74 });
  w.bus.emit('settings:changed');
  w.bus.emit('capture:scene', {});
}, SCENES[name] ?? SCENES.noon);
await page.waitForTimeout(10000);

await page.evaluate(() => {
  const eng = window.__leeward;
  const H = { tick: [], period: [], collect: false, prevStart: 0, prevEnd: 0, meterTick: [], plainTick: [] };
  window.__H = H;
  const o = eng.tick.bind(eng);
  eng.tick = (now) => {
    const t0 = performance.now();
    const isMeterFrame = eng.world.time.frame % 3 === 0;
    o(now);
    const t1 = performance.now();
    if (H.collect) {
      H.tick.push(t1 - t0);
      if (H.prevStart) H.period.push(t0 - H.prevStart);
      (isMeterFrame ? H.meterTick : H.plainTick).push(t1 - t0);
    }
    H.prevStart = t0; H.prevEnd = t1;
  };
});

const sample = async (label, setup, ms = 6000) => {
  const r = await page.evaluate(async ({ setup, ms }) => {
    const w = window.__leeward.world, H = window.__H;
    // eslint-disable-next-line no-new-func
    const undo = new Function('w', setup)(w);
    await new Promise((r) => setTimeout(r, 1200));
    H.tick.length = 0; H.period.length = 0; H.meterTick.length = 0; H.plainTick.length = 0;
    H.collect = true;
    await new Promise((r) => setTimeout(r, ms));
    H.collect = false;
    if (typeof undo === 'function') undo();
    const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? +s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(1) : NaN; };
    const mean = (a) => a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : NaN;
    return {
      n: H.period.length,
      periodMean: mean(H.period), periodP50: q(H.period, 0.5), periodP90: q(H.period, 0.9),
      tickMean: mean(H.tick), tickP10: q(H.tick, 0.1), tickP50: q(H.tick, 0.5), tickP90: q(H.tick, 0.9), tickP99: q(H.tick, 0.99),
      meterMean: mean(H.meterTick), meterP50: q(H.meterTick, 0.5),
      plainMean: mean(H.plainTick), plainP50: q(H.plainTick, 0.5),
    };
  }, { setup, ms });
  const gap = +(r.periodMean - r.tickMean).toFixed(1);
  console.log(`\n  ${label}`);
  console.log(`    period  mean ${r.periodMean}  p50 ${r.periodP50}  p90 ${r.periodP90}     -> ${(1000 / r.periodMean).toFixed(1)} fps`);
  console.log(`    tick    mean ${r.tickMean}  p10 ${r.tickP10}  p50 ${r.tickP50}  p90 ${r.tickP90}  p99 ${r.tickP99}`);
  console.log(`    gap (period - tick) mean ${gap}`);
  console.log(`    tick on metering frames (f%3==0) mean ${r.meterMean} p50 ${r.meterP50}  |  other frames mean ${r.plainMean} p50 ${r.plainP50}`);
  return r;
};

console.log(`======== FRAME PERIOD DECOMPOSITION  scene=${name} ========`);
await sample('as shipped', 'return null;');
await sample('exposure readback stubbed', `const a=window.__rcPipe.exposure,o=a.readback.bind(a); a.readback=()=>{}; return ()=>{a.readback=o;};`);
await sample('exposure meter fully off', `const a=window.__rcPipe.exposure,o=a.meter.bind(a); a.meter=()=>{}; return ()=>{a.meter=o;};`);
await sample('readback via 4 PBO slots', `const a=window.__rcPipe.exposure; const old=a.slots; a.slots=[{pbo:null,fence:null},{pbo:null,fence:null},{pbo:null,fence:null},{pbo:null,fence:null},{pbo:null,fence:null},{pbo:null,fence:null}]; a.nextSlot=0; return ()=>{a.slots=old; a.nextSlot=0;};`);
await sample('METER_INTERVAL effectively 30', `const a=window.__rcPipe.exposure,o=a.meter.bind(a); a.meter=(wd,s)=>{ if(wd.time.frame%30===0) o(wd,s); }; return ()=>{a.meter=o;};`);
await sample('as shipped (repeat, drift check)', 'return null;');

console.log('\n======== who else does a synchronous GL round-trip? ========');
const sync = await page.evaluate(async () => {
  const gl = window.__leeward.world.renderer.getContext();
  const names = ['getBufferSubData', 'readPixels', 'clientWaitSync', 'finish', 'getError', 'checkFramebufferStatus', 'getParameter', 'getQueryParameter', 'fenceSync', 'getSyncParameter', 'flush'];
  const acc = {};
  const orig = {};
  for (const n of names) {
    if (typeof gl[n] !== 'function') continue;
    orig[n] = gl[n].bind(gl);
    acc[n] = { sum: 0, n: 0, max: 0 };
    gl[n] = (...a) => { const t = performance.now(); const v = orig[n](...a); const d = performance.now() - t; const s = acc[n]; s.sum += d; s.n++; s.max = Math.max(s.max, d); return v; };
  }
  const w = window.__leeward.world;
  const f0 = w.time.frame;
  await new Promise((r) => setTimeout(r, 6000));
  const frames = w.time.frame - f0;
  for (const n of Object.keys(orig)) gl[n] = orig[n];
  const out = {};
  for (const [k, s] of Object.entries(acc)) if (s.n) out[k] = { perFrame: +(s.sum / frames).toFixed(2), calls: +(s.n / frames).toFixed(1), perCall: +(s.sum / s.n).toFixed(3), max: +s.max.toFixed(1) };
  return { out, frames };
});
for (const [k, v] of Object.entries(sync.out).sort((a, b) => b[1].perFrame - a[1].perFrame)) {
  console.log(`  ${k.padEnd(24)} ${String(v.perFrame).padStart(8)} ms/frame  ${String(v.calls).padStart(7)} calls/frame  ${String(v.perCall).padStart(8)} ms/call  max ${v.max}`);
}
await browser.close();
