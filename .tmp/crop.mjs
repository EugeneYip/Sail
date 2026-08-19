/**
 * crop.mjs <src> <out> <x> <y> <w> <h>
 *
 * Crops the source rect (x,y,w,h) and scales it to 1400 px wide.
 *
 * The previous version mixed two coordinate systems: it expressed the image
 * scale as a CSS percentage, which resolves against the CONTAINER width (1400),
 * not the image's own width, so the image was drawn at 1400/w * 1400 px instead
 * of 1600 * 1400/w -- while the left/top offsets were computed with the intended
 * scale. Zoom and registration therefore disagreed by 1600/1400, and every crop
 * landed ~14% off with the wrong magnification. It reads the source's true size
 * now and does the arithmetic in pixels.
 */
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
const [src, out, x, y, w, h] = process.argv.slice(2).map((v, i) => (i < 2 ? v : Number(v)));
const data = `data:image/png;base64,${(await readFile(src)).toString('base64')}`;
const b = await chromium.launch({ headless: true });
const s = 1400 / w;
const p = await b.newPage({ viewport: { width: 1400, height: Math.max(1, Math.round(h * s)) } });
await p.setContent(`<style>body{margin:0;background:#111;overflow:hidden}
.w{position:relative;width:1400px;height:${Math.round(h * s)}px;overflow:hidden}
img{position:absolute;image-rendering:auto}
</style><div class="w"><img src="${data}"></div>`);
await p.waitForFunction(() => Array.from(document.images).every((i) => i.complete && i.naturalWidth > 0));
const nat = await p.evaluate(() => [document.images[0].naturalWidth, document.images[0].naturalHeight]);
await p.evaluate(([sc, ox, oy, nw, nh]) => {
  const im = document.images[0];
  im.style.width = `${nw * sc}px`;
  im.style.height = `${nh * sc}px`;
  im.style.left = `${-ox * sc}px`;
  im.style.top = `${-oy * sc}px`;
}, [s, x, y, nat[0], nat[1]]);
await (await p.$('.w')).screenshot({ path: out });
await b.close();
console.log(`${out}  src=${nat[0]}x${nat[1]} rect=${x},${y} ${w}x${h} zoom=${s.toFixed(2)}x`);
