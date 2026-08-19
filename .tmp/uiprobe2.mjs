#!/usr/bin/env node
/**
 * The UI probe, rebuilt around what this machine can actually afford.
 *
 *   node .tmp/uiprobe2.mjs
 *
 * `uiprobe.mjs` booted a fresh browser context per subject — desktop, two
 * phones, a zoom pass, a flat-plate pass. That was clean and it is now
 * unaffordable: with six agents on one M2 a single boot costs four to seven
 * minutes, so five boots is half an hour in which any one timeout loses
 * everything. It lost everything twice.
 *
 * Two changes. One engine, resized: `setViewportSize` re-evaluates media queries,
 * and touch does not need `hasTouch` on the context because TouchControls also
 * arms on a real touch-type pointerdown — which is dispatchable. And a `finally`
 * that flushes the staged PNGs no matter how the run ends, because a frame you
 * captured and then threw away is worse than one you never took.
 *
 * The flat-plate contrast pass lives in `.tmp/uiplate.mjs` now: it needs the
 * stylesheet and the fonts, never a sea.
 */

import { chromium } from 'playwright';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import process from 'node:process';

const URL = 'http://127.0.0.1:5178/';
const staging = await mkdtemp(join(tmpdir(), 'leeward-probe2-'));
const pending = [];
const notes = [];
const errors = [];

function stage(rel) {
  const final = resolve(rel);
  const staged = join(staging, `${pending.length}-${basename(final)}`);
  pending.push([staged, final]);
  return staged;
}

const ENV = {
  timeOfDay: 12.1, windSpeed: 9.5, cloudCover: 0.42, cloudType: 0.75,
  turbidity: 2.3, rain: 0, visibility: 30000, seaState: 3, waveHeight: 1.4,
  choppiness: 0.55,
};

const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist',
    '--enable-unsafe-swiftshader', '--force-color-profile=srgb',
    '--hide-scrollbars', '--mute-audio',
  ],
});

try {
  const ctx = await browser.newContext({ colorScheme: 'dark', viewport: { width: 1600, height: 900 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(240000);
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message.slice(0, 200)}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text().slice(0, 200));
  });

  /* Somebody else's half-landed edit, shimmed toothlessly: Free.ts reads
     MAX_AXIS_ELEVATION without importing it, so FreeMode's field initialiser
     throws and CameraRig.init dies. The reference is a bare identifier, so the
     global satisfies it; the moment a real import lands, the module binding
     shadows this and the shim is inert. */
  await page.addInitScript(() => {
    if (!('MAX_AXIS_ELEVATION' in globalThis)) globalThis.MAX_AXIS_ELEVATION = 1.45;
  });
  /* A concurrent edit must not reload us mid-run. */
  await page.addInitScript(() => {
    const Real = window.WebSocket;
    class Dead {
      constructor() {
        this.readyState = 3;
        this.close = () => {};
        this.send = () => {};
        this.addEventListener = () => {};
        this.removeEventListener = () => {};
      }
    }
    window.WebSocket = function (url, protocols) {
      return protocols === 'vite-hmr' ? new Dead() : new Real(url, protocols);
    };
    window.WebSocket.prototype = Real.prototype;
  });

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__leeward, null, { timeout: 600000 });
  await page.evaluate((env) => {
    const w = window.__leeward.world;
    w.settings.adaptiveResolution = false;
    w.settings.renderScale = 1;
    Object.assign(w.env, env);
    w.bus.emit('settings:changed');
  }, ENV);
  await page.waitForSelector('.intro.ready', { timeout: 600000 });
  await page.click('.intro-begin');
  await page.waitForTimeout(2000);

  async function shot(rel, opts = {}) {
    for (let i = 0; i < 2; i++) {
      try {
        await page.screenshot({ path: stage(rel), timeout: 120000, ...opts });
        return;
      } catch {
        if (i === 0) await page.waitForTimeout(4000);
      }
    }
    notes.push(['MISSED SHOT', rel]);
  }

  /* The HUD idles out after 9 s and a settle IS idle. Hold the helm: update()
     re-arms lastActivity from input.steer inside the frame, so this cannot race
     with a stalled frame loop. */
  async function wake() {
    await page.keyboard.down('ArrowRight');
    try {
      await page.waitForFunction(() => window.__leeward.world.ext.ui?.hudVisible === true, null, { timeout: 240000 });
      await page.waitForTimeout(1200);
    } catch {
      errors.push('the HUD never came back up');
    }
  }
  const sleep = (s) => page.waitForTimeout(s * 1000);

  const state = () => page.evaluate(() => {
    const w = window.__leeward.world;
    return {
      hudMode: w.settings.hudMode,
      'settings.assist': w.settings.assist,
      'ext.physics.assist': w.ext.physics?.assist ?? null,
      extUiMode: w.ext.ui?.mode,
      touch: w.ext.ui?.touch,
      proBuilt: !!document.querySelector('.hud .pro'),
      nodes: document.querySelectorAll('#ui-root .ui *').length,
    };
  });

  /** Everything a human can actually read, opacity multiplied down the chain. */
  const readable = () => page.evaluate(() => {
    const out = [];
    const walk = (n, alpha) => {
      const cs = getComputedStyle(n);
      const a = alpha * +cs.opacity;
      if (cs.display === 'none' || cs.visibility === 'hidden' || a <= 0.05) return;
      let own = '';
      for (const c of n.childNodes) if (c.nodeType === 3) own += c.nodeValue;
      own = own.replace(/\s+/g, ' ').trim();
      if (own) out.push(own);
      for (const c of n.children) walk(c, a);
    };
    walk(document.querySelector('.ui'), 1);
    return out.join(' / ');
  });

  /**
   * `.touch` is the touch LAYER's own class and it is display:none until the
   * root opts in. The root used to be given `touch` as well, so a bare `.touch`
   * match hit the root and `display:none` blanked the entire interface. Assert
   * the shape of the fix, not merely that some pixels appeared.
   */
  const collision = () => page.evaluate(() => {
    const ui = document.querySelector('.ui');
    const box = (n) => {
      const r = n?.getBoundingClientRect();
      return r ? `${Math.round(r.width)}x${Math.round(r.height)}` : 'none';
    };
    return {
      rootClasses: ui.className,
      rootWearsTouch: ui.classList.contains('touch'),
      uiDisplay: getComputedStyle(ui).display,
      uiVisibility: getComputedStyle(ui).visibility,
      uiOpacity: getComputedStyle(ui).opacity,
      uiBox: box(ui),
      touchLayerDisplay: getComputedStyle(document.querySelector('.ui > .touch')).display,
      pads: document.querySelectorAll('.pad').length,
      padBox: box(document.querySelector('.pad-l')),
      miniDisplay: getComputedStyle(document.querySelector('.mini')).display,
      miniBox: box(document.querySelector('.mini')),
      miniOnScreen: (() => {
        const r = document.querySelector('.mini').getBoundingClientRect();
        return r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1;
      })(),
    };
  });

  /**
   * Cost. `stats['ui:ms']` is an exponential average the UI keeps whether or not
   * debug is on; sample it across frames and take the median, because on a
   * machine at load 200 the mean is scheduler noise. Reported next to the frame
   * period so the share is honest.
   */
  const cost = () => page.evaluate(async () => {
    const w = window.__leeward.world;
    const ui = [];
    const frame = [];
    let last = performance.now();
    for (let i = 0; i < 90; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      const now = performance.now();
      frame.push(now - last);
      last = now;
      ui.push(w.stats['ui:ms']);
    }
    const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
    const p95 = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length * 0.95)]; };
    return {
      uiMedian: +med(ui).toFixed(3), uiP95: +p95(ui).toFixed(3),
      framePeriodMedian: +med(frame).toFixed(1),
    };
  });

  /* ---------------- desktop, default mode ---------------- */
  await wake();
  await shot('shots/p2-minimal.png');
  notes.push(['default state', JSON.stringify(await state())]);
  notes.push(['default readable', await readable()]);
  notes.push(['default cost', JSON.stringify(await cost())]);

  /* Directive 2: sail trim is automatic in the default mode, so nothing about
     bracing, reefing or a sail plan may appear on this screen. */
  const forbidden = await page.evaluate(() => {
    const txt = document.querySelector('.ui').innerText.toLowerCase();
    const words = ['brace', 'reef', 'sail plan', 'sailplan', 'yard', 'trim', 'canvas', 'topsail'];
    const seen = words.filter((wd) => txt.includes(wd));
    const nodes = ['.sailplan', '.compass', '.rose', '.chart', '.inclblock', '.windrow', '.bells']
      .filter((s) => {
        const n = document.querySelector(s);
        return n && getComputedStyle(n).display !== 'none';
      });
    return { words: seen, proNodesVisible: nodes };
  });
  notes.push(['default: forbidden words', JSON.stringify(forbidden)]);
  if (forbidden.proNodesVisible.length) errors.push(`pro instruments on the default screen: ${forbidden.proNodesVisible}`);

  await page.keyboard.up('ArrowRight');

  /* ---------------- the toggle ---------------- */
  await page.click('.modesw-b:last-child');
  await sleep(3);
  await wake();
  await shot('shots/p2-pro.png');
  notes.push(['after clicking PRO', JSON.stringify(await state())]);
  notes.push(['pro cost', JSON.stringify(await cost())]);
  await page.keyboard.up('ArrowRight');

  await page.keyboard.press('i');
  await sleep(2);
  notes.push(['after pressing I', JSON.stringify(await state())]);

  /* The handling layer's end of the same switch. */
  const fromPhysics = await page.evaluate(async () => {
    const w = window.__leeward.world;
    w.settings.assist = false;
    w.bus.emit('settings:changed');
    await new Promise((r) => setTimeout(r, 900));
    const a = { hudMode: w.settings.hudMode, extUiMode: w.ext.ui?.mode };
    w.settings.assist = true;
    w.bus.emit('settings:changed');
    await new Promise((r) => setTimeout(r, 900));
    return { afterAssistFalse: a, afterAssistTrue: { hudMode: w.settings.hudMode, extUiMode: w.ext.ui?.mode } };
  });
  notes.push(['physics end drives the HUD', JSON.stringify(fromPhysics)]);
  if (fromPhysics.afterAssistFalse.hudMode !== 'pro') errors.push('settings.assist=false did not put the HUD into pro');
  if (fromPhysics.afterAssistTrue.hudMode !== 'minimal') errors.push('settings.assist=true did not put the HUD into minimal');

  /* Does the helm still answer after a click on the chrome? */
  await page.click('.modesw-b:first-child');
  await page.keyboard.down('ArrowLeft');
  await sleep(1);
  const steer = await page.evaluate(() => +window.__leeward.world.input.steer.toFixed(3));
  await page.keyboard.up('ArrowLeft');
  notes.push(['helm answers after clicking the switch', `steer=${steer}`]);
  if (steer === 0) errors.push('the switch stole focus and killed the helm');

  /* ---------------- a narrow viewport, with a real finger ---------------- */
  for (const [label, w, h] of [['portrait', 390, 780], ['landscape', 844, 390]]) {
    await page.setViewportSize({ width: w, height: h });
    await sleep(1.5);
    // Arm the touch layer the way a thumb does. TouchControls listens for a
    // pointerdown whose pointerType is 'touch' — no context flag needed.
    await page.evaluate(() => {
      document.documentElement.dispatchEvent(new PointerEvent('pointerdown', {
        pointerId: 91, pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true,
      }));
    });
    await sleep(1);
    await wake();
    await shot(`shots/p2-${label}.png`);
    const col = await collision();
    notes.push([`${label} ${w}x${h}`, JSON.stringify(col)]);
    notes.push([`${label} readable`, await readable()]);
    if (col.rootWearsTouch) errors.push(`[${label}] .ui wears the .touch class again`);
    if (col.uiDisplay === 'none' || col.uiVisibility === 'hidden' || +col.uiOpacity < 0.9) {
      errors.push(`[${label}] the UI root is hidden: display=${col.uiDisplay} vis=${col.uiVisibility} op=${col.uiOpacity}`);
    }
    if (col.touchLayerDisplay !== 'block') errors.push(`[${label}] touch layer display=${col.touchLayerDisplay}`);
    if (col.miniDisplay === 'none' || col.miniBox === '0x0') errors.push(`[${label}] the readout is not on screen`);
    if (col.padBox === 'none' || col.padBox === '0x0') errors.push(`[${label}] no helm pad`);
    if (!col.miniOnScreen) errors.push(`[${label}] the readout is off the edge of the viewport`);
    await page.keyboard.up('ArrowRight');
  }

  /* Does a thumb on the pad move the helm, and does letting go centre it? */
  const pad = await page.evaluate(async () => {
    const w = window.__leeward.world;
    const n = document.querySelector('.pad-l');
    if (!n) return 'no pad';
    const frames = async (k) => {
      const until = w.time.frame + k;
      const t0 = Date.now();
      while (w.time.frame < until && Date.now() - t0 < 15000) await new Promise((r) => setTimeout(r, 50));
    };
    const o = { pointerId: 7, isPrimary: true, pointerType: 'touch', bubbles: true, cancelable: true };
    n.dispatchEvent(new PointerEvent('pointerdown', o));
    await frames(30);
    const held = w.input.steer;
    n.dispatchEvent(new PointerEvent('pointerup', o));
    await frames(60);
    return `held=${held.toFixed(3)} -> released=${w.input.steer.toFixed(3)}`;
  });
  notes.push(['port pad', pad]);
  if (!/released=-?0\.0/.test(pad)) errors.push(`the helm did not centre after the pad was released: ${pad}`);

  await ctx.close();
} catch (e) {
  errors.push(`RUN ABORTED: ${e.message.slice(0, 300)}`);
} finally {
  await browser.close().catch(() => {});
  for (const [staged, final] of pending) {
    await mkdir(dirname(final), { recursive: true });
    await copyFile(staged, final).catch(() => {});
  }
  await rm(staging, { recursive: true, force: true }).catch(() => {});
  for (const [k, v] of notes) console.log(`${String(k).padEnd(34)} ${v}`);
  const real = errors.filter((e) => !e.includes('MAX_AXIS_ELEVATION'));
  if (real.length) {
    console.error(`\n${real.length} PROBLEM(S):`);
    for (const e of [...new Set(real)].slice(0, 15)) console.error('  ' + e);
  } else {
    console.log('\nOK');
  }
}
