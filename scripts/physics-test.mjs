#!/usr/bin/env node
/**
 * Physics acceptance tests.
 *
 * Drives the real solver in the real page through `world.ext.physics`, which
 * exposes a deterministic stepper: nothing else in the engine ticks while
 * `run()` is inside it, so the only variable is the frame rate being simulated
 * and every number below is repeatable.
 *
 *   node scripts/physics-test.mjs
 *   node scripts/physics-test.mjs --quick     # shorter settles, for iterating
 *
 * Exit code is non-zero if any assertion fails. What it asserts:
 *
 *   polar         close-hauled / beam-reach / running speeds are plausible and
 *                 correctly ordered, with the beam reach fastest
 *   hull speed    13.5 kn is unreachable however hard it blows
 *   no-go zone    she cannot make ground to windward inside ~65 deg, and that
 *                 comes out of aero + leeway rather than a clamp
 *   heel          rises with wind speed, falls when canvas is taken in
 *   roll          free-decay period is 8-14 s
 *   determinism   30 fps and 144 fps produce the same ship
 *   stability     ten simulated minutes in a gale with no NaN
 *   origin        the world is rebased before float32 precision gives out
 */

import { chromium } from 'playwright';
import process from 'node:process';

const QUICK = process.argv.includes('--quick');
const URL = 'http://127.0.0.1:5178/';
/** Seconds of simulated time to reach a steady state on a given heading. */
const SETTLE = QUICK ? 120 : 240;

const failures = [];
const notes = [];

function check(ok, label, detail) {
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`  [${tag}] ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

function note(label, detail) {
  console.log(`         ${label}: ${detail}`);
  notes.push(`${label}: ${detail}`);
}

const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-angle=metal',
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    '--enable-unsafe-swiftshader',
    '--mute-audio',
  ],
});
const page = await browser.newPage({ viewport: { width: 800, height: 500 } });

// Vite's HMR client reloads the page whenever any agent saves a file, which
// destroys the execution context in the middle of a run. Kill the socket before
// the app loads; nothing here needs hot reload.
await page.addInitScript(() => {
  const Real = WebSocket;
  class Dead extends EventTarget {
    constructor() {
      super();
      this.readyState = 3;
    }
    send() {}
    close() {}
  }
  const Patched = function (url, protocols) {
    const vite =
      protocols === 'vite-hmr' || (Array.isArray(protocols) && protocols.includes('vite-hmr'));
    return vite ? new Dead() : new Real(url, protocols);
  };
  Patched.prototype = Real.prototype;
  Object.assign(Patched, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  window.WebSocket = Patched;
});

const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => !!window.__leeward?.world?.ext?.physics, null, { timeout: 180000 });
await page.waitForTimeout(1500);

/**
 * Sail one heading to a steady state on a flat sea and report it. `twa` is the
 * true wind angle wanted, degrees, positive = wind from starboard.
 */
async function steady(twa, windSpeed, seconds, sailLevel = 16, entryKnots = 6) {
  return page.evaluate(
    ({ twa, windSpeed, seconds, sailLevel, entryKnots }) => {
      const w = window.__leeward.world;
      const px = w.ext.physics;
      const RAD = 180 / Math.PI;
      w.env.windSpeed = windSpeed;
      w.env.gust = 1;
      w.input.steer = 0;
      px.flatSea = true;
      const heading = (w.env.windBearing * RAD - twa + 720) % 360;
      // Enter with way on. A polar is what she can HOLD on a heading, not
      // whether she can accelerate onto it from a standstill — no square-rigger
      // gets to close-hauled from rest, you luff up from a reach.
      px.reset(heading, entryKnots);
      px.sailLevel = sailLevel;
      for (const s of w.ship.sails) s.set = 1;
      const trace = px.run(seconds, 1 / 60);
      const last = trace[trace.length - 1];
      return {
        ...last,
        awaDeg: (w.ship.apparentWindAngle * RAD),
        aws: w.ship.apparentWindSpeed,
        pointOfSail: w.ship.pointOfSail,
        inIrons: w.ship.inIrons,
        rigForce: px.rigForce,
        resistance: px.resistance,
        waterSpeed: px.waterSpeed,
        volume: px.volume,
        sailLevel: px.sailLevel,
      };
    },
    { twa, windSpeed, seconds, sailLevel, entryKnots },
  );
}

/* ------------------------------------------------------------------ *
 *  hydrostatics — measured off the panel set, reported not asserted
 * ------------------------------------------------------------------ */

console.log('\nHYDROSTATICS (measured from the panel set at init)');
const hs = await page.evaluate(() => {
  const px = window.__leeward.world.ext.physics;
  const h = px.hydrostatics;
  return {
    panels: px.panels,
    floatY: h.floatY,
    volume: h.volume,
    kb: h.kb,
    bm: h.bm,
    gm: h.gm,
    rollPeriod: h.rollPeriod,
    gz: h.gz,
  };
});
note('panels', hs.panels);
note('float offset', `${hs.floatY.toFixed(3)} m (0 = exactly on her design waterline)`);
note('displacement', `${hs.volume.toFixed(0)} m^3`);
note('KB / BM / GM', `${hs.kb.toFixed(2)} / ${hs.bm.toFixed(2)} / ${hs.gm.toFixed(2)} m`);
note('theoretical roll period', `${hs.rollPeriod.toFixed(1)} s`);
note('GZ 10/20/30/45 deg', hs.gz.map((g) => g.toFixed(2)).join(' / ') + ' m');
check(Math.abs(hs.floatY) < 0.05, 'floats on her design waterline', `${hs.floatY.toFixed(3)} m`);

/* ------------------------------------------------------------------ *
 *  1. speed polar
 * ------------------------------------------------------------------ */

console.log('\nPOLAR — 10 m/s true wind, flat sea, full press of sail');
const ANGLES = [50, 60, 65, 70, 80, 90, 110, 140, 175];
const polar = [];
for (const twa of ANGLES) {
  const r = await steady(twa, 10, SETTLE);
  polar.push({ twa, ...r });
  console.log(
    `  TWA ${String(twa).padStart(3)}  ${r.knots.toFixed(2).padStart(5)} kn   ` +
      `heel ${r.heelDeg.toFixed(1).padStart(5)}   leeway ${r.leewayDeg.toFixed(1).padStart(5)}   ` +
      `VMG ${r.vmgKnots.toFixed(2).padStart(5)}   AWA ${r.awaDeg.toFixed(0).padStart(4)}   ` +
      `held ${r.twaDeg.toFixed(0).padStart(4)}   rudder ${r.rudderDeg.toFixed(1).padStart(5)}   ` +
      // `steady()` has always returned this and the table has never shown it,
      // which is how the published polar in src/physics/index.ts came to claim
      // irons at three angles the harness sails through. Print it.
      `${r.inIrons ? 'IRONS  ' : '       '}${r.pointOfSail}`,
  );
}

const at = (twa) => polar.find((p) => p.twa === twa);
const beam = at(90);
const close = at(70);
const running = at(175);
const fastest = polar.reduce((a, b) => (b.knots > a.knots ? b : a));

check(beam.knots > 6 && beam.knots < 13.5, 'beam reach speed plausible', `${beam.knots.toFixed(2)} kn`);
check(close.knots > 2.5 && close.knots < beam.knots, 'close hauled slower than beam reach',
  `${close.knots.toFixed(2)} vs ${beam.knots.toFixed(2)} kn`);
check(running.knots < beam.knots, 'running slower than beam reach',
  `${running.knots.toFixed(2)} vs ${beam.knots.toFixed(2)} kn`);
check(fastest.twa >= 80 && fastest.twa <= 120, 'fastest point of sail is a reach',
  `TWA ${fastest.twa} at ${fastest.knots.toFixed(2)} kn`);

// The no-go zone must EMERGE: the closest angle at which she still makes ground
// to windward, not a clamp anywhere in the code.
// "Pointing" means the angle of her actual TRACK to the wind — the heading she
// holds through the water plus the leeway she makes over the ground — on a
// heading where she is genuinely sailing and genuinely gaining ground.
const pointing = polar
  .filter((p) => p.vmgKnots > 0.5 && p.knots > 3)
  .map((p) => Math.abs(p.twaDeg) + Math.abs(p.leewayDeg));
const closest = pointing.length ? Math.min(...pointing) : 180;
check(closest >= 65, 'cannot point closer than 65 deg to the true wind',
  `closest track she can make good is ${closest.toFixed(1)} deg off the wind`);
check(closest <= 85, 'can still work to windward at all', `${closest.toFixed(1)} deg`);
note('leeway close hauled', `${close.leewayDeg.toFixed(1)} deg`);

/* ------------------------------------------------------------------ *
 *  2. the hull-speed wall
 * ------------------------------------------------------------------ */

console.log('\nHULL SPEED — she must run into a wall near 13 kn');
const wall = [];
for (const wind of [10, 16, 24, 34]) {
  const r = await steady(110, wind, SETTLE);
  wall.push({ wind, ...r });
  console.log(
    `  wind ${String(wind).padStart(2)} m/s  ${r.knots.toFixed(2).padStart(5)} kn   ` +
      `heel ${r.heelDeg.toFixed(1).padStart(6)}   held ${r.twaDeg.toFixed(0).padStart(4)}   ` +
      `canvas ${r.sailArea.toFixed(0).padStart(4)} m^2   ` +
      `resistance ${(r.resistance / 1000).toFixed(0).padStart(4)} kN   sails set ${r.sailLevel.toFixed(1)}`,
  );
}
const top = Math.max(...wall.map((w) => w.knots), ...polar.map((p) => p.knots));
check(top <= 13.5, 'speed never exceeds 13.5 kn', `top speed seen ${top.toFixed(2)} kn`);
check(top > 10.5, 'she can actually reach her documented speed', `${top.toFixed(2)} kn`);
const gain = wall[3].knots - wall[0].knots;
check(gain > -0.5 && gain < 3.0, 'tripling the wind past 10 m/s buys almost nothing',
  `${gain >= 0 ? '+' : ''}${gain.toFixed(2)} kn from 10 to 34 m/s`);
check(wall[3].sailLevel > 2, 'she keeps steerage canvas set in a storm',
  `${wall[3].sailLevel.toFixed(1)} sails, ${wall[3].sailArea.toFixed(0)} m^2 at 34 m/s`);

/* ------------------------------------------------------------------ *
 *  3. heel
 * ------------------------------------------------------------------ */

console.log('\nHEEL — rises with wind at fixed canvas, falls when canvas comes in');
// Fixed canvas, so this measures the ship rather than the watch's judgement:
// under a full press the crew starts letting fly past 26 deg and heel plateaus,
// which is correct seamanship but hides the underlying curve.
const heels = [];
// Five sails: storm canvas plus a topsail. Little enough that she is never
// over-pressed even at 24 m/s, so the watch never intervenes.
for (const wind of [8, 13, 18, 24]) {
  const r = await steady(90, wind, SETTLE, 5);
  heels.push({ wind, heel: Math.abs(r.heelDeg), knots: r.knots });
  console.log(`  wind ${String(wind).padStart(2)} m/s, 5 sails  heel ${Math.abs(r.heelDeg).toFixed(1).padStart(4)} deg   ${r.knots.toFixed(2)} kn   canvas ${r.sailArea.toFixed(0)} m^2`);
}
const rising = heels.every((h, i) => i === 0 || h.heel > heels[i - 1].heel + 0.4);
check(rising, 'heel rises with wind speed', heels.map((h) => h.heel.toFixed(1)).join(' -> ') + ' deg');
check(heels[3].heel > 4 && heels[3].heel < 34, 'heel in a fresh gale is seamanlike',
  `${heels[3].heel.toFixed(1)} deg at 24 m/s under storm canvas`);

const full = await steady(90, 16, SETTLE, 16);
const reefed = await steady(90, 16, SETTLE, 5);
console.log(`  16 m/s full press: heel ${Math.abs(full.heelDeg).toFixed(1)} deg   ${full.knots.toFixed(2)} kn   canvas ${full.sailArea.toFixed(0)} m^2`);
console.log(`  16 m/s reefed to 5: heel ${Math.abs(reefed.heelDeg).toFixed(1)} deg   ${reefed.knots.toFixed(2)} kn   canvas ${reefed.sailArea.toFixed(0)} m^2`);
check(Math.abs(reefed.heelDeg) < Math.abs(full.heelDeg) - 1, 'heel falls when reefed',
  `${Math.abs(full.heelDeg).toFixed(1)} -> ${Math.abs(reefed.heelDeg).toFixed(1)} deg`);

/* ------------------------------------------------------------------ *
 *  4. free-decay roll period
 * ------------------------------------------------------------------ */

console.log('\nROLL — free decay from 20 deg, bare poles, flat still water');
const roll = await page.evaluate(() => {
  const w = window.__leeward.world;
  const px = w.ext.physics;
  w.env.windSpeed = 0;
  w.env.gust = 1;
  w.input.steer = 0;
  px.flatSea = true;
  px.sailLevel = 0;
  for (const s of w.ship.sails) s.set = 0;
  px.reset(0, 0, 20);
  const trace = px.run(80, 1 / 120, true);
  return trace.map((t) => ({ t: t.t, heel: t.heelDeg }));
});
// Period from successive same-direction zero crossings, linearly interpolated.
const crossings = [];
for (let i = 1; i < roll.length; i++) {
  const a = roll[i - 1].heel;
  const b = roll[i].heel;
  if (a > 0 && b <= 0) {
    const f = a / (a - b);
    crossings.push(roll[i - 1].t + f * (roll[i].t - roll[i - 1].t));
  }
}
const periods = [];
for (let i = 1; i < crossings.length; i++) periods.push(crossings[i] - crossings[i - 1]);
const rollPeriod = periods.length ? periods.reduce((a, b) => a + b, 0) / periods.length : 0;
const peaks = [];
for (let i = 1; i < roll.length - 1; i++) {
  if (roll[i].heel > roll[i - 1].heel && roll[i].heel >= roll[i + 1].heel && roll[i].heel > 0.3) {
    peaks.push(+roll[i].heel.toFixed(2));
  }
}
note('successive periods', periods.map((p) => p.toFixed(2)).join(' / ') + ' s');
note('decay of positive peaks', peaks.slice(0, 6).join(' -> ') + ' deg');
check(rollPeriod >= 8 && rollPeriod <= 14, 'free-decay roll period is 8-14 s',
  `${rollPeriod.toFixed(2)} s over ${periods.length} cycles`);
check(peaks.length >= 3 && peaks[1] < peaks[0] && peaks[1] > peaks[0] * 0.35,
  'roll decays, but she keeps rolling',
  peaks.length >= 2 ? `${peaks[0]} -> ${peaks[1]} deg` : 'too few peaks');

/* ------------------------------------------------------------------ *
 *  5. frame-rate independence
 * ------------------------------------------------------------------ */

console.log('\nDETERMINISM — 30 fps vs 144 fps must produce the same ship');
const fr = await page.evaluate(() => {
  const w = window.__leeward.world;
  const px = w.ext.physics;
  // A settled reach, deliberately: this measures the integrator, and an
  // accumulator leaves the two runs up to one substep apart in simulated time,
  // which any chaotic regime (a broach, in irons) would amplify without telling
  // us anything about frame-rate independence.
  w.env.windSpeed = 9;
  w.env.gust = 1;
  w.input.steer = 0;
  px.flatSea = true;
  const heading = (w.env.windBearing * 180 / Math.PI - 120 + 720) % 360;
  const one = (dt) => {
    px.reset(heading, 0);
    px.sailLevel = 16;
    for (const s of w.ship.sails) s.set = 1;
    const tr = px.run(150, dt);
    return tr[tr.length - 1];
  };
  return { slow: one(1 / 30), fast: one(1 / 144) };
});
const dKnots = Math.abs(fr.slow.knots - fr.fast.knots);
const dHeading = Math.abs(fr.slow.headingDeg - fr.fast.headingDeg);
const dHeel = Math.abs(fr.slow.heelDeg - fr.fast.heelDeg);
console.log(`   30 fps: ${fr.slow.knots.toFixed(3)} kn  heading ${fr.slow.headingDeg.toFixed(2)}  heel ${fr.slow.heelDeg.toFixed(2)}`);
console.log(`  144 fps: ${fr.fast.knots.toFixed(3)} kn  heading ${fr.fast.headingDeg.toFixed(2)}  heel ${fr.fast.heelDeg.toFixed(2)}`);
check(dKnots < 0.05, 'speed identical at 30 and 144 fps', `${dKnots.toFixed(4)} kn apart`);
check(dHeading < 0.5, 'heading identical at 30 and 144 fps', `${dHeading.toFixed(3)} deg apart`);
check(dHeel < 0.5, 'heel identical at 30 and 144 fps', `${dHeel.toFixed(3)} deg apart`);

/* ------------------------------------------------------------------ *
 *  6. ten minutes in a gale, on the real sea
 * ------------------------------------------------------------------ */

console.log('\nSTABILITY — 10 simulated minutes of gale on the real wave field');
/*
 * READ THIS BEFORE YOU "FIX" A FAILURE HERE.
 *
 * `px.run()` steps the solver but never ticks the ocean, so all 36 000 frames of
 * one gale sail through a SINGLE frozen wave snapshot — whichever one happened to
 * be current when `run()` was called. The ocean's phase advances only on real
 * rendered frames, so which snapshot you get is a function of how long every test
 * before this one took, and it is not controllable from here: `Ocean.cpu` is
 * private and neither `IOcean` nor `world.ext.ocean` exposes the sim clock.
 *
 * The consequence is that the peak of a single run is a draw from a distribution,
 * not a property of the ship. Measured, with the ship's state held bit-identical
 * and ONLY the snapshot varying: peak heel spans 30-62 deg and peak speed spans
 * 11.5-16.5 kn. Two back-to-back runs of this very suite gave 62.1 deg (fail) and
 * 31.2 deg (pass) off the same commit.
 *
 * Asserting on one draw made this the only intermittent test in the suite, and it
 * cost a previous session a long hunt for a physics regression that did not exist.
 * So sample several phases and assert on the ship: NaN-freedom is a true invariant
 * and is required of EVERY run, while the heel and speed peaks are asserted on the
 * median with a loose bound on the worst draw — loose enough to survive an unlucky
 * wave, tight enough that a solver which actually capsizes or surfs away still
 * fails. If you tighten these, tighten them against a measured spread, not one run.
 */
const GALE_PHASES = 5;
const galeOnce = () =>
  page.evaluate(() => {
    const w = window.__leeward.world;
    const px = w.ext.physics;
    w.env.windSpeed = 24;
    w.env.gust = 1.25;
    w.env.waveHeight = 7;
    w.env.seaState = 8;
    w.input.steer = 0;
    px.flatSea = false;
    const heading = (w.env.windBearing * 180 / Math.PI - 130 + 720) % 360;
    px.reset(heading, 6);
    px.sailLevel = 16;
    for (const s of w.ship.sails) s.set = 1;
    const tr = px.run(600, 1 / 60, true);
    let bad = 0;
    let maxKn = 0;
    let maxHeel = 0;
    let maxSlam = 0;
    let maxPitch = 0;
    for (const s of tr) {
      for (const k in s) if (!Number.isFinite(s[k])) bad++;
      maxKn = Math.max(maxKn, s.knots);
      maxHeel = Math.max(maxHeel, Math.abs(s.heelDeg));
      maxSlam = Math.max(maxSlam, Math.abs(s.bowSlam));
      maxPitch = Math.max(maxPitch, Math.abs(s.pitchDeg));
    }
    const last = tr[tr.length - 1];
    return {
      bad,
      frames: tr.length,
      maxKn,
      maxHeel,
      maxSlam,
      maxPitch,
      lastKn: last.knots,
      lastHeel: last.heelDeg,
      y: w.ship.position.y,
      volume: px.volume,
      canvas: last.sailArea,
      sailLevel: px.sailLevel,
      oceanTime: w.time.elapsed,
    };
  });

const gales = [];
for (let i = 0; i < GALE_PHASES; i++) {
  // The only way to move the wave field on from here is to let the live loop
  // render: `run()` deliberately does not tick the ocean.
  if (i > 0) await page.waitForTimeout(1700);
  gales.push(await galeOnce());
}
const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
const galeHeels = gales.map((g) => g.maxHeel);
const galeKnots = gales.map((g) => g.maxKn);
const gale = gales[gales.length - 1];
const medHeel = median(galeHeels);
const medKn = median(galeKnots);

note('frames simulated', `${gale.frames} x ${GALE_PHASES} wave phases`);
note('peak heel per phase', galeHeels.map((h) => h.toFixed(1)).join(' / ') + ` deg, median ${medHeel.toFixed(1)}`);
note('peak speed per phase', galeKnots.map((k) => k.toFixed(2)).join(' / ') + ` kn, median ${medKn.toFixed(2)}`);
note('peak pitch / bow acceleration', `${Math.max(...gales.map((g) => g.maxPitch)).toFixed(1)} deg / ${Math.max(...gales.map((g) => g.maxSlam)).toFixed(1)} m/s^2`);
note('canvas she chose to carry', `${gale.canvas.toFixed(0)} m^2, ${gale.sailLevel.toFixed(1)} sails set`);
note('hull origin / displacement at the end', `${gale.y.toFixed(2)} m / ${gale.volume.toFixed(0)} m^3`);
const badTotal = gales.reduce((a, g) => a + g.bad, 0);
check(badTotal === 0, 'no NaN after 10 simulated minutes in a gale, on any wave phase',
  `${badTotal} non-finite values over ${GALE_PHASES} x ${gale.frames} frames`);
check(medKn <= 14.5, 'no wave-riding speed blowout', `median peak ${medKn.toFixed(2)} kn`);
check(Math.max(...galeKnots) <= 18, 'no blowout even on the unluckiest wave',
  `worst peak ${Math.max(...galeKnots).toFixed(2)} kn`);
check(medHeel < 50, 'never knocked flat', `median peak heel ${medHeel.toFixed(1)} deg`);
check(Math.max(...galeHeels) < 75, 'not knocked flat even on the unluckiest wave',
  `worst peak heel ${Math.max(...galeHeels).toFixed(1)} deg`);
// `run()` freezes the wave field in time, so bow accelerations there are only
// what she generates by sailing through it. Measure the real thing live, with
// the ocean advancing, which is the signal VFX and the camera actually consume.
console.log('\nBOW SLAM — live, on the advancing wave field, storm sea');
await page.evaluate(() => {
  const w = window.__leeward.world;
  w.ext.physics.flatSea = false;
  Object.assign(w.env, { windSpeed: 22, waveHeight: 6.5, seaState: 7, choppiness: 0.85 });
  w.bus.emit('capture:scene', {});
});
let slamPeak = 0;
let pitchPeak = 0;
let heavePeak = 0;
for (let i = 0; i < 90; i++) {
  const s = await page.evaluate(() => {
    const sh = window.__leeward.world.ship;
    return { slam: Math.abs(sh.bowSlam), pitch: Math.abs(sh.pitch * 180 / Math.PI), y: Math.abs(sh.position.y) };
  });
  slamPeak = Math.max(slamPeak, s.slam);
  pitchPeak = Math.max(pitchPeak, s.pitch);
  heavePeak = Math.max(heavePeak, s.y);
  await page.waitForTimeout(120);
}
note('peak |bowSlam| live', `${slamPeak.toFixed(1)} m/s^2 (${(slamPeak / 9.81).toFixed(2)} g)`);
note('peak pitch / heave live', `${pitchPeak.toFixed(1)} deg / ${heavePeak.toFixed(2)} m`);
check(slamPeak > 3 && slamPeak < 60, 'bowSlam is scaled for spray and shake',
  `peak ${slamPeak.toFixed(1)} m/s^2, VFX triggers at 5.4 and the camera saturates at 45`);
check(pitchPeak > 1.5, 'she pitches in a storm sea', `peak ${pitchPeak.toFixed(1)} deg`);

/* ------------------------------------------------------------------ *
 *  7. floating origin
 * ------------------------------------------------------------------ */

console.log('\nFLOATING ORIGIN — she must be rebased before float32 gives out');
// PIN the wind, do not assign it. This case is the one place in the suite where
// the ABSOLUTE wind bearing matters: the rebase test is on the L-infinity norm,
// so where she ends up inside the 4000 m box depends on which way the box she is
// sailing. An unpinned bearing is whatever the weather sim happened to drift to,
// which is a different answer every run. Pinned and settled below; released after.
await page.evaluate(() => {
  const e = window.__leeward.world.ext.env;
  e.pin('windSpeed', 12);
  e.pin('gust', 1);
  e.pin('windBearing', Math.PI / 4);
});
await page.waitForTimeout(1200);
const originPin = await page.evaluate(() => {
  const w = window.__leeward.world;
  return { ws: w.env.windSpeed, gust: w.env.gust, wb: w.env.windBearing };
});
check(Math.abs(originPin.ws - 12) < 1e-6 && Math.abs(originPin.gust - 1) < 1e-6
  && Math.abs(originPin.wb - Math.PI / 4) < 1e-6,
  'the pinned wind actually held before measuring',
  `${originPin.ws.toFixed(2)} m/s, gust ${originPin.gust.toFixed(2)}, bearing ${(originPin.wb * 180 / Math.PI).toFixed(1)} deg`);
const origin = await page.evaluate(() => {
  const w = window.__leeward.world;
  const px = w.ext.physics;
  w.input.steer = 0;
  px.flatSea = true;
  let events = 0;
  let lastDelta = null;
  const off = w.bus.on('origin:shift', (d) => {
    events++;
    lastDelta = { x: d.x, y: d.y, z: d.z };
  });
  const o0 = w.origin.clone();
  px.reset((w.env.windBearing * 180 / Math.PI - 110 + 720) % 360, 8);
  px.sailLevel = 16;
  for (const s of w.ship.sails) s.set = 1;
  px.run(1400, 1 / 60);
  off();
  const p = w.ship.position;
  return {
    events,
    lastDelta,
    sailed: Math.hypot(w.origin.x - o0.x, w.origin.z - o0.z),
    dist: Math.hypot(p.x, p.z),
    linf: Math.max(Math.abs(p.x), Math.abs(p.z)),
    y: p.y,
  };
});
// Releasing the last pin also clears `frozen` (Weather.unpin: `if (pinMask === 0)
// this.frozen = false`), and BOW SLAM above had set it via `capture:scene`. Without
// this re-emit the cost case below would run on an evolving weather state where it
// used to run on a frozen one -- a quiet change of conditions rather than the
// no-op it should be.
await page.evaluate(() => {
  const w = window.__leeward.world;
  w.ext.env.unpin('all');
  w.bus.emit('capture:scene', {});
});
note('rebases in 1400 s', origin.events);
note('voyage distance banked in world.origin', `${(origin.sailed / 1852).toFixed(2)} NM`);
note('render-space distance from origin after', `${origin.dist.toFixed(0)} m (L2), ` +
  `${origin.linf.toFixed(0)} m (max component)`);
check(origin.events >= 1, 'the world gets rebased', `${origin.events} origin:shift event(s)`);
// L-INFINITY, not L2. `shiftOrigin` rebases when EITHER component reaches
// ORIGIN_SHIFT_RADIUS (4000 m), so the bound the code actually guarantees is on
// the larger component. The Euclidean radius at a rebase can legitimately reach
// R*sqrt2 = 5657 m, and this used to assert `hypot(x, z) < 4100`, which is not a
// property the solver has ever had. Measured over eight pinned wind bearings,
// everything else identical:
//
//   bearing      0    45    90   135   180   225   270   315 deg
//   L2        4161  3903  4161  3903  4162  3903  4162  3903 m   -> 4/8 under 4100
//   max|comp| 3950  3487  3950  3487  3950  3487  3950  3487 m   -> 8/8 under 4000
//
// The 90 deg periodicity is the whole story: a wind on an axis puts her track on
// a diagonal of the rebase box and a diagonal wind puts it on an axis. Distance
// sailed was 2.28-2.42 NM in all eight, so nothing about the ship changed. The
// old assertion was passing or failing on which way the world happened to face.
// Strictly under the radius, with no tolerance, because none is owed: `tick()`
// calls `shiftOrigin` AFTER the substep loop on every frame, and `run()` is a
// loop over `tick`, so when the run returns the last rebase has already happened.
// The invariant is exactly `max(|x|, |z|) < ORIGIN_SHIFT_RADIUS`. Measured max
// across the eight bearings above: 3950 m.
check(origin.linf < 4000, 'she never wanders far from the render origin',
  `largest component ${origin.linf.toFixed(0)} m against the 4000 m rebase radius ` +
  `(L2 ${origin.dist.toFixed(0)} m)`);
check(origin.sailed > 3000, 'world.origin accumulates the distance actually sailed',
  `${(origin.sailed / 1852).toFixed(2)} NM`);
check(!!origin.lastDelta && Number.isFinite(origin.lastDelta.x),
  'the shift payload is the delta added to render space',
  origin.lastDelta ? `(${origin.lastDelta.x.toFixed(0)}, ${origin.lastDelta.y.toFixed(0)}, ${origin.lastDelta.z.toFixed(0)})` : 'missing');

/* ------------------------------------------------------------------ *
 *  8. cost
 * ------------------------------------------------------------------ */

console.log('\nCOST');
await page.evaluate(() => {
  const w = window.__leeward.world;
  w.ext.physics.flatSea = false;
  w.env.windSpeed = 10;
  w.env.waveHeight = 2;
});
await page.waitForTimeout(3000);
const cost = await page.evaluate(() => {
  const w = window.__leeward.world;
  const px = w.ext.physics;
  // Time the solver directly: 600 frames of 1/60 s, i.e. 1200 substeps.
  const t0 = performance.now();
  px.run(10, 1 / 60);
  const ms = performance.now() - t0;
  return { perFrame: ms / 600, live: w.stats['physics:ms'], substeps: w.stats['physics:substeps'] };
});
note('solver cost', `${cost.perFrame.toFixed(3)} ms per 60 fps frame (2 substeps)`);
note('live physics:ms', `${(cost.live ?? 0).toFixed(3)} ms at ${cost.substeps} substeps`);
check(cost.perFrame < 2.5, 'inside the 2.5 ms/frame budget', `${cost.perFrame.toFixed(3)} ms`);

/* ------------------------------------------------------------------ *
 *  done
 * ------------------------------------------------------------------ */

if (pageErrors.length) {
  console.log(`\n${pageErrors.length} page error(s) (may belong to another subsystem):`);
  for (const e of [...new Set(pageErrors)].slice(0, 6)) console.log('  ' + e.slice(0, 160));
}

await browser.close();

console.log('');
if (failures.length) {
  console.error(`${failures.length} FAILED:`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('ALL PHYSICS TESTS PASSED');
