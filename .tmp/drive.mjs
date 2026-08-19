#!/usr/bin/env node
/**
 * Drive the ship for real: arrow keys into the live page, sampling every
 * rendered frame from inside it. This is the FEEL check — the deterministic
 * stepper measures the ship, this measures what it is like to sit at the wheel.
 *
 * Everything here goes through the player's own path: the title screen is
 * dismissed with a keypress, the helm and throttle are real key events, and
 * nothing touches world state except to set the weather and put her at rest.
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
const page = await browser.newPage({ viewport: { width: 1000, height: 620 } });
await page.addInitScript(() => {
  const Real = WebSocket;
  class Dead extends EventTarget {
    constructor() { super(); this.readyState = 3; }
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
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => !!window.__leeward?.world?.ext?.physics, null, { timeout: 180000 });
await page.waitForTimeout(2500);

/* ---- the player's own way in: press a key at the title -------------- */

const before = await page.evaluate(() => ({
  uiFocus: window.__leeward.world.input.uiFocus,
  assist: window.__leeward.world.settings.assist,
}));
await page.mouse.move(500, 320);
for (let i = 0; i < 12 && (await page.evaluate(() => window.__leeward.world.input.uiFocus)); i++) {
  await page.keyboard.press('Enter');
  await page.waitForTimeout(600);
}
const after = await page.evaluate(() => ({
  uiFocus: window.__leeward.world.input.uiFocus,
  assist: window.__leeward.world.settings.assist,
  exta: window.__leeward.world.ext.physics.assist,
}));
console.log(`TITLE  uiFocus ${before.uiFocus} -> ${after.uiFocus}   assist ${after.assist} (solver ${after.exta})`);

/* ---- per-frame recorder, read out in one go ------------------------- */

await page.evaluate(() => {
  const w = window.__leeward.world;
  const px = w.ext.physics;
  const R = 180 / Math.PI;
  const rec = (window.__rec = { on: false, t: 0, rows: [] });
  const tick = () => {
    if (rec.on) {
      const s = w.ship;
      rec.t += w.time.dt;
      rec.rows.push({
        t: rec.t,
        dt: w.time.dt,
        kn: s.speedKnots,
        hdg: s.heading * R,
        heel: s.heel * R,
        pitch: s.pitch * R,
        y: s.position.y,
        x: s.position.x,
        z: s.position.z,
        rud: s.rudder * R,
        area: s.sailArea,
        thr: px.throttle,
        steer: w.input.steer,
        irons: s.inIrons ? 1 : 0,
        pos: s.pointOfSail,
        twa: (((w.env.windBearing - s.heading) * R + 540) % 360) - 180,
      });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

const rec = {
  start: () => page.evaluate(() => { window.__rec.rows.length = 0; window.__rec.t = 0; window.__rec.on = true; }),
  stop: () => page.evaluate(() => { window.__rec.on = false; return window.__rec.rows; }),
};

const wrap = (d) => ((d + 540) % 360) - 180;
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const span = (rows, k) => [Math.min(...rows.map((r) => r[k])), Math.max(...rows.map((r) => r[k]))];

/** Simulated seconds until `pred` first holds. */
function firstAt(rows, pred) {
  for (const r of rows) if (pred(r)) return r.t;
  return null;
}

/** Yaw rate, deg/s, smoothed over a ~1 s window. */
function yawRates(rows) {
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    let j = i;
    while (j < rows.length - 1 && rows[j].t - rows[i].t < 1) j++;
    if (j === i) continue;
    out.push({ t: rows[i].t, rate: wrap(rows[j].hdg - rows[i].hdg) / (rows[j].t - rows[i].t) });
  }
  return out;
}

function frameStats(rows) {
  const dts = rows.map((r) => r.dt * 1000).filter((d) => d > 0);
  return `frame period p25/p50/p95 ${pct(dts, 0.25).toFixed(1)}/${pct(dts, 0.5).toFixed(1)}/${pct(dts, 0.95).toFixed(1)} ms over ${rows.length} frames`;
}

function table(rows, every = 2) {
  let next = 0;
  for (const r of rows) {
    if (r.t < next) continue;
    next = r.t + every;
    console.log(
      `   t=${r.t.toFixed(1).padStart(5)}  ${r.kn.toFixed(1).padStart(5)} kn  hdg ${((r.hdg + 360) % 360).toFixed(0).padStart(3)}  ` +
        `TWA ${r.twa.toFixed(0).padStart(4)}  heel ${r.heel.toFixed(1).padStart(5)}  pitch ${r.pitch.toFixed(1).padStart(5)}  ` +
        `heave ${r.y.toFixed(2).padStart(5)}  rud ${r.rud.toFixed(0).padStart(4)}  canvas ${r.area.toFixed(0).padStart(4)}  ` +
        `thr ${(r.thr * 100).toFixed(0).padStart(3)}%  ${r.pos}${r.irons ? ' IRONS' : ''}`,
    );
  }
}

/** Put her where a scenario wants her, without touching the assist layer. */
async function place(twa, knots, env) {
  await page.evaluate(({ twa, knots, env }) => {
    const w = window.__leeward.world;
    Object.assign(w.env, env);
    const R = 180 / Math.PI;
    w.ext.physics.reset((w.env.windBearing * R - twa + 720) % 360, knots);
    // reset() drops the solver into Pro by design; the live loop reads the mode
    // back off settings on the very next frame, which is what a player sees.
    w.settings.assist = true;
  }, { twa, knots, env });
  await page.waitForTimeout(500);
}

const REAL_SEA = { windSpeed: 10, gust: 1.06, waveHeight: 1.8, seaState: 4, choppiness: 0.6 };
await page.evaluate(() => { window.__leeward.world.ext.physics.flatSea = false; });

/* ================= 1. from rest, on the up arrow ==================== */

console.log('\n=== 1. FROM A DEAD STOP, TWA 100, 10 m/s, bare poles: hold UP ===');
await place(100, 0, REAL_SEA);
await page.evaluate(() => { window.__leeward.world.ext.physics.sailLevel = 0; });
await page.waitForTimeout(300);
await rec.start();
await page.keyboard.down('ArrowUp');
await page.waitForTimeout(9000);
await page.keyboard.up('ArrowUp');
await page.waitForTimeout(26000);
const a = await rec.stop();
table(a, 3);
const aTop = Math.max(...a.map((r) => r.kn));
console.log(`   ${frameStats(a)}`);
console.log(
  `   >> 1 kn at ${firstAt(a, (r) => r.kn > 1)?.toFixed(1)} s, 5 kn at ${firstAt(a, (r) => r.kn > 5)?.toFixed(1)} s, ` +
    `10 kn at ${firstAt(a, (r) => r.kn > 10)?.toFixed(1)} s, 90% of ${aTop.toFixed(1)} at ${firstAt(a, (r) => r.kn > 0.9 * aTop)?.toFixed(1)} s`,
);
console.log(`   >> heel span ${span(a, 'heel').map((v) => v.toFixed(1)).join(' .. ')} deg, heave ${span(a, 'y').map((v) => v.toFixed(2)).join(' .. ')} m, pitch ${span(a, 'pitch').map((v) => v.toFixed(1)).join(' .. ')} deg`);

/* ================= 2. hard over ==================================== */

console.log('\n=== 2. HARD A-PORT from that reach, hold LEFT 30 s, then let go ===');
await rec.start();
await page.keyboard.down('ArrowLeft');
await page.waitForTimeout(30000);
await page.keyboard.up('ArrowLeft');
await page.waitForTimeout(12000);
const b = await rec.stop();
table(b, 3);
const bRates = yawRates(b);
const h0 = b[0].hdg;
let turned = 0;
let prev = h0;
const turnRows = [];
for (const r of b) { turned += wrap(r.hdg - prev); prev = r.hdg; turnRows.push({ ...r, turned: Math.abs(turned) }); }
const t10 = firstAt(turnRows, (r) => r.turned > 10);
const t90 = firstAt(turnRows, (r) => r.turned > 90);
const t180 = firstAt(turnRows, (r) => r.turned > 180);
const rate1 = firstAt(bRates.map((x) => ({ t: x.t, r: Math.abs(x.rate) })), (x) => x.r > 1);
const peakRate = Math.max(...bRates.map((x) => Math.abs(x.rate)));
const steadyRate = bRates.filter((x) => x.t > 12 && x.t < 28).reduce((s, x, _, arr) => s + Math.abs(x.rate) / arr.length, 0);
console.log(`   ${frameStats(b)}`);
console.log(`   >> wheel: rudder reached ${Math.max(...b.map((r) => Math.abs(r.rud))).toFixed(0)} deg, |steer| 1.0 at ${firstAt(b, (r) => Math.abs(r.steer) > 0.95)?.toFixed(2)} s`);
console.log(`   >> 1 deg/s of yaw at ${rate1?.toFixed(1)} s, 10 deg of heading at ${t10?.toFixed(1)} s, 90 deg at ${t90?.toFixed(1)} s, 180 deg at ${t180?.toFixed(1)} s`);
console.log(`   >> steady rate ${steadyRate.toFixed(2)} deg/s, peak ${peakRate.toFixed(2)} deg/s`);
if (t90 != null) {
  const p0 = turnRows[0];
  const p90 = turnRows.find((r) => r.turned > 90);
  const chord = Math.hypot(p90.x - p0.x, p90.z - p0.z);
  console.log(`   >> radius over the first 90 deg: ${(chord / Math.SQRT2).toFixed(0)} m = ${(chord / Math.SQRT2 / 53.3).toFixed(1)} ship lengths`);
}
console.log(`   >> speed through the turn ${b[0].kn.toFixed(1)} -> min ${Math.min(...b.map((r) => r.kn)).toFixed(1)} -> ${b[b.length - 1].kn.toFixed(1)} kn`);
console.log(`   >> heel ${span(b, 'heel').map((v) => v.toFixed(1)).join(' .. ')} deg (does she lean into it?), canvas ${span(b, 'area').map((v) => v.toFixed(0)).join(' .. ')} m^2 unprompted`);
const settle = b.filter((r) => r.t > 30);
console.log(`   >> after letting go: heading ${((settle[0].hdg + 360) % 360).toFixed(0)} -> ${((settle[settle.length - 1].hdg + 360) % 360).toFixed(0)}, still swinging ${Math.abs(wrap(settle[settle.length - 1].hdg - settle[Math.max(0, settle.length - 60)].hdg)).toFixed(1)} deg in the last second`);

/* ================= 3. straight upwind =============================== */

console.log('\n=== 3. LUFF UP TO DEAD UPWIND with the arrows and hold there ===');
await rec.start();
let luffSeconds = 0;
for (let i = 0; i < 80; i++) {
  const s = await page.evaluate(() => {
    const w = window.__leeward.world;
    const R = 180 / Math.PI;
    return { twa: (((w.env.windBearing - w.ship.heading) * R + 540) % 360) - 180 };
  });
  if (Math.abs(s.twa) < 5) break;
  const key = s.twa > 0 ? 'ArrowRight' : 'ArrowLeft';
  await page.keyboard.down(key);
  await page.waitForTimeout(700);
  await page.keyboard.up(key);
  await page.waitForTimeout(200);
  luffSeconds += 0.9;
}
await page.waitForTimeout(25000);
const c = await rec.stop();
table(c, 4);
const hold = c.filter((r) => r.t > c[c.length - 1].t - 20);
console.log(`   ${frameStats(c)}`);
console.log(`   >> took ${luffSeconds.toFixed(1)} s of nudging the arrows to come up head to wind`);
console.log(`   >> holding dead upwind: TWA ${span(hold, 'twa').map((v) => v.toFixed(0)).join(' .. ')}, speed ${span(hold, 'kn').map((v) => v.toFixed(1)).join(' .. ')} kn`);
console.log(`   >> ever flagged in irons: ${c.some((r) => r.irons) ? 'YES' : 'no'};  ever below 2 kn: ${c.some((r) => r.kn < 2) ? 'YES' : 'no'};  slowest ${Math.min(...c.map((r) => r.kn)).toFixed(1)} kn`);
console.log(`   >> heel ${span(hold, 'heel').map((v) => v.toFixed(1)).join(' .. ')} deg, pitch ${span(hold, 'pitch').map((v) => v.toFixed(1)).join(' .. ')} deg, heave ${span(hold, 'y').map((v) => v.toFixed(2)).join(' .. ')} m`);

/* ================= 4. bear away, arrow keys only ==================== */

console.log('\n=== 4. BEAR AWAY 120 deg onto a broad reach, helm only, yards hands-off ===');
const braces0 = await page.evaluate(() => window.__leeward.world.ship.sails.map((s) => s.brace));
await rec.start();
await page.keyboard.down('ArrowRight');
await page.waitForTimeout(14000);
await page.keyboard.up('ArrowRight');
await page.waitForTimeout(24000);
const d = await rec.stop();
const braces1 = await page.evaluate(() => window.__leeward.world.ship.sails.map((s) => s.brace));
let moved = 0;
for (let i = 0; i < braces0.length; i++) moved += Math.abs(braces1[i] - braces0[i]);
table(d, 4);
console.log(`   ${frameStats(d)}`);
console.log(`   >> yards moved ${(moved * 180 / Math.PI).toFixed(0)} deg in total with the player touching only the helm`);
console.log(`   >> speed ${d[0].kn.toFixed(1)} -> ${d[d.length - 1].kn.toFixed(1)} kn, TWA ${d[0].twa.toFixed(0)} -> ${d[d.length - 1].twa.toFixed(0)}`);
console.log(`   >> sailTrim/brace input seen: ${JSON.stringify(await page.evaluate(() => ({ trim: window.__leeward.world.input.sailTrim, brace: window.__leeward.world.input.brace })))}`);

/* ================= 5. a real sea: does she weigh 2200 t? ============ */

console.log('\n=== 5. STORM SEA on a broad reach — mass check on live frames ===');
await place(130, 9, { windSpeed: 21, gust: 1.2, waveHeight: 6, seaState: 7, choppiness: 0.85 });
await rec.start();
await page.waitForTimeout(40000);
const e = await rec.stop();
table(e, 5);
console.log(`   ${frameStats(e)}`);
console.log(`   >> heel ${span(e, 'heel').map((v) => v.toFixed(1)).join(' .. ')} deg, pitch ${span(e, 'pitch').map((v) => v.toFixed(1)).join(' .. ')} deg, heave ${span(e, 'y').map((v) => v.toFixed(2)).join(' .. ')} m`);
console.log(`   >> speed ${span(e, 'kn').map((v) => v.toFixed(1)).join(' .. ')} kn, canvas ${span(e, 'area').map((v) => v.toFixed(0)).join(' .. ')} m^2 (the watch reefing on its own)`);
// Roll period straight off the live trace: zero crossings of heel about its mean.
const meanHeel = e.reduce((s, r) => s + r.heel, 0) / e.length;
const cross = [];
for (let i = 1; i < e.length; i++) {
  const p = e[i - 1].heel - meanHeel;
  const q = e[i].heel - meanHeel;
  if (p > 0 && q <= 0) cross.push(e[i - 1].t + (p / (p - q)) * (e[i].t - e[i - 1].t));
}
const per = [];
for (let i = 1; i < cross.length; i++) per.push(cross[i] - cross[i - 1]);
console.log(`   >> live roll: ${per.length} cycles about a ${meanHeel.toFixed(1)} deg mean, mean period ${(per.reduce((s, x) => s + x, 0) / Math.max(1, per.length)).toFixed(1)} s`);

/* ================= 6. Pro mode, same wheel ========================= */

console.log('\n=== 6. PRO MODE, same keys, same weather: the contrast ===');
await place(100, 0, REAL_SEA);
await page.evaluate(() => { const w = window.__leeward.world; w.settings.assist = false; w.ext.physics.sailLevel = 0; });
await page.waitForTimeout(500);
await rec.start();
await page.keyboard.down('ArrowUp');
await page.waitForTimeout(9000);
await page.keyboard.up('ArrowUp');
await page.waitForTimeout(21000);
await page.keyboard.down('ArrowLeft');
await page.waitForTimeout(25000);
await page.keyboard.up('ArrowLeft');
const f = await rec.stop();
const fTurn = (() => { let t = 0, p = f[0].hdg; const out = []; for (const r of f) { t += wrap(r.hdg - p); p = r.hdg; out.push({ ...r, turned: Math.abs(t) }); } return out; })();
console.log(`   >> Pro from rest: 5 kn at ${firstAt(f, (r) => r.kn > 5)?.toFixed(1) ?? 'never'} s, top ${Math.max(...f.map((r) => r.kn)).toFixed(1)} kn in 30 s`);
const proAt30 = fTurn.find((r) => r.t > 30);
const proEnd = fTurn[fTurn.length - 1];
console.log(`   >> Pro hard over for 25 s from ${proAt30?.kn.toFixed(1)} kn: turned ${(proEnd.turned - (proAt30?.turned ?? 0)).toFixed(0)} deg`);
await page.evaluate(() => { window.__leeward.world.settings.assist = true; });

/* ================= what the player can see ========================= */

const hud = await page.evaluate(() => {
  const t = document.body.innerText.replace(/\s+/g, ' ').trim();
  return t.slice(0, 400);
});
console.log(`\nHUD TEXT ON SCREEN: ${hud}`);

if (errs.length) {
  console.log(`\n${errs.length} page error(s):`);
  for (const x of [...new Set(errs)].slice(0, 8)) console.log('  ' + x.slice(0, 220));
} else {
  console.log('\nno console errors');
}
await browser.close();
