import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
const css = await readFile(new URL('../src/ui/styles.css', import.meta.url), 'utf8');
const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
await p.setContent(`<style>${css}</style><div id="app"><div id="ui-root"><div class="ui">
 <div class="hud"><div class="hud-scrim"></div><div class="mini"><span class="speed">16.1</span></div></div>
 <div class="modesw"><button class="modesw-b" aria-checked="true">minimal</button><span class="modesw-d"></span><button class="modesw-b">pro</button></div>
 <button class="menu"><span></span><span></span><span></span></button></div></div></div>`);
console.log(JSON.stringify(await p.evaluate(() => {
  const cs = (s) => { const n = document.querySelector(s); return n ? getComputedStyle(n) : null; };
  const r = (s) => { const n = document.querySelector(s); const q = n.getBoundingClientRect(); return [Math.round(q.left),Math.round(q.top),Math.round(q.width),Math.round(q.height)]; };
  return {
    rootContour: getComputedStyle(document.documentElement).getPropertyValue('--contour').trim().slice(0,60),
    modeswShadow: cs('.modesw').textShadow,
    modeswBtnShadow: cs('.modesw-b').textShadow,
    modeswBtnColor: cs('.modesw-b').color,
    modeswOpacity: cs('.modesw').opacity,
    modeswBg: cs('.modesw').backgroundImage,
    modeswRect: r('.modesw'), btnRect: r('.modesw-b'),
    miniShadow: cs('.mini').textShadow,
    speedShadow: cs('.speed').textShadow,
    hudShadow: cs('.hud').textShadow,
  };
}, null), null, 1));
await b.close();
