#!/usr/bin/env node
/**
 * One question: does letting go of a thumb pad centre the helm on a phone?
 * The main probe read steer 700 ms after pointerup and saw it unchanged in
 * portrait, which is either a stuck key or a stalled frame loop. Sample both.
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--hide-scrollbars'],
});

for (const [label, viewport] of [['portrait', { width: 390, height: 780 }], ['landscape', { width: 844, height: 390 }]]) {
  const ctx = await browser.newContext({ viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('  !!', e.message.slice(0, 200)));
  await page.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__leeward, null, { timeout: 90000 });
  await page.waitForSelector('.intro.ready', { timeout: 90000 });
  await page.click('.intro-begin');
  await page.waitForTimeout(2500);

  // A real touch, not a synthetic PointerEvent: Playwright's touchscreen goes
  // through the browser's own input pipeline, so pointer capture behaves.
  const pad = await page.locator('.pad-l').boundingBox();
  await page.touchscreen.tap(pad.x + pad.width / 2, pad.y + pad.height / 2);
  await page.waitForTimeout(200);

  const trace = await page.evaluate(async () => {
    const w = window.__leeward.world;
    const pad = document.querySelector('.pad-l');
    const o = { pointerId: 7, isPrimary: true, pointerType: 'touch', bubbles: true, cancelable: true,
      clientX: pad.getBoundingClientRect().x + 30, clientY: pad.getBoundingClientRect().y + 30 };
    const samples = [];
    const snap = (tag) => samples.push(`${tag} steer=${w.input.steer.toFixed(3)} frame=${w.time.frame} keys=[${[...w.input.keys].join(',')}] padOn=${pad.classList.contains('on')}`);
    snap('idle');
    pad.dispatchEvent(new PointerEvent('pointerdown', o));
    for (let i = 0; i < 4; i++) { await new Promise((r) => setTimeout(r, 250)); snap('hold' + i); }
    pad.dispatchEvent(new PointerEvent('pointerup', o));
    for (let i = 0; i < 6; i++) { await new Promise((r) => setTimeout(r, 250)); snap('rel' + i); }
    return samples;
  });
  console.log(`--- ${label} ---`);
  for (const s of trace) console.log('  ' + s);
  await ctx.close();
}
await browser.close();
