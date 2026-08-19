import { chromium } from 'playwright';
const b = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required','--enable-unsafe-swiftshader'] });
const p = await b.newPage();
for (const pat of ['**://fonts.googleapis.com/**','**://fonts.gstatic.com/**']) await p.route(pat, r => r.abort());
await p.goto('http://127.0.0.1:5178/', { waitUntil: 'commit' });
await p.waitForSelector('#viewport');
await p.waitForFunction(async () => { if (window.__ap) return true; try { window.__ap = await import('/src/audio/Probe.ts'); return true; } catch { return false; } }, null, { timeout: 60000 });

const run = (opts) => p.evaluate((o) => window.__ap.renderProbe(o), opts);
const names = await p.evaluate(() => window.__ap.BAND_NAMES);
const FIXED = { seaState: 3, waveHeight: 1.2, choppiness: 0.5, speedKnots: 0, apparentWind: 0, rain: 0, camDistance: 40, exposure: 0.6, masterVolume: 0.8 };

console.log('band names:', names.join(' '));
const scenes = [
  ['calm  sea',  { only:['sea'],  set: { ...FIXED, masterVolume:1, seaState:0, waveHeight:0.15, choppiness:0.1, windSpeed:1.5, apparentWind:1.5, speedKnots:1 } }],
  ['mod   sea',  { only:['sea'],  set: { ...FIXED, masterVolume:1, seaState:4, waveHeight:2.0, choppiness:0.6, windSpeed:10.5, apparentWind:10.5, speedKnots:6 } }],
  ['gale  sea',  { only:['sea'],  set: { ...FIXED, masterVolume:1, seaState:7, waveHeight:6.5, choppiness:0.85, windSpeed:22, apparentWind:22, speedKnots:11 } }],
  ['calm  wind', { only:['wind'], set: { ...FIXED, masterVolume:1, windSpeed:4.2, apparentWind:4.2 } }],
  ['gale  wind', { only:['wind'], set: { ...FIXED, masterVolume:1, windSpeed:22, apparentWind:22 } }],
  ['gale  ship', { only:['ship'], set: { ...FIXED, masterVolume:1, windSpeed:22, apparentWind:22, speedKnots:11, setRate:0.3, braceRate:0.3, rudderRate:0.4 }, sails:{count:18,area:340,set:1,luff:0}, motion:1.2 }],
  ['calm  ALL',  { set: { ...FIXED, masterVolume:1, musicVolume:1, seaState:2, waveHeight:0.6, choppiness:0.25, windSpeed:4.2, apparentWind:4.2, speedKnots:4 }, sails:{count:18,area:340,set:1,luff:0}, motion:0.5 }],
  ['mod   ALL',  { set: { ...FIXED, masterVolume:1, musicVolume:1, seaState:4, waveHeight:2.0, choppiness:0.6, windSpeed:10.5, apparentWind:10.5, speedKnots:6 }, sails:{count:18,area:340,set:1,luff:0}, motion:0.8 }],
  ['gale  ALL',  { set: { ...FIXED, masterVolume:1, musicVolume:1, seaState:7, waveHeight:6.5, choppiness:0.85, windSpeed:22, apparentWind:22, speedKnots:11, rain:0.85, cloudCover:0.98 }, sails:{count:18,area:340,set:1,luff:0}, motion:1.2 }],
];
for (const [label, o] of scenes) {
  const r = await run({ seconds: 10, warmup: 3, motion: 1, ...o });
  console.log(
    label.padEnd(10),
    ('' + r.rmsDb.toFixed(1)).padStart(6) + ' dBFS rms',
    ('' + r.peakDb.toFixed(1)).padStart(6) + ' pk',
    'cent ' + ('' + r.centroid.toFixed(0)).padStart(5),
    'clk ' + String(r.clicks).padStart(3),
    'dc ' + r.dc.toExponential(1),
    '| ' + r.bands.map((x,i) => `${names[i]} ${(x*100).toFixed(1)}%`).join('  '),
  );
}
await b.close();
