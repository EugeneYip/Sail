import { chromium } from 'playwright';
const b = await chromium.launch({ headless: true, args: ['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist','--enable-unsafe-swiftshader','--mute-audio'] });
const p = await b.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push('pageerror: ' + e.message.split('\n')[0]));
p.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().split('\n')[0]); });
await p.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });
let ok = false;
try { await p.waitForFunction(() => !!window.__leeward, null, { timeout: 25000 }); ok = true; } catch {}
console.log(ok ? 'BOOT OK' : 'BOOT FAILED');
for (const e of errs.slice(0, 6)) console.log('  ' + e.slice(0, 220));
await b.close();
process.exit(ok ? 0 : 1);
