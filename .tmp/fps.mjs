import { chromium } from 'playwright';
const b = await chromium.launch({ headless: true, args: ['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist','--hide-scrollbars','--mute-audio'] });
const page = await b.newPage({ viewport: { width: 1600, height: 900 } });
await page.addInitScript(() => { const R = window.WebSocket; class D extends EventTarget { constructor(){super();this.readyState=3;} send(){} close(){} } window.WebSocket = function(u,p){ return p==='vite-hmr'? new D(): new R(u,p); }; });
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__leeward, null, { timeout: 60000 });
await page.evaluate(() => { const w = window.__leeward.world;
  Object.assign(w.settings, { quality: 'ultra', adaptiveResolution: false, renderScale: 1, debug: false });
  Object.assign(w.env, { timeOfDay: 12.7, windSpeed: 10.5, cloudCover: 0.38, turbidity: 2, visibility: 34000, seaState: 4, waveHeight: 2 });
  Object.assign(w.cam, { mode: 'chase', distance: 74 });
  w.bus.emit('settings:changed'); w.bus.emit('capture:scene', {}); });
await page.waitForTimeout(10000);

// Measure inside the page over many frames so CDP round trips cannot pollute it.
async function run(label, patch) {
  await page.evaluate((p) => { const w = window.__leeward.world; Object.assign(w.settings, p); w.bus.emit('settings:changed'); }, patch);
  await page.waitForTimeout(2500);
  const r = await page.evaluate(() => new Promise((res) => {
    const t0 = performance.now(); const f0 = window.__leeward.world.time.frame;
    const samples = [];
    let last = t0;
    const tick = () => {
      const now = performance.now();
      samples.push(now - last); last = now;
      if (now - t0 < 5000) requestAnimationFrame(tick);
      else {
        const f1 = window.__leeward.world.time.frame;
        samples.sort((a, b) => a - b);
        res({ fps: ((f1 - f0) * 1000) / (now - t0), median: samples[samples.length >> 1], p95: samples[Math.floor(samples.length * 0.95)] });
      }
    };
    requestAnimationFrame(tick);
  }));
  console.log(`${label.padEnd(28)} fps=${r.fps.toFixed(1)}  medianFrame=${r.median.toFixed(2)}ms  p95=${r.p95.toFixed(2)}ms`);
}
for (let i = 0; i < 2; i++) {
  await run('baseline (all on)', { autoExposure: true, bloom: true, depthOfField: true, motionBlur: true, antialias: 'taa' });
  await run('autoExposure off', { autoExposure: false });
  await run('autoExposure on again', { autoExposure: true });
  await run('post minimal (no bloom/dof/mb/aa)', { bloom: false, depthOfField: false, motionBlur: false, antialias: 'off' });
  await run('post restored', { bloom: true, depthOfField: true, motionBlur: true, antialias: 'taa' });
}
await b.close();
