import { chromium } from 'playwright';
const b = await chromium.launch({ headless:true, args:['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist','--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport:{width:1280,height:720} });
await p.goto('http://127.0.0.1:5178/', { waitUntil:'domcontentloaded' });
await p.waitForFunction(()=>!!window.__leeward, null, {timeout:60000});
await p.evaluate(()=>{ const w=window.__leeward.world; Object.assign(w.env,{timeOfDay:12.7,windSpeed:10.5,cloudCover:0.38,turbidity:2.0,visibility:34000,seaState:4,waveHeight:2.0}); w.settings.adaptiveResolution=false; w.bus.emit('settings:changed'); });
await p.waitForTimeout(6000);
console.log(JSON.stringify(await p.evaluate(()=>{
  const w = window.__leeward.world;
  const sky = w.ext.sky ?? {};
  return {
    uExposure: w.uniforms.uExposure.value,
    settings_autoExposure: w.settings.autoExposure,
    exposureBias: w.settings.exposureBias,
    sunIntensity_uniform: w.uniforms.uSunIntensity.value,
    env_sunIntensity: w.env.sunIntensity,
    sunColor: w.uniforms.uSunColor.value.toArray?.().map(v=>+v.toFixed(3)),
    fogColor: w.uniforms.uFogColor.value.toArray?.().map(v=>+v.toFixed(3)),
    uFogDensity: w.uniforms.uFogDensity.value,
    uVisibility: w.uniforms.uVisibility.value,
    skyLuminance: sky.skyLuminance, sunLuminance: sky.sunLuminance,
    zenith: sky.zenithColor?.toArray?.().map(v=>+v.toFixed(3)),
    horizon: sky.horizonColor?.toArray?.().map(v=>+v.toFixed(3)),
    stats: Object.fromEntries(Object.entries(w.stats).filter(([k])=>/exp|lum|post|sky/i.test(k))),
  };
}), null, 2));
await b.close();
