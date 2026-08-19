import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
const [src, out, x, y, w, h] = process.argv.slice(2);
const data = `data:image/png;base64,${(await readFile(src)).toString('base64')}`;
const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
await p.setContent(`<style>body{margin:0;background:#111;overflow:hidden}
.w{position:relative;width:1400px;height:900px;overflow:hidden}
img{position:absolute;width:${(1400/ (w/1600) /1600*100).toFixed(4)}%;
 left:${(-x/(w) *100).toFixed(4)}%; top:${(-y/(h)*100).toFixed(4)}%; image-rendering:auto}
</style><div class="w"><img src="${data}"></div>`);
await p.waitForFunction(()=>Array.from(document.images).every(i=>i.complete&&i.naturalWidth>0));
await (await p.$('.w')).screenshot({ path: out });
await b.close();
console.log(out);
