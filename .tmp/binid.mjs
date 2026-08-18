import { chromium } from 'playwright';
const b = await chromium.launch({ headless:true, args:['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist','--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport:{width:1600,height:900} });
await p.addInitScript(() => { const R=window.WebSocket; window.WebSocket=function(u,pr){ if(pr==='vite-hmr') return {readyState:3,close(){},send(){},addEventListener(){},removeEventListener(){}}; return new R(u,pr);}; window.WebSocket.prototype=R.prototype; });
await p.goto('http://127.0.0.1:5178/', { waitUntil:'domcontentloaded' });
await p.waitForFunction(()=>!!window.__leeward, null, {timeout:60000});
await p.evaluate(()=>{ const w=window.__leeward.world; Object.assign(w.env,{timeOfDay:15.6,windSpeed:9,cloudCover:0.4,turbidity:2.2,visibility:32000,seaState:3,waveHeight:1.5}); w.cam.mode='orbit'; w.cam.distance=110; w.settings.showHud=true; w.settings.adaptiveResolution=false; w.settings.renderScale=1; w.bus.emit('settings:changed'); });
await p.waitForTimeout(6000);
await p.evaluate(()=>{
  const w = window.__leeward.world;
  const COL = { 'ship-copper':0xff0000, 'ship-black':0x00ff00, 'ship-stripe':0x0000ff, 'ship-buff':0xffff00, 'ship-deck':0xff00ff, 'ship-oak':0x00ffff, 'ship-iron':0xff8800, 'ship-brass':0x8800ff, 'ship-glass':0xffffff };
  w.shipRoot.traverse((o)=>{
    if(!o.isMesh || !(o.name in COL)) return;
    o.material.emissive.setHex(COL[o.name]);
    o.material.emissiveIntensity = 3.0;
  });
});
await p.waitForTimeout(2500);
await p.screenshot({ path: process.argv[2], animations: 'allow' });
await b.close();
