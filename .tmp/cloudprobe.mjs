#!/usr/bin/env node
/**
 * Cloud field probe. Reads the actual GPU textures back with raw WebGL so the
 * question "are there clouds" is answered by numbers, not by squinting at a PNG.
 *
 *   node .tmp/cloudprobe.mjs noon
 *   node .tmp/cloudprobe.mjs storm
 */
import { chromium } from 'playwright';
import process from 'node:process';

const W = 1600, H = 900;
const SCENES = {
  dawn: { timeOfDay: 5.9, windSpeed: 3.2, cloudCover: 0.3, cloudType: 0.45, turbidity: 3.4, rain: 0, visibility: 30000, seaState: 2, waveHeight: 0.6, choppiness: 0.35 },
  noon: { timeOfDay: 12.7, windSpeed: 10.5, cloudCover: 0.38, cloudType: 0.8, turbidity: 2.0, rain: 0, visibility: 34000, seaState: 4, waveHeight: 2.0, choppiness: 0.6 },
  golden: { timeOfDay: 18.6, windSpeed: 7.0, cloudCover: 0.5, cloudType: 0.75, turbidity: 3.6, rain: 0, visibility: 26000, seaState: 3, waveHeight: 1.5, choppiness: 0.5 },
  storm: { timeOfDay: 15.0, windSpeed: 22.0, cloudCover: 0.98, cloudType: 0.95, turbidity: 6.0, rain: 0.85, visibility: 5200, seaState: 7, waveHeight: 6.5, choppiness: 0.85 },
  fog: { timeOfDay: 7.4, windSpeed: 2.4, cloudCover: 0.85, cloudType: 0.2, turbidity: 8.0, rain: 0, visibility: 1400, seaState: 1, waveHeight: 0.4, choppiness: 0.3 },
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
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 160)); });
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message.slice(0, 200)));
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__leeward, null, { timeout: 60000 });

await page.evaluate((env) => {
  const w = window.__leeward.world;
  w.settings.quality = 'ultra';
  w.settings.adaptiveResolution = false;
  w.settings.renderScale = 1;
  w.settings.debug = true;
  Object.assign(w.env, env);
  w.bus.emit('settings:changed');
  w.bus.emit('capture:scene', {});
}, SCENES[scene] ?? SCENES.noon);

await page.waitForTimeout(9000);

const out = await page.evaluate(() => {
  const w = window.__leeward.world;
  const gl = w.renderer.getContext();
  const props = w.renderer.properties;

  function h2f(h) {
    const s = (h & 0x8000) >> 15, e = (h & 0x7c00) >> 10, f = h & 0x03ff;
    if (e === 0) return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
    if (e === 0x1f) return f ? NaN : (s ? -1 : 1) * Infinity;
    return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
  }

  const fb = gl.createFramebuffer();
  function readTex(tex, wpx, hpx) {
    const p = props.get(tex);
    if (!p || !p.__webglTexture) return { err: 'no gl texture' };
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, p.__webglTexture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return { err: 'fbo incomplete' };
    }
    const fmt = gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_FORMAT);
    const type = gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_TYPE);
    const comps = fmt === gl.RGBA ? 4 : fmt === gl.RGB ? 3 : fmt === gl.RG ? 2 : 1;
    const n = wpx * hpx * comps;
    let buf, dec;
    if (type === gl.UNSIGNED_BYTE) { buf = new Uint8Array(n); dec = (v) => v / 255; }
    else if (type === gl.HALF_FLOAT) { buf = new Uint16Array(n); dec = h2f; }
    else if (type === gl.FLOAT) { buf = new Float32Array(n); dec = (v) => v; }
    else { gl.bindFramebuffer(gl.FRAMEBUFFER, null); return { err: 'type 0x' + type.toString(16) }; }
    gl.readPixels(0, 0, wpx, hpx, fmt, type, buf);
    const e = gl.getError();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (e) return { err: 'gl error 0x' + e.toString(16) };
    const stats = [];
    for (let c = 0; c < comps; c++) {
      let mn = 1e30, mx = -1e30, sum = 0, nz = 0;
      const vals = new Float64Array(wpx * hpx);
      for (let i = 0; i < wpx * hpx; i++) {
        const v = dec(buf[i * comps + c]);
        vals[i] = v;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
        sum += v;
        if (v > 0.01) nz++;
      }
      vals.sort();
      const q = [];
      for (let k = 1; k <= 9; k++) q.push(+vals[Math.floor((vals.length - 1) * k * 0.1)].toPrecision(3));
      stats.push({ min: +mn.toPrecision(3), max: +mx.toPrecision(3), mean: +(sum / (wpx * hpx)).toPrecision(3), frac: +(nz / (wpx * hpx)).toPrecision(3), deciles: q });
    }
    return { comps, stats };
  }

  const sky = w.scene.getObjectByName('sky');
  const u = sky.material.uniforms;
  const res = {
    defines: Object.keys(sky.material.defines ?? {}),
    programOk: !!sky.material.program,
    uCoverage: u.uCoverage?.value,
    uCloudType: u.uCloudType?.value,
    uErosion: u.uErosion?.value,
    uDensityScale: u.uDensityScale?.value,
    uCirrusAmount: u.uCirrusAmount?.value,
    uLayer: [u.uLayerBottom?.value, u.uLayerTop?.value],
    cloudLightIrr: u.uCloudLightIrradiance?.value?.toArray?.().map((v) => +v.toPrecision(3)),
    cloudAmbTop: u.uCloudAmbientTop?.value?.toArray?.().map((v) => +v.toPrecision(3)),
    cloudAmbBot: u.uCloudAmbientBottom?.value?.toArray?.().map((v) => +v.toPrecision(3)),
    cloudShadowStrength: w.ext.sky?.cloudShadowStrength,
    stats: Object.fromEntries(Object.entries(w.stats).filter(([k]) => /cloud/i.test(k)).map(([k, v]) => [k, +Number(v).toPrecision(4)])),
    exposure: +Number(w.uniforms.uExposure.value).toPrecision(4),
  };

  const weather = u.tWeather?.value;
  res.weather = weather ? readTex(weather, 512, 512) : 'null';
  const clouds = u.tClouds?.value;
  res.cloudsTexName = clouds?.name;
  res.cloudBuf = clouds ? readTex(clouds, Math.floor(w.size.width / 2), Math.floor(w.size.height / 2)) : 'null';
  const shadow = w.ext.sky?.cloudShadowMap;
  res.shadowName = shadow?.name;
  res.shadow = shadow ? readTex(shadow, 512, 512) : 'null';
  gl.deleteFramebuffer(fb);
  return res;
});

console.log(`scene=${scene}`);
console.log(JSON.stringify(out, null, 1));
if (errs.length) console.log('\nconsole errors (first 8):\n' + errs.slice(0, 8).join('\n'));
await browser.close();
