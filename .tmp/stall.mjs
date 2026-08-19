#!/usr/bin/env node
/**
 * Where does Pipeline.render() lose ~50 ms of CPU?
 * Instruments the exposure readback statement-by-statement, then A/B tests
 * wall-clock frame time with the metering path swapped out.
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--hide-scrollbars', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.setDefaultTimeout(300000);
let fenceWarn = 0;
page.on('console', (m) => { if (/fenced/.test(m.text())) fenceWarn++; });
await page.addInitScript(() => {
  const R = window.WebSocket;
  class D extends EventTarget { constructor() { super(); this.readyState = 3; } send() {} close() {} }
  window.WebSocket = function (u, p) { return p === 'vite-hmr' ? new D() : new R(u, p); };
});
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__leeward, null, { timeout: 120000 });
await page.evaluate(() => {
  const w = window.__leeward.world;
  Object.assign(w.settings, { quality: 'ultra', adaptiveResolution: false, renderScale: 1, debug: false });
  Object.assign(w.env, { timeOfDay: 12.7, windSpeed: 10.5, cloudCover: 0.38, cloudType: 0.8, turbidity: 2, visibility: 34000, seaState: 4, waveHeight: 2, choppiness: 0.6 });
  Object.assign(w.cam, { mode: 'chase', distance: 74 });
  w.bus.emit('settings:changed');
  w.bus.emit('capture:scene', {});
});
await page.waitForTimeout(10000);

const wall = (ms = 3500) => page.evaluate(async (ms) => {
  const w = window.__leeward.world;
  const f0 = w.time.frame, t0 = performance.now();
  await new Promise((r) => setTimeout(r, ms));
  return +((performance.now() - t0) / (w.time.frame - f0)).toFixed(2);
}, ms);

const label = async (t) => { const v = await wall(); console.log(`  ${t.padEnd(46)} ${String(v).padStart(7)} ms/frame  ${(1000 / v).toFixed(1)} fps`); return v; };

console.log('=== A/B: what costs the frame ===');
const base = await label('BASELINE, as shipped');

// 1. metering entirely off
await page.evaluate(() => {
  const ae = window.__rcPipe.exposure;
  window.__save = { meter: ae.meter.bind(ae), readback: ae.readback.bind(ae) };
  ae.meter = () => {};
});
await label('AutoExposure.meter() stubbed out');

// 2. metering passes on, readback stubbed
await page.evaluate(() => {
  const ae = window.__rcPipe.exposure;
  ae.meter = window.__save.meter;
  ae.readback = () => {};
});
const noRead = await label('3 metering passes on, readback stubbed');

// 3. sync readback only
await page.evaluate(() => {
  const ae = window.__rcPipe.exposure;
  ae.readback = (r, res) => ae.readbackSync(r, res);
});
await label('sync readRenderTargetPixels (throttled 1/6)');

// 4. back to shipped
await page.evaluate(() => { const ae = window.__rcPipe.exposure; ae.readback = window.__save.readback; });
await label('restored shipped async path');

// 5. env probe off
await page.evaluate(() => {
  const p = window.__skyDbg.probe;
  window.__save.probeUpdate = p.update.bind(p);
  p.update = () => false;
});
await label('EnvProbe.update() stubbed (no PMREM)');

// 6. env probe on, but never flag PMREM
await page.evaluate(() => {
  const p = window.__skyDbg.probe;
  p.update = (world, force) => {
    const before = p.target.texture.needsPMREMUpdate;
    const res = window.__save.probeUpdate(world, force);
    p.target.texture.needsPMREMUpdate = before;
    return res;
  };
});
await label('EnvProbe renders, PMREM refresh suppressed');

await page.evaluate(() => { window.__skyDbg.probe.update = window.__save.probeUpdate; });

// 7. clouds off
await page.evaluate(() => { const w = window.__leeward.world; w.settings.volumetricClouds = false; w.bus.emit('settings:changed'); });
await label('volumetricClouds = false');
await page.evaluate(() => { const w = window.__leeward.world; w.settings.volumetricClouds = true; w.bus.emit('settings:changed'); });

// 8. combined: meter stub + probe stub
await page.evaluate(() => {
  const ae = window.__rcPipe.exposure; ae.meter = () => {};
  window.__skyDbg.probe.update = () => false;
});
await label('meter OFF + envProbe OFF');
await page.evaluate(() => {
  const ae = window.__rcPipe.exposure; ae.meter = window.__save.meter;
  window.__skyDbg.probe.update = window.__save.probeUpdate;
});

console.log(`\n=== statement-level timing inside readback (ms per metering frame) ===`);
const detail = await page.evaluate(async () => {
  const gl = window.__leeward.world.renderer.getContext();
  const ae = window.__rcPipe.exposure;
  const rec = { clientWaitSync: [], getBufferSubData: [], readPixels: [], fenceSync: [], setRenderTarget: [], total: [], status: {} };
  const orig = ae.readback.bind(ae);
  ae.readback = function (r, result) {
    const T = performance.now();
    // replicate the shipped logic with per-call timing
    for (let i = 0; i < ae.slots.length; i++) {
      const slot = ae.slots[(ae.nextSlot + i) % ae.slots.length];
      if (!slot.fence) continue;
      let t = performance.now();
      const status = gl.clientWaitSync(slot.fence, 0, 0);
      rec.clientWaitSync.push(performance.now() - t);
      const sname = status === gl.TIMEOUT_EXPIRED ? 'TIMEOUT' : status === gl.ALREADY_SIGNALED ? 'ALREADY' : status === gl.CONDITION_SATISFIED ? 'SATISFIED' : 'FAILED';
      rec.status[sname] = (rec.status[sname] ?? 0) + 1;
      if (status === gl.TIMEOUT_EXPIRED) continue;
      if (status !== gl.WAIT_FAILED && slot.pbo) {
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.pbo);
        t = performance.now();
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, ae.readBuffer);
        rec.getBufferSubData.push(performance.now() - t);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        ae.accept(ae.readBuffer[0], ae.readBuffer[1]);
      }
      gl.deleteSync(slot.fence);
      slot.fence = null;
    }
    const slot = ae.slots[ae.nextSlot];
    if (!slot.fence) {
      ae.nextSlot = (ae.nextSlot + 1) % ae.slots.length;
      if (!slot.pbo) {
        slot.pbo = gl.createBuffer();
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.pbo);
        gl.bufferData(gl.PIXEL_PACK_BUFFER, 16, gl.STREAM_READ);
      } else gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.pbo);
      let t = performance.now();
      r.setRenderTarget(result);
      rec.setRenderTarget.push(performance.now() - t);
      t = performance.now();
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, 0);
      rec.readPixels.push(performance.now() - t);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      t = performance.now();
      slot.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      rec.fenceSync.push(performance.now() - t);
    }
    rec.total.push(performance.now() - T);
  };
  await new Promise((r) => setTimeout(r, 4000));
  ae.readback = orig;
  const st = (a) => a.length ? { n: a.length, avg: +(a.reduce((s, v) => s + v, 0) / a.length).toFixed(3), max: +Math.max(...a).toFixed(3) } : null;
  return { clientWaitSync: st(rec.clientWaitSync), getBufferSubData: st(rec.getBufferSubData), readPixels: st(rec.readPixels), fenceSync: st(rec.fenceSync), setRenderTarget: st(rec.setRenderTarget), total: st(rec.total), status: rec.status };
});
console.log(JSON.stringify(detail, null, 2));

console.log(`\n=== renderHook internal split (CPU ms, no finish) ===`);
const split = await page.evaluate(async () => {
  const w = window.__leeward.world, pipe = window.__rcPipe;
  const acc = {};
  const T = (k, t) => { const a = acc[k] ??= { s: 0, n: 0, mx: 0 }; a.s += t; a.n++; a.mx = Math.max(a.mx, t); };
  const wrapPass = (obj, key, label) => {
    const o = obj[key].bind(obj);
    obj[key] = (...a) => { const t = performance.now(); const r = o(...a); T(label, performance.now() - t); return r; };
    return () => { obj[key] = o; };
  };
  const undo = [
    wrapPass(pipe.exposure, 'meter', 'exposure.meter'),
    wrapPass(pipe.exposure, 'update', 'exposure.update'),
    wrapPass(pipe.prepare, 'render', 'prepare'),
    wrapPass(pipe.composite, 'render', 'composite'),
    wrapPass(pipe.depthCopy, 'render', 'depthCopy'),
    wrapPass(pipe.velocity, 'render', 'velocity'),
    wrapPass(pipe.aa, 'render', 'aa'),
    wrapPass(pipe.bloom, 'render', 'bloom'),
    wrapPass(pipe.dof, 'render', 'dof'),
    wrapPass(pipe.motionBlur, 'render', 'motionBlur'),
    wrapPass(w.renderer, 'render', 'renderer.render(scene)'),
  ];
  const f0 = w.time.frame, t0 = performance.now();
  await new Promise((r) => setTimeout(r, 4000));
  const wallMs = (performance.now() - t0) / (w.time.frame - f0);
  for (const u of undo) u();
  const out = {};
  for (const [k, a] of Object.entries(acc)) out[k] = { avg: +(a.s / a.n).toFixed(3), perFrame: +(a.s / (w.time.frame - f0)).toFixed(3), calls: a.n, max: +a.mx.toFixed(2) };
  return { out, wallMs: +wallMs.toFixed(2), frames: w.time.frame - f0 };
});
for (const [k, v] of Object.entries(split.out).sort((a, b) => b[1].perFrame - a[1].perFrame)) {
  console.log(`  ${k.padEnd(24)} perFrame ${String(v.perFrame).padStart(8)}  avgCall ${String(v.avg).padStart(8)}  n=${v.calls}  max ${v.max}`);
}
console.log(`  wall ${split.wallMs} ms over ${split.frames} frames`);
console.log(`\nfence warnings seen: ${fenceWarn}`);
await browser.close();
