import { chromium } from 'playwright';
const b = await chromium.launch({ headless: true, args: ['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist','--hide-scrollbars','--mute-audio'] });
const page = await b.newPage({ viewport: { width: 1600, height: 900 } });
await page.addInitScript(() => { const R = window.WebSocket; class D extends EventTarget { constructor(){super();this.readyState=3;} send(){} close(){} } window.WebSocket = function(u,p){ return p==='vite-hmr'? new D(): new R(u,p); }; });
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__leeward, null, { timeout: 60000 });
await page.evaluate(() => { const w = window.__leeward.world;
  Object.assign(w.settings, { quality: 'ultra', adaptiveResolution: false, renderScale: 1, debug: true });
  Object.assign(w.env, { timeOfDay: 12.7, windSpeed: 10.5, cloudCover: 0.38, turbidity: 2, visibility: 34000, seaState: 4, waveHeight: 2 });
  Object.assign(w.cam, { mode: 'chase', distance: 74 });
  w.bus.emit('settings:changed'); w.bus.emit('capture:scene', {}); });
await page.waitForTimeout(11000);

const out = await page.evaluate(() => {
  const w = window.__leeward.world, r = w.renderer, gl = r.getContext();
  const p = globalThis.__rcPipe, t = p.targets, W = w.size.width, H = w.size.height;
  const scene = t.get('scene', W, H, 'rgba16f', { depth: true });
  const work0 = t.get('work0', W, H, 'rgba16f');
  const work1 = t.get('work1', W, H, 'rgba16f');
  // Best-of-K medians of N-iteration runs: robust against unrelated CPU stalls.
  const bench = (fn, n = 30, k = 5) => {
    const runs = [];
    for (let j = 0; j < k; j++) {
      fn(); gl.finish();
      const t0 = performance.now();
      for (let i = 0; i < n; i++) fn();
      gl.finish();
      runs.push((performance.now() - t0) / n);
    }
    runs.sort((a, b) => a - b);
    return +runs[0].toPrecision(3);
  };
  const res = {};
  res['scene pass (whole 3D scene)'] = bench(() => { r.setRenderTarget(scene); r.clear(true, true, true); r.render(w.scene, w.camera); }, 8, 5);
  p.prepare.uniforms.tScene.value = scene.texture;
  p.prepare.uniforms.uExposure.value = p.exposure.exposure;
  res['prepare (exposure+clamp)'] = bench(() => p.prepare.render(r, work0));
  res['depthCopy'] = bench(() => { p.depthCopy.uniforms.tDepth.value = scene.depthTexture; p.depthCopy.render(r, t.get('sceneDepth', W, H, 'r32f', { nearest: true })); });
  res['exposure 3 passes'] = bench(() => {
    const lum = t.get('expLum', 64, 64, 'r16f', { nearest: true });
    const par = t.get('expPartial', 64, 32, 'r16f', { nearest: true });
    const rr = t.get('expResult', 1, 1, 'rgba32f', { nearest: true });
    const e = p.exposure, lu = e.lumPass.uniforms;
    lu.tScene.value = scene.texture; lu.uSceneTexel.value.set(1 / W, 1 / H); lu.uFootprint.value.set(W / 64, H / 64);
    e.lumPass.render(r, lum);
    e.histPass.uniforms.tLum.value = lum.texture; e.histPass.render(r, par);
    e.resolvePass.uniforms.tPartial.value = par.texture; e.resolvePass.render(r, rr);
  });
  res['exposure readback (PBO+fence)'] = bench(() => {
    const rr = t.get('expResult', 1, 1, 'rgba32f', { nearest: true });
    p.exposure.readback(r, rr);
  });
  res['velocity'] = bench(() => p.velocity.render(r, t.get('velocity', W, H, 'rg16f', { nearest: true })));
  res['taa + rcas'] = bench(() => p.aa.render(r, w.settings, work0.texture, scene.depthTexture, t.get('velocity', W, H, 'rg16f', { nearest: true }).texture, work1, p.jitter.pixels, 1));
  res['dof (half-res gather)'] = bench(() => p.dof.render(r, w, work0.texture, scene.depthTexture, work1, 22));
  res['motionBlur'] = bench(() => p.motionBlur.render(r, work0.texture, t.get('velocity', W, H, 'rg16f', { nearest: true }).texture, scene.depthTexture, w.camera.near, w.camera.far, work1, 12, 0));
  res['bloom (6-level pyramid)'] = bench(() => p.bloom.render(r, work0.texture, 1.15));
  res['composite (AgX+LUT+grain)'] = bench(() => p.composite.render(r, null));
  r.setRenderTarget(null);
  return {
    passes: res,
    sky: Object.fromEntries(Object.entries(w.stats).filter(([k]) => /^sky:.*Ms$/.test(k)).map(([k, v]) => [k, +v.toPrecision(3)])),
    skyPasses: w.stats['sky:passes'],
    upd: Object.fromEntries(Object.entries(w.stats).filter(([k]) => k.startsWith('upd:')).map(([k, v]) => [k, +Number(v).toPrecision(3)])),
    dc: w.stats.drawCalls, tri: w.stats.triangles, prog: w.stats.programs,
    vram: +w.ext.post.vram().total.toFixed(1),
    exposure: +w.uniforms.uExposure.value.toPrecision(4),
  };
});
console.log('== per-pass GPU cost, 1600x900 ultra, best-of-5 medians (ms) ==');
for (const [k, v] of Object.entries(out.passes).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(32)} ${v}`);
console.log('\n== sky (serialising EMA, ms) =='); console.log(out.sky, 'sky:passes =', out.skyPasses);
console.log('\n== module update CPU (ms) =='); console.log(Object.entries(out.upd).sort((a, b) => b[1] - a[1]).slice(0, 8));
console.log(`\ndrawCalls=${out.dc} tris=${out.tri} programs=${out.prog} vram=${out.vram}MB exposure=${out.exposure}`);
await b.close();
