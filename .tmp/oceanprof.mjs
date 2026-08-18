import { chromium } from 'playwright';

const SCENE = process.argv[2] ?? 'noon';
const ENVS = {
  noon: { timeOfDay: 12.7, windSpeed: 10.5, cloudCover: 0.38, turbidity: 2, visibility: 34000, seaState: 4, waveHeight: 2, choppiness: 0.6 },
  storm: { timeOfDay: 15, windSpeed: 22, cloudCover: 0.98, turbidity: 6, visibility: 5200, seaState: 7, waveHeight: 6.5, choppiness: 0.85 },
};

const b = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--hide-scrollbars', '--mute-audio'] });
const page = await b.newPage({ viewport: { width: 1600, height: 900 } });
await page.addInitScript(() => { const R = window.WebSocket; class D extends EventTarget { constructor() { super(); this.readyState = 3; } send() {} close() {} } window.WebSocket = function (u, p) { return p === 'vite-hmr' ? new D() : new R(u, p); }; });
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__leeward, null, { timeout: 60000 });
await page.evaluate(({ env }) => {
  const w = window.__leeward.world;
  Object.assign(w.settings, { quality: 'ultra', adaptiveResolution: false, renderScale: 1, debug: true });
  Object.assign(w.env, env);
  Object.assign(w.cam, { mode: 'chase', distance: 74 });
  w.bus.emit('settings:changed'); w.bus.emit('capture:scene', {});
}, { env: ENVS[SCENE] });
await page.waitForTimeout(9000);

const out = await page.evaluate(() => {
  const w = window.__leeward.world;
  const oc = w.ocean;
  const bench = (fn, n = 20, k = 5) => {
    const runs = [];
    for (let j = 0; j < k; j++) {
      fn();
      const t0 = performance.now();
      for (let i = 0; i < n; i++) fn();
      runs.push((performance.now() - t0) / n);
    }
    runs.sort((a, b) => a - b);
    return +runs[0].toPrecision(3);
  };
  const res = {};
  let tt = 0;
  res['cpu.update (CPU wave mirror FFT)'] = bench(() => oc.cpu.update(tt += 0.0167));
  res['cpu.setParams (spectrum rebake, CPU)'] = bench(() => oc.cpu.setParams(oc.params), 3, 3);
  res['solveSpectrum only'] = bench(() => { oc.sinceRebake = 99; oc.baked.wind = -1; oc.solve(w, true); }, 3, 3);
  res['cascades[].update (GPU FFT submit)'] = bench(() => { for (const c of oc.cascades) c.update(w.renderer, tt += 0.0167); }, 10, 4);
  res['foam.update'] = bench(() => oc.foam.update(w.renderer, 0, 0, 0.0167, oc.params, 10), 10, 4);
  res['updateClipmap'] = bench(() => oc.updateClipmap(w.camera.position.x, w.camera.position.z), 200, 5);
  res['cpu.sample x 400 (physics load)'] = bench(() => {
    const s = { height: 0, dx: 0, dz: 0, normal: { x: 0, y: 1, z: 0, set() { return this; }, normalize() { return this; } }, velocity: { set() {} } };
    for (let i = 0; i < 400; i++) oc.cpu.sample(i * 0.7, i * 1.3, s);
  }, 10, 4);
  res['maxHeight()'] = bench(() => oc.cpu.maxHeight(), 20, 4);

  const grids = [];
  for (let i = 0; i < oc.cascades.length; i++) {
    grids.push({
      cascade: i,
      tile: oc.layouts[i].size,
      gpuN: oc.layouts[i].n,
      cpuM: oc.cpu.gridSize(i),
      activeModes: oc.cpu.activeModes(i),
      totalCells: oc.cpu.gridSize(i) ** 2,
      kMin: +oc.layouts[i].kMin.toPrecision(3),
      kMax: +oc.layouts[i].kMax.toPrecision(3),
    });
  }
  return {
    bench: res,
    grids,
    stats: Object.fromEntries(Object.entries(w.stats).filter(([k]) => /^(ocean:|upd:|ocean\.)/.test(k)).map(([k, v]) => [k, +Number(v).toPrecision(3)])),
    fps: Math.round(w.time.fps),
    hs: +oc.params.hs.toFixed(3),
    slopeRms: +oc.params.slopeRms.toFixed(4),
    compare: (() => { try { const c = w.ext.ocean.debugCompare(4096); return { rmsDiff: +c.rmsHeight.toFixed(4), maxDiff: +c.maxHeight.toFixed(4), rmsSlopeDiff: +c.rmsSlope.toFixed(4), rmsGpu: +c.rmsGpuField.toFixed(4), rmsCpu: +c.rmsCpuField.toFixed(4), corr: +c.correlation.toFixed(4), cascades: c.cascades }; } catch (e) { return 'ERR ' + e.message; } })(),
  };
});

console.log('=== scene ' + SCENE + ' — ocean CPU breakdown, best-of-K medians (ms) ===');
for (const [k, v] of Object.entries(out.bench).sort((a, b) => b[1] - a[1])) console.log('  ' + k.padEnd(40) + v);
console.log('\n=== live per-frame stats ===');
console.log(out.stats);
console.log('\n=== cascade layout ===');
console.table(out.grids);
console.log('\nfps=' + out.fps + ' hs=' + out.hs + ' slopeRms=' + out.slopeRms);
console.log('CPU-vs-GPU agreement:', JSON.stringify(out.compare));
if (errs.length) console.log('\nCONSOLE ERRORS (' + errs.length + '):\n' + errs.slice(0, 8).join('\n'));
await b.close();
