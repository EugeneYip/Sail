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
 *
 * Exit codes — this doubles as a smoke test:
 *   0  clean
 *   1  the page threw, WebGL failed, or the engine never booted
 *   2  bad arguments
 *   3  a scene was timed while rival renderers were on the GPU, so the
 *      frame-period numbers are not trustworthy. Add --allow-contention if you
 *      only wanted the PNGs (screenshots are fine under load; timings are not),
 *      or --wait-quiet <seconds> to sit and wait for a genuine quiet window.
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
 * Headless Chromium caps rAF at 60 Hz, so 16.6 ms is the FLOOR of anything this
 * harness can observe, not a performance target that was met.
 */
const VSYNC_MS = 1000 / 60;

/**
 * Tokens (`--user-data-dir=...`, unique per Playwright launch) belonging to our
 * own browser tree. Learned on first sight via the ppid chain and remembered, so
 * that a reparented child of ours is never miscounted as somebody else's.
 * Over-reporting would be as damaging as under-reporting: a gate that cries wolf
 * gets ignored, and then we are back to trusting contended numbers.
 */
const ownProfileTokens = new Set();

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
 *
 * Returns `{ procs, browsers }`, or `{ procs: -1 }` when `ps` could not be read
 * — never 0 on failure, because "I could not look" must not read as "quiet".
 * Both numbers are reported because one browser is ~5 processes (main, gpu,
 * renderer, network, audio), so a raw process count of 5 means ONE rival agent.
 */
function competingRenderers() {
  try {
    const out = execFileSync('ps', ['-Ao', 'pid=,ppid=,command='], { encoding: 'utf8' });
    const rows = [];
    for (const line of out.split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (m) rows.push({ pid: +m[1], ppid: +m[2], cmd: m[3] });
    }
    // byPid spans EVERY process, not just the browsers, so the walk can climb
    // through the intermediate node/shell links up to this process.
    const byPid = new Map(rows.map((r) => [r.pid, r]));
    const profileOf = (r) => /--user-data-dir=(\S+)/.exec(r.cmd)?.[1];
    const descendsFromUs = (r) => {
      let cur = r;
      for (let hops = 0; cur && hops < 64; hops++) {
        if (cur.pid === process.pid) return true;
        cur = byPid.get(cur.ppid);
      }
      return false;
    };
    // Playwright's chromium under either name (`chrome-headless-shell` is what
    // it actually runs on this box — matching only /Chromium/ missed it), plus
    // anything explicitly launched --headless. Keying on the ms-playwright cache
    // path as well as the flag also catches an agent that launched
    // headless:false, which contends for the GPU exactly the same, while still
    // ignoring the owner's everyday Chrome and Claude's Electron.
    const isRenderer = (r) =>
      /chrome-headless|ms-playwright|Chromium/i.test(r.cmd) || /--headless(=\S+)?(\s|$)/.test(r.cmd);

    const renderers = rows.filter(isRenderer);
    for (const r of renderers) {
      if (!descendsFromUs(r)) continue;
      const tok = profileOf(r);
      if (tok) ownProfileTokens.add(tok);
    }
    const isMine = (r) => descendsFromUs(r) || ownProfileTokens.has(profileOf(r) ?? '\0');

    const rivals = renderers.filter((r) => !isMine(r));
    // A tree root is a rival whose parent is not itself a rival: one per agent.
    const rivalPids = new Set(rivals.map((r) => r.pid));
    return { procs: rivals.length, browsers: rivals.filter((r) => !rivalPids.has(r.ppid)).length };
  } catch {
    return { procs: -1, browsers: -1 }; // unknown; do not claim the box is quiet
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
    waitQuiet: 0,
    allowContention: false,
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
    if (key === 'allow-contention') {
      out.allowContention = true;
      continue;
    }
    if (next === undefined || next.startsWith('--')) continue;
    i++;
    if (key === 'wait-quiet') out.waitQuiet = Number(next);
    else if (['w', 'h', 'settle', 'timeout', 'dpr'].includes(key)) out[key] = Number(next);
    else if (key === 'adaptive') { out.adaptive = true; i -= 1; }
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
  /*
   * A scene with NO CLOUD, for A/B-ing anything that touches shadow.
   *
   * Every other scene runs cloudCover 0.3-0.5, and the cloud field advects with
   * wall-clock time, so two captures minutes apart are two different cloud
   * fields falling on the same sails. That confound has invalidated two shadow
   * measurements: on identical code, this project measured a deep-shadow share
   * of 22.1 / 28.7 / 27.0 percent over the hull across three runs -- a 6.6-point
   * spread, larger than either change being tested.
   *
   * cloudCover 0 removes the moving occluder; the sun is high enough to throw
   * the rig's shadow across the sails rather than off the ship entirely, and
   * turbidity is low so the shadow's fill comes from a clean sky.
   */
  shadow: {
    label: 'No cloud — shadow A/B without a moving occluder',
    env: { timeOfDay: 14.2, windSpeed: 8.0, cloudCover: 0, cloudType: 0.7, turbidity: 1.9, rain: 0, visibility: 44000, seaState: 3, waveHeight: 1.3, choppiness: 0.5 },
    cam: { mode: 'orbit', distance: 104 },
  },
  // Direction 3's content is invisible to a scene that never asks for it: the
  // populations appear on a Poisson process with means of minutes, so a plain
  // scene will usually show empty sea. `showcase` forces one of each near enough
  // to read.
  wildlife: {
    label: 'Marine life, vessels and Boston — everything near',
    env: { timeOfDay: 9.4, windSpeed: 8.0, cloudCover: 0.38, cloudType: 0.7, turbidity: 2.4, rain: 0, visibility: 40000, seaState: 3, waveHeight: 1.4, choppiness: 0.5 },
    cam: { mode: 'chase', distance: 86 },
    showcase: 'near',
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
/**
 * Errors that are the headless environment's, not the game's. Failing a run on
 * these makes the exit code meaningless: a real GLSL error and "this box has no
 * sound card" would be indistinguishable, and the audio one fires intermittently.
 */
const ENVIRONMENT_NOISE = [
  /AudioContext encountered an error from the audio device/i,
  /The AudioContext was not allowed to start/i,
];
const isEnvironmentNoise = (s) => ENVIRONMENT_NOISE.some((re) => re.test(s));
const noted = [];

page.on('pageerror', (e) => {
  const s = `pageerror: ${e.message}\n${e.stack ?? ''}`;
  (isEnvironmentNoise(s) ? noted : errors).push(s);
});
page.on('console', (m) => {
  const text = `${m.type()}: ${m.text()}`;
  logs.push(text);
  if (m.type() === 'error') (isEnvironmentNoise(text) ? noted : errors).push(text);
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
  await page.screenshot({ path: shot, timeout: 120000 });
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
/** Scenes whose timings were taken with rivals present (or unverifiable). */
const tainted = [];

/**
 * Sit out the competition, if asked. Opt-in via `--wait-quiet <seconds>`: the
 * default of 0 preserves the old behaviour of measuring now and flagging it.
 *
 * Waiting here rather than at boot is deliberate — the page is already loaded
 * and converging, so when a quiet window does appear we spend it measuring
 * instead of booting.
 */
async function waitForQuiet(label) {
  if (!(args.waitQuiet > 0)) return;
  const deadline = Date.now() + args.waitQuiet * 1000;
  let announced = false;
  for (;;) {
    const r = competingRenderers();
    if (r.procs === 0) {
      if (announced) console.log(`[capture] ${label}: quiet — measuring now`);
      return;
    }
    if (Date.now() >= deadline) {
      console.log(
        `[capture] ${label}: no quiet window in ${args.waitQuiet}s ` +
          `(${r.procs < 0 ? 'contention unknown' : `${r.procs} rival proc(s)`}) — ` +
          'measuring anyway, flagged below',
      );
      return;
    }
    if (!announced) {
      console.log(
        `[capture] ${label}: waiting up to ${args.waitQuiet}s for a quiet GPU ` +
          `(${r.procs < 0 ? '?' : r.procs} rival proc(s) now)...`,
      );
      announced = true;
    }
    await page.waitForTimeout(2000);
  }
}

for (const name of sceneNames) {
  const scene = SCENES[name];

  await page.evaluate(
    ({ scene, quality, adaptive }) => {
      const eng = window.__leeward;
      const w = eng.world;
      if (quality && w.settings.quality !== quality) {
        w.settings.quality = quality;
      }
      /*
       * Deterministic capture: pin resolution, no adaptive drift.
       *
       * `--adaptive` opts out, and it exists because this default hid the
       * owner's stutter for the entire project. The backing store is
       * `min(devicePixelRatio, maxPixelRatio) * renderScale * cssSize`, and
       * `--dpr` defaults to 1 — so every measurement taken here has been
       * 1600x900 = 1.44 Mpx, while a Retina panel at the same window size is
       * 3200x1800 = 5.76 Mpx. Four times the pixels, with the adaptive
       * controller that exists to handle it switched off. Neither half of the
       * owner's actual condition was ever in the measurement.
       *
       * Pinning is still the right default for A/B work: an adaptive controller
       * changes the pixel count mid-run, which makes two runs incomparable. Use
       * `--dpr 2 --adaptive` to reproduce what a player on a Retina panel gets.
       */
      w.settings.adaptiveResolution = adaptive;
      if (!adaptive) w.settings.renderScale = 1;
      w.settings.showHud = true;
      Object.assign(w.env, scene.env ?? {});
      Object.assign(w.cam, scene.cam ?? {});
      w.bus.emit('settings:changed');
      if (scene.focusIsland) w.bus.emit('capture:focusIsland');
      if (scene.showcase) w.bus.emit('world:showcase', scene.showcase);
      w.bus.emit('capture:scene', scene);
    },
    { scene, quality: args.quality, adaptive: !!args.adaptive },
  );

  /*
   * Assert the frame is the render and nothing else.
   *
   * `UiLayer.enterCaptureMode()` already dismisses the title card, the tutorial
   * and the panels when it sees `capture:scene`, so this is not a fix -- it is a
   * tripwire. An agent reported that this harness shoots through the title card;
   * it does not, and measuring said so (centre luminance differed by 0.7%, i.e.
   * noise, and the crop shows open sea where the display type would be). But the
   * failure it imagined would have been expensive and silent: `.intro` lays a
   * radial scrim at rgba(shade, 0.5) over the CENTRE of frame, so every tonal,
   * contrast and exposure judgment taken from these PNGs would have been made
   * through a half-strength dark vignette that also inverts the natural one.
   *
   * That is worth one cheap check per scene rather than trusting a hook in
   * another module to keep working.
   */
  const overlay = await page.evaluate(() => {
    for (const sel of ['.intro', '.firstrun', '.panel.open', '.photo.on']) {
      const n = document.querySelector(sel);
      if (!n) continue;
      const cs = getComputedStyle(n);
      if (cs.display !== 'none' && Number(cs.opacity) > 0.01) {
        return `${sel} (display=${cs.display} opacity=${cs.opacity})`;
      }
    }
    return null;
  });
  if (overlay) {
    console.error(`SCENE ${name}: a UI overlay is still up -- ${overlay}. Every frame`
      + ' from here would be shot through it. Refusing to capture.');
    await browser.close();
    process.exit(1);
  }

  await waitForQuiet(name);

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
  const stats = await page.evaluate((VSYNC) => {
    const w = window.__leeward.world;
    const P = (window.__periods ?? []).slice(10).sort((a, b) => a - b);
    cancelAnimationFrame(window.__periodRaf);
    const pct = (q) => (P.length ? +P[Math.min(P.length - 1, Math.floor(P.length * q))].toFixed(1) : 0);
    return {
      p25: pct(0.25),
      p50: pct(0.5),
      p95: pct(0.95),
      // min and the 1-vsync share are the two statistics contention cannot
      // fake, because a rival can only ADD time to a frame. They are what
      // disproved the "3x regression" of §29: an engine that genuinely costs
      // 50 ms/frame cannot also produce a 6 ms frame, or land 7% of its frames
      // on the very next vsync. Read them as a one-sided bound on the real cost.
      min: P.length ? +P[0].toFixed(1) : 0,
      // Period quantised to whole vsync intervals, counting those that took
      // exactly one — i.e. everything under 25 ms (1.5 intervals). Same rule
      // that produced the figures in DIAGNOSIS §31, kept identical so the
      // numbers stay comparable across sessions.
      vsync1: P.length
        ? +((P.filter((v) => Math.round(v / VSYNC) <= 1).length / P.length) * 100).toFixed(0)
        : 0,
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
  }, VSYNC_MS);

  const file = sceneNames.length > 1 ? `${args.out}-${name}.png` : `${args.out}.png`;
  // 30s (playwright's default) aborts outright when other renderers
  // are competing for the GPU. Wait instead of losing the whole run.
  await page.screenshot({ path: stage(file), animations: 'allow', timeout: 120000 });

  // Sampled at BOTH ends of the window, and the worse end wins: rivals spin up
  // *during* a run, which is precisely how §29 recorded "load 1.9 at start" and
  // still measured 50 ms.
  const unknown = rivalsBefore.procs < 0 || rivalsAfter.procs < 0;
  const procs = Math.max(rivalsBefore.procs, rivalsAfter.procs);
  const browsers = Math.max(rivalsBefore.browsers, rivalsAfter.browsers);
  // Unknown counts as tainted. "I could not check" is not "the box was quiet".
  const dirty = unknown || procs > 0;
  if (dirty) tainted.push({ name, procs, browsers, unknown });

  results.push({
    name, label: scene.label, file,
    fps: lastFps ? Math.round(lastFps) : stats.fps,
    ...stats,
    rivalProcs: unknown ? -1 : procs,
    rivalBrowsers: unknown ? -1 : browsers,
  });

  // Headless Chromium caps rAF at 60 Hz, so 16.6 ms IS the floor here and a
  // p25 at the cap means "as fast as this harness can observe", not "exactly 60".
  const capped = stats.p25 > 0 && stats.p25 <= 17.2;
  // The marker rides directly on p25/p50 so the warning cannot be separated from
  // the number when someone copies one line of this output into a doc.
  const mark = dirty ? '!' : ' ';
  const verdict = unknown ? 'CONTENTION-UNKNOWN' : procs > 0 ? 'CONTENDED' : 'quiet';
  const rivalStr = unknown ? '?' : `${procs}p/${browsers}b`;
  // Fixed decimals, not String(number) — 55 and 55.8 must not misalign a column
  // that people read down looking for outliers.
  const ms = (v, pad = 5) => v.toFixed(1).padStart(pad);
  console.log(
    `[capture] ${name.padEnd(10)} ` +
      `p25 ${mark}${ms(stats.p25)}ms${capped ? '*' : ' '} ` +
      `p50 ${mark}${ms(stats.p50)}ms  ` +
      `p95 ${ms(stats.p95, 6)}ms  ` +
      `min ${ms(stats.min)}ms  ` +
      `1vsync ${String(stats.vsync1).padStart(3)}%  ` +
      `rivals ${rivalStr.padEnd(6)} ${verdict.padEnd(18)} ` +
      `${String(stats.drawCalls).padStart(3)}dc  ` +
      `${(stats.triangles / 1e6).toFixed(2)}Mtri  -> ${file}`,
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
console.log('rivals Np/Nb = N competing renderer processes / N distinct rival browsers,');
console.log('  sampled before AND after each window; one rival browser is ~5 processes.');
console.log('* p25 at the 16.6 ms rAF cap — the harness cannot observe faster than 60 Hz.');
console.log('1vsync = share of frames landing on the next vsync. Contention can only ADD');
console.log('  time, so a high 1vsync share under load still proves the engine is fast.');
console.log('Trust p25/p50 (engine cost). p95 and any mean are dominated by machine load.');

// The banner is printed BEFORE the page-error check, unconditionally. Ordering it
// after cost nothing until a routine console error (the headless AudioContext
// warning, say) exited first and swallowed the contention warning entirely —
// leaving flagged p25/p50 numbers on screen with nothing to explain them.
if (tainted.length) {
  const worst = tainted.reduce((a, b) => (a.procs >= b.procs ? a : b));
  console.error(
    '\n' + '='.repeat(78) + '\n' +
      '!! GPU CONTENTION — THE FRAME TIMES ABOVE ARE NOT A MEASUREMENT OF THIS ENGINE\n' +
      '='.repeat(78) + '\n' +
      `   Tainted scene(s): ${tainted.map((t) => t.name).join(', ')}\n` +
      `   Worst seen: ${worst.unknown ? 'unknown (ps unreadable)' : `${worst.procs} rival process(es) / ${worst.browsers} rival browser(s)`}\n` +
      '\n' +
      '   Load average CANNOT see this: it is a CPU run-queue metric and the GPU is\n' +
      '   invisible to it. DIAGNOSIS §29 recorded "load 1.9 at start", measured 50 ms,\n' +
      '   and reported a 3x regression that a full bisect proved did not exist.\n' +
      '   A contended number is worse than no number, because it reads as authoritative.\n' +
      '\n' +
      '   The min and 1vsync columns are still meaningful — contention only adds time,\n' +
      '   so they bound the real cost from below. p25/p50/p95 here are unusable.\n' +
      '\n' +
      '   Re-run with --wait-quiet 600 to measure inside a genuine quiet window, or\n' +
      '   --allow-contention if you only wanted the PNGs (screenshots are unaffected).\n' +
      '   To watch the competition directly:\n' +
      "     ps -Ao command= | grep -c '[c]hrome-headless'\n" +
      '='.repeat(78),
  );
  if (args.allowContention) {
    console.error('(--allow-contention given: not failing the run. Do not quote the timings.)');
  } else {
    // Don't promise exit 3 when a page error below will claim exit 1 instead.
    const code = errors.length ? '1 (the page error below takes precedence)' : '3';
    console.error(
      `\nFAILING, exit ${code}: ${tainted.length} of ${results.length} ` +
        'scene(s) timed under contention.\n' +
        'The PNGs were written and are valid; only the timings are refused.',
    );
  }
}

// A page error is the more actionable failure, so it claims the exit code — but
// only after the contention banner above has had its say.
if (noted.length) {
  console.log(`\n${noted.length} environment message(s) ignored (headless audio etc.), not treated as failures.`);
}
if (errors.length) {
  console.error(`\n${errors.length} PAGE ERROR(S):`);
  for (const e of errors.slice(0, 25)) console.error('  ' + e);
  process.exit(1);
}
if (tainted.length && !args.allowContention) process.exit(3);

console.log('\nOK — ' + results.length + ' shot(s)');
