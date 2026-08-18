/**
 * Crop and upscale a region of a PNG so a 40-pixel-tall sail can actually be
 * judged. Usage:
 *   node .tmp/zoom.mjs <in.png> <out.png> x y w h [scale]
 */
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import process from 'node:process';

const [, , inPath, outPath, xs, ys, ws, hs, ss] = process.argv;
const x = Number(xs);
const y = Number(ys);
const w = Number(ws);
const h = Number(hs);
const s = Number(ss ?? 2);

const data = await readFile(inPath);
const b64 = data.toString('base64');

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: Math.round(w * s), height: Math.round(h * s) } });
await page.setContent(
  `<style>html,body{margin:0;padding:0;overflow:hidden;background:#000}
   img{position:absolute;left:${-x * s}px;top:${-y * s}px;image-rendering:pixelated}</style>
   <img id="i" src="data:image/png;base64,${b64}">`,
);
const nat = await page.evaluate(() => {
  const i = document.getElementById('i');
  return { w: i.naturalWidth, h: i.naturalHeight };
});
await page.evaluate((sc) => {
  const i = document.getElementById('i');
  i.style.width = `${i.naturalWidth * sc}px`;
}, s);
await page.waitForTimeout(200);
await page.screenshot({ path: outPath, animations: 'allow' });
console.log(`${inPath} ${nat.w}x${nat.h} -> ${outPath} crop ${x},${y} ${w}x${h} @${s}x`);
await browser.close();
