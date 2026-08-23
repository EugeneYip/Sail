#!/usr/bin/env node
/**
 * Repository context for an AI or human starting cold.
 *
 * Prints, in one pass, the things you must know before touching anything:
 * where HEAD is relative to what is deployed, what is dirty, which worktrees
 * exist and whether any of them looks like a LIVE writer, and which notes are
 * unintegrated.
 *
 *   node scripts/ai-context.mjs
 *
 * Deliberately standalone — no package.json entry, no dependencies, read-only.
 * It runs git and nothing else, and it never writes.
 *
 * Worktree `git status` can take tens of seconds in this repository, so each
 * worktree is queried separately with its own timeout rather than in a loop that
 * would stall the whole run.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const git = (args, opts = {}) => {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      timeout: opts.timeout ?? 20000,
      stdio: ['ignore', 'pipe', 'ignore'],
      cwd: opts.cwd,
    }).trim();
  } catch {
    return null;
  }
};

const h1 = (s) => console.log(`\n${'='.repeat(72)}\n${s}\n${'='.repeat(72)}`);
const h2 = (s) => console.log(`\n-- ${s}`);
const age = (iso) => {
  if (!iso) return '?';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 90) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  return hrs < 48 ? `${hrs} h ago` : `${Math.round(hrs / 24)} days ago`;
};

h1('SAIL / LEEWARD — repository context');
console.log('  production   : https://eugeneyip.github.io/Sail/');
console.log('  deploys from : push to `main` (.github/workflows/pages.yml)');
console.log('  read first   : AI_HANDOFF.md, then AGENTS.md, then DIAGNOSIS.md');

h2('Which repository is this?');
const top = git(['rev-parse', '--show-toplevel']);
console.log(`  toplevel : ${top ?? 'NOT A GIT REPOSITORY'}`);
if (top && !/leeward$/.test(top)) {
  console.log('  ** This is not the Sail/leeward checkout. A path is NOT evidence of');
  console.log('     repository ownership -- a stray parent .git can capture a directory.');
  console.log('     Stop and confirm where you are before writing anything. **');
}

h2('HEAD');
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
const head = git(['rev-parse', '--short', 'HEAD']);
const subject = git(['log', '-1', '--format=%s']);
console.log(`  branch  : ${branch}`);
console.log(`  HEAD    : ${head}  ${subject ?? ''}`);

h2('Relationship to what is DEPLOYED (origin/main)');
const deployed = git(['rev-parse', '--short', 'origin/main']);
const counts = git(['rev-list', '--left-right', '--count', 'origin/main...HEAD']);
if (deployed && counts) {
  const [behind, ahead] = counts.split(/\s+/);
  console.log(`  origin/main (deployed) : ${deployed}`);
  console.log(`  local is               : ${ahead} ahead, ${behind} behind`);
  if (Number(ahead) > 0) {
    console.log('  ** Local work is NOT deployed. Player reports may predate it. **');
  }
  if (Number(behind) > 0) {
    console.log('  ** Local is BEHIND origin/main. Fetch and reconcile before working. **');
  }
} else {
  console.log('  could not read origin/main — run `git fetch origin` first');
}

h2('Working tree');
const status = git(['status', '--short']);
console.log(status ? status.split('\n').map((l) => `  ${l}`).join('\n') : '  clean');
console.log('  (`.claude/` is expected to be untracked — leave it that way)');

h2('Recent history');
const log = git(['log', '--oneline', '-12']);
if (log) console.log(log.split('\n').map((l) => `  ${l}`).join('\n'));

h1('WORKTREES — is anyone else writing?');
console.log('  Rule: DIRTY != INTERRUPTED. Never reset, stash, discard or integrate');
console.log('  another writer\'s uncommitted work without an explicit handoff.\n');
const wtRoot = '.claude/worktrees';
if (!existsSync(wtRoot)) {
  console.log('  no .claude/worktrees directory');
} else {
  for (const name of readdirSync(wtRoot)) {
    const dir = join(wtRoot, name);
    let isDir = false;
    try { isDir = statSync(dir).isDirectory(); } catch { /* ignore */ }
    if (!isDir) continue;
    const b = git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir });
    const hd = git(['rev-parse', '--short', 'HEAD'], { cwd: dir });
    const when = git(['log', '-1', '--format=%cI'], { cwd: dir });
    const subj = git(['log', '-1', '--format=%s'], { cwd: dir });
    const st = git(['status', '--short'], { cwd: dir, timeout: 45000 });
    const dirty = st ? st.split('\n').filter(Boolean) : [];
    const live = dirty.length > 0 && when
      && Date.now() - new Date(when).getTime() < 90 * 60000;
    console.log(`  ${name}`);
    console.log(`    branch : ${b ?? '?'}`);
    console.log(`    HEAD   : ${hd ?? '?'}  (${age(when)})  ${(subj ?? '').slice(0, 60)}`);
    if (st === null) {
      console.log('    dirty  : could not read (timed out) — assume it may be LIVE');
    } else if (dirty.length === 0) {
      console.log('    dirty  : none');
    } else {
      console.log(`    dirty  : ${dirty.length} file(s)${live ? '   ** MAY BE LIVE **' : ''}`);
      for (const d of dirty.slice(0, 8)) console.log(`             ${d}`);
    }
  }
  console.log('\n  A task can also run in a worktree that does not exist here at all');
  console.log('  (another machine or session). If the owner names an active task you');
  console.log('  cannot see, treat the files it would own as off-limits and say so.');
}

h1('UNINTEGRATED NOTES');
console.log('  notes/<topic>.md is a concurrent agent\'s workspace. Fold into');
console.log('  DIAGNOSIS.md and delete ONLY once the owning session has stopped.');
console.log('  Agents must never number their own sections. See notes/README.md.\n');
if (existsSync('notes')) {
  const files = readdirSync('notes').filter((f) => f.endsWith('.md') && f !== 'README.md');
  if (files.length === 0) {
    console.log('  none — nothing outstanding');
  } else {
    for (const f of files) {
      const m = statSync(join('notes', f)).mtime;
      const recent = Date.now() - m.getTime() < 90 * 60000;
      console.log(`  notes/${f}  (touched ${age(m.toISOString())})${recent ? '  ** MAY BE LIVE **' : ''}`);
    }
  }
}

h1('GATES');
console.log('  npm run typecheck      GLSL lint + tsc');
console.log('  npm run check-shaders  compiles/links every program on a real driver');
console.log('  npm run preflight      publishability: scratch files, secrets, size, docs, notes');
console.log('                         (it does NOT detect a downloaded asset as downloaded --');
console.log('                          that rule is AGENTS.md #7 plus review)');
console.log('  npm run build          tsc --noEmit && vite build');
console.log('  node scripts/physics-test.mjs --quick');
console.log('\n  DO NOT PUSH unless the owner asks — a push to main deploys to players.\n');
