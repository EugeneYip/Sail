#!/usr/bin/env node
/** Tuning probe for the assist layer. Not an acceptance test — see scripts/assist-test.mjs. */
import { chromium } from 'playwright';

const URL = 'http://127.0.0.1:5178/';
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
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
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => !!window.__leeward?.world?.ext?.physics, null, { timeout: 180000 });
await page.waitForTimeout(1200);

const setup = `
  const w = window.__leeward.world;
  const px = w.ext.physics;
  const RAD = 180 / Math.PI;
`;

async function polar(assist, wind = 10) {
  return page.evaluate(
    ({ assist, wind }) => {
      const w = window.__leeward.world;
      const px = w.ext.physics;
      const RAD = 180 / Math.PI;
      const out = [];
      for (const twa of [0, 20, 45, 70, 90, 120, 150, 180]) {
        w.env.windSpeed = wind;
        w.env.gust = 1;
        w.input.steer = 0;
        px.flatSea = true;
        const heading = (w.env.windBearing * RAD - twa + 720) % 360;
        px.reset(heading, 5);
        px.assist = assist;
        px.sailLevel = 16;
        for (const s of w.ship.sails) s.set = 1;
        const tr = px.run(200, 1 / 60);
        const last = tr[tr.length - 1];
        out.push({
          twa,
          kn: last.knots,
          heel: last.heelDeg,
          leeway: last.leewayDeg,
          held: last.twaDeg,
          rudder: last.rudderDeg,
          irons: w.ship.inIrons,
        });
      }
      return out;
    },
    { assist, wind },
  );
}

async function accel(assist) {
  return page.evaluate(
    ({ assist }) => {
      const w = window.__leeward.world;
      const px = w.ext.physics;
      const RAD = 180 / Math.PI;
      w.env.windSpeed = 10;
      w.env.gust = 1;
      w.input.steer = 0;
      px.flatSea = true;
      const heading = (w.env.windBearing * RAD - 100 + 720) % 360;
      px.reset(heading, 0);
      px.assist = assist;
      px.sailLevel = 16;
      for (const s of w.ship.sails) s.set = 1;
      const tr = px.run(240, 1 / 60, true);
      const top = tr[tr.length - 1].knots;
      const mark = (f) => {
        const t = tr.find((s) => s.knots >= f * top);
        return t ? t.t : null;
      };
      return { top, t50: mark(0.5), t90: mark(0.9), at10: tr[Math.round(10 * 60) - 1].knots, at20: tr[Math.round(20 * 60) - 1].knots, at30: tr[Math.round(30 * 60) - 1].knots };
    },
    { assist },
  );
}

async function turn(assist) {
  return page.evaluate(
    ({ assist }) => {
      const w = window.__leeward.world;
      const px = w.ext.physics;
      const RAD = 180 / Math.PI;
      w.env.windSpeed = 10;
      w.env.gust = 1;
      px.flatSea = true;
      const heading = (w.env.windBearing * RAD - 100 + 720) % 360;
      px.reset(heading, 6);
      px.assist = assist;
      px.sailLevel = 16;
      for (const s of w.ship.sails) s.set = 1;
      w.input.steer = 0;
      px.run(60, 1 / 60);
      const kn0 = w.ship.speedKnots;
      const h0 = w.ship.heading * RAD;
      w.input.steer = 1;
      const tr = px.run(90, 1 / 60, true);
      let prev = h0;
      let turned = 0;
      const rates = [];
      for (const s of tr) {
        let d = s.headingDeg - prev;
        while (d > 180) d -= 360;
        while (d < -180) d += 360;
        turned += d;
        prev = s.headingDeg;
        rates.push({ t: s.t, turned, kn: s.knots });
      }
      w.input.steer = 0;
      const at = (deg) => {
        const r = rates.find((x) => Math.abs(x.turned) >= deg);
        return r ? r.t : null;
      };
      // Steady rate over the last 30 s.
      const a = rates[rates.length - 1];
      const b = rates.find((x) => x.t >= a.t - 30);
      const steady = Math.abs(a.turned - b.turned) / (a.t - b.t);
      return {
        kn0,
        t90: at(90),
        t180: at(180),
        steadyDegS: steady,
        knInTurn: a.kn,
        radius: (a.kn * 0.5144) / (steady / RAD),
      };
    },
    { assist },
  );
}

async function upwindMin() {
  return page.evaluate(() => {
    const w = window.__leeward.world;
    const px = w.ext.physics;
    const RAD = 180 / Math.PI;
    w.env.windSpeed = 10;
    w.env.gust = 1;
    w.input.steer = 0;
    px.flatSea = true;
    px.reset((w.env.windBearing * RAD + 720) % 360, 0);
    px.assist = true;
    px.sailLevel = 16;
    for (const s of w.ship.sails) s.set = 1;
    const tr = px.run(300, 1 / 60, true);
    let min = Infinity;
    for (const s of tr) min = Math.min(min, s.knots);
    return { min, final: tr[tr.length - 1].knots, held: tr[tr.length - 1].twaDeg, vmg: tr[tr.length - 1].vmgKnots };
  });
}

console.log('--- PRO polar (10 m/s) ---');
for (const r of await polar(false)) console.log(`  TWA ${String(r.twa).padStart(3)}  ${r.kn.toFixed(2).padStart(5)} kn  heel ${r.heel.toFixed(1).padStart(5)}  leeway ${r.leeway.toFixed(1).padStart(5)}  held ${r.held.toFixed(0).padStart(4)}  irons ${r.irons}`);
console.log('--- ASSIST polar (10 m/s) ---');
for (const r of await polar(true)) console.log(`  TWA ${String(r.twa).padStart(3)}  ${r.kn.toFixed(2).padStart(5)} kn  heel ${r.heel.toFixed(1).padStart(5)}  leeway ${r.leeway.toFixed(1).padStart(5)}  held ${r.held.toFixed(0).padStart(4)}  irons ${r.irons}`);
console.log('--- ASSIST polar (3 m/s light air) ---');
for (const r of await polar(true, 3)) console.log(`  TWA ${String(r.twa).padStart(3)}  ${r.kn.toFixed(2).padStart(5)} kn  held ${r.held.toFixed(0).padStart(4)}`);
console.log('--- ASSIST polar (0 m/s dead calm) ---');
for (const r of await polar(true, 0)) console.log(`  TWA ${String(r.twa).padStart(3)}  ${r.kn.toFixed(2).padStart(5)} kn`);

console.log('--- accel from rest, TWA 100 ---');
console.log('  pro   ', JSON.stringify(await accel(false)));
console.log('  assist', JSON.stringify(await accel(true)));

console.log('--- hard over from 6 m/s ---');
console.log('  pro   ', JSON.stringify(await turn(false)));
console.log('  assist', JSON.stringify(await turn(true)));

console.log('--- steering dead upwind from rest, assist ---');
console.log('  ', JSON.stringify(await upwindMin()));

void setup;
await browser.close();
