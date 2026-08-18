import { chromium } from 'playwright';

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 560 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });

await page.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__leeward, null, { timeout: 60000 });
console.log('booted');
await page.waitForTimeout(6000);

const out = await page.evaluate(() => {
  const w = window.__leeward.world;
  const s = w.ship;
  const px = w.ext.physics;
  return {
    fps: w.time.fps,
    initPhysics: w.stats['init:physics'],
    physicsMs: w.stats['physics:ms'],
    substeps: w.stats['physics:substeps'],
    stats: Object.fromEntries(Object.entries(w.stats).filter(([k]) => /ms|upd:|init:/.test(k)).map(([k, v]) => [k, +v.toFixed(2)])),
    knots: +s.speedKnots.toFixed(2),
    heelDeg: +(s.heel * 180 / Math.PI).toFixed(2),
    pitchDeg: +(s.pitch * 180 / Math.PI).toFixed(2),
    headingDeg: +(s.heading * 180 / Math.PI).toFixed(1),
    posY: +s.position.y.toFixed(3),
    leewayDeg: +(s.leeway * 180 / Math.PI).toFixed(2),
    awa: +(s.apparentWindAngle * 180 / Math.PI).toFixed(1),
    aws: +s.apparentWindSpeed.toFixed(2),
    pos: s.pointOfSail,
    irons: s.inIrons,
    bowSlam: +s.bowSlam.toFixed(2),
    sailArea: +s.sailArea.toFixed(0),
    rudderDeg: +(s.rudder * 180 / Math.PI).toFixed(1),
    windBearing: +(w.env.windBearing * 180 / Math.PI).toFixed(1),
    windSpeed: w.env.windSpeed,
    hydro: px ? {
      panels: px.panels,
      volume: +px.volume.toFixed(0),
      waterSpeed: +px.waterSpeed.toFixed(2),
      resistance: +(px.resistance / 1000).toFixed(1),
      rigForce: +(px.rigForce / 1000).toFixed(1),
      sailLevel: +px.sailLevel.toFixed(2),
      hs: {
        floatY: +px.hydrostatics.floatY.toFixed(3),
        volume: +px.hydrostatics.volume.toFixed(0),
        kb: +px.hydrostatics.kb.toFixed(2),
        bm: +px.hydrostatics.bm.toFixed(2),
        gm: +px.hydrostatics.gm.toFixed(2),
        rollPeriod: +px.hydrostatics.rollPeriod.toFixed(2),
        gz: px.hydrostatics.gz.map((g) => +g.toFixed(2)),
      },
    } : null,
    sails: w.ship.sails.map((s) => `${s.id} set=${s.set.toFixed(2)} brace=${(s.brace * 180 / Math.PI).toFixed(0)} luff=${s.luff.toFixed(2)} f=${(s.force / 1000).toFixed(0)}kN camber=${s.camber.toFixed(2)}`),
  };
});
console.log(JSON.stringify(out, null, 2));
if (errors.length) console.log('ERRORS:\n' + [...new Set(errors)].slice(0, 12).join('\n'));
await browser.close();
