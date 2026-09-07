#!/usr/bin/env node
/**
 * Mesh topology acceptance tests.
 *
 *   node scripts/geometry-test.mjs
 *
 * Needs the dev server on :5178, like `physics-test.mjs` and `assist-test.mjs`.
 *
 * WHY THIS EXISTS
 * DIAGNOSIS 109/110 fixed a real, player-visible defect: Boston was a hollow
 * shell. You could see inside the land. It was closed by walling the boundary
 * ring down to LAND_FLOOR and fanning a hub across the bottom, and NOTHING has
 * guarded that since -- a later edit to `buildLand` could reopen it and the
 * only detector would be a player noticing. Section 127 measured the current
 * state; this turns that measurement into a gate.
 *
 * WHAT IT ASSERTS, AND WHY IT IS NOT A MAGIC NUMBER
 * In a closed 2-manifold every edge is shared by exactly two triangles. An edge
 * used once is a boundary -- a hole. The assertion is NOT "there are exactly 84
 * boundary edges", which would break on any legitimate island tweak. It is
 * about WHERE a hole is allowed to be:
 *
 *   - none at or near the waterline   -> that is the 110 hollow-shell signature,
 *                                        the one a player can see
 *   - none down at LAND_FLOOR         -> the land volume's bottom is closed
 *   - the only open rims are the harbour island bases at ISLAND_BASE_Y, which
 *     are cones with no cap (127). Eighteen metres down, and deliberate.
 *
 * `MeshBuilder.vert` duplicates vertices at every seam, so edges are keyed on
 * QUANTISED POSITION rather than index. Otherwise every welded seam reads as a
 * hole and the whole statistic is noise.
 *
 * THE CONTROLS ARE PART OF THE TEST
 * A topology check that cannot tell a closed mesh from an open one is worse
 * than no check, because it is green. So this builds two shapes of KNOWN
 * topology first -- a `box()` (closed, 0 boundary edges) and a two-rim
 * `tube()` (open, exactly 2 x segments) -- and refuses to report on Boston at
 * all unless both come out right. It also sweeps the weld tolerance across
 * three orders of magnitude: a numerical seam collapses as the tolerance
 * coarsens, a real hole does not.
 */

import { chromium } from 'playwright';
import process from 'node:process';

const URL = 'http://127.0.0.1:5178/?showcase=boston';

/** `ISLAND_BASE_Y` in src/world/Boston.ts. The harbour islands' open bottom. */
const ISLAND_BASE_Y = -18;
/** `LAND_FLOOR` in src/world/Boston.ts. The bottom the land volume is walled to. */
const LAND_FLOOR = -52;
/**
 * How far a boundary edge may sit from ISLAND_BASE_Y. Measured spread of the
 * real rims is 1.15 m (-18.59 .. -17.44, section 127); 4 m is ~3.5x that, and
 * still nowhere near either the waterline or the floor.
 */
const RIM_BAND = 4;

const failures = [];

/**
 * The two location predicates. Boston is judged by exactly these, and so are the
 * synthetic controls below -- if they were re-spelled for the controls, the
 * controls would be testing a copy and would prove nothing about the real check.
 */
const waterlineOk = (r) => r.boundary === 0 || r.yHi <= ISLAND_BASE_Y + RIM_BAND;
const floorOk = (r) => r.boundary === 0 || r.yLo >= ISLAND_BASE_Y - RIM_BAND;

function check(ok, label, detail) {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures.push(label);
}
function note(label, detail) {
  console.log(`         ${label}: ${detail}`);
}

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist',
         '--enable-unsafe-swiftshader', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 800, height: 500 } });

// Vite's HMR client reloads the page whenever any agent saves a file, which
// destroys the execution context mid-run. Kill the socket before the app loads.
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
await page.waitForFunction(() => !!window.__leeward?.world?.scene, null, { timeout: 180000 });
// Boston is built lazily by the showcase, not at boot. Wait for the mesh itself
// rather than for a fixed number of seconds.
await page.waitForFunction(() => {
  let seen = false;
  window.__leeward.world.scene.traverse((o) => {
    if (o.name === 'world-boston' && o.geometry?.attributes?.position?.count > 0) seen = true;
  });
  return seen;
}, null, { timeout: 120000 });

/**
 * Edge-incidence census, keyed on position quantised to `q` units per metre.
 * Returns boundary (used once) and non-manifold (used 3+) counts, plus the
 * y-extent of every boundary vertex, which is what localises a hole.
 */
const ANALYSE = `(g, q) => {
  const P = g.attributes.position.array;
  const idx = g.index ? g.index.array : null;
  const tris = idx ? idx.length / 3 : g.attributes.position.count / 3;
  const key = (i) => Math.round(P[i * 3] * q) + ',' + Math.round(P[i * 3 + 1] * q)
    + ',' + Math.round(P[i * 3 + 2] * q);
  const edges = new Map();
  let degenerate = 0;
  for (let t = 0; t < tris; t++) {
    const a = idx ? idx[t * 3] : t * 3;
    const b = idx ? idx[t * 3 + 1] : t * 3 + 1;
    const c = idx ? idx[t * 3 + 2] : t * 3 + 2;
    const ka = key(a), kb = key(b), kc = key(c);
    if (ka === kb || kb === kc || ka === kc) { degenerate++; continue; }
    for (const pair of [[ka, kb], [kb, kc], [kc, ka]]) {
      const e = pair[0] < pair[1] ? pair[0] + '|' + pair[1] : pair[1] + '|' + pair[0];
      edges.set(e, (edges.get(e) ?? 0) + 1);
    }
  }
  let boundary = 0, nonManifold = 0, shared = 0;
  let yLo = Infinity, yHi = -Infinity;
  for (const entry of edges.entries()) {
    if (entry[1] === 1) {
      boundary++;
      for (const half of entry[0].split('|')) {
        const y = Number(half.split(',')[1]) / q;
        if (y < yLo) yLo = y;
        if (y > yHi) yHi = y;
      }
    } else if (entry[1] === 2) shared++;
    else nonManifold++;
  }
  return { tris, degenerate, edges: edges.size, boundary, nonManifold, shared, yLo, yHi };
}`;

/* ------------------------------------------------------------------ *
 *  1. controls — calibrate the instrument before trusting it
 * ------------------------------------------------------------------ */

console.log('\nCONTROLS — a topology check that cannot see a hole is worse than none');
const ctl = await page.evaluate(async (analyseSrc) => {
  const analyse = eval('(' + analyseSrc + ')');
  const { MeshBuilder } = await import('/src/world/wgeom.ts');
  const C = [0.5, 0.5, 0.5];
  const A = [0, 0, 0, 0];
  const SEG = 8;

  const bb = new MeshBuilder();
  bb.box(0, 0, 0, 1, 1, 1, C, A);
  const closed = analyse(bb.finish('ctl-box'), 100);

  const bt = new MeshBuilder();
  const rings = [];
  for (const z of [-1, 0, 1]) {
    const r = [];
    for (let j = 0; j < SEG; j++) {
      const th = (j / SEG) * Math.PI * 2;
      r.push(bt.vert(Math.cos(th), Math.sin(th), z, C, A));
    }
    rings.push(r);
  }
  bt.tube(rings, true);
  const open = analyse(bt.finish('ctl-tube'), 100);

  // A rim ABOVE the allowed band, and one BELOW it. These exist so the two
  // location predicates are proven able to fail on every run, not just on the
  // day someone hand-breaks the source. A manual break of `buildLand` fired the
  // floor predicate but never lifted the waterline one, because Boston's whole
  // outer ring turns out to be submerged -- so that predicate had no
  // demonstration at all until these.
  const rimAt = (y0, y1) => {
    const b = new MeshBuilder();
    const rr = [];
    for (const z of [y0, y1]) {
      const r = [];
      for (let j = 0; j < SEG; j++) {
        const th = (j / SEG) * Math.PI * 2;
        r.push(b.vert(Math.cos(th) * 20, z, Math.sin(th) * 20, C, A));
      }
      rr.push(r);
    }
    b.tube(rr, true);
    return analyse(b.finish('ctl-rim'), 100);
  };

  return { closed, open, seg: SEG, high: rimAt(0, 5), deep: rimAt(-60, -55) };
}, ANALYSE);

check(ctl.closed.boundary === 0 && ctl.closed.nonManifold === 0,
  'a closed box reads as closed',
  `${ctl.closed.boundary} boundary, ${ctl.closed.nonManifold} non-manifold over ${ctl.closed.edges} edges`);
check(ctl.open.boundary === 2 * ctl.seg,
  'an open two-rim tube reads as open, with exactly its rim count',
  `${ctl.open.boundary} boundary edges, expected ${2 * ctl.seg}`);
check(!waterlineOk(ctl.high),
  'a hole at the waterline is REJECTED by the same predicate Boston is judged by',
  `rim at y ${ctl.high.yLo.toFixed(0)}..${ctl.high.yHi.toFixed(0)} m, limit ${(ISLAND_BASE_Y + RIM_BAND).toFixed(0)} m`);
check(!floorOk(ctl.deep),
  'a hole at the land floor is REJECTED by the same predicate',
  `rim at y ${ctl.deep.yLo.toFixed(0)}..${ctl.deep.yHi.toFixed(0)} m, limit ${(ISLAND_BASE_Y - RIM_BAND).toFixed(0)} m`);

if (failures.length) {
  console.error('\nThe instrument is not measuring topology. Nothing below would mean anything.');
  await browser.close();
  process.exit(1);
}

/* ------------------------------------------------------------------ *
 *  2. Boston — are the holes only where they are allowed to be?
 * ------------------------------------------------------------------ */

console.log('\nBOSTON — the land volume must stay closed (DIAGNOSIS 109/110)');
const tol = await page.evaluate(async (analyseSrc) => {
  const analyse = eval('(' + analyseSrc + ')');
  let geo = null;
  window.__leeward.world.scene.traverse((o) => {
    if (o.name === 'world-boston') geo = o.geometry;
  });
  if (!geo) return null;
  const out = {};
  for (const q of [1000, 100, 10, 1]) out[q] = analyse(geo, q);
  return out;
}, ANALYSE);

if (!tol) {
  check(false, 'the Boston mesh is in the scene', 'no object named world-boston');
} else {
  const at = tol[100];
  note('mesh', `${at.tris} triangles, ${at.edges} unique edges, ${at.degenerate} degenerate`);
  note('boundary edges by weld tolerance',
    [1000, 100, 10, 1].map((q) => `${1000 / q >= 1000 ? '1 m' : `${1000 / q} mm`}:${tol[q].boundary}`).join('  '));
  note('boundary-edge y extent', `${at.yLo.toFixed(2)} .. ${at.yHi.toFixed(2)} m`);

  check(at.tris > 10000, 'Boston actually built', `${at.tris} triangles`);

  // A numerical seam collapses as the weld tolerance coarsens; a hole does not.
  // If these disagree, the boundary count is measuring float noise and the
  // location assertions below are meaningless.
  const counts = [1000, 100, 10, 1].map((q) => tol[q].boundary);
  check(counts.every((c) => c === counts[0]),
    'the boundary count is holes, not weld noise — identical from 1 mm to 1 m',
    counts.join(' / '));

  if (at.boundary === 0) {
    check(true, 'no holes at all', 'fully closed');
  } else {
    // THE regression detector. A hole at or near the waterline is what section
    // 110 fixed; a hole at LAND_FLOOR means the bottom stopped being closed.
    check(waterlineOk(at),
      'no hole at or near the waterline',
      `highest boundary vertex ${at.yHi.toFixed(2)} m, limit ${(ISLAND_BASE_Y + RIM_BAND).toFixed(0)} m`);
    check(floorOk(at),
      'no hole down at the land floor',
      `lowest boundary vertex ${at.yLo.toFixed(2)} m, limit ${(ISLAND_BASE_Y - RIM_BAND).toFixed(0)} m ` +
      `(LAND_FLOOR is ${LAND_FLOOR})`);
  }

  // T-junctions where the wharf and quays meet the land. Bounded, not zero.
  check(at.nonManifold < at.edges * 0.005,
    'non-manifold edges stay a rounding error',
    `${at.nonManifold} of ${at.edges} (${((100 * at.nonManifold) / at.edges).toFixed(3)} %)`);
}

await browser.close();

console.log('');
if (failures.length) {
  console.error(`${failures.length} FAILED:`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('ALL GEOMETRY TESTS PASSED');
