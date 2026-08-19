#!/usr/bin/env node
/**
 * Term balance in the surface shader: is the sky probe reaching us, how does the
 * body radiance compare with the reflected sky, and does the wave field ever
 * fold enough to make foam.
 */
import { chromium } from 'playwright';

const SCENES = {
  noon: { timeOfDay: 12.7, windSpeed: 10.5, cloudCover: 0.38, cloudType: 0.8, turbidity: 2, rain: 0, visibility: 34000, seaState: 4, waveHeight: 2, choppiness: 0.6 },
  golden: { timeOfDay: 18.6, windSpeed: 8, cloudCover: 0.45, cloudType: 0.6, turbidity: 3, rain: 0, visibility: 26000, seaState: 3, waveHeight: 1.5, choppiness: 0.55 },
  storm: { timeOfDay: 15, windSpeed: 22, cloudCover: 0.98, cloudType: 1, turbidity: 6, rain: 0.9, visibility: 5200, seaState: 7, waveHeight: 6.5, choppiness: 0.85 },
};

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--hide-scrollbars', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.addInitScript(() => {
  const R = window.WebSocket;
  class D extends EventTarget { constructor() { super(); this.readyState = 3; } send() {} close() {} }
  window.WebSocket = function (u, p) { return p === 'vite-hmr' ? new D() : new R(u, p); };
});
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded', timeout: 240000 });
await page.waitForFunction(() => !!window.__leeward, null, { timeout: 240000 });

for (const [name, env] of Object.entries(SCENES)) {
  await page.evaluate((e) => {
    const w = window.__leeward.world;
    Object.assign(w.settings, { quality: 'ultra', adaptiveResolution: false, renderScale: 1, debug: true });
    Object.assign(w.env, e);
    Object.assign(w.cam, { mode: 'chase', distance: 74 });
    w.bus.emit('settings:changed');
    w.bus.emit('capture:scene', {});
  }, env);
  await page.waitForTimeout(8000);

  const out = await page.evaluate(() => {
    const w = window.__leeward.world;
    const oc = w.ocean;
    const mu = oc.material.uniforms;
    const u = w.uniforms;
    const L = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    const arr = (v) => v.isColor ? [v.r, v.g, v.b] : [v.x, v.y, v.z];

    const sky = arr(u.uSkyColor.value);
    const fog = arr(u.uFogColor.value);
    const sunC = arr(u.uSunColor.value);
    const sunI = u.uSunIntensity.value;
    const sunY = Math.max(u.uSunDirection.value.y, 0);
    const DEEP = [0.0011, 0.0165, 0.0520];
    const INV_PI = 1 / Math.PI;
    // Same expression the shader evaluates, at N.y = 1 (flat facet).
    const Ed = sky.map((s, i) => s + sunC[i] * sunI * INV_PI * sunY);
    const body = DEEP.map((a, i) => a * Ed[i]);

    // Jacobian fold statistics: foam needs fold < 0.78 on the GPU.
    const cp = w.camera.position;
    const s = { height: 0, dx: 0, dz: 0, normal: new (Object.getPrototypeOf(cp).constructor)(), velocity: new (Object.getPrototypeOf(cp).constructor)() };
    let below = 0, n = 0, minFold = 9;
    const hist = {};
    for (let j = 0; j < 120; j++) for (let i = 0; i < 120; i++) {
      const f = 1 + (oc.cpu.foamAtRaw ? 0 : 0); // placeholder
      oc.cpu.gather(cp.x + (i / 120 - 0.5) * 500, cp.z + (j / 120 - 0.5) * 500);
      const fold = 1 + oc.cpu.acc[3];
      minFold = Math.min(minFold, fold);
      if (fold < 0.78) below++;
      const b = (Math.floor(fold * 10) / 10).toFixed(1);
      hist[b] = (hist[b] ?? 0) + 1;
      n++;
    }
    return {
      probe: { uHasEnv: mu.uHasEnv.value, envMapPresent: !!(w.ext.sky && w.ext.sky.envMap),
        aerialLUT: !!(w.ext.sky && w.ext.sky.aerialLUT), hasReflection: mu.uHasReflection.value,
        wakeStrength: mu.uWakeStrength.value, hasWakeTex: !!(w.ext.vfx && w.ext.vfx.wakeTexture) },
      radiance: {
        'body (deep water)': body.map((x) => +x.toPrecision(3)),
        'body luminance': +L(body).toPrecision(3),
        'reflected sky @horizon (uFogColor)': +L(fog).toPrecision(3),
        'reflected sky @zenith (uSkyColor)': +L(sky).toPrecision(3),
        'ratio horizonSky : body': Math.round(L(fog) / Math.max(L(body), 1e-9)),
        'fres@2% x horizonSky vs body': +(0.02 * L(fog) / Math.max(L(body), 1e-9)).toPrecision(3),
      },
      fold: { 'min fold': +minFold.toFixed(3), 'fraction below 0.78 (foam threshold)': +(below / n).toFixed(4), 'uFoamAmount': +mu.uFoamAmount.value.toFixed(3), histogram: hist },
    };
  });
  console.log(`\n============ ${name} ============`);
  console.log('sky/vfx handshake:', out.probe);
  console.log('radiance balance:', out.radiance);
  console.log('fold:', out.fold);
}
await browser.close();
