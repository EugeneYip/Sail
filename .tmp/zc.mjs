#!/usr/bin/env node
/** Exact pixel crop + integer nearest-neighbour zoom. zc.mjs src out x y w h [zoom] */
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
const [src, out, x, y, w, h, z = '1'] = process.argv.slice(2);
const X = +x, Y = +y, W = +w, H = +h, Z = +z;
const data = `data:image/png;base64,${(await readFile(src)).toString('base64')}`;
const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: W * Z, height: H * Z } });
await p.setContent(`<style>html,body{margin:0;padding:0;background:#000}
#c{display:block}</style><canvas id="c" width="${W * Z}" height="${H * Z}"></canvas>
<script>
window.done = new Promise(r => {
  const i = new Image();
  i.onload = () => {
    const c = document.getElementById('c').getContext('2d');
    c.imageSmoothingEnabled = false;
    c.drawImage(i, ${X}, ${Y}, ${W}, ${H}, 0, 0, ${W * Z}, ${H * Z});
    r(true);
  };
  i.src = "${data}";
});
</script>`);
await p.evaluate(() => window.done);
await p.screenshot({ path: out });
await b.close();
console.log(`${out}  ${W}x${H} @${Z}x from (${X},${Y})`);
