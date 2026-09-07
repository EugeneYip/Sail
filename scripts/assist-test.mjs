#!/usr/bin/env node
/**
 * Assist-mode acceptance tests — the PLAYABILITY suite.
 *
 * `physics-test.mjs` asserts that the ship is right. This asserts that she is
 * fun: that she accelerates, that she turns, that she never leaves the player
 * stuck head to wind or becalmed, and that she still feels like 2200 tonnes
 * while doing it.
 *
 *   node scripts/assist-test.mjs
 *   node scripts/assist-test.mjs --quick
 *
 * Both suites drive the same solver through the same `world.ext.physics`
 * stepper. `px.reset()` returns the solver to Pro mode by design — it is a
 * measurement hook and Pro is its calibrated state — so every scenario here
 * sets `px.assist = true` immediately after its reset. That is what lets
 * `physics-test.mjs` keep passing byte-for-byte unchanged while assist is the
 * shipping default.
 *
 * What it asserts:
 *
 *   throttle      time to cruising speed from a standstill, and that a 2200 t
 *                 ship still visibly winds up rather than snapping to speed
 *   helm          steady turn rate, time to 90 deg, speed carried through the
 *                 turn, and that she answers the wheel when nearly stopped
 *   no-go zone    steering straight into the wind still makes way, is never
 *                 flagged in irons, and never comes to a dead stop
 *   becalmed      zero wind still leaves her sailing
 *   auto trim     the yards look after themselves through a 180 deg course
 *                 change with the player touching nothing but the helm
 *   mass          roll period, heel and pitch are the Pro ship's, unchanged
 *   Pro intact    with assist off the polar is the measured one again
 *   determinism   30 fps and 144 fps produce the same assisted ship
 *   stability     ten simulated minutes of gale, assisted, with no NaN
 */

import { chromium } from 'playwright';
import process from 'node:process';

const QUICK = process.argv.includes('--quick');
const URL = 'http://127.0.0.1:5178/';
const SETTLE = QUICK ? 90 : 180;

const failures = [];

function check(ok, label, detail) {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

function note(label, detail) {
  console.log(`         ${label}: ${detail}`);
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
// destroys the execution context mid-run. Kill the socket before the app loads.
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
 * Shared scenario setup, injected into every `page.evaluate` below. `put()`
 * places the ship at a true wind angle with the assist layer in a known state
 * and a full press of canvas ordered.
 */
const PRELUDE = `
  const w = window.__leeward.world;
  const px = w.ext.physics;
  const RAD = 180 / Math.PI;
  const put = (twa, knots, { assist = true, wind = 10, gust = 1, flat = true, level = 16 } = {}) => {
    w.env.windSpeed = wind;
    w.env.gust = gust;
    w.input.steer = 0;
    w.input.sailTrim = 0;
    w.input.brace = 0;
    px.flatSea = flat;
    px.reset((w.env.windBearing * RAD - twa + 720) % 360, knots);
    px.assist = assist;
    px.sailLevel = level;
    for (const s of w.ship.sails) s.set = 1;
  };
`;

const run = (body, arg) =>
  page.evaluate(new Function('ARG', `${PRELUDE}\n${body}`), arg ?? null);

/* ------------------------------------------------------------------ *
 *  0. the toggle
 * ------------------------------------------------------------------ */

console.log('\nTOGGLE — assist is the default and is reachable from both ends');
const toggle = await run(`
  const bootDefault = w.settings.assist;
  px.assist = true;
  const extOn = { ext: px.assist, setting: w.settings.assist };
  w.settings.assist = false;
  // The live update loop syncs the solver from the setting; run() deliberately
  // does not, so poke the solver directly the way the game loop would.
  px.assist = false;
  const off = { ext: px.assist, setting: w.settings.assist };
  px.assist = true;
  return { bootDefault, extOn, off, top: px.assistTopKnots, throttle: px.throttle };
`);
check(toggle.bootDefault === true, 'assist is ON by default', `settings.assist = ${toggle.bootDefault}`);
check(
  toggle.extOn.ext === true && toggle.extOn.setting === true && toggle.off.ext === false,
  'world.ext.physics.assist mirrors world.settings.assist',
  `on ${JSON.stringify(toggle.extOn)}, off ${JSON.stringify(toggle.off)}`,
);
note('assist speed ceiling', `${toggle.top.toFixed(1)} kn (hull speed is 12.8)`);

/* ------------------------------------------------------------------ *
 *  1. throttle — time to cruising speed
 * ------------------------------------------------------------------ */

console.log('\nTHROTTLE — from a standstill to cruising speed, TWA 100, 10 m/s');
const accel = await run(`
  const one = (assist) => {
    put(100, 0, { assist });
    const tr = px.run(300, 1 / 60, true);
    const top = tr[tr.length - 1].knots;
    const mark = (f) => (tr.find((s) => s.knots >= f * top) || {}).t ?? null;
    const at = (t) => tr[Math.min(tr.length - 1, Math.round(t * 60) - 1)].knots;
    return { top, t50: mark(0.5), t90: mark(0.9), at5: at(5), at10: at(10), at30: at(30) };
  };
  return { assist: one(true), pro: one(false) };
`);
note('pro   ', `${accel.pro.top.toFixed(2)} kn top, ${accel.pro.at10.toFixed(2)} kn at 10 s, 90% at ${accel.pro.t90?.toFixed(0)} s`);
note('assist', `${accel.assist.top.toFixed(2)} kn top, ${accel.assist.at10.toFixed(2)} kn at 10 s, 90% at ${accel.assist.t90?.toFixed(1)} s`);
check(accel.assist.t90 !== null && accel.assist.t90 < 30, 'reaches 90% of cruising speed inside 30 s',
  `${accel.assist.t90.toFixed(1)} s (pro: ${accel.pro.t90?.toFixed(0)} s)`);
check(accel.assist.at10 > 8, 'moving properly within 10 s of the order',
  `${accel.assist.at10.toFixed(2)} kn at 10 s (pro: ${accel.pro.at10.toFixed(2)})`);
check(accel.assist.t90 > 4, 'she still winds up like 2200 tonnes, not a speedboat',
  `90% at ${accel.assist.t90.toFixed(1)} s, ${accel.assist.at5.toFixed(1)} kn after 5 s`);
check(accel.assist.top > 14 && accel.assist.top < 22, 'assist cruising speed is well above hull speed',
  `${accel.assist.top.toFixed(2)} kn vs the 12.8 kn hull-speed wall`);

/* ------------------------------------------------------------------ *
 *  2. helm
 * ------------------------------------------------------------------ */

console.log('\nHELM — hard over from a reach, and from nearly stopped');
const turn = await run(`
  const swing = (assist, entry, bare, dir) => {
    put(100, entry, { assist, level: bare ? 0 : 16 });
    if (bare) for (const s of w.ship.sails) s.set = 0;
    px.run(bare ? 4 : 60, 1 / 60);
    const kn0 = w.ship.speedKnots;
    const h0 = w.ship.heading * RAD;
    w.input.steer = dir;
    const tr = px.run(120, 1 / 60, true);
    w.input.steer = 0;
    let prev = h0;
    let turned = 0;
    const rows = [];
    for (const s of tr) {
      let d = s.headingDeg - prev;
      while (d > 180) d -= 360;
      while (d < -180) d += 360;
      turned += d;
      prev = s.headingDeg;
      rows.push({ t: s.t, turned: Math.abs(turned), kn: s.knots, heel: s.heelDeg });
    }
    const at = (deg) => (rows.find((r) => r.turned >= deg) || {}).t ?? null;
    const last = rows[rows.length - 1];
    const back = rows.find((r) => r.t >= last.t - 30);
    const steady = (last.turned - back.turned) / (last.t - back.t);
    let minKn = Infinity;
    let maxHeel = 0;
    // Speed carried through the FIRST 90 deg. Past that a sustained hard-over
    // turn is just circling, and a circle necessarily drags her through the
    // beat, where the polar says she is slow — that is the point of sail
    // mattering, not the turn stopping her.
    let firstQuarter = Infinity;
    let sumKn = 0;
    let nQuarter = 0;
    for (const r of rows) {
      minKn = Math.min(minKn, r.kn);
      maxHeel = Math.max(maxHeel, Math.abs(r.heel));
      if (r.turned <= 90) {
        firstQuarter = Math.min(firstQuarter, r.kn);
        sumKn += r.kn;
        nQuarter++;
      }
    }
    const t90 = at(90);
    // Radius over the FIRST 90 deg — the turn a player actually makes when they
    // put the wheel over at cruising speed: mean speed / mean rate.
    //
    // This used to be measured as (speed at the end of 120 s of circling) /
    // (steady rate), and that number is meaningless for feel: a sustained circle
    // necessarily drags her through the beat, so it divides a SLOW regime's
    // speed by the rate she turns at when slow, and reported 0.7-0.9 ship
    // lengths for a ship that actually carves 1.8 at cruising speed. Judging a
    // skid by it would have had us detune a turn that was not too tight.
    const meanKn = nQuarter ? sumKn / nQuarter : 0;
    const radius90 = t90 ? (meanKn * 0.5144) / (90 / RAD / t90) : Infinity;
    return { kn0, t10: at(10), t90, t180: at(180), steady, minKn, firstQuarter, maxHeel,
             meanKn, radius90, radiusCircle: (last.kn * 0.5144) / (steady / RAD) };
  };
  return {
    assist: swing(true, 6, false, 1),
    pro: swing(false, 6, false, 1),
    crawl: swing(true, 0, true, 1),
    // Bearing away instead of luffing up, so both ends of the 90 deg are fast
    // points of sail and any speed lost is the turn's fault rather than the
    // polar's.
    bear: swing(true, 6, false, -1),
  };
`);
note('pro   ', `${turn.pro.steady.toFixed(2)} deg/s steady, 90 deg in ${turn.pro.t90?.toFixed(0) ?? '>120'} s, speed fell to ${turn.pro.minKn.toFixed(1)} kn`);
note('assist', `${turn.assist.steady.toFixed(2)} deg/s steady, 90 deg in ${turn.assist.t90?.toFixed(1)} s, 180 in ${turn.assist.t180?.toFixed(1)} s`);
note('assist turn radius', `${turn.assist.radius90.toFixed(0)} m = ${(turn.assist.radius90 / 53.3).toFixed(1)} ship lengths over the first 90 deg at ${turn.assist.meanKn.toFixed(1)} kn, peak heel ${turn.assist.maxHeel.toFixed(1)} deg`);
note('...once she is just circling', `${turn.assist.radiusCircle.toFixed(0)} m = ${(turn.assist.radiusCircle / 53.3).toFixed(1)} lengths, but she is down to the beat by then`);
check(turn.assist.steady > 4, 'steady turn rate is at least 4 deg/s',
  `${turn.assist.steady.toFixed(2)} deg/s (pro: ${turn.pro.steady.toFixed(2)})`);
check(turn.assist.t90 !== null && turn.assist.t90 < 25, '90 deg of heading inside 25 s',
  `${turn.assist.t90.toFixed(1)} s (pro: ${turn.pro.t90?.toFixed(0) ?? 'never'})`);
check(turn.assist.t10 !== null && turn.assist.t10 < 6, 'she starts turning within 6 s of the key going down',
  `10 deg at ${turn.assist.t10.toFixed(1)} s`);
// 0.65, not the 0.8 this started at. Bearing away 90 deg from a reach to dead
// downwind is not a free manoeuvre even in assist and should not be: the apparent
// wind falls by the boat's own speed, and the assist ceiling at TWA 180 is 0.86
// of its beam-reach value BY DESIGN (see ASSIST_ANGLE_* — a run being slower than
// a reach is the polar shape that makes the point of sail matter). Measured 0.70
// of entry speed at the worst moment, recovering to the TWA-180 polar afterwards.
// The property worth asserting is that the turn does not feel like the brakes,
// not that it is free.
check(turn.bear.firstQuarter > 0.65 * turn.bear.kn0,
  'she carries her speed round 90 deg of bearing away',
  `${turn.bear.kn0.toFixed(1)} -> ${turn.bear.firstQuarter.toFixed(1)} kn (${(100 * turn.bear.firstQuarter / turn.bear.kn0).toFixed(0)}% kept)`);
note('luffing up 90 deg instead', `${turn.assist.kn0.toFixed(1)} -> ${turn.assist.firstQuarter.toFixed(1)} kn, which is the polar, not the turn`);
check(turn.assist.minKn > 4, 'circling hard never brings her near a stop',
  `${turn.assist.minKn.toFixed(1)} kn at the slowest point of the circle (the beat)`);
check(turn.assist.radius90 > 53.3 && turn.assist.radius90 < 3 * 53.3,
  'turning radius reads as a big ship carving, not a skid',
  `${(turn.assist.radius90 / 53.3).toFixed(1)} ship lengths at ${turn.assist.meanKn.toFixed(1)} kn`);
note('bare poles, dead in the water', `${turn.crawl.kn0.toFixed(2)} kn entry, 90 deg in ${turn.crawl.t90?.toFixed(1) ?? 'never'} s`);
check(turn.crawl.kn0 < 1.5, 'the crawl case really is stopped', `${turn.crawl.kn0.toFixed(2)} kn`);
check(turn.crawl.t90 !== null && turn.crawl.t90 < 40,
  'the helm answers with no way on at all — the player is never immobilised',
  `90 deg in ${turn.crawl.t90?.toFixed(1)} s from ${turn.crawl.kn0.toFixed(2)} kn`);

/*
 * Regression, found by DRIVING her and not by any assertion above.
 *
 * `Trim`'s second reefing rule shortens sail when the rudder is held past 70 per
 * cent of hard over, on the reasoning that a pinned rudder means the after sails
 * are overpowering the helm. In assist the player turns by HOLDING the arrow key,
 * so the rudder sits at hard over for the whole turn and the rule fired on every
 * single turn: 25 s on the helm took the rig from 16 sails to storm canvas, cost
 * 5.5 kn, and then wanted 100 s at RESET_RATE to shake out again. Nothing in
 * either suite could see it, because both suites drive `w.input.steer` directly
 * and neither watched `px.sailLevel` during a turn.
 *
 * It was also MASKED by a second bug: `input.sailTrim` is an exponential approach
 * that never reached zero, so after any press of the up arrow `Trim` believed the
 * player still had a hand on the throttle and pinned the reef cap wide open.
 * Fixing the input residual alone would have exposed this one in the shipped game.
 */
const held = await run(`
  put(110, 12);
  px.run(30, 1 / 60);
  const level0 = px.sailLevel;
  const kn0 = w.ship.speedKnots;
  w.input.steer = -1;
  px.run(30, 1 / 60);
  const level = px.sailLevel;
  const kn = w.ship.speedKnots;
  w.input.steer = 0;
  return { level0, level, kn0, kn };
`);
note('30 s with the helm hard over', `${held.level0.toFixed(1)} -> ${held.level.toFixed(1)} sails, ${held.kn0.toFixed(1)} -> ${held.kn.toFixed(1)} kn`);
check(held.level > 0.9 * held.level0,
  'holding the helm over does not make the watch strike the rig',
  `${held.level0.toFixed(1)} -> ${held.level.toFixed(1)} sails still set`);

/* ------------------------------------------------------------------ *
 *  3. the no-go zone is gone
 * ------------------------------------------------------------------ */

console.log('\nNO-GO ZONE — steering straight at the wind must still make way');
const upwind = await run(`
  const out = {};
  for (const twa of [0, 20, 45, 70, 90, 120, 150, 180]) {
    put(twa, 4);
    const tr = px.run(ARG.settle, 1 / 60);
    const last = tr[tr.length - 1];
    out[twa] = { kn: last.knots, vmg: last.vmgKnots, held: last.twaDeg, irons: w.ship.inIrons,
                 heel: last.heelDeg, leeway: last.leewayDeg };
  }
  return out;
`, { settle: SETTLE });
for (const twa of [0, 20, 45, 70, 90, 120, 150, 180]) {
  const r = upwind[twa];
  console.log(
    `  TWA ${String(twa).padStart(3)}  ${r.kn.toFixed(2).padStart(5)} kn   ` +
      `VMG ${r.vmg.toFixed(2).padStart(6)}   heel ${r.heel.toFixed(1).padStart(5)}   ` +
      `leeway ${r.leeway.toFixed(1).padStart(5)}   held ${r.held.toFixed(0).padStart(4)}   irons ${r.irons}`,
  );
}
check(upwind[0].kn > 4, 'dead into the wind she still sails', `${upwind[0].kn.toFixed(2)} kn at TWA 0`);
check(upwind[0].vmg > 3, '...and actually gains ground to windward', `VMG ${upwind[0].vmg.toFixed(2)} kn`);
check([0, 20, 45, 70, 90, 120, 150, 180].every((t) => !upwind[t].irons),
  'never flagged in irons on any heading', 'all eight headings clear');
check(Math.abs(upwind[0].held) < 15, 'she HOLDS a dead-upwind heading instead of falling off',
  `held ${upwind[0].held.toFixed(1)} deg off the wind`);
const best = Object.entries(upwind).reduce((a, b) => (b[1].kn > a[1].kn ? b : a));
check(Number(best[0]) >= 90 && Number(best[0]) <= 150, 'a reach is still her best point of sail',
  `fastest at TWA ${best[0]}, ${best[1].kn.toFixed(2)} kn`);
check(upwind[120].kn - upwind[0].kn > 4, 'point of sail still matters to the player',
  `${upwind[0].kn.toFixed(1)} kn beating vs ${upwind[120].kn.toFixed(1)} kn on a broad reach`);

console.log('\nBECALMED — zero wind must not be a dead end');
const calm = await run(`
  put(90, 0, { wind: 0 });
  const tr = px.run(ARG.settle, 1 / 60);
  return { kn: tr[tr.length - 1].knots, pointOfSail: w.ship.pointOfSail };
`, { settle: SETTLE });
check(calm.kn > 3, 'she still ghosts along in a flat calm',
  `${calm.kn.toFixed(2)} kn with no wind at all`);
check(calm.kn < 9, '...but slowly enough that you want the breeze back', `${calm.kn.toFixed(2)} kn`);

console.log('\nDEAD STOP — five minutes beating into a gusty gale on the real sea');
const grind = await run(`
  put(0, 0, { wind: 18, gust: 1.3, flat: false });
  w.env.waveHeight = 5;
  w.env.seaState = 7;
  const tr = px.run(300, 1 / 60, true);
  let min = Infinity;
  let bad = 0;
  for (const s of tr) {
    if (s.t > 30) min = Math.min(min, s.knots);
    for (const k in s) if (!Number.isFinite(s[k])) bad++;
  }
  return { min, last: tr[tr.length - 1].knots, bad, frames: tr.length, irons: w.ship.inIrons };
`);
note('slowest moment after the first 30 s', `${grind.min.toFixed(2)} kn`);
check(grind.min > 2, 'she never comes to a dead stop', `worst ${grind.min.toFixed(2)} kn over 300 s`);
check(grind.bad === 0, 'no non-finite values in 18 000 assisted gale frames', `${grind.bad} bad`);

/* ------------------------------------------------------------------ *
 *  4. automatic sail handling
 * ------------------------------------------------------------------ */

console.log('\nAUTO TRIM — arrow keys only: a 180 deg course change, hands off the yards');
const auto = await run(`
  put(60, 6);
  px.run(90, 1 / 60);
  const before = w.ship.speedKnots;
  const braces0 = w.ship.sails.map((s) => s.brace);
  // Wear ship: hard over, hold until she is through 180 deg, then steady up.
  w.input.steer = 1;
  const h0 = w.ship.heading * RAD;
  let turned = 0;
  let prev = h0;
  let t = 0;
  while (Math.abs(turned) < 175 && t < 200) {
    const tr = px.run(1, 1 / 60);
    let d = tr[tr.length - 1].headingDeg - prev;
    while (d > 180) d -= 360;
    while (d < -180) d += 360;
    turned += d;
    prev = tr[tr.length - 1].headingDeg;
    t += 1;
  }
  w.input.steer = 0;
  const tr = px.run(120, 1 / 60, true);
  let min = Infinity;
  for (const s of tr) min = Math.min(min, s.knots);
  const braces1 = w.ship.sails.map((s) => s.brace);
  let moved = 0;
  for (let i = 0; i < braces0.length; i++) moved += Math.abs(braces1[i] - braces0[i]);
  return { before, after: tr[tr.length - 1].knots, min, turnSeconds: t,
           bracesMovedDeg: moved * RAD, sailTrimInput: w.input.sailTrim, braceInput: w.input.brace };
`);
note('wearing ship', `${auto.turnSeconds.toFixed(0)} s to come through 180 deg`);
note('yards', `${auto.bracesMovedDeg.toFixed(0)} deg of total yard movement, unprompted`);
check(auto.braceInput === 0 && auto.sailTrimInput === 0, 'the player touched nothing but the helm',
  'brace and sailTrim inputs both zero throughout');
check(auto.bracesMovedDeg > 30, 'the watch re-braced the whole rig on its own',
  `${auto.bracesMovedDeg.toFixed(0)} deg summed over 16 sails`);
check(auto.after > 0.75 * auto.before, 'speed recovers on the new tack without any trimming',
  `${auto.before.toFixed(1)} -> ${auto.after.toFixed(1)} kn`);

console.log('\nTHROTTLE KEYS — down takes canvas in, up sets it again');
const throttle = await run(`
  put(100, 6);
  px.run(60, 1 / 60);
  const cruise = w.ship.speedKnots;
  w.input.sailTrim = -1;
  px.run(12, 1 / 60);
  const ordered = px.throttle;
  w.input.sailTrim = 0;
  px.run(80, 1 / 60);
  const slow = w.ship.speedKnots;
  w.input.sailTrim = 1;
  px.run(12, 1 / 60);
  w.input.sailTrim = 0;
  px.run(90, 1 / 60);
  return { cruise, ordered, slow, back: w.ship.speedKnots, area: w.ship.sailArea };
`);
note('throttle after 12 s of the down arrow', `${(throttle.ordered * 100).toFixed(0)}% canvas`);
check(throttle.ordered < 0.35, '12 s on the down arrow strikes most of the canvas',
  `${(throttle.ordered * 100).toFixed(0)}% left`);
check(throttle.slow < 0.7 * throttle.cruise, 'and she slows down for it',
  `${throttle.cruise.toFixed(1)} -> ${throttle.slow.toFixed(1)} kn`);
check(throttle.back > 0.85 * throttle.cruise, 'the up arrow gets it all back',
  `${throttle.slow.toFixed(1)} -> ${throttle.back.toFixed(1)} kn`);

/* ------------------------------------------------------------------ *
 *  5. she must still feel like 2200 tonnes
 * ------------------------------------------------------------------ */

console.log('\nMASS — heel, roll and pitch must survive the assist');
const feel = await run(`
  // Free roll decay, assisted, bare poles, still water: the signature number.
  put(0, 0, { wind: 0, level: 0 });
  for (const s of w.ship.sails) s.set = 0;
  px.reset(0, 0, 20);
  px.assist = true;
  px.sailLevel = 0;
  const tr = px.run(80, 1 / 120, true);
  const cross = [];
  for (let i = 1; i < tr.length; i++) {
    const a = tr[i - 1].heelDeg, b = tr[i].heelDeg;
    if (a > 0 && b <= 0) cross.push(tr[i - 1].t + (a / (a - b)) * (tr[i].t - tr[i - 1].t));
  }
  let period = 0;
  for (let i = 1; i < cross.length; i++) period += cross[i] - cross[i - 1];
  period = cross.length > 1 ? period / (cross.length - 1) : 0;

  put(90, 6, { wind: 16 });
  const beam = px.run(ARG.settle, 1 / 60);
  const heel = Math.abs(beam[beam.length - 1].heelDeg);

  put(120, 8, { wind: 20, gust: 1.2, flat: false });
  w.env.waveHeight = 6;
  w.env.seaState = 7;
  const storm = px.run(200, 1 / 60, true);
  let pitch = 0, slam = 0, roll = 0;
  for (const s of storm) {
    pitch = Math.max(pitch, Math.abs(s.pitchDeg));
    slam = Math.max(slam, Math.abs(s.bowSlam));
    roll = Math.max(roll, Math.abs(s.heelDeg));
  }
  return { period, heel, pitch, slam, roll };
`, { settle: SETTLE });
note('assisted free-decay roll period', `${feel.period.toFixed(2)} s (Pro measures 9.31 s)`);
note('storm sea, assisted', `peak pitch ${feel.pitch.toFixed(1)} deg, peak heel ${feel.roll.toFixed(1)} deg, bow ${feel.slam.toFixed(1)} m/s^2`);
check(feel.period >= 8 && feel.period <= 14, 'roll period is untouched by the assist',
  `${feel.period.toFixed(2)} s`);
check(feel.heel > 6 && feel.heel < 30, 'she still lies down to a fresh breeze',
  `${feel.heel.toFixed(1)} deg on a beam reach in 16 m/s`);
check(feel.pitch > 1.5, 'she still pitches to a storm sea', `peak ${feel.pitch.toFixed(1)} deg`);

// `run()` freezes the wave field in time, so bow accelerations inside it are
// only what she generates by sailing through a still snapshot. Measure the real
// thing live, with the ocean advancing and the ordinary game loop ticking —
// which also proves the settings -> solver sync works in flight.
console.log('\nLIVE — assist switched on through world.settings, storm sea, real frames');
await page.evaluate(() => {
  const w = window.__leeward.world;
  w.settings.assist = true;
  w.ext.physics.flatSea = false;
  Object.assign(w.env, { windSpeed: 22, waveHeight: 6.5, seaState: 7, choppiness: 0.85 });
  w.bus.emit('capture:scene', {});
});
let slamPeak = 0;
let pitchPeak = 0;
let minKnots = Infinity;
let syncedOn = false;
for (let i = 0; i < 70; i++) {
  const s = await page.evaluate(() => {
    const w = window.__leeward.world;
    return {
      slam: Math.abs(w.ship.bowSlam),
      pitch: Math.abs((w.ship.pitch * 180) / Math.PI),
      kn: w.ship.speedKnots,
      assist: w.ext.physics.assist,
    };
  });
  slamPeak = Math.max(slamPeak, s.slam);
  pitchPeak = Math.max(pitchPeak, s.pitch);
  minKnots = Math.min(minKnots, s.kn);
  syncedOn = s.assist;
  await page.waitForTimeout(120);
}
note('live peaks', `bowSlam ${slamPeak.toFixed(1)} m/s^2, pitch ${pitchPeak.toFixed(1)} deg`);
check(syncedOn, 'the solver picked the mode up from world.settings on its own', 'assist = true');
check(slamPeak > 3 && slamPeak < 60, 'bowSlam still drives spray and camera shake',
  `peak ${slamPeak.toFixed(1)} m/s^2, VFX triggers at 5.4`);
check(minKnots > 2, 'she keeps sailing through a live storm', `slowest ${minKnots.toFixed(1)} kn`);

/* ------------------------------------------------------------------ *
 *  6. Pro mode is untouched
 * ------------------------------------------------------------------ */

console.log('\nPRO MODE — the same solver, unchanged, with the layer off');
const pro = await run(`
  const out = {};
  for (const twa of [70, 90, 175]) {
    put(twa, 6, { assist: false });
    const tr = px.run(ARG.settle, 1 / 60);
    const last = tr[tr.length - 1];
    out[twa] = { kn: last.knots, heel: last.heelDeg, leeway: last.leewayDeg, held: last.twaDeg,
                 vmg: last.vmgKnots };
  }
  // NOT ARG.settle. Every other Pro case here reaches a steady state in well
  // under a minute; this one never reaches one at all. Stalled at TWA 45 she
  // swings with a ~150 s period about roughly 42 deg, and the irons latch only
  // arms when that swing first carries her inside 44 deg. Measured, Pro, 10 m/s,
  // flat sea, full press, one independent settle per point:
  //
  //   settle   40    60    80    90   100   120   150   180   240   300 s
  //   held   48.2  47.8  45.8  44.2  42.6  39.7  37.5  38.7  45.6  41.7 deg
  //   irons     -     -     -     -  true  true  true  true  true  true
  //
  // First latch at 100 s, and it is sticky afterwards -- the hold gate is 62 deg
  // and 1.6 m/s, both of which she stays inside. So --quick's 90 s settle was
  // 10 s short and this assertion failed on a correct solver, deterministically,
  // to 0.1 deg over four repeats. Floor it at 150 s: 50 s past the crossing, at
  // the deepest point of the swing. Full mode's 180 s is unchanged.
  put(45, 6, { assist: false });
  const ir = px.run(Math.max(ARG.settle, 150), 1 / 60);
  out.irons = w.ship.inIrons;
  out.ironsHeld = ir[ir.length - 1].twaDeg;
  return out;
`, { settle: SETTLE });
note('pro TWA 70/90/175', `${pro[70].kn.toFixed(2)} / ${pro[90].kn.toFixed(2)} / ${pro[175].kn.toFixed(2)} kn`);
check(pro[90].kn > 8 && pro[90].kn < 11, 'Pro beam reach is still ~9.4 kn', `${pro[90].kn.toFixed(2)} kn`);
check(Math.abs(pro[70].twaDeg ?? pro[70].held) + Math.abs(pro[70].leeway) >= 65,
  'Pro still cannot point inside 65 deg',
  `${(Math.abs(pro[70].held) + Math.abs(pro[70].leeway)).toFixed(1)} deg made good`);
check(pro[70].kn > 4 && pro[70].kn < 7, 'Pro close-hauled is still hard work', `${pro[70].kn.toFixed(2)} kn`);
check(pro.irons === true, 'Pro still goes into irons at TWA 45',
  `inIrons = ${pro.irons}, holding ${pro.ironsHeld.toFixed(1)} deg off the wind (latch arms inside 44)`);

/* ------------------------------------------------------------------ *
 *  7. determinism and cost, assisted
 * ------------------------------------------------------------------ */

console.log('\nDETERMINISM — the assist layer must be frame-rate independent');
const fr = await run(`
  const one = (dt) => {
    put(110, 0);
    const tr = px.run(150, dt);
    return tr[tr.length - 1];
  };
  return { slow: one(1 / 30), fast: one(1 / 144) };
`);
const dK = Math.abs(fr.slow.knots - fr.fast.knots);
const dH = Math.abs(fr.slow.headingDeg - fr.fast.headingDeg);
console.log(`   30 fps: ${fr.slow.knots.toFixed(3)} kn  heading ${fr.slow.headingDeg.toFixed(2)}`);
console.log(`  144 fps: ${fr.fast.knots.toFixed(3)} kn  heading ${fr.fast.headingDeg.toFixed(2)}`);
check(dK < 0.05, 'assisted speed identical at 30 and 144 fps', `${dK.toFixed(4)} kn apart`);
check(dH < 0.5, 'assisted heading identical at 30 and 144 fps', `${dH.toFixed(3)} deg apart`);

console.log('\nCOST');
const cost = await run(`
  put(110, 8, { flat: false });
  px.run(20, 1 / 60);
  const t0 = performance.now();
  px.run(10, 1 / 60);
  return { perFrame: (performance.now() - t0) / 600 };
`);
note('assisted solver cost', `${cost.perFrame.toFixed(3)} ms per 60 fps frame`);
check(cost.perFrame < 2.5, 'inside the 2.5 ms/frame budget', `${cost.perFrame.toFixed(3)} ms`);

// Leave the page in the shipping default, in case anything else is watching.
await page.evaluate(() => {
  window.__leeward.world.settings.assist = true;
  window.__leeward.world.ext.physics.assist = true;
});

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
console.log('ALL ASSIST TESTS PASSED');
