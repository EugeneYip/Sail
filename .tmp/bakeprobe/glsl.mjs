/**
 * Renders the SHADER detail tier at a chosen viewing distance.
 *
 * The bake probe next door can only see the baked maps. Most of the ship's
 * close-range detail is now synthesised per pixel from metre coordinates, so
 * judging it needs a GPU — but not the scene. This puts one quad through the
 * real `lwWoodDetail` / `lwWeave` source, with dFdx/dFdy set up so one screen
 * pixel spans exactly the same distance in metres it would at `--dist` metres in
 * a 1600 px / 50 degree frame, and shades it with a single fixed light.
 *
 *   node .tmp/bakeprobe/glsl.mjs --dist 2 --family deck
 *
 * Cheap enough to run at load 180, which the scene harness is not.
 */
import { chromium } from 'playwright';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  if (process.argv[i].startsWith('--')) args[process.argv[i].slice(2)] = process.argv[i + 1];
}
const DIST = Number(args.dist ?? 2);
const SIZE = Number(args.size ?? 560);

/** Pull a tagged template's text out of a TS module without importing it. */
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
// The sail's cloth block interpolates constants; substitute the ones lwWeave needs.
let cloth = await glslFrom('src/ship/build/sails.ts', 'CLOTH_DETAIL');

/** Families, matching Ship.ts. (ringPitch, ringAlb, ringRelief, ringRough) etc. */
const FAMILY = {
  deck: {
    A: [0.0095, 0.135, 0.00055, 0.2], B: [0.32, 0.0032, 0.82, 0.00016],
    C: [0.0015, 0.075, 0.055, 0.16], D: [0.11, 0.06],
    base: [0.52, 0.46, 0.36], rough: 0.6, tile: [3.2, 1.28],
  },
  oak: {
    A: [0.0105, 0.115, 0.0005, 0.19], B: [0, 0.003, 0, 0.00015],
    C: [0.0014, 0.07, 0, 0], D: [0.1, 0],
    base: [0.44, 0.36, 0.27], rough: 0.65, tile: [3.2, 1.28],
  },
  black: {
    A: [0.011, 0.055, 0.00022, 0.11], B: [0.32, 0.0035, 0.45, 0.00009],
    C: [0.0019, 0.05, 0.035, 0], D: [0.06, 0.035],
    base: [0.14, 0.14, 0.145], rough: 0.6, tile: [3.2, 1.28],
  },
  copper: {
    A: [0.009, 0, 0, 0], B: [0, 0.003, 0, 0.00012],
    C: [0.0022, 0.05, 0, 0], D: [0.1, 0],
    base: [0.3, 0.27, 0.19], rough: 0.65, tile: [3.2, 1.28],
  },
};

const fam = FAMILY[args.family ?? 'deck'];
if (!fam) throw new Error(`unknown family ${args.family}`);

const pxPerM = 1600 / (2 * DIST * Math.tan((50 * Math.PI / 180) / 2));
const metresAcross = SIZE / pxPerM;

const FRAG = `#extension GL_OES_standard_derivatives : enable
precision highp float;
varying vec2 vXy;
uniform vec2 uTileM;
uniform vec4 uDetailA;
uniform vec4 uDetailB;
uniform vec4 uDetailC;
uniform vec2 uDetailD;
uniform vec3 uBase;
uniform float uRough;
uniform int uMode;
${common}
${noise2d}
${surface}
${detail}
${cloth}
void main(){
  vec2 vMapUv = vXy / uTileM;
  vec3 col;
  if (uMode == 3) {
    vec2 g;
    float w = lwWeave(vXy, vec2(fwidth(vXy.x), fwidth(vXy.y)), g);
    vec3 n = normalize(vec3(-g.y * 0.00011, -g.x * 0.00011, 1.0));
    vec3 L = normalize(vec3(0.42, 0.30, 0.86));
    float d = max(dot(n, L), 0.0);
    col = vec3(0.70, 0.675, 0.61) * (1.0 + 0.055 * w) * (0.22 + 0.78 * d);
  } else {
    float alb, rgh, ao;
    vec2 g;
    lwWoodDetail(vXy, uDetailA, uDetailB, uDetailC, uDetailD, alb, rgh, ao, g);
    if (uMode == 0) {
      // Albedo only, times AO, so the caulk and tone read on their own.
      col = uBase * alb * ao;
    } else if (uMode == 1) {
      col = normalize(vec3(-g.x, -g.y, 1.0)) * 0.5 + 0.5;
    } else if (uMode == 2) {
      col = vec3(clamp(uRough + rgh, 0.04, 1.0));
    } else {
      // Fully shaded: one fixed light, Lambert plus a GGX lobe, so albedo,
      // normal and roughness are all judged together.
      vec3 n = normalize(vec3(-g.x, -g.y, 1.0));
      vec3 L = normalize(vec3(0.42, 0.30, 0.86));
      vec3 V = vec3(0.0, 0.0, 1.0);
      vec3 H = normalize(L + V);
      float r = clamp(uRough + rgh, 0.04, 1.0);
      float a = r * r;
      float NoH = max(dot(n, H), 0.0);
      float dd = a * a / max(3.14159 * pow(NoH * NoH * (a * a - 1.0) + 1.0, 2.0), 1e-4);
      col = uBase * alb * ao * (0.22 + 0.78 * max(dot(n, L), 0.0)) + vec3(0.04) * dd * 0.35;
    }
  }
  gl_FragColor = vec4(pow(clamp(col, 0.0, 1.0), vec3(1.0 / 2.2)), 1.0);
}`;

const page = await (await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
})).newPage();

const out = await page.evaluate(
  ({ frag, size, metres, fam: f }) => {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    // WebGL1: ANGLE-on-Metal exposes OES_standard_derivatives here, but not in
    // an ES 1.00 shader inside a WebGL2 context.
    const gl = c.getContext('webgl', { antialias: false, preserveDrawingBuffer: true });
    if (!gl) return { err: 'no webgl' };
    if (!gl.getExtension('OES_standard_derivatives')) return { err: 'no derivatives' };
    const vs = `attribute vec2 aP; varying vec2 vXy; uniform float uM;
void main(){ vXy = (aP * 0.5 + 0.5) * uM; gl_Position = vec4(aP, 0.0, 1.0); }`;
    const mk = (t, s) => {
      const sh = gl.createShader(t);
      gl.shaderSource(sh, s);
      gl.compileShader(sh);
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
    } catch (e) {
      return { err: String(e.message || e) };
    }
    gl.useProgram(p);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(p, 'aP');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const U = (n) => gl.getUniformLocation(p, n);
    gl.uniform1f(U('uM'), metres);
    gl.uniform2fv(U('uTileM'), f.tile);
    gl.uniform4fv(U('uDetailA'), f.A);
    gl.uniform4fv(U('uDetailB'), f.B);
    gl.uniform4fv(U('uDetailC'), f.C);
    gl.uniform2fv(U('uDetailD'), f.D);
    gl.uniform3fv(U('uBase'), f.base);
    gl.uniform1f(U('uRough'), f.rough);
    const shots = {};
    for (const [name, mode] of [['albedo', 0], ['normal', 1], ['rough', 2], ['shaded', 4], ['weave', 3]]) {
      gl.uniform1i(U('uMode'), mode);
      gl.viewport(0, 0, size, size);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      shots[name] = c.toDataURL('image/png');
    }
    return { shots };
  },
  { frag: FRAG, size: SIZE, metres: metresAcross, fam },
);

if (out.err) {
  console.error('SHADER ERROR:\n' + out.err);
  process.exit(1);
}
await mkdir(join(here, 'out'), { recursive: true });
const tag = args.family ?? 'deck';
for (const [name, url] of Object.entries(out.shots)) {
  const f = join(here, 'out', `sh-${tag}-${name}-${DIST}m.png`);
  await writeFile(f, Buffer.from(url.split(',')[1], 'base64'));
  console.log(f);
}
console.log(`${SIZE}px shows ${metresAcross.toFixed(3)} m  (${pxPerM.toFixed(0)} px/m at ${DIST} m)`);
process.exit(0);
