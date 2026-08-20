#!/usr/bin/env node
/**
 * Is this repo in a state you could push and publish right now?
 *
 * Push-readiness is not a one-off chore — it decays. Every agent that adds a
 * probe, a screenshot or a scratch file can quietly make the repo
 * unpublishable, and nobody notices until the day someone tries. So it is a
 * check that runs on demand and in CI, not a task somebody remembers.
 *
 *   npm run preflight
 *
 * Exits non-zero with a specific reason. Warnings do not fail the run.
 */

import { execFileSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import process from 'node:process';

const fail = [];
const warn = [];
const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim();
const tracked = git('ls-files').split('\n').filter(Boolean);

/* 1. Nothing that should never be published. -------------------------------- */
const FORBIDDEN = [
  [/(^|\/)node_modules\//, 'dependencies'],
  [/(^|\/)dist\//, 'build output'],
  [/(^|\/)\.tmp\//, 'scratch probes'],
  [/(^|\/)shots\//, 'captures'],
  [/(^|\/)(sheets|compare)\//, 'contact sheets'],
  [/\.DS_Store$/, 'macOS metadata'],
  [/\.key\.json$/, 'blind-compare answer keys'],
  [/(^|\/)\.env/, 'environment files'],
  [/\.(pem|key|p12|keystore)$/, 'credentials'],
];
for (const f of tracked) {
  for (const [re, what] of FORBIDDEN) {
    if (re.test(f)) fail.push(`tracked ${what}: ${f}`);
  }
}

/* 2. No plausible secret in tracked content. -------------------------------- */
// Deliberately narrow. A broad pattern matched "mask-image" for containing "sk-",
// and a check that cries wolf gets switched off.
const SECRET = /(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[baprs]-[A-Za-z0-9-]{10,})/;
for (const f of tracked) {
  if (/\.(png|jpg|jpeg|webp|ico|woff2?|ttf|mp3|wav)$/i.test(f)) continue;
  let text;
  try {
    text = await readFile(f, 'utf8');
  } catch {
    continue;
  }
  if (SECRET.test(text)) fail.push(`possible credential in ${f}`);
}

/* 3. Size. A publishable browser game stays small. -------------------------- */
for (const f of tracked) {
  try {
    const { size } = await stat(f);
    if (size > 2 * 1024 * 1024) fail.push(`${f} is ${(size / 1048576).toFixed(1)} MB — too large to publish`);
    else if (size > 512 * 1024) warn.push(`${f} is ${Math.round(size / 1024)} KB`);
  } catch { /* deleted-but-tracked; git status will say */ }
}

/* 4. The documents a stranger needs. ---------------------------------------- */
for (const doc of ['README.md', 'HANDOVER.md', 'AGENTS.md', 'DIAGNOSIS.md', 'RUBRIC.md']) {
  if (!tracked.includes(doc)) fail.push(`missing ${doc}`);
}

/* 5. The HTML a crawler and a share preview need. --------------------------- */
const html = await readFile('index.html', 'utf8');
const NEEDED = [
  [/<html[^>]+lang=/, 'html lang'],
  [/name="description"/, 'meta description'],
  [/property="og:title"/, 'og:title'],
  [/property="og:description"/, 'og:description'],
  [/property="og:image"/, 'og:image'],
  [/name="twitter:card"/, 'twitter:card'],
  [/rel="manifest"/, 'web manifest'],
  [/rel="icon"/, 'favicon'],
  [/application\/ld\+json/, 'structured data'],
  [/<noscript>/, 'noscript fallback'],
];
for (const [re, what] of NEEDED) if (!re.test(html)) fail.push(`index.html is missing ${what}`);

// A render-blocking third-party stylesheet is the LCP killer on a game like this.
if (/<link[^>]+rel="stylesheet"[^>]+fonts\.googleapis/.test(html) && !/media="print"/.test(html)) {
  fail.push('index.html loads webfonts render-blocking — load them non-blocking');
}
if (!tracked.includes('public/social-card.jpg')) {
  warn.push('no public/social-card.jpg — og:image will 404, so shares show no preview');
}

/* 6. base must stay relative or a project-site subpath breaks. -------------- */
const vite = await readFile('vite.config.ts', 'utf8');
if (!/base:\s*'\.\/'/.test(vite)) fail.push("vite.config.ts: base must stay './' for a GitHub Pages subpath");

/* 7. A licence is required to publish, and is the owner's choice. ----------- */
if (!tracked.some((f) => /^LICEN[SC]E/.test(f))) warn.push('no LICENSE — pick one before publishing');

/* ------------------------------------------------------------------------- */
for (const w of warn) console.log(`warn  ${w}`);
if (fail.length) {
  console.error('\nNOT PUSH-READY:');
  for (const f of fail) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`\npreflight: push-ready (${tracked.length} tracked files)`);
