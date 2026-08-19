#!/usr/bin/env node
/**
 * Drive the ship for real: arrow keys into the live page, sampling what she
 * does. This is the feel check — the numbers the deterministic stepper gives
 * are not the same thing as sitting at the wheel.
 */
import { chromium } from 'playwright';

const URL = 'http://127.0.0.1:5178/';
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1000, height: 620 } });
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
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => !!window.__leeward?.world?.ext?.physics, null, { timeout: 180000 });
await page.waitForTimeout(2000);

// Dismiss anything covering the canvas, then focus it so the keys land.
await page.mouse.click(500, 400).catch(() => {});
await page.waitForTimeout(400);
await page.mouse.click(500, 400).catch(() => {});

const state = () =>
  page.evaluate(() => {
    const w = window.__leeward.world;
    const s = w.ship;
    const R = 180 / Math.PI;
    return {
      kn: s.speedKnots,
      hdg: (s.heading * R + 360) % 360,
      heel: s.heel * R,
      pitch: s.pitch * R,
      rudder: s.rudder * R,
      area: s.sailArea,
      pos: s.pointOfSail,
      irons: s.inIrons,
      twa: (((w.env.windBearing - s.heading) * R + 540) % 360) - 180,
      steer: w.input.steer,
      trim: w.input.sailTrim,
      throttle: w.ext.physics.throttle,
      uiFocus: w.input.uiFocus,
      assist: w.ext.physics.assist,
      fps: w.time?.fps ?? 0,
    };
  });

async function sample(label, seconds, step = 0.5) {
  const rows = [];
  const n = Math.round(seconds / step);
  for (let i = 0; i < n; i++) {
    rows.push({ t: +(i * step).toFixed(1), ...(await state()) });
    await page.waitForTimeout(step * 1000);
  }
  console.log(`\n### ${label}`);
  for (const r of rows) {
    if (Math.round(r.t * 2) % 4 !== 0) continue;
    console.log(
      `  t=${String(r.t).padStart(5)}  ${r.kn.toFixed(1).padStart(5)} kn  hdg ${r.hdg.toFixed(0).padStart(3)}  ` +
        `TWA ${r.twa.toFixed(0).padStart(4)}  heel ${r.heel.toFixed(1).padStart(5)}  pitch ${r.pitch.toFixed(1).padStart(5)}  ` +
        `rudder ${r.rudder.toFixed(0).padStart(4)}  canvas ${r.area.toFixed(0).padStart(4)}  ` +
        `thr ${(r.throttle * 100).toFixed(0).padStart(3)}%  ${r.pos}${r.irons ? ' IRONS' : ''}`,
    );
  }
  return rows;
}

// Fair weather, a real breeze, and put her at rest so acceleration is visible.
await page.evaluate(() => {
  const w = window.__leeward.world;
  w.settings.assist = true;
  Object.assign(w.env, { windSpeed: 10, gust: 1.05, waveHeight: 1.6, seaState: 4 });
  w.ext.physics.flatSea = false;
  const R = 180 / Math.PI;
  w.ext.physics.reset((w.env.windBearing * R - 100 + 720) % 360, 0);
  // reset() drops the solver into Pro; the live loop will pick assist back up
  // from settings on the very next frame, which is exactly what a player
  // toggling the switch would see.
  w.settings.assist = true;
});
console.log('boot state:', JSON.stringify(await state()));

const a = await sample('FROM REST, hands off — does she gather way?', 26);

console.log('\n>>> holding LEFT (hard a-port) for 22 s');
await page.keyboard.down('ArrowLeft');
const b = await sample('HARD OVER', 22);
await page.keyboard.up('ArrowLeft');

const c = await sample('WHEEL AMIDSHIPS — does she settle on the new course?', 10);

// Steer up to head-to-wind and hold it there.
console.log('\n>>> steering up to head-to-wind and holding');
for (let i = 0; i < 60; i++) {
  const s = await state();
  const err = ((s.twa + 540) % 360) - 180;
  if (Math.abs(err) < 6) break;
  const key = err > 0 ? 'ArrowRight' : 'ArrowLeft';
  await page.keyboard.down(key);
  await page.waitForTimeout(500);
  await page.keyboard.up(key);
}
const d = await sample('DEAD UPWIND, holding', 26);

console.log('\n>>> holding DOWN (take in canvas) for 12 s, then UP for 12 s');
await page.keyboard.down('ArrowDown');
const e = await sample('THROTTLE OFF', 12);
await page.keyboard.up('ArrowDown');
const f = await sample('COASTING', 10);
await page.keyboard.down('ArrowUp');
const g = await sample('THROTTLE ON', 14);
await page.keyboard.up('ArrowUp');
const h = await sample('BACK UP TO SPEED', 14);

const span = (rows, k) => `${Math.min(...rows.map((r) => r[k])).toFixed(1)}..${Math.max(...rows.map((r) => r[k])).toFixed(1)}`;
console.log('\n--- summary ---');
console.log(`  rest -> way:      ${a[0].kn.toFixed(1)} -> ${a[a.length - 1].kn.toFixed(1)} kn in 26 s`);
console.log(`  hard over:        heading ${b[0].hdg.toFixed(0)} -> ${b[b.length - 1].hdg.toFixed(0)}, heel span ${span(b, 'heel')}, speed span ${span(b, 'kn')}`);
console.log(`  settle:           heading ${c[0].hdg.toFixed(0)} -> ${c[c.length - 1].hdg.toFixed(0)}`);
console.log(`  dead upwind:      ${d[d.length - 1].kn.toFixed(1)} kn, TWA ${d[d.length - 1].twa.toFixed(0)}, irons ${d.some((r) => r.irons)}`);
console.log(`  throttle off/on:  ${e[0].kn.toFixed(1)} -> ${f[f.length - 1].kn.toFixed(1)} -> ${h[h.length - 1].kn.toFixed(1)} kn`);
console.log(`  canvas off/on:    ${e[0].area.toFixed(0)} -> ${f[f.length - 1].area.toFixed(0)} -> ${h[h.length - 1].area.toFixed(0)} m^2`);
console.log(`  pitch span:       ${span([...a, ...b, ...d], 'pitch')} deg`);
if (errs.length) {
  console.log(`\n${errs.length} page error(s):`);
  for (const x of [...new Set(errs)].slice(0, 8)) console.log('  ' + x.slice(0, 200));
} else {
  console.log('\nno console errors');
}
await browser.close();
