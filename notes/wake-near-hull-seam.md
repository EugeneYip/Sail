# The near-hull ruled seam (owner P2): testing §94's mechanism

**Question.** The owner reports a smooth pale plate hugging the waterline whose
outer boundary is a hard ruled edge, with the ocean's own textured foam beyond
it. §94 excluded all vfx geometry (~1 code of change against a 3.25-code
temporal floor) and named `src/ocean/shaders/surface.ts` — specifically
`wakeFoam = max(wk.r - 0.06, 0.0) * (1/0.94) * wf` (line ~131) and
`cover = max(cover, wakeFoam * 0.88)` (line ~594) — as a *read-off-source,
not-yet-tested* candidate. My job is to confirm or refute it causally, then fix
it without globally blurring foam.

Status: IN PROGRESS. Everything below is either measured here or cited.

## Reading the chain before measuring it

Recorded because it changes what the discriminator has to be.

§94's story is that `max(cover, wakeFoam * 0.88)` "replaces the ocean's own
detailed foam wherever the smooth plate wins". Reading `surface.ts`, the ocean's
detail is **not** in `cover`. `cover` is a scalar coverage *fraction*; all of the
detail is downstream of it, in §40's threshold-on-flattened-noise
(`thr = 1 - cover + bite * (...)`, `foam = linstep(thr - wThr, thr + wThr,
decide)`). Whatever raises `cover`, the tearing is applied to it afterwards. So
raising `cover` from a smooth metre-scale field should still come out torn, and
§94's mechanism as literally written has a hole in it.

Two ways the plate could still be real, both about the *detail* terms rather than
`cover`:

1. `bite = min(cover, 1 - cover) * 2` collapses as `cover -> 1`, taking the
   threshold perturbation with it. But the wake's ceiling is
   `(0.78 - 0.06)/0.94 * 0.88 = 0.674`, so `bite = 0.652` — not collapsed.
2. `wThr = mix(0.05, 0.5, smoothstep(1.2, 3.5, pxWorld))` and the `r1/r2/r3`
   octave schedules. If `pxWorld` is large at the waterline in that view, the
   fine octaves are gone, the decision field's features are metres wide, and the
   linstep is a half-unit-wide *wash* rather than a cut — a smooth pale plate by
   construction. This is a distance/footprint story, not a `max` story.

So the A/B has to separate "is it `cover`" from "is it the detail schedule".
