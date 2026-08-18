import { chromium } from 'playwright';
const b = await chromium.launch({ headless:true, args:['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist','--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport:{width:1280,height:720} });
await p.addInitScript(() => { const R=window.WebSocket; window.WebSocket=function(u,pr){ if(pr==='vite-hmr') return {readyState:3,close(){},send(){},addEventListener(){},removeEventListener(){}}; return new R(u,pr);}; window.WebSocket.prototype=R.prototype; });
await p.goto('http://127.0.0.1:5178/', { waitUntil:'domcontentloaded' });
await p.waitForFunction(()=>!!window.__leeward, null, {timeout:60000});
await p.waitForTimeout(3000);
console.log(JSON.stringify(await p.evaluate(()=>{
  const w = window.__leeward.world;
  const out = { meshes: [], sails: [], stats: {}, envMap: !!w.scene.environment };
  const root = w.shipRoot;
  root.traverse((o)=>{
    if (!o.isMesh) return;
    const g = o.geometry;
    g.computeBoundingBox?.();
    const bb = g.boundingBox;
    out.meshes.push({
      name: o.name, visible: o.visible, tris: (g.index? g.index.count : g.attributes.position.count)/3,
      verts: g.attributes.position.count,
      instanceCount: g.instanceCount ?? null,
      bbMin: bb ? bb.min.toArray().map(v=>+v.toFixed(1)) : null,
      bbMax: bb ? bb.max.toArray().map(v=>+v.toFixed(1)) : null,
      mat: o.material.type, transparent: o.material.transparent, side: o.material.side,
      scale: o.scale.toArray(),
    });
  });
  for (const s of w.ship.sails) out.sails.push({ id:s.id, set:+s.set.toFixed(3), brace:+s.brace.toFixed(3), luff:+s.luff.toFixed(3), camber:+s.camber.toFixed(3), area:s.area, tri:s.triangular });
  for (const [k,v] of Object.entries(w.stats)) if (/ship|draw|tri/i.test(k)) out.stats[k]=v;
  out.rootChildren = root.children.map(c=>c.type+':'+c.name+':'+(c.children?.length??0));
  return out;
}), null, 2));
await b.close();
