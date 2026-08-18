/**
 * Close-up sail verification. Pins SailState fields with read-only accessors so
 * the rig solver cannot overwrite the test trim, then shoots a close orbit for
 * each of: full-and-drawing, deep camber, luffing, reefed, furled, profile.
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const OUT = process.env.SAIL_OUT || '/tmp/sailprobe';
await mkdir(OUT, { recursive: true });

const b = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--force-color-profile=srgb', '--hide-scrollbars'],
});
const p = await b.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
await p.addInitScript(() => {
  const R = window.WebSocket;
  window.WebSocket = function (u, pr) {
    if (pr === 'vite-hmr') return { readyState: 3, close() {}, send() {}, addEventListener() {}, removeEventListener() {} };
    return new R(u, pr);
  };
  window.WebSocket.prototype = R.prototype;
});
const logs = [];
p.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
p.on('pageerror', (e) => logs.push('pageerror: ' + e.message));

await p.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded', timeout: 120000 });
await p.waitForFunction(() => !!window.__leeward, null, { timeout: 90000 });

const setup = (dist) => p.evaluate((d) => {
  const w = window.__leeward.world;
  w.settings.adaptiveResolution = false;
  w.settings.renderScale = 1;
  w.settings.showHud = false;
  Object.assign(w.env, {
    timeOfDay: 15.2, windSpeed: 9.0, cloudCover: 0.3, cloudType: 0.7, turbidity: 2.0,
    rain: 0, visibility: 60000, seaState: 3, waveHeight: 1.4, choppiness: 0.5,
  });
  Object.assign(w.cam, { mode: 'orbit', distance: d });
  w.bus.emit('settings:changed');
}, dist);

/** Pin a field so the rig solver's writes are discarded. */
const pin = (field, valueSrc) => p.evaluate(({ field, valueSrc }) => {
  const w = window.__leeward.world;
  const f = new Function('s', 'i', 'return (' + valueSrc + ');');
  w.ship.sails.forEach((s, i) => {
    const v = f(s, i);
    Object.defineProperty(s, field, { configurable: true, get: () => v, set: () => {} });
  });
}, { field, valueSrc });

const unpin = (field) => p.evaluate((field) => {
  const w = window.__leeward.world;
  w.ship.sails.forEach((s) => {
    const v = s[field];
    delete s[field];
    s[field] = v;
  });
}, field);

await setup(52);
await p.waitForTimeout(9000);

console.log(JSON.stringify(await p.evaluate(() => {
  const w = window.__leeward.world;
  const meshes = [];
  w.scene.traverse((o) => {
    if (o.isMesh && /sail/.test(o.name)) {
      meshes.push({
        name: o.name, inst: o.geometry.instanceCount,
        verts: o.geometry.attributes.position.count, visible: o.visible,
      });
    }
  });
  return {
    meshes,
    sails: w.ship.sails.map((s) => [s.id, +s.set.toFixed(2), +s.brace.toFixed(2), +s.luff.toFixed(2), +s.camber.toFixed(2)]),
    stats: Object.fromEntries(Object.entries(w.stats).filter(([k]) => /ship|draw|^tri/.test(k))),
  };
}), null, 1));

async function shoot(tag) {
  await p.waitForTimeout(1400);
  await p.screenshot({ path: `${OUT}/${tag}.png`, animations: 'allow' });
  console.log('wrote', tag);
}

await shoot('a-asis');

await pin('luff', '0');
await pin('set', '1');
await pin('camber', 's.camber < 0 ? -0.4 : 0.4');
await shoot('b-camber');

await unpin('camber');
await pin('camber', 's.camber < 0 ? -0.06 : 0.06');
await pin('luff', '1');
await shoot('c-luff');

await unpin('luff');
await unpin('camber');
await pin('luff', '0');
await pin('camber', 's.camber < 0 ? -0.3 : 0.3');
await unpin('set');
await pin('set', '0.55');
await shoot('d-reef');

await unpin('set');
await pin('set', 'i % 3 === 0 ? 0.04 : (i % 3 === 1 ? 0.4 : 1.0)');
await shoot('e-furl-mixed');

await unpin('set');
await pin('set', '1');
await setup(150);
await p.waitForTimeout(3000);
await shoot('f-profile');

console.log('console errors:', logs.length);
for (const l of logs.slice(0, 10)) console.log('  ', l.slice(0, 180));
await b.close();
