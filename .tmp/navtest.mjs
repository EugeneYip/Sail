import { chromium } from 'playwright';
const b = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required','--enable-unsafe-swiftshader'] });
const p = await b.newPage();
p.on('console', m => { if (m.type()==='error') console.log('ERR', m.text().slice(0,200)); });
const t0 = Date.now();
try {
  await p.goto('http://127.0.0.1:5178/', { waitUntil: 'commit', timeout: 30000 });
  console.log('commit', Date.now()-t0, 'ms');
  await p.waitForFunction(() => !!document.querySelector('#viewport'), null, { timeout: 30000 });
  console.log('dom', Date.now()-t0, 'ms');
  const ok = await p.evaluate(async () => { try { await import('/src/audio/Probe.ts'); return 'probe-ok'; } catch (e) { return 'probe-fail: '+e.message; } });
  console.log(ok, Date.now()-t0, 'ms');
  const eng = await p.waitForFunction(() => !!window.__leeward?.world?.ext?.audio, null, { timeout: 40000 }).then(()=> 'engine-up').catch(()=>'engine-down');
  console.log(eng, Date.now()-t0, 'ms');
} catch (e) { console.log('FAIL', e.message.slice(0,300), Date.now()-t0); }
await b.close();
