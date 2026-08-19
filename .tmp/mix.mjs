// Level + band balance across families and weather. Iteration tool for the mix.
import { chromium } from 'playwright';
const b = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required','--enable-unsafe-swiftshader'] });
const p = await b.newPage();
for (const pat of ['**://fonts.googleapis.com/**','**://fonts.gstatic.com/**']) await p.route(pat, r => r.abort());
await p.goto('http://127.0.0.1:5178/', { waitUntil: 'commit' });
await p.waitForSelector('#viewport');
let names = null;
for (let i = 0; i < 20 && !names; i++) {
  names = await p.evaluate(async () => {
    try { window.__ap = await import('/src/audio/Probe.ts'); return window.__ap.BAND_NAMES; } catch { return null; }
  });
  if (!names) await p.waitForTimeout(1000);
}
if (!names) { console.log('probe never loaded'); await b.close(); process.exit(1); }
const run = (opts) => p.evaluate((o) => window.__ap.renderProbe(o), opts);

const BASE = { rain:0, cloudCover:0.3, camDistance:40, exposure:0.6, masterVolume:1, musicVolume:1, landDistance:4000 };
const WEATHER = {
  calm: { seaState:1, waveHeight:0.35, choppiness:0.15, windSpeed:3.0, apparentWind:3.0, speedKnots:3 },
  mod:  { seaState:4, waveHeight:2.0, choppiness:0.6, windSpeed:10.5, apparentWind:11.5, speedKnots:6 },
  gale: { seaState:7, waveHeight:6.5, choppiness:0.85, windSpeed:22, apparentWind:24, speedKnots:11, rain:0.85, cloudCover:0.98 },
};
const FAMS = ['sea','wind','ship','weather','wildlife','music'];
const show = (label, r) => console.log(
  label.padEnd(18),
  ('' + r.rmsDb.toFixed(1)).padStart(6),
  ('' + r.peakDb.toFixed(1)).padStart(6),
  ('' + r.centroid.toFixed(0)).padStart(5),
  String(r.clicks).padStart(3),
  r.dc.toExponential(1).padStart(9),
  '| ' + r.bands.map((x,i) => `${names[i]} ${(x*100).toFixed(1)}`.padEnd(11)).join(''),
);
console.log('scene/family      rmsDb   peak  cent clk        dc | band power %');
for (const [wname, w] of Object.entries(WEATHER)) {
  const set = { ...BASE, ...w };
  const common = { seconds: 10, warmup: 3, motion: wname === 'gale' ? 1.2 : 0.5, sails: { count: 18, area: 340, set: 1, luff: 0 }, set };
  show(`${wname} ALL`, await run(common));
  const raw = await run({ ...common, bypassLimiter: true });
  show(`${wname} ALL noclip`, raw);
  for (const f of FAMS) show(`  ${wname} ${f}`, await run({ ...common, only: [f] }));
}
await b.close();
