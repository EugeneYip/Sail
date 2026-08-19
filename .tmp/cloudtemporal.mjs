#!/usr/bin/env node
/**
 * Is the cloud temporal filter actually converging?
 *
 * Reads the resolved half-res cloud buffer and measures high-frequency energy
 * (deviation from a 3x3 mean) plus the frame-to-frame delta, at several temporal
 * alphas. If HF energy is the same at alpha 0.05 and alpha 1.0, the accumulation
 * is doing nothing and the raw march dither is what we are seeing on screen.
 *
 *   node .tmp/cloudtemporal.mjs noon
 */
import { chromium } from 'playwright';
import process from 'node:process';

const SCENES = {
  noon: { timeOfDay: 12.7, windSpeed: 10.5, cloudCover: 0.38, cloudType: 0.8, turbidity: 2.0, rain: 0, visibility: 34000, seaState: 4, waveHeight: 2.0 },
  golden: { timeOfDay: 18.6, windSpeed: 7.0, cloudCover: 0.5, cloudType: 0.75, turbidity: 3.6, rain: 0, visibility: 26000, seaState: 3, waveHeight: 1.5 },
  storm: { timeOfDay: 15.0, windSpeed: 22.0, cloudCover: 0.98, cloudType: 0.95, turbidity: 6.0, rain: 0.85, visibility: 5200, seaState: 7, waveHeight: 6.5 },
};
const scene = process.argv[2] ?? 'noon';

const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--hide-scrollbars', '--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.setDefaultTimeout(240000);
page.setDefaultNavigationTimeout(240000);
await page.addInitScript(() => { const R = window.WebSocket; class D extends EventTarget { constructor() { super(); this.readyState = 3; } send() {} close() {} } window.WebSocket = function (u, p) { return p === 'vite-hmr' ? new D() : new R(u, p); }; });
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__leeward, null, { timeout: 120000 });
await page.evaluate((env) => {
  const w = window.__leeward.world;
  Object.assign(w.settings, { quality: 'ultra', adaptiveResolution: false, renderScale: 1, debug: true });
  Object.assign(w.env, env);
  w.bus.emit('settings:changed');
}, SCENES[scene] ?? SCENES.noon);
await page.waitForTimeout(9000);

const out = await page.evaluate(async () => {
  const w = window.__leeward.world;
  const gl = w.renderer.getContext();
  const props = w.renderer.properties;
  const sky = window.__skyDbg;
  const clouds = sky?.clouds;
  if (!clouds) return { err: 'no __skyDbg.clouds' };

  const h2f = (h) => {
    const s = (h & 0x8000) >> 15, e = (h & 0x7c00) >> 10, f = h & 0x03ff;
    if (e === 0) return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
    if (e === 0x1f) return NaN;
    return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
  };
  const fb = gl.createFramebuffer();
  const W = Math.floor(w.size.width / 2), H = Math.floor(w.size.height / 2);
  const read = (tex) => {
    const p = props.get(tex);
    if (!p?.__webglTexture) return null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, p.__webglTexture, 0);
    const buf = new Uint16Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.HALF_FLOAT, buf);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const g = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) g[i] = h2f(buf[i * 4 + 1]);   // green channel of cloud radiance
    return g;
  };
  // HF energy: |x - mean3x3(x)| over texels where there IS cloud, normalised.
  const hf = (g) => {
    let s = 0, m = 0, n = 0;
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (g[i] < 1e-3) continue;
      let mean = 0;
      for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) mean += g[i + j * W + k];
      mean /= 9;
      s += Math.abs(g[i] - mean); m += g[i]; n++;
    }
    return { hfRel: n ? +(s / Math.max(1e-9, m)).toPrecision(3) : null, coverFrac: +(n / (W * H)).toPrecision(3), meanRad: n ? +(m / n).toPrecision(3) : null };
  };
  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  const results = {};
  for (const alpha of [0.09, 0.03, 1.0]) {
    clouds.resolvePass.uniforms.uAlpha.value = alpha;
    for (let i = 0; i < 40; i++) await frame();      // let it converge
    const a = read(clouds.texture);
    await frame();
    const b = read(clouds.texture);
    let d = 0, mm = 0, nn = 0;
    for (let i = 0; i < a.length; i++) { if (a[i] < 1e-3) continue; d += Math.abs(a[i] - b[i]); mm += a[i]; nn++; }
    results[`alpha=${alpha}`] = { ...hf(a), frameDeltaRel: nn ? +(d / Math.max(1e-9, mm)).toPrecision(3) : null };
  }
  clouds.resolvePass.uniforms.uAlpha.value = 0.09;
  gl.deleteFramebuffer(fb);

  const u = clouds.marchPass.uniforms;
  return {
    results,
    steps: u.uSteps.value,
    shafts: u.uShafts.value,
    reset: clouds.reset,
    coverage: u.uCoverage.value,
    layer: [u.uLayerBottom.value, u.uLayerTop.value],
    densityScale: u.uDensityScale.value,
    cirrus: u.uCirrusAmount.value,
    stats: Object.fromEntries(Object.entries(w.stats).filter(([k]) => /cloud|sky:/.test(k)).map(([k, v]) => [k, +Number(v).toPrecision(4)])),
  };
});

console.log(`scene=${scene}`);
console.log(JSON.stringify(out, null, 1));
await browser.close();
