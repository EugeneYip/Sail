#!/usr/bin/env node
/**
 * Phantom-slab identification, attempt 5 (DIAGNOSIS 17A) — the decisive one.
 *
 * Attempt 4 (.tmp/frozenablate.mjs) froze time correctly (13 px control diff)
 * but every ablation still reported 4100+ changed pixels spread over the whole
 * frame. That floor was AUTO-EXPOSURE: hiding any mesh changes average scene
 * luminance, the eye re-adapts, and every pixel shifts by just over the diff
 * threshold. Hiding a distant island shore moved 4130 px; the bow wave moved
 * 5233. The signal was 1000 px inside a 4130 px noise floor.
 *
 * Two changes make it decisive:
 *   1. autoExposure = false, so the tonemap is bit-stable across ablations.
 *   2. The diff is scored inside the slab's own screen rectangle AND outside
 *      it, so "this mesh drew the slab" is distinguishable from "this mesh
 *      shifted the whole frame".
 *
 * SLAB= x,y,w,h overrides the region. Default is the rectangle where the slab
 * was seen in the frozen orbit frame written by frozenablate.mjs.
 */
import { chromium } from 'playwright';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';

const OUT = process.env.OUT || '/tmp/slabname';
const W = Number(process.env.W || 1600);
const H = Number(process.env.H || 900);
const REGION = (process.env.SLAB || '860,735,170,60').split(',').map(Number);
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

/** Changed-pixel counts split by inside/outside the slab rectangle. */
function score(a, bq, thr = 18) {
  const [rx, ry, rw, rh] = REGION;
  let inN = 0, outN = 0, inSum = 0;
  let mnx = 1e9, mny = 1e9, mxx = -1, mxy = -1;
  for (let y = 0; y < a.h; y++) {
    for (let x = 0; x < a.w; x++) {
      const i = (y * a.w + x) * a.ch;
      const j = (y * bq.w + x) * bq.ch;
      const d = Math.abs(a.px[i] - bq.px[j]) + Math.abs(a.px[i + 1] - bq.px[j + 1]) + Math.abs(a.px[i + 2] - bq.px[j + 2]);
      if (d <= thr) continue;
      const inside = x >= rx && x < rx + rw && y >= ry && y < ry + rh;
      if (inside) {
        inN++; inSum += d;
        if (x < mnx) mnx = x; if (x > mxx) mxx = x;
        if (y < mny) mny = y; if (y > mxy) mxy = y;
      } else outN++;
    }
  }
  const area = rw * rh;
  return {
    inN, outN, area,
    frac: +(inN / area).toFixed(3),
    inMean: inN ? +(inSum / inN).toFixed(1) : 0,
    inBox: inN ? [mnx, mny, mxx - mnx + 1, mxy - mny + 1] : null,
  };
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
  w.settings.adaptiveResolution = false;
  w.settings.renderScale = 1;
  w.settings.showHud = false;
  w.settings.antialias = 'off';
  w.settings.filmGrain = false;
  w.settings.motionBlur = false;
  w.settings.depthOfField = false;
  w.settings.chromaticAberration = false;
  w.settings.screenSpaceReflections = false;
  w.settings.lensDirt = false;
  // The reason attempt 4 could not localise anything.
  w.settings.autoExposure = false;
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
await p.evaluate(() => {
  const e = window.__leeward;
  e.stop();
  window.__step = (n) => {
    for (let i = 0; i < n; i++) { e.lastTime = performance.now(); e.tick(e.lastTime); }
  };
  window.__step(4);
});

/** Every drawable, with the module-identifying detail an ablation cannot give. */
const list = await p.evaluate(() => {
  const out = [];
  window.__leeward.world.scene.traverse((o) => {
    if (!(o.isMesh || o.isLine || o.isPoints)) return;
    const m = o.material;
    const chain = [];
    for (let q = o.parent; q; q = q.parent) chain.push(q.name || q.type);
    out.push({
      name: o.name || `(anon:${(m && (m.name || m.type)) || '?'})`,
      vis: o.visible,
      parents: chain.join('<'),
      mat: m ? `${m.type}${m.name ? `:${m.name}` : ''}` : '-',
      order: o.renderOrder,
      culled: o.frustumCulled,
    });
  });
  return out;
});

const grab = async (file) => {
  await p.evaluate(() => window.__step(3));
  await p.screenshot({ path: file, animations: 'disabled', caret: 'hide' });
  return decode(await readFile(file));
};

const base = await grab(`${OUT}/00-base.png`);
const control = await grab(`${OUT}/00-control.png`);
const cs = score(base, control);
console.log(`region ${REGION.join(',')}  (${cs.area} px)`);
console.log(`control: in=${cs.inN} out=${cs.outN}   <- both must be ~0\n`);

const results = [];
for (let i = 0; i < list.length; i++) {
  const item = list[i];
  if (!item.vis) continue;
  const hid = await p.evaluate((i) => {
    let k = 0, hit = null;
    window.__leeward.world.scene.traverse((o) => {
      if (!(o.isMesh || o.isLine || o.isPoints)) return;
      if (k === i) { o.userData.__om = o.layers.mask; o.layers.mask = 0; hit = o.name; }
      k++;
    });
    return hit;
  }, i);
  const tag = `${String(i).padStart(2, '0')}-${item.name.replace(/[^a-z0-9-]/gi, '_')}`;
  const img = await grab(`${OUT}/${tag}.png`);
  const s = score(base, img);
  await p.evaluate((i) => {
    let k = 0;
    window.__leeward.world.scene.traverse((o) => {
      if (!(o.isMesh || o.isLine || o.isPoints)) return;
      if (k === i && o.userData.__om !== undefined) o.layers.mask = o.userData.__om;
      k++;
    });
  }, i);
  results.push({ i, name: item.name, hid, parents: item.parents, mat: item.mat, ...s });
  const flag = s.frac > 0.15 ? '  <<< SLAB' : '';
  console.log(`${tag.padEnd(30)} inRegion=${String(s.inN).padStart(6)} (${String(s.frac).padStart(5)})  elsewhere=${String(s.outN).padStart(7)}  inBox=${JSON.stringify(s.inBox)}${flag}`);
}
await writeFile(`${OUT}/slabname.json`, JSON.stringify({ region: REGION, list, results }, null, 2));
await b.close();

results.sort((a, bb) => bb.frac - a.frac);
console.log('\n=== ranked by fraction of the slab rectangle they own ===');
for (const r of results.slice(0, 8)) {
  console.log(`${String(r.frac).padStart(6)}  ${r.name.padEnd(24)} mat=${r.mat.padEnd(28)} parents=${r.parents}`);
}
console.log('\ndone ->', OUT);
