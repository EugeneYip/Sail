#!/usr/bin/env node
/**
 * Slab OWNERSHIP test (DIAGNOSIS 17A), the step after .tmp/slabname.mjs.
 *
 * slabname.mjs proved the slab pixels are DRAWN by ocean clipmap meshes. That is
 * not the same as proving src/ocean owns the bug: the ocean surface shader adds
 * the VFX wake buffer's G channel straight into 'disp.y'
 * (src/ocean/shaders/surface.ts: "disp.y += textureLod(uWake, wuv, 0.0).g * wf")
 * so a hard-edged strip written into that buffer by src/vfx/WakeField.ts lifts a
 * plank-shaped patch of ocean above the surrounding sea — drawn by the ocean,
 * authored by VFX.
 *
 * This distinguishes the two by ablating the CONTENT rather than the mesh:
 *   A  hide ocean clipmap level 0            (repeat of the positive control)
 *   B  uWakeStrength = 0                     (ocean stops reading the buffer)
 *   C  wake texture -> 1x1 black             (buffer readable but empty)
 *   D  WakeField ribbon hidden in its own offscreen scene
 *   E  WakeField ripple mesh hidden
 *   F  WakeField stamp mesh hidden
 * If B or C kills the slab, the geometry is ocean but the CONTENT is VFX's.
 * D/E/F then name which VFX writer put it there.
 */
import { chromium } from 'playwright';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';

const OUT = process.env.OUT || '/tmp/slabowner';
const W = Number(process.env.W || 1600);
const H = Number(process.env.H || 900);
const REGION = (process.env.SLAB || '980,845,150,55').split(',').map(Number);
await mkdir(OUT, { recursive: true });

function decode(buf) {
  let p = 8;
  let ihdr = null;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), color: data[9] };
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[ihdr.color];
  const raw = inflateSync(Buffer.concat(idat));
  const stride = ihdr.w * ch;
  const px = Buffer.alloc(ihdr.h * stride);
  let q = 0;
  for (let y = 0; y < ihdr.h; y++) {
    const filter = raw[q++];
    const row = raw.subarray(q, q + stride);
    q += stride;
    const cur = px.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= ch ? prev[i - ch] : 0;
      let v = row[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 0xff;
    }
  }
  return { w: ihdr.w, h: ihdr.h, ch, px };
}

function score(a, bq, thr = 18) {
  const [rx, ry, rw, rh] = REGION;
  let inN = 0, outN = 0;
  let mnx = 1e9, mny = 1e9, mxx = -1, mxy = -1;
  for (let y = 0; y < a.h; y++) {
    for (let x = 0; x < a.w; x++) {
      const i = (y * a.w + x) * a.ch;
      const j = (y * bq.w + x) * bq.ch;
      const d = Math.abs(a.px[i] - bq.px[j]) + Math.abs(a.px[i + 1] - bq.px[j + 1]) + Math.abs(a.px[i + 2] - bq.px[j + 2]);
      if (d <= thr) continue;
      if (x >= rx && x < rx + rw && y >= ry && y < ry + rh) {
        inN++;
        if (x < mnx) mnx = x; if (x > mxx) mxx = x;
        if (y < mny) mny = y; if (y > mxy) mxy = y;
      } else outN++;
    }
  }
  return { inN, outN, frac: +(inN / (rw * rh)).toFixed(3), inBox: inN ? [mnx, mny, mxx - mnx + 1, mxy - mny + 1] : null };
}

const b = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--force-color-profile=srgb', '--hide-scrollbars', '--mute-audio'],
});
const p = await b.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
await p.addInitScript(() => {
  const R = window.WebSocket;
  window.WebSocket = function (u, pr) {
    if (pr === 'vite-hmr') return { readyState: 3, close() {}, send() {}, addEventListener() {}, removeEventListener() {} };
    return new R(u, pr);
  };
  window.WebSocket.prototype = R.prototype;
});
p.on('console', (m) => { if (m.type() === 'error' && !/AudioContext/.test(m.text())) console.log('[page error]', m.text().slice(0, 160)); });
p.setDefaultNavigationTimeout(240000);
p.setDefaultTimeout(120000);
await p.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => !!window.__leeward, null, { timeout: 120000 });

await p.evaluate(() => {
  const w = window.__leeward.world;
  Object.assign(w.settings, {
    adaptiveResolution: false, renderScale: 1, showHud: false, antialias: 'off',
    filmGrain: false, motionBlur: false, depthOfField: false,
    chromaticAberration: false, screenSpaceReflections: false, lensDirt: false,
    autoExposure: false,
  });
  const scene = {
    env: { timeOfDay: 15.6, windSpeed: 9.0, cloudCover: 0.4, cloudType: 0.75, turbidity: 2.2, rain: 0, visibility: 32000, seaState: 3, waveHeight: 1.5, choppiness: 0.55 },
    cam: { mode: 'orbit', distance: 110 },
  };
  Object.assign(w.env, scene.env);
  Object.assign(w.cam, scene.cam);
  w.bus.emit('settings:changed');
  w.bus.emit('capture:scene', scene);
});
await p.waitForTimeout(12000);
await p.evaluate(() => { window.__leeward.world.cam.mode = 'free'; });
await p.waitForTimeout(1500);

/* Freeze, then build handles onto the ocean material and the wake internals. */
const inv = await p.evaluate(() => {
  const e = window.__leeward;
  e.stop();
  window.__step = (n) => { for (let i = 0; i < n; i++) { e.lastTime = performance.now(); e.tick(e.lastTime); } };
  window.__step(4);

  const w = e.world;
  // The ocean surface material: found from the drawables, not from a guess at
  // the module's private field names.
  let oceanMat = null;
  const oceanMeshes = [];
  w.scene.traverse((o) => {
    if (!o.isMesh) return;
    const n = (o.material && o.material.name) || '';
    if (n === 'ocean-surface') { oceanMeshes.push(o); oceanMat = o.material; }
  });
  window.__oceanMat = oceanMat;
  window.__oceanMeshes = oceanMeshes;

  // Everything reachable that looks like the wake field's offscreen writers.
  const found = [];
  const seen = new Set();
  const walk = (obj, path, depth) => {
    if (!obj || depth > 4 || seen.has(obj)) return;
    seen.add(obj);
    for (const k of Object.keys(obj)) {
      let v;
      try { v = obj[k]; } catch { continue; }
      if (!v || typeof v !== 'object') continue;
      if (v.isMesh) found.push({ path: `${path}.${k}`, name: v.name || '(anon)', mat: (v.material && (v.material.name || v.material.type)) || '-', inWorldScene: false, ref: v });
      else if (v.isScene) found.push({ path: `${path}.${k}`, name: v.name || '(scene)', mat: 'SCENE', ref: v });
      else walk(v, `${path}.${k}`, depth + 1);
    }
  };
  walk(w.vfx || {}, 'vfx', 0);
  const inWorld = new Set();
  w.scene.traverse((o) => inWorld.add(o));
  window.__wakeMeshes = found.filter((f) => f.mat !== 'SCENE').map((f) => f.ref);
  return {
    oceanCount: oceanMeshes.length,
    oceanUniforms: oceanMat ? Object.keys(oceanMat.uniforms).filter((k) => /wake/i.test(k)) : [],
    wakeStrength: oceanMat ? oceanMat.uniforms.uWakeStrength.value : null,
    wakeMeshes: found.map((f) => ({ path: f.path, name: f.name, mat: f.mat, inWorldScene: inWorld.has(f.ref) })),
  };
});
console.log('ocean-surface meshes:', inv.oceanCount, ' wake uniforms:', inv.oceanUniforms.join(','), ' uWakeStrength =', inv.wakeStrength);
console.log('\nmeshes reachable from world.vfx:');
for (const m of inv.wakeMeshes) console.log(`   ${m.path.padEnd(38)} ${String(m.name).padEnd(18)} mat=${String(m.mat).padEnd(24)} inWorldScene=${m.inWorldScene}`);

const grab = async (file) => {
  await p.evaluate(() => window.__step(3));
  await p.screenshot({ path: file, animations: 'disabled', caret: 'hide' });
  return decode(await readFile(file));
};

const base = await grab(`${OUT}/00-base.png`);
const cs = score(base, await grab(`${OUT}/00-control.png`));
console.log(`\nregion ${REGION.join(',')}   control: in=${cs.inN} out=${cs.outN}\n`);

/**
 * Each case is a pair of source strings rather than functions: closures cannot
 * cross the Playwright bridge, and the mutations have to run in page context.
 */
const run = async (tag, applySrc, revertSrc) => {
  const e1 = await p.evaluate((s) => { try { eval(s); return null; } catch (er) { return String(er.message || er); } }, applySrc);
  if (e1) { console.log(`${tag.padEnd(30)} SKIPPED (${e1})`); return; }
  const img = await grab(`${OUT}/${tag}.png`);
  const s = score(base, img);
  await p.evaluate((s2) => { try { eval(s2); } catch { /* leave it */ } }, revertSrc);
  const flag = s.frac > 0.15 ? '  <<< KILLS/MOVES THE SLAB' : s.inN === 0 ? '   (slab untouched)' : '';
  console.log(`${tag.padEnd(30)} inRegion=${String(s.inN).padStart(6)} (${String(s.frac).padStart(5)})  elsewhere=${String(s.outN).padStart(7)}  inBox=${JSON.stringify(s.inBox)}${flag}`);
  return { tag, ...s };
};

const out = [];
out.push(await run('A-hide-clipmap-L0',
  'const m=window.__oceanMeshes[0]; m.userData.__om=m.layers.mask; m.layers.mask=0;',
  'const m=window.__oceanMeshes[0]; m.layers.mask=m.userData.__om;'));
out.push(await run('B-uWakeStrength-0',
  'const u=window.__oceanMat.uniforms; window.__ws=u.uWakeStrength.value; u.uWakeStrength.value=0;',
  'window.__oceanMat.uniforms.uWakeStrength.value=window.__ws;'));
out.push(await run('D-hide-vfx-wake-writers',
  'window.__hidden=[]; for (const m of window.__wakeMeshes){ window.__hidden.push([m,m.layers.mask]); m.layers.mask=0; }',
  'for (const [m,k] of window.__hidden) m.layers.mask=k;'));
out.push(await run('E-hide-every-ocean-but-L0',
  'window.__h2=[]; window.__oceanMeshes.forEach((m,i)=>{ if(i!==0){ window.__h2.push([m,m.layers.mask]); m.layers.mask=0; } });',
  'for (const [m,k] of window.__h2) m.layers.mask=k;'));

await writeFile(`${OUT}/slabowner.json`, JSON.stringify({ region: REGION, inv, out }, null, 2));
await b.close();
console.log('\ndone ->', OUT);
