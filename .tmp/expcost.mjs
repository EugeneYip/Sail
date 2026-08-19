import { chromium } from 'playwright';

const b = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--hide-scrollbars', '--mute-audio'] });
const page = await b.newPage({ viewport: { width: 1600, height: 900 } });
page.setDefaultTimeout(240000);
page.setDefaultNavigationTimeout(240000);
const warn = new Map();
page.on('console', (m) => {
  const t = m.text();
  let key = t.slice(0, 90);
  if (/fenced/.test(t)) key = 'ANGLE fenced-buffer warning';
  else if (/defines/.test(t)) key = 'THREE defines undefined';
  else if (/glGetProgramiv/.test(t)) key = 'glGetProgramiv INVALID_VALUE';
  warn.set(key, (warn.get(key) ?? 0) + 1);
});
await page.addInitScript(() => { const R = window.WebSocket; class D extends EventTarget { constructor() { super(); this.readyState = 3; } send() {} close() {} } window.WebSocket = function (u, p) { return p === 'vite-hmr' ? new D() : new R(u, p); }; });
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__leeward, null, { timeout: 90000 });
await page.evaluate(() => {
  const w = window.__leeward.world;
  Object.assign(w.settings, { quality: 'ultra', adaptiveResolution: false, renderScale: 1, debug: false });
  Object.assign(w.env, { timeOfDay: 12.7, windSpeed: 10.5, seaState: 4 });
  w.bus.emit('settings:changed');
});
await page.waitForTimeout(9000);

const out = await page.evaluate(() => {
  const w = window.__leeward.world, r = w.renderer, gl = r.getContext();
  const pipe = window.__rcPipe, ae = pipe.exposure, t = pipe.targets;
  const bench = (fn, n = 12, k = 5) => {
    const runs = [];
    for (let j = 0; j < k; j++) { fn(); const t0 = performance.now(); for (let i = 0; i < n; i++) fn(); runs.push((performance.now() - t0) / n); }
    runs.sort((a, b) => a - b); return +runs[0].toPrecision(3);
  };
  const scene = t.get('scene', w.size.width, w.size.height, 'rgba16f', { depth: true });
  const lum = t.get('expLum', 64, 64, 'r16f', { nearest: true });
  const partial = t.get('expPartial', 64, 32, 'r16f', { nearest: true });
  const result = t.get('expResult', 1, 1, 'rgba32f', { nearest: true });
  ae.lumPass.uniforms.tScene.value = scene.texture;
  ae.lumPass.uniforms.uSceneTexel.value.set(1 / scene.width, 1 / scene.height);
  ae.lumPass.uniforms.uFootprint.value.set(scene.width / 64, scene.height / 64);
  ae.histPass.uniforms.tLum.value = lum.texture;
  ae.resolvePass.uniforms.tPartial.value = partial.texture;

  const res = {};
  res['0_baseline_finish_only'] = bench(() => { gl.finish(); });
  res['1_lumPass+finish'] = bench(() => { ae.lumPass.render(r, lum); gl.finish(); });
  res['2_histPass+finish'] = bench(() => { ae.histPass.render(r, partial); gl.finish(); });
  res['3_resolvePass+finish'] = bench(() => { ae.resolvePass.render(r, result); gl.finish(); });
  res['4_all3_passes+finish'] = bench(() => {
    ae.lumPass.render(r, lum); ae.histPass.render(r, partial); ae.resolvePass.render(r, result); gl.finish();
  });

  const buf = new Float32Array(4);
  res['5_sync_readRenderTargetPixels+finish'] = bench(() => { r.readRenderTargetPixels(result, 0, 0, 1, 1, buf); gl.finish(); }, 6, 4);

  // Fenced PBO write, no read (what the disabled path did)
  const pbo = gl.createBuffer();
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
  gl.bufferData(gl.PIXEL_PACK_BUFFER, 16, gl.STREAM_READ);
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
  let fence = null;
  res['6_pbo_readPixels+fence(no finish)'] = bench(() => {
    r.setRenderTarget(result);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    if (fence) gl.deleteSync(fence);
    fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  }, 6, 4);
  if (fence) { gl.deleteSync(fence); fence = null; }
  res['7_pbo_write+wait+getBufferSubData'] = bench(() => {
    r.setRenderTarget(result);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, 0);
    const f = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    for (let i = 0; i < 10000; i++) { if (gl.clientWaitSync(f, 0, 0) !== gl.TIMEOUT_EXPIRED) break; }
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, buf);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.deleteSync(f);
  }, 6, 4);
  gl.deleteBuffer(pbo);
  r.setRenderTarget(null);

  // r8 alternative: can we read a UNSIGNED_BYTE 1x1 instead of FLOAT?
  res['8_meter_as_shipped'] = bench(() => { ae.meter({ ...w, time: { ...w.time, frame: 0 } }, scene); gl.finish(); }, 8, 4);

  return {
    res,
    stats: { stops: w.stats['post:exposureStops'], measured: w.stats['post:sceneLog2Lum'], exposure: w.uniforms.uExposure.value },
    profiled: null,
  };
});

const prof = await page.evaluate(async () => await window.__leeward.world.ext.post.profile(90));

console.log('=== exposure cost anatomy (ms/call, min-of-5) ===');
for (const [k, v] of Object.entries(out.res).sort()) console.log('  ' + k.padEnd(40) + v);
console.log('\nexposure stats:', JSON.stringify(out.stats));
console.log('\n=== per-pass profile (syncMode, ms/frame) ===');
for (const [k, v] of Object.entries(prof).sort((a, b) => b[1] - a[1])) console.log('  ' + k.padEnd(20) + v.toFixed(3));
console.log('  ' + 'TOTAL'.padEnd(20) + Object.values(prof).reduce((a, b) => a + b, 0).toFixed(3));
console.log('\n=== console messages ===');
for (const [k, v] of [...warn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14)) console.log('  ' + String(v).padStart(4) + ' x ' + k);
await b.close();
