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

/** White oak grain: warped ring structure running along the plank. */
function oakGrain(u: number, v: number, seed: number): number {
  const warp = fbm(u, v, 4, 4, 2, seed + 5) - 0.5;
  const g = ridged(u + warp * 0.05, v + warp * 0.012, 3, 110, 3, seed);
  const fibre = fbm(u, v, 220, 26, 2, seed + 17) - 0.5;
  return g * 0.85 + fibre * 0.3;
}

/* ------------------------------------------------------------------ *
 *  Families
 * ------------------------------------------------------------------ */

/** Bare / oiled white oak planking — used for spars, boats and furniture. */
export function makeOak(size = 512): TexSet {
  return bake(size, 2.2, (u, v, p) => {
    plankLayout(u, v, 11, 2, _pl);
    const grain = oakGrain(u, v, 11);
    let l = 0.42 + grain * 0.13 + _pl.tone * 0.045;

    worleyCell(u, v, 7, 23, _cell);
    const knot = _cell.r < 0.13 ? smoothstep(0.16, 0.02, _cell.d) : 0;
    l = mix(l, 0.2, knot * 0.85);

    const seam = smoothstep(0.03, 0.0, _pl.seam) + smoothstep(0.035, 0.0, _pl.butt) * 0.8;
    l = mix(l, 0.13, clamp01(seam));

    p.r = l * 1.09;
    p.g = l * 0.93;
    p.b = l * 0.72;
    p.h = grain * 0.35 - clamp01(seam) * 1.1 - knot * 0.5 + _pl.tone * 0.06;
    p.rough = 0.62 + grain * 0.12 + knot * 0.1;
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
    const grain = oakGrain(u, v, 11);

    // Paint sits on the wood: the grain still telegraphs through.
    let l = 0.052 + grain * 0.016 + _pl.tone * 0.008;
    // Broad patchy fade from sun and salt.
    const fade = fbm(u, v, 5, 5, 3, 71);
    l += fade * 0.032;

    // Chips: small worley cells that break through to primer/oak.
    worleyCell(u, v, 26, 41, _cell);
    const chip = _cell.r < 0.1 ? smoothstep(0.28, 0.06, _cell.d) : 0;
    const chipDeep = _cell.r < 0.04 ? smoothstep(0.2, 0.04, _cell.d) : 0;

    // Salt streaking: thin in u, long in v — i.e. running down the side.
    const streak = clamp01((fbm(u, v, 90, 4, 3, 133) - 0.5) * 3.2);
    const salt = streak * smoothstep(0.35, 0.75, fbm(u, v, 6, 3, 2, 211));

    const seam = smoothstep(0.028, 0.0, _pl.seam) * 0.8 + smoothstep(0.03, 0.0, _pl.butt) * 0.5;
    l = mix(l, 0.03, clamp01(seam));

    let r = l;
    let g = l;
    let b = l * 1.03;
    // Primer grey, then bare oak in the deepest chips.
    r = mix(r, 0.3, chip * 0.55); g = mix(g, 0.29, chip * 0.55); b = mix(b, 0.28, chip * 0.55);
    r = mix(r, 0.42, chipDeep * 0.7); g = mix(g, 0.34, chipDeep * 0.7); b = mix(b, 0.24, chipDeep * 0.7);
    // Salt bloom.
    r = mix(r, 0.62, salt * 0.4); g = mix(g, 0.63, salt * 0.4); b = mix(b, 0.61, salt * 0.4);

    p.r = r; p.g = g; p.b = b;
    p.h = grain * 0.22 - clamp01(seam) * 1.2 - chip * 0.5 + salt * 0.1;
    p.rough = 0.36 + fade * 0.18 + chip * 0.3 + salt * 0.25;
    p.ao = 1 - clamp01(seam) * 0.4 - chip * 0.15;
    p.metal = 0;
  });
}

/** The white/buff gunport stripe — same oak underneath, brighter paint. */
export function makeStripeWhite(size = 512): TexSet {
  return bake(size, 2.4, (u, v, p) => {
    plankLayout(u, v, 11, 2, _pl);
    const grain = oakGrain(u, v, 11);
    const fade = fbm(u, v, 5, 5, 3, 71);
    let l = 0.76 + grain * 0.05 + _pl.tone * 0.02 - fade * 0.08;

    worleyCell(u, v, 24, 61, _cell);
    const chip = _cell.r < 0.11 ? smoothstep(0.26, 0.05, _cell.d) : 0;
    const grime = clamp01((fbm(u, v, 70, 5, 3, 307) - 0.45) * 2.6);

    const seam = smoothstep(0.026, 0.0, _pl.seam) * 0.9 + smoothstep(0.03, 0.0, _pl.butt) * 0.5;
    l = mix(l, 0.5, clamp01(seam));
    l = mix(l, 0.44, grime * 0.5);

    p.r = mix(l * 1.0, 0.4, chip * 0.6);
    p.g = mix(l * 0.975, 0.33, chip * 0.6);
    p.b = mix(l * 0.9, 0.24, chip * 0.6);
    p.h = grain * 0.2 - clamp01(seam) * 1.2 - chip * 0.5;
    p.rough = 0.44 + fade * 0.16 + chip * 0.28 + grime * 0.2;
    p.ao = 1 - clamp01(seam) * 0.4 - chip * 0.15;
  });
}

/** Ochre-buff paint for the inboard bulwarks. */
export function makeBuff(size = 256): TexSet {
  return bake(size, 2.0, (u, v, p) => {
    plankLayout(u, v, 13, 2, _pl);
    const grain = oakGrain(u, v, 13);
    const fade = fbm(u, v, 5, 5, 3, 91);
    let l = 0.6 + grain * 0.06 + _pl.tone * 0.03 - fade * 0.07;
    const seam = smoothstep(0.03, 0.0, _pl.seam) * 0.9;
    l = mix(l, 0.4, clamp01(seam));
    const grime = clamp01((fbm(u, v, 60, 6, 3, 401) - 0.48) * 2.4);
    l = mix(l, 0.34, grime * 0.45);
    p.r = l * 1.06;
    p.g = l * 0.88;
    p.b = l * 0.53;
    p.h = grain * 0.2 - clamp01(seam) * 1.0;
    p.rough = 0.5 + fade * 0.16 + grime * 0.2;
    p.ao = 1 - clamp01(seam) * 0.4;
  });
}

/** Holystoned, oiled deck planking with caulked seams and traffic wear. */
export function makeDeck(size = 512): TexSet {
  return bake(size, 2.8, (u, v, p) => {
    plankLayout(u, v, 17, 3, _pl);
    const grain = oakGrain(u, v, 17);
    const traffic = fbm(u, v, 4, 4, 3, 151);
    let l = 0.5 + grain * 0.1 + _pl.tone * 0.05;
    // Scrubbed pale where feet go, darker and oilier at the edges.
    l += (traffic - 0.5) * 0.13;

    worleyCell(u, v, 9, 71, _cell);
    const knot = _cell.r < 0.1 ? smoothstep(0.14, 0.02, _cell.d) : 0;
    l = mix(l, 0.24, knot * 0.8);

    // Caulk: pitch in the seams, distinctly black and slightly recessed.
    const seam = smoothstep(0.045, 0.012, _pl.seam);
    const butt = smoothstep(0.02, 0.004, _pl.butt);
    const caulk = clamp01(seam + butt * 0.9);

    p.r = mix(l * 1.02, 0.055, caulk);
    p.g = mix(l * 0.93, 0.05, caulk);
    p.b = mix(l * 0.76, 0.048, caulk);
    p.h = grain * 0.3 - caulk * 1.4 - knot * 0.4 + _pl.tone * 0.1;
    p.rough = 0.55 + grain * 0.14 - traffic * 0.1 + caulk * 0.2;
    p.ao = 1 - caulk * 0.6 - knot * 0.2;
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

    const tone = lattice(row, col, 5) * 2 - 1;
    const patina = fbm(u, v, 7, 7, 4, 313);
    const grime = fbm(u, v, 30, 14, 3, 419);

    // Fresh copper is a warm brown; sea water turns it green-brown then dull.
    const green = clamp01(patina * 1.35 - 0.2);
    let r = mix(0.4, 0.2, green) + tone * 0.03;
    let g = mix(0.24, 0.3, green) + tone * 0.02;
    let b = mix(0.15, 0.24, green) + tone * 0.015;
    // Weed / dirt in the laps.
    r = mix(r, 0.12, lap * 0.55);
    g = mix(g, 0.15, lap * 0.55);
    b = mix(b, 0.12, lap * 0.55);
    const speck = grime > 0.62 ? (grime - 0.62) * 2 : 0;
    r += speck * 0.05; g += speck * 0.06; b += speck * 0.03;

    p.r = r; p.g = g; p.b = b;
    p.h = -lap * 1.3 + (patina - 0.5) * 0.25 + tone * 0.12;
    p.rough = 0.55 + green * 0.28 + lap * 0.15 + speck * 0.1;
    p.ao = 1 - lap * 0.5;
    // Mostly-oxidised copper keeps a little metallic character.
    p.metal = mix(0.55, 0.12, green);
  });
}

/** Rope: three-strand right-hand lay. Tinted per instance by the shader. */
export function makeRope(size = 128): TexSet {
  return bake(size, 3.4, (u, v, p) => {
    // Strands spiral: constant phase along u + v.
    const s = (u * 6 + v) % 1;
    const strand = Math.sin(s * Math.PI * 2) * 0.5 + 0.5;
    const fuzz = fbm(u, v, 64, 20, 3, 503);
    const l = 0.42 + Math.pow(strand, 0.7) * 0.34 + (fuzz - 0.5) * 0.13;
    p.r = l * 1.02;
    p.g = l * 0.98;
    p.b = l * 0.92;
    p.h = Math.pow(strand, 0.6) * 1.4 + (fuzz - 0.5) * 0.3;
    p.rough = 0.82 - strand * 0.08;
    p.ao = 0.72 + strand * 0.28;
  });
}

/**
 * Weathered flax sailcloth: woven weft/warp, vertical panel seams,
 * hand-sewn patches and mildew staining toward the foot.
 */
export function makeCanvas(size = 512): TexSet {
  return bake(size, 1.9, (u, v, p) => {
    // Weave: two orthogonal high-frequency bands.
    const weftPhase = (v * 190) % 1;
    const warpPhase = (u * 150) % 1;
    const weave =
      (Math.sin(weftPhase * Math.PI * 2) * 0.5 + 0.5) * 0.55 +
      (Math.sin(warpPhase * Math.PI * 2) * 0.5 + 0.5) * 0.45;
    const slub = fbm(u, v, 130, 100, 2, 601);

    // Four vertical panels per tile with an overlapped, double-stitched seam.
    const pv = v * 4;
    const pRow = Math.floor(pv);
    const av = pv - pRow;
    const seam = smoothstep(0.055, 0.02, Math.min(av, 1 - av));
    const stitch = seam * (Math.sin(u * 260) * 0.5 + 0.5);

    const tone = lattice(pRow, Math.floor(u * 3), 9) * 2 - 1;
    const soil = fbm(u, v, 6, 6, 4, 617);
    const mildew = clamp01((fbm(u, v, 12, 9, 3, 733) - 0.52) * 3.0);

    // Patches: rectangular worley cells of slightly different cloth.
    worleyCell(u, v, 6, 809, _cell);
    const patch = _cell.r < 0.07 ? smoothstep(0.2, 0.14, _cell.d) : 0;

    let l = 0.7 + (weave - 0.5) * 0.075 + (slub - 0.5) * 0.05 + tone * 0.022;
    l -= soil * 0.07;
    l = mix(l, 0.6, patch * 0.5);
    l = mix(l, 0.44, seam * 0.35);

    // Flax canvas is warm off-white; mildew pulls it grey-green.
    p.r = mix(l * 1.0, l * 0.72, mildew * 0.6);
    p.g = mix(l * 0.965, l * 0.73, mildew * 0.6);
    p.b = mix(l * 0.875, l * 0.62, mildew * 0.6);
    p.h = (weave - 0.5) * 0.5 + seam * 0.9 + stitch * 0.35 + patch * 0.4 + (slub - 0.5) * 0.3;
    p.rough = 0.78 + (weave - 0.5) * 0.06 + mildew * 0.1;
    p.ao = 1 - seam * 0.22 - patch * 0.1;
  });
}

/** Blackened wrought iron with hammer facets and a little rust bleed. */
export function makeIron(size = 256): TexSet {
  return bake(size, 2.4, (u, v, p) => {
    const facet = fbm(u, v, 12, 12, 3, 907);
    const pit = fbm(u, v, 48, 48, 3, 911);
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
    const swirl = fbm(u, v, 10, 10, 3, 1009);
    const fine = fbm(u, v, 60, 60, 2, 1013);
    const tarnish = clamp01((fbm(u, v, 5, 5, 3, 1019) - 0.42) * 2.4);
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
