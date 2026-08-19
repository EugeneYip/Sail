import { chromium } from 'playwright';
const b = await chromium.launch({ headless: true, args: ['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist','--enable-unsafe-swiftshader'] });
const p = await (await b.newContext({ viewport: { width: 800, height: 450 } })).newPage();
p.on('console', m => console.log('[c]', m.type(), m.text().slice(0, 300)));
p.on('pageerror', e => console.log('[E]', e.message.slice(0, 400)));
await p.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });
try { await p.waitForFunction(() => !!window.__leeward, null, { timeout: 45000 }); console.log('BOOTED'); }
catch { console.log('NO __leeward after 45s'); }
console.log('html len', (await p.content()).length);
await b.close();
