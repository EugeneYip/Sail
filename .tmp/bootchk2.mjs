import { chromium } from 'playwright';
const b = await chromium.launch({ headless: true, args: ['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist','--enable-unsafe-swiftshader','--mute-audio'] });
const p = await b.newPage({ viewport: { width: 600, height: 400 } });
const errs = [];
p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
await p.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded', timeout: 60000 });
for (const s of [5, 15, 30, 60, 100]) {
  await p.waitForTimeout(s === 5 ? 5000 : 10000 + s * 100);
  const st = await p.evaluate(() => ({
    leeward: !!window.__leeward,
    bootFailed: document.body.innerText.startsWith('Boot failed'),
    text: document.body.innerText.slice(0, 200),
  }));
  console.log(`t~${s}s  leeward=${st.leeward}  bootFailed=${st.bootFailed}`);
  if (st.leeward) { console.log('  BOOTED'); break; }
  if (st.bootFailed) { console.log('  ' + st.text.replace(/\n/g, ' | ')); break; }
}
for (const e of [...new Set(errs)].slice(0, 10)) console.log('  ' + e.slice(0, 260));
await b.close();
