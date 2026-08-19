import { chromium } from 'playwright';
const b = await chromium.launch({ headless: true, args: ['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist','--hide-scrollbars','--mute-audio'] });
const p = await b.newPage({ viewport: { width: 800, height: 450 } });
const errs = [];
p.on('console', m => { if (m.type()==='error') errs.push(m.text().slice(0,300)); });
p.on('pageerror', e => errs.push('PAGEERROR: ' + e.message.slice(0,300)));
await p.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded', timeout: 300000 });
try { await p.waitForFunction(() => !!window.__leeward, null, { timeout: 180000 }); console.log('world booted OK'); }
catch { console.log('WORLD NEVER BOOTED'); }
const st = await p.evaluate(() => { const w = window.__leeward && window.__leeward.world; return w ? { frame: w.time.frame, hasOcean: !!w.ocean, oceanStat: w.stats['upd:ocean'] } : null; }).catch(()=>null);
console.log('state:', JSON.stringify(st));
console.log('errors(' + errs.length + '):'); errs.slice(0,12).forEach(e=>console.log('  ', e));
await b.close();
