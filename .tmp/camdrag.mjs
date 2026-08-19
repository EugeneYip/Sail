#!/usr/bin/env node
/**
 * Drag-direction assertions for every camera mode, plus the composition bound.
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
 * "Ship-relative" matters: the hull is turning under the camera the whole time,
 * so the ship's own heading change over the measurement window is subtracted
 * before the assertion. The fly-cam is world-absolute and is measured that way.
 *
 * Reading the numbers: a 300 px drag is 0.840 rad of raw look, and the
 * first-person modes report exactly that, which is the proof that the pointer
 * events arrive intact. `chase` reports LESS — sometimes half — and that is not a
 * lost event. It is the only mode with a `lookRecentreRate`, and on a machine at
 * load 190 a single stalled frame can carry a multi-second `dt`, which both
 * pushes `lookIdle` past the rig's 4 s threshold and then applies the recentre
 * for that whole `dt` in one step. It shrinks the magnitude and can never flip
 * the sign, so the assertions are unaffected — but do not go hunting for a
 * missing 40% of drag. Run on a quiet machine if you want clean magnitudes.
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

/** Pixels of drag per test. 300 px * 0.0028 rad/px = 0.84 rad of raw look. */
const DRAG = 300;
/** Minimum view rotation, radians, that counts as "it moved the right way". */
const MIN_YAW = 0.25;
const MIN_PITCH = 0.18;

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
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(46)} ${detail}`);
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
} catch (e) {
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

    // World AABB of the ship's visible geometry.
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let meshes = 0;
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
        if (v.x < minX) minX = v.x; if (v.x > maxX) maxX = v.x;
        if (v.y < minY) minY = v.y; if (v.y > maxY) maxY = v.y;
        if (v.z < minZ) minZ = v.z; if (v.z > maxZ) maxZ = v.z;
      }
    });

    // Project that box. Only corners IN FRONT of the lens are meaningful; a
    // corner behind it projects to a mirrored, meaningless NDC.
    let nx0 = Infinity, nx1 = -Infinity, ny0 = Infinity, ny1 = -Infinity;
    let behind = 0;
    if (meshes > 0) {
      for (let i = 0; i < 8; i++) {
        v.set(i & 1 ? maxX : minX, i & 2 ? maxY : minY, i & 4 ? maxZ : minZ);
        // depth along the view axis
        const dx = v.x - cam.position.x, dy = v.y - cam.position.y, dz = v.z - cam.position.z;
        if (dx * fx + dy * fy + dz * fz <= 0.5) { behind++; continue; }
        v.project(cam);
        if (v.x < nx0) nx0 = v.x; if (v.x > nx1) nx1 = v.x;
        if (v.y < ny0) ny0 = v.y; if (v.y > ny1) ny1 = v.y;
      }
    }

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
      mode: w.ext.camera.mode,
      lookYaw: w.ext.camera.lookYaw,
      lookPitch: w.ext.camera.lookPitch,
      eyeY: +cam.position.y.toFixed(2),
      altitude: +w.ext.camera.altitude.toFixed(2),
      dist: +Math.hypot(cam.position.x - shipPos.x, cam.position.z - shipPos.z).toFixed(1),
      /** Metres the eye is forward of the hull along the ship's own heading. */
      ahead: +ahead.toFixed(1),
      ndc: meshes ? { x0: +nx0.toFixed(3), x1: +nx1.toFixed(3), y0: +ny0.toFixed(3), y1: +ny1.toFixed(3) } : null,
      behind,
      meshes,
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

/** View rotation between two samples, with the hull's own turn removed. */
const dYawRel = (a, b) => wrapPi(b.bearing - a.bearing) - wrapPi(b.heading - a.heading);
const dYawAbs = (a, b) => wrapPi(b.bearing - a.bearing);
const dElev = (a, b) => b.elev - a.elev;

/** Real pointer events through the browser's input pipeline. */
async function drag(dx, dy, steps = 12) {
  await page.mouse.move(CX, CY);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(CX + (dx * i) / steps, CY + (dy * i) / steps);
  }
  await page.mouse.up();
  // The rig springs the look axes with a 0.1 s time constant and the modes add
  // their own filters; 0.8 s is several time constants for all of them.
  await page.waitForTimeout(800);
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
  await page.waitForTimeout(1500);
}

/* ------------------------------------------------------------------ *
 *  1. four drag directions, every mode that has free look
 * ------------------------------------------------------------------ */

// `cinematic` is in here too, and it is the mode this suite was least likely to
// catch: it used to declare lookYawLimit = 0, so a player dragging inside it
// moved nothing at all. A dead axis is not an inverted axis, but it is just as
// broken from the player's side, so it gets the same four assertions as the rest.
// Its pan is bounded at 0.5 rad, hence the smaller thresholds below.
const MODES = ['chase', 'helm', 'bowsprit', 'masthead', 'orbit', 'cinematic', 'free'];

console.log('\n=== 1. drag directions ===');
const table = [];
for (const mode of MODES) {
  const absolute = mode === 'free';
  const row = { mode };
  for (const [label, dx, dy] of [
    ['right', DRAG, 0], ['left', -DRAG, 0], ['up', 0, -DRAG], ['down', 0, DRAG],
  ]) {
    await enter(mode);
    const a = await view();
    await drag(dx, dy);
    const b = await view();

    // `cinematic` deliberately clamps its pan well below a 300 px drag, so it is
    // asserted against its own limit rather than the shared threshold.
    const yawFloor = mode === 'cinematic' ? 0.3 : MIN_YAW;
    const pitchFloor = mode === 'cinematic' ? 0.15 : MIN_PITCH;

    if (dy === 0) {
      const d = absolute ? dYawAbs(a, b) : dYawRel(a, b);
      row[label] = +d.toFixed(3);
      const want = dx > 0 ? 1 : -1;
      check(
        `${mode} / drag ${label} -> view ${dx > 0 ? 'starboard' : 'port'}`,
        d * want > yawFloor,
        `d_yaw ${d >= 0 ? '+' : ''}${d.toFixed(3)} rad (need ${want > 0 ? '>' : '<'} ${want > 0 ? '+' : '-'}${yawFloor}), accum lookYaw ${b.lookYaw.toFixed(3)}`,
      );
    } else {
      const d = dElev(a, b);
      row[label] = +d.toFixed(3);
      const want = dy < 0 ? 1 : -1;
      check(
        `${mode} / drag ${label} -> view ${dy < 0 ? 'up' : 'down'}`,
        d * want > pitchFloor,
        `d_elev ${d >= 0 ? '+' : ''}${d.toFixed(3)} rad (need ${want > 0 ? '>' : '<'} ${want > 0 ? '+' : '-'}${pitchFloor}), eye ${a.eyeY}->${b.eyeY} m`,
      );
    }
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
    await drag(700, 0, 10);
    const now = await view();
    travelled += dYawRel(prev, now);
    prev = now;
  }
  check(
    `${mode} / yaw reaches a full circle`,
    travelled > 5.6,
    `view travelled ${travelled.toFixed(2)} rad of 6.28 (need > 5.6)`,
  );
}

/* ------------------------------------------------------------------ *
 *  3. the bow: reachable, and framed
 * ------------------------------------------------------------------ */

console.log('\n=== 3. the bow ===');
await enter('chase');
const bowBase = await view();
// 180 deg of look = 3.1416 rad / 0.0028 rad per px = 1122 px, in four pulls.
for (let i = 0; i < 4; i++) await drag(281, 0, 10);
const bow = await view();
check(
  'chase / half a turn puts the eye AHEAD of the ship',
  bow.ahead > 5,
  `eye is ${bow.ahead} m forward of the hull (was ${bowBase.ahead} m), lookYaw ${bow.lookYaw.toFixed(2)} rad`,
);
check(
  'chase / ship still framed with the eye on the bow',
  bow.ndc !== null && bow.ndc.x0 > -1 && bow.ndc.x1 < 1 && bow.behind === 0,
  bow.ndc
    ? `ndc x ${bow.ndc.x0}..${bow.ndc.x1}, y ${bow.ndc.y0}..${bow.ndc.y1}, ${bow.behind} corners behind lens`
    : 'no ship geometry found',
);
await page.screenshot({ path: stage('shots/cam-bow-chase.png'), animations: 'allow' });

// The same shot from the jibboom, looking forward over the head rig — the angle
// the old 140 deg limit made unreachable.
await enter('bowsprit');
for (let i = 0; i < 4; i++) await drag(281, 0, 10);
const bowsprit = await view();
check(
  'bowsprit / can look forward over the bow',
  Math.abs(wrapPi(bowsprit.bearing - bowsprit.heading)) < 0.6,
  `view is ${((wrapPi(bowsprit.bearing - bowsprit.heading) * 180) / Math.PI).toFixed(1)} deg off dead ahead (need < 34)`,
);
await page.screenshot({ path: stage('shots/cam-bow-bowsprit.png'), animations: 'allow' });

/* ------------------------------------------------------------------ *
 *  4. no dead look angle at the pitch limits
 * ------------------------------------------------------------------ */

console.log('\n=== 4. pitch saturation has no dead band ===');
for (const mode of ['chase', 'orbit']) {
  await enter(mode);
  await drag(0, -DRAG * 3, 20); // hard up, well past saturation
  const top = await view();
  await drag(0, 70, 6); // a small nudge back down
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
 *  5. composition — nothing may graze a frame edge
 * ------------------------------------------------------------------ */

console.log('\n=== 5. composition ===');
for (const mode of ['chase', 'orbit']) {
  await enter(mode);
  await page.waitForTimeout(2500); // let the framing filters settle
  const v = await view();
  const inFrame = v.ndc && v.ndc.x0 > -0.94 && v.ndc.x1 < 0.94;
  check(
    `${mode} / ship clear of both frame edges`,
    !!inFrame,
    v.ndc ? `ndc x ${v.ndc.x0}..${v.ndc.x1} (need inside -0.94..0.94), d ${v.camDistance} m` : 'no geometry',
  );
  if (mode === 'chase') {
    const centre = v.ndc ? (v.ndc.x0 + v.ndc.x1) / 2 : 0;
    check(
      'chase / ship is off the centreline',
      Math.abs(centre) > 0.1,
      `ndc centre ${centre.toFixed(3)} (need |x| > 0.10)`,
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
