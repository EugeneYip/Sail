#!/usr/bin/env node
/** Is EXT_disjoint_timer_query_webgl2 available, and does it return sane values? */
import { chromium } from 'playwright';

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--hide-scrollbars', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.setDefaultTimeout(200000);
await page.addInitScript(() => {
  const R = window.WebSocket;
  class D extends EventTarget { constructor() { super(); this.readyState = 3; } send() {} close() {} }
  window.WebSocket = function (u, p) { return p === 'vite-hmr' ? new D() : new R(u, p); };
});
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__leeward, null, { timeout: 120000 });
await page.waitForTimeout(4000);
console.log(JSON.stringify(await page.evaluate(() => {
  const gl = window.__leeward.world.renderer.getContext();
  return {
    all: gl.getSupportedExtensions().filter((e) => /timer|disjoint|parallel|khr/i.test(e)),
    timer: !!gl.getExtension('EXT_disjoint_timer_query_webgl2'),
    timer1: !!gl.getExtension('EXT_disjoint_timer_query'),
  };
}), null, 2));
await browser.close();
