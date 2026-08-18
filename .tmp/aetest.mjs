import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist','--hide-scrollbars','--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.addInitScript(() => { const R = window.WebSocket; class D extends EventTarget { constructor(){super();this.readyState=3;} send(){} close(){} } window.WebSocket = function(u,p){ return p==='vite-hmr'? new D(): new R(u,p); }; });
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__leeward, null, { timeout: 60000 });
await page.evaluate(() => {
  const w = window.__leeward.world;
  Object.assign(w.settings, { quality: 'ultra', adaptiveResolution: false, renderScale: 1, debug: true });
  Object.assign(w.env, { timeOfDay: 12.7, windSpeed: 10.5, cloudCover: 0.38, turbidity: 2, visibility: 34000, seaState: 4, waveHeight: 2 });
  w.bus.emit('settings:changed'); w.bus.emit('capture:scene', {});
});
await page.waitForTimeout(8000);
async function measure(label, on) {
  await page.evaluate((v) => { const w = window.__leeward.world; w.settings.autoExposure = v; w.bus.emit('settings:changed'); }, on);
  await page.waitForTimeout(3000);
  const a = await page.evaluate(() => ({ f: window.__leeward.world.time.frame, t: performance.now() }));
  await page.waitForTimeout(4000);
  const r = await page.evaluate(() => {
    const w = window.__leeward.world;
    return { f: w.time.frame, t: performance.now(), exp: +w.stats['post:exposure']?.toFixed(3), scene: +w.stats['post:scene']?.toFixed(3), total: +w.stats['post:total']?.toFixed(3) };
  });
  console.log(`${label}: fps=${(((r.f-a.f)*1000)/(r.t-a.t)).toFixed(1)} post:exposure=${r.exp} post:scene=${r.scene} post:total=${r.total}`);
}
await measure('autoExposure ON ', true);
await measure('autoExposure OFF', false);
await measure('autoExposure ON ', true);
// Is the async readback working, or has it fallen back to a stalling sync read?
const dbg = await page.evaluate(() => {
  const p = globalThis.__rcPipe;
  const e = p.exposure;
  return { asyncFailed: e.asyncFailed, reading: e.reading, syncCountdown: e.syncCountdown, measuredLog: e.measuredLog };
});
console.log('AutoExposure internals:', JSON.stringify(dbg));
await browser.close();
