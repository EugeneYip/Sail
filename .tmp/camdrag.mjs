#!/usr/bin/env node
/**
 * Camera assertions: drag directions, the yaw circle, the recentre, composition.
 *
 *   node .tmp/camdrag.mjs
 *
 * Why assertions and not screenshots: a look-axis sign error is trivially easy
 * to "fix" into a different wrong state, and two mistakes that cancel look
 * correct from the outside. So every check below drives REAL Chromium pointer
 * events (so `movementX/Y` come from the browser's own input pipeline, exactly
 * as they do for a player) and then asserts on the resulting VIEW DIRECTION —
 * never on the eye position, and never on the accumulator alone.
 *
 * The expectation, from the sign contract in `src/camera/CameraMode.ts`:
 *
 *   drag right -> the view swings to starboard   (ship-relative bearing rises)
 *   drag left  -> the view swings to port
 *   drag up    -> the view tilts up              (axis elevation rises)
 *   drag down  -> the view tilts down
 *
 * Every direction is asserted per mode, with a TWO-SIDED band on the magnitude
 * as well as the sign. One-sided sign checks passed happily while `chase` was
 * losing 70% of the drag, which is the failure this file exists to catch.
 *
 * Three confounds had to be removed before a magnitude could mean anything, and
 * each one had previously been mistaken for a bug:
 *
 *   1. MACHINE LOAD. Six agents share this laptop; a `page.mouse.move` round
 *      trip was measured at 1.2 s, so a twelve-step drag took eighteen seconds
 *      and the gaps between its own steps were longer than the camera's
 *      four-second recentre delay. Every direction test now moves the pointer
 *      ONCE, so the drag cannot straddle any timeout, and the multi-step drag
 *      survives only as the recentre test in section 3, where those gaps are
 *      the point.
 *   2. `orbit` DRIFTS ON PURPOSE at 0.055 rad/s, and a window that nominally
 *      lasts 2.4 s is fourteen SIMULATED seconds once the two `view()` round
 *      trips are paid for — nearly a radian of orbit, which used to be scored as
 *      look. Subtracted analytically; see `dYaw` for why that is exact.
 *   3. `cinematic` CUTS every 8-14 s and dollies within each shot. A cut inside
 *      the measurement window swamps it — which is the whole of why this mode
 *      used to report all four directions inverted, and there was never anything
 *      wrong with its pan. Cuts are now counted and the measurement retried, and
 *      the director's own within-shot sweep is what `CINEMATIC_GAIN_*` allows for.
 *
 * Reading the numbers: a 300 px drag is 0.840 rad of raw look, and a mode that
 * has settled reports very nearly that. `cinematic` deliberately clamps its pan
 * to 0.5 rad and is scored against its own limit.
 */

import { chromium } from 'playwright';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import process from 'node:process';

const URL = 'http://127.0.0.1:5178/';
const W = 1600;
const H = 900;
const CX = W / 2;
const CY = H / 2;

/** Pixels of drag per direction test. 300 px * 0.0028 rad/px = 0.84 rad. */
const DRAG = 300;
const RAW_PER_DRAG = DRAG * 0.0028;
/** `Orbit.ts` ORBIT_RATE — the free-run orbit this probe has to subtract. */
const ORBIT_RATE = 0.055;
/**
 * Milliseconds to wait before sampling. The look accumulator springs with a
 * 0.1 s time constant, but `chase` filters its look TARGET with 0.62 s, so the
 * view direction needs roughly four of those to have arrived.
 */
const SETTLE_MS = 2400;

const staging = await mkdtemp(join(tmpdir(), 'leeward-camdrag-'));
const pending = [];
function stage(rel) {
  const final = resolve(rel);
  const staged = join(staging, `${pending.length}-${basename(final)}`);
  pending.push([staged, final]);
  return staged;
}

const ENV = {
  timeOfDay: 12.7, windSpeed: 10.5, cloudCover: 0.38, cloudType: 0.8,
  turbidity: 2.0, rain: 0, visibility: 34000, seaState: 4, waveHeight: 2.0,
  choppiness: 0.6,
};

const results = [];
const failures = [];

function check(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failures.push(`${name} — ${detail}`);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(52)} ${detail}`);
}

const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist',
    '--enable-unsafe-swiftshader', '--force-color-profile=srgb',
    '--hide-scrollbars', '--mute-audio',
  ],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, colorScheme: 'dark' });
page.setDefaultTimeout(180000);
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });

await page.addInitScript(() => {
  const Real = window.WebSocket;
  class Dead {
    constructor() {
      this.readyState = 3;
      this.close = () => {}; this.send = () => {};
      this.addEventListener = () => {}; this.removeEventListener = () => {};
    }
  }
  window.WebSocket = function (url, protocols) {
    return protocols === 'vite-hmr' ? new Dead() : new Real(url, protocols);
  };
  window.WebSocket.prototype = Real.prototype;
});

await page.goto(URL, { waitUntil: 'domcontentloaded' });
// Six agents share this machine; load averages north of 190 happen, and a cold
// boot measured 60 s at load 195. A short timeout here does not find a bug, it
// just throws the run away.
try {
  await page.waitForFunction(() => !!window.__leeward, null, { timeout: 420000 });
} catch {
  console.error('ENGINE NEVER BOOTED. Page errors:');
  for (const m of pageErrors.slice(0, 12)) console.error('  ' + m);
  await browser.close();
  process.exit(1);
}
await page.evaluate((env) => {
  const w = window.__leeward.world;
  w.settings.adaptiveResolution = false;
  w.settings.renderScale = 1;
  w.settings.debug = true; // lets `free` be reachable the way a debugger reaches it
  Object.assign(w.env, env);
  w.bus.emit('settings:changed');
}, ENV);

// Take the player's path in: the title card sets `input.uiFocus`, which gates
// free-look off entirely, so a probe that skips it measures nothing.
await page.waitForSelector('.intro.ready', { timeout: 420000 });
await page.click('.intro-begin');
await page.waitForTimeout(1600);

/**
 * A watcher appended to the engine's own module list, so it runs after the rig
 * in the same tick and sees exactly the values that frame solved with. A
 * `requestAnimationFrame` sampler would race the engine's loop.
 *
 * It records the peak and trough of the look accumulator, the longest wall-clock
 * frame, and how many cinematic cuts went by — the three things that decide
 * whether a measurement window was clean.
 */
await page.evaluate(() => {
  window.__w = { peakYaw: 0, minAbsYaw: 1e9, lastYaw: 0, maxRawDt: 0, cuts: 0, frames: 0 };
  window.__leeward.modules.push({
    name: 'camwatch',
    init() {},
    update(world) {
      const w = window.__w;
      const y = world.ext.camera.lookYaw;
      w.frames++;
      if (Math.abs(y) > Math.abs(w.peakYaw)) w.peakYaw = y;
      if (Math.abs(y) < w.minAbsYaw) w.minAbsYaw = Math.abs(y);
      w.lastYaw = y;
      if (world.time.rawDt > w.maxRawDt) w.maxRawDt = world.time.rawDt;
      if (world.ext.camera.cut) w.cuts++;
    },
  });
});
const watchReset = () =>
  page.evaluate(() => {
    window.__w = { peakYaw: 0, minAbsYaw: 1e9, lastYaw: 0, maxRawDt: 0, cuts: 0, frames: 0 };
  });
const watchRead = () => page.evaluate(() => window.__w);

/* ------------------------------------------------------------------ *
 *  measurement
 * ------------------------------------------------------------------ */

/**
 * The view direction, the ship's heading, and where the ship's geometry lands in
 * normalised device coordinates. All read in one round trip so the numbers are
 * from the same frame.
 */
async function view() {
  return page.evaluate(() => {
    const w = window.__leeward.world;
    const cam = w.camera;
    w.scene.updateMatrixWorld(true);
    cam.updateMatrixWorld(true);

    // The camera looks down its own -Z. Roll is about Z and so cannot disturb
    // this, which is why the view axis is read from the matrix and not the euler.
    const e = cam.matrixWorld.elements;
    const fx = -e[8], fy = -e[9], fz = -e[10];

    // A scratch Vector3 without importing three into the page.
    const v = w.shipRoot.position.clone();

    // Project EACH MESH's own transformed corners. The previous version unioned
    // them into one world AABB first and projected that, which invents corners
    // the ship does not have: with the eye out on the bow the phantom corner
    // nearest the lens read as the jibboom leaving frame by 2.4 NDC. Per-mesh is
    // still an outer bound, but a tight enough one to assert on.
    let nx0 = Infinity, nx1 = -Infinity, ny0 = Infinity, ny1 = -Infinity;
    let behind = 0;
    let meshes = 0;
    // Which object owns the extreme, and how far from the lens it is. A framing
    // failure that cannot name the offender is a failure you cannot act on.
    let worst = null;
    w.shipRoot.traverse((o) => {
      if (!o.visible || !o.geometry) return;
      const g = o.geometry;
      if (!g.boundingBox) g.computeBoundingBox();
      const bb = g.boundingBox;
      if (!bb) return;
      // Skip effect volumes: nothing on a 62 m ship has a 300 m local extent,
      // and one such box would swallow the whole measurement.
      if (bb.max.x - bb.min.x > 300 || bb.max.y - bb.min.y > 300) return;
      meshes++;
      for (let i = 0; i < 8; i++) {
        v.set(i & 1 ? bb.max.x : bb.min.x, i & 2 ? bb.max.y : bb.min.y, i & 4 ? bb.max.z : bb.min.z);
        v.applyMatrix4(o.matrixWorld);
        const dx = v.x - cam.position.x, dy = v.y - cam.position.y, dz = v.z - cam.position.z;
        // Only corners IN FRONT of the lens are meaningful; one behind it
        // projects to a mirrored, meaningless NDC.
        if (dx * fx + dy * fy + dz * fz <= 0.5) { behind++; continue; }
        const range = Math.sqrt(dx * dx + dy * dy + dz * dz);
        v.project(cam);
        if (v.x < nx0) { nx0 = v.x; worst = { side: 'x0', name: o.name || o.type, ndc: +v.x.toFixed(2), range: +range.toFixed(1) }; }
        if (v.x > nx1) { nx1 = v.x; if (Math.abs(v.x) > Math.abs(nx0)) worst = { side: 'x1', name: o.name || o.type, ndc: +v.x.toFixed(2), range: +range.toFixed(1) }; }
        if (v.y < ny0) ny0 = v.y;
        if (v.y > ny1) ny1 = v.y;
      }
    });

    const shipPos = w.shipRoot.position.lengthSq() > 0 ? w.shipRoot.position : w.ship.position;
    const heading = w.ship.heading;
    // Ship forward is -Z rotated by the heading.
    const sfx = Math.sin(heading), sfz = -Math.cos(heading);
    const ahead =
      (cam.position.x - shipPos.x) * sfx + (cam.position.z - shipPos.z) * sfz;

    return {
      bearing: Math.atan2(fx, -fz),
      elev: Math.asin(Math.max(-1, Math.min(1, fy))),
      heading,
      elapsed: w.time.elapsed,
      mode: w.ext.camera.mode,
      shot: w.ext.camera.shot,
      lookYaw: w.ext.camera.lookYaw,
      lookPitch: w.ext.camera.lookPitch,
      eyeY: +cam.position.y.toFixed(2),
      altitude: +w.ext.camera.altitude.toFixed(2),
      dist: +Math.hypot(cam.position.x - shipPos.x, cam.position.z - shipPos.z).toFixed(1),
      /** Metres the eye is forward of the hull along the ship's own heading. */
      ahead: +ahead.toFixed(1),
      ndc: nx1 > nx0 ? { x0: +nx0.toFixed(3), x1: +nx1.toFixed(3), y0: +ny0.toFixed(3), y1: +ny1.toFixed(3) } : null,
      behind,
      meshes,
      worst,
      knots: +w.ship.speedKnots.toFixed(1),
      camDistance: +w.cam.distance.toFixed(1),
    };
  });
}

const wrapPi = (a) => {
  let x = a;
  while (x > Math.PI) x -= 2 * Math.PI;
  while (x < -Math.PI) x += 2 * Math.PI;
  return x;
};

/**
 * View rotation between two samples with everything that is not the player's
 * drag removed: the hull's own turn (the ship keeps sailing under the camera)
 * and, for `orbit`, its deliberate free-run orbit over the same interval.
 *
 * The orbit term is exact, not a fudge. `Orbit.solve` puts the eye at ship-frame
 * (sin θ, -cos θ) · horiz and aims at the ship, so the ship-relative view bearing
 * is exactly -θ = lookYaw - azimuth, and the azimuth advances at exactly
 * ORBIT_RATE per SIMULATED second. Hence `+ ORBIT_RATE · Δelapsed` recovers the
 * player's contribution. Getting this sign backwards is what made `orbit` report
 * +0.05 rad for a drag right and -2.17 for the same drag left: the correction was
 * being applied twice in the wrong direction, on a window that turned out to be
 * fourteen simulated seconds rather than the two the settle timer asks for,
 * because a `view()` round trip on a loaded machine is measured in seconds.
 */
function dYaw(a, b, mode) {
  const raw = wrapPi(b.bearing - a.bearing);
  if (mode === 'free') return raw; // the fly-cam is world-absolute
  let d = raw - wrapPi(b.heading - a.heading);
  if (mode === 'orbit') d += ORBIT_RATE * (b.elapsed - a.elapsed);
  return wrapPi(d);
}
const dElev = (a, b) => b.elev - a.elev;

/**
 * One pointer move, and only one. See the header: a multi-step drag on a loaded
 * machine spends longer between its own steps than the camera's recentre delay,
 * so the direction tests must not use one.
 */
async function flick(dx, dy) {
  await page.mouse.move(CX, CY);
  await page.mouse.down();
  await page.mouse.move(CX + dx, CY + dy);
  await page.mouse.up();
  await page.waitForTimeout(SETTLE_MS);
}

/**
 * Enter `name` with the look axes zeroed. The rig only re-enters a mode when the
 * requested name differs from the active one, so bounce through another mode.
 */
async function enter(name) {
  await page.evaluate((n) => {
    window.__leeward.world.cam.mode = n === 'chase' ? 'orbit' : 'chase';
  }, name);
  await page.waitForTimeout(300);
  await page.evaluate((n) => { window.__leeward.world.cam.mode = n; }, name);
  await page.waitForTimeout(1400);
}

/** Block the page's main thread — a real stall, one frame with a huge rawDt. */
async function stall(ms) {
  await page.evaluate((n) => {
    const t0 = performance.now();
    while (performance.now() - t0 < n) { /* spin */ }
  }, ms);
}

/* ------------------------------------------------------------------ *
 *  1. four drag directions, every mode with free look
 * ------------------------------------------------------------------ */

// `cinematic` is in here too, and it is the mode this suite was least likely to
// catch: it used to declare lookYawLimit = 0, so a player dragging inside it
// moved nothing at all. A dead axis is not an inverted axis, but it is just as
// broken from the player's side, so it gets the same four assertions as the rest.
const MODES = ['chase', 'helm', 'bowsprit', 'masthead', 'orbit', 'cinematic', 'free'];
/** Fraction of the raw drag a settled mode must deliver, and may not exceed. */
const GAIN_MIN = 0.65;
const GAIN_MAX = 1.35;
/**
 * `cinematic` gets a wider band, and it is the director's own motion that buys it,
 * not slack. Each shot dollies and sweeps its aim by up to 0.28 rad across the
 * shot BY DESIGN, and a measurement window that is fourteen simulated seconds long
 * on a loaded machine catches a real fraction of that on top of the player's pan.
 * Widened to admit it; still far too tight to pass an inverted axis, which is what
 * this mode was actually reporting before cuts were excluded.
 */
const CINEMATIC_GAIN_MIN = 0.5;
const CINEMATIC_GAIN_MAX = 1.7;

console.log('\n=== 1. drag directions (300 px = 0.840 rad of raw look) ===');
const table = [];
for (const mode of MODES) {
  const row = { mode };
  // `cinematic` clamps its pan to 0.5 rad on yaw and 0.32 on pitch, so it is
  // scored against its own limit, not the raw drag.
  const wantYaw = mode === 'cinematic' ? 0.5 : RAW_PER_DRAG;
  const wantPitch = mode === 'cinematic' ? 0.32 : RAW_PER_DRAG;

  for (const [label, dx, dy] of [
    ['right', DRAG, 0], ['left', -DRAG, 0], ['up', 0, -DRAG], ['down', 0, DRAG],
  ]) {
    const want = dy === 0 ? (dx > 0 ? 1 : -1) : dy < 0 ? 1 : -1;
    const expect = dy === 0 ? wantYaw : wantPitch;
    const lo = mode === 'cinematic' ? CINEMATIC_GAIN_MIN : GAIN_MIN;
    const hi = mode === 'cinematic' ? CINEMATIC_GAIN_MAX : GAIN_MAX;
    let d = 0;
    let cuts = 0;
    // A cinematic cut inside the window swamps the measurement; retry rather
    // than score it. Nothing else in the game can invalidate a window.
    for (let attempt = 0; attempt < (mode === 'cinematic' ? 4 : 1); attempt++) {
      await enter(mode);
      await watchReset();
      const a = await view();
      await flick(dx, dy);
      const b = await view();
      cuts = (await watchRead()).cuts;
      d = dy === 0 ? dYaw(a, b, mode) : dElev(a, b);
      if (cuts === 0) break;
    }
    row[label] = +d.toFixed(3);
    const gain = (d * want) / expect;
    check(
      `${mode} / drag ${label} -> view ${dy === 0 ? (dx > 0 ? 'starboard' : 'port') : dy < 0 ? 'up' : 'down'}`,
      cuts === 0 && gain > lo && gain < hi,
      `${d >= 0 ? '+' : ''}${d.toFixed(3)} rad of ${want > 0 ? '+' : '-'}${expect.toFixed(3)} ` +
        `(gain ${gain.toFixed(2)}, need ${lo}-${hi})${cuts ? ` — ${cuts} CUTS in window` : ''}`,
    );
  }
  table.push(row);
}

/* ------------------------------------------------------------------ *
 *  2. full 360 yaw — is a complete circle reachable?
 * ------------------------------------------------------------------ */

console.log('\n=== 2. full 360 yaw ===');
for (const mode of ['chase', 'helm', 'bowsprit', 'masthead', 'orbit']) {
  await enter(mode);
  let prev = await view();
  let travelled = 0;
  // 4 x 700 px = 7.84 rad of raw look: comfortably more than a full circle, so
  // a clamp anywhere below 180 deg either side shows up as a stalled total.
  for (let i = 0; i < 4; i++) {
    await flick(700, 0);
    const now = await view();
    travelled += dYaw(prev, now, mode);
    prev = now;
  }
  check(
    `${mode} / yaw reaches a full circle`,
    travelled > 5.6,
    `view travelled ${travelled.toFixed(2)} rad of 6.28 (need > 5.6)`,
  );
}

/* ------------------------------------------------------------------ *
 *  3. the recentre must yield to the player, and must still work
 * ------------------------------------------------------------------ */

/*
 * `chase` is the only mode with a `lookRecentreRate`, and it used to arm off "no
 * look DELTA for four seconds". A held, motionless pointer produces no delta, so
 * a player holding an angle to look at it was indistinguishable from one who had
 * let go: traced at 99.3% of a deliberate 0.741 rad look silently removed with
 * the button still down. Both halves are asserted here, because a recentre that
 * yields to everything is just a recentre that has been deleted.
 */
console.log('\n=== 3. the recentre ===');

/** Drag in two halves with `gapMs` of stillness between, button DOWN throughout. */
async function heldDrag(gapMs, stallMs = 0) {
  await enter('chase');
  await watchReset();
  await page.mouse.move(CX, CY);
  await page.mouse.down();
  await page.mouse.move(CX + 150, CY);
  if (stallMs > 0) await stall(stallMs);
  if (gapMs > 0) await page.waitForTimeout(gapMs);
  await page.mouse.move(CX + 300, CY);
  await page.mouse.up();
  await page.waitForTimeout(1200);
  return { ...(await watchRead()), v: await view() };
}

{
  // 6 s of stillness spans LOOK_IDLE_SECONDS twice over.
  const r = await heldDrag(6000);
  check(
    'chase / a 6 s motionless HOLD mid-drag keeps the whole drag',
    Math.abs(r.v.lookYaw) > 0.75,
    `lookYaw ${r.v.lookYaw.toFixed(3)} of 0.840 rad (need > 0.75), ${r.frames} frames`,
  );
}
{
  const r = await heldDrag(0, 3000);
  check(
    'chase / an injected 3 s machine STALL mid-drag keeps the drag',
    Math.abs(r.v.lookYaw) > 0.75 && r.maxRawDt > 1,
    `lookYaw ${r.v.lookYaw.toFixed(3)} of 0.840 (need > 0.75), longest frame ${r.maxRawDt.toFixed(2)} s (need > 1)`,
  );
}
{
  // The same stall, but AFTER letting go: a hitch must not be read as four
  // seconds of the player being gone. Guards the idle timer's units.
  await enter('chase');
  await watchReset();
  await flick(DRAG, 0);
  await stall(3000);
  await page.waitForTimeout(600);
  const r = await watchRead();
  const v = await view();
  check(
    'chase / a 3 s stall AFTER release does not arm the recentre',
    Math.abs(v.lookYaw) > 0.75 && r.maxRawDt > 1,
    `lookYaw ${v.lookYaw.toFixed(3)} of 0.840 (need > 0.75), longest frame ${r.maxRawDt.toFixed(2)} s`,
  );
}
{
  // ... and it must still be alive. 150 px = 0.42 rad, below the rig's
  // LOOK_HOLD_FROM, so this deviation gets the mode's full recentre rate.
  await enter('chase');
  await flick(150, 0);
  const before = (await view()).lookYaw;
  await page.waitForTimeout(11000); // 4 s arming + 1.2 s ramp + ~6 s of drift
  const after = (await view()).lookYaw;
  check(
    'chase / the recentre IS still alive once the player lets go',
    Math.abs(after) < 0.5 * Math.abs(before),
    `lookYaw ${before.toFixed(3)} -> ${after.toFixed(3)} over 11 s idle (need < half)`,
  );
}
{
  // The owner's actual complaint: a deliberate angle must not be taken back.
  await enter('chase');
  for (let i = 0; i < 4; i++) await flick(281, 0); // 1124 px = 3.15 rad, the bow
  const before = (await view()).lookYaw;
  await page.waitForTimeout(11000);
  const after = (await view()).lookYaw;
  check(
    'chase / a player parked on the bow STAYS parked',
    Math.abs(after) > 2.6,
    `lookYaw ${before.toFixed(2)} -> ${after.toFixed(2)} rad over 11 s idle (need |x| > 2.6)`,
  );
}

/* ------------------------------------------------------------------ *
 *  4. the bow: reachable, and framed
 * ------------------------------------------------------------------ */

console.log('\n=== 4. the bow ===');
await enter('chase');
const bowBase = await view();
// 180 deg of look = 3.1416 rad / 0.0028 rad per px = 1122 px, in four pulls.
for (let i = 0; i < 4; i++) await flick(281, 0);
const bow = await view();
check(
  'chase / half a turn puts the eye AHEAD of the ship',
  bow.ahead > 5,
  `eye is ${bow.ahead} m forward of the hull (was ${bowBase.ahead} m), lookYaw ${bow.lookYaw.toFixed(2)} rad`,
);
check(
  'chase / ship still framed with the eye on the bow',
  bow.ndc !== null && bow.ndc.x0 > -1 && bow.ndc.x1 < 1,
  bow.ndc
    ? `ndc x ${bow.ndc.x0}..${bow.ndc.x1}, y ${bow.ndc.y0}..${bow.ndc.y1}, ` +
      `${bow.behind} behind lens, worst ${JSON.stringify(bow.worst)}`
    : 'no ship geometry found',
);
await page.screenshot({ path: stage('shots/cam-bow-chase.png'), animations: 'allow' });

// The same shot from the jibboom, looking forward over the head rig — the angle
// the old 140 deg limit made unreachable.
await enter('bowsprit');
for (let i = 0; i < 4; i++) await flick(281, 0);
const bowsprit = await view();
check(
  'bowsprit / can look forward over the bow',
  Math.abs(wrapPi(bowsprit.bearing - bowsprit.heading)) < 0.6,
  `view is ${((wrapPi(bowsprit.bearing - bowsprit.heading) * 180) / Math.PI).toFixed(1)} deg off dead ahead (need < 34)`,
);
await page.screenshot({ path: stage('shots/cam-bow-bowsprit.png'), animations: 'allow' });

/* ------------------------------------------------------------------ *
 *  5. no dead look angle at the pitch limits
 * ------------------------------------------------------------------ */

console.log('\n=== 5. pitch saturation has no dead band ===');
for (const mode of ['chase', 'orbit']) {
  await enter(mode);
  await flick(0, -DRAG * 3); // hard up, well past saturation
  const top = await view();
  await flick(0, 70); // a small nudge back down
  const back = await view();
  check(
    `${mode} / a nudge down after saturating up moves the view`,
    dElev(top, back) < -0.02,
    `d_elev ${dElev(top, back).toFixed(3)} rad from a 70 px nudge (lookPitch ${top.lookPitch.toFixed(2)} -> ${back.lookPitch.toFixed(2)})`,
  );
  check(
    `${mode} / the lens stays out of the sea at full look-up`,
    top.altitude > 1.5,
    `eye ${top.altitude} m above the water`,
  );
}

/* ------------------------------------------------------------------ *
 *  6. composition — nothing may graze a frame edge
 * ------------------------------------------------------------------ */

console.log('\n=== 6. composition ===');
for (const mode of ['chase', 'orbit']) {
  await enter(mode);
  await page.waitForTimeout(2500); // let the framing filters settle
  const v = await view();
  const inFrame = v.ndc && v.ndc.x0 > -0.9 && v.ndc.x1 < 0.9;
  check(
    `${mode} / ship clear of both frame edges`,
    !!inFrame,
    v.ndc
      ? `ndc x ${v.ndc.x0}..${v.ndc.x1} (need inside -0.90..0.90), d ${v.camDistance} m` +
        (inFrame ? '' : `, worst ${JSON.stringify(v.worst)}`)
      : 'no geometry',
  );
  if (!v.ndc) continue;
  // Only `chase` carries the off-centre rule. `orbit` is the full-profile
  // screenshot mode: its composition is vertical (heroic low angle, horizon on
  // the lower third) and centring the subject horizontally is correct there.
  if (mode === 'chase') {
    const centre = (v.ndc.x0 + v.ndc.x1) / 2;
    check(
      'chase / ship is off the centreline',
      Math.abs(centre) > 0.06,
      `ndc centre ${centre.toFixed(3)} (need |x| > 0.06)`,
    );
    // The vertical half of the same rule, and the half that was failing: the
    // mainmast truck must be decisively cropped or decisively clear, never
    // sitting on the top frame edge.
    check(
      'chase / the rig does not GRAZE the top frame edge',
      v.ndc.y1 > 1.06 || v.ndc.y1 < 0.94,
      `top of rig at ndc y ${v.ndc.y1} (must be outside 0.94..1.06; ` +
        `${v.ndc.y1 > 1 ? 'cropped' : 'clear'})`,
    );
  }
}

/* ------------------------------------------------------------------ *
 *  report
 * ------------------------------------------------------------------ */

console.log('\n=== view rotation per 300 px drag, radians ===');
console.log('mode        right     left       up     down');
for (const r of table) {
  console.log(
    `${r.mode.padEnd(10)} ${String(r.right).padStart(6)} ${String(r.left).padStart(8)} ` +
      `${String(r.up).padStart(8)} ${String(r.down).padStart(8)}`,
  );
}

await browser.close();
for (const [staged, final] of pending) {
  await mkdir(dirname(final), { recursive: true });
  await copyFile(staged, final).catch(() => {});
}
await rm(staging, { recursive: true, force: true }).catch(() => {});

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} assertions passed`);
if (pageErrors.length) {
  console.error(`\n${pageErrors.length} page error(s):`);
  for (const e of pageErrors.slice(0, 10)) console.error('  ' + e);
}
if (failures.length) {
  console.error('\nFAILURES:');
  for (const f of failures) console.error('  ' + f);
  process.exit(1);
}
