#!/usr/bin/env node
/**
 * UI probe: the two modes, the toggle, the first-run hint, and a phone.
 *
 * capture.mjs drives the engine straight into capture mode, which dismisses the
 * title and the hint — exactly what a screenshot of the sea wants and exactly
 * wrong for judging the chrome. This one takes the player's path: wait for the
 * title, press Begin, then work the toggle the way a finger would.
 *
 *   node .tmp/uiprobe.mjs
 *
 * Writes shots/probe-*.png next to the capture harness output. Same staging
 * trick: PNGs land outside the Vite root and are copied in at exit.
 */

import { chromium } from 'playwright';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import process from 'node:process';

const URL = 'http://127.0.0.1:5178/';
const staging = await mkdtemp(join(tmpdir(), 'leeward-probe-'));
const pending = [];

function stage(rel) {
  const final = resolve(rel);
  const staged = join(staging, `${pending.length}-${basename(final)}`);
  pending.push([staged, final]);
  return staged;
}

/** Mid-morning, fresh breeze — the same light for every frame here. */
const ENV = {
  timeOfDay: 10.4, windSpeed: 9.5, cloudCover: 0.42, cloudType: 0.75,
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

const errors = [];
const notes = [];

async function boot(ctxOpts, label) {
  const ctx = await browser.newContext({ colorScheme: 'dark', ...ctxOpts });
  const page = await ctx.newPage();
  // Several agents share this machine and load averages north of 150 happen.
  // The 30 s default turns a busy minute into a crashed probe run.
  page.setDefaultTimeout(180000);
  page.on("pageerror", (e) => { errors.push(`[${label}] pageerror: ${e.message}`); console.error(`  !! [${label}] ${e.message.slice(0, 300)}`); });
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[${label}] ${m.text()}`);
  });
  // Dead HMR socket: a concurrent edit must not reload us mid-run.
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
  await page.waitForFunction(() => !!window.__leeward, null, { timeout: 60000 });
  await page.evaluate((env) => {
    const w = window.__leeward.world;
    w.settings.adaptiveResolution = false;
    w.settings.renderScale = 1;
    Object.assign(w.env, env);
    w.bus.emit('settings:changed');
  }, ENV);
  return { ctx, page };
}

async function begin(page) {
  await page.waitForSelector('.intro.ready', { timeout: 60000 });
  await page.click('.intro-begin');
  await page.waitForTimeout(1400);
}

async function settle(page, s) {
  await page.waitForTimeout(s * 1000);
}

/**
 * A screenshot that cannot take the run down with it.
 *
 * Several agents share this machine; at load 200 Chromium's GPU process gets
 * starved and `captureScreenshot` simply never returns. Losing one frame is a
 * nuisance, losing the assertions that came after it is what actually wasted a
 * session — so retry once, then record the gap and carry on.
 */
async function shot(page, rel, opts = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await page.screenshot({ path: stage(rel), timeout: 90000, ...opts });
      return true;
    } catch {
      if (attempt === 0) await page.waitForTimeout(4000);
    }
  }
  notes.push(['MISSED SHOT (machine starved)', rel]);
  return false;
}

/** Self-cost, read straight off the blackboard the UI writes it to. */
async function uiCost(page) {
  return page.evaluate(() => +window.__leeward.world.stats['ui:ms'].toFixed(4));
}

async function state(page) {
  return page.evaluate(() => {
    const w = window.__leeward.world;
    return {
      hudMode: w.settings.hudMode,
      assist: w.settings.assist,
      extMode: w.ext.ui?.mode,
      extTouch: w.ext.ui?.touch,
      nodes: document.querySelectorAll('#ui-root .ui *').length,
      proBuilt: !!document.querySelector('.hud .pro'),
      knots: +w.ship.speedKnots.toFixed(1),
    };
  });
}

/**
 * The regression check for the bug that cost a session: `.touch` is the touch
 * LAYER's class, and it is `display: none` until the root opts in. If the root
 * ever wears `touch` itself, a bare `.touch` match hides the whole interface.
 * Assert the shape of the fix, not just that pixels appeared.
 */
async function collision(page) {
  return page.evaluate(() => {
    const ui = document.querySelector('.ui');
    const touch = document.querySelector('.ui > .touch');
    const mini = document.querySelector('.mini');
    const box = (n) => {
      const r = n?.getBoundingClientRect();
      return r ? Math.round(r.width) + 'x' + Math.round(r.height) : 'none';
    };
    return {
      rootClasses: ui ? ui.className : 'NO .ui',
      rootWearsTouch: !!ui?.classList.contains('touch'),
      uiDisplay: ui ? getComputedStyle(ui).display : '-',
      uiOpacity: ui ? getComputedStyle(ui).opacity : '-',
      uiBox: box(ui),
      touchDisplay: touch ? getComputedStyle(touch).display : 'no layer',
      pads: document.querySelectorAll('.pad').length,
      padBox: box(document.querySelector('.pad-l')),
      miniDisplay: mini ? getComputedStyle(mini).display : 'no mini',
      miniBox: box(mini),
      // What a human would actually read off the screen. Walk to the leaves and
      // multiply opacity down the chain: `textContent` on a container happily
      // reports the irons nag that is sitting at opacity 0 waiting its turn,
      // which had this log claiming the default screen was scolding the player.
      visibleText: (() => {
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
        for (const root of document.querySelectorAll('.mini, .modesw, .firstrun')) walk(root, 1);
        return out.join(' / ');
      })(),
    };
  });
}

/* ------------------------------------------------------------------ *
 *  desktop — 1600x900
 * ------------------------------------------------------------------ */

{
  const { ctx, page } = await boot({ viewport: { width: 1600, height: 900 } }, 'desktop');
  await begin(page);

  // The hint is live and the player has not touched anything yet.
  await shot(page, 'shots/probe-hint.png');
  notes.push(['first-run hint', JSON.stringify(await state(page))]);

  // Steer, the way the hint says to. The hint should give up.
  await page.keyboard.down('ArrowLeft');
  await page.waitForTimeout(1400);
  await page.keyboard.up('ArrowLeft');
  await settle(page, 5);
  await shot(page, 'shots/probe-minimal.png');
  const minCost = await uiCost(page);
  const minState = await state(page);
  notes.push(['minimal', `${minCost.toFixed(4)} ms  ${JSON.stringify(minState)}`]);

  const hintGone = await page.evaluate(() => {
    const n = document.querySelector('.firstrun');
    return !n || getComputedStyle(n).opacity === '0' || getComputedStyle(n).display === 'none';
  });
  notes.push(['hint faded after moving', String(hintGone)]);

  // The toggle, clicked exactly where a player would click it.
  await page.click('.modesw-b:last-child');
  await settle(page, 4);
  await shot(page, 'shots/probe-pro.png');
  const proCost = await uiCost(page);
  notes.push(['pro', `${proCost.toFixed(4)} ms  ${JSON.stringify(await state(page))}`]);

  // ...and back, by key this time.
  await page.keyboard.press('i');
  await settle(page, 3);
  await shot(page, 'shots/probe-back.png');
  notes.push(['back via I', JSON.stringify(await state(page))]);

  // Does the helm still answer after clicking the toggle? (Focus theft check.)
  await page.click('.modesw-b:first-child');
  await page.keyboard.down('ArrowRight');
  await page.waitForTimeout(600);
  const steering = await page.evaluate(() => +window.__leeward.world.input.steer.toFixed(3));
  await page.keyboard.up('ArrowRight');
  notes.push(['helm answers after a click on the toggle', `steer=${steering}`]);

  // Idle fade, and the panel.
  await page.click('.menu');
  await settle(page, 1.5);
  await shot(page, 'shots/probe-panel.png');
  await page.keyboard.press('Escape');

  await ctx.close();
}

/* ------------------------------------------------------------------ *
 *  phone — landscape and portrait, real touch emulation
 * ------------------------------------------------------------------ */

for (const [label, viewport] of [
  ['landscape', { width: 844, height: 390 }],
  ['portrait', { width: 390, height: 780 }],
]) {
  const { ctx, page } = await boot(
    { viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 2 },
    `phone-${label}`,
  );
  await begin(page);
  await settle(page, 5);
  await shot(page, `shots/probe-phone-${label}.png`);
  const st = await state(page);
  notes.push([`phone ${label}`, `${(await uiCost(page)).toFixed(4)} ms  ${JSON.stringify(st)}`]);
  const col = await collision(page);
  notes.push([`phone ${label} collision`, JSON.stringify(col)]);
  if (col.rootWearsTouch) errors.push(`[phone-${label}] .ui wears the .touch class again`);
  if (col.uiDisplay === 'none' || +col.uiOpacity < 0.9) errors.push(`[phone-${label}] the UI root is hidden`);
  if (col.miniDisplay === 'none' || col.miniBox === '0x0') errors.push(`[phone-${label}] the minimal readout is not on screen`);
  if (col.touchDisplay !== 'block') errors.push(`[phone-${label}] touch layer display=${col.touchDisplay}`);
  if (col.padBox === 'none' || col.padBox === '0x0') errors.push(`[phone-${label}] no helm pad`);

  // Hold the port pad and see whether the helm actually goes over — then, more
  // importantly, whether letting go centres it again. Wall-clock waits lie here:
  // under load the frame loop stalls for most of a second and an unchanged
  // `steer` reads as a stuck helm when nothing has been integrated at all. Wait
  // on `time.frame` instead, so the sample is always taken after the sim ran.
  const steer = await page.evaluate(async () => {
    const w = window.__leeward.world;
    const pad = document.querySelector('.pad-l');
    if (!pad) return 'no pad';
    const frames = async (n) => {
      const until = w.time.frame + n;
      const t0 = Date.now();
      while (w.time.frame < until && Date.now() - t0 < 8000) {
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    const opts = { pointerId: 3, isPrimary: true, pointerType: 'touch', bubbles: true, cancelable: true };
    pad.dispatchEvent(new PointerEvent('pointerdown', opts));
    await frames(30);
    const held = w.input.steer;
    const keysHeld = [...w.input.keys].join(',');
    pad.dispatchEvent(new PointerEvent('pointerup', opts));
    await frames(60);
    const keysAfter = [...w.input.keys].join(',');
    return `held=${held.toFixed(3)} [${keysHeld}] -> released=${w.input.steer.toFixed(3)} [${keysAfter || 'none'}]`;
  });
  if (!/released=-?0\.0/.test(steer)) errors.push(`[phone-${label}] the helm did not centre: ${steer}`);
  notes.push([`phone ${label} port pad`, steer]);

  // The thumb pads over sunlit wake — the background they actually have to beat.
  // Clipped to the bottom strip at device scale 2 so the chevron weight is real.
  await shot(page, `shots/probe-pads-${label}.png`, {
    clip: { x: 0, y: viewport.height - 110, width: viewport.width, height: 110 },
  });

  if (label === 'landscape') {
    await page.click('.modesw-b:last-child');
    await settle(page, 3);
    await shot(page, 'shots/probe-phone-pro.png');
    notes.push(['phone pro', JSON.stringify(await state(page))]);
    // Pro adds the sail pair. It must not land on top of an instrument.
    const overlap = await page.evaluate(() => {
      const r = (s) => document.querySelector(s)?.getBoundingClientRect() ?? null;
      const hits = [];
      const sail = r('.pad-sail');
      if (!sail) return 'no sail pads';
      for (const sel of ['.rose', '.r-bot-r', '.r-bot-c', '.pad-r', '.mini', '.sailplan', '.inclblock']) {
        const b = r(sel);
        if (!b || b.width === 0) continue;
        const over = !(b.right <= sail.left || b.left >= sail.right || b.bottom <= sail.top || b.top >= sail.bottom);
        if (over) hits.push(sel);
      }
      return hits.length ? 'OVERLAPS ' + hits.join(',') : 'clear';
    });
    notes.push(['phone pro sail pads', overlap]);
    if (overlap.startsWith('OVERLAPS')) errors.push(`[phone-${label}] sail pads ${overlap}`);
    await shot(page, 'shots/probe-pads-pro.png', {
      clip: { x: 0, y: viewport.height - 130, width: viewport.width, height: 130 },
    });
  }
  await ctx.close();
}

/* ------------------------------------------------------------------ *
 *  zoom — the two corners at 2x, over the two hardest backgrounds
 * ------------------------------------------------------------------ */

/* A 9 px cap and a 40 px numeral are a typographic claim, and a 1600x900 PNG
   downsampled for review cannot test it. Shoot the corners at device scale 2
   over a dark sea and then over a storm's pale foam, which is the brightest
   thing the readouts ever have to sit on. */
{
  const W = 1600, H = 900;
  const { ctx, page } = await boot(
    { viewport: { width: W, height: H }, deviceScaleFactor: 2 },
    'zoom',
  );
  await begin(page);

  const corners = {
    mini: { x: 0, y: H - 150, width: 330, height: 150 },
    modesw: { x: W - 300, y: 0, width: 300, height: 60 },
  };

  for (const [label, env] of [
    ['dark', ENV],
    ['bright', { ...ENV, timeOfDay: 12.4, windSpeed: 24, cloudCover: 0.95, rain: 0.8, seaState: 8, waveHeight: 5.5, turbidity: 6, visibility: 4500 }],
  ]) {
    await page.evaluate((e) => {
      Object.assign(window.__leeward.world.env, e);
      window.__leeward.world.bus.emit('settings:changed');
    }, env);
    await settle(page, label === 'dark' ? 4 : 9);
    // The idle fade is 9 s and a settle IS idle, so the first two versions of
    // this pass shot an empty corner and called it a legibility result. A
    // pointer nudge was not enough either — it depends on an event arriving in
    // a frame, and frames are exactly what a loaded machine is not delivering.
    // Hold the helm instead: `update()` re-arms `lastActivity` from `input.steer`
    // inside the frame itself, so this cannot race. Then WAIT for the state
    // rather than guessing a duration.
    await page.keyboard.down('ArrowRight');
    let up = true;
    try {
      await page.waitForFunction(() => window.__leeward.world.ext.ui?.hudVisible === true, null, { timeout: 60000 });
      await page.waitForTimeout(1100); // the 0.85 s fade-in, plus slack
    } catch {
      up = false;
      errors.push(`[zoom-${label}] the HUD never came back up — nothing to judge`);
    }
    for (const [c, clip] of Object.entries(corners)) {
      if (up) await shot(page, `shots/probe-zoom-${label}-${c}.png`, { clip });
    }
    await page.keyboard.up('ArrowRight');
  }
  notes.push(['zoom pass', `${(await uiCost(page)).toFixed(4)} ms`]);
  await ctx.close();
}

/* ------------------------------------------------------------------ *
 *  flat plates — contrast, measured instead of admired
 * ------------------------------------------------------------------ */

/* The scene is the wrong instrument for a legibility test: the sky is whatever
   six other agents left it, and the day the ocean renders black is the day a
   contrast pass reports 17:1 and means nothing. So hide the canvas and put a
   flat plate behind the chrome — a blown white sky, a hazy noon sky, sunlit
   foam, and a night sea. Those four numbers are reproducible, and the white one
   is the worst case that can physically exist. Frames go out at dpr 1 so the
   measuring script's rectangles land where it thinks they do. */
{
  const { ctx, page } = await boot({ viewport: { width: 1600, height: 900 } }, 'flat');
  await begin(page);
  await page.addStyleTag({
    content: '#viewport{visibility:hidden!important}#app{background:var(--plate)!important}',
  });

  for (const [label, plate] of [
    ['white', '#ffffff'],
    ['sky', '#b9c6d2'],
    ['foam', '#dfe6ea'],
    ['night', '#060a0f'],
  ]) {
    await page.evaluate((c) => document.documentElement.style.setProperty('--plate', c), plate);
    // Same reason as the zoom pass: a settle is idle time, and idle fades the
    // HUD out. Hold the helm and wait for the state, never for the clock.
    await page.keyboard.down('ArrowRight');
    try {
      await page.waitForFunction(() => window.__leeward.world.ext.ui?.hudVisible === true, null, { timeout: 60000 });
      await page.waitForTimeout(1100);
      await shot(page, `shots/probe-flat-${label}.png`);
    } catch {
      errors.push(`[flat-${label}] the HUD never came back up`);
    }
    await page.keyboard.up('ArrowRight');
  }
  await ctx.close();
}

await browser.close();
for (const [staged, final] of pending) {
  await mkdir(dirname(final), { recursive: true });
  await copyFile(staged, final).catch(() => {});
}
await rm(staging, { recursive: true, force: true }).catch(() => {});

for (const [k, v] of notes) console.log(`${k.padEnd(42)} ${v}`);
if (errors.length) {
  console.error(`\n${errors.length} CONSOLE ERROR(S):`);
  for (const e of errors.slice(0, 20)) console.error('  ' + e);
  process.exit(1);
}
console.log('\nOK');
