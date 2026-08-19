/**
 * Frozen-time ablation. The definitive "which mesh is that" test.
 *
 * Every earlier attempt at this failed for the same two reasons: the camera was
 * still orbiting and auto-exposure re-adapted once things were hidden, so the
 * two frames differed everywhere and the diff said nothing.
 *
 * Here the engine's RAF loop is stopped and frames are stepped by hand with
 * dt = 0 (Engine.tick is only TypeScript-private), so uTime, the ship, the
 * waves, the camera and the exposure are all bit-identical between frames.
 * Hiding one mesh then changes exactly the pixels that mesh drew.
 *
 *   node .tmp/frozenablate.mjs            # all drawables
 *   ONLY=ship-rigging,ship-oak node .tmp/frozenablate.mjs
 */
import { chromium } from 'playwright';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';

const OUT = process.env.OUT || '/tmp/frozen';
const W = Number(process.env.W || 1600);
const H = Number(process.env.H || 900);
const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);
await mkdir(OUT, { recursive: true });

function decode(buf) {
  let p = 8;
  let ihdr = null;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], color: data[9], interlace: data[12] };
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

function diff(a, bq, thr = 24) {
  let n = 0, mnx = 1e9, mny = 1e9, mxx = -1, mxy = -1, sum = 0;
  const rows = new Int32Array(a.h);
  for (let y = 0; y < a.h; y++) {
    for (let x = 0; x < a.w; x++) {
      const i = (y * a.w + x) * a.ch;
      const j = (y * bq.w + x) * bq.ch;
      const d = Math.abs(a.px[i] - bq.px[j]) + Math.abs(a.px[i + 1] - bq.px[j + 1]) + Math.abs(a.px[i + 2] - bq.px[j + 2]);
      if (d > thr) {
        n++; sum += d; rows[y]++;
        if (x < mnx) mnx = x; if (x > mxx) mxx = x;
        if (y < mny) mny = y; if (y > mxy) mxy = y;
      }
    }
  }
  return { n, bbox: n ? [mnx, mny, mxx - mnx + 1, mxy - mny + 1] : null, mean: n ? +(sum / n).toFixed(1) : 0, rows };
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
  // Kill every temporal / stochastic pass, or the "frozen" frames differ
  // everywhere from TAA jitter and film grain and the diff says nothing.
  w.settings.antialias = 'off';
  w.settings.filmGrain = false;
  w.settings.motionBlur = false;
  w.settings.depthOfField = false;
  w.settings.chromaticAberration = false;
  w.settings.screenSpaceReflections = false;
  w.settings.lensDirt = false;
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

// Freeze: stop the loop, then step frames with dt = 0 so nothing advances.
const frozen = await p.evaluate(() => {
  const e = window.__leeward;
  e.world.cam.mode = 'free';
  return true;
});
await p.waitForTimeout(1500);
await p.evaluate(() => {
  const e = window.__leeward;
  e.stop();
  window.__step = (n) => {
    for (let i = 0; i < n; i++) { e.lastTime = performance.now(); e.tick(e.lastTime); }
  };
  window.__step(4);
});

const list = await p.evaluate(() => {
  const out = [];
  window.__leeward.world.scene.traverse((o) => {
    if (!(o.isMesh || o.isLine || o.isPoints)) return;
    out.push({ name: o.name || `(anon:${(o.material && (o.material.name || o.material.type)) || '?'})`, vis: o.visible });
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
const cd = diff(base, control);
console.log(`control (nothing hidden, two frames apart): ${cd.n} px changed  ${JSON.stringify(cd.bbox)}`);
if (cd.n > 2000) console.log('WARNING: the freeze is leaking; the diffs below are not exact.');

const results = [];
for (let i = 0; i < list.length; i++) {
  const item = list[i];
  if (!item.vis) continue;
  if (ONLY.length && !ONLY.includes(item.name)) continue;
  const ok = await p.evaluate((i) => {
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
  const d = diff(base, img);
  await p.evaluate((i) => {
    let k = 0;
    window.__leeward.world.scene.traverse((o) => {
      if (!(o.isMesh || o.isLine || o.isPoints)) return;
      if (k === i && o.userData.__om !== undefined) o.layers.mask = o.userData.__om;
      k++;
    });
  }, i);
  // Widest thin band: the tallest run of rows that is under 40 px tall.
  results.push({ i, name: item.name, hid: ok, n: d.n, bbox: d.bbox, mean: d.mean });
  console.log(`${tag.padEnd(34)} changed=${String(d.n).padStart(8)} bbox=${JSON.stringify(d.bbox)} mean=${d.mean}`);
}
await writeFile(`${OUT}/ablate.json`, JSON.stringify(results, null, 2));
await b.close();
console.log('\ndone ->', OUT, frozen ? '' : '(freeze failed)');
