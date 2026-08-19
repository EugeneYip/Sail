#!/usr/bin/env node
/**
 * Two suspicions raised by driving her, checked directly.
 *
 *   A. `input.sailTrim` is an exponential approach, so after the up arrow comes
 *      up it decays toward zero but never REACHES it. `Trim.update` tests
 *      `cmd !== 0` before re-raising the reef cap, so a residual of 1e-40 may be
 *      pinning the cap at the ordered canvas and disabling the watch's reefing.
 *
 *   B. the `pinned` reef rule fires whenever the rudder is past 70 per cent of
 *      hard over. In assist a player HOLDS the arrow key, so the rudder sits at
 *      hard over for the whole turn — which may make the watch strike the rig
 *      during an ordinary turn.
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 560 } });
await page.addInitScript(() => {
  const Real = WebSocket;
  class Dead extends EventTarget { constructor() { super(); this.readyState = 3; } send() {} close() {} }
  const P = function (u, p) {
    const vite = p === 'vite-hmr' || (Array.isArray(p) && p.includes('vite-hmr'));
    return vite ? new Dead() : new Real(u, p);
  };
  P.prototype = Real.prototype;
  Object.assign(P, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  window.WebSocket = P;
});
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => !!window.__leeward?.world?.ext?.physics, null, { timeout: 180000 });
await page.waitForTimeout(2000);
for (let i = 0; i < 12 && (await page.evaluate(() => window.__leeward.world.input.uiFocus)); i++) {
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
}

const look = () =>
  page.evaluate(() => {
    const w = window.__leeward.world;
    const px = w.ext.physics;
    const n = w.ship.sails.length;
    return {
      trimIn: w.input.sailTrim,
      steerIn: w.input.steer,
      ordered: px.throttle * n,
      level: px.sailLevel,
      heel: (w.ship.heel * 180) / Math.PI,
      rud: (w.ship.rudder * 180) / Math.PI,
      kn: w.ship.speedKnots,
      hdg: (w.ship.heading * 180) / Math.PI,
    };
  });

const place = async (twa, kn, env) =>
  page.evaluate(({ twa, kn, env }) => {
    const w = window.__leeward.world;
    Object.assign(w.env, env);
    w.ext.physics.flatSea = true;
    w.ext.physics.reset(((w.env.windBearing * 180) / Math.PI - twa + 720) % 360, kn);
    w.settings.assist = true;
  }, { twa, kn, env });

/* ---- A. the residual ------------------------------------------------ */

console.log('\nA. does input.sailTrim ever actually reach zero after the key comes up?');
await page.keyboard.down('ArrowUp');
await page.waitForTimeout(2500);
await page.keyboard.up('ArrowUp');
for (const s of [1, 3, 6, 12, 25]) {
  await page.waitForTimeout(s * 1000 - (s === 1 ? 0 : 0));
  const r = await look();
  console.log(`   +${String(s).padStart(2)}s after release  sailTrim = ${r.trimIn.toExponential(3)}   (=== 0 ? ${r.trimIn === 0})`);
}

/* ---- B. can the watch reef while a throttle key has been touched? --- */

console.log('\nB. 20 m/s on a beam reach, full press: does the watch shorten sail?');
console.log('   (ordered stays 16; `level` falling below it IS the watch reefing)');

const beamTest = async (label, forceZero) => {
  await place(90, 8, { windSpeed: 20, gust: 1, waveHeight: 0, seaState: 2 });
  await page.evaluate((z) => {
    const w = window.__leeward.world;
    w.ext.physics.sailLevel = 16;
    if (z) w.input.sailTrim = 0;
  }, forceZero);
  // Keep sailTrim pinned to exactly zero every frame for the control case.
  if (forceZero) {
    await page.evaluate(() => {
      window.__zero = setInterval(() => { window.__leeward.world.input.sailTrim = 0; }, 8);
    });
  }
  const rows = [];
  for (let i = 0; i < 9; i++) {
    await page.waitForTimeout(5000);
    rows.push(await look());
  }
  if (forceZero) await page.evaluate(() => clearInterval(window.__zero));
  console.log(`   ${label}`);
  for (const [i, r] of rows.entries()) {
    console.log(
      `     t=${String((i + 1) * 5).padStart(2)}s  heel ${r.heel.toFixed(1).padStart(6)}  ` +
        `${r.kn.toFixed(1).padStart(5)} kn  ordered ${r.ordered.toFixed(1)}  level ${r.level.toFixed(2)}  ` +
        `sailTrim ${r.trimIn.toExponential(1)}`,
    );
  }
  return rows;
};

const withTail = await beamTest('with the exponential tail present (a real player):', false);
const zeroed = await beamTest('with sailTrim forced to EXACTLY zero every frame:', true);
console.log(
  `   >> lowest level reached:  tail ${Math.min(...withTail.map((r) => r.level)).toFixed(2)}   ` +
    `forced-zero ${Math.min(...zeroed.map((r) => r.level)).toFixed(2)}  (16 = the watch never reefed)`,
);

/* ---- C. does holding a turn strike the rig? ------------------------- */

console.log('\nC. hold the left arrow for 25 s on a reach in 10 m/s, sailTrim forced to zero.');
await place(110, 12, { windSpeed: 10, gust: 1, waveHeight: 0, seaState: 2 });
await page.evaluate(() => {
  const w = window.__leeward.world;
  w.ext.physics.sailLevel = 16;
  window.__zero = setInterval(() => { w.input.sailTrim = 0; }, 8);
});
await page.waitForTimeout(4000);
const c0 = await look();
await page.keyboard.down('ArrowLeft');
const cRows = [];
for (let i = 0; i < 5; i++) {
  await page.waitForTimeout(5000);
  cRows.push(await look());
}
await page.keyboard.up('ArrowLeft');
await page.waitForTimeout(6000);
const cAfter = await look();
await page.evaluate(() => clearInterval(window.__zero));
console.log(`   entry: ${c0.kn.toFixed(1)} kn, level ${c0.level.toFixed(2)}, heel ${c0.heel.toFixed(1)}`);
for (const [i, r] of cRows.entries()) {
  console.log(
    `     t=${String((i + 1) * 5).padStart(2)}s  rudder ${r.rud.toFixed(0).padStart(4)}  hdg ${((r.hdg + 360) % 360).toFixed(0).padStart(3)}  ` +
      `${r.kn.toFixed(1).padStart(5)} kn  heel ${r.heel.toFixed(1).padStart(6)}  ordered ${r.ordered.toFixed(1)}  level ${r.level.toFixed(2)}`,
  );
}
console.log(`   6 s after letting go: level ${cAfter.level.toFixed(2)} (RESET_RATE is 0.12 sails/s, so ~100 s to recover 12 sails)`);
console.log(
  `   >> turned ${(((cRows[4].hdg - c0.hdg + 540) % 360) - 180).toFixed(0)} deg in 25 s ` +
    `while the watch took the rig from ${c0.level.toFixed(1)} to ${cRows[4].level.toFixed(1)} sails`,
);

await browser.close();
