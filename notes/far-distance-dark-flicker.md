# Far-distance dark patch / flicker (owner P4)

Scope: diagnosis first. No source change until a discriminator isolates a cause.

## The question, kept in three parts deliberately

The owner reports a dark patch and/or flicker at far distance. Before anything
else, establish which of these it is:

- **A. a static dark spatial patch** — dark in a temporal mean, LOW temporal
  variance;
- **B. temporal flicker** — HIGH temporal variance, not necessarily dark on
  average;
- **C. both** — dark in the mean AND high variance.

**A dark static feature must not be called flicker without temporal evidence.**
That is the whole reason this note starts with an instrument rather than a
screenshot.

## Candidate systems, to be separated rather than guessed

far-field ocean / wake · `pxWorld` / footprint-dependent foam · LOD / clipmap
transitions · normal or reflection instability · z-fighting · shadowing ·
exposure / temporal post · TAA history · cloud/ocean interaction.

**One lead, explicitly only a lead.** §95 and §96 refuted the `wThr` footprint
widening as a cause of the NEAR-hull plate, and measured `wThr` pinned at its 0.05
floor in every near band. But `wThr = mix(0.05, 0.5, smoothstep(1.2, 3.5, pxWorld))`
is *designed* to widen at large `pxWorld`, and §96's own ablation showed that
pinning it wide transformed the surrounding foam (`FOAM` sd 14.2 -> 31.5). So it
becomes plausible again at kilometre distances. **The near-field negative must not
be inverted into a far-field conclusion** — it says nothing about the far field
either way.

Related prior art to check before re-deriving: §75 (`§67`'s dead far field, "the
footprint is 3 m by 514 m and `Nlow` was answering with one number"), §76 (earth
curvature and the skirt's hack), and the far-field whitecap block in
`surface.ts` that exists because "past a few hundred metres a full gale rendered
with no whitecaps at all".

## Instrument traps already paid for on this project

1. **Assert the lever binds, not just that the string was patched.** §95's
   `cover <= 0.85` edit compiled and changed nothing because the value never
   reached 0.85.
2. **Do not select on the outcome.** §96's first mask keyed on `foam` itself and
   then "discovered" that foam saturates there.
3. **Establish a noise floor in a control region** that the change cannot reach.
   Two frozen frames of open sea still differed by 3.25 codes from temporal
   residue.
4. **A change appearing where it is impossible is a measurement bug.** An inverted
   equirect convention cost a rebuild in §93.
5. The debug-output trick only replaces the material it is applied to; every other
   object still renders normally and will invert to garbage.
6. Stage screenshots outside the Vite root, or the probe reloads the page it is
   measuring.

## Instrument

TBD — filled in below.

## Log

(append-only, newest last)
