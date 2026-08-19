/**
 * How much detail does each procedural tier actually deliver, at what distance?
 *
 * glsl.mjs next door renders the tier so it can be LOOKED at. This one measures
 * it: same shader, same metre frame, but it reads the pixels back and reports the
 * standard deviation of albedo, of the normal's xy, and of roughness, at a sweep
 * of viewing distances — and again with each tier ablated, so the contribution of
 * rings / fibre / plank layout / weave can be attributed rather than guessed.
 *
 * A std of 0.02 in albedo is a flat surface with a rounding error on it; that is
 * the number section 17D of DIAGNOSIS.md is complaining about. Anything under
 * ~0.01 in normal xy means the surface has no relief the eye can find.
 *
 *   node .tmp/bakeprobe/tiers.mjs
 *   node .tmp/bakeprobe/tiers.mjs --family deck --dists 0.5,1,2,4
 */
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  if (process.argv[i].startsWith('--')) args[process.argv[i].slice(2)] = process.argv[i + 1];
}
const DISTS = (args.dists ?? '0.5,1,2,4,8').split(',').map(Number);
const SIZE = 256;

async function glslFrom(file, exportName) {
  const src = await readFile(join(root, file), 'utf8');
  const i = src.indexOf(exportName);
  if (i < 0) throw new Error(`${exportName} not in ${file}`);
  const a = src.indexOf('`', i);
  const b = src.indexOf('`', a + 1);
  return src.slice(a + 1, b);
}
const glslTs = await readFile(join(root, 'src/util/glsl.ts'), 'utf8');
function section(name) {
  const i = glslTs.indexOf(`const ${name} = /* glsl */ \``);
  const a = glslTs.indexOf('`', i);
  const b = glslTs.indexOf('`;', a + 1);
  return glslTs.slice(a + 1, b);
}
const common = section('common');
const noise2d = section('noise2d');
const surface = section('surface');
const detail = await glslFrom('src/ship/shaders/detail.ts', 'DETAIL_DECL');
const cloth = await glslFrom('src/ship/build/sails.ts', 'CLOTH_DETAIL');

/** Straight from src/ship/Ship.ts. */
const FAMILY = {
  deck: {
    A: [0.0095, 0.135, 0.00055, 0.2], B: [0.32, 0.0032, 0.82, 0.00016],
    C: [0.0015, 0.075, 0.12, 0.16], D: [0.11, 0.11], E: [0.042, 0.17, 0.0016, 0.2], rough: 0.6,
  },
  oak: {
    A: [0.0105, 0.115, 0.0005, 0.19], B: [0, 0.003, 0, 0.00015],
    C: [0.0014, 0.07, 0, 0], D: [0.1, 0], E: [0.038, 0.19, 0.0017, 0.21], rough: 0.65,
  },
  black: {
    A: [0.011, 0.055, 0.00022, 0.11], B: [0.32, 0.0035, 0.45, 0.00009],
    C: [0.0019, 0.05, 0.035, 0], D: [0.06, 0.035], E: [0.05, 0.035, 0.0006, 0.06], rough: 0.6,
  },
};
const famName = args.family ?? 'deck';
const fam = FAMILY[famName];

/** Ablations: which tiers are left alive. */
const ABLATE = {
  all: (f) => f,
  'figure-only': (f) => ({ ...f, A: [f.A[0], 0, 0, 0], B: [0, f.B[1], 0, 0], C: [f.C[0], 0, 0, 0], D: [0, 0] }),
  'ring-only': (f) => ({ ...f, E: [0, 0, 0, 0], B: [0, f.B[1], 0, 0], C: [f.C[0], 0, 0, 0], D: [0, 0] }),
  'fibre-only': (f) => ({ ...f, E: [0, 0, 0, 0], A: [f.A[0], 0, 0, 0], B: [0, f.B[1], 0, f.B[3]], C: [f.C[0], f.C[1], 0, 0], D: [f.D[0], 0] }),
  'plank-only': (f) => ({ ...f, E: [0, 0, 0, 0], A: [f.A[0], 0, 0, 0], B: [f.B[0], f.B[1], f.B[2], 0], C: [f.C[0], 0, f.C[2], 0], D: [0, f.D[1]] }),
  'wear-only': (f) => ({ ...f, E: [0, 0, 0, 0], A: [f.A[0], 0, 0, 0], B: [0, f.B[1], 0, 0], C: [f.C[0], 0, 0, f.C[3]], D: [0, 0] }),
};

const FRAG = `#extension GL_OES_standard_derivatives : enable
precision highp float;
varying vec2 vXy;
uniform vec4 uDetailA;
uniform vec4 uDetailB;
uniform vec4 uDetailC;
uniform vec2 uDetailD;
uniform vec4 uDetailE;
uniform float uRough;
uniform int uMode;
${common}
${noise2d}
${surface}
${detail}
${cloth}
void main(){
  vec4 o;
  if (uMode == 3) {
    // The cloth, composed exactly as makeSailMaterial composes it.
    vec2 aa = vec2(fwidth(vXy.x), fwidth(vXy.y));
    vec2 gw, gs;
    float w = lwWeave(vXy, aa, gw);
    float sl = lwClothSlub(vXy, aa, gs);
    vec2 sg = gw * 0.00011 + gs * 0.0018;
    o = vec4(0.5 + 0.5 * (0.055 * w + 0.085 * sl),
             0.5 + 0.5 * clamp(sg.x, -1.0, 1.0),
             0.5 + 0.5 * clamp(sg.y, -1.0, 1.0),
             clamp(0.94 + 0.075 * sl, 0.0, 1.0));
  } else {
    float alb, rgh, ao;
    vec2 g;
    lwWoodDetail(vXy, uDetailA, uDetailB, uDetailC, uDetailD, uDetailE, alb, rgh, ao, g);
    // R: albedo*ao about 1.0, G/B: the two slope components, all remapped to 0..1
    // so an 8-bit readback keeps 1/255 = 0.008 of resolution on each.
    o = vec4(clamp(alb * ao, 0.0, 2.0) * 0.5,
             0.5 + 0.5 * clamp(g.x, -1.0, 1.0),
             0.5 + 0.5 * clamp(g.y, -1.0, 1.0),
             clamp(uRough + rgh, 0.0, 1.0));
  }
  gl_FragColor = o;
}`;

const jobs = [];
for (const d of DISTS) {
  const pxPerM = 1600 / (2 * d * Math.tan((50 * Math.PI / 180) / 2));
  const metres = SIZE / pxPerM;
  for (const [ab, fn] of Object.entries(ABLATE)) {
    jobs.push({ tag: `${famName} ${ab}`, dist: d, metres, mode: 0, mmPerPx: 1000 / pxPerM, ...fn(fam) });
  }
  jobs.push({ tag: 'sail cloth', dist: d, metres, mode: 3, mmPerPx: 1000 / pxPerM, ...fam });
}

const page = await (await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
})).newPage();

const out = await page.evaluate(({ frag, size, jobs }) => {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const gl = c.getContext('webgl', { antialias: false, preserveDrawingBuffer: true });
  if (!gl) return { err: 'no webgl' };
  if (!gl.getExtension('OES_standard_derivatives')) return { err: 'no derivatives' };
  const vs = `attribute vec2 aP; varying vec2 vXy; uniform float uM;
void main(){ vXy = (aP * 0.5 + 0.5) * uM; gl_Position = vec4(aP, 0.0, 1.0); }`;
  const mk = (t, s) => {
    const sh = gl.createShader(t);
    gl.shaderSource(sh, s); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
    return sh;
  };
  let p;
  try {
    p = gl.createProgram();
    gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, mk(gl.FRAGMENT_SHADER, frag));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  } catch (e) { return { err: String(e.message || e) }; }
  gl.useProgram(p);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(p, 'aP');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const U = (n) => gl.getUniformLocation(p, n);
  const px = new Uint8Array(size * size * 4);
  const res = [];
  for (const j of jobs) {
    gl.uniform1f(U('uM'), j.metres);
    gl.uniform4fv(U('uDetailA'), j.A);
    gl.uniform4fv(U('uDetailB'), j.B);
    gl.uniform4fv(U('uDetailC'), j.C);
    gl.uniform2fv(U('uDetailD'), j.D);
    gl.uniform4fv(U('uDetailE'), j.E);
    gl.uniform1f(U('uRough'), j.rough);
    gl.uniform1i(U('uMode'), j.mode);
    gl.viewport(0, 0, size, size);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const n = size * size;
    const s = [0, 0, 0, 0], s2 = [0, 0, 0, 0];
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 4; k++) { const v = px[i * 4 + k] / 255; s[k] += v; s2[k] += v * v; }
    }
    const std = s.map((sum, k) => Math.sqrt(Math.max(s2[k] / n - (sum / n) ** 2, 0)));
    res.push({
      tag: j.tag, dist: j.dist, mmPerPx: j.mmPerPx,
      // undo the 0.5 / 0.5-centred packing so the numbers are in surface units
      albStd: std[0] * 2, nxStd: std[1] * 2, nyStd: std[2] * 2, rghStd: std[3],
    });
  }
  return { res };
}, { frag: FRAG, size: SIZE, jobs });

if (out.err) { console.error('SHADER ERROR:\n' + out.err); process.exit(1); }

let lastD = null;
console.log('tier                     dist  mm/px  albedo-std  slope-x-std  slope-y-std  rough-std');
for (const r of out.res) {
  if (r.dist !== lastD) { console.log(''); lastD = r.dist; }
  console.log(
    `${r.tag.padEnd(24)} ${String(r.dist).padStart(4)}  ${r.mmPerPx.toFixed(2).padStart(5)}` +
    `  ${r.albStd.toFixed(4).padStart(10)}  ${r.nxStd.toFixed(4).padStart(11)}` +
    `  ${r.nyStd.toFixed(4).padStart(11)}  ${r.rghStd.toFixed(4).padStart(9)}`,
  );
}
process.exit(0);
