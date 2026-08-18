#!/usr/bin/env node
/**
 * Cloud GPU budget. A/B: full serialising per-pass profile with volumetric
 * clouds on and off, plus the sky module's own finish()-bracketed cloud timers.
 *
 *   node .tmp/cloudcost.mjs noon
 */
import { chromium } from 'playwright';
import process from 'node:process';

const W = 1600, H = 900;
const SCENES = {
  noon: { timeOfDay: 12.7, windSpeed: 10.5, cloudCover: 0.38, cloudType: 0.8, turbidity: 2.0, rain: 0, visibility: 34000, seaState: 4, waveHeight: 2.0, choppiness: 0.6 },
  storm: { timeOfDay: 15.0, windSpeed: 22.0, cloudCover: 0.98, cloudType: 0.95, turbidity: 6.0, rain: 0.85, visibility: 5200, seaState: 7, waveHeight: 6.5, choppiness: 0.85 },
  golden: { timeOfDay: 18.6, windSpeed: 7.0, cloudCover: 0.5, cloudType: 0.75, turbidity: 3.6, rain: 0, visibility: 26000, seaState: 3, waveHeight: 1.5, choppiness: 0.5 },
};
const scene = process.argv[2] ?? 'noon';

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--force-color-profile=srgb', '--hide-scrollbars', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: W, height: H } });
await page.addInitScript(() => {
  const Real = window.WebSocket;
  class Dead extends EventTarget { constructor() { super(); this.readyState = 3; } send() {} close() {} }
  window.WebSocket = function (u, p) { return p === 'vite-hmr' ? new Dead() : new Real(u, p); };
});
const warn = new Map();
page.on('console', (m) => {
  const t = m.text();
  if (/READ-usage buffer/.test(t)) warn.set('fence', (warn.get('fence') ?? 0) + 1);
  else if (m.type() === 'error') warn.set(t.slice(0, 90), (warn.get(t.slice(0, 90)) ?? 0) + 1);
});
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__leeward, null, { timeout: 60000 });

async function run(clouds) {
  await page.evaluate(([env, on]) => {
    const w = window.__leeward.world;
    w.settings.quality = 'ultra';
    w.settings.adaptiveResolution = false;
    w.settings.renderScale = 1;
    w.settings.debug = true;
    w.settings.volumetricClouds = on;
    w.settings.cloudSteps = 48;
    Object.assign(w.env, env);
    w.bus.emit('settings:changed');
    w.bus.emit('capture:scene', {});
  }, [SCENES[scene] ?? SCENES.noon, clouds]);
  await page.waitForTimeout(9000);
  return page.evaluate(async () => {
    const w = window.__leeward.world;
    const prof = await w.ext.post.profile(120);
    const f = (v) => +Number(v).toPrecision(4);
    let total = 0;
    for (const v of Object.values(prof)) total += v;
    return {
      passes: Object.fromEntries(Object.entries(prof).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, f(v)])),
      total: f(total),
      sky: Object.fromEntries(Object.entries(w.stats).filter(([k]) => k.startsWith('sky:')).map(([k, v]) => [k, f(v)])),
      fog: {
        uFogColor: w.uniforms.uFogColor.value.toArray().map((v) => f(v)),
        uFogDensity: f(w.uniforms.uFogDensity.value),
        uSkyColor: w.uniforms.uSkyColor.value.toArray().map((v) => f(v)),
        uSunIntensity: f(w.uniforms.uSunIntensity.value),
        skyLuminance: f(w.ext.sky.skyLuminance),
        cloudShadowStrength: f(w.ext.sky.cloudShadowStrength),
        uExposure: f(w.uniforms.uExposure.value),
      },
    };
  });
}

const on = await run(true);
const off = await run(false);
console.log(`scene=${scene}  1600x900 ultra, serialising profile\n`);
console.log('-- clouds ON, per pass ms --');
console.log(on.passes);
console.log('sky:', on.sky);
console.log('\n-- clouds OFF, per pass ms --');
console.log(off.passes);
console.log('sky:', off.sky);
console.log(`\nGPU total  ON ${on.total} ms   OFF ${off.total} ms   => clouds cost ${(on.total - off.total).toFixed(3)} ms`);
console.log('\nradiometry ON :', on.fog);
console.log('radiometry OFF:', off.fog);
console.log('\nconsole tallies:', Object.fromEntries(warn));
await browser.close();
