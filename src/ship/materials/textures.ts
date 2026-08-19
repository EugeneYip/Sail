/**
 * The ship's procedural texture library.
 *
 * Every map is generated in a single CPU pass at init; there are no image
 * files anywhere in the project. Each family produces three textures:
 *
 *   map        sRGB albedo
 *   normalMap  tangent-space normal, derived from the same pass's height field
 *   ormMap     R = ambient occlusion, G = roughness, B = metalness
 *
 * That ORM packing is exactly what three's aoMap / roughnessMap / metalnessMap
 * read (.r / .g / .b), so one texture drives all three.
 *
 * UV convention for plank materials: u runs ALONG the planks, v ACROSS them,
 * with four planks per tile. The hull and deck builders emit UVs in metres
 * divided by the tile size, so plank runs follow the hull's own lines.
 */

import * as THREE from 'three';
import { clamp01, fbm, lattice, mix, ridged, smoothstep, worleyCell } from './noise';

export interface Px {
  /** sRGB albedo 0..1. */
  r: number;
  g: number;
  b: number;
  /** Height for the derived normal map, arbitrary units. */
  h: number;
  rough: number;
  ao: number;
  metal: number;
}

export interface TexSet {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  ormMap: THREE.Texture;
  normalScale: number;
}

const TEXTURES: THREE.Texture[] = [];

function bake(size: number, normalStrength: number, fn: (u: number, v: number, px: Px) => void): TexSet {
  const alb = new Uint8Array(size * size * 4);
  const orm = new Uint8Array(size * size * 4);
  const hgt = new Float32Array(size * size);
  const px: Px = { r: 0.5, g: 0.5, b: 0.5, h: 0.5, rough: 0.6, ao: 1, metal: 0 };

  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      px.r = 0.5; px.g = 0.5; px.b = 0.5; px.h = 0.5; px.rough = 0.6; px.ao = 1; px.metal = 0;
      fn(u, v, px);
      const i = y * size + x;
      alb[i * 4] = clamp01(px.r) * 255;
      alb[i * 4 + 1] = clamp01(px.g) * 255;
      alb[i * 4 + 2] = clamp01(px.b) * 255;
      alb[i * 4 + 3] = 255;
      orm[i * 4] = clamp01(px.ao) * 255;
      orm[i * 4 + 1] = clamp01(px.rough) * 255;
      orm[i * 4 + 2] = clamp01(px.metal) * 255;
      orm[i * 4 + 3] = 255;
      hgt[i] = px.h;
    }
  }

  // Sobel the height field into a tangent-space normal map.
  const nrm = new Uint8Array(size * size * 4);
  const at = (x: number, y: number) => hgt[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx =
        at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) -
        at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1);
      const dy =
        at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) -
        at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1);
      let nx = -dx * normalStrength;
      let ny = -dy * normalStrength;
      const nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l;
      ny /= l;
      const i = (y * size + x) * 4;
      nrm[i] = (nx * 0.5 + 0.5) * 255;
      nrm[i + 1] = (ny * 0.5 + 0.5) * 255;
      nrm[i + 2] = (nz / l * 0.5 + 0.5) * 255;
      nrm[i + 3] = 255;
    }
  }

  const mk = (data: Uint8Array, srgb: boolean): THREE.DataTexture => {
    const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 8;
    t.needsUpdate = true;
    TEXTURES.push(t);
    return t;
  };

  return { map: mk(alb, true), normalMap: mk(nrm, false), ormMap: mk(orm, false), normalScale: 1 };
}

export function disposeTextures(): void {
  for (const t of TEXTURES) t.dispose();
  TEXTURES.length = 0;
}

/* ------------------------------------------------------------------ *
 *  Shared building blocks
 * ------------------------------------------------------------------ */

const PLANKS_PER_TILE = 4;

/**
 * THE UV CONTRACT. One tile of any plank map covers this many metres of
 * surface, (along the plank run, across it).
 *
 * This constant is load-bearing in three places and it used to be written out
 * by hand in all three, which is how they came to disagree:
 *
 *   - the builders divide real distances by it to emit UVs (`MeshBuilder.uvTile`);
 *   - `makeShipMaterial` multiplies UVs back by it to recover METRES, which is
 *     the only frame in which `shaders/detail.ts` can hold a 9.5 mm growth ring
 *     or a 3 mm caulk seam at a fixed physical size;
 *   - `PLANKS_PER_TILE` above divides `TILE_ACROSS` into planks, so the baked
 *     seam and the shader's crisp caulk core have to land at the same pitch or
 *     they draw two sets of seams a few centimetres apart.
 *
 * Measured before it was centralised (`.tmp/uvscale.mjs`, area-weighted ratio of
 * metres-per-UV to this tile, 1.00 = exact): deck 1.00/2.08, oak 0.51/1.21,
 * iron 0.30/0.71, brass 0.35/0.76. Every primitive in `Builder.ts` emitted raw
 * METRES and several `grid` call sites emitted raw grid INDEX, so 1444 m2 of the
 * ship — including every spar and all the deck furniture the helm camera is two
 * metres from — was drawing its grain 3.2x too fine along and 1.28x too fine
 * across, which put it below the antialiasing fade and erased it.
 */
export const TILE_ALONG = 3.2;
export const TILE_ACROSS = 1.28;
/** Deck/hull plank pitch implied by the tile. 280 mm — eleven inches. */
export const PLANK_PITCH_M = TILE_ACROSS / PLANKS_PER_TILE;

/**
 * Texels a cycle must occupy for the map to actually carry it.
 *
 * A lattice period of P puts one cycle in `size / P` texels. Below about four,
 * the cycle stops being a cycle: it averages to flat in the very first mip, and
 * — the part that cost us the deck — the Sobel pass turns it into a normal map
 * of pure per-texel sandpaper. The old `oakGrain` asked for a ridged base
 * period of 110 across v with three octaves, i.e. 440 cycles in 512 texels,
 * 1.2 texels per cycle; measured, the deck's baked normal had a high
 * neighbour-difference and no structure whatsoever.
 *
 * So this library now owns only the tier it can carry — figure, paint fade,
 * chips, patina, plank tone — and everything finer than roughly a centimetre is
 * synthesised per pixel from the surface's metre coordinates in
 * `shaders/detail.ts`, where it can be resolved at any distance and faded out
 * by the screen-space derivative before it aliases.
 */
const TEXELS_PER_CYCLE = 4;

/** Largest base period a `size`-texel map can carry with `octaves` doublings. */
function cap(size: number, octaves: number): number {
  return Math.max(2, Math.floor(size / (TEXELS_PER_CYCLE * 2 ** (octaves - 1))));
}

/** `fbm` with every period clamped to what the map can resolve. */
function fbmC(
  size: number, u: number, v: number, perX: number, perY: number, octaves: number, seed: number,
): number {
  const c = cap(size, octaves);
  return fbm(u, v, Math.min(perX, c), Math.min(perY, c), octaves, seed);
}

interface PlankInfo {
  /** Plank row index within the tile. */
  row: number;
  /** 0..1 across the plank. */
  across: number;
  /** Distance to the nearest caulked seam, 0 at the seam. */
  seam: number;
  /** Butt-joint section index along the plank. */
  sect: number;
  /** Distance to the nearest butt joint. */
  butt: number;
  /** Per-plank-section tonal jitter, -1..1. */
  tone: number;
}

function plankLayout(u: number, v: number, seed: number, sectionsPerTile: number, out: PlankInfo): void {
  const pv = v * PLANKS_PER_TILE;
  out.row = Math.floor(pv);
  out.across = pv - out.row;
  out.seam = Math.min(out.across, 1 - out.across);
  // Stagger the butt joints per plank row so the runs never line up.
  const off = lattice(out.row, 3, seed) * 0.9;
  const pu = (u + off) * sectionsPerTile;
  out.sect = Math.floor(pu);
  const su = pu - out.sect;
  out.butt = Math.min(su, 1 - su);
  out.tone = lattice(out.row, out.sect, seed + 31) * 2 - 1;
}

const _pl: PlankInfo = { row: 0, across: 0, seam: 1, sect: 0, butt: 1, tone: 0 };
const _cell = { d: 0, r: 0 };

/**
 * White-oak FIGURE — the tier above the grain.
 *
 * The grain proper (growth rings at 9-11 mm, pores at 1.5 mm) is now generated
 * per pixel in `shaders/detail.ts`, so what is left for the map is what the map
 * can actually carry over 3.2 m of plank: the broad cathedral sweep of a
 * flat-sawn board, sapwood streaks, and colour drift along the run. Every
 * period below is a decimetre or coarser and survives two mip levels intact.
 *
 * Returns roughly -0.5..0.5, zero-mean.
 */
function oakFigure(u: number, v: number, seed: number, size: number): number {
  // The sweep bends the streaks the way the saw met the log.
  const sweep = fbmC(size, u, v, 3, 7, 3, seed + 5) - 0.5;
  const streak = fbmC(size, u + sweep * 0.07, v, 6, 22, 2, seed + 17) - 0.5;
  // Quartersawn oak throws short bright flecks of ray tissue across the grain.
  // 0.33 is the mean of `ridged`, subtracted so the figure stays zero-mean —
  // every base value in this file is calibrated on that.
  const c2 = cap(size, 2);
  const ray = ridged(u, v, Math.min(11, c2), Math.min(30, c2), 2, seed + 41) - 0.33;
  return sweep * 0.62 + streak * 0.78 + ray * 0.30;
}

/* ------------------------------------------------------------------ *
 *  Families
 * ------------------------------------------------------------------ */

/**
 * Bare / oiled white oak planking — used for spars, boats and furniture.
 *
 * Every base value below is the old base plus the old mean of `oakGrain` (0.28
 * of its amplitude), because `oakFigure` is zero-mean where `oakGrain` was not.
 * The point of the arithmetic is that the ship's overall value does not move:
 * only the distribution of detail within it does.
 */
export function makeOak(size = 512): TexSet {
  return bake(size, 2.2, (u, v, p) => {
    plankLayout(u, v, 11, 2, _pl);
    const fig = oakFigure(u, v, 11, size);
    let l = 0.456 + fig * 0.22 + _pl.tone * 0.045;

    worleyCell(u, v, 7, 23, _cell);
    const knot = _cell.r < 0.13 ? smoothstep(0.16, 0.02, _cell.d) : 0;
    l = mix(l, 0.2, knot * 0.85);

    const seam = smoothstep(0.03, 0.0, _pl.seam) + smoothstep(0.035, 0.0, _pl.butt) * 0.8;
    l = mix(l, 0.13, clamp01(seam));

    // Oil soaks into the open pores and dries out on the exposed faces, so the
    // gloss varies over decimetres as well as over the grain.
    const oil = fbmC(size, u, v, 5, 12, 3, 137) - 0.5;

    p.r = l * 1.09;
    p.g = l * 0.93;
    p.b = l * 0.72;
    p.h = fig * 0.55 - clamp01(seam) * 1.1 - knot * 0.5 + _pl.tone * 0.06;
    p.rough = 0.654 + fig * 0.2 + oil * 0.26 + knot * 0.1;
    p.ao = 1 - clamp01(seam) * 0.55 - knot * 0.25;
    p.metal = 0;
  });
}

/**
 * Weathered black hull paint over the oak grain. Chipping reveals grey
 * primer and bare wood; salt streaks run down the topsides.
 */
export function makeHullBlack(size = 512): TexSet {
  return bake(size, 2.6, (u, v, p) => {
    plankLayout(u, v, 11, 2, _pl);
    const fig = oakFigure(u, v, 11, size);

    // Paint sits on the wood: the figure still telegraphs through.
    //
    // This map is tagged sRGB, so 'l' is an encoded value. Lamp-black oil paint,
    // weathered, has a linear reflectance around 0.02 — sRGB ~0.16. The earlier
    // 0.052 here decoded to 0.004 linear, darker than black velvet, which is
    // what flattened the topsides into a silhouette with no form in them: at
    // that albedo neither the plank grain nor the sheer can show at all.
    let l = 0.143 + fig * 0.05 + _pl.tone * 0.014;
    // Broad patchy fade from sun and salt.
    const fade = fbmC(size, u, v, 5, 5, 3, 71);
    l += fade * 0.045;

    // Chips: small worley cells that break through to primer/oak.
    worleyCell(u, v, 26, 41, _cell);
    const chip = _cell.r < 0.1 ? smoothstep(0.28, 0.06, _cell.d) : 0;
    const chipDeep = _cell.r < 0.04 ? smoothstep(0.2, 0.04, _cell.d) : 0;

    // Salt streaking: thin in u, long in v — i.e. running down the side. 90
    // cycles along u was 1.4 texels per cycle at the third octave and came out
    // as vertical hash; 28 with two octaves is 4.6 and reads as streaks.
    const streak = clamp01((fbmC(size, u, v, 28, 3, 2, 133) - 0.5) * 3.2);
    const salt = streak * smoothstep(0.35, 0.75, fbmC(size, u, v, 6, 3, 2, 211));

    const seam = smoothstep(0.028, 0.0, _pl.seam) * 0.8 + smoothstep(0.03, 0.0, _pl.butt) * 0.5;
    l = mix(l, 0.12, clamp01(seam));

    let r = l;
    let g = l;
    let b = l * 1.03;
    // Primer grey, then bare oak in the deepest chips.
    r = mix(r, 0.3, chip * 0.55); g = mix(g, 0.29, chip * 0.55); b = mix(b, 0.28, chip * 0.55);
    r = mix(r, 0.42, chipDeep * 0.7); g = mix(g, 0.34, chipDeep * 0.7); b = mix(b, 0.24, chipDeep * 0.7);
    // Salt bloom.
    r = mix(r, 0.62, salt * 0.4); g = mix(g, 0.63, salt * 0.4); b = mix(b, 0.61, salt * 0.4);

    p.r = r; p.g = g; p.b = b;
    p.h = fig * 0.4 - clamp01(seam) * 1.2 - chip * 0.5 + salt * 0.1;
    // Weathered oil paint is satin at best. At the old 0.36 the topsides worked
    // as a near-mirror for a deep blue sky and the hull read slate-blue instead
    // of black — the specular was carrying more of the pixel than the albedo.
    //
    // The 'dull' term is what actually gives the topsides form at close range:
    // fresh paint holds a sheen and weathered paint chalks, in patches a
    // hand's-breadth across, and that variation reads long before the albedo
    // does on a surface this dark.
    const dull = fbmC(size, u, v, 9, 16, 3, 353) - 0.5;
    p.rough = 0.58 + fade * 0.14 + dull * 0.3 + chip * 0.24 + salt * 0.16;
    p.ao = 1 - clamp01(seam) * 0.4 - chip * 0.15;
    p.metal = 0;
  });
}

/** The white/buff gunport stripe — same oak underneath, brighter paint. */
export function makeStripeWhite(size = 512): TexSet {
  return bake(size, 2.4, (u, v, p) => {
    plankLayout(u, v, 11, 2, _pl);
    const fig = oakFigure(u, v, 11, size);
    const fade = fbmC(size, u, v, 5, 5, 3, 71);
    // Lead white in oil, weathered — a warm off-white, not paper. At 0.76 the
    // stripe was the brightest surface in the frame, brighter than the sunlit
    // canvas, which is what made the hull read as two-tone graphics rather than
    // a black ship with one painted band on it.
    let l = 0.673 + fig * 0.075 + _pl.tone * 0.018 - fade * 0.075;

    worleyCell(u, v, 24, 61, _cell);
    const chip = _cell.r < 0.11 ? smoothstep(0.26, 0.05, _cell.d) : 0;
    // Powder streaks running down from the gunport sills.
    const grime = clamp01((fbmC(size, u, v, 24, 4, 2, 307) - 0.45) * 2.6);

    const seam = smoothstep(0.026, 0.0, _pl.seam) * 0.9 + smoothstep(0.03, 0.0, _pl.butt) * 0.5;
    l = mix(l, 0.5, clamp01(seam));
    l = mix(l, 0.44, grime * 0.5);

    p.r = mix(l * 1.0, 0.4, chip * 0.6);
    p.g = mix(l * 0.965, 0.33, chip * 0.6);
    p.b = mix(l * 0.855, 0.24, chip * 0.6);
    p.h = fig * 0.36 - clamp01(seam) * 1.2 - chip * 0.5;
    const dull = fbmC(size, u, v, 9, 15, 3, 359) - 0.5;
    p.rough = 0.44 + fade * 0.16 + dull * 0.26 + chip * 0.28 + grime * 0.2;
    p.ao = 1 - clamp01(seam) * 0.4 - chip * 0.15;
  });
}

/** Ochre-buff paint for the inboard bulwarks. */
export function makeBuff(size = 256): TexSet {
  return bake(size, 2.0, (u, v, p) => {
    plankLayout(u, v, 13, 2, _pl);
    const fig = oakFigure(u, v, 13, size);
    const fade = fbmC(size, u, v, 5, 5, 3, 91);
    let l = 0.617 + fig * 0.09 + _pl.tone * 0.03 - fade * 0.07;
    const seam = smoothstep(0.03, 0.0, _pl.seam) * 0.9;
    l = mix(l, 0.4, clamp01(seam));
    const grime = clamp01((fbmC(size, u, v, 20, 5, 2, 401) - 0.48) * 2.4);
    l = mix(l, 0.34, grime * 0.45);
    p.r = l * 1.06;
    p.g = l * 0.88;
    p.b = l * 0.53;
    p.h = fig * 0.34 - clamp01(seam) * 1.0;
    const dull = fbmC(size, u, v, 8, 14, 3, 367) - 0.5;
    p.rough = 0.5 + fade * 0.16 + dull * 0.24 + grime * 0.2;
    p.ao = 1 - clamp01(seam) * 0.4;
  });
}

/**
 * Holystoned, oiled deck planking with caulked seams and traffic wear.
 *
 * The caulk here is deliberately WIDER and SOFTER than a real seam. The crisp
 * 3 mm black core is drawn per pixel in `shaders/detail.ts`, at the same phase
 * (both derive from v, and the shader's plank pitch of 0.32 m is exactly
 * `TILE_ACROSS / PLANKS_PER_TILE`), with `fwidth` antialiasing. What the map
 * contributes is the pitch bleed and dirt on either side of it — a feature that
 * is a decimetre wide and mips correctly, unlike the 14 mm hard-edged band that
 * used to be here and aliased into a dotted line at any distance.
 */
export function makeDeck(size = 512): TexSet {
  return bake(size, 2.8, (u, v, p) => {
    plankLayout(u, v, 17, 3, _pl);
    const fig = oakFigure(u, v, 17, size);
    const traffic = fbmC(size, u, v, 4, 4, 3, 151);
    let l = 0.528 + fig * 0.17 + _pl.tone * 0.05;
    // Scrubbed pale where feet go, darker and oilier at the edges.
    l += (traffic - 0.5) * 0.13;

    worleyCell(u, v, 9, 71, _cell);
    const knot = _cell.r < 0.1 ? smoothstep(0.14, 0.02, _cell.d) : 0;
    l = mix(l, 0.24, knot * 0.8);

    // Pitch bleed either side of the seam, soft-edged so it mips.
    const bleed = smoothstep(0.055, 0.014, _pl.seam) * 0.55
                + smoothstep(0.028, 0.006, _pl.butt) * 0.4;
    const caulk = clamp01(bleed);

    // Sand and salt ground into the softwood, and oil standing in the low spots.
    const oil = fbmC(size, u, v, 7, 18, 3, 157) - 0.5;

    p.r = mix(l * 1.02, 0.09, caulk);
    p.g = mix(l * 0.93, 0.082, caulk);
    p.b = mix(l * 0.76, 0.078, caulk);
    p.h = fig * 0.52 - caulk * 0.9 - knot * 0.4 + _pl.tone * 0.1;
    // Holystoning leaves the deck matte where it is walked and the oil sits in
    // the sheltered runs, so roughness has to carry as much variation as albedo
    // does. Measured, the old ORM had a standard deviation of 0.017 at close
    // range — visually a constant.
    p.rough = 0.55 + fig * 0.16 + oil * 0.3 - traffic * 0.1 + caulk * 0.2;
    p.ao = 1 - caulk * 0.5 - knot * 0.2;
  });
}

/** Oxidised copper sheathing: plates with lapped seams and patchy patina. */
export function makeCopper(size = 256): TexSet {
  return bake(size, 3.2, (u, v, p) => {
    // 4 plate courses across the tile, 3 plates along it.
    const pv = v * 4;
    const row = Math.floor(pv);
    const av = pv - row;
    const pu = (u + row * 0.5) * 3;
    const col = Math.floor(pu);
    const au = pu - col;

    const lapV = smoothstep(0.1, 0.0, av) + smoothstep(0.9, 1.0, av) * 0.7;
    const lapU = smoothstep(0.05, 0.0, au) + smoothstep(0.95, 1.0, au) * 0.6;
    const lap = clamp01(lapV + lapU * 0.8);

    // Each plate was tacked on by hand out of a different batch of sheet, so
    // plate-to-plate tone is the strongest signal on a coppered bottom — much
    // stronger than any within-plate detail. At 0.03 it was invisible.
    const tone = lattice(row, col, 5) * 2 - 1;
    const patina = fbmC(size, u, v, 7, 7, 4, 313);
    // 30x14 with three octaves was 2.1 texels per cycle on a 256 map: the
    // speckle it produced averaged to nothing and the plate measured flat.
    const grime = fbmC(size, u, v, 11, 9, 3, 419);
    const dent = fbmC(size, u, v, 6, 13, 3, 431) - 0.5;

    // Fresh copper is a warm brown; sea water turns it green-brown then dull.
    const green = clamp01(patina * 1.35 - 0.2);
    let r = mix(0.4, 0.2, green) + tone * 0.075;
    let g = mix(0.24, 0.3, green) + tone * 0.055;
    let b = mix(0.15, 0.24, green) + tone * 0.04;
    // Weed / dirt in the laps.
    r = mix(r, 0.12, lap * 0.55);
    g = mix(g, 0.15, lap * 0.55);
    b = mix(b, 0.12, lap * 0.55);
    const speck = grime > 0.58 ? (grime - 0.58) * 2.2 : 0;
    r += speck * 0.07; g += speck * 0.08; b += speck * 0.04;

    p.r = r; p.g = g; p.b = b;
    // Thin sheet over a plank seam dents and oil-cans; that slow buckle is what
    // catches the light along a coppered bottom.
    p.h = -lap * 1.3 + (patina - 0.5) * 0.25 + dent * 0.7 + tone * 0.12;
    p.rough = 0.55 + green * 0.28 + dent * 0.22 + lap * 0.15 + speck * 0.1;
    p.ao = 1 - lap * 0.5;
    // Mostly-oxidised copper keeps a little metallic character.
    p.metal = mix(0.55, 0.12, green);
  });
}

/**
 * Rope: three-strand right-hand lay. Tinted per instance by the shader.
 *
 * The visible lay is the whole point of a rope, so it gets its own tier: three
 * strands spiralling right-handed, and within each strand the finer left-handed
 * twist of the yarns that make it up. The yarn tier is at 24 cycles on a
 * 128-texel map — 5.3 texels a cycle, just inside what the map can carry —
 * where the old `fbm(..., 64, 20, 3, ...)` asked for 0.5 and delivered hash.
 */
export function makeRope(size = 128): TexSet {
  return bake(size, 3.4, (u, v, p) => {
    // Strands spiral: constant phase along u + v.
    const s = (u * 6 + v) % 1;
    const strand = Math.sin(s * Math.PI * 2) * 0.5 + 0.5;
    // Yarns lie the opposite way inside each strand.
    const ys = (u * 22 - v * 3) % 1;
    const yarn = Math.sin(ys * Math.PI * 2) * 0.5 + 0.5;
    const fuzz = fbmC(size, u, v, 16, 9, 2, 503);
    const l = 0.42 + Math.pow(strand, 0.7) * 0.3 + (yarn - 0.5) * 0.075
            + (fuzz - 0.5) * 0.13;
    p.r = l * 1.02;
    p.g = l * 0.98;
    p.b = l * 0.92;
    p.h = Math.pow(strand, 0.6) * 1.4 + (yarn - 0.5) * 0.42 + (fuzz - 0.5) * 0.3;
    // Hemp is hairy on the outside of the lay and packed hard in the valleys.
    p.rough = 0.82 - strand * 0.08 - (yarn - 0.5) * 0.1 + (fuzz - 0.5) * 0.14;
    p.ao = 0.72 + strand * 0.24 + (yarn - 0.5) * 0.06;
  });
}

/**
 * Weathered flax sailcloth: woven weft/warp, vertical panel seams,
 * hand-sewn patches and mildew staining toward the foot.
 */
export function makeCanvas(size = 512): TexSet {
  return bake(size, 2.4, (u, v, p) => {
    // The WEAVE IS NOT HERE any more. 190 weft cycles over 512 texels is 2.7
    // texels a cycle: sampled at Nyquist it came out as a beating moiré that
    // averaged to a flat grey-green field, which measured a standard deviation
    // of 0.024 at two metres and is exactly the "sails read as flat cloth" the
    // owner reported. The weave is now generated per pixel from the sail's own
    // metre coordinates in `build/sails.ts`, where a 2.5 mm thread pitch can be
    // resolved and faded out honestly.
    //
    // What is left here is the tier a map can carry: the slub and cockle of
    // hand-woven flax at a centimetre and up, panel tone, soil and mildew.
    const slub = fbmC(size, u, v, 34, 26, 3, 601) - 0.5;
    const cockle = fbmC(size, u, v, 9, 11, 3, 607) - 0.5;

    // Four vertical panels per tile with an overlapped, double-stitched seam.
    const pv = v * 4;
    const pRow = Math.floor(pv);
    const av = pv - pRow;
    const seam = smoothstep(0.055, 0.02, Math.min(av, 1 - av));

    const tone = lattice(pRow, Math.floor(u * 3), 9) * 2 - 1;
    const soil = fbmC(size, u, v, 6, 6, 4, 617);
    const mildew = clamp01((fbmC(size, u, v, 12, 9, 3, 733) - 0.52) * 3.0);

    // Patches: rectangular worley cells of slightly different cloth.
    worleyCell(u, v, 6, 809, _cell);
    const patch = _cell.r < 0.07 ? smoothstep(0.2, 0.14, _cell.d) : 0;

    let l = 0.7 + slub * 0.085 + cockle * 0.07 + tone * 0.03;
    l -= soil * 0.07;
    l = mix(l, 0.6, patch * 0.5);
    l = mix(l, 0.44, seam * 0.35);

    // Flax canvas is warm off-white; mildew pulls it grey-green.
    p.r = mix(l * 1.0, l * 0.72, mildew * 0.6);
    p.g = mix(l * 0.965, l * 0.73, mildew * 0.6);
    p.b = mix(l * 0.875, l * 0.62, mildew * 0.6);
    p.h = slub * 0.55 + cockle * 0.85 + seam * 0.9 + patch * 0.4;
    p.rough = 0.78 + slub * 0.1 + cockle * 0.14 + mildew * 0.1;
    p.ao = 1 - seam * 0.22 - patch * 0.1;
  });
}

/** Blackened wrought iron with hammer facets and a little rust bleed. */
export function makeIron(size = 256): TexSet {
  return bake(size, 2.4, (u, v, p) => {
    const facet = fbmC(size, u, v, 12, 12, 3, 907);
    // 48 with three octaves is 1.3 texels a cycle on a 256 map. The pit tier
    // now lives in the shader's fibre term as hammer draw marks.
    const pit = fbmC(size, u, v, 16, 16, 3, 911);
    worleyCell(u, v, 14, 919, _cell);
    const rust = _cell.r < 0.18 ? smoothstep(0.28, 0.08, _cell.d) : 0;
    let l = 0.1 + facet * 0.07 + (pit - 0.5) * 0.04;
    p.r = mix(l, 0.3, rust * 0.7);
    p.g = mix(l, 0.15, rust * 0.7);
    p.b = mix(l * 1.05, 0.08, rust * 0.7);
    p.h = (facet - 0.5) * 0.9 + (pit - 0.5) * 0.5 - rust * 0.3;
    p.rough = 0.44 + facet * 0.2 + rust * 0.32;
    p.ao = 1 - rust * 0.18;
    p.metal = mix(0.9, 0.2, rust);
  });
}

/** Tarnished brass — the binnacle, the bell, cannon furniture. */
export function makeBrass(size = 128): TexSet {
  return bake(size, 2.0, (u, v, p) => {
    const swirl = fbmC(size, u, v, 10, 10, 3, 1009);
    const fine = fbmC(size, u, v, 22, 22, 2, 1013);
    const tarnish = clamp01((fbmC(size, u, v, 5, 5, 3, 1019) - 0.42) * 2.4);
    const l = 0.62 + swirl * 0.14 + (fine - 0.5) * 0.06;
    p.r = mix(l * 1.0, l * 0.5, tarnish);
    p.g = mix(l * 0.8, l * 0.52, tarnish);
    p.b = mix(l * 0.35, l * 0.42, tarnish);
    p.h = (swirl - 0.5) * 0.5 + (fine - 0.5) * 0.4;
    p.rough = 0.22 + tarnish * 0.42 + swirl * 0.1;
    p.ao = 1 - tarnish * 0.12;
    p.metal = mix(0.95, 0.55, tarnish);
  });
}
