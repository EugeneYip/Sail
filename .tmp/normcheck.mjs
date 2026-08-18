import { chromium } from 'playwright';
const b = await chromium.launch({ headless:true, args:['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist','--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport:{width:800,height:600} });
await p.addInitScript(() => { const R=window.WebSocket; window.WebSocket=function(u,pr){ if(pr==='vite-hmr') return {readyState:3,close(){},send(){},addEventListener(){},removeEventListener(){}}; return new R(u,pr);}; window.WebSocket.prototype=R.prototype; });
await p.goto('http://127.0.0.1:5178/', { waitUntil:'domcontentloaded' });
await p.waitForFunction(()=>!!window.__leeward, null, {timeout:60000});
await p.waitForTimeout(2000);
console.log(await p.evaluate(()=>{
  const w = window.__leeward.world;
  const lines=[];
  w.shipRoot.traverse((o)=>{
    if(!o.isMesh || !o.name.startsWith('ship-') || o.name==='ship-rigging') return;
    const g=o.geometry, pos=g.attributes.position, nrm=g.attributes.normal, idx=g.index;
    // For each triangle: check winding consistency with the stored normal, and
    // whether the normal points away from the ship's centreline axis.
    let outward=0, inward=0, windOK=0, windBad=0, n=0;
    const A={},B={},C={};
    for(let t=0;t<idx.count/3;t++){
      const ia=idx.getX(t*3), ib=idx.getX(t*3+1), ic=idx.getX(t*3+2);
      const ax=pos.getX(ia), ay=pos.getY(ia), az=pos.getZ(ia);
      const bx=pos.getX(ib), by=pos.getY(ib), bz=pos.getZ(ib);
      const cx=pos.getX(ic), cy=pos.getY(ic), cz=pos.getZ(ic);
      // geometric normal from winding
      const e1x=bx-ax,e1y=by-ay,e1z=bz-az, e2x=cx-ax,e2y=cy-ay,e2z=cz-az;
      let gx=e1y*e2z-e1z*e2y, gy=e1z*e2x-e1x*e2z, gz=e1x*e2y-e1y*e2x;
      const gl=Math.hypot(gx,gy,gz)||1; gx/=gl; gy/=gl; gz/=gl;
      const nx=(nrm.getX(ia)+nrm.getX(ib)+nrm.getX(ic))/3;
      const ny=(nrm.getY(ia)+nrm.getY(ib)+nrm.getY(ic))/3;
      const nz=(nrm.getZ(ia)+nrm.getZ(ib)+nrm.getZ(ic))/3;
      if (gx*nx+gy*ny+gz*nz > 0) windOK++; else windBad++;
      // centroid, radial x direction (sign of x)
      const mx=(ax+bx+cx)/3;
      if (Math.abs(mx) > 2.0) { if (nx*Math.sign(mx) > 0) outward++; else inward++; }
      n++;
    }
    lines.push(`${o.name.padEnd(14)} tris=${n} windingMatchesNormal=${windOK}/${n} sideTrisOutward=${outward} inward=${inward}`);
  });
  return lines.join('\n');
}));
await b.close();
