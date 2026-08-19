import { chromium } from 'playwright';
const b = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required','--enable-unsafe-swiftshader'] });
const p = await b.newPage();
for (const pat of ['**://fonts.googleapis.com/**','**://fonts.gstatic.com/**']) await p.route(pat, r => r.abort());
await p.goto('http://127.0.0.1:5178/', { waitUntil: 'commit' });
await p.waitForSelector('#viewport');
const r = await p.evaluate(async () => { try { const m = await import('/src/audio/Probe.ts'); return 'ok ' + Object.keys(m).join(','); } catch (e) { return 'FAIL ' + e.message + ' | ' + (e.stack||'').slice(0,400); } });
console.log(r);
await b.close();
