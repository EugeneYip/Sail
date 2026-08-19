import { chromium } from 'playwright';
const b = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required','--enable-unsafe-swiftshader'] });
const p = await b.newPage();
for (const pat of ['**://fonts.googleapis.com/**','**://fonts.gstatic.com/**']) await p.route(pat, r => r.abort());
await p.goto('http://127.0.0.1:5178/', { waitUntil: 'commit' });
await p.waitForSelector('#viewport');
await p.waitForFunction(async () => { if (window.__ap) return true; try { window.__ap = await import('/src/audio/Probe.ts'); return true; } catch { return false; } }, null, { timeout: 60000 });
const run = (opts) => p.evaluate((o) => window.__ap.renderProbe(o), opts);
const names = await p.evaluate(() => window.__ap.BAND_NAMES);
const CALM = { seaState:2, waveHeight:0.6, choppiness:0.25, windSpeed:4.2, apparentWind:4.2, speedKnots:4, rain:0, camDistance:40, exposure:0.6, masterVolume:1, musicVolume:1 };
const show = (label, r) => console.log(
  label.padEnd(24),
  ('' + r.rmsDb.toFixed(1)).padStart(6) + ' dBFS',
  ('' + r.peakDb.toFixed(1)).padStart(6) + ' pk',
  '| ' + r.bands.map((x,i) => `${names[i]} ${(x*100).toFixed(1)}%`).join(' '),
);
for (const [label, o] of [
  ['calm ALL',                {}],
  ['calm music only',         { only:['music'] }],
  ['calm music only, noverb', { only:['music'], bypassLimiter: true }],
  ['calm no music',           { mute:['music'] }],
  ['calm musicVolume 0',      { set:{ musicVolume: 0 } }],
  ['calm sea only',           { only:['sea'] }],
  ['calm sea, no limiter',    { only:['sea'], bypassLimiter:true }],
]) {
  const set = { ...CALM, ...(o.set||{}) };
  const r = await run({ seconds: 10, warmup: 3, motion: 0.6, sails:{count:18,area:340,set:1,luff:0}, ...o, set });
  show(label, r);
}
await b.close();
