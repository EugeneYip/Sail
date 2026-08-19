#!/usr/bin/env node
/**
 * BAND-FIX verifier. Successor to .tmp/flick.mjs, with three additions that the
 * earlier tool lacked and that a verification run needs:
 *
 *  1. Every shader ablation ASSERTS that its target string was present. A silent
 *     no-op replace is the classic way to "measure" a fix that never applied:
 *     the ablation and the baseline then render identical code and the numbers
 *     agree beautifully. Any MISS aborts the run.
 *  2. A full-frame per-pixel |luminance delta| map is written as a PNG per
 *     variant (amplified), so the flicker can be SEEN and localised, not just
 *     summarised per row.
 *  3. Mean luminance per distance band is reported alongside, because a "fix"
 *     that merely washes the sea to a flat grey also reduces every temporal
 *     statistic to zero.
 *
 * Everything except the ocean is frozen and the engine's clock is driven by
 * hand, so the camera cannot move. `frozen` additionally pins the ocean's own
 * sim time, which means the SAME wave phase is rendered every frame -- anything
 * that still changes is the renderer, not the sea.
 *
 *   node .tmp/bandverify.mjs <scene> <frames> <variant...>
 *
 * variants: base | oldref | flatgeo | frozen | nojit  (combine with '_')
 *   oldref  -- undo the landed macro-normal reflection fix (the BEFORE case)
 *   flatgeo -- flat plane geometry: the post-process/film-grain noise floor
 *   frozen  -- pin the ocean sim clock
 *   nojit   -- SMAA instead of TAA (removes the sub-pixel jitter)
 *
 * PNGs and JSON go OUTSIDE the Vite root: writing them under it reloads the page.
 */
import { chromium } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';

const scene = process.argv[2] ?? 'noon';
const FRAMES = Number(process.argv[3] ?? 10);
const variants = process.argv.slice(4);
if (!variants.length) variants.push('base');
const OUT = process.env.BV_OUT ?? '/tmp/bandverify';
await mkdir(OUT, { recursive: true });

const SCENES = {
  noon: { env: { timeOfDay: 12.7, windSpeed: 10.5, cloudCover: 0.38, cloudType: 0.8, turbidity: 2.0, rain: 0, visibility: 34000, seaState: 4, waveHeight: 2.0, choppiness: 0.6 }, cam: { mode: 'chase', distance: 74 } },
  golden: { env: { timeOfDay: 18.6, windSpeed: 7.0, cloudCover: 0.5, cloudType: 0.75, turbidity: 3.6, rain: 0, visibility: 26000, seaState: 3, waveHeight: 1.5, choppiness: 0.5 }, cam: { mode: 'chase', distance: 80 } },
  storm: { env: { timeOfDay: 15.0, windSpeed: 22.0, cloudCover: 0.98, cloudType: 0.95, turbidity: 6.0, rain: 0.85, visibility: 5200, seaState: 7, waveHeight: 6.5, choppiness: 0.85 }, cam: { mode: 'chase', distance: 70 } },
};

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader',
    '--force-color-profile=srgb', '--hide-scrollbars', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await page.addInitScript(() => {
  const Real = window.WebSocket;
  class Dead { constructor() { this.readyState = 3; this.close = () => {}; this.send = () => {}; this.addEventListener = () => {}; this.removeEventListener = () => {}; } }
  window.WebSocket = function (u, p) { return p === 'vite-hmr' ? new Dead() : new Real(u, p); };
  window.WebSocket.prototype = Real.prototype;
});
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded', timeout: 240000 });
await page.waitForFunction(() => !!window.__leeward, null, { timeout: 300000 });
await page.evaluate((s) => {
  const w = window.__leeward.world;
  w.settings.quality = 'ultra';
  w.settings.adaptiveResolution = false;
  w.settings.renderScale = 1;
  w.settings.showHud = false;
  Object.assign(w.env, s.env);
  Object.assign(w.cam, s.cam);
  w.bus.emit('settings:changed');
}, SCENES[scene]);
await page.waitForTimeout(10000);

await page.evaluate(() => {
  const eng = window.__leeward;
  const w = eng.world;
  const mats = () => {
    const s = new Set();
    w.scene.traverse((o) => { if (o.material && o.material.name === 'ocean-surface') s.add(o.material); });
    return [...s];
  };
  window.__mats = mats;
  window.__orig = { v: mats()[0].vertexShader, f: mats()[0].fragmentShader };

  for (const m of eng.modules) if (m.name !== 'ocean') m.update = () => {};
  const ocean = eng.modules.find((m) => m.name === 'ocean');
  window.__oceanUpdate = ocean.update;
  eng.stop();

  window.__apply = (kind) => {
    const parts = kind.split('_');
    const log = [];
    const rp = (src, a, b, tag) => {
      if (!src.includes(a)) { log.push(`MISS:${tag}`); return src; }
      log.push(`ok:${tag}`);
      return src.split(a).join(b);
    };
    const PIN = 400;
    if (parts.includes('frozen')) {
      ocean.update = function (world) { this.simTime = PIN - world.time.dt; window.__oceanUpdate.call(this, world); };
      log.push('ok:frozen');
    } else {
      ocean.update = window.__oceanUpdate;
    }
    w.settings.antialias = parts.includes('nojit') ? 'smaa' : 'taa';
    w.bus.emit('settings:changed');

    for (const m of window.__mats()) {
      let v = window.__orig.v;
      let f = window.__orig.f;
      if (parts.includes('flatgeo')) {
        v = rp(v, 'vec3 pos = vec3(world.x + disp.x, disp.y + skirtRise, world.y + disp.z);',
          'vec3 pos = vec3(world.x + disp.x, skirtRise, world.y + disp.z);', 'flatgeo');
        f = rp(f, 'if (isSkirt > 0.5) { slope = vec2(0.0); jac = vec3(0.0);',
          'if (true) { slope = vec2(0.0); jac = vec3(0.0);', 'flatgeo.frag');
      }
      const ani = parts.find((p) => /^tap[0-9]$/.test(p));
      if (ani) {
        // Diagnostic only: N-tap anisotropic footprint filter along the view's
        // major axis, to test whether the STATIC horizontal streaks are an
        // isotropic-LOD artefact. Costs N x the cascade fetches.
        f = rp(f, 'float pxWorld = max(dist * uPixelAngle, 1e-3);',
          'float pxWorld = max(dist * uPixelAngle, 1e-3);\n' +
          '  vec2 aniDir = normalize(vec2(-V.x, -V.z) + vec2(1e-6));\n' +
          '  float aniRatio = min(1.0 / max(abs(V.y), 1e-3), 64.0);\n' +
          '  float pxMajor = pxWorld * aniRatio;', 'aniprologue');
        const N = Number(ani.slice(3));
        const before = f;
        f = f.replace(/vec4 d0 = textureLod\(uDisp(\d+), uv, lod\);\s*\n\s*vec4 d1 = textureLod\(uDeriv(\d+), uv, lod\);/g,
          (_m, a) => `vec4 d0 = vec4(0.0); vec4 d1 = vec4(0.0);
    float lodA = max(0.0, log2(pxWorld * max(1.0, aniRatio / ${N}.0) * uCascadeTexels[${a}]));
    for (int t = 0; t < ${N}; t++) {
      vec2 o = aniDir * (pxMajor * ((float(t) + 0.5) / ${N}.0 - 0.5)) * uCascadeScale[${a}];
      d0 += textureLod(uDisp${a}, uv + o, lodA);
      d1 += textureLod(uDeriv${a}, uv + o, lodA);
    }
    d0 /= ${N}.0; d1 /= ${N}.0;`);
        log.push(f === before ? `MISS:${ani}` : `ok:${ani}`);
      }
      if (parts.includes('nofoam')) {
        // Attributes leftover NEAR-field flicker: the foam mask feeds both the
        // normal perturbation and the lobe width, and its buffer advances even
        // when the wave sim clock is pinned.
        f = rp(f, 'float foam = max(instant, persistent * inWindow);', 'float foam = 0.0;', 'nofoam');
      }
      if (parts.includes('softlift')) {
        // The grazing-ray lift 'R.y = abs(R.y)*0.55 + R.y*0.45' is a KINK: its
        // first derivative jumps where R.y crosses zero, which on a far, nearly
        // flat sea happens at one distance -- i.e. along one screen row. Round
        // the corner and see whether the leftover STATIC horizontal line goes.
        f = rp(f, 'R.y = abs(R.y) * 0.55 + R.y * 0.45;',
          'R.y = sqrt(R.y * R.y + 0.0025) * 0.55 + R.y * 0.45;', 'softlift');
      }
      if (parts.includes('noskirt')) {
        // Is the leftover far-field line the flat horizon skirt (inner edge at
        // 24.6 km) reading as a mirror at grazing incidence?
        f = rp(f, 'void main(){', 'void main(){\n  if (vAbsMisc.w > 0.5) discard;', 'noskirt');
      }
      if (parts.includes('oldref')) {
        // Exactly the pre-fix code: point-sampled MICRO normal into the macro
        // reflectance model, and the un-widened lobe for the sky lookup.
        f = rp(f, 'float fres = oceanReflectance(max(dot(Nmac, V), 1e-3), alphaR);',
          'float fres = oceanReflectance(max(dot(N, V), 1e-3), alpha);', 'oldref.fres');
        f = rp(f, 'vec3 R = reflect(-V, Nmac);', 'vec3 R = reflect(-V, N);', 'oldref.R');
        f = rp(f, 'vec3 skyRefl = oceanReflection(normalize(R), alphaR);',
          'vec3 skyRefl = oceanReflection(normalize(R), alpha);', 'oldref.sky');
      }
      m.vertexShader = v;
      m.fragmentShader = f;
      m.needsUpdate = true;
    }
    return log;
  };

  window.__run = (FRAMES) => {
    const gl = w.renderer.getContext();
    let tk = performance.now();
    for (let i = 0; i < 40; i++) { eng.lastTime = tk; tk += 16.6667; eng.tick(tk); } // TAA history must converge
    const W = w.size.width, H = w.size.height;
    const buf = new Uint8Array(W * H * 4);
    const cols = [];
    for (let x = 40; x < 520; x += 2) cols.push(x);
    for (let x = 1120; x < 1560; x += 2) cols.push(x);
    const NC = cols.length;
    const rowMean = [];
    const pxD = new Float64Array(H);
    const dmap = new Float32Array(W * H);   // full-frame mean |delta|, top-down
    const full = new Float32Array(W * H);
    let prevFull = null;
    let prev = null;
    for (let f = 0; f < FRAMES; f++) {
      eng.lastTime = tk; tk += 16.6667; eng.tick(tk);
      w.renderer.setRenderTarget(null);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      for (let yy = 0; yy < H; yy++) {
        const src = (H - 1 - yy) * W * 4;
        const dst = yy * W;
        for (let x = 0; x < W; x++) {
          const o = src + x * 4;
          full[dst + x] = 0.2126 * buf[o] + 0.7152 * buf[o + 1] + 0.0722 * buf[o + 2];
        }
      }
      if (prevFull) for (let i = 0; i < W * H; i++) dmap[i] += Math.abs(full[i] - prevFull[i]) / (FRAMES - 1);
      prevFull = prevFull ? prevFull : new Float32Array(W * H);
      prevFull.set(full);
      const rm = new Float64Array(H);
      const lum = new Float32Array(H * NC);
      for (let yy = 0; yy < H; yy++) {
        let s = 0;
        for (let c = 0; c < NC; c++) { const L = full[yy * W + cols[c]]; lum[yy * NC + c] = L; s += L; }
        rm[yy] = s / NC;
      }
      if (prev) for (let yy = 0; yy < H; yy++) {
        let s = 0;
        for (let c = 0; c < NC; c++) s += Math.abs(lum[yy * NC + c] - prev[yy * NC + c]);
        pxD[yy] += s / NC / (FRAMES - 1);
      }
      prev = lum;
      rowMean.push(rm);
    }
    const flick = new Float64Array(H);
    const band = new Float64Array(H);
    for (let y = 3; y < H - 3; y++) {
      let s = 0, s2 = 0;
      for (let f = 0; f < FRAMES; f++) {
        const hp = rowMean[f][y] - 0.5 * (rowMean[f][y - 3] + rowMean[f][y + 3]);
        s += hp; s2 += hp * hp;
      }
      const mu = s / FRAMES;
      band[y] = Math.abs(mu);
      flick[y] = Math.sqrt(Math.max(0, s2 / FRAMES - mu * mu));
    }
    const meanL = new Float64Array(H);
    for (let y = 0; y < H; y++) { let s = 0; for (let f = 0; f < FRAMES; f++) s += rowMean[f][y]; meanL[y] = s / FRAMES; }

    // amplified flicker map, x8, clipped
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(W, H);
    for (let i = 0; i < W * H; i++) {
      const g = Math.min(255, dmap[i] * 8);
      img.data[i * 4] = g; img.data[i * 4 + 1] = g; img.data[i * 4 + 2] = g; img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);

    const cam = w.camera;
    const pitchDown = -Math.asin(Math.max(-1, Math.min(1, -cam.matrixWorld.elements[9])));
    const th = Math.tan((cam.fov * Math.PI) / 360);
    const dist = [];
    for (let y = 0; y < H; y++) {
      const dep = pitchDown + Math.atan(((y + 0.5 - H / 2) / (H / 2)) * th);
      dist.push(dep > 1e-5 ? Math.round(Math.min(99999, cam.position.y / Math.tan(dep))) : -1);
    }
    return {
      H, dist, camY: +cam.position.y.toFixed(2), pitch: +pitchDown.toFixed(4), fov: cam.fov,
      // The fix's own inputs, so the blend can be checked against the geometry.
      slopeRms: window.__mats()[0].uniforms.uSlopeRms?.value ?? null,
      slopeVarTail: window.__mats()[0].uniforms.uSlopeVarTail?.value ?? null,
      flick: Array.from(flick).map((x) => +x.toFixed(3)),
      band: Array.from(band).map((x) => +x.toFixed(3)),
      pxD: Array.from(pxD).map((x) => +x.toFixed(3)),
      meanL: Array.from(meanL).map((x) => +x.toFixed(2)),
      png: cv.toDataURL('image/png'),
    };
  };
});

const runs = {};
for (const v of variants) {
  const log = await page.evaluate((k) => window.__apply(k), v);
  const miss = log.filter((l) => l.startsWith('MISS'));
  if (miss.length) { console.log(`ABORT variant ${v}: ablation did not apply: ${miss.join(',')}`); await browser.close(); process.exit(2); }
  await page.waitForTimeout(1200);
  const r = await page.evaluate((n) => window.__run(n), FRAMES);
  await writeFile(`${OUT}/flickmap-${scene}-${v}.png`, Buffer.from(r.png.split(',')[1], 'base64'));
  delete r.png;
  runs[v] = r;
  console.log(`ran ${v.padEnd(20)} [${log.join(' ')}]`);
}
if (errs.length) console.log('ERRORS', errs.slice(0, 6));

const ref = runs[variants[0]];
const pad = (s, n) => String(s).padStart(n);
console.log(`\nscene=${scene} camY=${ref.camY} pitchDown=${ref.pitch} fov=${ref.fov} frames=${FRAMES} H=${ref.H}`);
const bands = [[352, 392, 'far  >600m'], [392, 440, '600-240m'], [440, 500, '240-130m'], [500, 580, '130-85m'], [580, 700, '85-55m'], [700, 895, '<55m']];
for (const [key, label] of [['flick', 'FLICK  std_t(band signal)  <-- the defect'], ['band', 'BAND   |mean_t(band signal)|'], ['pxD', 'PXD    mean |frame delta|'], ['meanL', 'MEANL  luminance (sanity: must not go flat)']]) {
  console.log(`\n${label}`);
  console.log('  band        ' + variants.map((v) => pad(v.slice(0, 18), 19)).join(''));
  for (const [a, b, l] of bands) {
    let out = '  ' + l.padEnd(12);
    for (const v of variants) { let s = 0; for (let y = a; y < b; y++) s += runs[v][key][y]; out += pad((s / (b - a)).toFixed(2), 19); }
    console.log(out);
  }
}
console.log('\nworst 12 FLICKERING rows per variant  row(distance, flick):');
for (const v of variants) {
  const idx = []; for (let y = 352; y < 895; y++) idx.push(y);
  idx.sort((a, b) => runs[v].flick[b] - runs[v].flick[a]);
  console.log(`  ${v.padEnd(20)}` + idx.slice(0, 12).sort((a, b) => a - b)
    .map((y) => `${y}(${ref.dist[y]}m,${runs[v].flick[y].toFixed(1)})`).join(' '));
}
await writeFile(`${OUT}/bandverify-${scene}.json`, JSON.stringify(runs));
console.log(`\nmaps: ${OUT}/flickmap-${scene}-*.png`);
await browser.close();
