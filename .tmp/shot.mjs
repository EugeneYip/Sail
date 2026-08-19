#!/usr/bin/env node
/**
 * Robust capture + radiometry probe for the radiometry agent.
 *
 *   node .tmp/shot.mjs --out shots/rad --scene dawn,noon --settle 6
 *
 * Differs from scripts/capture.mjs only in being resilient: canvas.toDataURL
 * inside a post-engine rAF instead of page.screenshot (which was timing out),
 * plus HDR pixel statistics read straight off the post stack's scene target.
 */
import { chromium } from 'playwright';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

const SCENES = {
  dawn: { env: { timeOfDay: 5.9, windSpeed: 3.2, cloudCover: 0.3, cloudType: 0.45, turbidity: 3.4, rain: 0, visibility: 30000, seaState: 2, waveHeight: 0.6, choppiness: 0.35 }, cam: { mode: 'chase', distance: 82 } },
  morning: { env: { timeOfDay: 9.2, windSpeed: 8.5, cloudCover: 0.45, cloudType: 0.7, turbidity: 2.4, rain: 0, visibility: 28000, seaState: 3, waveHeight: 1.3, choppiness: 0.55 }, cam: { mode: 'chase', distance: 76 } },
  noon: { env: { timeOfDay: 12.7, windSpeed: 10.5, cloudCover: 0.38, cloudType: 0.8, turbidity: 2.0, rain: 0, visibility: 34000, seaState: 4, waveHeight: 2.0, choppiness: 0.6 }, cam: { mode: 'chase', distance: 74 } },
  golden: { env: { timeOfDay: 18.6, windSpeed: 7.0, cloudCover: 0.5, cloudType: 0.75, turbidity: 3.6, rain: 0, visibility: 26000, seaState: 3, waveHeight: 1.5, choppiness: 0.5 }, cam: { mode: 'chase', distance: 80 } },
  sunset: { env: { timeOfDay: 19.6, windSpeed: 6.0, cloudCover: 0.55, cloudType: 0.7, turbidity: 4.2, rain: 0, visibility: 24000, seaState: 3, waveHeight: 1.2, choppiness: 0.45 }, cam: { mode: 'bowsprit' } },
  dusk: { env: { timeOfDay: 20.7, windSpeed: 5.0, cloudCover: 0.35, cloudType: 0.5, turbidity: 2.8, rain: 0, visibility: 28000, seaState: 2, waveHeight: 0.9, choppiness: 0.4 }, cam: { mode: 'chase', distance: 78 } },
  night: { env: { timeOfDay: 23.4, windSpeed: 6.5, cloudCover: 0.2, cloudType: 0.5, turbidity: 2.0, rain: 0, visibility: 30000, seaState: 3, waveHeight: 1.1, choppiness: 0.5 }, cam: { mode: 'chase', distance: 76 } },
  storm: { env: { timeOfDay: 15.0, windSpeed: 22.0, cloudCover: 0.98, cloudType: 0.95, turbidity: 6.0, rain: 0.85, visibility: 5200, seaState: 7, waveHeight: 6.5, choppiness: 0.85 }, cam: { mode: 'chase', distance: 70 } },
  fog: { env: { timeOfDay: 7.4, windSpeed: 2.4, cloudCover: 0.85, cloudType: 0.2, turbidity: 8.0, rain: 0, visibility: 1400, seaState: 1, waveHeight: 0.4, choppiness: 0.3 }, cam: { mode: 'chase', distance: 60 } },
};

const args = { url: 'http://127.0.0.1:5178/', out: 'shots/rad', scene: 'noon', w: 1600, h: 900, settle: 6, quality: 'ultra', hud: '1' };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const k = a.slice(2);
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith('--')) continue;
  i++;
  args[k] = ['w', 'h', 'settle'].includes(k) ? Number(v) : v;
}
const names = args.scene === 'all' ? Object.keys(SCENES) : args.scene.split(',').map((s) => s.trim());

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--force-color-profile=srgb', '--hide-scrollbars', '--mute-audio', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: args.w, height: args.h }, deviceScaleFactor: 1, colorScheme: 'dark' });
page.setDefaultTimeout(240000);
page.setDefaultNavigationTimeout(240000);
const logs = [];
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  const t = `${m.type()}: ${m.text()}`;
  logs.push(t);
  if (m.type() === 'error') errors.push(t);
});
// Neutralise Vite HMR. Any file written anywhere under the project root — a
// concurrent agent editing src/physics, or this script writing a PNG into
// shots/ — makes the dev server issue a full page reload, which resets the
// engine mid-capture and silently produces unsettled frames.
let navigations = 0;
page.on('framenavigated', (f) => {
  if (f === page.mainFrame()) navigations++;
});
// Vite's HMR client is `new WebSocket(url, 'vite-hmr')`; hand it a dead socket
// and it can never tell the page to reload. Stubbing /@vite/client instead
// breaks the module graph, so do it at the socket.
await page.addInitScript(() => {
  const Real = window.WebSocket;
  class Dead extends EventTarget {
    constructor() {
      super();
      this.readyState = 3;
    }
    send() {}
    close() {}
  }
  window.WebSocket = function (url, protocols) {
    if (protocols === 'vite-hmr') return new Dead();
    return new Real(url, protocols);
  };
});
await page.goto(args.url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__leeward, null, { timeout: 60000 });
await page.evaluate((on) => { window.__hdrProbe = on === '1'; }, args.hdr ?? '0');

const STAGE = `${process.env.TMPDIR ?? '/tmp'}leeward-shots`;
await mkdir(STAGE, { recursive: true });
const pending = [];
const out = [];
for (const name of names) {
  const scene = SCENES[name];
  await page.evaluate(({ scene, quality, hud }) => {
    const w = window.__leeward.world;
    w.settings.quality = quality;
    w.settings.adaptiveResolution = false;
    w.settings.renderScale = 1;
    w.settings.showHud = hud === '1';
    Object.assign(w.env, scene.env ?? {});
    Object.assign(w.cam, scene.cam ?? {});
    w.bus.emit('settings:changed');
    w.bus.emit('capture:scene', scene);
  }, { scene, quality: args.quality, hud: args.hud });

  await page.waitForTimeout(args.settle * 1000);

  // fps FIRST: toDataURL and readRenderTargetPixels both stall the pipeline and
  // poison the 0.25 s rolling average.
  const perf = await page.evaluate(() => {
    const w = window.__leeward.world;
    return { fps0: Math.round(w.time.fps), frame0: w.time.frame, ms0: performance.now() };
  });
  await page.waitForTimeout(2000);
  const perf2 = await page.evaluate(() => {
    const w = window.__leeward.world;
    return { fps1: Math.round(w.time.fps), frame1: w.time.frame, ms1: performance.now() };
  });
  const trueFps = +(((perf2.frame1 - perf.frame0) * 1000) / (perf2.ms1 - perf.ms0)).toFixed(1);

  const data = await page.evaluate(() => new Promise((res) => {
    requestAnimationFrame(() => {
      const c = document.getElementById('viewport');
      res(c.toDataURL('image/png'));
    });
  }));
  // NOTE: writing inside the Vite project root makes the dev server issue a
  // full page reload, which destroys the engine mid-run. Stage everything in a
  // scratch dir outside the watched tree and copy in after the browser closes.
  const file = resolve(names.length > 1 ? `${args.out}-${name}.png` : `${args.out}.png`);
  const staged = `${STAGE}/${name}.png`;
  await writeFile(staged, Buffer.from(data.split(',')[1], 'base64'));
  pending.push([staged, file]);

  const probe = await page.evaluate(() => {
    const w = window.__leeward.world;
    const sky = w.ext.sky ?? {};
    const pipe = globalThis.__rcPipe;
    const r = w.renderer;
    const f = (v) => (typeof v === 'number' ? +v.toPrecision(4) : v);
    const arr = (v) => v?.toArray?.().map(f);
    const fpsNow = Math.round(w.time.fps);
    const statsNow = Object.fromEntries(
      Object.entries(w.stats).filter(([k]) => /^(gpu|sky|post|upd):/.test(k)).map(([k, v]) => [k, f(v)]),
    );

    // HDR statistics off the pre-exposure scene target. Opt-in: the readbacks
    // are synchronous and stall the pipeline hard.
    let hdr = null;
    try {
      if (!window.__hdrProbe) throw new Error('skipped');
      const t = pipe.targets.get('scene', w.size.width, w.size.height, 'rgba16f', { depth: true });
      // rgba16f reads back as Uint16 half floats; decode by hand.
      const h2f = (u) => {
        const s = (u & 0x8000) ? -1 : 1;
        const e = (u >> 10) & 0x1f;
        const m = u & 0x3ff;
        if (e === 0) return s * m * 5.9604644775390625e-8;
        if (e === 31) return m ? NaN : s * Infinity;
        return s * Math.pow(2, e - 15) * (1 + m / 1024);
      };
      const rect = (x, y, w2, h2) => {
        const raw = new Uint16Array(w2 * h2 * 4);
        r.readRenderTargetPixels(t, x, y, w2, h2, raw);
        const b = new Float32Array(w2 * h2 * 4);
        for (let i = 0; i < b.length; i++) b[i] = h2f(raw[i]);
        let lo = 1e9, hi = -1e9, sum = 0, n = 0, clipped = 0;
        const rgb = [0, 0, 0];
        for (let i = 0; i < w2 * h2; i++) {
          const l = 0.2126 * b[i * 4] + 0.7152 * b[i * 4 + 1] + 0.0722 * b[i * 4 + 2];
          if (!Number.isFinite(l)) continue;
          lo = Math.min(lo, l); hi = Math.max(hi, l); sum += l; n++;
          rgb[0] += b[i * 4]; rgb[1] += b[i * 4 + 1]; rgb[2] += b[i * 4 + 2];
          if (l * w.uniforms.uExposure.value > 1.0) clipped++;
        }
        return { min: f(lo), max: f(hi), mean: f(sum / Math.max(1, n)), rgb: rgb.map((v) => f(v / Math.max(1, n))), clipFrac: f(clipped / Math.max(1, n)) };
      };
      const H0 = w.size.height, W0 = w.size.width;
      hdr = {
        // readRenderTargetPixels y counts from the bottom of the target
        zenith: rect((W0 >> 1) - 32, Math.floor(H0 * 0.94), 64, 16),
        skyMid: rect((W0 >> 1) - 32, Math.floor(H0 * 0.78), 64, 16),
        aboveHorizon: rect((W0 >> 1) - 32, Math.floor(H0 * 0.66), 64, 12),
        seaFar: rect((W0 >> 1) - 32, Math.floor(H0 * 0.6), 64, 12),
        seaMid: rect((W0 >> 1) - 32, Math.floor(H0 * 0.35), 64, 16),
        seaNear: rect((W0 >> 1) - 32, 8, 64, 16),
        ship: rect((W0 >> 1) - 32, Math.floor(H0 * 0.22), 64, 24),
      };
    } catch (e) { hdr = { error: String(e) }; }

    return {
      fps: fpsNow,
      dc: w.stats.drawCalls, tris: w.stats.triangles, programs: w.stats.programs,
      uExposure: f(w.uniforms.uExposure.value),
      stops: f(w.stats['post:exposureStops']), meteredLog2: f(w.stats['post:sceneLog2Lum']),
      uSunIntensity: f(w.uniforms.uSunIntensity.value),
      uMoonIntensity: f(w.uniforms.uMoonIntensity.value),
      uSkyColor: arr(w.uniforms.uSkyColor.value),
      uGroundColor: arr(w.uniforms.uGroundColor.value),
      uFogColor: arr(w.uniforms.uFogColor.value),
      sunLuminance: f(sky.sunLuminance), skyLuminance: f(sky.skyLuminance),
      zenith: arr(sky.zenithColor), horizon: arr(sky.horizonColor),
      sh0: sky.irradianceSH ? [f(sky.irradianceSH[0]), f(sky.irradianceSH[1]), f(sky.irradianceSH[2])] : null,
      sunY: f(w.env.sunDirection.y),
      stats: statsNow,
      hdr,
    };
  });
  out.push({ name, file, trueFps, ...probe });
  console.log(
    `[${name}] fps=${trueFps} exp=${probe.uExposure} metered=${probe.meteredLog2} ` +
      `sun=${probe.uSunIntensity} moon=${probe.uMoonIntensity} skyLum=${probe.skyLuminance} sunY=${probe.sunY}`,
  );
}

await browser.close();

for (const [from, to] of pending) {
  await mkdir(dirname(to), { recursive: true });
  await copyFile(from, to);
}
await writeFile(resolve(`${args.out}-probe.json`), JSON.stringify(out, null, 2));
await writeFile(resolve(`${args.out}-console.log`), logs.join('\n'), 'utf8');
const uniq = new Map();
for (const e of errors) {
  const k = e.replace(/\d+/g, '#').slice(0, 160);
  uniq.set(k, (uniq.get(k) ?? 0) + 1);
}
console.log(`\nmain-frame navigations during run: ${navigations} (1 = clean)`);
console.log(`${errors.length} console error line(s), ${uniq.size} distinct:`);
for (const [k, n] of [...uniq.entries()].slice(0, 20)) console.log(`  x${n}  ${k}`);
