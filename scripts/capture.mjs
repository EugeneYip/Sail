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
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

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

await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: args.timeout });

// Wait for the engine handle, i.e. boot() resolved.
try {
  await page.waitForFunction(() => !!window.__leeward, null, { timeout: args.timeout });
} catch {
  const shot = resolve(`${args.out}-BOOTFAIL.png`);
  await mkdir(dirname(shot), { recursive: true });
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

  // Let the sim settle: waves need to build, TAA needs to converge, auto
  // exposure needs to adapt, LOD/streaming needs to finish.
  const settleMs = args.settle * 1000;
  const t0 = Date.now();
  let lastFps = 0;
  while (Date.now() - t0 < settleMs) {
    await page.waitForTimeout(250);
    lastFps = await page.evaluate(() => window.__leeward.world.time.fps);
  }

  const stats = await page.evaluate(() => {
    const w = window.__leeward.world;
    return {
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
  const path = resolve(file);
  await mkdir(dirname(path), { recursive: true });
  await page.screenshot({ path, animations: 'allow' });

  results.push({ name, label: scene.label, file, fps: lastFps ? Math.round(lastFps) : stats.fps, ...stats });
  console.log(
    `[capture] ${name.padEnd(10)} ${String(stats.fps).padStart(3)}fps  ` +
      `${String(stats.drawCalls).padStart(4)}dc  ` +
      `${(stats.triangles / 1e6).toFixed(2)}Mtri  ` +
      `${stats.knots.toFixed(1)}kn  -> ${file}`,
  );
}

if (args.console || errors.length) {
  const logPath = resolve(`${args.out}-console.log`);
  await mkdir(dirname(logPath), { recursive: true });
  await writeFile(logPath, logs.join('\n'), 'utf8');
}

await browser.close();

console.log('\nGPU: ' + gpuInfo.renderer + (gpuInfo.float ? ' [float-rt ok]' : ' [NO FLOAT RT]'));
if (errors.length) {
  console.error(`\n${errors.length} PAGE ERROR(S):`);
  for (const e of errors.slice(0, 25)) console.error('  ' + e);
  process.exit(1);
}
console.log('\nOK — ' + results.length + ' shot(s)');
