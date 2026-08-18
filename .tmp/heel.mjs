import { chromium } from 'playwright';
const b = await chromium.launch({ headless:true, args:['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist','--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport:{width:1280,height:720} });
await p.addInitScript(()=>{const R=window.WebSocket;class D{constructor(){this.readyState=3;this.close=()=>{};this.send=()=>{};this.addEventListener=()=>{};this.removeEventListener=()=>{};}}window.WebSocket=function(u,pr){if(pr==='vite-hmr')return new D();return new R(u,pr);};window.WebSocket.prototype=R.prototype;});
await p.goto('http://127.0.0.1:5178/',{waitUntil:'domcontentloaded'});
await p.waitForFunction(()=>!!window.__leeward,null,{timeout:60000});
await p.evaluate(()=>{const w=window.__leeward.world;Object.assign(w.env,{timeOfDay:12.7,windSpeed:10.5,seaState:4,waveHeight:2.0});w.bus.emit('settings:changed');});
await p.waitForTimeout(9000);
console.log(JSON.stringify(await p.evaluate(()=>{
  const THREE = window.__leeward.world.shipRoot.constructor;
  const w = window.__leeward.world;
  const e = new (Object.getPrototypeOf(w.shipRoot).constructor===Object?Object:Object)();
  // Decompose the actual visual transform the renderer uses.
  const m = w.shipRoot.matrixWorld.clone();
  const q = w.shipRoot.quaternion;
  // roll about local Z from the quaternion, in the same YXZ order physics uses
  const eul = { x:0,y:0,z:0 };
  const el = m.elements;
  // extract using YXZ
  const sinX = -el[9];
  eul.x = Math.asin(Math.max(-1,Math.min(1,sinX)));
  eul.y = Math.atan2(el[8], el[10]);
  eul.z = Math.atan2(el[1], el[5]);
  const R2D = 180/Math.PI;
  return {
    physics_heel_deg: +(w.ship.heel*R2D).toFixed(2),
    physics_pitch_deg: +(w.ship.pitch*R2D).toFixed(2),
    shipRoot_roll_deg: +(eul.z*R2D).toFixed(2),
    shipRoot_pitch_deg: +(eul.x*R2D).toFixed(2),
    shipRoot_yaw_deg: +(eul.y*R2D).toFixed(2),
    shipRoot_scale: w.shipRoot.scale.toArray(),
    shipRoot_pos: w.shipRoot.position.toArray().map(v=>+v.toFixed(2)),
    ship_quat: [w.ship.quaternion.x,w.ship.quaternion.y,w.ship.quaternion.z,w.ship.quaternion.w].map(v=>+v.toFixed(4)),
    root_quat: [q.x,q.y,q.z,q.w].map(v=>+v.toFixed(4)),
    children: w.shipRoot.children.length,
  };
}), null, 2));
await b.close();
