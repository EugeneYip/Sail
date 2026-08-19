#!/usr/bin/env node
/**
 * The default screen's two corners at 3x over the grounds that matter, with no
 * engine in the way. Companion to uiplate.mjs: that one gives the numbers, this
 * one lets you look at the letterforms and see whether a contour has turned 9 px
 * caps into a smudge — which no contrast ratio will ever tell you.
 *
 *   node .tmp/uizoom.mjs
 */
import { chromium } from 'playwright';
import { readFile, mkdir } from 'node:fs/promises';
const css = await readFile(new URL('../src/ui/styles.css', import.meta.url), 'utf8');
const FONTS = 'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,500;0,600;1,300;1,400&family=Inter:wght@200;300;400;500;600&family=JetBrains+Mono:wght@300;400;500&display=block';
const HEAD = 'M12 2.5 L8.6 9.6 L12 7.9 L15.4 9.6 Z';
const BODY = `<div id="app"><div id="ui-root"><div class="ui">
  <div class="hud"><div class="hud-scrim"></div>
    <div class="mini">
      <div class="speedline"><span class="speed">16.1</span><span class="speed-u">kn</span></div>
      <div class="mini-hdg"><span class="mini-deg">033°</span><span class="mini-card">NNE</span></div>
      <div class="mini-wind"><svg class="mini-wind-g" width="24" height="24" viewBox="0 0 24 24"><g transform="rotate(147 12 12)">
        <line x1="12" y1="21" x2="12" y2="7" class="mw-stem-u"></line><path d="${HEAD}" class="mw-head-u"></path>
        <line x1="12" y1="21" x2="12" y2="7" class="mw-stem"></line><path d="${HEAD}" class="mw-head"></path>
      </g></svg><span class="mini-wind-l">wind</span></div>
    </div></div>
  <div class="modesw"><button class="modesw-b" aria-checked="true">minimal</button><span class="modesw-d"></span><button class="modesw-b" aria-checked="false">pro</button></div>
  <button class="menu"><span></span><span></span><span></span></button>
</div></div></div>`;
const b = await chromium.launch({ headless: true, args: ['--force-color-profile=srgb', '--hide-scrollbars'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 3 });
await p.setContent(`<link href="${FONTS}" rel="stylesheet"><style>${css}</style><style>html,body{background:var(--plate,#fff)}</style>${BODY}`, { waitUntil: 'load' });
await p.evaluate(() => document.fonts.ready);
await mkdir('shots', { recursive: true });
for (const [label, plate] of [['white', '#ffffff'], ['foam', '#dfe6ea'], ['night', '#060a0f']]) {
  await p.evaluate((c) => document.documentElement.style.setProperty('--plate', c), plate);
  await p.screenshot({ path: `/private/tmp/uiz-${label}-mini.png`, clip: { x: 10, y: 745, width: 260, height: 145 }, timeout: 120000 });
  await p.screenshot({ path: `/private/tmp/uiz-${label}-sw.png`, clip: { x: 1400, y: 4, width: 190, height: 60 }, timeout: 120000 });
  console.log(label);
}
await b.close();
