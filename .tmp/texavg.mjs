import { chromium } from 'playwright';
const b = await chromium.launch({ headless:true, args:['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist','--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport:{width:1280,height:720} });
await p.addInitScript(() => { const R=window.WebSocket; window.WebSocket=function(u,pr){ if(pr==='vite-hmr') return {readyState:3,close(){},send(){},addEventListener(){},removeEventListener(){}}; return new R(u,pr);}; window.WebSocket.prototype=R.prototype; });
await p.goto('http://127.0.0.1:5178/', { waitUntil:'domcontentloaded' });
await p.waitForFunction(()=>!!window.__leeward, null, {timeout:60000});
await p.waitForTimeout(2500);
console.log(JSON.stringify(await p.evaluate(()=>{
  const w = window.__leeward.world;
  const out = [];
  w.shipRoot.traverse((o)=>{
    if(!o.isMesh || !o.name.startsWith('ship-') || o.name==='ship-rigging') return;
    const m = o.material;
    const t = m.map;
    let avg=null, size=null, cs=null;
    if (t && t.image && t.image.data) {
      const d=t.image.data; let r=0,g=0,bl=0; const n=d.length/4;
      for(let i=0;i<n;i++){ r+=d[i*4]; g+=d[i*4+1]; bl+=d[i*4+2]; }
      avg=[+(r/n).toFixed(1), +(g/n).toFixed(1), +(bl/n).toFixed(1)];
      size=[t.image.width,t.image.height]; cs=t.colorSpace;
    }
    let orm=null;
    if (m.roughnessMap && m.roughnessMap.image && m.roughnessMap.image.data){
      const d=m.roughnessMap.image.data; let r=0,g=0,bl=0; const n=d.length/4;
      for(let i=0;i<n;i++){ r+=d[i*4]; g+=d[i*4+1]; bl+=d[i*4+2]; }
      orm=[+(r/n).toFixed(1), +(g/n).toFixed(1), +(bl/n).toFixed(1)];
    }
    // average vertex colour
    const c=o.geometry.attributes.color; let vr=0,vg=0,vb=0;
    for(let i=0;i<c.count;i++){ vr+=c.getX(i); vg+=c.getY(i); vb+=c.getZ(i); }
    out.push({ name:o.name, mapAvg255:avg, mapSize:size, cs, ormAvg255:orm,
      matColor:m.color.toArray().map(v=>+v.toFixed(3)),
      rough:m.roughness, metal:m.metalness,
      mapRepeat:t?t.repeat.toArray():null,
      vcolAvg: [vr/c.count, vg/c.count, vb/c.count].map(v=>+v.toFixed(3)),
      uvRange: (()=>{ const u=o.geometry.attributes.uv; let mn=[1e9,1e9], mx=[-1e9,-1e9];
        for(let i=0;i<u.count;i++){ const a=u.getX(i), bq=u.getY(i); if(a<mn[0])mn[0]=a; if(a>mx[0])mx[0]=a; if(bq<mn[1])mn[1]=bq; if(bq>mx[1])mx[1]=bq; }
        return [mn.map(v=>+v.toFixed(1)), mx.map(v=>+v.toFixed(1))]; })(),
    });
  });
  return out;
}), null, 1));
await b.close();
