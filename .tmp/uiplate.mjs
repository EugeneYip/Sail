#!/usr/bin/env node
/**
 * The contrast pass, with the engine taken out of the loop.
 *
 *   node .tmp/uiplate.mjs
 *
 * `uiprobe.mjs` already shoots flat plates behind the real chrome, and those are
 * the authoritative frames. But it needs a booted engine to do it, and a booted
 * engine currently costs four minutes and depends on six other agents' files
 * compiling. Nothing about a legibility measurement needs a sea: it needs the
 * stylesheet, the fonts, and a known ground.
 *
 * So this rebuilds the default screen's DOM by hand — the same tags, classes and
 * nesting MiniHud.ts and ModeSwitch.ts emit — over four flat plates, and reports
 * ink against ground and ink against its own contour. If this and the probe ever
 * disagree, the probe is right and this file has drifted from the TS.
 *
 * The four plates are chosen to bracket reality rather than to flatter it:
 *   white  #ffffff  the brightest ground that can physically exist
 *   foam   #dfe6ea  sunlit wake, which is what is actually under the readout
 *   sky    #b9c6d2  hazy noon
 *   night  #060a0f  where a contour must cost nothing and show nothing
 */

import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import process from 'node:process';

const css = await readFile(new URL('../src/ui/styles.css', import.meta.url), 'utf8');
const FONTS =
  'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,500;0,600;1,300;1,400' +
  '&family=Inter:wght@200;300;400;500;600&family=JetBrains+Mono:wght@300;400;500&display=block';

/* The default screen, as MiniHud.ts and ModeSwitch.ts build it. */
const HEAD = 'M12 2.5 L8.6 9.6 L12 7.9 L15.4 9.6 Z';
const BODY = `
<div id="app"><div id="ui-root"><div class="ui">
  <div class="hud">
    <div class="hud-scrim"></div>
    <div class="mini">
      <div class="speedline"><span class="speed">16.1</span><span class="speed-u">kn</span></div>
      <div class="mini-hdg"><span class="mini-deg">033°</span><span class="mini-card">NNE</span></div>
      <div class="mini-wind">
        <svg class="mini-wind-g" width="24" height="24" viewBox="0 0 24 24"><g transform="rotate(147 12 12)">
          <line x1="12" y1="21" x2="12" y2="7" class="mw-stem-u"></line>
          <path d="${HEAD}" class="mw-head-u"></path>
          <line x1="12" y1="21" x2="12" y2="7" class="mw-stem"></line>
          <path d="${HEAD}" class="mw-head"></path>
        </g></svg><span class="mini-wind-l">wind</span>
      </div>
      <div class="mini-irons">in irons — bear away</div>
    </div>
  </div>
  <div class="modesw" role="radiogroup">
    <button class="modesw-b" role="radio" aria-checked="true">minimal</button>
    <span class="modesw-d"></span>
    <button class="modesw-b" role="radio" aria-checked="false">pro</button>
  </div>
  <button class="menu"><span></span><span></span><span></span></button>
</div></div></div>`;

const browser = await chromium.launch({
  headless: true,
  args: ['--force-color-profile=srgb', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.setContent(
  `<link href="${FONTS}" rel="stylesheet"><style>${css}</style>
   <style>html,body{background:var(--plate,#fff)}</style>${BODY}`,
  { waitUntil: 'load' },
);
await page.evaluate(() => document.fonts.ready);

/* Rectangles measured off the live layout, so a margin change cannot silently
   move the measurement off the type it is supposed to be measuring. */
const RECTS = await page.evaluate(() => {
  const out = {};
  const put = (name, sel) => {
    const n = document.querySelector(sel);
    if (!n) return;
    const r = n.getBoundingClientRect();
    out[name] = [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
  };
  put('speed 16.1', '.speed');
  put('heading 033', '.mini-deg');
  put('label kn', '.speed-u');
  put('label wind', '.mini-wind-l');
  put('wind arrow', '.mini-wind-g');
  put('switch MINIMAL', '.modesw-b[aria-checked="true"]');
  put('switch PRO', '.modesw-b[aria-checked="false"]');
  put('menu rules', '.menu');
  return out;
});

const results = [];
for (const [label, plate] of [['white', '#ffffff'], ['foam', '#dfe6ea'], ['sky', '#b9c6d2'], ['night', '#060a0f']]) {
  await page.evaluate((c) => document.documentElement.style.setProperty('--plate', c), plate);
  const png = await page.screenshot({ timeout: 120000 });
  const row = await measure(png, RECTS);
  results.push([label, row]);
}

/** Ink vs ground and ink vs contour, inside each rect, from the PNG's pixels. */
async function measure(png, rects) {
  const p = await browser.newPage({ viewport: { width: 64, height: 64 } });
  await p.setContent('<canvas id=c></canvas>');
  const out = await p.evaluate(
    async ([src, rs]) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const c = document.getElementById('c');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, 0, 0);
      const { data: d, width: W, height: H } = g.getImageData(0, 0, c.width, c.height);
      const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      const lum = (i) => 0.2126 * lin(d[i]) + 0.7152 * lin(d[i + 1]) + 0.0722 * lin(d[i + 2]);
      const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      const res = {};
      for (const [name, r] of Object.entries(rs)) {
        const [x0, y0, w, h] = r;
        const ink = [];
        for (let y = y0; y < y0 + h; y++) {
          for (let x = x0; x < x0 + w; x++) {
            if (x < 0 || y < 0 || x >= W || y >= H) continue;
            ink.push(lum((y * W + x) << 2));
          }
        }
        if (!ink.length) continue;
        ink.sort((a, b) => a - b);
        const q = (t) => ink[Math.min(ink.length - 1, Math.floor(ink.length * t))];
        // The ground is sampled from a ring outside the rect, so the contour
        // that belongs to the mark cannot be mistaken for the sky behind it.
        const ring = [];
        const pad = 30;
        for (let y = y0 - pad; y < y0 + h + pad; y++) {
          for (let x = x0 - pad; x < x0 + w + pad; x++) {
            if (x < 0 || y < 0 || x >= W || y >= H) continue;
            if (x >= x0 - 6 && x < x0 + w + 6 && y >= y0 - 6 && y < y0 + h + 6) continue;
            ring.push(lum((y * W + x) << 2));
          }
        }
        ring.sort((a, b) => a - b);
        const ground = ring[ring.length >> 1] ?? q(0.5);
        // Marks here are light on dark, so the ink is the bright tail and the
        // contour is the dark tail. 2 % trims the antialiasing.
        const bright = q(0.98), dark = q(0.02);
        res[name] = {
          vsGround: +ratio(bright, ground).toFixed(2),
          vsContour: +ratio(bright, dark).toFixed(2),
          inkY: Math.round(bright * 255), groundY: Math.round(ground * 255), contourY: Math.round(dark * 255),
        };
      }
      return res;
    },
    [`data:image/png;base64,${png.toString('base64')}`, rects],
  );
  await p.close();
  return out;
}

const names = Object.keys(RECTS);
console.log('ink vs its own contour (the local separation), and vs the ground 30 px out\n');
console.log(`${''.padEnd(17)}${results.map(([l]) => l.padStart(17)).join('')}`);
let worst = 99;
for (const n of names) {
  const cells = results.map(([, r]) => {
    const v = r[n];
    if (!v) return '—'.padStart(17);
    if (results.indexOf(results.find(([, rr]) => rr === r)) < 3) worst = Math.min(worst, v.vsContour);
    return `${v.vsContour.toFixed(1)}:1 (${v.vsGround.toFixed(1)})`.padStart(17);
  });
  console.log(`${n.padEnd(17)}${cells.join('')}`);
}
console.log('\nformat: ink-vs-contour (ink-vs-ground).  4.5:1 is the WCAG bar for small text.');
console.log(`worst contour separation on the three bright plates: ${worst.toFixed(2)}:1`);
await browser.close();
if (worst < 3) process.exitCode = 1;
