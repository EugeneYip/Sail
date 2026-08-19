/**
 * Close-range look at the ship's materials IN THE SCENE, with the temporal and
 * blur passes off.
 *
 * scripts/capture.mjs cannot answer 'does the wood read as wood', because the
 * helm scene runs with motion blur on and the ship is under way: every crop of
 * the deck comes back smeared along the camera's motion, and the grain that the
 * GLSL probe measures at full amplitude is simply not in the image. So: freeze
 * the engine, turn off motion blur / TAA / grain / DoF, and shoot.
 *
 * These are the owner's two complaints, one frame each: the deck from the helm,
 * and the sails from the masthead.
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const OUT = process.env.OUT || '/tmp/matlook';
await mkdir(OUT, { recursive: true });

const SCENES = {
  helm: {
    env: { timeOfDay: 10.4, windSpeed: 9.0, cloudCover: 0.4, cloudType: 0.7, turbidity: 2.2, rain: 0, visibility: 30000, seaState: 3, waveHeight: 1.4, choppiness: 0.55 },
    cam: { mode: 'helm' },
  },
  masthead: {
    env: { timeOfDay: 11.4, windSpeed: 9.5, cloudCover: 0.42, cloudType: 0.75, turbidity: 2.2, rain: 0, visibility: 30000, seaState: 4, waveHeight: 1.8, choppiness: 0.6 },
    cam: { mode: 'masthead' },
  },
  bowsprit: {
    env: { timeOfDay: 12.2, windSpeed: 8.0, cloudCover: 0.35, cloudType: 0.7, turbidity: 2.2, rain: 0, visibility: 30000, seaState: 3, waveHeight: 1.2, choppiness: 0.5 },
    cam: { mode: 'bowsprit' },
  },
};

const b = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--force-color-profile=srgb', '--hide-scrollbars', '--mute-audio'],
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
p.on('console', (m) => { if (m.type() === 'error' && !/AudioContext/.test(m.text())) console.log('[err]', m.text().slice(0, 200)); });
p.setDefaultNavigationTimeout(240000);
p.setDefaultTimeout(120000);
await p.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => !!window.__leeward, null, { timeout: 120000 });

for (const [name, scene] of Object.entries(SCENES)) {
  await p.evaluate((sc) => {
    const w = window.__leeward.world;
    Object.assign(w.settings, {
      adaptiveResolution: false, renderScale: 1, showHud: false, antialias: 'off',
      filmGrain: false, motionBlur: false, depthOfField: false,
      chromaticAberration: false, lensDirt: false, quality: 3,
    });
    Object.assign(w.env, sc.env);
    Object.assign(w.cam, sc.cam);
    w.bus.emit('settings:changed');
    w.bus.emit('capture:scene', sc);
  }, scene);
  await p.waitForTimeout(10000);
  // Freeze so nothing moves between the settle and the shutter.
  await p.evaluate(() => {
    const e = window.__leeward;
    e.stop();
    for (let i = 0; i < 4; i++) { e.lastTime = performance.now(); e.tick(e.lastTime); }
  });
  await p.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`${OUT}/${name}.png`);
  await p.evaluate(() => window.__leeward.start && window.__leeward.start());
}
await b.close();
