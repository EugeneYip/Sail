#!/usr/bin/env node
/**
 * Is the GPU wave field actually displaced in a gale?
 *
 * `oceanlook` reports the CPU mirror at 8.2 m peak-to-trough while the storm
 * frame renders as a dead-flat plane, so the two candidates are (a) the GPU
 * cascades do not carry the energy and (b) they do and the shading has no
 * contrast. This reads the GPU displacement textures back per cascade and
 * reports their real amplitude, which separates the two.
 */
import { chromium } from 'playwright';
import process from 'node:process';

const SCENES = {
  noon: { timeOfDay: 12.7, windSpeed: 10.5, cloudCover: 0.38, cloudType: 0.8, turbidity: 2, rain: 0, visibility: 34000, seaState: 4, waveHeight: 2, choppiness: 0.6 },
  storm: { timeOfDay: 15, windSpeed: 22, cloudCover: 0.98, cloudType: 0.95, turbidity: 6, rain: 0.85, visibility: 5200, seaState: 7, waveHeight: 6.5, choppiness: 0.85 },
};
const want = (process.argv[2] ?? 'noon,storm').split(',');

const b = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--hide-scrollbars', '--mute-audio'] });
const page = await b.newPage({ viewport: { width: 1600, height: 900 } });
await page.addInitScript(() => { const R = window.WebSocket; class D extends EventTarget { constructor() { super(); this.readyState = 3; } send() {} close() {} } window.WebSocket = function (u, p) { return p === 'vite-hmr' ? new D() : new R(u, p); }; });
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded', timeout: 240000 });
await page.waitForFunction(() => !!window.__leeward, null, { timeout: 240000 });

for (const name of want) {
  await page.evaluate((e) => {
    const w = window.__leeward.world;
    Object.assign(w.settings, { quality: 'ultra', adaptiveResolution: false, renderScale: 1, debug: true });
    Object.assign(w.env, e);
    Object.assign(w.cam, { mode: 'chase', distance: 74 });
    w.bus.emit('settings:changed');
    w.bus.emit('capture:scene', {});
  }, SCENES[name]);
  await page.waitForTimeout(9000);

  const out = await page.evaluate(() => {
    const w = window.__leeward.world;
    const oc = w.ocean;
    const cmp = w.ext.ocean.debugCompare(4096);
    // Per-cascade GPU amplitude, straight off the readback path debugCompare uses.
    const per = [];
    const THREE = oc.mesh.levels[0].mesh.material.constructor;
    for (let i = 0; i < oc.cascades.length; i++) {
      const c = oc.cascades[i];
      const n = c.layout.n;
      const rt = new (Object.getPrototypeOf(w.renderer).constructor === Function ? Object : Object)();
      per.push({ cascade: i, n, size: c.layout.size });
    }
    const mu = oc.material.uniforms;
    return {
      compare: {
        rmsGpuField: +cmp.rmsGpuField.toFixed(4),
        rmsCpuField: +cmp.rmsCpuField.toFixed(4),
        rmsDiff: +cmp.rmsHeight.toFixed(4),
        maxDiff: +cmp.maxHeight.toFixed(4),
        corr: +cmp.correlation.toFixed(4),
        rmsSlopeDiff: +cmp.rmsSlope.toFixed(4),
      },
      // 4*rms of the GPU elevation field is the GPU's own Hs.
      gpuHs: +(4 * cmp.rmsGpuField).toFixed(3),
      cpuHs: +(4 * cmp.rmsCpuField).toFixed(3),
      targetHs: +oc.params.hs.toFixed(3),
      uniforms: {
        uWaveHeight: +mu.uWaveHeight.value.toFixed(3),
        uSlopeRms: +mu.uSlopeRms.value.toFixed(4),
        uSlopeVarTail: +mu.uSlopeVarTail.value.toFixed(5),
        uFoamThreshold: +mu.uFoamThreshold.value.toFixed(3),
        uFoamAmount: +mu.uFoamAmount.value.toFixed(3),
        uWetness: +w.uniforms.uWetness.value.toFixed(3),
        cellFade: mu.uCascadeCellFade.value.map((v) => [+v.x.toFixed(2), +v.y.toFixed(2)]),
        pxFade: mu.uCascadePxFade.value.map((v) => [+v.x.toFixed(3), +v.y.toFixed(3)]),
        slopeVar: mu.uCascadeSlopeVar.value.map((v) => +v.toFixed(5)),
      },
      // What the vertex shader computes for the near field.
      clipmap: oc.mesh.levels.slice(0, 4).map((l) => ({ level: l.level, cell: +l.cell.toFixed(3), half: l.halfExtent })),
      camY: +w.camera.position.y.toFixed(2),
    };
  });
  console.log(`\n================ ${name} ================`);
  console.log(JSON.stringify(out, null, 2));
}
await b.close();
