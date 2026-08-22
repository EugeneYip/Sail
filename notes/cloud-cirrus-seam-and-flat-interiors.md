# The sky's ruler-straight streaks were a tiling seam, and cloud interiors were flat because one coefficient was three

Answers the blind critique's items **#4 (flat interiors, seven of eight frames)** and
**#5 (silhouettes give away their construction)**. Both landed. Item (5)'s
sub-items (a) and (b) did **not** share a cause with (c) and are still open —
what is known about them is at the end.

Scope: `src/sky` only. No file outside it was touched.

Frames on this box: `shots/S82-base-{orbit,noon,golden}.png` before,
`shots/S82-after-{orbit,noon,golden,storm,dawn}.png` after. The clearest 1:1 look
at item (c) is the crop `(880,90) 660x250` of the two `noon` frames — the base
has three thin straight lines crossing the right half of it and the after has
none.

---

## Item (c): the "three ruler-straight streaks crossing the whole sky"

The critique: *"three ruler-straight streaks crossing the whole sky, roughly
(0,200)→(417,250) and (0,320)→(375,350), uniform 4–6 px wide, passing behind the
cumulus. Slab layers seen edge-on — you can see the planes."*

It is not the marched volume's slab structure. It is the **cirrus layer**, and
the lines are the **tiling seam of the weather map's cirrus channel**.

### The attribution, three independent steps

All three are on the same frozen frame, camera / sun / field pinned, via
`.tmp/skyab.mjs`. Each ablation asserts its target string was present.

**1. `nocirrus` — the lines are the high layer.** With
`cirrusOpticalDepth` forced to return 0, the streaks vanish and the cumulus is
unchanged. So the low march is not drawing them. They pass *behind* the cumulus
because the cirrus slab is composited after the low march, against the `T` it
has already accumulated.

**2. `swapci` — their direction comes from the weather map's own uv axes.**
Transposing the A-channel fetch to `xz.yx` rotates the entire family 90°. So the
streaks are world-axis-aligned by construction, not by anything in the geometry.

**3. The bake, measured.** `.tmp/S82wx.mjs` reads the baked 512² weather texture
straight off the GPU and reports the A channel's wrapped autocorrelation and its
seam step:

| | shipped | after |
|---|---|---|
| mean \|step\| across the **v** wrap | **0.30646** | 0.00590 |
| mean \|step\| in the v interior | 0.00467 | 0.00575 |
| **ratio** | **65.6×** | **1.0×** |
| same across **u** | 1.1× | 1.0× |
| channel sd, for scale | 0.288 | 0.293 |

A step of 0.31 on a channel whose standard deviation is 0.288 — more than one
sd, in one texel, on one line.

### The cause, and it is one missing `vec2`

```glsl
float ci = tilePerlin2(vec2(p.x * 9.0, p.y * 1.6), 9.0, 4) * 0.5 + 0.5;
```

`tileGrad2` wraps its lattice with `mod(cell, vec2(period))`, so the field is
periodic over uv 0..1 only if the coordinate spans **exactly** `period` on each
axis. Here `x` spans 9 against a period of 9 and tiles correctly; `v` spans 1.6
against a period of 9 and does not close at all.

A discontinuity at constant `v` is a discontinuity at constant **world Z**, i.e.
a dead-straight line running along world X, repeating every
`uWeatherExtent * CLOUD_CIRRUS_MAP_SCALE` = **96 km**. The cirrus is one analytic
shell at 7.6 km, visible out to ~320 km, so **three** wraps fall inside the
visible deck. Parallel lines in world space converge on a vanishing point on
screen, which is the fan the critic drew two segments of; the width is uniform
because it is a one-texel step in a bilinear-filtered map, not a cloud feature.

### The controlled discriminator

Two things were wrong with that line — the non-tiling period *and* a 6.76×
anisotropy — so they were separated before either was blamed.

Setting the periods to `vec2(9,2)` / `vec2(21,4)` **holds the anisotropy and the
streak length** (6.76 → 6.57×; along-streak correlation length 17.17 → 17.76 km)
and **removes only the seam** (65.6× → 1.0×). The ruler-straight hairlines are
gone from the frame at that setting. So the streaks were the seam. The anisotropy
is a separate, smaller matter.

### What shipped

`tileGrad2` / `tilePerlin2` take a `vec2` period; the scalar forms are kept as
one-line overloads, so the other five call sites are untouched and the coverage,
type and precip channels are byte-identical. Cirrus periods are
`vec2(9,4)` / `vec2(21,8)`.

**Non-integer periods are equally fatal, just less visibly.** `mod(cell, 1.6)` on
an integer lattice lands on 0.4, which is not a lattice point, so the hash is
evaluated off-grid and the field is discontinuous *everywhere* rather than on one
line. That is why the along-axis count went to 4 and not to 2.5.

Measured on the bake, shipped → after:

| | before | after |
|---|---|---|
| v seam ratio | 65.6× | **1.0×** |
| anisotropy (ACF v/u) | 6.76× | **2.65×** |
| correlation length along the streak | 17.17 km | **7.33 km** |
| ridge size at the shipped `uCirrusAmount` 0.276 | 2.63 × 11.81 km | **2.44 × 5.44 km** |
| fraction of the map above the threshold | 28.9 % | **28.2 %** |
| channel mean / sd | 0.505 / 0.288 | 0.500 / 0.293 |

The last two rows are the check that matters for the knob: the `gaussCdf`
histogram flattening survived the octave change, so `COVERAGE_SIGMA * 0.85` did
**not** need refitting and `uCirrusAmount` still means the fraction of sky it
says it does.

---

## Item #4: the flat interiors

The critique: *"the cloud mass x 520–1450, y 0–500 is uniform white throughout. No
darker base, no silver lining, no self-shadow. Spilled milk."*

### The instrument, because the statistic is the argument

`skyab.mjs` now measures contrast **inside a cloud body** rather than over a
hand-drawn box:

- the interior mask is the composite's own opacity, `1 - alpha` of the resolved
  RGBA16F buffer, thresholded at 0.90. **Edges are excluded on purpose** — an
  edge is bright for reasons that say nothing about whether the body is shaded.
- connected components on that mask; the largest is "a cloud".
- the **lit/shaded axis is the sun's own azimuth projected into the image plane**,
  from the camera's inverse world matrix, so it is right at any yaw and with the
  sun out of frame. A pixel's coordinate is its signed distance from the
  component centroid along that axis; the flanks are the tails beyond ±0.6 sd.
- **crown/base is per component**, top vs bottom quarter of its own bounding box
  — not an altitude band, for the reason DIAGNOSIS already records about altitude
  slices mixing shallow crowns with deep bases.
- everything is reported twice: in display codes **and in scene-linear radiance
  read straight out of the cloud buffer.** That separation is load-bearing. A
  sunlit cumulus sits at 200/255, high on the AgX shoulder, where a factor of two
  in radiance is worth a handful of codes — so a display-only measurement cannot
  tell "the lighting is flat" from "the grade is flattening it".

Two more instrument changes were needed to make any of it comparable:

- **the field offsets are now pinned.** The three scroll accumulators advance
  from boot on wall-clock dt, so before this the script could only A/B *within*
  one page and a before/after across a source edit was measuring the weather.
- **`env.sunDirection` is pinned.** It is written by the **weather** module, not
  by Sky, so re-asserting `timeOfDay` after the freeze does not recompute it and
  `sunY` still drifted 0.6097–0.6179 across runs.

### The baseline, measured

Largest interior component, 52 351 half-res texels ≈ 210 000 full-res pixels,
`orbit` env, camera pinned at pitch 14:

| | value |
|---|---|
| display L p10 / p50 / p90 | 176.7 / 201.4 / 208.5 |
| display spread (p90−p10)/p50 | 15.8 % |
| display lit vs shaded | 202.2 / 186.3, ΔL **16.0**, ratio **1.086** |
| display crown vs base | 205.0 / 194.8, ΔL **10.2**, ratio **1.052** |
| **scene-linear** lit / shaded | 3.274 / 2.075 = **1.578** |
| **scene-linear** crown / base | 3.103 / 2.634 = **1.178** |

And on the second, compact body: **scene-linear lit / shaded = 0.964.** The
shaded flank was *brighter* than the lit flank. The critic was being generous.

### Attribution: one term of `cloudScatteredRadiance` removed at a time

Same frozen frame, body0:

| ablation | linear lit/shaded | linear crown/base | display ΔL lit−shaded |
|---|---|---|---|
| shipped | 1.578 | 1.178 | 16.0 |
| `noms` — multiple-scattering octaves off | 1.325 | **1.913** | 3.8 |
| `nopowder` — powder factor forced to 1 | 1.827 | 1.255 | 24.1 |
| `hardk` — flat k 0.19 → 0.75 | 1.891 | 1.329 | 28.0 |

`noms` is the diagnostic. With the octaves off, the crown/base gradient is
**1.913**; with them on it is **1.178**. The octaves carry ~80 % of the signal and
were erasing the depth gradient they exist to soften.

Two causes, both in the octave loop.

**1. The two-stream coefficient was one flat number for three different octaves.**
`T = 1/(1 + k τ)` with `k = 0.19`, which is `0.75 (1 − 0.75)` — the asymmetry of
the **first** Mie scatter. But each octave stands in for a later scattering order
and carries its own eccentricity: the loop's `c` decays 1, 0.6, 0.36, 0.216 and
the phase uses `g = 0.82 c`, so the right `k` **rises** with octave order — 0.38,
0.53, 0.62. A flat 0.19 under-attenuated all three by two to three times.
Integrating the shipped loop by hand: the sun term ran **2.81 at τ = 2, 2.57 at
τ = 8, 0.76 at τ = 71** — under a factor of four across two decades of optical
depth, and **non-monotonic** below τ ≈ 8. A sample buried 70 optical depths from
the sun received three quarters of what a sample one optical depth in received.
That is the flat interior, exactly.

**2. Beer's-powder was applied at twice its own value.**
`mix(1.0, 2.0 * powder, powderMix)` with `powder = 1 − exp(−2τ)` tends to **2.0**
as τ grows. That is not a dark-rim term; it is a 2× gain on everything optically
thick, with a rolloff only at the thin edges. And it is blended in by view–light
angle, so **the 2× lands on the anti-solar side** — it was brightening precisely
the flank it was added to darken. That is why the compact body came back
inverted at 0.964.

**3. The level, and why it needed its own constant.** Correcting (1) removes 35 %
of the cloud's radiance. `CLOUD_MULTISCATTER_GAIN` is the constant whose job is
that level — but it was **shared** with `Radiometry`'s cloud *ambient* gain
(`0.25 * CLOUD_MULTISCATTER_GAIN`), and the ambient path runs no octaves at all,
so raising it would have lifted the ambient floor by the same 44 % and made the
contrast fix pay for itself. Split: `CLOUD_OCTAVE_GAIN = 6.5` for the shader,
`CLOUD_MULTISCATTER_GAIN = 4.5` for the ambient, numerically unchanged.

### The result

Measured against the **landed source** with the inverse ablation (`oldlight`
puts back the flat k, the doubled powder and the 4.5 gain, and asserts all three
applied). One page, identical field, camera and sun. Body0, 52 400 half-res
texels ≈ 210 000 full-res pixels:

| body0 | `oldlight` — before | landed | |
|---|---|---|---|
| **scene-linear lit / shaded** | 3.286 / 2.083 = **1.578** | 3.188 / 1.520 = **2.097** | **+33 %** |
| **scene-linear crown / base** | 3.122 / 2.636 = **1.185** | 2.975 / 2.271 = **1.310** | **+11 %** |
| **scene-linear p90 — the top end** | 3.542 | **3.532** | **−0.3 %** |
| display ΔL lit − shaded | 16.4 | **32.4** | ×1.98 |
| display ΔL crown − base | 10.8 | **17.5** | ×1.62 |
| display spread (p90−p10)/p50 | 17.7 % | **25.7 %** | ×1.45 |
| body1 scene-linear lit / shaded | **0.973** | **1.133** | sign corrected |

The p90 row is the point: **the top end is preserved to 0.3 %**, so this is a
contrast change and not a darkening. It does not dim the clouds and then let
auto-exposure lift the sea and the ship to compensate.

An independent earlier run in the forward direction (`new` vs `both65`, before
the fix was landed, natural sun) gave 1.578 → 2.102, 1.178 → 1.309, p90 3.534 →
3.525. Same three numbers to within 0.4 %.

### The ordering control, because the display columns needed one

Auto-exposure's adaptation state carries over between variants inside one page
and does not re-converge in 90 frames, so the same A/B was run **both ways**:

- `oldlight` then `new`: display ΔL 23.3 → **33.5**, and p50 186.1 → 156.0.
- `new` then `oldlight`: display ΔL 32.4 → 16.4, and p50 207.7 → 184.4.

**Whichever shader runs second comes out globally darker.** So the level shift is
a sequencing artefact and not the edit — while the contrast increase survives the
flip and points the same way in both orders. The scene-linear columns are read
pre-exposure and are immune to all of this; they are the ones to quote.
(The forward run also had a fabricated sun azimuth — see the instrument note at
the end — so only the direction of its result is usable, not its absolute values.)

### Total mass: the coverage calibration provably did not move

The lighting fix does not touch `cloudDensity`, and the shadow pass never calls
`cloudScatteredRadiance`, so `CLOUD_COLUMNS_PER_RAY`'s calibration cannot walk
backwards. Measured rather than argued — the resolved buffer's own opacity, same
frozen frame, over 162 400 cloud-buffer texels:

| | shipped | `powder1` | `k2` | `both65` |
|---|---|---|---|---|
| mean opacity | 0.2754 | 0.2754 | 0.2754 | 0.2752 |
| fraction > 0.5 | 20.04 % | 20.04 % | 20.05 % | 20.04 % |
| fraction > 0.9 | 15.99 % | 15.99 % | 15.98 % | 15.97 % |

And the same again in the landed-source pair: `oldlight` 0.2853 / 19.87 % /
15.88 % against the landed 0.2855 / 19.88 % / 15.90 %.

Across the whole change including the cirrus bake, the low deck is
`frac>0.5` 19.81 → 19.88 % and `frac>0.9` 15.88 → 15.89 %. Mean sky opacity rose
0.206 → 0.285, and all of that is thin cirrus: it is a different *realisation* of
the cirrus field, not more of it — the fraction of the weather map above the
cirrus threshold went 28.9 → 28.2 %.

---

## What is still not good enough

**The interiors are better, not good.** Display lit/shaded is 1.22 — a 22 % tonal
difference across a cloud body where a real cumulus at this sun elevation shows
two to four times. The remaining ceiling looks structural, and both halves of it
cost per-pixel budget, which is the side with no room:

- `cloudLightDepth` samples the field with `detail = false`, so the 200–600 m
  cauliflower lobes the view march carves **cast no shadow on each other**.
  Worth noting for whoever picks this up: the lobe term is
  `base.b * 0.62 + base.a * 0.38`, and that texel is **already fetched** for
  `lowFbm`. Applying the lobe half of the erosion when `detail == false` would
  cost no extra texture fetch — but it changes the density the shadow map sees,
  so it is a coverage-adjacent change and needs its own mass proof.
- the view march's step caps at `DT_MAX = 1.2 km`, so the first optical depth of
  a cloud along the view ray — which is nearly all of what the pixel shows — is
  resolved by one or two samples.

**The cirrus A/B is not the same field with the lines removed.** The fix is in a
baked texture, which an in-page shader ablation cannot reach, so the before/after
is a different cirrus realisation under an identical camera, sun and low deck. The
crop pair shows the *class* of artefact disappearing rather than the same streaks
moving. That is the honest limit of this instrument on a baked texture, and it is
why the controlled discriminator above was worth running.

**Cirrus is still locked to the world axes.** The streaks run along world Z for
ever, whatever the wind does, because the anisotropy is baked into a static
texture in world XZ. Rotating the lookup by `uWindDir` inside
`cirrusOpticalDepth` would fix it for two multiplies — but note the hazard:
`uCirrusOffset` and `uFieldOffset` are wrapped to `CLOUD_WEATHER_EXTENT_M`
(48 km) while the cirrus lookup divides by 96 km, so **the cirrus field already
teleports by half a period every few hours** when that wrap fires, and a rotation
would turn that half-period jump into an arbitrary one. Both are one session;
neither is what the critique saw.

## Three instrument findings, one of which invalidated a column of my own results

**1. `world.uniforms.uExposure` is a CPU estimate and must not be quoted as the
applied exposure.** `AutoExposure.ts` says so in as many words — "do not
calibrate anything against it" — and I read it anyway. It reported +0.5 % for a
variant pair in which **738 856 clear deep-blue sky pixels darkened by 10.0 %**,
and +0.07 % for another pair that darkened **21.0 %**. Clear sky comes from the
sky-view LUT and cannot be touched by a cloud-shading edit, so that was the tell.
The real value is `world.ext.post.exposure`, read back from the GPU's own 1×1
adaptation buffer; `skyab.mjs` now prints both, labelled.

**2. Auto-exposure state carries across variants inside one page and does not
re-converge in 90 frames.** `clouds.invalidate()` resets the cloud history and
nothing resets the exposure. Proven by running the same A/B both ways: whichever
shader ran second came out globally darker. **Every display-code level
comparison across variants in a single `skyab.mjs` run is confounded**, which is
why this note leads with scene-linear radiance read out of the cloud buffer.
Contrast ratios survive the flip; absolute levels do not.

**3. Do not invent a sun vector to pin a known elevation.** `env.sunDirection` is
written by the *weather* module, not by Sky, so re-asserting `timeOfDay` after
the freeze does not recompute it — but the fix I first wrote kept the measured
`sunY` and made up the horizontal pair, which put a 15.6 h sun in the **east**
and flipped every lit flank in the frame. `skyab.mjs` now prints all three
components so the value can be pinned by copy-paste from an observed run.

## Other things that could not be verified

**Cost was not measured, and no timing is quoted.** `capture.mjs` flagged
contention on every run of this session. Both lighting edits are ALU-only inside
an existing loop — the two-stream term adds one multiply-add per octave and the
powder change removes a multiply — and the cirrus change is bake-time with zero
runtime cost. `check-shaders` links 42/42 programs; `npm run typecheck` is clean.

---

## Items (a) and (b): the brief's hypothesis did not hold

The brief guessed the bottom cut and the stair-steps might share a cause with the
streaks — that the march was aliasing against its own slab structure. It does
not: (c) is a baked-texture seam in a layer that is not marched at all.

What is known, and it is thin:

- **(a) the "700 px dead-straight bottom cut".** Still present after this change
  — visible in `shots/S82-after-noon.png` at y ≈ 300–320 across x 880–1550. Two
  candidates not yet separated: cloud bases genuinely converging on the horizon
  (a real cumulus field does show a flat base, so some of this is correct), and
  the march's own reach — `seg` is capped at 55 km and `DT_MAX` brings the real
  reach to ~42 km, which puts a hard floor of about 1.7° on how low a cloud base
  can appear and would draw a straight line at exactly that elevation. The second
  is testable by raising the cap and watching the line move.
- **(b) the "10–16 px stair-step blocks".** The one candidate tested was the
  march's step cap, on the grounds that once the geometric growth reaches
  `DT_MAX` the steps are *uniform*, and uniform sample distances paint
  evenly-spaced iso-range shells. Halving `DT_MAX` to 0.6 km left the cloud's
  scene-linear radiance identical to four decimal places — **but that run was on
  `golden` at pitch 8, a solid overcast, which is the wrong view: it contains no
  ribbed cumulus face.** The ablation proves nothing about (b) and the test needs
  redoing on a view that actually shows the ribs.
- The haze cull (`hazeColumnTau > HAZE_CULL_TAU`, which returns "no cloud" below a
  fixed elevation and is therefore a straight horizontal line by construction) is
  **inert** at golden's 26 km visibility: with it off, the cloud's scene-linear
  radiance is unchanged to four decimals. So it is not (a), at least not there.
