# Post-deploy player-reported defects (2026-08-22)

Ground truth is the owner's gameplay screenshots at
https://eugeneyip.github.io/Sail/ . Four open items, worked in the owner's order.

1. **Stern / aft transparency** — the aft structure reads penetrable or incomplete
   from several real angles. Explicitly NOT the sail film; this is the ship's own
   aft geometry.
2. **Straight partition between stern and near wake** — a ruled boundary still
   readable in the real player view, despite §96's ramp-width fix improving the
   general look.
3. **Black flickering blotches when zoomed out** — size appears to vary with
   settings. Player-visible. Note this is NOT the same report as §97's P4 (which was
   a far-distance *dark patch* at a fixed station and did not reproduce); this one is
   zoomed-out and flickering, and the owner sees it in play.
4. **Close-up motion harshness + flat-cut rope ends.**

## Discipline carried in

Use `scripts/measure.mjs` where a number is claimed: fresh load per arm, a control
channel the arm cannot influence, repeats, reject inside control variance. Assert
every lever binds. Distinguish a visible effect from a numerical one. Prior
retractions to respect: §97 (P4 not reproduced), §100 (render-scale magnitude
retracted), §101 (heave chatter invisible), §98/§99 (sail film is IBL, shadow and
sheenSpecularDirect both refuted).

## Log

(append-only, newest last)
