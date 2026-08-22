# `notes/` — where a concurrent session records a diagnosis

**If you are a background or worktree agent: write your findings here, in
`notes/<your-topic>.md`, and do not touch `DIAGNOSIS.md` at all.**

## Why this directory exists

`DIAGNOSIS.md` is a single monotonically-numbered document, and that makes it
unsafe for concurrent writers in two independent ways:

1. **The numbers collide.** It happened three times. Two ocean sessions both took
   §75. A foam session wrote §65 against a main that had already reached §78. The
   number an agent can see is the number that was free when its worktree was
   created, which is not the number that is free when its work is integrated.
2. **The file conflicts.** Even with perfect numbering, two agents appending to
   the same file produce a merge conflict in a 3000-line document every time.

Numbering was the visible symptom; the shared mutable file is the cause. One file
per topic removes both — an agent's notes cannot collide with anything, because
nothing else writes that path.

## The rule

- **Agents** create `notes/<topic>.md` and write freely: use a plain descriptive
  `#` heading, and **never number your own sections.**

  **Citing an existing section is encouraged.** `as §40 already proved`,
  `see §71`, even `## Why §40 matters` — all fine, and referring back to earlier
  findings is exactly what these notes are for. What fails the gate is a heading
  that *is numbered*:

  | | |
  |---|---|
  | `## 82. New diagnosis` | **allocation — fails** |
  | `### §82 New diagnosis` | **allocation — fails** |
  | `as §40 already proved` | reference — fine |
  | `## Why §40 matters` | reference in a heading — fine |

  The discriminator is heading *position*, not the presence of a section sign. An
  earlier version of the check failed on any `§n` anywhere, and the very first
  real note written under this convention tripped it on the words "as §40 already
  proved".
- **The integrating session on `main`** folds the content into `DIAGNOSIS.md`,
  assigns the next sequential number at that moment, and deletes the note —
  **but only once the owning session has stopped.** A note on disk means someone
  may still be writing into it. An integrator once deleted a live agent's note
  mid-edit on the assumption that untracked meant abandoned; see `AGENTS.md`,
  *Reconciling another session's work*, and §82a. `preflight` prints each note's
  age and marks recent ones `MAY BE LIVE` for exactly this reason.
- A note left here is *unintegrated work*, not clutter — `preflight` reports them
  so a paused session's findings cannot be quietly lost. That has already happened
  once: an interrupted session's uncommitted `src/vfx` work survived only because
  a reconciliation pass went looking for it.

**`preflight` finds notes on disk, not in git.** You do not have to `git add` a
note for it to count — an agent that writes one and then hits its token limit
before staging is exactly the case this exists to catch, and a git-based check
would have reported nothing. A file git is deliberately *ignoring* is skipped, so
scratch space in here stays your own business.

## Naming

`notes/<short-kebab-topic>.md` — e.g. `notes/cloud-slab-streaks.md`. Name it after
the *finding*, not after the branch: branch names are generated and tell a later
reader nothing, and the topic is what the integrator needs to place it.
