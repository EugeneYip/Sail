import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--hide-scrollbars', '--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.setDefaultTimeout(400000);
await page.addInitScript(() => { const R = window.WebSocket; class D extends EventTarget { constructor() { super(); this.readyState = 3; } send() {} close() {} } window.WebSocket = function (u, p) { return p === 'vite-hmr' ? new D() : new R(u, p); }; });
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__leeward, null, { timeout: 120000 });
const SC = {
  dawn: { timeOfDay: 5.9, windSpeed: 3.2, cloudCover: 0.3, cloudType: 0.45, turbidity: 3.4, rain: 0, visibility: 30000, seaState: 2, waveHeight: 0.6, choppiness: 0.35 },
  noon: { timeOfDay: 12.7, windSpeed: 10.5, cloudCover: 0.38, cloudType: 0.8, turbidity: 2.0, rain: 0, visibility: 34000, seaState: 4, waveHeight: 2.0, choppiness: 0.6 },
};
for (const [name, env] of Object.entries(SC)) {
  await page.evaluate((env) => { const w = window.__leeward.world; Object.assign(w.settings, { quality: 'ultra', adaptiveResolution: false, renderScale: 1, debug: true }); Object.assign(w.env, env); Object.assign(w.cam, { mode: 'chase', distance: 82 }); w.bus.emit('settings:changed'); w.bus.emit('capture:scene', {}); }, env);
  await page.waitForTimeout(9000);
  const r = await page.evaluate(async () => {
    const w = window.__leeward.world, sky = window.__skyDbg;
    let bakes = 0, skyViews = 0, aerials = 0, probes = 0, frames = 0;
    const L = sky.luts;
    const oB = L.stepBake.bind(L), oS = L.updateSkyView.bind(L), oA = L.updateAerial.bind(L);
    const P = sky.probe, oP = P.update.bind(P);
    L.stepBake = (...a) => { bakes++; return oB(...a); };
    L.updateSkyView = (...a) => { const v = oS(...a); if (v) skyViews++; return v; };
    L.updateAerial = (...a) => { aerials++; return oA(...a); };
    P.update = (...a) => { const v = oP(...a); if (v) probes++; return v; };
    const f0 = w.time.frame, t0 = performance.now();
    await new Promise((r) => setTimeout(r, 5000));
    frames = w.time.frame - f0; const wall = (performance.now() - t0) / frames;
    L.stepBake = oB; L.updateSkyView = oS; L.updateAerial = oA; P.update = oP;
    const st = Object.fromEntries(Object.entries(w.stats).filter(([k]) => /^sky:/.test(k)).map(([k, v]) => [k, +Number(v).toPrecision(3)]));
    return { frames, wall: +wall.toFixed(1), perFrame: { bakes: +(bakes / frames).toFixed(3), skyViews: +(skyViews / frames).toFixed(3), aerials: +(aerials / frames).toFixed(3), probes: +(probes / frames).toFixed(3) }, mie: +sky.radiometry.mieMul.toFixed(4), sunY: +w.env.sunDirection.y.toFixed(4), tod: +w.env.timeOfDay.toFixed(3), st };
  });
  console.log(`\n== ${name} ==  wall ${r.wall} ms  tod ${r.tod}  sunY ${r.sunY}  mieMul ${r.mie}`);
  console.log('  calls/frame:', JSON.stringify(r.perFrame));
  console.log('  sky stats:', Object.entries(r.st).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join('  '));
}
await browser.close();
