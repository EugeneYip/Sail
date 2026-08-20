#!/usr/bin/env node
/**
 * Catches the one mistake that has broken this build more than any other: a
 * backtick-quoted code span inside a comment that sits in the TEXT portion of a
 * GLSL template literal.
 *
 *   const frag = `
 *     // `foo` does the thing
 *   `;
 *
 * In template text, `//` is not a comment — it is literal characters — so the
 * backtick closes the template early and TypeScript reports a cascade of syntax
 * errors dozens of lines from the real cause.
 *
 * The distinction that matters: inside a `${ ... }` interpolation we are back in
 * TypeScript, where `//` IS a comment and backticks in it are harmless. A
 * checker that ignores this cries wolf on correct code and gets ignored, so
 * this walks the source with a real (small) lexer instead of counting backticks.
 *
 * THE BLIND SPOT THAT MADE THIS CHECKER LIE, AND THE TWO NETS THAT CLOSE IT
 * An agent hit the exact bug this file exists to catch -- a backtick pair in a
 * GLSL comment in `ocean/shaders/surface.ts` -- and got `check-glsl: clean`,
 * `tsc --noEmit` green, and then a FAILED `vite build`. The checker missed the
 * one bug it was written for.
 *
 * Mechanism, reproduced: the lexer has no recovery. The first stray backtick
 * pops it out of template state, so every later line in that file is
 * misclassified as code and silently skipped. Minimal case -- line 3 is
 * reported, line 4 is NOT:
 *
 *   const F = `
 *     // an odd backtick like `this flips the lexer
 *     // and then `this real pair` is silently missed
 *   `;
 *
 * So a single-net design is wrong here: the net that localises the error is the
 * same net the error destroys. Two independent checks now run.
 *
 *   1. PARSE (ground truth, no lexer). Hand every file to esbuild's parser. A
 *      file it cannot parse WILL NOT BUILD -- that is not a heuristic, it is the
 *      same parser Vite uses. This cannot be desynchronised by the bug it is
 *      looking for.
 *   2. LOCALISE (the lexer), which is what turns esbuild's "Expected ; but
 *      found this" into "backtick in a GLSL comment, use single quotes". It now
 *      ASSERTS its own end state: a well-formed file must finish at depth 1 in
 *      code. If it does not, the lexer lost sync, its per-line verdicts are
 *      untrustworthy, and it says so instead of printing "clean".
 */

import { glob, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import process from 'node:process';

/** Lines that the author clearly meant as a comment. */
const LOOKS_LIKE_COMMENT = /^\s*(?:\/\/|\*|\/\*)/;

/**
 * Returns the 1-based line numbers that sit in template *text* (not in code and
 * not inside an interpolation).
 */
function templateTextLines(src) {
  const out = new Set();
  // stack entries: 'tpl' for template text, 'code' for an interpolation body
  const stack = ['code'];
  let line = 1;
  let i = 0;
  const top = () => stack[stack.length - 1];

  while (i < src.length) {
    const c = src[i];
    const c2 = src[i + 1];

    if (c === '\n') {
      line++;
      i++;
      if (top() === 'tpl') out.add(line);
      continue;
    }

    if (top() === 'code') {
      if (c === '/' && c2 === '/') {
        while (i < src.length && src[i] !== '\n') i++;
        continue;
      }
      if (c === '/' && c2 === '*') {
        i += 2;
        while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
          if (src[i] === '\n') line++;
          i++;
        }
        i += 2;
        continue;
      }
      if (c === '"' || c === "'") {
        i++;
        while (i < src.length && src[i] !== c) {
          if (src[i] === '\\') i++;
          i++;
        }
        i++;
        continue;
      }
      if (c === '`') {
        stack.push('tpl');
        i++;
        out.add(line);
        continue;
      }
      if (c === '}' && stack.length > 1) {
        stack.pop(); // leave the interpolation, back into template text
        i++;
        continue;
      }
      i++;
      continue;
    }

    // top() === 'tpl' — template text. Only ` and ${ are special.
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '`') {
      stack.pop();
      i++;
      continue;
    }
    if (c === '$' && c2 === '{') {
      stack.push('code');
      i += 2;
      continue;
    }
    i++;
  }
  // A well-formed TypeScript file ends outside every template and every
  // interpolation. Anything else means we lost sync somewhere and every verdict
  // after that point is worthless -- see the header.
  return { lines: out, synced: stack.length === 1 && stack[0] === 'code' };
}

const require = createRequire(import.meta.url);
const esbuild = require(require.resolve('esbuild', { paths: [require.resolve('vite')] }));

let bad = 0;
let unparseable = 0;
let desynced = 0;

for await (const file of glob('src/**/*.ts')) {
  const src = await readFile(file, 'utf8');
  if (!src.includes('`')) continue;

  /* 1. Ground truth: does it parse at all? ---------------------------------- */
  try {
    await esbuild.transform(src, { loader: 'ts', sourcefile: file });
  } catch (e) {
    unparseable++;
    const m = e.errors?.[0];
    const where = m?.location ? `${file}:${m.location.line}` : file;
    console.error(`${where}  WILL NOT BUILD: ${m?.text ?? e.message}`);
    if (m?.location?.lineText) console.error(`    ${m.location.lineText.trim()}`);
    console.error('    -> if this line is a comment inside a GLSL template, a backtick'
      + " ended the template early; use 'single quotes' for code spans there");
  }

  /* 2. Localisation: which comment did it, in plain words. ------------------ */
  const { lines: textLines, synced } = templateTextLines(src);
  if (!synced) {
    desynced++;
    console.error(`${file}  lexer lost sync — its per-line verdicts for this file are`
      + ' unreliable, so treat the parse result above as the answer');
  }
  src.split('\n').forEach((l, idx) => {
    const n = idx + 1;
    if (!textLines.has(n)) return;
    if (!LOOKS_LIKE_COMMENT.test(l)) return;
    if (!l.includes('`')) return;
    console.error(
      `${file}:${n}  backtick in a comment inside GLSL template text\n`
        + `    ${l.trim()}\n`
        + `    -> use 'single quotes' for code spans here; a backtick ends the template`,
    );
    bad++;
  });
}

if (bad || unparseable || desynced) {
  const parts = [];
  if (unparseable) parts.push(`${unparseable} file(s) that will not build`);
  if (bad) parts.push(`${bad} backticked comment(s)`);
  if (desynced) parts.push(`${desynced} file(s) the lexer could not follow`);
  console.error(`\n${parts.join(', ')} — this is the bug that keeps breaking the build.`);
  process.exit(1);
}
console.log('check-glsl: clean (parsed + lexed)');
