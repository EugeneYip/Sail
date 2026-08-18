import { chromium } from 'playwright';
const b = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--hide-scrollbars', '--mute-audio'] });
const page = await b.newPage({ viewport: { width: 1600, height: 900 } });
await page.addInitScript(() => { const R = window.WebSocket; class D extends EventTarget { constructor() { super(); this.readyState = 3; } send() {} close() {} } window.WebSocket = function (u, p) { return p === 'vite-hmr' ? new D() : new R(u, p); }; });
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__leeward, null, { timeout: 60000 });
await page.evaluate(() => {
  const w = window.__leeward.world;
  Object.assign(w.settings, { quality: 'ultra', adaptiveResolution: false, renderScale: 1, debug: true });
  Object.assign(w.env, { timeOfDay: 12.7, windSpeed: 10.5, seaState: 4, waveHeight: 2 });
  w.bus.emit('settings:changed');
});
await page.waitForTimeout(7000);
const out = await page.evaluate(async () => {
  const THREE = window.__leeward.THREE ?? (await import('/node_modules/three/build/three.module.js'));
  const w = window.__leeward.world, r = w.renderer, gl = r.getContext();
  const oc = w.ocean;
  const bench = (fn, n = 20, k = 5) => { const runs = []; for (let j = 0; j < k; j++) { fn(); const t0 = performance.now(); for (let i = 0; i < n; i++) fn(); runs.push((performance.now() - t0) / n); } runs.sort((a, b) => a - b); return +runs[0].toPrecision(3); };

  // Trivial material + tiny target: isolates three's per-render() CPU overhead.
  const tiny = new THREE.WebGLRenderTarget(4, 4, { depthBuffer: false, stencilBuffer: false });
  const trivialMat = new THREE.ShaderMaterial({
    vertexShader: 'void main(){ gl_Position = vec4(position.xy,0.0,1.0); }',
    fragmentShader: 'void main(){ gl_FragColor = vec4(1.0); }',
    depthTest: false, depthWrite: false,
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  const mesh = new THREE.Mesh(geo, trivialMat); mesh.frustumCulled = false;
  const sc = new THREE.Scene(); sc.add(mesh);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const res = {};
  res['112x renderer.render() trivial mat, 4x4 rt, save/restore rt'] = bench(() => {
    for (let i = 0; i < 112; i++) { const prev = r.getRenderTarget(); const ac = r.autoClear; r.autoClear = false; r.setRenderTarget(tiny); r.render(sc, cam); r.setRenderTarget(prev); r.autoClear = ac; }
  }, 6, 5);
  res['112x renderer.render() trivial, rt set ONCE'] = bench(() => {
    const prev = r.getRenderTarget(); const ac = r.autoClear; r.autoClear = false; r.setRenderTarget(tiny);
    for (let i = 0; i < 112; i++) r.render(sc, cam);
    r.setRenderTarget(prev); r.autoClear = ac;
  }, 6, 5);
  res['112x setRenderTarget only (no render)'] = bench(() => {
    const prev = r.getRenderTarget();
    for (let i = 0; i < 112; i++) { r.setRenderTarget(tiny); r.setRenderTarget(prev); }
  }, 6, 5);
  res['real ocean cascade submit (112 passes)'] = bench(() => { let t = 0; for (const c of oc.cascades) c.update(r, t += 0.0167); }, 8, 5);
  res['real, but only cascade 3 (N=256, 34 passes)'] = bench(() => { oc.cascades[3].update(r, Math.random()); }, 10, 5);
  res['real, but only cascade 0 (N=64, 26 passes)'] = bench(() => { oc.cascades[0].update(r, Math.random()); }, 10, 5);
  res['GPU-side: 112 real passes + gl.finish'] = bench(() => { let t = 0; for (const c of oc.cascades) c.update(r, t += 0.0167); gl.finish(); }, 8, 4);

  // Does GLSL3 + MRT compile and render here?
  let mrt = 'untested';
  try {
    const rt2 = new THREE.WebGLRenderTarget(8, 8, { count: 2, type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    const m2 = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: 'void main(){ gl_Position = vec4(position.xy,0.0,1.0); }',
      fragmentShader: 'precision highp float;\nlayout(location=0) out vec4 o0;\nlayout(location=1) out vec4 o1;\nvoid main(){ ivec2 p = ivec2(gl_FragCoord.xy); o0 = vec4(float(p.x),2.0,3.0,4.0); o1 = vec4(9.0,8.0,7.0,6.0); }',
      depthTest: false, depthWrite: false,
    });
    mesh.material = m2;
    r.setRenderTarget(rt2); r.render(sc, cam); r.setRenderTarget(null);
    const buf = new Float32Array(4);
    mrt = { drawBuffers: gl.getParameter(gl.MAX_DRAW_BUFFERS), textures: rt2.textures?.length ?? 0, compiled: !!m2.program || 'n/a' };
    rt2.dispose(); m2.dispose();
  } catch (e) { mrt = 'ERR ' + e.message; }
  mesh.material = trivialMat;

  // Does the existing FFT material use texelFetch under GLSL1? report its version.
  const fftMat = oc.cascades[0].fft.material;
  return { res, mrt, fftGlslVersion: fftMat.glslVersion ?? 'GLSL1(default)', isWebGL2: r.capabilities.isWebGL2 !== false, maxDrawBuffers: gl.getParameter(gl.MAX_DRAW_BUFFERS) };
});
console.log('=== pass-cost anatomy (ms per batch of 112 unless noted) ===');
for (const [k, v] of Object.entries(out.res).sort((a, b) => b[1] - a[1])) console.log('  ' + k.padEnd(52) + v);
console.log('\nMRT probe:', JSON.stringify(out.mrt));
console.log('fft material glslVersion:', out.fftGlslVersion, ' maxDrawBuffers:', out.maxDrawBuffers);
await b.close();
