import { chromium } from 'playwright';
const b = await chromium.launch({ headless: true, args: ['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist','--force-color-profile=srgb','--hide-scrollbars','--mute-audio','--autoplay-policy=no-user-gesture-required'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
await p.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => !!window.__leeward, null, { timeout: 60000 });
await p.evaluate(() => {
  const w = window.__leeward.world;
  w.settings.quality = 'ultra';
  w.settings.adaptiveResolution = false;
  w.settings.renderScale = 1;
  w.settings.debug = true;
  Object.assign(w.env, { timeOfDay: 12.7, windSpeed: 10.5, cloudCover: 0.38, cloudType: 0.8, turbidity: 2.0, rain: 0, visibility: 34000, seaState: 4, waveHeight: 2.0, choppiness: 0.6 });
  Object.assign(w.cam, { mode: 'chase', distance: 74 });
  w.bus.emit('settings:changed');
  w.bus.emit('capture:scene', {});
});
for (let i = 0; i < 8; i++) {
  await p.waitForTimeout(1500);
  const s = await p.evaluate(() => {
    const w = window.__leeward.world;
    return { t: +w.env.timeOfDay.toFixed(2), sunY: +w.env.sunDirection.y.toFixed(3), fps: Math.round(w.time.fps), frame: w.time.frame, dc: w.stats.drawCalls };
  });
  console.log(JSON.stringify(s));
}
const prof = await p.evaluate(async () => {
  const w = window.__leeward.world;
  const r = await w.ext.post.profile(120);
  return { prof: r, upd: Object.fromEntries(Object.entries(w.stats).filter(([k]) => k.startsWith('upd:') || k.startsWith('sky:') || k.startsWith('init:'))) };
});
console.log(JSON.stringify(prof, null, 2));
await b.close();
