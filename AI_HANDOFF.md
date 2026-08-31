# AI_HANDOFF — start here

**Audience:** any competent AI (Claude, GPT, Grok, Codex, …) or human picking this
repository up with **zero access to the conversation that produced it.**

This file is the **current operational state**. It is deliberately short. It does not
repeat the project's history — it tells you what is true now and where to look.

| document | role |
|---|---|
| **AI_HANDOFF.md** (this file) | current state, onboarding, what to do next |
| `AGENTS.md` | permanent engineering rules and the build contract — **binding** |
| `DIAGNOSIS.md` | forensic history: why decisions were made, failed experiments, retractions |
| `HANDOVER.md` | project narrative and design intent. **Superseded where it conflicts with `AGENTS.md` or this file** — notably its "State as of 2026-08-20" section, and its suggestion to price changes with `ext.post.profile()`, which `AGENTS.md` now forbids (see §9). |
| `RUBRIC.md` | how visual quality is judged |
| `notes/` | scratch space for concurrent agents; see `notes/README.md` |
| source + `scripts/` | the final behavioural authority. When docs and code disagree, code wins. |

---

## 1. What is this?

**Leeward** — an endless procedural sailing game in the browser. You helm the USS
Constitution (1797 frigate) on an open ocean. Three.js + TypeScript + Vite, WebGL2.

**Everything is generated in code**: hull, rigging, sails, ocean, sky, clouds, textures,
audio. **No downloaded assets of any kind** — no textures, models, HDRIs or audio files.
That constraint is deliberate and non-negotiable. Note what enforces it: `AGENTS.md`
non-negotiable #7 and review — **not** `npm run preflight`, which gates scratch files,
plausible secrets, file size, docs, HTML metadata, the Vite base and notes, but would not
recognise a small downloaded texture as downloaded. Do not rely on the tooling to catch it.

Repository: `https://github.com/EugeneYip/Sail`

## 2. Production

- **URL:** <https://eugeneyip.github.io/Sail/>
- **Deploy branch:** `main`. Any push to `main` deploys.
- **Pipeline:** `.github/workflows/pages.yml` → `npm run typecheck` → `npm run check-shaders`
  → `npm run preflight` → `npm run build` → GitHub Pages.
- **Vite `base` must stay `'./'`** (`vite.config.ts`) or the Pages build 404s its assets.

> **Pushing deploys to players.** Do not push unless the owner asks. The owner pushes
> manually.

## 3. Authoritative checkpoint — derive it, do not read it here

**Any commit hash written into this file is stale the moment the next commit lands.** A
previous version of this section hardcoded one and was already wrong by the time the first
cold reader arrived. So there is no table here. Run:

```bash
git fetch origin && node scripts/ai-context.mjs
```

That prints the live HEAD, the deployed commit (`origin/main`), the ahead/behind count, and
warns you outright when local work is not deployed.

The two facts that do not change:

- **`origin/main` is what players are running.** Local commits are not deployed until pushed.
- **Never assume the player is testing your latest work.** Check the ahead/behind count before
  interpreting any bug report. Misreading this once caused a whole round of wrong conclusions
  (`DIAGNOSIS.md` §118 opening) — a report was attributed to unfixed code that had in fact
  already been fixed, and vice versa.

## 4. First-start procedure

**Verify which repository you are in before anything else.** A directory name or path is
not evidence of repository ownership — a stray home-level `.git` once made every directory
beneath it look like part of an unrelated repository, and a retired but otherwise perfectly
valid clone of *this* repository still exists on this machine (§5a). Identity comes from
these three:

```bash
git rev-parse --show-toplevel     # where this checkout actually is
git rev-parse --git-common-dir    # `.git` = standalone clone; a path elsewhere = linked worktree
git remote -v                     # must be github.com/EugeneYip/Sail
```

Then the state:

```bash
git fetch origin
git status --short
git rev-list --left-right --count origin/main...HEAD
git log --oneline -12
git worktree list
```

Then, for the same picture in one shot including worktree ownership and open notes:

```bash
node scripts/ai-context.mjs
```

Then read, in this order: this file → `AGENTS.md` → the `DIAGNOSIS.md` sections named below.

## 5. What is open and what is closed

**Closed and validated** (each has a `DIAGNOSIS.md` section with the measurements):

- Cloud-shadow dark blotches — §107, §108 (the shadow slice had no temporal filter)
- Boston harbour *topology* — §109, §110 (shoreline, channel, closed volume, normals)
- Stern/wake ruled partition — §111, §112 (the transom pad's alpha clamp, not its fade)
- Gunport lids reading as shelves — §113, §114 (1.32 → 2.2 rad)
- Stern residual see-through — §118 A (the counter top was never built)
- Sail **false translucency** / ungated sky wash — §118 B, §121
- Ensign penetrating the spanker — §118 C
- Dark specks at high wind on a flat sea — §119 (whitecaps without waves)
- Accidental iPad double-tap zoom — §120, §121

**Open — do not describe these as closed:**

| item | state |
|---|---|
| **The whole round-2 visual package** | **deployed and awaiting player validation.** Counter top, sail sky-wash gate, ensign clearance, whitecaps-without-waves, iPad zoom. Engineering-complete; no player confirmation yet. Do not reopen any of it on suspicion alone — wait for a report |
| **Boston harbour** | topology engineering-accepted; **deployed/player validation pending** |
| **Mobile / iPad zoom** | engineering fixed; validated with Playwright WebKit using an iPad profile; **real-device iPad/iPhone player validation pending** (§121) |
| **Sail residual sheen mottling** | measured (−19.5 % of mottling is the `sheen` lobe); **deferred visual-quality decision**, not a closed defect (§121) |
| Rope free ends (backstay feet) | cause known: the foot sits ~0.72 m outboard of the planking; moving it is coupled to `fitRigEnvelope` / spanker clearance (§115) |
| Far-sea dot-lattice aliasing | never isolated |
| `wgeom` `tube`/`cyl`/`rope` normals | **bounded cross-system lead only.** Boston's land/island/box cases are proven inverted; vessel/buoy/creature consumers are unexamined. **Do not flip globally** without a per-consumer audit (§110, §117) |
| Pale blocky blobs on a flat mirror sea | observed, pale not dark, uninvestigated (§119) |
| Physics `no wave-riding speed blowout` | pre-existing unstable assertion. Established: **no code path from `src/ship/build/*` into the solver.** Do not re-investigate (§117 B) |
| `measure-selftest` CONFOUND assertions | intermittently fail on `origin/main` too. Stochastic, not a regression (§116) |
| Boston façades / city quality | blockout-grade by intent. Do not start façade polish before topology player-validation |

## 5a. Where this repository lives, and what else is on disk

**Canonical identity is established from git facts, never inferred from a directory name.**
The three checks in §4 are the test. The table below is a fact about *today's* machine, not
a rule: a legitimate future clone of `EugeneYip/Sail` may live at any path. Only the legacy
checkout is named, because it is a genuine clone of this repository and would otherwise pass
every check you could run on it.

| location | status |
|---|---|
| `/Volumes/Projects/sail/leeward` | **current canonical working location.** External SSD, APFS, created 2026-08-31 by a fresh clone from GitHub. All normal development, new agents and new worktrees originate here. |
| `/Users/eugene/Desktop/sail/leeward` | **LEGACY / RECOVERY ONLY — DO NOT USE FOR NORMAL DEVELOPMENT.** A complete, valid, same-remote, same-HEAD clone — which is exactly what makes it dangerous: nothing in its contents says it is retired. It still holds five old worktrees, two of them dirty. **Do not modify, prune, reset, stash, merge or delete it or its worktrees.** They are historical recovery material pending a separate cleanup decision. `scripts/ai-context.mjs` warns by name if you run it there. |
| `/Users/eugene/.git-retired-2026-08-23` | a home-level `.git` that had accidentally made `/Users/eugene` a repository. Retired, not deleted. Its old branches and worktrees are unrelated historical tallship/Solo work. **Do not restore it.** Its existence is why `AGENTS.md` now requires `git rev-parse --show-toplevel` before trusting any worktree. |
| `/Users/eugene/Desktop/sail/UNCOMMITTED-worktree-ca2247-2026-08-23.patch` | uncommitted work preserved from that migration. Audited read-only: it touches `.DS_Store`, `.claude/launch.json`, and `tallship/` paths only — **no** `src/physics/*`, `scripts/physics-test.mjs` or `tsconfig*`. Unrelated to any current task. **Do not apply it. Do not delete it yet.** |

No old `.claude/worktrees` were migrated, and none must be reconstructed. A worktree created
before this migration belongs to the legacy checkout; create fresh ones from the canonical
repository, after running the three checks in §4.

## 6. Git and worktree rules — non-negotiable

- **Never** `git add .`, `git add -A`, `git add --all`. Stage explicit paths only.
- **Keep `.claude/` untracked.** It holds worktrees and local launch config.
- **Do not push** unless the owner asks.
- **Do not rewrite pushed history.** Do not squash or rebase to tidy up.
- **Do not prune or delete worktrees** as part of any other task.
- **Dirty ≠ interrupted.** Uncommitted files in a worktree may belong to a *live* writer.
  Never restore, reset, stash or discard someone else's uncommitted work, and never
  integrate partial work without an explicit completion handoff.
- After any `git stash push` / `git stash pop` cycle, **check for `* 2.ts`-style duplicate
  files** — a stash cycle has produced byte-identical duplicates here before (§116).

### How to tell whether dirty files belong to an active writer

There is no flag for it. Use evidence:

```bash
git worktree list
for w in .claude/worktrees/*/; do
  echo "$w"; git -C "$w" rev-parse --abbrev-ref HEAD
  git -C "$w" log -1 --format='%cr  %s'
  git -C "$w" status --short
done
```

Note: `git status` inside a worktree can take tens of seconds here — query worktrees
**one at a time**, not in a single loop, or the command will time out. And confirm each
one's toplevel with `git rev-parse --show-toplevel` before trusting it: **a path is not
proof of which repository a worktree belongs to.**

**Never hardcode a worktree directory name.** They are generated and can disagree with
their own branch. The standing example — `reverent-jepsen-5ed163` checked out on
`claude/gifted-lalande-041ee3` — is **history from the legacy Desktop repository (§5a), not
a worktree registered in this one.** Resolve branch and HEAD from git per worktree, every
time; never from a name written in a document. See `AGENTS.md` →
*Reconciling another session's work* for the binding form of this rule.

Then judge:

1. **Recency.** A worktree whose last commit is minutes old and whose files are dirty is
   probably live. Days old is probably paused — still not yours to take.
2. **Overlap.** Compare its dirty paths against what you intend to touch. If they overlap,
   pick different work.
3. **`npm run preflight`** prints each file in `notes/` with its age and marks recent ones
   `MAY BE LIVE`.
4. **A task may run in a worktree that does not exist in this repository at all** (another
   machine or session). If the owner names an active task you cannot see, treat the files
   it would plausibly own as off-limits and say so rather than guessing.

When in doubt: **take nothing, touch nothing, and report.**

## 7. How temporary notes are integrated

Full protocol in `notes/README.md`. In short:

- A concurrent/worktree agent writes `notes/<topic>.md` and **never touches `DIAGNOSIS.md`**
  (numbered sections collide; it has happened three times).
- Agents **must not** number their own sections. Citing an existing `§n` in prose is fine.
- Only the integrating session on `main` folds a note into `DIAGNOSIS.md`, assigns the next
  sequential number **at that moment**, and deletes the note — and **only once the owning
  session has stopped.**
- Delete a note only if nothing in it is unique. Check by content, not by assumption.

## 8. How player-visible defects are validated

1. **Reproduce at the player's own viewpoint class first.** Several defects here are
   viewpoint-dependent and invisible from a level side view or a pure top-down. The stern
   see-through was mis-described as needing an extreme overhead angle when it is plain from
   an ordinary oblique stern-quarter.
2. **Pin the weather** (see §9 below) and assert it held.
3. **Isolate causally** — ablate one thing at a time, with a null control arm that changes
   nothing. If the control moves as much as the result, you have measured noise.
4. **Assert the lever binds.** A patched string is not a bound lever.
5. **Fix only after causal closure**, then re-validate at the same viewpoints, and capture
   before/after.
6. Gates: `npm run typecheck`, `npm run check-glsl`, `npm run check-shaders`,
   `npm run preflight`, `npm run build`.

## 9. Instruments known to be INVALID — do not repeat these

Each of these produced a wrong conclusion here. `AGENTS.md` → *Measuring anything: use the
harness* is the binding list; these are the ones that cost the most.

- **`Object.assign(world.env, …)` does not establish a weather condition.** A weather
  simulation keeps driving `world.env`: `41 kn / sea 0 / wave 0.0` drifted to wave 2.38 /
  sea 4.90 / wind 27.3 in **six seconds**. Use `world.ext.env.pin(field, value)` — the same
  path the UI uses — then settle, read back, **assert**, then measure (§119).
- **Reading numeric values out of the composited framebuffer.** AgX tonemapping and the look
  LUT corrupt them; a zero channel comes back lifted. Sample a **pre-tonemap** target such
  as the post stack's `post/scene` (rgba16f, NoColorSpace) instead. Cost three attempts
  before it was believed (§112).
- **Freezing a texture uniform's `.value`.** That holds a *pointer* to a render target that
  is overwritten in place; the pixels keep changing and the "held" assertion is vacuous.
  Stub the pass that writes the target and assert on blocked call count (§107).
- **`dt = 0` does not freeze the image.** `time.frame` still increments, so TAA re-jitters,
  film grain re-dithers ~90 % of pixels, the cloud march re-marches, and a 1-LSB dither
  fires. State froze; the picture never did (§111).
- **Fresh-load brightness boxes in the wake region.** Swamped by wake-state variance; the
  same metric moved +45 % and −22 % across stations for one change (§112).
- **Per-load arms are not pixel-joinable.** Separate page loads leave the ship in different
  states. Swap the material's `fragmentShader` in-page instead (§112).
- **Additive particles contaminate readbacks.** They lifted a "1.0" control arm to 1.0635.
  Hide them for the run (§112).
- **`RedFormat` targets are one channel.** Reading one with a `w*h*4` buffer leaves three
  quarters unfilled and reads them as zeros — the tell was a mean of exactly 0.853/4 (§116).
- **Vertex counts near sea level are not an acceptance metric** for Boston: 26 % of the mesh
  sits within ±5 m of the surface either way, because moored hulls float there (§110).
- Class names are **minified in production builds** — runtime scans by
  `constructor.name` work in dev and silently find nothing in `dist` (§116).
- **`world.ext.post.profile()` is not frame cost.** It leans on `gl.finish()`, which does not
  block under ANGLE-on-Metal, so it reports CPU submission: its passes sum to ~2.3–2.6 ms
  against frames costing 25–56 ms. `HANDOVER.md` still recommends it; `AGENTS.md` forbids it.
- **Wall-clock fps under GPU contention is noise.** Load average is a CPU run-queue metric and
  cannot see a rival renderer. If a capture prints `!! rival renderer(s) — TIMINGS INVALID`,
  believe it — state readouts are still fine, timings are not.
- **Sub-60 fps is the engine's standing state, not a regression signal.** `AGENTS.md`
  non-negotiable #5 records the target as currently unmet and gives the measured model,
  `cost = 9.44 ms + 13.83 ms/Mpx`, so 1600x900 at 1:1 costs ~29 ms by design. Judge a *change*
  against a measured baseline at the same pixel count, and always quote the pixel count and
  whether it is CSS or backing store. `RUBRIC.md` **deliberately excludes** performance from
  its automatic failures and says why — beware: `AGENTS.md` "Verifying your work" still lists
  `sub-60fps` among them, which is wrong; `RUBRIC.md` is the authority on its own contents.

## 10. What to work on next

Nothing is urgent. In rough priority:

1. **Wait for player validation** of the three-commit round-2 package and of Boston harbour.
2. The `wgeom` normals **bounded audit** — one representative vessel, buoy and creature
   consumer each; classify before considering any shared change.
3. Issue 4A rope free ends, if the owner wants it: either land the backstay foot on the
   ship's side (needs a spanker-clearance pass across trim states) or add the missing
   deadeye and chainplate at the existing foot (envelope-safe, 18 fittings).
4. The deferred sail sheen mottling decision.

Do not start façade polish, a global normals flip, or a new visual defect without the owner
asking.
