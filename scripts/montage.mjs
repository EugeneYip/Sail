#!/usr/bin/env node
/**
 * Contact-sheet builder. Tiles many PNGs into one image so a reviewer can judge
 * a whole set — a full day cycle, every camera mode, before/after — in a single
 * look instead of opening twenty files.
 *
 *   node scripts/montage.mjs --out sheets/day 'shots/env-timeline-*.png'
 *   node scripts/montage.mjs --out sheets/modes --cols 3 --labels shots/cam-*.png
 */

import { chromium } from 'playwright';
import { glob, mkdir, readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import process from 'node:process';

const argv = process.argv.slice(2);
let out = 'sheets/montage';
let cols = 0;
let labels = false;
let width = 2400;
const patterns = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--out') out = argv[++i];
  else if (a === '--cols') cols = Number(argv[++i]);
  else if (a === '--width') width = Number(argv[++i]);
  else if (a === '--labels') labels = true;
  else patterns.push(a);
}

if (!patterns.length) {
  console.error("usage: montage.mjs --out <basename> [--cols N] [--labels] '<glob>' [...]");
  process.exit(2);
}

const files = [];
for (const p of patterns) {
  if (p.includes('*') || p.includes('?')) {
    for await (const f of glob(p)) files.push(f);
  } else {
    files.push(p);
  }
}
files.sort();

if (!files.length) {
  console.error('no files matched');
  process.exit(1);
}

if (!cols) cols = files.length <= 4 ? 2 : files.length <= 9 ? 3 : files.length <= 16 ? 4 : 5;

const tiles = await Promise.all(
  files.map(async (f) => ({
    name: basename(f).replace(/\.png$/, ''),
    data: `data:image/png;base64,${(await readFile(resolve(f))).toString('base64')}`,
  })),
);

const html = `<!doctype html><meta charset="utf-8"><style>
  *{box-sizing:border-box}
  body{margin:0;background:#0d0d0d;font:500 11px/1.3 ui-sans-serif,system-ui,sans-serif;color:#d8d8d8}
  .grid{display:grid;grid-template-columns:repeat(${cols},1fr);gap:8px;padding:8px}
  figure{margin:0;display:flex;flex-direction:column;gap:4px}
  img{display:block;width:100%;border:1px solid #262626}
  figcaption{opacity:.6;letter-spacing:.07em;text-transform:uppercase;font-size:10px}
</style><div class="grid">
${tiles
  .map(
    (t) =>
      `<figure><img src="${t.data}">${labels ? `<figcaption>${t.name}</figcaption>` : ''}</figure>`,
  )
  .join('\n')}
</div>`;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width, height: 900 } });
await page.setContent(html, { waitUntil: 'load' });
await page.waitForFunction(() => Array.from(document.images).every((i) => i.complete && i.naturalWidth > 0));
const outPng = resolve(`${out}.png`);
await mkdir(dirname(outPng), { recursive: true });
await (await page.$('body')).screenshot({ path: outPng });
await browser.close();
console.log(`${files.length} tiles -> ${outPng}`);
