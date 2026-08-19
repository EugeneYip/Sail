import { chromium } from 'playwright';

const SCENES = {
  noon: { timeOfDay: 12.7, windSpeed: 10.5, cloudCover: 0.38, turbidity: 2.0, visibility: 34000, seaState: 4, waveHeight: 2.0 },
  storm: { timeOfDay: 15.0, windSpeed: 22.0, cloudCover: 0.95, turbidity: 3.2, visibility: 5200, seaState: 7, waveHeight: 6.5 },
};

const msgs = new Map();
const b = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
p.on('console', (m) => {
  const t = m.text().slice(0, 200);
  msgs.set(t, (msgs.get(t) ?? 0) + 1);
});
p.on('pageerror', (e) => msgs.set('PAGEERROR ' + e.message.slice(0, 200), 1));
await p.addInitScript(() => {
  window.__warnStacks = [];
  const w = console.warn.bind(console);
  console.warn = (...a) => {
    if (String(a[0]).includes('defines')) window.__warnStacks.push(new Error('x').stack.split('\n').slice(1, 7).join(' | '));
    w(...a);
  };
});
await p.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => !!window.__leeward, null, { timeout: 60000 });
await p.evaluate(() => { window.__leeward.world.settings.debug = true; });

const out = {};
for (const [name, env] of Object.entries(SCENES)) {
  await p.evaluate((e) => {
    const w = window.__leeward.world;
    Object.assign(w.env, e);
    w.settings.adaptiveResolution = false;
    w.settings.debug = true;
    w.bus.emit('settings:changed');
  }, env);
  await p.waitForTimeout(9000);
  out[name] = await p.evaluate(async () => {
    const w = window.__leeward.world;
    const keys = Object.keys(w.stats).filter((k) => /^upd:|^vfx:/.test(k) && typeof w.stats[k] === 'number');
    const samples = {};
    for (const k of keys) samples[k] = [];
    for (let i = 0; i < 160; i++) {
      await new Promise((r) => requestAnimationFrame(() => r()));
      for (const k of keys) { const v = w.stats[k]; if (typeof v === 'number') samples[k].push(v); }
    }
    const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return s.length ? +s[Math.min(s.length - 1, Math.floor(s.length * q))].toFixed(2) : null; };
    const r = {};
    for (const k of keys) r[k] = [pct(samples[k], 0.5), pct(samples[k], 0.95), pct(samples[k], 1)];
    return {
      note: 'key: [p50, p95, max] ms',
      timings: r,
      fps: w.stats.fps,
      exposure: +w.uniforms.uExposure.value.toFixed(4),
      sunIntensity: +w.uniforms.uSunIntensity.value.toFixed(3),
      wakeStrength: w.ext.vfx?.wakeStrength,
    };
  });
}
console.log(JSON.stringify(out, null, 2));
console.log('--- console tallies ---');
for (const [t, n] of [...msgs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(String(n).padStart(4), t);
console.log('--- defines warn stacks ---');
for (const s of await p.evaluate(() => window.__warnStacks.slice(0, 4))) console.log(s);
await b.close();
