# The close-view sail "film": testing the sheenSpecularDirect lead

## Standing facts, carried in

CONFIRMED: the sails are opaque; coverage, culling and depth holes are excluded
(§87 Test D — the pixels ARE the sail). The apparent transparency is produced by
the sail pixels' own radiance resembling the background: outgoing radiance sits at
0.585 of the radiance behind it, in a similar hue, and a surface matching its
background reads as film.

DISCONFIRMED (§93): correcting the EnvProbe's lower hemisphere does NOT remove the
film — ratio moves at most 2.6% and the hue moves the WRONG way. The EnvProbe fix
is kept because it repairs a separate real lighting defect.

CURRENT LEAD: `sheenSpecularDirect`. §87 found that rendering that accumulator
alone gives a black frame containing exactly the pale streaky patches that read as
"sea through the canvas". **That is a contribution observation, not a cause.**

## What must NOT be done

Not merely darkening the sail. Not solving it through global exposure. Not turning
cloth into a dark tarpaulin. §87 already showed dimming is the wrong axis: a dial
combination reached ratio 0.370 and stopped reading as film, but the crop became a
dark blue tarpaulin and the hue did not move at all (B-R +18.65 -> +20.56).

Desired outcome: opaque cloth, still plausibly lit, but visually separated from the
sea/sky background enough that it no longer reads as translucent film.

## Instrument traps already paid for

1. Assert the lever BINDS, not just that the string was patched (§95's
   `cover <= 0.85` compiled and changed nothing; §97's `return probe` executed but
   moved nothing).
2. Do not select on the outcome (§96 masked on `foam` then "found" foam saturating).
3. Establish a noise floor in a control region the change cannot reach.
4. A change appearing where it is impossible is a measurement bug (§93's inverted
   equirect).
5. A CPU raycast cannot see the sails at all — they are GPU-expanded from a unit
   patch (§90).
6. Stage screenshots outside the Vite root.

## Instrument

`.tmp/sailabl.mjs` — term-by-term ablation of the sail's radiance at the affected
close station (eye 12 fwd / 26 up / 26 to port, aimed at 0/14/0). The sail is a
`MeshPhysicalMaterial`, so the levers are three's own accumulators, inserted after
`#include <lights_fragment_end>` where `sheenSpecularDirect`,
`sheenSpecularIndirect` and the four `reflectedLight` terms are all in scope.

Two things this needed that are worth keeping:

1. **The existing `onBeforeCompile` must be WRAPPED, not replaced.** The sails are
   GPU-expanded from a unit patch by a 16 kB hook; clobbering it breaks the vertex
   expansion.
2. **`customProgramCacheKey()` on this material returns a CONSTANT (`'ship-sail'`).**
   With a constant key three reuses the cached program and never calls
   `onBeforeCompile`, so the first run of every arm was a silent no-op — the hook
   reported "needle seen: false" for all seven arms. The key must vary per arm.
   This is the same class as §95's non-binding clamp, one level further out: the
   patch was correct and never ran.

## Log

(append-only, newest last)

### The lead is refuted: `sheenSpecularDirect` carries 4.5%

Ablating one term at a time. The inert arms establish a recompile noise floor of
about 2 to 2.6 codes whole-frame, because each arm rebuilds the program and resets
TAA history.

| arm | frame delta | sail ratio to sea | B-R | HF |
|---|---|---|---|---|
| base | — | 0.311 | +40 | 1.27 |
| **sheenSpecularDirect = 0** | 2.45 | **0.309** | **+40** | **1.28** |
| sheenSpecularIndirect = 0 | 7.01 | 0.190 | +34 | 1.05 |
| reflectedLight.indirectDiffuse = 0 | 8.08 | 0.161 | +34 | 0.90 |
| reflectedLight.indirectSpecular = 0 | 3.31 | 0.252 | +35 | 1.17 |
| directDiffuse = 0 | 2.03 | 0.305 | +39 | 1.23 |
| directSpecular = 0 | 2.64 | 0.309 | +39 | 1.27 |

And each term rendered ALONE, which is the test §87 used when it nominated the
sheen:

| term alone | sail linear L | share of base | B-R |
|---|---|---|---|
| base, all terms | 0.0774 | 100% | +39 |
| **sheenSpecularDirect only** | **0.0035** | **4.5%** | +3 |
| sheenSpecularIndirect only | 0.0271 | 35% | +27 |
| indirectDiffuse only | 0.0331 | 43% | +27 |
| indirectSpecular only | 0.0118 | 15% | +21 |
| direct only (diffuse+specular) | 0.0035 | 4.5% | +3 |

**`sheenSpecularDirect` is refuted.** Zeroing it moves the ratio by 0.002 and the
hue not at all, and alone it is 4.5% of the sail's radiance — the same floor as the
whole direct path. §87's observation that rendering it alone shows the streaky
patches was a contribution observation on a near-black frame; it does not survive
as a cause.

The sail at this station is **93% image-based lighting**: 43% indirect diffuse,
35% indirect sheen, 15% indirect specular. Note `indirectDiffuse` alone measures
B-R **+27**, i.e. the diffuse term is itself blue — the buff flax albedo is being
swamped by blue environment irradiance.

### The direct path is near zero because the sail is SHADOWED, not because it faces away

Sun direction at this station is (-0.189, 0.952, 0.239) — elevation about 72
degrees, nearly overhead — and a sail is near-vertical, which alone would explain a
small cosine. But turning the sun's shadow casting off changes the sail box by
**16.3 codes**: median RGB (56, 77, 97) -> (84, 94, 104), and the hue WARMS from
B-R +41 to +20. So direct light is available and is being removed by the shadow
term. That is consistent with the `directDiffuse = 0` arm being inert: the light was
already shadowed away.

### And the film's streaky STRUCTURE is the shadow pattern

The direct-light-only render is the informative one. The sails carry **large, soft,
amoeba-shaped dark blobs** — not the clean quadrilateral edges another sail would
cast — while the deck in the same frame shows crisp, plausible mast and rigging
shadows. The pale streaky patches that read as "sea through the canvas" in the base
image coincide with the BRIGHT, unshadowed regions of this render.

So the structure is not a radiance term at all: it is the sail's own shadowing,
blobby and soft-edged on large canvas surfaces. Next: whether that blobbiness is
shadow-map resolution, bias, or cascade fitting — a technical defect — or genuine
sail-on-sail occlusion.
