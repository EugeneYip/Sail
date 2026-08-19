#!/usr/bin/env node
/**
 * Is the ~100 ms frame gap ours or the machine's?
 * Compares: our engine / engine with rendering stubbed / a bare rAF page.
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--force-color-profile=srgb', '--hide-scrollbars', '--mute-audio'],
});
page: {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.setDefaultTimeout(300000);
  // 1. bare rAF page, no WebGL at all
  await page.goto('about:blank');
  const bare = await page.evaluate(async () => {
    const t = []; let prev = performance.now();
    await new Promise((res) => {
      let n = 0;
      const loop = () => { const now = performance.now(); t.push(now - prev); prev = now; if (++n < 300) requestAnimationFrame(loop); else res(); };
      requestAnimationFrame(loop);
    });
    const s = t.slice(5).sort((a, b) => a - b);
    return { p10: +s[Math.floor(s.length * 0.1)].toFixed(1), p50: +s[Math.floor(s.length * 0.5)].toFixed(1), p90: +s[Math.floor(s.length * 0.9)].toFixed(1), mean: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(1) };
  });
  console.log('bare about:blank rAF loop, no WebGL :', JSON.stringify(bare));
  await page.close();
}

const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.setDefaultTimeout(300000);
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
await page.waitForTimeout(9000);
await page.evaluate(() => {
  const eng = window.__leeward;
  const H = { tick: [], period: [], collect: false, prev: 0 };
  window.__H = H;
  const o = eng.tick.bind(eng);
  eng.tick = (now) => {
    const t0 = performance.now();
    o(now);
    const t1 = performance.now();
    if (H.collect) { H.tick.push(t1 - t0); if (H.prev) H.period.push(t0 - H.prev); }
    H.prev = t0;
  };
});
const go = async (label, setup) => {
  const r = await page.evaluate(async ({ setup }) => {
    const w = window.__leeward.world, H = window.__H;
    // eslint-disable-next-line no-new-func
    const undo = new Function('w', setup)(w);
    await new Promise((r) => setTimeout(r, 1500));
    H.tick.length = 0; H.period.length = 0; H.collect = true;
    await new Promise((r) => setTimeout(r, 6000));
    H.collect = false;
    if (typeof undo === 'function') undo();
    const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? +s[Math.floor(s.length * p)].toFixed(1) : NaN; };
    const mn = (a) => a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : NaN;
    return { n: H.period.length, pMean: mn(H.period), pP50: q(H.period, 0.5), tMean: mn(H.tick), tP50: q(H.tick, 0.5), tP10: q(H.tick, 0.1) };
  }, { setup });
  console.log(`  ${label.padEnd(40)} period mean ${String(r.pMean).padStart(7)} p50 ${String(r.pP50).padStart(6)} | tick mean ${String(r.tMean).padStart(6)} p50 ${String(r.tP50).padStart(6)} p10 ${String(r.tP10).padStart(5)} | gap ${(r.pMean - r.tMean).toFixed(1)}`);
};
console.log('\n--- engine ---');
await go('as shipped', 'return null;');
await go('render hook stubbed (no drawing at all)', `const e=window.__leeward; const p=e.renderHook, o=p.render.bind(p); p.render=()=>{}; return ()=>{p.render=o;};`);
await go('all modules + render stubbed', `const e=window.__leeward; const p=e.renderHook, o=p.render.bind(p); p.render=()=>{}; const ms=e.modules.map(m=>[m,m.update.bind(m)]); for(const [m] of ms) m.update=()=>{}; return ()=>{p.render=o; for(const [m,u] of ms) m.update=u;};`);
await go('exposure readback stubbed only', `const a=window.__rcPipe.exposure,o=a.readback.bind(a); a.readback=()=>{}; return ()=>{a.readback=o;};`);
await browser.close();
