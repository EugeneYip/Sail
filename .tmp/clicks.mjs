#!/usr/bin/env node
// Fast click-attribution driver. Renders the rig offline family by family and
// prints the discontinuity numbers, with and without simulated stalls.
import { chromium } from 'playwright';
import process from 'node:process';

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
// Serve a blank document so the whole three.js app does not have to boot; the
// probe only needs src/audio/** and its imports, which Vite serves on demand.
await page.route('http://127.0.0.1:5178/', (r) =>
  r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>p</title>' }));
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'commit', timeout: 120000 });
try {
  await page.evaluate(async () => { window.__p = await import('/src/audio/Probe.ts'); }, null);
} catch (e) {
  console.log('IMPORT FAIL', String(e).slice(0, 600));
  process.exit(2);
}

const probe = (o) => page.evaluate((o) => window.__p.renderProbe(o), o);
const f = (x, n = 1) => (Number.isFinite(x) ? x.toFixed(n) : String(x));

const SCENE = {
  calm: { windSpeed: 4, apparentWind: 4.5, seaState: 2, waveHeight: 0.6, choppiness: 0.35, speedKnots: 3, exposure: 0.5, camDistance: 40, masterVolume: 0.8, musicVolume: 0.45 },
  noon: { windSpeed: 10.5, apparentWind: 12, seaState: 4, waveHeight: 2.0, choppiness: 0.6, speedKnots: 6, exposure: 0.55, camDistance: 40, masterVolume: 0.8, musicVolume: 0.45 },
  gale: { windSpeed: 22, gust: 1.25, apparentWind: 26, seaState: 7, waveHeight: 6.5, choppiness: 0.85, rain: 0.85, cloudCover: 0.98, speedKnots: 11, exposure: 0.7, camDistance: 30, masterVolume: 0.8, musicVolume: 0.45 },
  worst: { windSpeed: 30, gust: 1.4, apparentWind: 34, seaState: 9, waveHeight: 12, choppiness: 1, rain: 1, cloudCover: 1, speedKnots: 13, bowSlam: 18, setRate: 1.2, braceRate: 1.2, rudderRate: 1.2, exposure: 1, camDistance: 8, landDistance: 120, masterVolume: 1, musicVolume: 1 },
};
const FAMILIES = ['sea', 'wind', 'ship', 'weather', 'wildlife', 'music'];

async function row(label, opts) {
  const r = await probe({ seconds: 8, warmup: 1.5, sampleRate: 24000, ...opts });
  console.log(
    `  ${label.padEnd(30)} clicks ${String(r.clicks).padStart(5)}  (${f(r.clickRate, 1).padStart(6)}/s)  ` +
    `worstJump ${f(r.worstJumpDb, 1).padStart(7)} dB  ratio ${f(r.worstRatio, 0).padStart(5)}  ` +
    `peak ${f(r.peakDb, 2).padStart(7)} dB  rms ${f(r.rmsDb, 1).padStart(6)}  dc ${r.dc.toExponential(1)}  nf ${r.nonFinite}`,
  );
  return r;
}

const want = (n) => only.length === 0 || only.includes(n);

if (want('scene')) {
  console.log('\nWHOLE MIX, no stall');
  for (const [k, v] of Object.entries(SCENE)) await row(k, { set: v, motion: 1.2, sails: { count: 18, area: 320, set: 1, luff: k === 'worst' ? 1 : 0.1 } });
}

if (want('fam')) {
  console.log('\nPER-FAMILY (gale, motion, some luff), no stall');
  for (const fam of FAMILIES) {
    await row(fam, { only: [fam], set: SCENE.gale, motion: 1.2, sails: { count: 18, area: 320, set: 1, luff: 0.4 } });
  }
}

if (want('stall')) {
  console.log('\nWHOLE MIX under simulated main-thread stalls');
  for (const st of [{ ms: 80, everyMs: 500 }, { ms: 120, everyMs: 700 }, { ms: 150, everyMs: 400 }]) {
    await row(`stall ${st.ms}ms/${st.everyMs}ms`, { set: SCENE.noon, motion: 1.2, stall: st, sails: { count: 18, area: 320, set: 1, luff: 0.1 } });
  }
  console.log('\nPER-FAMILY under 120ms/700ms stalls (gale)');
  for (const fam of FAMILIES) {
    await row(fam, { only: [fam], set: SCENE.gale, motion: 1.2, stall: { ms: 120, everyMs: 700 }, sails: { count: 18, area: 320, set: 1, luff: 0.4 } });
  }
}

if (want('sweep')) {
  console.log('\nSWEEPS (a moving target is where a step shows up)');
  for (const s of [
    { key: 'windSpeed', from: 2, to: 28 },
    { key: 'speedKnots', from: 0, to: 13 },
    { key: 'seaState', from: 1, to: 9 },
    { key: 'camDistance', from: 8, to: 400 },
  ]) {
    await row(`${s.key} ${s.from}->${s.to}`, { set: SCENE.noon, sweep: s, motion: 1.0, sails: { count: 18, area: 320, set: 1, luff: 0.2 } });
  }
}

if (want('headroom')) {
  console.log('\nRAW VOICE SUM (limiter bypassed) — worst case');
  await row('worst, limiter bypassed', { set: SCENE.worst, motion: 1.6, lightning: 90, bell: 8, bypassLimiter: true, sails: { count: 18, area: 340, set: 1, luff: 1 } });
  await row('worst, limiter in', { set: SCENE.worst, motion: 1.6, lightning: 90, bell: 8, sails: { count: 18, area: 340, set: 1, luff: 1 } });
}

if (errs.length) console.log('\nPAGE ERRORS:', errs.slice(0, 6).join(' | '));
await browser.close();
