#!/usr/bin/env node
/**
 * The audio acceptance test, with no dev server and no game.
 *
 * `audio-test.mjs` reaches the probe through the running dev server and the
 * booted game. That coupling has cost two measurement runs: five agents edit
 * this tree at once, Vite full-reloads on any module it cannot hot-patch, and a
 * reload mid-measurement destroys the `AudioContext` and the detector's counters
 * while every call still succeeds. It also means a broken ocean shader can stop
 * the audio module from being measured at all.
 *
 * So this bundles `src/audio` with esbuild, loads it on `about:blank`, and builds
 * the rig against a real `AudioContext` inside the page. What it gives up is the
 * blackboard wiring check — that stays in `audio-test.mjs`. What it gains is the
 * thing that actually matters:
 *
 *   1. CALIBRATION   inject discontinuities of known size at a known scheduling
 *                    lead and confirm the detector counts them. Every number
 *                    below is a zero, and DIAGNOSIS.md §25 lists ten instruments
 *                    that reported a confident zero because they were blind.
 *   2. STALLS        drive the rig on a real audio thread while blocking the main
 *                    thread 80-150 ms at intervals. A click IS a sample-to-sample
 *                    discontinuity, so this is the owner's symptom measured
 *                    directly. Clean without stalls and dirty with them is not a
 *                    pass: on the title screen `dt` averages 63.8 ms (§32), so
 *                    the stall is the normal case, not the exception.
 *   3. CEILING       peak, DC, NaN, denormals and the live node count.
 *
 *   node scripts/audio-live.mjs
 *   node scripts/audio-live.mjs --json
 */

import { chromium } from 'playwright';
import { build } from 'esbuild';
import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = { json: false, quick: false };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--json') args.json = true;
  else if (a === '--quick') args.quick = true;
}

const results = [];
let failures = 0;

function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  failures += ok ? 0 : 1;
  if (!args.json) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const fmt = (x, n = 2) => (Number.isFinite(x) ? x.toFixed(n) : String(x));

/* ------------------------------------------------------------------ *
 *  bundle
 * ------------------------------------------------------------------ */

/**
 * One self-contained IIFE on `window.__audio`. `addScriptTag({ content })`
 * inlines it, so nothing is fetched and `about:blank` needs no origin — which is
 * the whole point of not depending on a server.
 */
const entry = `
export { renderProbe, probeCensus, probeSensitivity } from '${path.join(root, 'src/audio/Probe.ts').replace(/\\/g, '/')}';
export { liveProbe } from '${path.join(root, 'src/audio/LiveProbe.ts').replace(/\\/g, '/')}';
export { LEAD_S, schedule } from '${path.join(root, 'src/audio/Context.ts').replace(/\\/g, '/')}';
`;

const bundled = await build({
  stdin: { contents: entry, resolveDir: root, loader: 'ts' },
  bundle: true,
  format: 'iife',
  globalName: '__audio',
  platform: 'browser',
  target: 'chrome120',
  write: false,
  logLevel: 'silent',
  legalComments: 'none',
});
const code = bundled.outputFiles[0].text;
if (!args.json) console.log(`bundled src/audio -> ${(code.length / 1024).toFixed(0)} KB`);

/* ------------------------------------------------------------------ *
 *  boot
 * ------------------------------------------------------------------ */

const browser = await chromium.launch({
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
const pageErrors = [];
const consoleLines = [];
page.on('pageerror', (e) => pageErrors.push(`pageerror: ${e.message}`));
page.on('console', (m) => consoleLines.push(`${m.type()}: ${m.text()}`));
/**
 * A real origin, served by Playwright itself rather than by a server.
 *
 * `about:blank` is not good enough: its origin is opaque, so
 * `URL.createObjectURL` yields `blob:null/...` and `audioWorklet.addModule`
 * refuses to fetch it. Both worklets in this module are loaded that way — the
 * rigging resonator bank and the click detector — so on `about:blank` the rig
 * silently fell back to biquads and the detector failed to attach at all,
 * reporting `usesWorklet=false` and a null `watch`. Intercepting a fake https
 * origin costs nothing and gives blob URLs somewhere to belong.
 */
const ORIGIN = 'https://leeward.test';
await page.route(`${ORIGIN}/**`, (route) =>
  route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>audio</title>' }),
);
await page.goto(`${ORIGIN}/`);
await page.addScriptTag({ content: code });

const call = (fn, arg) =>
  page.evaluate(
    ({ src, arg }) => new Function('audio', 'arg', `return (${src})(audio, arg)`)(window.__audio, arg),
    { src: fn.toString(), arg },
  );

const ready = await page.evaluate(() => typeof window.__audio?.liveProbe === 'function');
check('the audio module bundles and loads with no dev server', ready, ready ? 'window.__audio present' : 'bundle did not expose liveProbe');
if (!ready) {
  await browser.close();
  console.log(pageErrors.join('\n'));
  process.exit(1);
}

/* ------------------------------------------------------------------ *
 *  scenes
 * ------------------------------------------------------------------ */

const CALM = {
  seaState: 2, waveHeight: 0.6, choppiness: 0.25, windSpeed: 4.2, apparentWind: 4.2,
  speedKnots: 4, rain: 0, cloudCover: 0.2, camDistance: 40, exposure: 0.6, masterVolume: 0.8,
};
const GALE = {
  seaState: 7, waveHeight: 6.5, choppiness: 0.85, windSpeed: 22, apparentWind: 26,
  speedKnots: 11, rain: 0.85, cloudCover: 0.98, camDistance: 40, exposure: 0.6, masterVolume: 0.8,
};
const WORST = {
  windSpeed: 30, gust: 1.4, apparentWind: 34, seaState: 9, waveHeight: 12, choppiness: 1,
  rain: 1, cloudCover: 1, speedKnots: 13, bowSlam: 18, setRate: 1.2, braceRate: 1.2,
  rudderRate: 1.2, exposure: 1, camDistance: 8, landDistance: 120, masterVolume: 1, musicVolume: 1,
};

const live = (o) => call((a, arg) => a.liveProbe(arg), o);

/* ------------------------------------------------------------------ *
 *  1. calibration — can the detector see a click at all?
 * ------------------------------------------------------------------ */

if (!args.json) {
  console.log('\nCALIBRATION  deliberate 4 ms attack ramps injected at a known scheduling lead');
}
const LEADS = [-0.02, -0.005, 0, 0.002, 0.005, 0.02, 0.055];
const cal = await live({
  seconds: 3, warmup: 1.5, set: CALM, motion: 1,
  leads: LEADS, injectCount: 6,
});
for (const r of cal.leadSweep) {
  if (!args.json) {
    console.log(
      `    lead ${fmt(r.leadS * 1000, 1).padStart(6)} ms   ${String(r.clicks).padStart(3)}/${r.scheduled} caught   ` +
        `worst ${fmt(r.worstJumpDb, 1).padStart(6)} dBFS (x${fmt(r.worstRatio, 0)})`,
    );
  }
}
const rowAt = (lead) => cal.leadSweep.find((r) => Math.abs(r.leadS - lead) < 1e-9) ?? null;
const neg = rowAt(-0.02);
const atLead = rowAt(0.055);
const cleanest = cal.leadSweep
  .filter((r) => r.clicks === 0)
  .reduce((a, r) => (a === null || r.leadS < a.leadS ? r : a), null);

check(
  'the detector counts a click that is really there',
  neg !== null && neg.clicks >= neg.scheduled,
  neg
    ? `${neg.clicks}/${neg.scheduled} injected steps of ${fmt(20 * Math.log10(neg.amp), 1)} dBFS found, worst x${fmt(neg.worstRatio, 0)} over local`
    : 'the sweep did not run — every zero below would be unverified',
);
check(
  'LEAD_S is enough on this device',
  atLead !== null && atLead.clicks === 0,
  atLead ? `0/${atLead.scheduled} at 55 ms lead` : 'no reading',
);
check(
  'LEAD_S has margin over what this device needs',
  cleanest !== null && cleanest.leadS <= 0.055,
  cleanest
    ? `clean from ${fmt(cleanest.leadS * 1000, 1)} ms upward; LEAD_S is 55 ms; ` +
      `baseLatency ${fmt(cal.baseLatencyS * 1000, 2)} ms, outputLatency ${fmt(cal.outputLatencyS * 1000, 2)} ms`
    : 'no clean lead found — LEAD_S may be insufficient',
);

/* ------------------------------------------------------------------ *
 *  2. the acceptance test — a real audio thread, a stalling main thread
 * ------------------------------------------------------------------ */

if (!args.json) {
  console.log('\nSTALLS  live AudioContext, per-sample detector on the master, main thread blocked by spinning');
}

const SCENES = args.quick
  ? [['gale + 120 ms stalls', GALE, { ms: 120, everyMs: 400 }]]
  : [
      ['calm, no stall', CALM, null],
      ['calm + 80 ms stalls', CALM, { ms: 80, everyMs: 300 }],
      ['calm + 150 ms stalls', CALM, { ms: 150, everyMs: 250 }],
      ['gale, no stall', GALE, null],
      ['gale + 80 ms stalls', GALE, { ms: 80, everyMs: 300 }],
      ['gale + 120 ms stalls', GALE, { ms: 120, everyMs: 400 }],
      ['gale + 150 ms stalls', GALE, { ms: 150, everyMs: 250 }],
      ['worst case + 150 ms stalls', WORST, { ms: 150, everyMs: 250 }],
    ];

const stallRows = [];
for (const [label, set, stall] of SCENES) {
  const r = await live({ seconds: args.quick ? 8 : 10, warmup: 2, set, motion: set === WORST ? 1.6 : 1, stall: stall ?? undefined });
  const w = r.watch;
  stallRows.push({ label, stall, ...r });
  if (!args.json) {
    console.log(
      `    ${label.padEnd(26)} ${String(w?.clicks ?? '?').padStart(4)} clicks  ` +
        `${fmt(w?.clickRate ?? 0, 2).padStart(5)}/s   peak ${fmt(w?.peakDb ?? -240, 2).padStart(7)} dBFS   ` +
        `dt ${fmt(r.meanDtMs, 1).padStart(5)}/${fmt(r.maxDtMs, 0).padStart(4)} ms   ` +
        `cost ${fmt(r.costMeanMs, 3)}/${fmt(r.costMaxMs, 2)} ms` +
        (stall ? `   [${r.stalls} stalls, ${r.blockedMs} ms blocked]` : ''),
    );
  }
}

const stalled = stallRows.filter((r) => r.stall);
const unstalled = stallRows.filter((r) => !r.stall);
const clicks = (r) => r.watch?.clicks ?? -1;

check(
  'the sea is free of clicks with the main thread healthy',
  unstalled.length > 0 && unstalled.every((r) => clicks(r) === 0),
  unstalled.map((r) => `${r.label}:${clicks(r)}`).join(' ') || 'no reading',
);
check(
  'the sea is free of clicks with the main thread stalling 80-150 ms',
  stalled.length > 0 && stalled.every((r) => clicks(r) === 0),
  stalled.map((r) => `${clicks(r)}`).join('/') +
    ` clicks over ${stalled.reduce((a, r) => a + r.stalls, 0)} stalls / ` +
    `${stalled.reduce((a, r) => a + r.blockedMs, 0)} ms blocked` +
    ` (read with the detection floors below)`,
);
check(
  'stalls really did starve the frame loop',
  stalled.every((r) => r.maxDtMs > 70),
  `worst frame gap ${fmt(Math.max(...stalled.map((r) => r.maxDtMs)), 0)} ms, ` +
    `mean dt ${stalled.map((r) => fmt(r.meanDtMs, 0)).join('/')} ms — the title screen averages 63.8 ms (§32)`,
);

/* ------------------------------------------------------------------ *
 *  2b. what could each of those scenes have hidden?
 * ------------------------------------------------------------------ */

/**
 * A click count is not interpretable without the detection floor of the bed it
 * was measured under. The threshold is 12x the LOCAL first-difference RMS, so it
 * rises with the programme: the calibration above was run over a calm bed, and a
 * bright gale can mask a step that a calm bed makes obvious. Measured, not
 * assumed — the offline sweep found the gale hiding a -12 dBFS step outright.
 */
if (!args.json) console.log('\nDETECTION FLOOR  smallest guaranteed-late step each bed did NOT hide');
const AMPS = [0.71, 0.5, 0.25, 0.12, 0.05, 0.02, 0.008, 0.003];
const floors = {};
for (const [label, set] of [['calm', CALM], ['gale', GALE], ['worst case', WORST]]) {
  const r = await live({
    seconds: 2, warmup: 1.5, set, motion: set === WORST ? 1.6 : 1,
    amps: AMPS, injectCount: 6,
  });
  floors[label] = r;
  if (!args.json) {
    console.log(
      `    ${label.padEnd(11)} floor ${fmt(r.floorDb, 1).padStart(6)} dBFS   ` +
        `programme peak ${fmt(r.watch?.peakDb ?? -240, 1)} dBFS   ` +
        r.ampSweep.map((x) => `${fmt(20 * Math.log10(x.amp), 0)}:${x.clicks}/${x.scheduled}`).join(' '),
    );
  }
}
/**
 * The bar is set on the CALM bed on purpose, and this is the honest reading of
 * the whole click measurement.
 *
 * Measured floors: calm -42 dBFS against a -33 dBFS peak, so a step 9 dB below
 * the loudest sample is caught — that zero is real evidence. Gale -12 dBFS
 * against a -13 dBFS peak, and the worst case caught nothing at all below
 * -3 dBFS. In a bright broadband bed the local threshold rises above the
 * programme itself, so a gale's zero is WEAK evidence and must not be quoted as
 * proof. That is a property of masking, not a bug to be tuned away: raising
 * sensitivity by dropping CLICK_RATIO would buy ~3 dB against a >12 dB gap and
 * spend the false-positive margin the constant exists to protect.
 *
 * It is also the right priority. Directive 5 puts the calm sea first — it is
 * what the player sits in, and the title screen where the owner heard the worst
 * of it is a calm bed, not a gale.
 */
const calmFloor = floors.calm;
check(
  'the calm bed can be measured — its zero is backed by real sensitivity',
  calmFloor && calmFloor.floorDb <= (calmFloor.watch?.peakDb ?? 0) - 6,
  calmFloor
    ? `floor ${fmt(calmFloor.floorDb, 1)} dBFS vs peak ${fmt(calmFloor.watch?.peakDb ?? -240, 1)} dBFS ` +
      `(${fmt((calmFloor.watch?.peakDb ?? 0) - calmFloor.floorDb, 1)} dB of margin)`
    : 'no reading',
);
check(
  'the floor is known for every scene, so no zero is quoted blind',
  Object.values(floors).every((r) => r.ampSweep.length === AMPS.length),
  Object.entries(floors)
    .map(([k, r]) => `${k} ${r.floorDb > 200 ? 'BLIND' : fmt(r.floorDb, 1) + ' dBFS'} (peak ${fmt(r.watch?.peakDb ?? -240, 1)})`)
    .join(', ') + ' — loud beds mask, so their zeros are weak by construction',
);

/* ------------------------------------------------------------------ *
 *  3. the ceiling, and the lead invariant on live hardware
 * ------------------------------------------------------------------ */

const worstPeak = Math.max(...stallRows.map((r) => r.watch?.peak ?? 0));
const worstDc = Math.max(...stallRows.map((r) => Math.abs(r.watch?.dc ?? 0)));
check(
  'peak stays below 0 dBFS with margin in every scene',
  worstPeak > 0 && worstPeak < 0.9,
  `worst ${fmt(20 * Math.log10(worstPeak || 1e-12), 2)} dBFS across ${stallRows.length} scenes`,
);
check('nothing ever reaches full scale', stallRows.every((r) => (r.watch?.clipped ?? 1) === 0), `clipped samples ${stallRows.reduce((a, r) => a + (r.watch?.clipped ?? 0), 0)}`);
check('no DC offset', worstDc < 1e-3, worstDc.toExponential(2));
check(
  'no NaN, no Inf, no denormals',
  stallRows.every((r) => (r.watch?.nonFinite ?? 1) === 0 && (r.watch?.denormal ?? 1) === 0),
  stallRows.map((r) => `${r.watch?.nonFinite ?? '?'}/${r.watch?.denormal ?? '?'}`).join(' '),
);
check(
  'the node count is bounded and nothing is orphaned',
  stallRows.every((r) => r.liveNodes === r.createdNodes && r.liveNodes === stallRows[0].liveNodes),
  `${stallRows[0].liveNodes} live == created in every scene`,
);
check(
  'main-thread cost within the 1.5 ms budget',
  stallRows.every((r) => r.costMeanMs < 1.5),
  `worst mean ${fmt(Math.max(...stallRows.map((r) => r.costMeanMs)), 3)} ms/frame, worst single frame ${fmt(Math.max(...stallRows.map((r) => r.costMaxMs)), 2)} ms`,
);
check(
  'the AudioWorklet rigging bank is the one that ran',
  stallRows.every((r) => r.usesWorklet),
  `worklet=${stallRows.every((r) => r.usesWorklet)}`,
);
check(
  'no call site needed the backstop clamp on live hardware',
  stallRows.every((r) => r.late === 0),
  stallRows.every((r) => r.late === 0) ? 'every event built with eventTime()' : `${stallRows.reduce((a, r) => a + r.late, 0)} clamped`,
);
check(
  'LEAD_S covers this device’s render-ahead in every scene',
  stallRows.every((r) => r.shortfall === 0),
  `needLeadS ${fmt(Math.max(...stallRows.map((r) => r.needLeadS)) * 1000, 2)} ms vs LEAD_S ${fmt(stallRows[0].leadS * 1000, 1)} ms, ` +
    `worst frame gap seen by the scheduler ${fmt(Math.max(...stallRows.map((r) => r.frameGapS)) * 1000, 0)} ms`,
);

/* ------------------------------------------------------------------ *
 *  4. offline — calibrate the offline detector, then use it
 * ------------------------------------------------------------------ */

const renders = [];
const render = async (o, label) => {
  const r = await call((a, arg) => a.renderProbe(arg), o);
  renders.push({ label, ...r });
  return r;
};

if (!args.json) console.log('\nCALIBRATION offline detector — steps of known size added to a real render');
const sens = {};
for (const [label, o] of [
  ['calm bed', { seconds: 8, warmup: 2, only: ['sea'], motion: 1, set: { ...CALM, masterVolume: 1 } }],
  ['gale, everything', { seconds: 8, warmup: 2, motion: 1.6, set: { ...GALE, masterVolume: 1 } }],
]) {
  const r = await call((a, arg) => a.probeSensitivity(arg), o);
  sens[label] = r;
  if (!args.json) {
    console.log(
      `    ${label.padEnd(18)} programme ${fmt(r.peakDb, 1)} dBFS peak / ${fmt(r.rmsDb, 1)} dBFS RMS, ` +
        `false positives ${r.falsePositives}, threshold ${fmt(r.thresholdDb, 0)} dBFS\n` +
        `      ${r.steps.map((x) => `${x.db}:${x.found}/${x.injected}`).join(' ')}`,
    );
  }
}
check(
  'the offline detector does not invent clicks',
  Object.values(sens).every((r) => r.falsePositives === 0),
  Object.entries(sens).map(([k, r]) => `${k}:${r.falsePositives}`).join(' '),
);
// Same honest framing as the live floors: the calm bed is the case that has to
// be measurable, and the gale's threshold is reported rather than asserted
// because masking, not the code, is what sets it. Offline is also 24 kHz against
// the live 48 kHz, which halves the first-difference magnitudes and costs a
// further few dB of sensitivity — one more reason the offline zero is the weaker
// of the two and the live path is the acceptance test.
check(
  'the offline detector can measure the calm bed',
  sens['calm bed'].thresholdDb <= -30,
  `calm bed catches ${fmt(sens['calm bed'].thresholdDb, 0)} dBFS against a ` +
    `${fmt(sens['calm bed'].peakDb, 1)} dBFS peak; gale only ${fmt(sens['gale, everything'].thresholdDb, 0)} dBFS ` +
    'against -13 dBFS — so an offline zero in a gale is weak evidence',
);

/* ------------------------------------------------------------------ *
 *  5. offline — the sea bed on its own (AGENTS.md directive 5)
 * ------------------------------------------------------------------ */

if (!args.json) {
  console.log('\nOFFLINE the sea alone — the bed everything else sits under');
  console.log('    state        RMS    peak   centroid  sub/swell/body/break/hiss/air %        cv   rate');
}
const seaRows = [];
for (const [label, set] of [
  ['flat calm', { seaState: 0, waveHeight: 0.15, choppiness: 0.1, windSpeed: 1.5, speedKnots: 1 }],
  ['light air', { seaState: 2, waveHeight: 0.6, choppiness: 0.25, windSpeed: 4.2, speedKnots: 4 }],
  ['moderate', { seaState: 4, waveHeight: 2.0, choppiness: 0.6, windSpeed: 10.5, speedKnots: 6 }],
  ['gale', { seaState: 7, waveHeight: 6.5, choppiness: 0.85, windSpeed: 22, speedKnots: 11 }],
]) {
  const r = await render(
    {
      seconds: 30,
      warmup: 4,
      only: ['sea'],
      motion: 1,
      set: { ...CALM, ...set, apparentWind: set.windSpeed, masterVolume: 1, camDistance: 40 },
    },
    `sea ${label}`,
  );
  seaRows.push({ label, ...r });
  if (!args.json) {
    console.log(
      `    ${label.padEnd(10)} ${fmt(r.rmsDb, 1).padStart(6)} ${fmt(r.peakDb, 1).padStart(7)} ` +
        `${fmt(r.centroid, 0).padStart(7)} Hz   ${r.bands.map((b) => fmt(b * 100, 1).padStart(5)).join(' ')}   ` +
        `${fmt(r.envelopeCv, 2)}  ${fmt(r.envelopeRateHz, 3)} Hz`,
    );
  }
}
const calmSea = seaRows[0];
check(
  'the sea bed is clean at every state',
  seaRows.every((r) => r.clicks === 0),
  seaRows.map((r) => `${r.label}:${r.clicks}`).join(' '),
);
check(
  'the sea gets louder as it gets rougher',
  seaRows.every((r, i) => i === 0 || r.rms > seaRows[i - 1].rms),
  seaRows.map((r) => fmt(r.rmsDb, 1)).join(' -> ') + ' dBFS',
);
check(
  'a flat calm is quiet enough to sit in',
  calmSea.rmsDb < -30 && calmSea.rmsDb > -60,
  `${fmt(calmSea.rmsDb, 1)} dBFS`,
);
check(
  'a flat calm has no crest hiss on top of it',
  calmSea.bands[4] + calmSea.bands[5] < 0.06,
  `${fmt((calmSea.bands[4] + calmSea.bands[5]) * 100, 1)}% of power above 3 kHz`,
);
// Was 10% of the calm sea's power before the swell highpass went in (see
// Sea.ts); 5% is the bar that change has to keep clearing.
check(
  'nothing is wasted below hearing',
  seaRows.every((r) => r.bands[0] < 0.05),
  'sub-35 Hz ' + seaRows.map((r) => fmt(r.bands[0] * 100, 1) + '%').join(' '),
);
// The hole this catches is the one Sea.ts warns about: "a rumble with a hiss on
// top and nothing in between". The gale is the case that fails it — breaking
// water genuinely belongs up there, but not at the cost of the body.
check(
  'the bed keeps a body, it is not rumble plus hiss',
  seaRows.every((r) => r.bands[2] > 0.15),
  '150-800 Hz ' + seaRows.map((r) => fmt(r.bands[2] * 100, 0) + '%').join(' '),
);
check(
  'no state is dominated by spray',
  seaRows.every((r) => r.bands[4] + r.bands[5] < 0.25),
  'above 3 kHz ' + seaRows.map((r) => fmt((r.bands[4] + r.bands[5]) * 100, 0) + '%').join(' '),
);
check(
  'the sea breathes rather than sitting still or pumping',
  seaRows.every((r) => r.envelopeCv > 0.02 && r.envelopeCv < 0.5),
  'cv ' + seaRows.map((r) => fmt(r.envelopeCv, 2)).join(' ') + ' (0 = a drone, >0.5 = a tremolo)',
);
check(
  'that breathing is slow',
  seaRows.every((r) => r.envelopeRateHz < 0.4),
  seaRows.map((r) => `${fmt(r.envelopeRateHz, 3)} Hz = ${fmt(1 / Math.max(1e-6, r.envelopeRateHz), 0)} s`).join(', '),
);

/* ------------------------------------------------------------------ *
 *  5b. offline — the ear's speedometer
 * ------------------------------------------------------------------ */

/**
 * Guards the foam levels against being turned down until speed stops reading.
 * The hull rush and the wake are the only cues that report speed, and the
 * spectral rebalance above took 5-6 dB out of the two bright ones, so this has
 * to be asserted in the same run rather than trusted.
 */
if (!args.json) console.log('\nOFFLINE speed sweep 0 -> 13 kn at a fixed 8 m/s wind');
const speedRows = [];
for (const speedKnots of [0, 3, 6, 9, 13]) {
  const r = await render(
    {
      seconds: 6,
      warmup: 3,
      mute: ['music', 'wildlife', 'weather'],
      set: { ...CALM, windSpeed: 8, apparentWind: 8, seaState: 3, waveHeight: 1.2, speedKnots, masterVolume: 0.8 },
      sails: { count: 12, area: 300, set: 1, luff: 0 },
    },
    `speed ${speedKnots}`,
  );
  speedRows.push({ speedKnots, ...r });
  if (!args.json) {
    console.log(
      `    ${String(speedKnots).padStart(2)} kn   ${fmt(r.rmsDb, 1).padStart(6)} dBFS RMS   ` +
        `centroid ${fmt(r.centroid, 0).padStart(5)} Hz   above 3 kHz ${fmt((r.bands[4] + r.bands[5]) * 100, 1)}%`,
    );
  }
}
check(
  'spectral centroid rises with ship speed',
  speedRows.every((r, i) => i === 0 || r.centroid > speedRows[i - 1].centroid),
  speedRows.map((r) => fmt(r.centroid, 0)).join(' -> ') + ' Hz',
);
check(
  'the ship gets louder as it makes way',
  speedRows[speedRows.length - 1].rms > speedRows[0].rms * 1.4,
  `${fmt(speedRows[0].rmsDb, 1)} -> ${fmt(speedRows[speedRows.length - 1].rmsDb, 1)} dBFS`,
);
check(
  'the speed cue is clean at every speed',
  speedRows.every((r) => r.clicks === 0),
  speedRows.map((r) => `${r.speedKnots}kn:${r.clicks}`).join(' '),
);

/* ------------------------------------------------------------------ *
 *  6. offline — worst case, and the same with the loop stalling
 * ------------------------------------------------------------------ */

if (!args.json) console.log('\nOFFLINE worst case: 30 m/s, sea state 9, every sail luffing, lightning at 90 m, bell, near land');
const worstOpts = {
  seconds: 8,
  warmup: 0.5,
  motion: 1.6,
  lightning: 90,
  bell: 8,
  set: WORST,
  sails: { count: 18, area: 340, set: 1, luff: 1 },
};
const worst = await render(worstOpts, 'worst case');
if (!args.json) {
  console.log(
    `    ${fmt(worst.rmsDb, 1)} dBFS RMS   peak ${fmt(worst.peakDb, 2)} dBFS (${fmt(worst.peak, 4)})   ` +
      `dc ${worst.dc.toExponential(1)}   ${worst.clicks} clicks   ${worst.liveNodes} nodes`,
  );
}
const offStalls = [];
for (const stall of [{ ms: 80, everyMs: 300 }, { ms: 120, everyMs: 400 }, { ms: 150, everyMs: 250 }]) {
  const r = await render({ ...worstOpts, stall }, `stall ${stall.ms}/${stall.everyMs}`);
  offStalls.push({ stall, ...r });
  if (!args.json) {
    console.log(
      `    ${String(stall.ms).padStart(3)} ms every ${stall.everyMs} ms   ${String(r.clicks).padStart(3)} clicks   ` +
        `peak ${fmt(r.peakDb, 2)} dBFS   worst jump ${fmt(r.worstJumpDb, 1)} dBFS`,
    );
  }
}
check('the offline worst case never reaches 0 dBFS', worst.peak < 0.999, `peak ${fmt(worst.peakDb, 2)} dBFS`);
check('no NaN or Inf samples offline', worst.nonFinite === 0 && offStalls.every((r) => r.nonFinite === 0), `${worst.nonFinite} bad samples`);
check('no DC offset offline', Math.abs(worst.dc) < 1e-3, worst.dc.toExponential(2));
check('the offline worst case is free of discontinuities', worst.clicks === 0, `${worst.clicks} clicks, worst jump ${fmt(worst.worstJumpDb, 1)} dBFS`);
check(
  'a stalled driving loop does not step any parameter',
  offStalls.every((r) => r.clicks === 0),
  offStalls.map((r) => `${r.stall.ms}ms:${r.clicks}`).join(' '),
);

/* ------------------------------------------------------------------ *
 *  7. the scheduling-lead invariant over every offline render
 * ------------------------------------------------------------------ */

const minLead = Math.min(...renders.map((r) => r.minLeadS));
const writes = renders.reduce((a, r) => a + r.paramWrites, 0);
const valueWrites = renders.reduce((a, r) => a + r.valueWrites, 0);
const lateTotal = renders.reduce((a, r) => a + r.late, 0);
const required = renders[0].requiredLeadS;
const worstRender = renders.reduce((a, r) => (r.minLeadS < a.minLeadS ? r : a), renders[0]);
if (!args.json) {
  console.log(
    `\nSCHEDULING LEAD over ${renders.length} offline renders and ${writes} automation calls\n` +
      `    minimum lead ${fmt(minLead * 1000, 2)} ms (required ${fmt(required * 1000, 1)} ms), worst render '${worstRender.label}'`,
  );
}
check('the instrumentation actually ran', writes > 1000, `${writes} AudioParam calls seen`);
check(
  'no event is ever scheduled with less than LEAD_S of lead',
  minLead >= required - 1e-9,
  `min ${fmt(minLead * 1000, 2)} ms vs required ${fmt(required * 1000, 1)} ms ('${worstRender.label}')`,
);
check(
  'no call site needed the backstop clamp',
  lateTotal === 0,
  lateTotal === 0 ? 'every event built with eventTime()' : `${lateTotal} clamped`,
);
// A bare assignment carries no time, so `minLeadS` cannot see it: it applies at
// the next sample rendered, which makes it a step by construction. This is the
// only hole left in the lead invariant, and a grep is not an invariant.
check(
  'no running parameter is assigned with .value =',
  valueWrites === 0,
  valueWrites === 0 ? `0 bare assignments across ${writes} timed events` : `${valueWrites} bare assignments — each one is a step`,
);

/* ------------------------------------------------------------------ *
 *  8. pooling
 * ------------------------------------------------------------------ */

const census = await call((a, arg) => a.probeCensus(5, arg), {
  motion: 1.4,
  sails: { count: 18, area: 340, set: 1, luff: 0.7 },
  set: { ...GALE, setRate: 0.4, braceRate: 0.4, rudderRate: 0.5, landDistance: 300 },
});
if (!args.json) console.log(`\nOFFLINE 5 simulated minutes of a gale: ${census.frames} frames, created ${census.afterWarmup} -> ${census.afterRun}`);
check('no node created after warm-up (pooling works)', census.afterRun === census.afterWarmup, `${census.afterWarmup} at 5 s, ${census.afterRun} after 5 min`);
check('live == created (nothing orphaned)', census.live === census.afterRun, `live=${census.live}`);

/* ------------------------------------------------------------------ *
 *  9. console hygiene
 * ------------------------------------------------------------------ */

const noise = consoleLines.filter((l) => /autoplay|AudioContext|audioWorklet|\[audio\]/i.test(l));
check('no audio console warnings', noise.length === 0, noise.slice(0, 3).join(' | ') || 'clean');
check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | ') || 'clean');

await browser.close();

if (args.json) {
  console.log(JSON.stringify({ results, cal, floors, stallRows, sens, seaRows, speedRows, worst, offStalls, census, renders }, null, 2));
} else {
  console.log(`\n${results.length - failures}/${results.length} checks passed`);
}
process.exit(failures > 0 ? 1 : 0);
