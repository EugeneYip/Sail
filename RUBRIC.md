# Blind critique rubric

How a critic agent judges a frame. The critic is shown images with neutral
labels and **is not told which build produced which**, nor which is newer. It
must commit to a verdict before any reveal.

## Method

1. Look at the sheet. For each pane, write what you actually see — not what you
   expect a sailing game to contain. Describe defects concretely and locate them
   ("horizon at x≈1200 has a 2px stair-step", not "aliasing present").
2. Score each axis below 1–10 for each pane, independently, before comparing.
3. Declare a winner per axis, then overall, and state the single change that
   would most improve the loser.
4. Only then may the key be revealed.

A frame scores **8+ only if a stranger shown it alongside a commercial release
could not tell which was the hobby project.** Reserve 9–10 for frames that would
survive as a marketing screenshot. Be harsh. Most frames are 4–6. Grade
inflation makes this whole exercise worthless — if everything scores 8 the loop
cannot find anything to fix.

## Axes

**1. Light & colour (weight 3)**
Does the light have a believable direction, colour temperature and intensity for
the stated hour? Is there a real shadow/fill ratio, or is everything flatly lit?
At golden hour do direct light and sky fill split warm/cool? Does the grade look
authored, or like raw untonemapped output? Any hue skew in bright highlights
(sky going cyan or magenta is the classic tonemapper failure)? Black level:
crushed, milky, or right?

**2. Water (weight 3)** — it fills most of the frame
Does it read as deep ocean with real depth absorption, or as a blue surface? Are
there waves of multiple scales, or one obvious repeating pattern? Visible tiling?
Do backlit crests glow translucent? Is foam attached to wave structure and
persistent, or flickering noise? Is there specular sparkle/aliasing in the
mid-distance? Is the horizon a clean straight line? Does the water meet the sky
seamlessly or is there a seam?

**3. Sky & atmosphere (weight 2)**
Gradient believable for the hour? Banding? Do clouds have volume, silver lining
and internal shadowing, or are they flat noise? Is there real aerial perspective
— do distant things sit *in* air? Does the sun scatter into the surrounding sky?

**4. The ship (weight 2)**
Correct frigate silhouette (tumblehome, sheer, mast proportion, rake)? Does the
rigging read as a dense web? Do sails look like loaded cloth with camber, or bent
planes? Material believability — does wood look like wood at this distance?
Any z-fighting, gaps, or geometry poking through?

**5. Composition & camera (weight 2)**
Horizon height — dead-centre is a failure. Is the ship well placed (thirds,
leading room)? Anything awkwardly clipped at the frame edge? Does the frame have
a subject, or is it an undifferentiated expanse? Would you stop scrolling on it?

**6. Image quality (weight 2)**
Aliasing on rigging and horizon. Ghosting or smearing (TAA failure). Overall
crispness vs mush. Banding in gradients. Bloom tasteful or a haze over
everything? Is DoF motivated or arbitrary? Grain appropriate or noisy?

**7. Detail density & life (weight 1)**
Does the world feel inhabited and endless, or empty? Is there something on the
horizon worth sailing toward? Anything alive?

**8. Restraint (weight 1)**
Does it look tasteful and confident, or like every effect was turned on to prove
it exists? Over-bloom, over-saturation, over-vignette, HUD too loud — all
subtract. The reference standard here is calm and understated.

## Automatic failures

Any of these caps the frame at 4 regardless of other scores:
- Visible tiling or repetition in the water
- LOD popping or geometry cracks
- Banding in a sky gradient
- Ghosting trails behind a moving object
- The horizon reading as a hard seam between two flat colours
- Anything rendering as an obvious untextured placeholder
- Sub-60 fps at 1600x900 ultra on the reference M2

## Output format

```
PANE LEFT  — observations, then per-axis scores, then weighted total
PANE RIGHT — observations, then per-axis scores, then weighted total
WINNER: <left|right> on <n> of 8 axes. Overall: <left|right>.
TOP 3 FIXES for the loser, most valuable first, each specific enough to act on.
CONFIDENCE: <how sure, and what would change your mind>
```
