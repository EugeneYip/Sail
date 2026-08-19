/**
 * Phantom-slab hunt (DIAGNOSIS 17A), attempt 4.
 *
 * Why the previous three failed: every candidate mesh in this scene is
 * displaced in its VERTEX SHADER (the bow-wave sheet's 'position' attribute is
 * (t, j, side), the ocean clipmap and the islands are unit planes). So
 * geometry.computeBoundingBox() reports a 1-2 m box for a mesh that covers
 * hundreds of metres, and every bounding-box bisect misses them.
 *
 * So: freeze the camera (free mode adopts the current pose and holds it), then
 * (1) CPU-raycast a pixel grid against every mesh that has real geometry, and
 * (2) screenshot with only one candidate visible at a time. Between them,
 * whatever the slab is gets named.
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const OUT = process.env.OUT || '/tmp/slabhunt';
const REGION = (process.env.REGION || '700,430,560,340').split(',').map(Number);
const STEP = Number(process.env.STEP || 16);
const W = Number(process.env.W || 1600);
const H = Number(process.env.H || 900);
const SCENE = process.env.SCENE || 'orbit';
await mkdir(OUT, { recursive: true });

const SCENES = {
  orbit: {
    env: { timeOfDay: 15.6, windSpeed: 9.0, cloudCover: 0.4, cloudType: 0.75, turbidity: 2.2, rain: 0, visibility: 32000, seaState: 3, waveHeight: 1.5, choppiness: 0.55 },
    cam: { mode: 'orbit', distance: 110 },
  },
  noon: {
    env: { timeOfDay: 12.7, windSpeed: 10.5, cloudCover: 0.38, cloudType: 0.8, turbidity: 2.0, rain: 0, visibility: 34000, seaState: 4, waveHeight: 2.0, choppiness: 0.6 },
    cam: { mode: 'chase', distance: 74 },
  },
  waterline: {
    env: { timeOfDay: 16.8, windSpeed: 11.0, cloudCover: 0.42, cloudType: 0.8, turbidity: 2.4, rain: 0, visibility: 30000, seaState: 4, waveHeight: 2.2, choppiness: 0.65 },
    cam: { mode: 'chase', distance: 86 },
  },
};

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
p.on('console', (m) => { if (m.type() === 'error' && !/AudioContext/.test(m.text())) console.log('[page error]', m.text().slice(0, 200)); });
p.setDefaultNavigationTimeout(240000);
await p.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => !!window.__leeward, null, { timeout: 120000 });

await p.evaluate((scene) => {
  const w = window.__leeward.world;
  w.settings.adaptiveResolution = false;
  w.settings.renderScale = 1;
  w.settings.showHud = false;
  Object.assign(w.env, scene.env);
  Object.assign(w.cam, scene.cam);
  w.bus.emit('settings:changed');
  w.bus.emit('capture:scene', scene);
}, SCENES[SCENE]);
await p.waitForTimeout(11000);

// Freeze: free mode adopts the current pose, zeroes velocity and shake.
await p.evaluate(() => { window.__leeward.world.cam.mode = 'free'; });
await p.waitForTimeout(1200);
await p.screenshot({ path: `${OUT}/hunt-all.png` });

const res = await p.evaluate(({ REGION, STEP, W, H }) => {
  const w = window.__leeward.world;
  const cam = w.camera;
  w.scene.updateMatrixWorld(true);

  const applyMat = (e, x, y, z, wv) => {
    const ox = e[0] * x + e[4] * y + e[8] * z + e[12] * wv;
    const oy = e[1] * x + e[5] * y + e[9] * z + e[13] * wv;
    const oz = e[2] * x + e[6] * y + e[10] * z + e[14] * wv;
    const ow = e[3] * x + e[7] * y + e[11] * z + e[15] * wv;
    return [ox, oy, oz, ow];
  };

  // Gather world-space triangle soups for every mesh with real geometry.
  const soups = [];
  w.scene.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry;
    if (!g || !g.attributes || !g.attributes.position) return;
    const pa = g.attributes.position;
    if (pa.itemSize !== 3) return;
    const index = g.index ? g.index.array : null;
    const triCount = index ? index.length / 3 : pa.count / 3;
    const instMat = o.isInstancedMesh ? o.instanceMatrix.array : null;
    const instCount = o.isInstancedMesh ? o.count : 1;
    if (triCount * instCount > 400000) return;
    const tris = new Float64Array(triCount * instCount * 9);
    const em = o.matrixWorld.elements;
    let t = 0;
    const im = new Float64Array(16);
    for (let n = 0; n < instCount; n++) {
      let e = em;
      if (instMat) {
        // full = matrixWorld * instanceMatrix
        const a = em; const bm = instMat.subarray(n * 16, n * 16 + 16);
        for (let c = 0; c < 4; c++) {
          for (let r = 0; r < 4; r++) {
            let s = 0;
            for (let k = 0; k < 4; k++) s += a[k * 4 + r] * bm[c * 4 + k];
            im[c * 4 + r] = s;
          }
        }
        e = im;
      }
      for (let i = 0; i < triCount; i++) {
        for (let k = 0; k < 3; k++) {
          const vi = index ? index[i * 3 + k] : i * 3 + k;
          const q = applyMat(e, pa.getX(vi), pa.getY(vi), pa.getZ(vi), 1);
          tris[t++] = q[0]; tris[t++] = q[1]; tris[t++] = q[2];
        }
      }
    }
    // world AABB of the actual soup
    let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
    for (let i = 0; i < tris.length; i += 3) {
      if (tris[i] < mnx) mnx = tris[i]; if (tris[i] > mxx) mxx = tris[i];
      if (tris[i + 1] < mny) mny = tris[i + 1]; if (tris[i + 1] > mxy) mxy = tris[i + 1];
      if (tris[i + 2] < mnz) mnz = tris[i + 2]; if (tris[i + 2] > mxz) mxz = tris[i + 2];
    }
    soups.push({
      name: o.name || `(anon:${o.material && (o.material.name || o.material.type)})`,
      visible: o.visible && (() => { let q = o; while (q) { if (!q.visible) return false; q = q.parent; } return true; })(),
      tris, count: tris.length / 9,
      box: [mnx, mny, mnz, mxx, mxy, mxz],
    });
  });

  const origin = [cam.matrixWorld.elements[12], cam.matrixWorld.elements[13], cam.matrixWorld.elements[14]];
  const pinv = cam.projectionMatrixInverse.elements;
  const mw = cam.matrixWorld.elements;

  const rayFor = (px, py) => {
    const nx = (px / W) * 2 - 1;
    const ny = -((py / H) * 2 - 1);
    const c = applyMat(pinv, nx, ny, 0.5, 1);
    const v = applyMat(mw, c[0] / c[3], c[1] / c[3], c[2] / c[3], 1);
    let dx = v[0] - origin[0], dy = v[1] - origin[1], dz = v[2] - origin[2];
    const L = Math.hypot(dx, dy, dz);
    return [dx / L, dy / L, dz / L];
  };

  const hitTri = (ox, oy, oz, dx, dy, dz, t, i) => {
    const ax = t[i], ay = t[i + 1], az = t[i + 2];
    const bx = t[i + 3], by = t[i + 4], bz = t[i + 5];
    const cx = t[i + 6], cy = t[i + 7], cz = t[i + 8];
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-12) return -1;
    const inv = 1 / det;
    const tx = ox - ax, ty = oy - ay, tz = oz - az;
    const u = (tx * px + ty * py + tz * pz) * inv;
    if (u < 0 || u > 1) return -1;
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
    const v = (dx * qx + dy * qy + dz * qz) * inv;
    if (v < 0 || u + v > 1) return -1;
    const d = (e2x * qx + e2y * qy + e2z * qz) * inv;
    return d > 0.05 ? d : -1;
  };

  const boxHit = (box, ox, oy, oz, dx, dy, dz) => {
    let t0 = 0, t1 = 1e9;
    const o = [ox, oy, oz], d = [dx, dy, dz];
    for (let k = 0; k < 3; k++) {
      const inv = 1 / (d[k] || 1e-20);
      let a = (box[k] - 2 - o[k]) * inv, bq = (box[k + 3] + 2 - o[k]) * inv;
      if (a > bq) { const s = a; a = bq; bq = s; }
      if (a > t0) t0 = a;
      if (bq < t1) t1 = bq;
      if (t0 > t1) return false;
    }
    return true;
  };

  const [rx, ry, rw, rh] = REGION;
  const rows = [];
  const legend = new Map();
  const hits = [];
  for (let py = ry; py < ry + rh; py += STEP) {
    let line = '';
    for (let px = rx; px < rx + rw; px += STEP) {
      const [dx, dy, dz] = rayFor(px, py);
      let best = Infinity, bestName = null;
      for (const s of soups) {
        if (!s.visible) continue;
        if (!boxHit(s.box, origin[0], origin[1], origin[2], dx, dy, dz)) continue;
        for (let i = 0; i < s.tris.length; i += 9) {
          const d = hitTri(origin[0], origin[1], origin[2], dx, dy, dz, s.tris, i);
          if (d > 0 && d < best) { best = d; bestName = s.name; }
        }
      }
      if (bestName) {
        if (!legend.has(bestName)) legend.set(bestName, String.fromCharCode(65 + legend.size));
        line += legend.get(bestName);
        hits.push({ px, py, name: bestName, dist: +best.toFixed(2),
          at: [origin[0] + dx * best, origin[1] + dy * best, origin[2] + dz * best].map((v) => +v.toFixed(2)) });
      } else line += '.';
    }
    rows.push({ py, line });
  }

  return {
    camPos: origin.map((v) => +v.toFixed(2)),
    shipPos: [w.shipRoot.position.x, w.shipRoot.position.y, w.shipRoot.position.z].map((v) => +v.toFixed(2)),
    shipHeading: +(w.ship.heading ?? 0).toFixed(3),
    origin: [w.origin.x, w.origin.y, w.origin.z].map((v) => +v.toFixed(1)),
    speed: +(w.ship.speed ?? 0).toFixed(2),
    boxes: soups.map((s) => ({ name: s.name, vis: s.visible, count: s.count,
      size: [s.box[3] - s.box[0], s.box[4] - s.box[1], s.box[5] - s.box[2]].map((v) => +v.toFixed(1)),
      min: s.box.slice(0, 3).map((v) => +v.toFixed(1)), max: s.box.slice(3).map((v) => +v.toFixed(1)) })),
    rows, legend: [...legend].map(([n, c]) => `${c} = ${n}`), hits,
  };
}, { REGION, STEP, W, H });

await writeFile(`${OUT}/hunt.json`, JSON.stringify(res, null, 2));
console.log('camPos', res.camPos, 'shipPos', res.shipPos, 'voyageOrigin', res.origin, 'speed', res.speed);
console.log('\n=== true world AABB of every real-geometry mesh (from the transformed vertex soup) ===');
for (const bx of res.boxes) {
  console.log(bx.name.padEnd(30), bx.vis ? 'vis' : 'HID',
    `size=${bx.size.join(' x ').padEnd(24)}`, `min=${bx.min.join(',')}`.padEnd(30), `max=${bx.max.join(',')}`);
}
console.log(`\n=== raycast map, region ${REGION.join(',')} step ${STEP}px ===`);
for (const r of res.rows) console.log(String(r.py).padStart(4), r.line);
console.log(res.legend.join('\n'));

// Isolation renders.
const CANDS = (process.env.CANDS || '').split(',').filter(Boolean);
for (const cand of CANDS) {
  const seen = await p.evaluate((cand) => {
    const w = window.__leeward.world;
    const out = [];
    w.scene.traverse((o) => {
      if (!(o.isMesh || o.isLine || o.isPoints)) return;
      if (o.userData.__ov === undefined) o.userData.__ov = o.visible;
      const on = o.name === cand || o.name === 'sky';
      o.visible = on ? o.userData.__ov : false;
      if (o.name === cand) out.push(o.name);
    });
    return out;
  }, cand);
  await p.waitForTimeout(600);
  await p.screenshot({ path: `${OUT}/only-${cand}.png` });
  console.log('only', cand, JSON.stringify(seen));
}
if (CANDS.length) {
  await p.evaluate(() => {
    window.__leeward.world.scene.traverse((o) => {
      if (o.userData.__ov !== undefined) o.visible = o.userData.__ov;
    });
  });
}
await b.close();
console.log('done ->', OUT);
