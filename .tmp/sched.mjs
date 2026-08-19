import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist','--enable-unsafe-swiftshader','--force-color-profile=srgb','--hide-scrollbars','--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.log('PAGEERR', e.message.slice(0,200)));
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLEERR', m.text().slice(0,200)); });
await page.addInitScript(() => { const R = window.WebSocket; class D { constructor(){ this.readyState=3; this.close=()=>{}; this.send=()=>{}; this.addEventListener=()=>{}; this.removeEventListener=()=>{}; } } window.WebSocket = function(u,p){ return p==='vite-hmr'? new D(): new R(u,p); }; window.WebSocket.prototype = R.prototype; });
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded', timeout: 240000 });
await page.waitForFunction(() => !!window.__leeward, null, { timeout: 300000 });
const scenes = { noon:{ timeOfDay:12.7, windSpeed:10.5, seaState:4, waveHeight:2.0, choppiness:0.6, visibility:34000 }, storm:{ timeOfDay:15.0, windSpeed:22.0, seaState:7, waveHeight:6.5, choppiness:0.85, rain:0.85, visibility:5200 } };
for (const [nm, env] of Object.entries(scenes)) {
  await page.evaluate((e) => { const w = window.__leeward.world; w.settings.quality='ultra'; w.settings.renderScale=1; w.settings.adaptiveResolution=false; Object.assign(w.env, e); w.cam.mode='chase'; w.cam.distance=74; w.bus.emit('settings:changed'); }, env);
  await page.waitForTimeout(7000);
  const out = await page.evaluate(() => {
    const w = window.__leeward.world;
    let m = null; w.scene.traverse((o) => { if (o.material && o.material.name === 'ocean-surface') m = o.material; });
    const u = m.uniforms;
    const cam = w.camera;
    const pitchDown = -Math.asin(Math.max(-1, Math.min(1, -cam.matrixWorld.elements[9])));
    const th = Math.tan((cam.fov * Math.PI) / 360);
    const H = 900, camY = cam.position.y;
    const pxAngle = u.uPixelAngle.value;
    const rms = u.uSlopeRms.value, tail = u.uSlopeVarTail.value;
    const sv = u.uCascadeSlopeVar.value.slice();
    const pf = u.uCascadePxFade.value.map((v) => [v.x, v.y]);
    const tx = u.uCascadeTexels.value.slice();
    const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
    const rows = [];
    for (const row of [360, 380, 400, 420, 450, 500, 560, 640, 720, 800, 870]) {
      const dep = pitchDown + Math.atan(((row + 0.5 - H / 2) / (H / 2)) * th);
      if (dep <= 1e-5) continue;
      const d = camY / Math.tan(dep);
      const dist = Math.hypot(d, camY);
      const px = Math.max(dist * pxAngle, 1e-3);
      const Vy = camY / dist;
      const maj = Math.min(px / Math.max(Vy, 0.004), 1e5);
      let lv = tail, lm = tail;
      for (let i = 0; i < sv.length; i++) { lv += sv[i] * ss(pf[i][0], pf[i][1], px); lm += sv[i] * ss(pf[i][0], pf[i][1], maj); }
      const den = Math.max(rms * rms - tail, 1e-5);
      rows.push({ row, d: Math.round(d), px: +px.toFixed(3), maj: +maj.toFixed(2), ratio: +(1/Vy).toFixed(1),
        lostVar: +lv.toFixed(5), lostMaj: +lm.toFixed(5),
        macro: +Math.min(1, Math.max(0, (lm - tail) / den)).toFixed(3),
        glitOld: +ss(45, 850, dist).toFixed(3),
        aTight: +Math.sqrt(lv).toFixed(3), aR: +Math.sqrt(lm).toFixed(3) });
    }
    return { camY: +camY.toFixed(1), pxAngle: +pxAngle.toFixed(6), rms: +rms.toFixed(4), rms2: +(rms*rms).toFixed(5), tail: +tail.toFixed(5),
      tailFrac: +(tail/(rms*rms)).toFixed(3), slopeVar: sv.map(v=>+v.toFixed(5)), pxFade: pf.map(p=>p.map(v=>+v.toFixed(3))), texels: tx.map(v=>+v.toFixed(3)), rows };
  });
  console.log(`\n=== ${nm} ===`);
  console.log(`camY=${out.camY} pxAngle=${out.pxAngle} slopeRms=${out.rms} rms^2=${out.rms2} tail=${out.tail} tail/rms^2=${out.tailFrac}`);
  console.log(`cascadeSlopeVar=${JSON.stringify(out.slopeVar)}  sum=${out.slopeVar.reduce((a,b)=>a+b,0).toFixed(5)}`);
  console.log(`pxFade(m)=${JSON.stringify(out.pxFade)}  texels/m=${JSON.stringify(out.texels)}`);
  console.log('row  dist   px      major   ratio  lostVar  lostMaj  macro  glitOld  aTight  alphaR');
  for (const r of out.rows) console.log(`${String(r.row).padStart(4)} ${String(r.d).padStart(5)} ${String(r.px).padStart(7)} ${String(r.maj).padStart(8)} ${String(r.ratio).padStart(6)} ${String(r.lostVar).padStart(8)} ${String(r.lostMaj).padStart(8)} ${String(r.macro).padStart(6)} ${String(r.glitOld).padStart(8)} ${String(r.aTight).padStart(7)} ${String(r.aR).padStart(7)}`);
}
await browser.close();
