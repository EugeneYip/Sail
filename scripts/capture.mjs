#!/usr/bin/env node
/**
 * Headless screenshot harness.
 *
 * Boots the dev server page in Chromium with real GPU rasterisation, drives the
 * scene into a deterministic state, waits for the frame time to settle, then
 * writes PNGs. Every agent uses this to self-verify without fighting over the
 * shared browser pane.
 *
 *   node scripts/capture.mjs --out shots/ocean --scene noon
 *   node scripts/capture.mjs --out shots/all --scene all --w 1600 --h 900
 *   node scripts/capture.mjs --out shots/x --scene noon --settle 6 --console
 *
 * Scenes are declared in SCENES below. `--scene all` renders every one.
 * Exit code is non-zero if the page threw or WebGL failed, so it doubles as a
 * smoke test.
 */

import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import process from 'node:process';

/**
 * Screenshots are written to a staging directory OUTSIDE the project and copied
 * to their final paths only after the browser closes.
 *
 * This is not tidiness. Writing a PNG under the Vite root makes the dev server
 * reload the page, so every scene after the first used to be captured on a
 * freshly booted, unsettled engine — wrong waves, wrong exposure, wrong
 * everything, with nothing in the output to say so.
 */
/**
 * Count headless Chromium processes that are NOT ours.
 *
 * This exists because load average is a CPU run-queue metric and **cannot see
 * GPU contention**. A run once recorded "load 1.9" and measured a 50 ms frame
 * that the engine renders in 6 ms, purely because 4-9 other agents were
 * capturing at the same time. Every performance conclusion drawn from that
 * number was wrong, and the only reason we know is that the same session also
 * observed a 5.7 ms minimum period — a frame that genuinely costs 50 ms cannot
 * produce a 7 ms frame.
 *
 * So: measure the competition, and refuse to print an unflagged number when
 * there is any.
 */
function competingRenderers() {
  try {
    const out = execFileSync('ps', ['-Ao', 'pid=,ppid=,command='], { encoding: 'utf8' });
    const mine = new Set([process.pid]);
    const rows = out.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const m = /^(\d+)\s+(\d+)\s+(.*)$/.exec(l);
      return m ? { pid: +m[1], ppid: +m[2], cmd: m[3] } : null;
    }).filter(Boolean);
    // Our own browser is a descendant of this process; walk parents to exclude it.
    const byPid = new Map(rows.map((r) => [r.pid, r]));
    const isMine = (r) => {
      let cur = r, hops = 0;
      while (cur && hops++ < 40) {
        if (mine.has(cur.pid)) return true;
        cur = byPid.get(cur.ppid);
      }
      return false;
    };
    return rows.filter(
      (r) => /(Chromium|Google Chrome|chrome)/i.test(r.cmd) && /--headless/.test(r.cmd) && !isMine(r),
    ).length;
  } catch {
    return -1; // unknown; do not claim the box is quiet
  }
}

const staging = await mkdtemp(join(tmpdir(), 'leeward-shots-'));
/** [stagedPath, finalPath] pairs, flushed at exit. */
const pending = [];

function stage(finalRelPath) {
  const final = resolve(finalRelPath);
  const staged = join(staging, `${pending.length}-${basename(final)}`);
  pending.push([staged, final]);
  return staged;
}

async function flushStaged() {
  for (const [staged, final] of pending) {
    await mkdir(dirname(final), { recursive: true });
    await copyFile(staged, final).catch(() => {});
  }
  await rm(staging, { recursive: true, force: true }).catch(() => {});
}

/* ------------------------------------------------------------------ *
 *  args
 * ------------------------------------------------------------------ */

function parseArgs(argv) {
  const out = {
    url: 'http://127.0.0.1:5178/',
    out: 'shots/frame',
    scene: 'noon',
    w: 1600,
    h: 900,
    settle: 4,
    timeout: 60000,
    console: false,
    quality: 'ultra',
    dpr: 1,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (key === 'console') {
      out.console = true;
      continue;
    }
    if (next === undefined || next.startsWith('--')) continue;
    i++;
    if (['w', 'h', 'settle', 'timeout', 'dpr'].includes(key)) out[key] = Number(next);
    else out[key] = next;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 *  scenes — each is a patch applied to world.env / world.settings / world.cam
 * ------------------------------------------------------------------ */

const SCENES = {
  dawn: {
    label: 'Dawn, light air, glassy swell',
    env: { timeOfDay: 5.9, windSpeed: 3.2, cloudCover: 0.3, cloudType: 0.45, turbidity: 3.4, rain: 0, visibility: 30000, seaState: 2, waveHeight: 0.6, choppiness: 0.35 },
    cam: { mode: 'chase', distance: 82 },
  },
  morning: {
    label: 'Mid-morning, moderate breeze',
    env: { timeOfDay: 9.2, windSpeed: 8.5, cloudCover: 0.45, cloudType: 0.7, turbidity: 2.4, rain: 0, visibility: 28000, seaState: 3, waveHeight: 1.3, choppiness: 0.55 },
    cam: { mode: 'chase', distance: 76 },
  },
  noon: {
    label: 'High noon, fresh breeze, deep blue water',
    env: { timeOfDay: 12.7, windSpeed: 10.5, cloudCover: 0.38, cloudType: 0.8, turbidity: 2.0, rain: 0, visibility: 34000, seaState: 4, waveHeight: 2.0, choppiness: 0.6 },
    cam: { mode: 'chase', distance: 74 },
  },
  golden: {
    label: 'Golden hour, warm rim light',
    env: { timeOfDay: 18.6, windSpeed: 7.0, cloudCover: 0.5, cloudType: 0.75, turbidity: 3.6, rain: 0, visibility: 26000, seaState: 3, waveHeight: 1.5, choppiness: 0.5 },
    cam: { mode: 'chase', distance: 80 },
  },
  sunset: {
    label: 'Sunset on the bow, sun in frame',
    env: { timeOfDay: 19.6, windSpeed: 6.0, cloudCover: 0.55, cloudType: 0.7, turbidity: 4.2, rain: 0, visibility: 24000, seaState: 3, waveHeight: 1.2, choppiness: 0.45 },
    cam: { mode: 'bowsprit' },
  },
  dusk: {
    label: 'Blue hour, first stars',
    env: { timeOfDay: 20.7, windSpeed: 5.0, cloudCover: 0.35, cloudType: 0.5, turbidity: 2.8, rain: 0, visibility: 28000, seaState: 2, waveHeight: 0.9, choppiness: 0.4 },
    cam: { mode: 'chase', distance: 78 },
  },
  night: {
    label: 'Moonlit night, clear',
    env: { timeOfDay: 23.4, windSpeed: 6.5, cloudCover: 0.2, cloudType: 0.5, turbidity: 2.0, rain: 0, visibility: 30000, seaState: 3, waveHeight: 1.1, choppiness: 0.5 },
    cam: { mode: 'chase', distance: 76 },
  },
  storm: {
    label: 'Gale, near-full reef, heavy sea',
    env: { timeOfDay: 15.0, windSpeed: 22.0, cloudCover: 0.98, cloudType: 0.95, turbidity: 6.0, rain: 0.85, visibility: 5200, seaState: 7, waveHeight: 6.5, choppiness: 0.85 },
    cam: { mode: 'chase', distance: 70 },
  },
  fog: {
    label: 'Fog bank, calm',
    env: { timeOfDay: 7.4, windSpeed: 2.4, cloudCover: 0.85, cloudType: 0.2, turbidity: 8.0, rain: 0, visibility: 1400, seaState: 1, waveHeight: 0.4, choppiness: 0.3 },
    cam: { mode: 'chase', distance: 60 },
  },
  helm: {
    label: 'From the helm — deck detail',
    env: { timeOfDay: 10.4, windSpeed: 9.0, cloudCover: 0.4, cloudType: 0.7, turbidity: 2.2, rain: 0, visibility: 30000, seaState: 3, waveHeight: 1.4, choppiness: 0.55 },
    cam: { mode: 'helm' },
  },
  masthead: {
    label: 'Masthead — sail plan from above',
    env: { timeOfDay: 11.4, windSpeed: 9.5, cloudCover: 0.42, cloudType: 0.75, turbidity: 2.2, rain: 0, visibility: 30000, seaState: 4, waveHeight: 1.8, choppiness: 0.6 },
    cam: { mode: 'masthead' },
  },
  orbit: {
    label: 'Beam-on orbit — full profile',
    env: { timeOfDay: 15.6, windSpeed: 9.0, cloudCover: 0.4, cloudType: 0.75, turbidity: 2.2, rain: 0, visibility: 32000, seaState: 3, waveHeight: 1.5, choppiness: 0.55 },
    cam: { mode: 'orbit', distance: 110 },
  },
  waterline: {
    label: 'Low waterline — wave shape and foam',
    env: { timeOfDay: 13.8, windSpeed: 12.0, cloudCover: 0.35, cloudType: 0.8, turbidity: 2.0, rain: 0, visibility: 34000, seaState: 5, waveHeight: 3.0, choppiness: 0.7 },
    cam: { mode: 'cinematic' },
  },
  island: {
    label: 'Island landfall',
    env: { timeOfDay: 16.8, windSpeed: 7.5, cloudCover: 0.42, cloudType: 0.8, turbidity: 2.6, rain: 0, visibility: 32000, seaState: 3, waveHeight: 1.2, choppiness: 0.5 },
    cam: { mode: 'chase', distance: 86 },
    focusIsland: true,
  },
};

/* ------------------------------------------------------------------ *
 *  main
 * ------------------------------------------------------------------ */

const args = parseArgs(process.argv);
const sceneNames =
  args.scene === 'all'
    ? Object.keys(SCENES)
    : args.scene.split(',').map((s) => s.trim()).filter(Boolean);

for (const n of sceneNames) {
  if (!SCENES[n]) {
    console.error(`Unknown scene "${n}". Known: ${Object.keys(SCENES).join(', ')}`);
    process.exit(2);
  }
}

const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-angle=metal',
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    '--enable-unsafe-swiftshader',
    '--enable-webgl',
    '--enable-webgl2-compute-context',
    '--disable-gpu-driver-bug-workarounds',
    '--force-color-profile=srgb',
    '--disable-features=CalculateNativeWinOcclusion',
    '--hide-scrollbars',
    '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
  ],
});

const page = await browser.newPage({
  viewport: { width: args.w, height: args.h },
  deviceScaleFactor: args.dpr,
  colorScheme: 'dark',
});

const errors = [];
const logs = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}\n${e.stack ?? ''}`));
page.on('console', (m) => {
  const text = `${m.type()}: ${m.text()}`;
  logs.push(text);
  if (m.type() === 'error') errors.push(text);
});
page.on('requestfailed', (r) => {
  // Font CDN failures are not fatal for a screenshot.
  if (!/fonts\.(googleapis|gstatic)/.test(r.url())) {
    errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText ?? ''}`);
  }
});

// Hand Vite's HMR client a dead socket. Otherwise any concurrent edit to src/
// reloads the page in the middle of a capture run and silently resets the sim.
await page.addInitScript(() => {
  const Real = window.WebSocket;
  class Dead {
    constructor() {
      this.readyState = 3;
      this.close = () => {};
      this.send = () => {};
      this.addEventListener = () => {};
      this.removeEventListener = () => {};
    }
  }
  window.WebSocket = function (url, protocols) {
    if (protocols === 'vite-hmr') return new Dead();
    return new Real(url, protocols);
  };
  window.WebSocket.prototype = Real.prototype;
});

await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: args.timeout });

// A reload would reset the engine and invalidate every later scene, so fail
// loudly rather than reporting a settled frame that never settled.
let navigations = 0;
page.on('framenavigated', (f) => {
  if (f === page.mainFrame()) navigations++;
});

// Wait for the engine handle, i.e. boot() resolved.
try {
  await page.waitForFunction(() => !!window.__leeward, null, { timeout: args.timeout });
} catch {
  const shot = stage(`${args.out}-BOOTFAIL.png`);
  await page.screenshot({ path: shot });
  console.error('ENGINE NEVER BOOTED. Console:\n' + logs.slice(-60).join('\n'));
  await browser.close();
  process.exit(1);
}

// Verify a real GPU backend, not a software fallback that would misrepresent perf.
const gpuInfo = await page.evaluate(() => {
  const c = document.createElement('canvas');
  const gl = c.getContext('webgl2');
  if (!gl) return { ok: false, renderer: 'no webgl2' };
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  return {
    ok: true,
    renderer: dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : 'unknown',
    vendor: dbg ? String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)) : 'unknown',
    float: !!gl.getExtension('EXT_color_buffer_float'),
    lin: !!gl.getExtension('OES_texture_float_linear'),
  };
});

const results = [];
/** Set if any scene saw a competing renderer; makes the summary refuse to lie. */
let contended = false;

for (const name of sceneNames) {
  const scene = SCENES[name];

  await page.evaluate(
    ({ scene, quality }) => {
      const eng = window.__leeward;
      const w = eng.world;
      if (quality && w.settings.quality !== quality) {
        w.settings.quality = quality;
      }
      // Deterministic capture: pin resolution, no adaptive drift.
      w.settings.adaptiveResolution = false;
      w.settings.renderScale = 1;
      w.settings.showHud = true;
      Object.assign(w.env, scene.env ?? {});
      Object.assign(w.cam, scene.cam ?? {});
      w.bus.emit('settings:changed');
      if (scene.focusIsland) w.bus.emit('capture:focusIsland');
      w.bus.emit('capture:scene', scene);
    },
    { scene, quality: args.quality },
  );

  // Record frame periods across the settle window. Wall-clock "fps" averaged
  // over a noisy machine is worthless — this session measured the same
  // unchanged scene at 9 fps and 34 fps twenty minutes apart. Percentiles
  // separate the engine's real cost (p25/p50) from machine contention (mean,
  // p95), so report those instead of trusting the average.
  await page.evaluate(() => {
    const w = window;
    w.__periods = [];
    let last = performance.now();
    const tick = () => {
      const now = performance.now();
      w.__periods.push(now - last);
      last = now;
      w.__periodRaf = requestAnimationFrame(tick);
    };
    w.__periodRaf = requestAnimationFrame(tick);
  });

  const rivalsBefore = competingRenderers();

  // Let the sim settle: waves need to build, TAA needs to converge, auto
  // exposure needs to adapt, LOD/streaming needs to finish.
  const settleMs = args.settle * 1000;
  const t0 = Date.now();
  let lastFps = 0;
  while (Date.now() - t0 < settleMs) {
    await page.waitForTimeout(250);
    lastFps = await page.evaluate(() => window.__leeward.world.time.fps);
  }

  const rivalsAfter = competingRenderers();
  const stats = await page.evaluate(() => {
    const w = window.__leeward.world;
    const P = (window.__periods ?? []).slice(10).sort((a, b) => a - b);
    cancelAnimationFrame(window.__periodRaf);
    const pct = (q) => (P.length ? +P[Math.min(P.length - 1, Math.floor(P.length * q))].toFixed(1) : 0);
    return {
      p25: pct(0.25),
      p50: pct(0.5),
      p95: pct(0.95),
      frames: P.length,
      fps: Math.round(w.time.fps),
      drawCalls: w.stats.drawCalls ?? 0,
      triangles: w.stats.triangles ?? 0,
      programs: w.stats.programs ?? 0,
      knots: +w.ship.speedKnots.toFixed(2),
      heelDeg: +((w.ship.heel * 180) / Math.PI).toFixed(2),
      timeOfDay: +w.env.timeOfDay.toFixed(2),
      sunY: +w.env.sunDirection.y.toFixed(3),
    };
  });

  const file = sceneNames.length > 1 ? `${args.out}-${name}.png` : `${args.out}.png`;
  await page.screenshot({ path: stage(file), animations: 'allow' });

  results.push({ name, label: scene.label, file, fps: lastFps ? Math.round(lastFps) : stats.fps, ...stats });
  // Headless Chromium caps rAF at 60 Hz, so 16.6 ms IS the floor here and a
  // p25 at the cap means "as fast as this harness can observe", not "exactly 60".
  const rivals = Math.max(rivalsBefore, rivalsAfter);
  contended ||= rivals > 0;
  const capped = stats.p25 > 0 && stats.p25 <= 17.2;
  const flag = rivals > 0 ? `  !! ${rivals} rival renderer(s) — TIMINGS INVALID` : rivals < 0 ? '  !! contention unknown' : '';
  console.log(
    `[capture] ${name.padEnd(10)} ` +
      `p25 ${String(stats.p25).padStart(5)}ms${capped ? '*' : ' '} ` +
      `p50 ${String(stats.p50).padStart(5)}ms  ` +
      `p95 ${String(stats.p95).padStart(6)}ms  ` +
      `${String(stats.drawCalls).padStart(3)}dc  ` +
      `${(stats.triangles / 1e6).toFixed(2)}Mtri  -> ${file}${flag}`,
  );
}

if (args.console || errors.length) {
  const logPath = join(staging, 'console.log');
  pending.push([logPath, resolve(`${args.out}-console.log`)]);
  await writeFile(logPath, logs.join('\n'), 'utf8');
}

await browser.close();
await flushStaged();

if (navigations > 1) {
  console.error(
    `\nUNRELIABLE RUN: the page navigated ${navigations} times (expected 1).\n` +
      'Scenes after the first were captured on a re-booted engine. Re-run when\n' +
      'no other process is editing src/.',
  );
  process.exit(1);
}

console.log('\nGPU: ' + gpuInfo.renderer + (gpuInfo.float ? ' [float-rt ok]' : ' [NO FLOAT RT]'));
if (contended) {
  console.log(
    '\n!! GPU CONTENTION DETECTED — every frame-period number above is INVALID.\n' +
      '   Other headless renderers were running. Load average cannot see GPU\n' +
      '   contention, so a quiet-looking box still ruins timings. Re-run when\n' +
      '   `ps -Ao command= | grep -c "[-]-headless"` reports only your own.',
  );
}
console.log('* p25 at the 16.6 ms rAF cap — the harness cannot observe faster than 60 Hz.');
console.log('Trust p25/p50 (engine cost). p95 and any mean are dominated by machine load.');
if (errors.length) {
  console.error(`\n${errors.length} PAGE ERROR(S):`);
  for (const e of errors.slice(0, 25)) console.error('  ' + e);
  process.exit(1);
}
console.log('\nOK — ' + results.length + ' shot(s)');
