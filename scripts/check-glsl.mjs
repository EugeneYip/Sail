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
 */

import { glob, readFile } from 'node:fs/promises';
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
  return out;
}

let bad = 0;
for await (const file of glob('src/**/*.ts')) {
  const src = await readFile(file, 'utf8');
  if (!src.includes('`')) continue;
  const textLines = templateTextLines(src);
  src.split('\n').forEach((l, idx) => {
    const n = idx + 1;
    if (!textLines.has(n)) return;
    if (!LOOKS_LIKE_COMMENT.test(l)) return;
    if (!l.includes('`')) return;
    console.error(
      `${file}:${n}  backtick in a comment inside GLSL template text\n` +
        `    ${l.trim()}\n` +
        `    -> use 'single quotes' for code spans here; a backtick ends the template`,
    );
    bad++;
  });
}

if (bad) {
  console.error(`\n${bad} occurrence(s) — this is the bug that keeps breaking the build.`);
  process.exit(1);
}
console.log('check-glsl: clean');
