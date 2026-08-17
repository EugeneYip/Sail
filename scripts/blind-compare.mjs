#!/usr/bin/env node
/**
 * Blind A/B comparison sheet builder.
 *
 * Composites two images side by side with neutral LEFT/RIGHT labels, in a
 * randomised order, and writes the answer key to a SEPARATE file that the
 * judging agent is not shown. This is how we get an honest verdict on whether
 * our renderer beats the reference — a critic who knows which image is "ours"
 * cannot help but grade on a curve.
 *
 *   node scripts/blind-compare.mjs --a shots/ours-noon.png --b refs/sr-04.png \
 *        --out compare/noon --seed 7
 *
 * Writes:
 *   compare/noon.png       <- give this to the critic
 *   compare/noon.key.json  <- do NOT give this to the critic until they answer
 *
 * Options:
 *   --mode side|stack|crop   layout (default side)
 *   --crop x,y,w,h           crop both images to this region first (fraction 0..1)
 *   --zoom N                 magnify the crop N times, nearest-neighbour
 *   --label "text"           optional neutral caption (no identifying info)
 */

import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

function parseArgs(argv) {
  const out = { mode: 'side', seed: Date.now() & 0xffff, zoom: 1, label: '', crop: null };
  for (let i = 2; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) continue;
    i++;
    out[k] = ['seed', 'zoom'].includes(k) ? Number(v) : v;
  }
  return out;
}

const args = parseArgs(process.argv);
if (!args.a || !args.b || !args.out) {
  console.error('usage: blind-compare.mjs --a <img> --b <img> --out <basename> [--mode side|stack] [--crop x,y,w,h] [--zoom N] [--seed N]');
  process.exit(2);
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(args.seed);
const aFirst = rng() < 0.5;

const pathA = resolve(args.a);
const pathB = resolve(args.b);
const [bufA, bufB] = await Promise.all([readFile(pathA), readFile(pathB)]);
const dataA = `data:image/png;base64,${bufA.toString('base64')}`;
const dataB = `data:image/png;base64,${bufB.toString('base64')}`;

const left = aFirst ? dataA : dataB;
const right = aFirst ? dataB : dataA;
const leftSrc = aFirst ? args.a : args.b;
const rightSrc = aFirst ? args.b : args.a;

const cropCss = (() => {
  if (!args.crop) return '';
  const [x, y, w, h] = String(args.crop).split(',').map(Number);
  // Implemented as a scaled/translated img inside an overflow-hidden box.
  return `
    .pane .win { overflow: hidden; position: relative; width: 100%; aspect-ratio: ${w} / ${h}; }
    .pane img {
      position: absolute;
      width: ${(100 / w).toFixed(4)}%;
      left: ${(-x * 100 / w).toFixed(4)}%;
      top: ${(-y * 100 / h).toFixed(4)}%;
      image-rendering: ${args.zoom > 1 ? 'pixelated' : 'auto'};
    }`;
})();

const stack = args.mode === 'stack';

const html = `<!doctype html><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  body { margin:0; background:#111; font: 500 13px/1.2 ui-sans-serif, system-ui, sans-serif; color:#eaeaea; }
  .sheet { display:grid; grid-template-columns:${stack ? '1fr' : '1fr 1fr'}; gap:10px; padding:10px; }
  .pane { display:flex; flex-direction:column; gap:6px; }
  .tag { letter-spacing:.16em; text-transform:uppercase; opacity:.75; font-size:11px; }
  .pane > .win, .pane > img { display:block; width:100%; border:1px solid #2a2a2a; }
  .cap { text-align:center; padding:6px 0 10px; opacity:.6; font-size:11px; letter-spacing:.08em; }
  ${cropCss}
</style>
<div class="sheet">
  <div class="pane"><div class="tag">Left</div>${args.crop ? `<div class="win"><img src="${left}"></div>` : `<img src="${left}">`}</div>
  <div class="pane"><div class="tag">Right</div>${args.crop ? `<div class="win"><img src="${right}"></div>` : `<img src="${right}">`}</div>
</div>
${args.label ? `<div class="cap">${String(args.label).replace(/[<>]/g, '')}</div>` : ''}`;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: stack ? 1500 : 2560, height: 900 } });
await page.setContent(html, { waitUntil: 'load' });
await page.waitForFunction(() => Array.from(document.images).every((i) => i.complete && i.naturalWidth > 0));

const outPng = resolve(`${args.out}.png`);
const outKey = resolve(`${args.out}.key.json`);
await mkdir(dirname(outPng), { recursive: true });
const el = await page.$('body');
await el.screenshot({ path: outPng });
await browser.close();

await writeFile(
  outKey,
  JSON.stringify({ seed: args.seed, left: leftSrc, right: rightSrc, aWasLeft: aFirst }, null, 2),
  'utf8',
);

console.log(`sheet: ${outPng}`);
console.log(`key:   ${outKey}  (do not show the critic until they have answered)`);
