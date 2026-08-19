/**
 * Phantom-slab hunt, attempt 4 (DIAGNOSIS 17A) — geometry, not pixels.
 *
 * Every earlier bisect used geometry.computeBoundingBox(), which is useless
 * here: the bow-wave sheet's 'position' attribute is (t, j, side) and the ocean
 * and islands are unit planes displaced in the vertex shader, so their boxes are
 * 1-2 m across for meshes that cover hundreds of metres.
 *
 * This transforms every real triangle into SHIP-LOCAL space (+X starboard, +Y
 * up, -Z forward) and reports anything sitting outboard of the hull at close to
 * sea level — i.e. exactly the shape the owner described. Instanced meshes are
 * expanded, so a single bad rope instance is caught and named by index.
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const OUT = process.env.OUT || '/tmp/slabgeom';
await mkdir(OUT, { recursive: true });

const b = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--force-color-profile=srgb', '--hide-scrollbars', '--mute-audio'],
});
const p = await b.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
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
await p.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => !!window.__leeward, null, { timeout: 120000 });
await p.evaluate(() => {
  const w = window.__leeward.world;
  w.settings.adaptiveResolution = false;
  Object.assign(w.env, { timeOfDay: 15.6, windSpeed: 9.0, seaState: 3, waveHeight: 1.5, choppiness: 0.55, visibility: 32000 });
  w.bus.emit('settings:changed');
});
await p.waitForTimeout(9000);

const res = await p.evaluate(() => {
  const w = window.__leeward.world;
  w.scene.updateMatrixWorld(true);
  const inv = w.shipRoot.matrixWorld.clone().invert().elements;
  const mul = (a, bm, o) => {
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += a[k * 4 + r] * bm[c * 4 + k];
        o[c * 4 + r] = s;
      }
    }
  };
  const xf = (e, x, y, z, out) => {
    out[0] = e[0] * x + e[4] * y + e[8] * z + e[12];
    out[1] = e[1] * x + e[5] * y + e[9] * z + e[13];
    out[2] = e[2] * x + e[6] * y + e[10] * z + e[14];
  };

  // Anything at |x| > OUTBOARD and below HIGH is outboard of the hull at close
  // to the waterline: no legitimate part of the ship lives there.
  const OUTBOARD = 9.0;
  const HIGH = 6.0;
  const report = [];
  const full = new Float64Array(16);
  const a = new Float64Array(3), bq = new Float64Array(3), c = new Float64Array(3);

  w.scene.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry;
    if (!g || !g.attributes || !g.attributes.position) return;
    // Skip the shader-displaced families; their attributes are not positions.
    const mn = (o.material && (o.material.name || o.material.type)) || '';
    if (/ocean-surface|world-terrain|world-shore/.test(mn)) return;
    if (o.material && o.material.type === 'RawShaderMaterial') return;
    if (o.name === 'sky') return;
    const pa = g.attributes.position;
    const index = g.index ? g.index.array : null;
    const triCount = index ? index.length / 3 : pa.count / 3;
    const instCount = o.isInstancedMesh ? o.count : 1;
    const instMat = o.isInstancedMesh ? o.instanceMatrix.array : null;

    // shipLocal = inv(shipRoot.matrixWorld) * o.matrixWorld
    const local = new Float64Array(16);
    mul(inv, o.matrixWorld.elements, local);

    const perInstance = [];
    for (let n = 0; n < instCount; n++) {
      let e = local;
      if (instMat) { mul(local, instMat.subarray(n * 16, n * 16 + 16), full); e = full; }
      let bad = 0;
      let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
      let maxAbsX = 0, maxAbsZ = 0;
      for (let i = 0; i < triCount; i++) {
        const i0 = index ? index[i * 3] : i * 3;
        const i1 = index ? index[i * 3 + 1] : i * 3 + 1;
        const i2 = index ? index[i * 3 + 2] : i * 3 + 2;
        xf(e, pa.getX(i0), pa.getY(i0), pa.getZ(i0), a);
        xf(e, pa.getX(i1), pa.getY(i1), pa.getZ(i1), bq);
        xf(e, pa.getX(i2), pa.getY(i2), pa.getZ(i2), c);
        const lowest = Math.min(a[1], bq[1], c[1]);
        const outb = Math.min(Math.abs(a[0]), Math.abs(bq[0]), Math.abs(c[0]));
        if (lowest < HIGH && outb > OUTBOARD) {
          bad++;
          for (const v of [a, bq, c]) {
            if (v[0] < mnx) mnx = v[0]; if (v[0] > mxx) mxx = v[0];
            if (v[1] < mny) mny = v[1]; if (v[1] > mxy) mxy = v[1];
            if (v[2] < mnz) mnz = v[2]; if (v[2] > mxz) mxz = v[2];
            if (Math.abs(v[0]) > maxAbsX) maxAbsX = Math.abs(v[0]);
            if (Math.abs(v[2]) > maxAbsZ) maxAbsZ = Math.abs(v[2]);
          }
        }
      }
      if (bad) {
        perInstance.push({
          inst: n, bad, tris: triCount,
          min: [mnx, mny, mnz].map((v) => +v.toFixed(2)),
          max: [mxx, mxy, mxz].map((v) => +v.toFixed(2)),
          size: [mxx - mnx, mxy - mny, mxz - mnz].map((v) => +v.toFixed(2)),
        });
      }
    }

    // Also the whole-mesh ship-local extent, for context.
    let Mnx = Infinity, Mny = Infinity, Mnz = Infinity, Mxx = -Infinity, Mxy = -Infinity, Mxz = -Infinity;
    for (let n = 0; n < instCount; n++) {
      let e = local;
      if (instMat) { mul(local, instMat.subarray(n * 16, n * 16 + 16), full); e = full; }
      for (let v = 0; v < pa.count; v++) {
        xf(e, pa.getX(v), pa.getY(v), pa.getZ(v), a);
        if (a[0] < Mnx) Mnx = a[0]; if (a[0] > Mxx) Mxx = a[0];
        if (a[1] < Mny) Mny = a[1]; if (a[1] > Mxy) Mxy = a[1];
        if (a[2] < Mnz) Mnz = a[2]; if (a[2] > Mxz) Mxz = a[2];
      }
    }

    report.push({
      name: o.name || `(anon:${mn})`,
      visible: o.visible,
      instCount, triCount,
      localMin: [Mnx, Mny, Mnz].map((v) => +v.toFixed(2)),
      localMax: [Mxx, Mxy, Mxz].map((v) => +v.toFixed(2)),
      offenders: perInstance,
    });
  });

  return {
    heel: +(w.ship.heel ?? 0).toFixed(3),
    heave: +(w.shipRoot.position.y ?? 0).toFixed(2),
    speed: +(w.ship.speed ?? 0).toFixed(2),
    report,
  };
});

await writeFile(`${OUT}/geom.json`, JSON.stringify(res, null, 2));
console.log('heel', res.heel, 'heave', res.heave, 'speed', res.speed);
console.log('\n=== ship-local extents of every solid mesh (+X stbd, +Y up, -Z fwd) ===');
for (const r of res.report) {
  console.log(r.name.padEnd(20), (r.visible ? 'vis' : 'HID'),
    `inst=${String(r.instCount).padStart(4)}`, `tris=${String(r.triCount).padStart(6)}`,
    `min=${r.localMin.join(',')}`.padEnd(28), `max=${r.localMax.join(',')}`);
}
console.log('\n=== OFFENDERS: triangles outboard of |x| > 9 m and below y = 6 m ===');
let any = false;
for (const r of res.report) {
  if (!r.offenders.length) continue;
  any = true;
  const totalBad = r.offenders.reduce((s, o) => s + o.bad, 0);
  console.log(`\n${r.name}: ${r.offenders.length} offending instance(s), ${totalBad} triangles`);
  for (const o of r.offenders.slice(0, 24)) {
    console.log(`   inst ${String(o.inst).padStart(4)}  bad=${String(o.bad).padStart(5)}/${o.tris}`,
      `min=${o.min.join(',')}`.padEnd(30), `max=${o.max.join(',')}`.padEnd(30), `size=${o.size.join(' x ')}`);
  }
  if (r.offenders.length > 24) console.log(`   ... ${r.offenders.length - 24} more`);
}
if (!any) console.log('(none — the slab is not solid ship geometry)');
await b.close();
console.log('\ndone ->', OUT);
