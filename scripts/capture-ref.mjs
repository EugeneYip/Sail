#!/usr/bin/env node
/**
 * Reference-capture harness for https://slowroads.io/
 *
 * Modelled on scripts/capture.mjs: boots a real Chromium with real GPU
 * rasterisation (same launch args), drives the target page into a state
 * worth screenshotting, and writes PNGs to disk.
 *
 * Flow (only reached if no bot-challenge is served — see policy note below):
 *   1. Navigate to the site.
 *   2. Screenshot the landing screen.
 *   3. Try to click through whatever "begin/play" affordance is present.
 *   4. Hold a forward-drive input and capture N frames at a fixed interval.
 *   5. Best-effort: find a settings/gear affordance and capture a couple of
 *      time-of-day / weather variations. This step is soft-timeboxed and is
 *      skipped (not retried indefinitely) if nothing plausible is found.
 *
 *   node scripts/capture-ref.mjs --out refs --frames 10 --interval 6 --w 1600 --h 900
 *
 * ---------------------------------------------------------------------
 * BOT-DETECTION / CAPTCHA POLICY — read before touching the guard below.
 * ---------------------------------------------------------------------
 * If the site responds with an interactive "verify you are human" /
 * Cloudflare Turnstile-style challenge (or any similar bot-detection
 * interstitial), this script logs what it saw, saves ONE evidence
 * screenshot, and exits non-zero. It does not:
 *   - click the verification checkbox or solve any challenge,
 *   - patch navigator.webdriver / plugins / other automation fingerprints,
 *   - retry through proxies, alternate IPs, or headed mode to dodge scoring,
 *   - loop/retry hoping the challenge lapses.
 * That is intentional and out of scope by design — do not "fix" the guard
 * to push past a real challenge. If this fires, the right move is to run
 * the capture from a normal, human-driven browser session instead.
 */

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

/* ------------------------------------------------------------------ *
 *  args
 * ------------------------------------------------------------------ */

function parseArgs(argv) {
  const out = {
    url: 'https://slowroads.io/',
    out: 'refs',
    w: 1600,
    h: 900,
    frames: 10,
    interval: 6, // seconds between driving frames
    timeout: 45000,
    settleAfterStart: 4000, // ms to let the scene spin up after "begin"
    settingsBudgetMs: 90000, // soft cap on settings-panel exploration
    driveKey: 'ArrowUp',
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) continue;
    i++;
    if (['w', 'h', 'frames', 'interval', 'timeout', 'settleAfterStart', 'settingsBudgetMs'].includes(key)) {
      out[key] = Number(next);
    } else {
      out[key] = next;
    }
  }
  return out;
}

const args = parseArgs(process.argv);
const outDir = resolve(args.out);
await mkdir(outDir, { recursive: true });

/* ------------------------------------------------------------------ *
 *  browser
 * ------------------------------------------------------------------ */

const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-angle=metal',
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    '--enable-unsafe-swiftshader',
    '--enable-webgl',
    '--enable-webgl2-compute-context',
    '--disable-gpu-driver-bug-workarounds',
    '--force-color-profile=srgb',
    '--disable-features=CalculateNativeWinOcclusion',
    '--hide-scrollbars',
    '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
  ],
});

const page = await browser.newPage({
  viewport: { width: args.w, height: args.h },
  deviceScaleFactor: 1,
});

const logs = [];
page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`));
page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
page.on('requestfailed', (r) => logs.push(`requestfailed: ${r.url()} ${r.failure()?.errorText ?? ''}`));

let shotIndex = 0;
async function shot(name, { fullPage = false } = {}) {
  const path = resolve(outDir, name);
  await page.screenshot({ path, fullPage });
  shotIndex++;
  console.log(`[capture-ref] wrote ${path}`);
  return path;
}

/* ------------------------------------------------------------------ *
 *  navigate
 * ------------------------------------------------------------------ */

console.log(`[capture-ref] navigating to ${args.url}`);
let resp = null;
try {
  resp = await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: args.timeout });
} catch (e) {
  console.error(`[capture-ref] navigation failed: ${e.message}`);
}

await page.waitForTimeout(2500);

/* ------------------------------------------------------------------ *
 *  Bot-detection / CAPTCHA guard — see policy note in the file header.
 *  Do not remove or "improve" this to get past a real challenge.
 * ------------------------------------------------------------------ */

const challenge = await page.evaluate(() => {
  const title = document.title || '';
  const text = document.body?.innerText || '';
  const hasCfFrame = !!document.querySelector(
    'iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"]',
  );
  const looksChallenged =
    /just a moment/i.test(title) ||
    /verify you are human/i.test(text) ||
    /checking your browser/i.test(text) ||
    /security service to protect against malicious bots/i.test(text) ||
    hasCfFrame;
  return { looksChallenged, title, snippet: text.slice(0, 400) };
});

if (challenge.looksChallenged) {
  console.error('[capture-ref] BLOCKED: an interactive bot-detection / CAPTCHA challenge was served.');
  console.error(`[capture-ref] HTTP status: ${resp?.status()}`);
  console.error(`[capture-ref] page title: "${challenge.title}"`);
  console.error(`[capture-ref] page text: ${challenge.snippet.replace(/\s+/g, ' ')}`);
  console.error(
    '[capture-ref] Per policy this script will not click the verification control, patch automation ' +
      'fingerprints, retry via proxies/headed mode, or loop waiting for it to lapse. Saving one ' +
      'evidence screenshot and stopping. Run this from a normal human-driven browser session instead.',
  );
  await shot('BLOCKED-cloudflare-challenge.png');
  await browser.close();
  process.exit(1);
}

console.log(
  `[capture-ref] status ${resp?.status()} title "${await page.title()}" — no challenge detected, proceeding`,
);

/* ------------------------------------------------------------------ *
 *  Landing screen
 * ------------------------------------------------------------------ */

await shot('00-landing.png');

// slowroads (and similar procedural-drive sites) typically gate the sim
// behind a "begin"/"play"/"start" affordance, or just start on any
// click/keypress once the world has finished generating. Try the explicit
// affordances first, then fall back to generic click/keypress.
const beginTextPatterns = [/begin/i, /start/i, /play/i, /enter/i, /click.*(start|begin)/i];

async function findAndClickBegin() {
  // 1) Buttons/links/divs whose visible text matches a begin-like word.
  const candidates = await page.$$('button, a, [role=button], div, span');
  for (const el of candidates) {
    let text = '';
    try {
      text = (await el.innerText({ timeout: 500 })) || '';
    } catch {
      continue;
    }
    text = text.trim();
    if (!text || text.length > 40) continue;
    if (beginTextPatterns.some((re) => re.test(text))) {
      const visible = await el.isVisible().catch(() => false);
      if (!visible) continue;
      console.log(`[capture-ref] clicking begin-like control with text "${text}"`);
      await el.click({ timeout: 3000 }).catch((e) => console.log(`[capture-ref] click failed: ${e.message}`));
      return true;
    }
  }
  return false;
}

let clicked = await findAndClickBegin();

if (!clicked) {
  console.log('[capture-ref] no explicit begin/play control found — trying canvas click + Enter/Space fallback');
  const canvas = page.locator('canvas').first();
  if ((await canvas.count()) > 0) {
    await canvas.click({ timeout: 3000 }).catch(() => {});
  } else {
    await page.mouse.click(args.w / 2, args.h / 2).catch(() => {});
  }
  await page.keyboard.press('Enter').catch(() => {});
  await page.keyboard.press('Space').catch(() => {});
}

await page.waitForTimeout(args.settleAfterStart);
await shot('01-after-begin.png');

// Second pass in case "begin" only reveals a further confirmation control.
if (await findAndClickBegin()) {
  await page.waitForTimeout(args.settleAfterStart);
  await shot('02-after-second-begin.png');
}

/* ------------------------------------------------------------------ *
 *  Driving frames
 * ------------------------------------------------------------------ */

console.log(`[capture-ref] holding "${args.driveKey}" and capturing ${args.frames} frame(s) every ${args.interval}s`);

// Hold forward continuously; also nudge with WASD in case the site binds
// that scheme instead of/as well as arrow keys.
await page.keyboard.down(args.driveKey).catch(() => {});
await page.keyboard.down('KeyW').catch(() => {});

for (let i = 0; i < args.frames; i++) {
  await page.waitForTimeout(args.interval * 1000);
  const label = `drive-${String(i + 1).padStart(2, '0')}.png`;
  await shot(label);
  console.log(`[capture-ref] frame ${i + 1}/${args.frames} -> ${label}`);
}

await page.keyboard.up(args.driveKey).catch(() => {});
await page.keyboard.up('KeyW').catch(() => {});

/* ------------------------------------------------------------------ *
 *  Settings panel — best-effort, soft-timeboxed.
 * ------------------------------------------------------------------ */

console.log('[capture-ref] looking for a settings/graphics/weather panel (best-effort)');
const settingsBudgetStart = Date.now();
function timeLeft() {
  return args.settingsBudgetMs - (Date.now() - settingsBudgetStart);
}

const settingsSelectors = [
  '[aria-label*="setting" i]',
  '[title*="setting" i]',
  '[aria-label*="option" i]',
  '[aria-label*="menu" i]',
  '[class*="setting" i]',
  '[class*="gear" i]',
  '[class*="cog" i]',
  'button:has(svg)',
];

let openedSettings = false;
for (const sel of settingsSelectors) {
  if (timeLeft() <= 0) break;
  try {
    const loc = page.locator(sel).first();
    if ((await loc.count()) === 0) continue;
    if (!(await loc.isVisible({ timeout: 500 }).catch(() => false))) continue;
    await loc.click({ timeout: 2000 });
    await page.waitForTimeout(800);
    openedSettings = true;
    console.log(`[capture-ref] opened a candidate settings panel via selector: ${sel}`);
    break;
  } catch {
    /* try next selector */
  }
}

if (openedSettings) {
  await shot('settings-panel.png');

  // Look for anything that smells like a time-of-day or weather control
  // (slider, radio group, or labelled buttons) and try toggling it once or
  // twice, screenshotting each resulting state.
  const stateControls = await page
    .locator(
      '[aria-label*="time" i], [aria-label*="weather" i], [aria-label*="cloud" i], ' +
        'input[type=range], [class*="time" i], [class*="weather" i]',
    )
    .all()
    .catch(() => []);

  let stateShots = 0;
  for (const ctl of stateControls) {
    if (timeLeft() <= 0 || stateShots >= 3) break;
    const visible = await ctl.isVisible().catch(() => false);
    if (!visible) continue;
    try {
      const tag = await ctl.evaluate((n) => n.tagName.toLowerCase());
      if (tag === 'input') {
        // Drag a range input roughly a third and two-thirds across.
        const box = await ctl.boundingBox();
        if (box) {
          await page.mouse.click(box.x + box.width * 0.25, box.y + box.height / 2);
        }
      } else {
        await ctl.click({ timeout: 1500 });
      }
      await page.waitForTimeout(1000);
      stateShots++;
      await shot(`settings-state-${stateShots}.png`);
    } catch {
      /* ignore and move to next control */
    }
  }

  if (stateShots === 0) {
    console.log('[capture-ref] settings panel opened but no time/weather controls could be identified/driven');
  }
} else {
  console.log('[capture-ref] no settings/graphics panel found within budget — skipping (driving frames matter most)');
}

/* ------------------------------------------------------------------ *
 *  wrap up
 * ------------------------------------------------------------------ */

await browser.close();
console.log(`\n[capture-ref] done. ${shotIndex} named shot(s) requested; see console log above for filenames.`);
if (logs.length) {
  console.log('\n[capture-ref] page console/error log tail:');
  for (const l of logs.slice(-40)) console.log('  ' + l);
}
