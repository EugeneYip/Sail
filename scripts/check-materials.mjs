#!/usr/bin/env node
/**
 * Link every MATERIAL program in a real engine boot.
 *
 *   npm run check-materials
 *
 * Needs the dev server on :5178, like `physics-test.mjs`, `assist-test.mjs` and
 * `geometry-test.mjs`. Not in CI for the same reason those are not: CI has no
 * dev server, and `check-shaders.mjs` deliberately avoids booting the engine.
 *
 * WHY THIS EXISTS
 * `check-shaders.mjs` says so itself, in its own header: it does not cover the
 * material shaders at all — `ocean/shaders/surface`, `ship/shaders/{parts,sail,
 * line}`, `vfx`, `world` — because those are injected into three's chunks via
 * `onBeforeCompile`, so only a real engine boot assembles them. It names
 * `capture.mjs`'s console check as the instrument for those. But `capture.mjs`
 * is a screenshot harness: it is not an npm script, it is not in CI, and nobody
 * runs it to check a shader. So the material programs have had NO automated
 * gate, in the bug class the project has said cost it most — a structural fix
 * written and never called left `vAback` undeclared in the depth material and
 * sail shadows silently stopped compiling (DIAGNOSIS 27, 34).
 *
 * WHAT IT PROVES
 * With `?showcase=all` every world subsystem is instantiated, so the ocean, the
 * ship's parts/sail/line materials, the town, the shore, the vessels, the
 * creatures and the VFX all assemble and link against the real ANGLE-on-Metal
 * driver. It then asserts:
 *
 *   - no program carries a failed `diagnostics` record;
 *   - nothing shader-shaped reached the console;
 *   - programs were actually linked, and the named material programs are among
 *     them, so a run where nothing got built cannot pass by being quiet.
 *
 * WHAT IT DOES NOT PROVE
 * That a shader is CORRECT. A program that links can still compute nonsense.
 * This is the compile/link floor, nothing above it.
 */

import { chromium } from 'playwright';
import process from 'node:process';

const URL = 'http://127.0.0.1:5178/?showcase=all';
/** Programs three only names when the material carries a name. These must exist. */
const EXPECTED_NAMED = ['ocean-surface', 'world-terrain', 'world-shore'];
/**
 * Floor on the linked program count. Measured 66 on a clean boot; 40 is well
 * under that but far above a boot that failed to build the world, which is the
 * failure this guards -- a silent nothing is not allowed to look like a pass.
 */
const MIN_PROGRAMS = 40;
/** Anything in console output that would indicate a shader problem. */
const SHADER_SHAPED =
  /THREE\.WebGLProgram|Shader Error|ERROR:\s*\d|Material Name|GL_INVALID|gl\.LINK_STATUS|VALIDATE_STATUS/i;

const failures = [];
const check = (ok, label, detail) => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures.push(label);
};
const note = (label, detail) => console.log(`         ${label}: ${detail}`);

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist',
         '--enable-unsafe-swiftshader', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 800, height: 500 } });

const messages = [];
page.on('console', (m) => messages.push({ type: m.type(), text: m.text() }));
page.on('pageerror', (e) => messages.push({ type: 'pageerror', text: e.message }));

await page.addInitScript(() => {
  const Real = WebSocket;
  class Dead extends EventTarget {
    constructor() { super(); this.readyState = 3; }
    send() {} close() {}
  }
  const Patched = function (url, protocols) {
    const vite = protocols === 'vite-hmr'
      || (Array.isArray(protocols) && protocols.includes('vite-hmr'));
    return vite ? new Dead() : new Real(url, protocols);
  };
  Patched.prototype = Real.prototype;
  Object.assign(Patched, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  window.WebSocket = Patched;
});

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => !!window.__leeward?.world?.renderer, null, { timeout: 180000 });
// Materials assemble lazily, as each subsystem first renders. Wait for the
// showcase to have put the town in the scene, then give the rest a settle.
await page.waitForFunction(() => {
  let seen = false;
  window.__leeward.world.scene.traverse((o) => {
    if (o.name === 'world-boston' && o.geometry?.attributes?.position?.count > 0) seen = true;
  });
  return seen;
}, null, { timeout: 120000 });
await page.waitForTimeout(12000);

console.log('\nMATERIALS — every onBeforeCompile program, linked on a real driver');

const info = await page.evaluate(() => {
  const r = window.__leeward.world.renderer;
  const programs = [...(r.info.programs ?? [])];
  return {
    checkShaderErrors: r.debug?.checkShaderErrors === true,
    count: programs.length,
    named: programs.map((p) => p.name).filter(Boolean),
    broken: programs
      .filter((p) => p.diagnostics && p.diagnostics.runnable === false)
      .map((p) => ({ name: p.name || '(unnamed)', log: String(p.diagnostics.programLog ?? '').slice(0, 200) })),
    geometries: r.info.memory.geometries,
    textures: r.info.memory.textures,
  };
});

note('linked programs', `${info.count} (${info.geometries} geometries, ${info.textures} textures)`);
note('named material programs', info.named.join(', ') || '(none named)');

// If three is not checking, a broken program would link silently and every
// assertion below would be vacuous.
check(info.checkShaderErrors,
  'the renderer is actually checking shader errors',
  `renderer.debug.checkShaderErrors = ${info.checkShaderErrors}`);

check(info.count >= MIN_PROGRAMS,
  'the world actually built its programs',
  `${info.count} linked, floor ${MIN_PROGRAMS}`);

const missing = EXPECTED_NAMED.filter((n) => !info.named.includes(n));
check(missing.length === 0,
  'the named material programs are present',
  missing.length ? `missing: ${missing.join(', ')}` : info.named.join(', '));

check(info.broken.length === 0,
  'no program failed to link',
  info.broken.length
    ? info.broken.map((b) => `${b.name}: ${b.log}`).join(' | ')
    : `${info.count} programs, none with a failed diagnostics record`);

const shaderMsgs = messages.filter((m) => SHADER_SHAPED.test(m.text));
const errorMsgs = messages.filter((m) => m.type === 'error' || m.type === 'pageerror');
check(shaderMsgs.length === 0,
  'nothing shader-shaped reached the console',
  shaderMsgs.length
    ? shaderMsgs.slice(0, 3).map((m) => `[${m.type}] ${m.text.slice(0, 160)}`).join(' | ')
    : `${messages.length} console messages, none matching`);
check(errorMsgs.length === 0,
  'no console errors at all',
  errorMsgs.length
    ? errorMsgs.slice(0, 3).map((m) => `[${m.type}] ${m.text.slice(0, 160)}`).join(' | ')
    : 'clean');

await browser.close();

console.log('');
if (failures.length) {
  console.error(`${failures.length} FAILED:`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('ALL MATERIAL PROGRAMS LINK');
