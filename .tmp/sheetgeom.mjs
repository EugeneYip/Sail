/**
 * Numeric extent of the HullWater bow/quarter sheet, computed from the LIVE
 * uniforms by replaying the vertex shader on the CPU. The mesh's own bounding
 * box is meaningless (its 'position' attribute carries parameters, not points),
 * which is why the AABB sweep could not see this thing.
 */
import { chromium } from 'playwright';

const b = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
p.setDefaultTimeout(240000);
p.setDefaultNavigationTimeout(240000);
await p.addInitScript(() => {
  const R = window.WebSocket;
  window.WebSocket = function (u, pr) {
    if (pr === 'vite-hmr') return { readyState: 3, close() {}, send() {}, addEventListener() {}, removeEventListener() {} };
    return new R(u, pr);
  };
  window.WebSocket.prototype = R.prototype;
});
await p.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => !!window.__leeward, null, { timeout: 240000 });
await p.evaluate(() => {
  const w = window.__leeward.world;
  const scene = {
    env: { timeOfDay: 15.6, windSpeed: 9.0, cloudCover: 0.4, cloudType: 0.75, turbidity: 2.2, rain: 0, visibility: 32000, seaState: 3, waveHeight: 1.5, choppiness: 0.55 },
    cam: { mode: 'orbit', distance: 110 },
  };
  Object.assign(w.env, scene.env);
  Object.assign(w.cam, scene.cam);
  w.settings.adaptiveResolution = false;
  w.bus.emit('settings:changed');
  w.bus.emit('capture:scene', scene);
});
await p.waitForTimeout(12000);

console.log(JSON.stringify(await p.evaluate(() => {
  const w = window.__leeward.world;
  let mat = null;
  w.scene.traverse((o) => { if (o.name === 'vfx-bow-wave') mat = o.material; });
  if (!mat) return { error: 'vfx-bow-wave not found' };
  const u = mat.uniforms;
  const beam = u.uBeam.value, lwl = u.uLwl.value, speed = u.uSpeed.value;
  const speedN = u.uSpeedN.value, heel = u.uHeel.value, slam = u.uSlam.value;
  const halfBeamAt = (t) => {
    const uu = Math.min(1, Math.max(0, t));
    const fwd = Math.pow(Math.sin(Math.PI * Math.pow(uu, 0.58)), 0.62);
    const transom = 0.42 + 0.58 * (1 - (uu <= 0.72 ? 0 : uu >= 1 ? 1 : (() => { const x = (uu - 0.72) / 0.28; return x * x * (3 - 2 * x); })()));
    return beam * 0.5 * fwd * transom;
  };
  const smoothstep = (a, b2, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b2 - a))); return t * t * (3 - 2 * t); };
  const stag = speed * speed / 19.62;
  const out = { beam, lwl, speed: +speed.toFixed(3), speedN: +speedN.toFixed(3), heelDeg: +(heel * 180 / Math.PI).toFixed(2), slam: +slam.toFixed(3), stag: +stag.toFixed(3), rows: [] };
  let maxOut = 0, maxY = 0, maxOutT = 0;
  for (let side of [-1, 1]) {
    for (let i = 0; i <= 40; i++) {
      const t = Math.pow(i / 40, 1.45);
      const hb = halfBeamAt(t);
      const lee = Math.sign(heel) * side;
      const heelGain = 1 + lee * Math.min(Math.abs(heel) * 4.2, 1.1);
      const bowBump = Math.exp(-Math.pow((t - 0.085) / 0.150, 2));
      const quarter = 0.5 * Math.exp(-Math.pow((t - 0.80) / 0.14, 2));
      const slamGain = 1 + Math.min(slam * 0.05, 1.4);
      const crest = stag * (0.80 * bowBump * slamGain + quarter) * heelGain * smoothstep(0.03, 0.30, speedN);
      const width = (1.4 + crest * 1.55) * heelGain;
      // j = 1 -> the tip of the lip: over = 1, so the widest point.
      const outb = hb + width * (1 * 0.9 + 1 * 0.7);
      const curl = 0.55 + 0.55 * speedN;
      const y = crest * (1 - curl);
      if (outb > maxOut) { maxOut = outb; maxOutT = t; }
      if (Math.abs(crest) > Math.abs(maxY)) maxY = crest;
      if (i % 8 === 0) out.rows.push({ side, t: +t.toFixed(3), hb: +hb.toFixed(2), heelGain: +heelGain.toFixed(2), crest: +crest.toFixed(2), width: +width.toFixed(2), outb: +outb.toFixed(2), tipY: +y.toFixed(2) });
    }
  }
  out.maxOutboardFromCentreline_m = +maxOut.toFixed(2);
  out.maxOutboardAt_t = +maxOutT.toFixed(3);
  out.totalSheetWidth_m = +(maxOut * 2).toFixed(2);
  out.hullBeam_m = beam;
  out.maxCrestHeight_m = +maxY.toFixed(2);
  return out;
}), null, 1));
await b.close();
