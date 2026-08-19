import { chromium } from 'playwright';
const b = await chromium.launch({ headless: true, args: ['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist','--enable-unsafe-swiftshader','--mute-audio'] });
const p = await b.newPage({ viewport: { width: 800, height: 450 } });
p.setDefaultTimeout(300000);
const logs = [];
p.on('pageerror', e => logs.push('PAGEERROR: ' + e.message.slice(0,500)));
p.on('console', m => { if (m.type() === 'error') logs.push('CONSOLE: ' + m.text().slice(0,500)); });
const t0 = Date.now();
await p.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded', timeout: 300000 });
console.log('goto ok in', ((Date.now()-t0)/1000).toFixed(1), 's');
let ok = false;
try { await p.waitForFunction(() => !!window.__leeward, null, { timeout: 300000 }); ok = true; } catch {}
console.log('booted:', ok, 'after', ((Date.now()-t0)/1000).toFixed(1), 's');
if (ok) console.log('mode:', await p.evaluate(() => window.__leeward.world.cam.mode));
for (const l of logs.slice(0, 12)) console.log(l);
await b.close();
