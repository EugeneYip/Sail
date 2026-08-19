#!/usr/bin/env node
/**
 * Crop-and-upscale, with timeouts that survive this box. Same job as
 * .tmp/zoom.mjs, which dies at its 30 s setContent limit when the other agents
 * have the machine at a load average in the hundreds.
 *
 *   node .tmp/shipcrop.mjs <in.png> <out.png> x y w h [scale]
 */
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import process from 'node:process';

const [, , inPath, outPath, xs, ys, ws, hs, ss] = process.argv;
const x = Number(xs), y = Number(ys), w = Number(ws), h = Number(hs);
const s = Number(ss ?? 3);

const b64 = (await readFile(inPath)).toString('base64');
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: Math.round(w * s), height: Math.round(h * s) },
});
page.setDefaultTimeout(240000);
await page.setContent(
  `<style>html,body{margin:0;padding:0;overflow:hidden;background:#000}
   img{position:absolute;left:${-x * s}px;top:${-y * s}px;width:${1600 * s}px;image-rendering:pixelated}</style>
   <img id="i" src="data:image/png;base64,${b64}">`,
  { waitUntil: 'domcontentloaded', timeout: 240000 },
);
await page.waitForFunction(
  () => { const i = document.getElementById('i'); return i && i.complete && i.naturalWidth > 0; },
  null, { timeout: 240000 },
);
await page.screenshot({ path: outPath, timeout: 240000 });
console.log(`${outPath}  crop ${x},${y} ${w}x${h} @${s}x`);
await browser.close();
