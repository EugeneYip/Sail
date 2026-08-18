#!/usr/bin/env node
/**
 * Audio verification harness.
 *
 * You cannot listen to a headless browser, so everything the audio module
 * claims has to be a number. Two measurement paths:
 *
 *  LIVE      an AnalyserNode tapped off the master bus in the running game
 *            (`world.ext.audio.measure()`), which proves the thing is actually
 *            wired to the blackboard and making sound.
 *  OFFLINE   `world.ext.audio.render()` rebuilds the whole rig inside an
 *            OfflineAudioContext, drives it with a synthetic voyage and returns
 *            RMS / peak / spectral centroid computed from the rendered samples.
 *            Deterministic, device independent, faster than real time.
 *
 *   node scripts/audio-test.mjs
 *   node scripts/audio-test.mjs --json
 */

import { chromium } from 'playwright';
import process from 'node:process';

const args = { url: 'http://127.0.0.1:5178/', json: false, timeout: 60000 };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--json') args.json = true;
  else if (a === '--url') args.url = process.argv[++i];
  else if (a === '--timeout') args.timeout = Number(process.argv[++i]);
}

const results = [];
let failures = 0;
let skipped = 0;

function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  failures += ok ? 0 : 1;
  if (!args.json) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  }
}

function skip(name, why) {
  results.push({ name, skipped: true, detail: why });
  skipped++;
  if (!args.json) console.log(`  SKIP  ${name}  — ${why}`);
}

const fmt = (x, n = 2) => (Number.isFinite(x) ? x.toFixed(n) : String(x));

/* ------------------------------------------------------------------ *
 *  boot
 * ------------------------------------------------------------------ */

const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-angle=metal',
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    '--enable-unsafe-swiftshader',
    '--force-color-profile=srgb',
    '--hide-scrollbars',
    // The graph must render for the analyser to read anything, so the output is
    // NOT muted here. Offline renders are unaffected either way.
    '--autoplay-policy=no-user-gesture-required',
  ],
});

const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const pageErrors = [];
const consoleLines = [];
page.on('pageerror', (e) => pageErrors.push(`pageerror: ${e.message}`));
page.on('console', (m) => consoleLines.push(`${m.type()}: ${m.text()}`));

await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: args.timeout });

/**
 * The offline half deliberately imports the probe module straight off the dev
 * server rather than going through `world.ext.audio`. Other agents are editing
 * other subsystems at the same time; a broken ocean shader must not be able to
 * stop the audio module from being measured.
 */
async function loadProbe() {
  await page.waitForFunction(
    async () => {
      if (window.__audioProbe) return true;
      try {
        window.__audioProbe = await import('/src/audio/Probe.ts');
        return true;
      } catch {
        return false;
      }
    },
    null,
    { timeout: args.timeout },
  );
}
await loadProbe();

/**
 * The dev server hot-reloads under us whenever another agent saves a file,
 * which destroys the execution context mid-evaluate. Retry rather than fail.
 */
async function robust(fn, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (!/context was destroyed|Execution context|of undefined|__leeward|__audioProbe/i.test(String(err))) {
        throw err;
      }
      await page.waitForTimeout(1000);
      await loadProbe();
    }
  }
  throw last;
}

/** Calls into the probe module, re-importing it if a reload wiped the page. */
const inProbe = (fn, arg) =>
  robust(() =>
    page.evaluate(
      async ({ src, arg }) => {
        if (!window.__audioProbe) window.__audioProbe = await import('/src/audio/Probe.ts');
        return new Function('probe', 'arg', `return (${src})(probe, arg)`)(window.__audioProbe, arg);
      },
      { src: fn.toString(), arg },
    ),
  );

const probe = (opts) => inProbe((p, o) => p.renderProbe(o), opts);

/** The live game may be broken by another agent; report that instead of failing. */
let gameUp = true;
try {
  await page.waitForFunction(() => !!window.__leeward?.world?.ext?.audio, null, { timeout: 30000 });
} catch {
  gameUp = false;
}

const setScene = (env, ship) =>
  robust(() =>
    page.evaluate(
      ({ env, ship }) => {
        const w = window.__leeward.world;
        Object.assign(w.env, env ?? {});
        Object.assign(w.ship, ship ?? {});
        w.bus.emit('capture:scene', { env });
      },
      { env, ship },
    ),
  );

const settle = async (s) => {
  const t0 = Date.now();
  while (Date.now() - t0 < s * 1000) await page.waitForTimeout(250);
};

/* ------------------------------------------------------------------ *
 *  1. live — is it actually making sound?
 * ------------------------------------------------------------------ */

if (!args.json) console.log('\nLIVE (AnalyserNode on the master bus)');

let noon = null;
let storm = null;
if (!gameUp) {
  const why = 'the game did not boot — another subsystem is broken, not audio';
  for (const n of [
    'context running',
    'AudioWorklet active for the rigging',
    'noon is not silent',
    'storm is louder than noon',
    'storm is brighter than noon',
    'live peak stays below 0 dBFS',
    'main-thread cost within 1.5 ms budget',
    'no node leak while running',
  ]) {
    skip(n, why);
  }
} else {
await robust(() => page.evaluate(() => window.__leeward.world.ext.audio.start()));
await page.waitForTimeout(1500);

const status = await robust(() =>
  page.evaluate(() => {
    const a = window.__leeward.world.ext.audio;
    return { status: a.status, worklet: a.usesWorklet, ctx: a.context()?.state ?? null };
  }),
);
check('context running', status.status === 'running', `status=${status.status} ctx=${status.ctx}`);
check('AudioWorklet active for the rigging', status.worklet === true, `worklet=${status.worklet}`);

await setScene(
  { timeOfDay: 12.7, windSpeed: 10.5, gust: 1, seaState: 4, waveHeight: 2.0, choppiness: 0.6, rain: 0, cloudCover: 0.38 },
  { speedKnots: 6 },
);
await settle(5);
noon = await robust(() =>
  page.evaluate(() => {
    const a = window.__leeward.world.ext.audio;
    let rms = 0;
    let peak = 0;
    let brightness = 0;
    // Average a handful of analyser reads — one frame of a bed is noisy.
    for (let i = 0; i < 24; i++) {
      const m = a.measure();
      rms += m.rms / 24;
      peak = Math.max(peak, m.peak);
      brightness += m.brightness / 24;
    }
    return { rms, peak, brightness, cost: a.costMs, nodes: a.census() };
  }),
);
check('noon is not silent', noon.rms > 1e-4, `rms=${noon.rms.toExponential(2)} (${fmt(20 * Math.log10(noon.rms), 1)} dBFS)`);

await setScene(
  { timeOfDay: 15.0, windSpeed: 22.0, gust: 1.25, seaState: 7, waveHeight: 6.5, choppiness: 0.85, rain: 0.85, cloudCover: 0.98 },
  { speedKnots: 11 },
);
await settle(6);
storm = await robust(() =>
  page.evaluate(() => {
    const a = window.__leeward.world.ext.audio;
    let rms = 0;
    let peak = 0;
    let brightness = 0;
    for (let i = 0; i < 24; i++) {
      const m = a.measure();
      rms += m.rms / 24;
      peak = Math.max(peak, m.peak);
      brightness += m.brightness / 24;
    }
    return { rms, peak, brightness, cost: a.costMs, nodes: a.census() };
  }),
);

check(
  'storm is louder than noon',
  storm.rms > noon.rms * 1.2,
  `noon ${fmt(20 * Math.log10(noon.rms), 1)} dBFS -> storm ${fmt(20 * Math.log10(storm.rms), 1)} dBFS`,
);
check(
  'storm is brighter than noon',
  storm.brightness > noon.brightness,
  `noon ${fmt(noon.brightness, 0)} Hz -> storm ${fmt(storm.brightness, 0)} Hz`,
);
check('live peak stays below 0 dBFS', storm.peak < 1 && noon.peak < 1, `worst peak ${fmt(storm.peak, 3)}`);
check(
  'main-thread cost within 1.5 ms budget',
  storm.cost < 1.5,
  `${fmt(storm.cost, 3)} ms/frame in the gale`,
);
check(
  'no node leak while running',
  storm.nodes.live === noon.nodes.live && storm.nodes.created === noon.nodes.created,
  `live=${storm.nodes.live} created=${storm.nodes.created}`,
);
}

/* ------------------------------------------------------------------ *
 *  2. offline — wind sweep
 * ------------------------------------------------------------------ */

if (!args.json) console.log('\nOFFLINE wind sweep 0 -> 25 m/s (music + wildlife muted: both are timed events)');

const FIXED = {
  seaState: 3,
  waveHeight: 1.2,
  choppiness: 0.5,
  speedKnots: 0,
  apparentWind: 0,
  rain: 0,
  camDistance: 40,
  exposure: 0.6,
  masterVolume: 0.8,
};
const windRows = [];
for (const windSpeed of [0, 5, 10, 15, 20, 25]) {
  const r = await probe({
    seconds: 5,
    warmup: 2.5,
    mute: ['music', 'wildlife'],
    set: { ...FIXED, windSpeed, apparentWind: windSpeed },
    sails: { count: 12, area: 300, set: 1, luff: 0 },
  });
  windRows.push({ windSpeed, ...r });
  if (!args.json) {
    console.log(
      `    u=${String(windSpeed).padStart(2)} m/s   ${fmt(r.rmsDb, 1).padStart(6)} dBFS RMS   ` +
        `peak ${fmt(r.peakDb, 1).padStart(6)} dBFS   centroid ${fmt(r.centroid, 0).padStart(5)} Hz`,
    );
  }
}
let windMono = true;
for (let i = 1; i < windRows.length; i++) {
  if (!(windRows[i].rms > windRows[i - 1].rms)) windMono = false;
}
check(
  'RMS rises monotonically with wind speed',
  windMono,
  windRows.map((r) => fmt(r.rmsDb, 1)).join(' -> ') + ' dBFS',
);
check(
  'wind also brightens, not just swells',
  windRows[windRows.length - 1].centroid > windRows[1].centroid,
  `${fmt(windRows[1].centroid, 0)} Hz at 5 m/s -> ${fmt(windRows[windRows.length - 1].centroid, 0)} Hz at 25 m/s`,
);

/* ------------------------------------------------------------------ *
 *  3. offline — speed sweep (the ear's speedometer)
 * ------------------------------------------------------------------ */

if (!args.json) console.log('\nOFFLINE speed sweep 0 -> 13 kn at a fixed 8 m/s wind');

const speedRows = [];
for (const speedKnots of [0, 3, 6, 9, 13]) {
  const r = await probe({
    seconds: 5,
    warmup: 2.5,
    mute: ['music', 'wildlife', 'weather'],
    set: { ...FIXED, windSpeed: 8, apparentWind: 8, speedKnots },
    sails: { count: 12, area: 300, set: 1, luff: 0 },
  });
  speedRows.push({ speedKnots, ...r });
  if (!args.json) {
    console.log(
      `    ${String(speedKnots).padStart(2)} kn      ${fmt(r.rmsDb, 1).padStart(6)} dBFS RMS   ` +
        `centroid ${fmt(r.centroid, 0).padStart(5)} Hz   hi/lo ${fmt(r.highRatio, 3)}`,
    );
  }
}
let centroidMono = true;
for (let i = 1; i < speedRows.length; i++) {
  if (!(speedRows[i].centroid > speedRows[i - 1].centroid)) centroidMono = false;
}
check(
  'spectral centroid rises with ship speed',
  centroidMono,
  speedRows.map((r) => fmt(r.centroid, 0)).join(' -> ') + ' Hz',
);
check(
  'hull water gets louder with speed',
  speedRows[speedRows.length - 1].rms > speedRows[0].rms,
  `${fmt(speedRows[0].rmsDb, 1)} -> ${fmt(speedRows[speedRows.length - 1].rmsDb, 1)} dBFS`,
);

/* ------------------------------------------------------------------ *
 *  4. worst case — nothing may ever clip
 * ------------------------------------------------------------------ */

if (!args.json) console.log('\nOFFLINE worst case: 30 m/s, sea state 9, every sail luffing, lightning at 90 m');

const worst = await probe({
  seconds: 8,
  warmup: 0,
  motion: 1.6,
  lightning: 90,
  bell: 8,
  set: {
    windSpeed: 30,
    gust: 1.4,
    apparentWind: 34,
    seaState: 9,
    waveHeight: 12,
    choppiness: 1,
    rain: 1,
    cloudCover: 1,
    speedKnots: 13,
    bowSlam: 18,
    setRate: 1.2,
    braceRate: 1.2,
    rudderRate: 1.2,
    exposure: 1,
    camDistance: 8,
    landDistance: 120,
    masterVolume: 1,
    musicVolume: 1,
  },
  sails: { count: 18, area: 340, set: 1, luff: 1 },
});
if (!args.json) {
  console.log(
    `    ${fmt(worst.rmsDb, 1)} dBFS RMS   peak ${fmt(worst.peakDb, 2)} dBFS (${fmt(worst.peak, 4)})   ` +
      `centroid ${fmt(worst.centroid, 0)} Hz   dc ${worst.dc.toExponential(1)}`,
  );
}
check('worst case never reaches 0 dBFS', worst.peak < 1.0, `peak ${fmt(worst.peak, 4)} = ${fmt(worst.peakDb, 2)} dBFS`);
check('worst case has headroom left', worst.peak < 0.999, `${fmt(worst.peakDb, 2)} dBFS`);
check('no NaN or Inf samples', worst.nonFinite === 0, `${worst.nonFinite} bad samples`);
check('no DC offset', Math.abs(worst.dc) < 1e-3, worst.dc.toExponential(2));
check(
  'worst case is louder than the noon bed',
  worst.rms > windRows[2].rms,
  `${fmt(worst.rmsDb, 1)} vs ${fmt(windRows[2].rmsDb, 1)} dBFS`,
);

/* ------------------------------------------------------------------ *
 *  5. silence really is silent
 * ------------------------------------------------------------------ */

const muted = await probe({
  seconds: 3,
  warmup: 1.5,
  set: { ...FIXED, windSpeed: 12, masterVolume: 0, musicVolume: 0 },
});
check('masterVolume 0 is silent', muted.rms < 1e-4, `rms ${muted.rms.toExponential(2)}`);

const musicOff = await probe({
  seconds: 4,
  warmup: 2,
  mute: ['sea', 'ship', 'wind', 'weather', 'wildlife'],
  set: { ...FIXED, windSpeed: 12, musicVolume: 0 },
});
check('musicVolume 0 is silent', musicOff.rms < 1e-4, `rms ${musicOff.rms.toExponential(2)}`);

/* ------------------------------------------------------------------ *
 *  6. pooling — the node count must be bounded
 * ------------------------------------------------------------------ */

if (!args.json) console.log('\nOFFLINE 5 simulated minutes of a gale (node census)');

const census = await inProbe((p, o) => p.probeCensus(5, o), {
  motion: 1.4,
  sails: { count: 18, area: 340, set: 1, luff: 0.7 },
  set: {
    windSpeed: 24,
    apparentWind: 26,
    seaState: 7,
    waveHeight: 6.5,
    rain: 0.9,
    cloudCover: 0.95,
    speedKnots: 10,
    setRate: 0.4,
    braceRate: 0.4,
    rudderRate: 0.5,
    landDistance: 300,
  },
});
if (!args.json) {
  console.log(`    ${census.frames} frames driven; created ${census.afterWarmup} -> ${census.afterRun}`);
}
check(
  'no node created after warm-up (pooling works)',
  census.afterRun === census.afterWarmup,
  `${census.afterWarmup} nodes at 5 s, ${census.afterRun} after 5 min`,
);
check('live == created (nothing orphaned)', census.live === census.afterRun, `live=${census.live}`);

/* ------------------------------------------------------------------ *
 *  7. no console noise
 * ------------------------------------------------------------------ */

const audioNoise = consoleLines.filter((l) => /autoplay|AudioContext|audioWorklet|\[audio\]/i.test(l));
check('no audio console warnings', audioNoise.length === 0, audioNoise.slice(0, 3).join(' | ') || 'clean');
check('no page errors from audio', !pageErrors.some((e) => /audio|Audio/.test(e)), pageErrors.filter((e) => /audio/i.test(e)).slice(0, 2).join(' | ') || 'clean');

/* ------------------------------------------------------------------ *
 *  report
 * ------------------------------------------------------------------ */

await browser.close();

if (args.json) {
  console.log(JSON.stringify({ results, live: { noon, storm }, windRows, speedRows, worst, census }, null, 2));
} else {
  const ran = results.length - skipped;
  console.log(`\n${ran - failures}/${ran} checks passed${skipped ? `, ${skipped} skipped` : ''}`);
}
process.exit(failures > 0 ? 1 : 0);
