/**
 * Name the owner of the stray waterline line (DIAGNOSIS section 8 defect 5).
 * Hides the whole ship, then bisects the remaining draw objects, detecting the
 * line numerically: a dark, near-horizontal run of pixels spanning the frame.
 * Pixels are scored in the page via canvas, so there is no image-decode dep.
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const OUT = process.env.STRAY_OUT || '/tmp/strayid';
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
await p.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });
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
await p.waitForTimeout(9000);

const inv = await p.evaluate(() => {
  const w = window.__leeward.world;
  const rows = [];
  let i = 0;
  w.scene.traverse((o) => {
    if (!(o.isMesh || o.isLine || o.isPoints)) return;
    o.userData.__sid = i;
    const g = o.geometry;
    const chain = [];
    for (let q = o.parent; q; q = q.parent) chain.push(q.name || q.type);
    rows.push({
      sid: i,
      type: o.type,
      name: o.name || '(anon)',
      mat: (o.material && (o.material.name || o.material.type)) || '?',
      shader: (o.material && o.material.customProgramCacheKey && o.material.customProgramCacheKey()) || '',
      tris: g && g.index ? g.index.count / 3 : (g && g.attributes.position ? g.attributes.position.count / 3 : 0),
      inst: o.isInstancedMesh ? o.count : (g && g.instanceCount) || 0,
      chain: chain.join(' < '),
      renderOrder: o.renderOrder,
    });
    i++;
  });
  return rows;
});
await writeFile(`${OUT}/inventory.json`, JSON.stringify(inv, null, 2));
console.log('sid type              name              material/shader        tris    inst  ancestry');
for (const r of inv) {
  console.log(
    String(r.sid).padEnd(3),
    r.type.padEnd(17),
    r.name.padEnd(17),
    `${r.mat}${r.shader ? '/' + r.shader : ''}`.padEnd(22),
    String(Math.round(r.tris)).padStart(7),
    String(r.inst).padStart(5),
    r.chain,
  );
}

const setBySid = (sids, v) => p.evaluate(({ sids, v }) => {
  const w = window.__leeward.world;
  const want = new Set(sids);
  let n = 0;
  w.scene.traverse((o) => {
    if (!(o.isMesh || o.isLine || o.isPoints)) return;
    if (want.has(o.userData.__sid)) { o.visible = v; n++; }
  });
  return n;
}, { sids, v });

/**
 * Score the stray line: for each row, count columns markedly darker than the
 * rows 4 px above and below. A smooth vertical gradient scores ~0; a thin dark
 * streak spanning the frame scores near 1.
 */
async function lineScore(tag) {
  await p.waitForTimeout(1200);
  const buf = await p.screenshot({ animations: 'allow', clip: { x: 0, y: 330, width: 1600, height: 320 } });
  await writeFile(`${OUT}/${tag}.png`, buf);
  const dataUrl = `data:image/png;base64,${buf.toString('base64')}`;
  const r = await p.evaluate(async (url) => {
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const cx = c.getContext('2d', { willReadFrequently: true });
    cx.drawImage(img, 0, 0);
    const d = cx.getImageData(0, 0, c.width, c.height).data;
    const lum = (y, x) => {
      const yy = Math.max(0, Math.min(c.height - 1, y));
      const i = (yy * c.width + x) * 4;
      return 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    };
    let best = 0; let bestRow = -1;
    for (let y = 0; y < c.height; y++) {
      let dark = 0;
      for (let x = 0; x < c.width; x++) {
        if (lum(y, x) < Math.min(lum(y - 4, x), lum(y + 4, x)) - 9) dark++;
      }
      const f = dark / c.width;
      if (f > best) { best = f; bestRow = y; }
    }
    return { best, bestRow };
  }, dataUrl);
  console.log(`${tag.padEnd(30)} lineScore=${r.best.toFixed(3)} at y=${r.bestRow + 330}`);
  return r.best;
}

const shipSids = inv.filter((r) => /^ship-/.test(r.name)).map((r) => r.sid);
const vfxSids = inv.filter((r) => /^vfx-/.test(r.name)).map((r) => r.sid);
const rest = inv.filter((r) => !/^ship-|^vfx-/.test(r.name)).map((r) => r.sid);

const base = await lineScore('0-baseline');
await setBySid(shipSids, false);
const noShip = await lineScore('1-ship-hidden');
await setBySid(vfxSids, false);
await lineScore('2-ship+vfx-hidden');

console.log(`\nbaseline=${base.toFixed(3)} shipHidden=${noShip.toFixed(3)} -> stray line is ${noShip > 0.3 ? 'NOT the ship' : 'possibly the ship'}\n`);

for (const sid of rest) {
  const row = inv.find((r) => r.sid === sid);
  await setBySid([sid], false);
  const s = await lineScore(`3-without-sid${sid}-${row.name}`);
  if (s < 0.3) {
    console.log(`\n>>> STRAY LINE OWNER: sid ${sid} ${JSON.stringify(row)}`);
    break;
  }
  await setBySid([sid], true);
}

await b.close();
