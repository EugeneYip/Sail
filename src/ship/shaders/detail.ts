/**
 * Close-range surface detail, synthesised per pixel in METRES.
 *
 * WHY THIS EXISTS. The baked library in `materials/textures.ts` covers 3.2 m of
 * plank run in 512 texels — 6.3 mm per texel along the run. At a two-metre
 * viewing distance a 1600 px frame resolves 1.2 mm per pixel, so every baked map
 * is being magnified 5.4x and the owner is looking at a bilinear blur of it.
 * That is the whole of "materials are too flat when zoomed in": there is no
 * information in the texture at the scale the eye is working at, and no texture
 * small enough to fix it would still tile a 62 m hull.
 *
 * So the split is by frequency. The baked maps keep the tier that mips well —
 * plank tone, paint fade, chips, patina. Everything finer than about a
 * centimetre is generated here from the surface's own metre coordinates, which
 * has three properties a texture cannot have:
 *
 *   1. it is resolution-independent, so it is as sharp at 0.5 m as at 5 m;
 *   2. it does not repeat with the texture tile;
 *   3. every feature knows its own size in metres, so it can be faded out by
 *      the screen-space derivative before it aliases. Nothing here sparkles in
 *      the mid-distance — the amplitude is gone by the time the pitch reaches
 *      two pixels.
 *
 * All the relief comes back as an analytic slope, never as `dFdx` of a
 * high-frequency function, for the reason set out in `build/sails.ts`: a
 * derivative of noise finer than a pixel is not a normal, it is sparkle.
 *
 * Frame convention, matching the plank UVs the builders emit:
 *   m.x  ALONG the planks, metres
 *   m.y  ACROSS the planks, metres
 *
 * Depends on: GLSL.common (TAU, hash12), GLSL.noise2d (noise2d_d),
 * GLSL.surface (blendNormalRNM).
 */

export const DETAIL_DECL = /* glsl */ `
#ifndef LEEWARD_SHIP_DETAIL
#define LEEWARD_SHIP_DETAIL

/**
 * Antialiased dark line. 'd' and 'halfWidth' are metres, 'aa' is a pixel in
 * metres. A feature narrower than a pixel is widened to a pixel and loses
 * contrast in proportion, so it converges on its own average instead of
 * aliasing — a 6 mm caulk seam stays a crisp black line at arm's length and
 * becomes a faint grey one at eighty metres, which is what it does in life.
 */
float lwDetailLine(float d, float halfWidth, float aa) {
  float w = max(halfWidth, aa);
  return (1.0 - smoothstep(0.0, w, d)) * clamp(halfWidth / w, 0.0, 1.0);
}

/** Amplitude envelope for a feature of the given pitch: gone by ~2 px. */
float lwDetailFade(float pitch, float aa) {
  return clamp(pitch / max(aa * 2.0, 1e-7) - 1.0, 0.0, 1.0);
}

/**
 * The ring figure of a sawn oak board.
 *
 * Rings are level sets of m.y — they run along the plank — bent by two warps:
 * a long gentle sweep and a shorter cathedral figure. Both warps come from
 * 'noise2d_d', so their gradients are exact and the ring phase gradient 'tG'
 * below is exact with them.
 *
 * The profile is a sinusoid with its trough sharpened by a cube, which is what
 * a growth ring actually looks like across the grain: a wide band of soft
 * earlywood and one narrow hard line of latewood at its edge. Holystoning
 * scrubs the soft band away faster, so the latewood stands slightly proud.
 *
 * The result is CENTRED on zero, not on the profile's mean of 0.3125. That is
 * not cosmetic: every tier here fades to zero with distance, so a tier with a
 * non-zero mean would shift the surface's albedo and gloss as the camera pulled
 * back. Centred, the fade is invisible except as a loss of detail.
 *
 *   returns  about -0.31 .. +0.69, positive on the latewood line
 *   g        out: d/dm, per metre — multiply by the relief in metres for a slope
 */
float lwOakRings(vec2 m, float pitch, float phase, float skew, float aa, out vec2 g) {
  float fade = lwDetailFade(pitch, aa);
  // The warp used to run at 0.37 cycles per metre ALONG the plank, so across a
  // 320 mm board it changed by a tenth of a cycle and the rings came out dead
  // straight and dead parallel — a comb, not a board. At 1.15 the cathedral
  // figure turns over about once every board width, which is what a flatsawn
  // plank does, and it is also most of the relief the surface has along the
  // grain rather than across it.
  vec3 w1 = noise2d_d(vec2(m.x * 1.15, m.y * 2.3));
  vec3 w2 = noise2d_d(vec2(m.x * 4.20, m.y * 6.9) + 21.7);
  float warp = w1.x * 1.60 + w2.x * 0.42;
  vec2 warpG = vec2(w1.y * 1.15, w1.z * 2.3) * 1.60
             + vec2(w2.y * 4.20, w2.z * 6.9) * 0.42;

  // 'skew' tilts the rings off the plank's own axis and 'phase' slides them
  // along it. Both are per-board (see lwWoodDetail), and both matter more than
  // they sound: with skew = phase = 0 the ring lines run dead straight, dead
  // parallel and IN PHASE across every seam on the ship, and a laid deck reads
  // as one sheet of corrugated card. The skew also puts real relief ALONG the
  // grain — measured, the slope was 39x stronger across the planks than along
  // them, which is why the lighting only ever broke up in one direction.
  float k = 1.0 / max(pitch, 1e-4);
  float t = (m.y + skew * m.x) * k + warp + phase;
  vec2 tG = vec2(skew * k, k) + warpG;

  float s = sin(TAU * t);
  float e = 0.5 - 0.5 * s;
  float h = e * e * e;
  // dh/dt = 3 e^2 de/dt, de/dt = -0.5 TAU cos(TAU t)
  float dh = -1.5 * TAU * e * e * cos(TAU * t);
  g = dh * tG * fade;
  return (h - 0.3125) * fade;
}

/**
 * The fibre tier: pores, rays and saw marks, elongated 20:1 along the grain.
 *
 * This is the tier that separates timber from painted card at arm's length,
 * and it is also the tier the baked maps lose first — at 6 mm per texel a
 * 1 mm pore is a fifth of a texel, so baking it produced the per-pixel hash
 * that made the old deck normal map read as sandpaper.
 *
 *   returns  roughly -1..1
 *   g        out: d/dm, per metre
 */
float lwFibre(vec2 m, float pitch, float aniso, float aa, out vec2 g) {
  float fade = lwDetailFade(pitch, aa);
  float k = 1.0 / max(pitch, 1e-5);
  float kx = k / max(aniso, 1.0);
  vec3 n = noise2d_d(vec2(m.x * kx, m.y * k) + 7.13);
  g = vec2(n.y * kx, n.z * k) * fade;
  return n.x * fade;
}

/**
 * The FIGURE of a board: medullary rays, colour streaking, scrub and adze marks.
 *
 * This tier exists because of a measurement. At a two-metre viewing distance a
 * 1600 px / 50 degree frame resolves 1.17 mm per pixel, so the Nyquist limit is
 * 2.3 mm and nothing finer can be drawn at all. The fibre tier above is authored
 * at 1.4-2.2 mm, so its own antialiasing fade takes it to EXACTLY ZERO beyond
 * about 1.2 m — probed and confirmed, std of albedo, slope and roughness all
 * 0.0000 at 2 m. The rings sit at 9.5-11 mm and the plank layout at 290-320 mm.
 * That left the band from 5 mm to 290 mm carrying nothing but one perfectly
 * periodic ring sinusoid, and a surface whose only close-range information is a
 * single spatial frequency reads as machined ribbing, not as timber.
 *
 * So: two octaves of anisotropic gradient noise at about 40 mm and 14 mm, which
 * is where oak's figure actually lives, elongated a modest 6:1 rather than the
 * fibre tier's 22:1 because ray fleck is short and chunky where a pore is a long
 * scratch. Being two octaves an eighth of a decade apart, one of them is always
 * inside the resolvable band from arm's length out to about fifteen metres.
 *
 *   returns  roughly -1..1
 *   g        out: d/dm, per metre
 */
float lwGrainFigure(vec2 m, float pitch, float aa, out vec2 g) {
  float k = 1.0 / max(pitch, 1e-5);
  float kx = k / 6.0;
  float f1 = lwDetailFade(pitch, aa);
  float f2 = lwDetailFade(pitch * 0.34, aa);
  vec2 p = vec2(m.x * kx, m.y * k);
  vec3 a = noise2d_d(p + 3.71);
  vec3 b = noise2d_d(p * 2.94 + 19.3);
  // Chain rule: octave 2 samples the same domain scaled by 2.94, so its
  // gradient carries that factor as well as the amplitude weight.
  g = vec2(a.y * kx, a.z * k) * f1
    + vec2(b.y * kx, b.z * k) * (2.94 * 0.42 * f2);
  return a.x * f1 + b.x * 0.42 * f2;
}

/**
 * Everything the ship's timber and painted topsides need at close range, in one
 * pass over the plank frame. Driven entirely by uniforms so all nine material
 * families share one program.
 *
 *   A  (ring pitch m, ring albedo amp, ring relief m, ring roughness amp)
 *   B  (plank pitch m — 0 disables, seam half-width m, seam darkness, fibre relief m)
 *   C  (fibre pitch m, fibre albedo amp, per-plank tone amp, scrub/wear amp)
 *   D  (fibre roughness amp, per-board roughness spread)
 *   E  (figure pitch m — 0 disables, figure albedo amp, figure relief m, figure roughness amp)
 *
 * A metal family sets the ring amplitudes to zero and keeps only the fibre
 * tier, which then reads as the draw marks in rolled sheet or the hammer marks
 * on a forging — the same anisotropic function, doing the same job one tier
 * down. That is why there is no separate metal path and no second program.
 *
 *   alb  out: multiply into albedo
 *   rgh  out: add to roughness
 *   ao   out: multiply into ambient occlusion
 *   g    out: surface slope in the (along, across) frame
 */
void lwWoodDetail(vec2 m, vec4 A, vec4 B, vec4 C, vec2 D, vec4 E,
                  out float alb, out float rgh, out float ao, out vec2 g) {
  // The screen-space derivative is taken OUTSIDE every branch below. A
  // derivative in non-uniform control flow is undefined, and the whole
  // antialiasing story rests on this one value being right.
  vec2 aa = abs(dFdx(m)) + abs(dFdy(m));

  // ---- which board is this? Resolved BEFORE the rings, not after, because the
  // ring figure has to be a property OF the board. B.x is a uniform, so this
  // branch is uniform control flow and safe to sit above the tiers.
  float pf = 0.0;
  float sf = 0.0;
  float plank = 0.0;
  float sect = 0.0;
  if (B.x > 0.0) {
    pf = m.y / B.x;
    plank = floor(pf);
    // Butt joints are staggered per plank so the runs never line up, and the
    // board length is randomised about seven metres.
    float off = hash12(vec2(plank, 3.0)) * 9.0;
    sf = (m.x + off) / (5.6 + 2.4 * hash12(vec2(plank, 11.0)));
    sect = floor(sf);
  }
  // Three decorrelated draws per board: where its rings sit, how close together
  // they are, and how far off the saw ran. An unplanked family (B.x = 0) gets
  // board 0 for all of them, which is the single-billet look a spar should have.
  vec2 bid = vec2(plank, sect);
  float ringPhase = hash12(bid + 41.7);
  float ringPitch = A.x * (0.74 + 0.52 * hash12(bid + 71.3));
  float ringSkew = (hash12(bid + 97.1) - 0.5) * 0.17;

  vec2 gr;
  float ring = lwOakRings(m, ringPitch, ringPhase, ringSkew, aa.y, gr);
  vec2 gf;
  float fib = lwFibre(m, C.x, 22.0, max(aa.x, aa.y), gf);
  vec2 gq;
  float fig = 0.0;
  if (E.x > 0.0) fig = lwGrainFigure(m, E.x, max(aa.x, aa.y), gq);
  else gq = vec2(0.0);

  g = gr * A.z + gf * B.w + gq * E.z;

  // Latewood is denser and darker, and takes a slight sheen where the soft
  // earlywood around it has been scrubbed away.
  alb = 1.0 - A.y * ring + C.y * fib + E.y * fig;
  rgh = -A.w * ring + D.x * fib + E.w * fig;
  ao = 1.0;

  // ---- plank layout: seams across, butt joints along, tone per board
  if (B.x > 0.0) {
    float seamD = min(fract(pf), 1.0 - fract(pf)) * B.x;
    float buttD = min(fract(sf), 1.0 - fract(sf)) * 5.6;

    float seam = lwDetailLine(seamD, B.y, aa.y);
    float butt = lwDetailLine(buttD, B.y * 0.55, aa.x);
    float caulk = max(seam, butt * 0.8);

    // Every board is a different piece of timber.
    float tone = hash12(bid) * 2.0 - 1.0;
    alb *= 1.0 + C.z * tone;
    rgh += D.y * tone;

    alb *= 1.0 - B.z * caulk;
    ao *= 1.0 - 0.55 * caulk;
    rgh += 0.22 * caulk;
    // The seam is a groove, not a painted stripe: slope into it from both
    // sides. sign() of the offset across the plank gives the direction.
    float sSide = sign(fract(pf) - 0.5);
    g.y += sSide * seam * B.y * 9.0;
    g.x += sign(fract(sf) - 0.5) * butt * B.y * 4.0;
  }

  // ---- traffic: scrubbed pale and smooth on the paths, oily at the edges.
  // Wavelengths of two to three metres, so this never repeats with the texture
  // tile and never fades — it is the only tier the eye still reads at 80 m.
  if (C.w > 0.0) {
    float wear = noise2(m * vec2(0.34, 0.55) + 13.7) * 0.5 + 0.5;
    wear *= wear;
    alb *= 1.0 + C.w * (wear - 0.3);
    rgh -= C.w * 0.55 * (wear - 0.3);
  }
}
#endif
`;
