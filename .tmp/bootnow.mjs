import { chromium } from 'playwright';
const b = await chromium.launch({ headless: true, args: ['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist','--enable-unsafe-swiftshader','--mute-audio'] });
const p = await b.newPage({ viewport: { width: 640, height: 400 } });
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
await p.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded', timeout: 60000 });
let ok = false;
try { await p.waitForFunction(() => !!window.__leeward?.world?.ext?.physics, null, { timeout: 45000 }); ok = true; } catch {}
console.log(`boots: ${ok}`);
console.log(`errors: ${errs.length ? [...new Set(errs)].slice(0,3).join(' | ') : 'none'}`);
await b.close();
