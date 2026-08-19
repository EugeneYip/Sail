#!/usr/bin/env node
/**
 * Two measurements, so "it reads as a lozenge" stops being a matter of taste.
 *
 *   node .tmp/uigrade.mjs scrim              — is the scrim invisible as a SHAPE?
 *   node .tmp/uigrade.mjs text shots/probe-flat-white.png   — does the type READ?
 *
 * SHAPE
 *   The scrim is mounted alone over a flat white plate — the brightest ground
 *   that can physically exist, and the one with no texture to hide a gradient
 *   in. Then, along every scanline, the largest luminance step across a 32 px
 *   window. That number, not the peak darkening, is what makes a soft gradient
 *   read as an object: the eye finds edges by differentiating, so a ramp is
 *   invisible exactly when its slope stays under the banding threshold
 *   everywhere. Under ~4 levels/32 px (1.6%) is quiet on a flat white field;
 *   past ~10 you are looking at a plate with soft corners.
 *
 * TEXT
 *   Ink versus its own local ground, WCAG-style, inside a named rectangle:
 *   brightest 2% of pixels (the glyph cores) against the median of the ring
 *   just outside the rect (the sky the glyphs actually sit on). Bright plates
 *   are the hard case; the night plate is the check that the fix did not turn
 *   the corner into a visible smudge.
 *
 * Both passes decode PNGs by handing them back to Chromium — no hand-rolled
 * inflate, and the sRGB numbers are the browser's own.
 */

import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import process from 'node:process';

const mode = process.argv[2] ?? 'scrim';
const browser = await chromium.launch({ headless: true, args: ['--force-color-profile=srgb', '--hide-scrollbars'] });

/** Run `fn` over the pixels of a PNG, in the browser, as an ImageData. */
async function withPixels(png, fn, arg) {
  const page = await browser.newPage({ viewport: { width: 64, height: 64 } });
  const data = `data:image/png;base64,${png.toString('base64')}`;
  await page.setContent('<canvas id=c></canvas>');
  const out = await page.evaluate(
    async ([src, body, a]) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const c = document.getElementById('c');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, 0, 0);
      const px = g.getImageData(0, 0, c.width, c.height);
      // eslint-disable-next-line no-new-func
      return new Function('px', 'W', 'H', 'arg', body)(px, c.width, c.height, a);
    },
    [data, fn, arg ?? null],
  );
  await page.close();
  return out;
}

/*
 * Two luminances, because the two questions live in different spaces.
 *
 * `luma` is the ENCODED sRGB grey, 0-255. Banding and "does this gradient read
 * as an object" are properties of the code values the display is handed, and
 * the ~1-level-per-degree threshold everyone quotes is quoted in this space. The
 * first version of this script measured the shape in linear luminance and
 * reported a 194-level drop where the sRGB drop was 120 — flattering in the
 * highlights, alarmist in the shadows, useless for a slope threshold.
 *
 * `lum` is LINEAR relative luminance, which is what WCAG contrast is defined
 * on. Used only for the text pass.
 */
const LUM = `
const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
const lum = (r, g, b) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
`;

/* ------------------------------------------------------------------ *
 *  shape
 * ------------------------------------------------------------------ */

if (mode === 'scrim') {
  const css = await readFile(new URL('../src/ui/styles.css', import.meta.url), 'utf8');
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  // Only the scrim, over white. No canvas, no text, no engine — so anything
  // this pass sees is the scrim's own shape and nothing else's.
  await page.setContent(
    `<style>${css}</style>
     <style>html,body{background:#fff}#app{position:fixed;inset:0}</style>
     <div id="app"><div id="ui-root"><div class="ui"><div class="hud">
       <div class="hud-scrim"></div></div></div></div></div>`,
  );
  const rows = [];
  for (const mod of ['minimal', 'pro']) {
    await page.evaluate((m) => {
      const hud = document.querySelector('.hud');
      hud.classList.toggle('m-pro', m === 'pro');
    }, mod);
    const png = await page.screenshot({ timeout: 90000 });
    const r = await withPixels(png, `
      ${LUM}
      const d = px.data;
      const L = new Float32Array(W * H);
      for (let i = 0, p = 0; i < d.length; i += 4, p++) L[p] = luma(d[i], d[i + 1], d[i + 2]);
      const S = 32;
      let maxH = 0, maxV = 0, hx = 0, hy = 0, vx = 0, vy = 0, min = 1e9;
      // Chromium dithers gradients, so a plain max-over-all-pixels reports the
      // noise peak rather than the ramp — it read 6.0 where the ramp is 4.5.
      // Histogram both axes and quote the 99.99th percentile as well.
      const hist = new Int32Array(256);
      let n = 0;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const v = L[y * W + x];
          if (v < min) min = v;
          if (x + S < W) {
            const dv = Math.abs(L[y * W + x + S] - v);
            if (dv > maxH) { maxH = dv; hx = x; hy = y; }
            hist[Math.min(255, Math.round(dv))]++; n++;
          }
          if (y + S < H) {
            const dv = Math.abs(L[(y + S) * W + x] - v);
            if (dv > maxV) { maxV = dv; vx = x; vy = y; }
            hist[Math.min(255, Math.round(dv))]++; n++;
          }
        }
      }
      let acc = 0, p9999 = 0;
      for (let i = 0; i < 256; i++) {
        acc += hist[i];
        if (acc >= n * 0.9999) { p9999 = i; break; }
      }
      // The corners, where the content sits: mean luminance of a 120x48 patch.
      const patch = (x0, y0, w, h) => {
        let s = 0, n = 0;
        for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) { s += L[y * W + x]; n++; }
        return s / n;
      };
      return {
        peakDrop: +(255 - min).toFixed(1),
        p9999,
        maxH: +maxH.toFixed(2), atH: hx + ',' + hy,
        maxV: +maxV.toFixed(2), atV: vx + ',' + vy,
        tr: +(255 - patch(W - 190, 12, 150, 40)).toFixed(1),
        bl: +(255 - patch(20, H - 110, 150, 90)).toFixed(1),
        mid: +(255 - patch(W / 2 - 75, H / 2 - 24, 150, 48)).toFixed(1),
      };
    `);
    rows.push([mod, r]);
  }
  await page.close();
  console.log('scrim over a flat white plate — levels out of 255\n');
  for (const [m, r] of rows) {
    const verdict = r.p9999 <= 4 ? 'quiet' : r.p9999 <= 10 ? 'noticeable' : 'READS AS A SHAPE';
    console.log(
      `${m.padEnd(8)} peak ${String(r.peakDrop).padStart(5)}  ` +
        `slope/32px p99.99 ${String(r.p9999).padStart(3)}  max H ${String(r.maxH).padStart(6)} @${r.atH.padEnd(10)} ` +
        `V ${String(r.maxV).padStart(6)} @${r.atV.padEnd(10)} ` +
        `| drop under type: tr ${String(r.tr).padStart(5)}  bl ${String(r.bl).padStart(5)}  centre ${String(r.mid).padStart(5)}  -> ${verdict}`,
    );
  }
}

/* ------------------------------------------------------------------ *
 *  text
 * ------------------------------------------------------------------ */

if (mode === 'text') {
  /* Rectangles in 1600x900 CSS px, matching where the probe's flat frames put
     the chrome. `ring` is how far outside the rect to sample the ground. */
  const RECTS = {
    'modesw MINIMAL|PRO': [1418, 18, 130, 26],
    'mini 16.1 kn': [24, 756, 130, 46],
    'mini heading': [24, 800, 110, 18],
    'mini wind arrow': [24, 826, 100, 22],
  };
  for (const path of process.argv.slice(3)) {
    const png = await readFile(path);
    const res = await withPixels(png, `
      ${LUM}
      const d = px.data;
      const S = W / 1600;                 // the frame may be shot at dpr 2
      const L = (x, y) => {
        const i = ((y * W + x) << 2);
        return lum(d[i], d[i + 1], d[i + 2]) * 255;
      };
      const out = {};
      for (const [name, r] of arg) {
        const x0 = Math.round(r[0] * S), y0 = Math.round(r[1] * S);
        const w = Math.round(r[2] * S), h = Math.round(r[3] * S);
        const ink = [];
        for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) ink.push(L(x, y));
        ink.sort((a, b) => a - b);
        const q = (p) => ink[Math.min(ink.length - 1, Math.floor(ink.length * p))];
        // The ground: a ring 26 px outside the rect, median, so a stray glyph
        // or the menu rule cannot move it.
        const g = [];
        const pad = Math.round(26 * S);
        for (let y = y0 - pad; y < y0 + h + pad; y++) {
          for (let x = x0 - pad; x < x0 + w + pad; x++) {
            if (x < 0 || y < 0 || x >= W || y >= H) continue;
            if (x >= x0 && x < x0 + w && y >= y0 && y < y0 + h) continue;
            g.push(L(x, y));
          }
        }
        g.sort((a, b) => a - b);
        const ground = g[g.length >> 1];
        const bright = q(0.99), dark = q(0.02), mid = q(0.5);
        out[name] = {
          ink: +bright.toFixed(1), halo: +dark.toFixed(1), body: +mid.toFixed(1),
          ground: +ground.toFixed(1),
          // Ink against the sky just outside — the number a player experiences.
          vsGround: +ratio(bright / 255, ground / 255).toFixed(2),
          // Ink against its own halo — the local separation the contour buys.
          vsHalo: +ratio(bright / 255, dark / 255).toFixed(2),
        };
      }
      return out;
    `, Object.entries(RECTS));
    console.log(`\n${path}`);
    for (const [k, v] of Object.entries(res)) {
      const worst = Math.min(v.vsGround, v.vsHalo);
      const flag = worst >= 4.5 ? 'ok  ' : worst >= 3 ? 'thin' : 'FAIL';
      console.log(
        `  ${k.padEnd(20)} ink ${String(v.ink).padStart(5)}  halo ${String(v.halo).padStart(5)}  ` +
          `ground ${String(v.ground).padStart(5)}  |  vs ground ${String(v.vsGround).padStart(6)}:1  ` +
          `vs halo ${String(v.vsHalo).padStart(6)}:1   ${flag}`,
      );
    }
  }
}

await browser.close();
