#!/usr/bin/env node
/**
 * Test-isolation proof.
 *
 * The claim under test: the DETERMINISM case in physics-test.mjs failed only in
 * suite order because section 4 (free roll decay: zero wind, all canvas furled)
 * left the yards braced for no wind at all, and `px.reset()` did not put them
 * back. If that is true then:
 *
 *   A. the SAME dt run twice back to back must disagree (run 1 starts from the
 *      stale rig, run 2 starts from run 1's correctly trimmed rig), and
 *   B. the disagreement must vanish when the rig is reset between cases,
 *
 * and neither of those has anything to do with the integrator.
 *
 * Prints four numbers. `sameDt` is the whole argument: if a frame-rate bug were
 * real, sameDt would be 0 and crossDt would not.
 */
import { chromium } from 'playwright';

const URL = 'http://127.0.0.1:5178/';
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
  const P = function (u, p) {
    const vite = p === 'vite-hmr' || (Array.isArray(p) && p.includes('vite-hmr'));
    return vite ? new Dead() : new Real(u, p);
  };
  P.prototype = Real.prototype;
  Object.assign(P, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  window.WebSocket = P;
});
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => !!window.__leeward?.world?.ext?.physics, null, {
  timeout: 180000,
});
await page.waitForTimeout(1500);

const out = await page.evaluate(() => {
  const w = window.__leeward.world;
  const px = w.ext.physics;
  const RAD = 180 / Math.PI;

  // Section 4 of physics-test, verbatim: zero wind, bare poles, roll decay.
  // This is the case that precedes DETERMINISM in suite order.
  const pollute = () => {
    w.env.windSpeed = 0;
    w.env.gust = 1;
    w.input.steer = 0;
    px.flatSea = true;
    px.sailLevel = 0;
    for (const s of w.ship.sails) s.set = 0;
    px.reset(0, 0, 20);
    px.run(80, 1 / 120, true);
  };

  // Section 5 of physics-test, verbatim.
  const heading = () => ((w.env.windBearing * RAD) - 120 + 720) % 360;
  const one = (dt) => {
    w.env.windSpeed = 9;
    w.env.gust = 1;
    w.input.steer = 0;
    px.flatSea = true;
    px.reset(heading(), 0);
    px.sailLevel = 16;
    for (const s of w.ship.sails) s.set = 1;
    // Total yard angle the rig starts the run at. If reset() trims the yards
    // this is a function of the apparent wind only; if it does not, it is
    // whatever the last scenario happened to leave.
    let brace0 = 0;
    for (const s of w.ship.sails) brace0 += Math.abs(s.brace);
    const tr = px.run(150, dt);
    const l = tr[tr.length - 1];
    return { kn: l.knots, hdg: l.headingDeg, heel: l.heelDeg, brace0: brace0 * RAD };
  };

  // The suite's own order: roll decay, then determinism.
  pollute();
  const a30 = one(1 / 30); // first after the polluting case
  const b30 = one(1 / 30); // same dt again, now after a clean reach
  const f144 = one(1 / 144);

  // Now the determinism case in isolation, nothing before it but a fresh reach.
  pollute();
  const i30 = one(1 / 30);
  pollute();
  const i144 = one(1 / 144);

  return { a30, b30, f144, i30, i144 };
});

const d = (x, y) => ({
  kn: Math.abs(x.kn - y.kn),
  hdg: Math.abs(x.hdg - y.hdg),
  heel: Math.abs(x.heel - y.heel),
});

const show = (label, r) =>
  console.log(
    `  ${label.padEnd(26)} ${r.kn.toFixed(3).padStart(7)} kn  ` +
      `hdg ${r.hdg.toFixed(2).padStart(7)}  heel ${r.heel.toFixed(2).padStart(6)}  ` +
      `yards at start ${r.brace0.toFixed(1).padStart(6)} deg`,
  );

console.log('\nSUITE ORDER (roll decay immediately before):');
show('30 fps, 1st after decay', out.a30);
show('30 fps, 2nd (same dt!)', out.b30);
show('144 fps, 3rd', out.f144);

console.log('\nISOLATED (each preceded by its own fresh roll-decay reset):');
show('30 fps', out.i30);
show('144 fps', out.i144);

const sameDt = d(out.a30, out.b30);
const crossDt = d(out.a30, out.f144);
const isolated = d(out.i30, out.i144);

console.log('\nDELTAS');
console.log(
  `  same dt, back to back      ${sameDt.kn.toFixed(4)} kn  ${sameDt.hdg.toFixed(3)} deg hdg  ${sameDt.heel.toFixed(3)} deg heel`,
);
console.log(
  `  30 vs 144 in suite order   ${crossDt.kn.toFixed(4)} kn  ${crossDt.hdg.toFixed(3)} deg hdg  ${crossDt.heel.toFixed(3)} deg heel`,
);
console.log(
  `  30 vs 144 isolated         ${isolated.kn.toFixed(4)} kn  ${isolated.hdg.toFixed(3)} deg hdg  ${isolated.heel.toFixed(3)} deg heel`,
);

console.log('\nVERDICT');
if (sameDt.kn < 1e-6 && sameDt.hdg < 1e-6) {
  console.log('  The same dt twice is bit-identical => run() is a pure function of');
  console.log('  (pose, rig, weather, dt). No rig state survives a reset.');
} else {
  console.log('  The same dt twice DISAGREES => the difference cannot be dt. It is');
  console.log(`  starting rig state: ${sameDt.kn.toFixed(4)} kn from nothing but run order.`);
}
const yardDelta = Math.abs(out.a30.brace0 - out.b30.brace0);
console.log(
  `  yard angle at the start of run 1 vs run 2: ${out.a30.brace0.toFixed(1)} vs ${out.b30.brace0.toFixed(1)} deg (delta ${yardDelta.toFixed(1)})`,
);

await browser.close();
