#!/usr/bin/env node
/**
 * Controlled-arm measurement harness.
 *
 * This exists because of a specific, repeated failure. Over one long session five
 * separate conclusions were retracted, and every one of them came from the same
 * small set of instrument mistakes rather than from bad reasoning about the engine:
 *
 *   - sequential arms measured in ONE page load, so simulation drift accumulated
 *     between them and, in an ascending parameter sweep, drifted in the same
 *     direction as the parameter (retracted a 5.5-code result, and an "impossible"
 *     ordering where two casters disabled brightened less than either alone);
 *   - dt = 0 to freeze the scene, which also stops subsystems that only refresh on
 *     a time step -- the shadow map never re-rendered, so every caster toggle was
 *     measured against a stale map;
 *   - levers that did not bind: a clamp set above the value it was meant to clamp,
 *     a uniform rewritten from settings every frame, `castShadow = false` which
 *     three ignores for receivers under VSM, and a `customProgramCacheKey` that
 *     returned a constant so `onBeforeCompile` was never called;
 *   - a sample region defined using the very quantity being measured;
 *   - reporting a median where the invariant was a mean.
 *
 * The one thing that caught all of them was a control channel the arm could not
 * possibly influence. When the control moved as much as the result, the result was
 * noise. So this harness makes that the default rather than something each probe
 * re-invents: fresh load per arm, declared-up-front regions, a mandatory control,
 * repeats, and an explicit verdict that REJECTS any delta inside control variance.
 *
 * It is deliberately not a framework. It runs arms and reports numbers with the
 * traps closed. Anything cleverer belongs in the probe, not here.
 *
 *   node scripts/measure.mjs --selftest
 *
 * As a library:
 *
 *   import { measure } from './measure.mjs';
 *   const report = await measure({
 *     scene: { timeOfDay: 12.3, seaState: 3 },     // env, applied before settling
 *     camera: { mode: 'chase', distance: 76 },
 *     dtPolicy: 'whole',                           // whole | fract | fixed | zero
 *     samples: 400, repeats: 2,
 *     channels: ['shipY', 'speed'],
 *     control: ['speed'],            // arms MUST NOT be able to influence these
 *     sample: () => ({ ... }),       // in-page, per frame, returns numbers
 *     arms: [{ name: 'base', apply: null },
 *            { name: 'x', apply: () => { ...; return { bound: true }; } }],
 *   });
 *
 * `sample` and `apply` are serialised to the page, so they must be self-contained:
 * no closures over Node scope. `apply` must return `{ bound: true }` or the arm is
 * reported NOT-BOUND and its numbers are withheld.
 */

import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import process from 'node:process';

const F = 1000 / 60;

/**
 * dt sequences. `zero` exists only so a caller who wants it has to name it, and it
 * warns: a zero step does not advance subsystems that refresh on a time step, which
 * is how a whole session's shadow measurements came to be taken against a stale map.
 */
export const DT_POLICIES = {
  fixed: [1].map((k) => k * F),
  whole: [1, 1, 2, 1, 3, 1, 1, 2, 1, 1, 4, 1, 2, 1, 1, 1].map((k) => k * F),
  fract: [1.37, 0.83, 2.41, 1.12, 0.67, 3.19, 1.05, 1.83, 0.91, 2.07, 1.44, 0.78].map((k) => k * F),
  zero: [0],
};

/**
 * Range-to-sigma factors (d2). A repeat range is a range, not a standard deviation;
 * dividing by d2 turns it into an unbiased sigma estimate for that sample size.
 */
const D2 = { 2: 1.128, 3: 1.693, 4: 2.059, 5: 2.326, 6: 2.534 };

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
const median = (a) => { const b = [...a].sort((x, y) => x - y);
  return b.length % 2 ? b[b.length >> 1] : (b[b.length / 2 - 1] + b[b.length / 2]) / 2; };

/** Both, always. Picking one after seeing the data is how a mean invariant got read as a median. */
function summarise(series) {
  return { n: series.length, mean: mean(series), median: median(series), sd: sd(series),
    min: Math.min(...series), max: Math.max(...series) };
}

function head() {
  try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); }
  catch { return 'unknown'; }
}

/**
 * Run every arm and report. One fresh page load per arm per repeat unless the caller
 * explicitly opts out, because sharing a load between arms is the single mistake
 * that produced the most false positives.
 */
export async function measure(cfg) {
  const {
    url = 'http://127.0.0.1:5178/',
    scene = {}, camera = { mode: 'chase', distance: 76 },
    width = 1280, height = 720,
    dtPolicy = 'whole', settleMs = 12000, warmFrames = 180, samples = 300,
    repeats = 2, channels, control = [], sample, arms,
    station = null, freshLoadPerArm = true, quiet = false,
  } = cfg;

  if (!Array.isArray(arms) || !arms.length) throw new Error('measure: arms required');
  if (typeof sample !== 'function') throw new Error('measure: sample() required');
  if (!Array.isArray(channels) || !channels.length) throw new Error('measure: channels required');
  if (!control.length) throw new Error('measure: at least one control channel required — ' +
    'a channel the arms cannot influence is the only thing that reliably catches a null result');
  for (const c of control) if (!channels.includes(c)) throw new Error(`measure: control '${c}' not in channels`);

  const seq = DT_POLICIES[dtPolicy];
  if (!seq) throw new Error(`measure: unknown dtPolicy '${dtPolicy}'`);
  const warnings = [];
  if (dtPolicy === 'zero') warnings.push(
    'dtPolicy=zero: subsystems that refresh on a time step (shadow maps, probe ' +
    'cooldowns, temporal post) will NOT update. Do not measure them on this policy.');
  if (repeats < 3) warnings.push(
    `repeats=${repeats}: the per-channel noise floor is estimated from a range of ` +
    `${repeats} and is weak. Use 3+ repeats before believing a marginal result.`);
  if (!freshLoadPerArm) warnings.push(
    'freshLoadPerArm=false: arms share simulation state, so later arms are drifted ' +
    'relative to earlier ones. Any monotonic trend across arms is suspect.');

  const meta = { head: head(), scene, camera, width, height, dtPolicy,
    dtSeqLen: seq.length, settleMs, warmFrames, samples, repeats,
    channels, control, freshLoadPerArm, when: new Date().toISOString() };

  const browser = await chromium.launch({ headless: true,
    args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--mute-audio'] });
  const page = await browser.newPage({ viewport: { width, height } });
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 160)); });

  const load = async () => {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__leeward, null, { timeout: 120000 });
    await page.evaluate(([scene, camera]) => {
      const w = window.__leeward.world;
      w.settings.adaptiveResolution = false; w.settings.renderScale = 1;
      Object.assign(w.env, scene);
      Object.assign(w.cam, camera);
      w.bus.emit('settings:changed'); w.bus.emit('capture:scene', {});
    }, [scene, camera]);
    await page.waitForTimeout(settleMs);
    if (station) await page.evaluate(station);
  };

  const results = {};
  let loaded = false;
  for (const arm of arms) {
    results[arm.name] = { reps: [], bound: null };
    for (let rep = 0; rep < repeats; rep++) {
      if (freshLoadPerArm || !loaded) { await load(); loaded = true; }
      const r = await page.evaluate(([applySrc, sampleSrc, seq, warmFrames, samples, channels]) => {
        const eng = window.__leeward, w = eng.world;
        eng.stop();
        const applyFn = applySrc ? eval('(' + applySrc + ')') : null;
        const sampleFn = eval('(' + sampleSrc + ')');
        let bound = true;
        const doApply = () => { if (!applyFn) return; const res = applyFn(w, eng);
          if (res && res.bound === false) bound = false; };
        doApply();
        let t = eng.lastTime, i = 0;
        const step = () => { const dt = seq[i++ % seq.length]; t += dt; doApply(); eng.tick(t); return dt / 1000; };
        for (let k = 0; k < warmFrames; k++) step();
        const cols = {}; for (const c of channels) cols[c] = [];
        const dts = [];
        for (let k = 0; k < samples; k++) {
          const dt = step();
          const row = sampleFn(w, eng);
          dts.push(dt);
          for (const c of channels) cols[c].push(Number(row[c]));
        }
        return { bound, cols, dts };
      }, [arm.apply ? arm.apply.toString() : null, sample.toString(), seq, warmFrames, samples, channels]);
      results[arm.name].bound = arm.apply ? r.bound : true;
      results[arm.name].reps.push(r.cols);
      if (!quiet) process.stdout.write(`  ${arm.name} rep${rep} ok\n`);
    }
  }
  await browser.close();

  // ---- verdicts -------------------------------------------------------------
  // Control variance is measured two ways and the larger is used: spread of the
  // control channel BETWEEN repeats of the same arm, and its spread across arms.
  // Anything a real effect has to clear.
  const armNames = arms.map((a) => a.name);
  const perArm = {};
  for (const n of armNames) {
    perArm[n] = {};
    for (const c of channels) {
      const reps = results[n].reps.map((cols) => summarise(cols[c]));
      perArm[n][c] = { mean: mean(reps.map((s) => s.mean)), median: mean(reps.map((s) => s.median)),
        sd: mean(reps.map((s) => s.sd)), repSpread: reps.length > 1
          ? Math.max(...reps.map((s) => s.mean)) - Math.min(...reps.map((s) => s.mean)) : NaN };
    }
  }
  const controlFloor = {};
  for (const c of control) {
    const withinRep = Math.max(...armNames.map((n) => perArm[n][c].repSpread || 0));
    const across = Math.max(...armNames.map((n) => perArm[n][c].mean))
      - Math.min(...armNames.map((n) => perArm[n][c].mean));
    controlFloor[c] = { withinRep, acrossArms: across, floor: Math.max(withinRep, across) };
  }
  // A single scalar floor per channel: scale the control's relative floor onto it.
  const baseName = armNames[0];
  const relFloor = Math.max(...control.map((c) => {
    const f = controlFloor[c].floor, m = Math.abs(perArm[baseName][c].mean);
    return m > 1e-12 ? f / m : f;
  }));
  // Per-channel allowance. Two terms, and the larger wins.
  //
  // The relative control floor alone is NOT enough, and the self-test caught this:
  // scaling a relative floor onto a channel whose mean oscillates about zero (heave)
  // collapses the allowance to nothing and reports a film-grain arm as moving the
  // hull. So the channel's own SCALE is max(|mean|, sd) -- for a zero-mean
  // oscillating quantity the amplitude is the meaningful scale, not the mean.
  //
  // The second term is empirical: how much this channel already disagrees between
  // repeats of the SAME arm. That is the channel's own reproducibility floor and it
  // needs no assumption about distribution.
  const verdicts = {};
  for (const n of armNames.slice(1)) {
    verdicts[n] = {};
    for (const c of channels) {
      const d = perArm[n][c].mean - perArm[baseName][c].mean;
      const scale = Math.max(Math.abs(perArm[baseName][c].mean), perArm[baseName][c].sd);
      // The repeat RANGE is not a noise floor on its own. With two repeats it is the
      // range of two samples, which underestimates the spread about half the time --
      // the self-test caught this too, reporting a film-grain arm as moving ship
      // speed. Convert range to a sigma estimate with the standard d2 factor, then
      // allow a 3-sigma margin on the DIFFERENCE of two arm means.
      const ranges = armNames.map((m) => perArm[m][c].repSpread).filter((x) => Number.isFinite(x));
      const sigma = ranges.length ? mean(ranges) / (D2[Math.min(repeats, 6)] ?? 1.128) : 0;
      const repFloor = 3 * sigma * Math.sqrt(2 / Math.max(1, repeats));
      const allow = Math.max(scale * relFloor, repFloor);
      verdicts[n][c] = { delta: d, allow, scale, repFloor,
        verdict: !results[n].bound ? 'NOT-BOUND'
          : Math.abs(d) > allow ? 'SIGNIFICANT' : 'REJECTED (within control variance)' };
    }
  }
  return { meta, warnings, consoleErrors, perArm, controlFloor, relFloor, verdicts,
    bound: Object.fromEntries(armNames.map((n) => [n, results[n].bound])) };
}

/** Human-readable dump. Prints the control floor before the results, on purpose. */
export function report(r, channelsToShow = null) {
  const chans = channelsToShow || r.meta.channels;
  console.log(`\n  HEAD ${r.meta.head}  dt=${r.meta.dtPolicy}  ${r.meta.width}x${r.meta.height}`
    + `  samples=${r.meta.samples} repeats=${r.meta.repeats}  freshLoad=${r.meta.freshLoadPerArm}`);
  console.log(`  scene ${JSON.stringify(r.meta.scene)}  camera ${JSON.stringify(r.meta.camera)}`);
  for (const w of r.warnings) console.log(`  !! ${w}`);
  console.log(`  CONTROL FLOOR (relative): ${(r.relFloor * 100).toFixed(2)}%`);
  for (const [c, f] of Object.entries(r.controlFloor))
    console.log(`    ${c}: withinRep ${f.withinRep.toPrecision(3)}  acrossArms ${f.acrossArms.toPrecision(3)}`);
  const arms = Object.keys(r.perArm);
  for (const c of chans) {
    console.log(`  -- ${c}`);
    for (const n of arms) {
      const p = r.perArm[n][c];
      const v = r.verdicts[n]?.[c];
      console.log(`    ${n.padEnd(16)} mean ${p.mean.toPrecision(6).padStart(13)}`
        + ` median ${p.median.toPrecision(6).padStart(13)} sd ${p.sd.toPrecision(4).padStart(11)}`
        + (v ? `  delta ${v.delta.toPrecision(3).padStart(11)}`
            + ` allow ${v.allow.toPrecision(3).padStart(10)}  ${v.verdict}` : '  (baseline)'));
    }
  }
  if (r.consoleErrors.length) console.log(`  console errors: ${r.consoleErrors.length}`);
}
