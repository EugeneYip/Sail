#!/usr/bin/env node
/**
 * Compile and LINK every fullscreen-pass program against the real
 * ANGLE-on-Metal driver. No dev server, no engine boot, no Vite root touched.
 *
 * WHY THIS EXISTS
 * `npm run typecheck` proves the TypeScript is valid. `check-glsl` proves no
 * backtick escaped a shader comment. NEITHER can see GLSL semantics: a
 * misspelled swizzle, a float literal where an int belongs, a redeclared name,
 * a varying the fragment stage reads and the vertex stage never writes. Those
 * are invisible to both and surface only as a black frame or a silently missing
 * effect -- which is exactly how the sail-shadow bug survived (a structural fix
 * was written and never called, so `vAback` was undeclared in the depth
 * material and sail shadows quietly stopped compiling). See DIAGNOSIS sections
 * 27 and 34.
 *
 * WHAT IT PROVES, EXACTLY
 * Every `*_FRAG` exported from `src/sky/shaders` and `src/post/shaders` is
 * compiled against the vertex shader the engine really pairs it with
 * (`PASS_VERT` for sky, `FULLSCREEN_VERT` for post -- see `sky/Pass.ts:35` and
 * `post/FullscreenPass.ts:56`) and the pair is LINKED. Link is the point:
 * compiling the stages apart cannot see a varying mismatch, and that is the
 * class of bug that cost us most.
 *
 * WHAT IT DOES NOT PROVE
 * The prefix is three's own, copied from `WebGLProgram.js:800-828` -- the same
 * `#version 300 es` and the same GLSL1-compatibility defines the engine hands a
 * `ShaderMaterial` on WebGL2. It is not byte-identical (three also injects
 * lighting, fog and encoding chunks that a fullscreen pass does not use), but
 * every source here declares its own uniforms and varyings, so the difference
 * cannot mask an error in ours.
 *
 * And it does not cover the MATERIAL shaders at all -- `ocean/shaders/surface`,
 * `ship/shaders/{parts,sail,line}`, `vfx`, `world`. Those are injected into
 * three's own chunks via `onBeforeCompile`, so only a real engine boot
 * assembles them. Do not read a green run here as covering them: run
 * `npm run check-materials`, which boots the engine with `?showcase=all` and
 * links all 66 of them on the real driver. Proven complementary rather than
 * assumed -- an undeclared identifier in `world/shaders/terrain.ts` leaves
 * check-glsl, `tsc` AND this script all green at exit 0, and fails
 * check-materials (DIAGNOSIS 131).
 *
 * The program list is DISCOVERED, not hand-written, so a new pass is covered
 * the moment it is exported. Only the define permutations below are manual.
 *
 * POSITIVE CONTROLS -- this checker's green is only worth what these prove.
 * Rerun them by hand after any change to the prefix or the version table:
 *
 *   A. Add `vec3 f(vec3 c){ return c.rgba.rgb; }` to any `*_FRAG`.
 *      -> `tsc` 0 errors, `check-glsl` clean, this checker FAILS that program.
 *      That is the semantic class both other checkers are blind to.
 *   B. Add a `varying`/`in` to a frag that no vert writes, AND READ IT.
 *      -> `tsc` 0 errors, this checker FAILS on link. That is the `vAback`
 *      class.
 *
 * Control B is only valid if the varying is actually read. An unused mismatched
 * `in` is LEGAL GLSL -- the spec only requires a match for statically-used
 * varyings -- so declaring one and stopping there tests nothing and passes. It
 * passed here first time for exactly that reason, and that pass was not a gap in
 * the checker; it was a bad control.
 */
import { chromium } from 'playwright';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const ROOT = resolve(import.meta.dirname, '..');

/**
 * Which vertex shader the engine really pairs each directory's passes with, and
 * WHICH GLSL VERSION it compiles them as.
 *
 * `glsl` must match the material's real `glslVersion`: sky passes are
 * `THREE.GLSL3` (`sky/Pass.ts:34`), post passes set none and so are written
 * GLSL1-style. It selects only two `#define`s, because three compiles both as
 * `#version 300 es` anyway (see the prefix below).
 *
 * Get the version wrong and this checker produces a screenful of confident
 * nonsense about perfectly good shaders. Its own first run compiled post as
 * literal ES 1.00 and reported `'varying' : Illegal use of reserved word` 27
 * times; its second rejected a working `sampler3D`; a sibling probe compiling
 * GLSL3 sources as 1.00 invented eight `textureLod` errors. Every time, the
 * instrument was broken and the shader was fine. **If a whole directory fails
 * identically, suspect this table before you touch a shader.**
 */
const PAIRING = [
  { dir: 'src/sky/shaders', vert: 'PASS_VERT', vertFrom: 'src/sky/shaders/lutPasses.ts', glsl: 3 },
  { dir: 'src/post/shaders', vert: 'FULLSCREEN_VERT', vertFrom: 'src/post/FullscreenPass.ts', glsl: 1 },
];

/**
 * Extra define sets to compile a pass under, beyond the bare one. Keyed by
 * export name. These are the permutations the engine actually instantiates --
 * a `#if` branch that is never compiled is a branch that can rot.
 */
const PERMUTATIONS = {
  SKY_FRAG: [
    { SKY_CLOUDS: '1' },
    { SKY_EQUIRECT: '1', SKY_ENV: '1' },
    { SKY_EQUIRECT: '1', SKY_ENV: '1', SKY_ENV_CLOUDS: '1' },
  ],
  DOF_GATHER_FRAG: [{ DOF_NEAR: '1' }],
  BLOOM_DOWN_FRAG: [{ BLOOM_KARIS: '1' }],
};

// ---- discover every exported pass ------------------------------------------
const found = [];
for (const p of PAIRING) {
  for (const file of (await readdir(join(ROOT, p.dir))).filter((f) => f.endsWith('.ts'))) {
    const src = await readFile(join(ROOT, p.dir, file), 'utf8');
    for (const m of src.matchAll(/^export const ([A-Z][A-Z0-9_]*_FRAG)\b/gm)) {
      found.push({ name: m[1], from: `${p.dir}/${file}`, ...p });
    }
  }
}
if (found.length === 0) {
  console.error('check-shaders: discovered no passes -- the discovery regex has rotted.');
  process.exit(1);
}

// ---- bundle the shader sources with the esbuild already inside vite --------
const require = createRequire(import.meta.url);
const esbuild = require(require.resolve('esbuild', { paths: [require.resolve('vite')] }));
const tmp = await mkdtemp(join(tmpdir(), 'lw-shaders-'));
try {
  const imports = new Map();
  for (const f of found) {
    if (!imports.has(f.from)) imports.set(f.from, new Set());
    imports.get(f.from).add(f.name);
  }
  for (const p of PAIRING) {
    if (!imports.has(p.vertFrom)) imports.set(p.vertFrom, new Set());
    imports.get(p.vertFrom).add(p.vert);
  }
  const entry = join(tmp, 'entry.ts');
  await writeFile(entry, [
    ...[...imports].map(([from, names]) =>
      `import { ${[...names].join(', ')} } from '${join(ROOT, from).replace(/\.ts$/, '')}';`),
    'export const SRC: Record<string, string> = {',
    ...[...imports].flatMap(([, names]) => [...names].map((n) => `  ${n},`)),
    '};',
  ].join('\n'));

  const out = join(tmp, 'bundle.js');
  await esbuild.build({
    entryPoints: [entry], outfile: out, bundle: true, format: 'iife',
    globalName: 'LW', platform: 'browser', logLevel: 'silent', target: 'es2022',
  });
  const bundle = await readFile(out, 'utf8');

  const programs = found.flatMap((f) => [
    { name: f.name, frag: f.name, vert: f.vert, glsl: f.glsl, defines: {}, from: f.from },
    ...(PERMUTATIONS[f.name] ?? []).map((defines) => ({
      name: `${f.name} [${Object.keys(defines).join(',')}]`,
      frag: f.name, vert: f.vert, glsl: f.glsl, defines, from: f.from,
    })),
  ]);

  // ---- compile + link against the real driver -----------------------------
  // A missing browser is an environment fact, not a shader defect. Skip loudly:
  // a checker that fails where chromium is not installed gets deleted from CI,
  // and then it checks nothing anywhere.
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist',
        '--enable-unsafe-swiftshader', '--enable-webgl', '--hide-scrollbars', '--mute-audio'],
    });
  } catch (e) {
    console.log(`check-shaders: cannot launch chromium -- SKIPPED (not a pass). ${e.message.split('\n')[0]}`);
    console.log('  Install it with: npx playwright install chromium');
    process.exit(0);
  }
  let results;
  try {
    const page = await browser.newPage();
    await page.setContent('<canvas id=c width=8 height=8></canvas>');
    await page.addScriptTag({ content: bundle });
    results = await page.evaluate((programs) => {
      const gl = document.getElementById('c').getContext('webgl2');
      if (!gl) return { renderer: null, out: [] };
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      const renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown';
      // What three prepends to a GLSL3 ShaderMaterial, near enough. Our sources
      // declare their own uniforms, so a difference here cannot hide our bugs.
      // Copied from three's WebGLProgram.js:800-828. three compiles EVERY
      // non-raw ShaderMaterial as `#version 300 es` on WebGL2 and hands GLSL1
      // sources these compatibility defines -- which is why our post chain can
      // write `varying`/`texture2D` and still declare a `sampler3D`. Emulating
      // GLSL1 as literal ES 1.00 instead is what made this checker's first run
      // reject a working `sampler3D`.
      const COMPAT_VERT = ['#define attribute in', '#define varying out',
        '#define texture2D texture'].join('\n') + '\n';
      const COMPAT_FRAG = (glsl3) => ['#define varying in',
        glsl3 ? '' : 'layout(location = 0) out highp vec4 pc_fragColor;',
        glsl3 ? '' : '#define gl_FragColor pc_fragColor',
        '#define gl_FragDepthEXT gl_FragDepth', '#define texture2D texture',
        '#define textureCube texture', '#define texture2DProj textureProj',
        '#define texture2DLodEXT textureLod', '#define texture2DProjLodEXT textureProjLod',
        '#define textureCubeLodEXT textureLod', '#define texture2DGradEXT textureGrad',
        '#define texture2DProjGradEXT textureProjGrad',
        '#define textureCubeGradEXT textureGrad'].join('\n') + '\n';
      const MATS = 'uniform mat4 modelMatrix;\nuniform mat4 modelViewMatrix;\n'
        + 'uniform mat4 projectionMatrix;\nuniform mat4 viewMatrix;\n'
        + 'uniform mat3 normalMatrix;\nuniform vec3 cameraPosition;\n';
      const ATTRS = 'in vec3 position;\nin vec2 uv;\nin vec3 normal;\n';
      const FRAG_UNIFORMS = 'uniform mat4 viewMatrix;\nuniform vec3 cameraPosition;\n'
        + 'uniform bool isOrthographic;\n';
      const out = [];
      for (const p of programs) {
        const glsl3 = p.glsl === 3;
        const defs = Object.entries(p.defines).map(([k, v]) => `#define ${k} ${v}`).join('\n');
        const head = `#version 300 es\n${defs}\nprecision highp float;\nprecision highp int;\n`;
        const vertPre = COMPAT_VERT + ATTRS + MATS;
        const fragPre = COMPAT_FRAG(glsl3) + FRAG_UNIFORMS;
        const mk = (type, src) => {
          const s = gl.createShader(type);
          gl.shaderSource(s, src);
          gl.compileShader(s);
          return { s, ok: !!gl.getShaderParameter(s, gl.COMPILE_STATUS), log: gl.getShaderInfoLog(s) || '' };
        };
        const vsrc = window.LW.SRC[p.vert];
        const fsrc = window.LW.SRC[p.frag];
        if (typeof vsrc !== 'string' || typeof fsrc !== 'string') {
          out.push({ name: p.name, ok: false, log: `missing source for ${p.vert}/${p.frag}` });
          continue;
        }
        const v = mk(gl.VERTEX_SHADER, head + vertPre + vsrc);
        const f = mk(gl.FRAGMENT_SHADER, head + fragPre + fsrc);
        let linked = false, linkLog = '';
        if (v.ok && f.ok) {
          const prog = gl.createProgram();
          gl.attachShader(prog, v.s); gl.attachShader(prog, f.s);
          gl.linkProgram(prog);
          linked = !!gl.getProgramParameter(prog, gl.LINK_STATUS);
          linkLog = gl.getProgramInfoLog(prog) || '';
          gl.deleteProgram(prog);
        }
        gl.deleteShader(v.s); gl.deleteShader(f.s);
        out.push({
          name: p.name, from: p.from, ok: v.ok && f.ok && linked,
          log: [v.ok ? '' : `VERT(${p.vert}): ${v.log}`, f.ok ? '' : `FRAG: ${f.log}`,
            (v.ok && f.ok && !linked) ? `LINK: ${linkLog}` : ''].filter(Boolean).join('\n').slice(0, 2000),
        });
      }
      return { renderer, out };
    }, programs);
  } finally {
    await browser.close();
  }

  if (!results.renderer) {
    // No GPU here is an environment fact, not a shader defect. Say so and pass:
    // a checker that fails on CI-without-a-GPU gets disabled, and then it checks
    // nothing at all.
    console.log('check-shaders: no WebGL2 context available -- SKIPPED (not a pass).');
    process.exit(0);
  }
  console.log(`driver: ${results.renderer}`);
  let bad = 0;
  for (const r of results.out) {
    if (r.ok) continue;
    bad++;
    console.log(`FAIL  ${r.name}   (${r.from})`);
    console.log(r.log.split('\n').map((l) => `        ${l}`).join('\n'));
  }
  console.log(`check-shaders: ${results.out.length - bad}/${results.out.length} pass programs compile and link`
    + ` (${found.length} discovered in ${PAIRING.length} dirs).`);
  if (bad) console.log('Material shaders are NOT covered here; capture.mjs is their instrument.');
  process.exit(bad ? 1 : 0);
} finally {
  await rm(tmp, { recursive: true, force: true });
}
