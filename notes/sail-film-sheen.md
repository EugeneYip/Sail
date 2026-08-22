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

TBD

## Log

(append-only, newest last)
