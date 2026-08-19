/**
 * Inventory every drawable in the scene with its WORLD-space bounding box, so a
 * thin horizontal slab can be found by geometry instead of by guesswork
 * (DIAGNOSIS section 17 defect A). Prints sorted by "slabbiness".
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const OUT = process.env.SLAB_OUT || '/tmp/slabid';
await mkdir(OUT, { recursive: true });

const b = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--force-color-profile=srgb', '--hide-scrollbars'],
});
const p = await b.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
await p.addInitScript(() => {
  const R = window.WebSocket;
  window.WebSocket = function (u, pr) {
    if (pr === 'vite-hmr') return { readyState: 3, close() {}, send() {}, addEventListener() {}, removeEventListener() {} };
    return new R(u, pr);
  };
  window.WebSocket.prototype = R.prototype;
});
p.on('console', (m) => { if (m.type() === 'error') console.log('[page error]', m.text().slice(0, 200)); });
p.setDefaultNavigationTimeout(180000);
await p.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded', timeout: 180000 });
await p.waitForFunction(() => !!window.__leeward, null, { timeout: 60000 });

await p.evaluate(() => {
  const w = window.__leeward.world;
  w.settings.adaptiveResolution = false;
  w.settings.renderScale = 1;
  w.settings.showHud = false;
  Object.assign(w.env, { timeOfDay: 15.6, windSpeed: 9.0, cloudCover: 0.4, cloudType: 0.75, turbidity: 2.2, rain: 0, visibility: 32000, seaState: 3, waveHeight: 1.5, choppiness: 0.55 });
  Object.assign(w.cam, { mode: 'orbit', distance: 110 });
  w.bus.emit('settings:changed');
});
await p.waitForTimeout(10000);

const inv = await p.evaluate(() => {
  const THREE = window.__leeward.THREE ?? null;
  const w = window.__leeward.world;
  const rows = [];
  let i = 0;
  const min = [0, 0, 0];
  const max = [0, 0, 0];
  w.scene.updateMatrixWorld(true);
  w.scene.traverse((o) => {
    if (!(o.isMesh || o.isLine || o.isPoints || o.isSprite)) return;
    o.userData.__sid = i;
    const g = o.geometry;
    let box = null;
    if (g && g.attributes && g.attributes.position) {
      if (!g.boundingBox) g.computeBoundingBox();
      const bb = g.boundingBox;
      const e = o.matrixWorld.elements;
      for (let k = 0; k < 3; k++) { min[k] = Infinity; max[k] = -Infinity; }
      for (let c = 0; c < 8; c++) {
        const x = (c & 1) ? bb.max.x : bb.min.x;
        const y = (c & 2) ? bb.max.y : bb.min.y;
        const z = (c & 4) ? bb.max.z : bb.min.z;
        const wx = e[0] * x + e[4] * y + e[8] * z + e[12];
        const wy = e[1] * x + e[5] * y + e[9] * z + e[13];
        const wz = e[2] * x + e[6] * y + e[10] * z + e[14];
        const v = [wx, wy, wz];
        for (let k = 0; k < 3; k++) { if (v[k] < min[k]) min[k] = v[k]; if (v[k] > max[k]) max[k] = v[k]; }
      }
      box = { min: min.slice(), max: max.slice() };
    }
    const chain = [];
    for (let q = o.parent; q; q = q.parent) chain.push(q.name || q.type);
    rows.push({
      sid: i,
      type: o.type,
      name: o.name || '(anon)',
      mat: (o.material && (o.material.name || o.material.type)) || '?',
      side: o.material ? o.material.side : -1,
      transparent: o.material ? !!o.material.transparent : false,
      depthWrite: o.material ? o.material.depthWrite : null,
      visible: o.visible,
      parentName: o.parent ? (o.parent.name || o.parent.type) : '',
      chain: chain.join(' < '),
      renderOrder: o.renderOrder,
      tris: g && g.index ? g.index.count / 3 : (g && g.attributes && g.attributes.position ? g.attributes.position.count / 3 : 0),
      inst: o.isInstancedMesh ? o.count : (g && g.instanceCount) || 0,
      box,
      size: box ? [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]] : null,
      center: box ? [(box.max[0] + box.min[0]) / 2, (box.max[1] + box.min[1]) / 2, (box.max[2] + box.min[2]) / 2] : null,
      frustumCulled: o.frustumCulled,
    });
    i++;
  });
  return rows;
});
await writeFile(`${OUT}/inventory.json`, JSON.stringify(inv, null, 2));

const f = (n, w = 7) => (n === undefined || n === null ? '-'.padStart(w) : n.toFixed(1).padStart(w));
console.log('\n=== all drawables, world AABB (m) ===');
console.log('sid name                        vis type            sx      sy      sz      cx      cy      cz  parent');
for (const r of inv) {
  console.log(
    String(r.sid).padStart(3),
    r.name.padEnd(27),
    (r.visible ? 'y' : 'N').padEnd(3),
    r.type.padEnd(14),
    f(r.size?.[0]), f(r.size?.[1]), f(r.size?.[2]),
    f(r.center?.[0]), f(r.center?.[1]), f(r.center?.[2]),
    ' ', r.parentName,
  );
}

const BEAM = 13.3;
console.log('\n=== SLAB CANDIDATES: sy < 3 m, max(sx,sz) > 13.3 m, |cy| < 12 m, footprint < 400 m ===');
const cands = inv.filter((r) => {
  if (!r.size) return false;
  const [sx, sy, sz] = r.size;
  const wide = Math.max(sx, sz);
  return sy < 3 && wide > BEAM && wide < 400 && Math.abs(r.center[1]) < 12;
});
for (const r of cands) {
  console.log(
    String(r.sid).padStart(3), r.name.padEnd(27), (r.visible ? 'vis' : 'HID'),
    `size=${r.size.map((v) => v.toFixed(2)).join(' x ')}`,
    `centre=${r.center.map((v) => v.toFixed(2)).join(',')}`,
    `mat=${r.mat}`, `tris=${Math.round(r.tris)}`, `parent=${r.parentName}`,
  );
}
if (!cands.length) console.log('(none)');

await b.close();
