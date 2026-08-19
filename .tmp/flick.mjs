#!/usr/bin/env node
/**
 * FLICKER localiser — proves *where* and *why* the sea's horizontal bands move.
 *
 * Everything except the ocean is frozen. The ocean's own sim clock can also be
 * pinned, so a variant can render the SAME wave phase from the SAME camera
 * every frame; then anything that still changes frame to frame is a renderer
 * artefact, not the sea moving.
 *
 * Per screen row y (top-down):
 *   rowMean_f(y)   mean luminance of that row over two vertical strips of sea
 *   hp_f(y)        rowMean_f(y) - 0.5*(rowMean_f(y-3) + rowMean_f(y+3))
 *                  i.e. the horizontal-BAND signal of that row in frame f
 *   flick(y)       std over f of hp_f(y)     <-- a band that FLICKERS
 *   band(y)        |mean over f of hp_f(y)|  <-- a band that just sits there
 *   pxD(y)         mean per-pixel |frame delta| of the row
 *
 * node .tmp/flick.mjs <scene> <frames> <variant...>
 * variants: base frozen nojit frozen_nojit flatgeo noderiv aniso aniso_frozen
 */
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';

const scene = process.argv[2] ?? 'noon';
const FRAMES = Number(process.argv[3] ?? 10);
const variants = process.argv.slice(4);
if (!variants.length) variants.push('base');

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

  window.__frozen = [];
  for (const m of eng.modules) {
    if (m.name !== 'ocean') { window.__frozen.push([m, m.update]); m.update = () => {}; }
  }
  const ocean = eng.modules.find((m) => m.name === 'ocean');
  window.__ocean = ocean;
  window.__oceanUpdate = ocean.update;
  eng.stop();

  window.__apply = (kind) => {
    const parts = kind.split('_');
    // -- sim clock ------------------------------------------------------
    const PIN = 400;
    if (parts.includes('frozen')) {
      ocean.update = function (world) {
        this.simTime = PIN - world.time.dt;
        window.__oceanUpdate.call(this, world);
      };
    } else {
      ocean.update = window.__oceanUpdate;
    }
    // -- TAA jitter -----------------------------------------------------
    w.settings.antialias = parts.includes('nojit') ? 'smaa' : 'taa';
    w.bus.emit('settings:changed');

    // -- shader ablations ----------------------------------------------
    for (const m of window.__mats()) {
      let v = window.__orig.v;
      let f = window.__orig.f;
      if (parts.includes('flatgeo')) {
        // Geometry becomes a flat plane; every fragment input is unchanged.
        v = v.replace('vec3 pos = vec3(world.x + disp.x, disp.y + skirtRise, world.y + disp.z);',
          'vec3 pos = vec3(world.x + disp.x, skirtRise, world.y + disp.z);');
      }
      if (parts.includes('noderiv')) {
        // Kill the sampled wave slope/Jacobian, keep the roughness bookkeeping.
        f = f.replace('if (isSkirt > 0.5) { slope',
          'slope = vec2(0.0); jac = vec3(0.0);\n  if (isSkirt > 0.5) { slope');
      }
      if (parts.includes('nofoam')) {
        f = f.replace('float foam = max(instant, persistent * inWindow);',
          'float foam = 0.0;');
      }
      if (parts.includes('aniso')) {
        // Crude grazing-angle widening, for comparison only.
        f = f.replace('float pxWorld = max(dist * uPixelAngle, 1e-3);',
          'float pxWorld = max(dist * uPixelAngle, 1e-3);\n' +
          '  pxWorld /= clamp(abs(normalize(uCameraPos - P).y), 0.05, 1.0);');
      }
      // --- who AMPLIFIES the aliased normal? -----------------------------
      if (parts.includes('spec0')) {
        f = f.replace('col += sunSpec * (1.0 - foam * 0.55);', 'col += vec3(0.0);');
      }
      if (parts.includes('fresflat')) {
        f = f.replace('float fres = oceanReflectance(NoV, alpha);',
          'float fres = oceanReflectance(max(dot(Nlow, V), 1e-3), alpha);');
        f = f.replace('vec3 R = reflect(-V, N);', 'vec3 R = reflect(-V, Nlow);');
      }
      // --- candidate fixes ------------------------------------------------
      if (parts.includes('grz')) {
        // Blend by the probability that the point-sampled facet is backfacing:
        // carried slope rms vs the grazing sine.
        f = f.replace('float macro = saturate1((lostVarMaj - uSlopeVarTail) / macroDen);',
          'float carried = max(uSlopeRms * uSlopeRms - lostVar, 1e-6);\n' +
          '  float macro = saturate1(sqrt(carried) / max(abs(V.y), 1e-3) - 0.25);');
        f = f.replace('float alphaR = clamp(max(alpha, sqrt(lostVarMaj)), 0.02, 0.95);',
          'float km = 1.0 - macro;\n' +
          '  float alphaR = clamp(max(alpha, sqrt(lostVar + (1.0 - km * km) * carried)), 0.02, 0.95);');
      }
      if (parts.includes('grzboth')) {
        f = f.replace('float macro = saturate1((lostVarMaj - uSlopeVarTail) / macroDen);',
          'float carried = max(uSlopeRms * uSlopeRms - lostVar, 1e-6);\n' +
          '  float macro = max(saturate1((lostVarMaj - uSlopeVarTail) / macroDen),\n' +
          '                    saturate1(sqrt(carried) / max(abs(V.y), 1e-3) - 0.25));');
        f = f.replace('float alphaR = clamp(max(alpha, sqrt(lostVarMaj)), 0.02, 0.95);',
          'float km = 1.0 - macro;\n' +
          '  float alphaR = clamp(max(alpha, sqrt(lostVar + (1.0 - km * km) * carried)), 0.02, 0.95);');
      }
      if (parts.includes('oldref')) {
        // Undo the macro-normal reflection fix: back to the micro normal.
        f = f.replace('float fres = oceanReflectance(max(dot(Nmac, V), 1e-3), alphaR);',
          'float fres = oceanReflectance(max(dot(N, V), 1e-3), alpha);');
        f = f.replace('vec3 R = reflect(-V, Nmac);', 'vec3 R = reflect(-V, N);');
        f = f.replace('vec3 skyRefl = oceanReflection(normalize(R), alphaR);',
          'vec3 skyRefl = oceanReflection(normalize(R), alpha);');
      }
      if (parts.includes('refns')) {
        // Feed the reflection path the SAME statistically filtered normal the
        // sun lobe already uses, instead of the raw high-frequency one.
        f = f.replace('float fres = oceanReflectance(NoV, alpha);',
          'float fres = oceanReflectance(max(dot(Ns, V), 1e-3), alpha);');
        f = f.replace('vec3 R = reflect(-V, N);', 'vec3 R = reflect(-V, Ns);');
      }
      if (parts.includes('fpsched')) {
        // Crossfade on "how much slope variance the footprint threw away",
        // not on an arbitrary distance ramp.
        f = f.replace('float glit = smoothstep(45.0, 850.0, dist);',
          'float glit = saturate1(lostVar / max(uSlopeRms * uSlopeRms, 1e-5));');
      }
      if (parts.includes('softlift')) {
        f = f.replace('R.y = abs(R.y) * 0.55 + R.y * 0.45;',
          'R.y = sqrt(R.y * R.y + 0.0025) * 0.55 + R.y * 0.45;');
      }
      const ani = parts.find((p) => /^tap[0-9]$/.test(p));
      if (parts.includes('varmaj') || ani) {
        f = f.replace('float pxWorld = max(dist * uPixelAngle, 1e-3);',
          'float pxWorld = max(dist * uPixelAngle, 1e-3);\n' +
          '  vec2 aniDir = normalize(vec2(-V.x, -V.z) + vec2(1e-6));\n' +
          '  float aniRatio = min(1.0 / max(abs(V.y), 1e-3), 64.0);\n' +
          '  float pxMajor = pxWorld * aniRatio;');
      }
      if (parts.includes('varmaj')) {
        f = f.split('.y, pxWorld);').join('.y, pxMajor);');
      }
      if (ani) {
        const N = Number(ani.slice(3));
        f = f.replace(/vec4 d0 = textureLod\(uDisp(\d+), uv, lod\);\s*\n\s*vec4 d1 = textureLod\(uDeriv(\d+), uv, lod\);/g,
          (_m, a) => `vec4 d0 = vec4(0.0); vec4 d1 = vec4(0.0);
    float lodA = max(0.0, log2(pxWorld * max(1.0, aniRatio / ${N}.0) * uCascadeTexels[${a}]));
    for (int t = 0; t < ${N}; t++) {
      vec2 o = aniDir * (pxMajor * ((float(t) + 0.5) / ${N}.0 - 0.5)) * uCascadeScale[${a}];
      d0 += textureLod(uDisp${a}, uv + o, lodA);
      d1 += textureLod(uDeriv${a}, uv + o, lodA);
    }
    d0 /= ${N}.0; d1 /= ${N}.0;`);
      }
      m.vertexShader = v;
      m.fragmentShader = f;
      m.needsUpdate = true;
    }
    return kind;
  };

  window.__run = (FRAMES) => {
    const gl = w.renderer.getContext();
    const t0 = performance.now();
    let tk = t0;
    // long warmup: TAA history must converge on the frozen state
    for (let i = 0; i < 40; i++) { eng.lastTime = tk; tk += 16.6667; eng.tick(tk); }
    const W = w.size.width, H = w.size.height;
    const buf = new Uint8Array(W * H * 4);
    // two strips of open sea, left and right of the ship
    const cols = [];
    for (let x = 40; x < 520; x += 2) cols.push(x);
    for (let x = 1120; x < 1560; x += 2) cols.push(x);
    const NC = cols.length;
    const rowMean = [];       // [f][y] top-down
    const pxD = new Float64Array(H);
    let prev = null;
    for (let f = 0; f < FRAMES; f++) {
      eng.lastTime = tk; tk += 16.6667; eng.tick(tk);
      w.renderer.setRenderTarget(null);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      const rm = new Float64Array(H);
      const lum = new Float32Array(H * NC);
      for (let yy = 0; yy < H; yy++) {
        const y = H - 1 - yy;
        const base = y * W * 4;
        let s = 0;
        for (let c = 0; c < NC; c++) {
          const o = base + cols[c] * 4;
          const L = 0.2126 * buf[o] + 0.7152 * buf[o + 1] + 0.0722 * buf[o + 2];
          lum[yy * NC + c] = L;
          s += L;
        }
        rm[yy] = s / NC;
      }
      if (prev) {
        for (let yy = 0; yy < H; yy++) {
          let s = 0;
          for (let c = 0; c < NC; c++) s += Math.abs(lum[yy * NC + c] - prev[yy * NC + c]);
          pxD[yy] += s / NC / (FRAMES - 1);
        }
      }
      prev = lum;
      rowMean.push(rm);
    }
    // band signal, its temporal std, its static mean
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

    const cam = w.camera;
    const pitchDown = -Math.asin(Math.max(-1, Math.min(1, -cam.matrixWorld.elements[9])));
    const th = Math.tan((cam.fov * Math.PI) / 360);
    const rowOf = (d) => {
      const dep = Math.atan(cam.position.y / d);
      return Math.round(H / 2 + ((H / 2) * Math.tan(dep - pitchDown)) / th);
    };
    const rings = [];
    for (let k = 0; k < 10; k++) { const d = 48 * 2 ** k; rings.push([d, rowOf(d)]); }
    const dist = [];
    for (let y = 0; y < H; y++) {
      const dep = pitchDown + Math.atan(((y + 0.5 - H / 2) / (H / 2)) * th);
      dist.push(dep > 1e-5 ? Math.round(Math.min(99999, cam.position.y / Math.tan(dep))) : -1);
    }
    return {
      H, rings, dist, camY: +cam.position.y.toFixed(2), pitch: +pitchDown.toFixed(4), fov: cam.fov,
      flick: Array.from(flick).map((x) => +x.toFixed(3)),
      band: Array.from(band).map((x) => +x.toFixed(3)),
      pxD: Array.from(pxD).map((x) => +x.toFixed(3)),
      meanL: Array.from(meanL).map((x) => +x.toFixed(2)),
    };
  };
});

const runs = {};
for (const v of variants) {
  await page.evaluate((k) => window.__apply(k), v);
  await page.waitForTimeout(1200);
  runs[v] = await page.evaluate((n) => window.__run(n), FRAMES);
  console.log(`ran ${v}`);
}
if (errs.length) console.log('ERRORS', errs.slice(0, 6));

const ref = runs[variants[0]];
const pad = (s, n) => String(s).padStart(n);
console.log(`\nscene=${scene} camY=${ref.camY} pitchDown=${ref.pitch} fov=${ref.fov} frames=${FRAMES} H=${ref.H}`);
console.log('clipmap ring rows:', ref.rings.filter(([, r]) => r > 340 && r < 900).map(([d, r]) => `${d}m@${r}`).join('  '));

const bands = [[352, 392, 'far  >600m'], [392, 440, '600-240m'], [440, 500, '240-130m'], [500, 580, '130-85m'], [580, 700, '85-55m'], [700, 895, '<55m']];
for (const [key, label] of [['flick', 'FLICK  std_t(band signal)'], ['band', 'BAND   |mean_t(band signal)|'], ['pxD', 'PXD    mean |frame delta|'], ['meanL', 'MEANL  luminance']]) {
  console.log(`\n${label}`);
  console.log('  band        ' + variants.map((v) => pad(v, 13)).join(''));
  for (const [a, b, l] of bands) {
    let out = '  ' + l.padEnd(12);
    for (const v of variants) { let s = 0; for (let y = a; y < b; y++) s += runs[v][key][y]; out += pad((s / (b - a)).toFixed(2), 13); }
    console.log(out);
  }
}

console.log('\ntop 14 FLICKERING rows per variant  row(distance, flick):');
for (const v of variants) {
  const idx = []; for (let y = 352; y < 895; y++) idx.push(y);
  idx.sort((a, b) => runs[v].flick[b] - runs[v].flick[a]);
  console.log(`  ${v.padEnd(13)}` + idx.slice(0, 14).sort((a, b) => a - b)
    .map((y) => `${y}(${ref.dist[y]}m,${runs[v].flick[y].toFixed(1)})`).join(' '));
}
await writeFile(`/tmp/flick-${scene}.json`, JSON.stringify(runs));
await browser.close();
