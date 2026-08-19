import * as THREE from 'three';

/**
 * Every particle / foam texture in the VFX stack, baked on the CPU at init.
 * No image files anywhere in this project, so all of this is procedural.
 *
 * Channel layouts are documented per generator — the shaders depend on them.
 */

function hash2i(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Tileable value noise with integer period `p`. */
function vnoise(x: number, y: number, p: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const w = (v: number) => ((v % p) + p) % p;
  const xa = w(x0);
  const xb = w(x0 + 1);
  const ya = w(y0);
  const yb = w(y0 + 1);
  const a = hash2i(xa, ya, seed);
  const b = hash2i(xb, ya, seed);
  const c = hash2i(xa, yb, seed);
  const d = hash2i(xb, yb, seed);
  return (a * (1 - ux) + b * ux) * (1 - uy) + (c * (1 - ux) + d * ux) * uy;
}

/** Tileable fBm. `base` is the lattice period at the first octave. */
function fbm2(x: number, y: number, base: number, octaves: number, seed: number): number {
  let amp = 0.5;
  let sum = 0;
  let norm = 0;
  let f = 1;
  for (let i = 0; i < octaves; i++) {
    sum += amp * vnoise(x * f, y * f, base * f, seed + i * 71);
    norm += amp;
    amp *= 0.52;
    f *= 2;
  }
  return sum / norm;
}

/**
 * One precomputed value-noise lattice with INDEPENDENT x and y periods.
 *
 * Independent periods are the point. `fbm2` uses a single period for both axes,
 * so the only way to get an anisotropic feature there is to scale one axis of
 * the input — which makes the lattice repeat along that axis. Stretching a
 * period-2 lattice over 48 units of v, which is how the streak channel used to
 * be built, is 24 copies of the same two rows: a corduroy pattern with perfectly
 * even spacing, not water. A 2 x 22 lattice gives 22 distinct rows with
 * irregular spacing and still tiles exactly.
 */
interface Lattice {
  px: number;
  py: number;
  v: Float32Array;
}

/**
 * Prebaked octave stack, periods (px, py) doubling per octave.
 *
 * `fbm2` rehashes its lattice on every sample. That is free for a 64 x 64 sprite
 * and it is not free for the foam texture, which is the one bake big enough to
 * show up at boot: hoisting the hashes out of the per-texel loop removes every
 * hash from the inner loop and leaves four array reads per octave.
 */
function fbmStack(px: number, py: number, octaves: number, seed: number): Lattice[] {
  const out: Lattice[] = [];
  for (let i = 0, f = 1; i < octaves; i++, f *= 2) {
    const ax = px * f;
    const ay = py * f;
    const v = new Float32Array(ax * ay);
    for (let y = 0; y < ay; y++) {
      for (let x = 0; x < ax; x++) v[y * ax + x] = hash2i(x, y, seed + i * 71);
    }
    out.push({ px: ax, py: ay, v });
  }
  return out;
}

function vnoiseL(x: number, y: number, L: Lattice): number {
  const px = L.px;
  const py = L.py;
  const v = L.v;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const xa = ((x0 % px) + px) % px;
  const ya = ((y0 % py) + py) % py;
  const xb = xa + 1 === px ? 0 : xa + 1;
  const yb = ya + 1 === py ? 0 : ya + 1;
  const ra = ya * px;
  const rb = yb * px;
  const a = v[ra + xa];
  const bb = v[ra + xb];
  const c = v[rb + xa];
  const d = v[rb + xb];
  return (a * (1 - ux) + bb * ux) * (1 - uy) + (c * (1 - ux) + d * ux) * uy;
}

/** `x` and `y` must span exactly st[0].px and st[0].py for the result to tile. */
function fbmS(x: number, y: number, st: Lattice[]): number {
  let amp = 0.5;
  let sum = 0;
  let norm = 0;
  let f = 1;
  for (let i = 0; i < st.length; i++) {
    sum += amp * vnoiseL(x * f, y * f, st[i]);
    norm += amp;
    amp *= 0.52;
    f *= 2;
  }
  return sum / norm;
}

/**
 * Jittered feature point per cell of a `cells` x `cells` torus, precomputed.
 *
 * The previous Worley hashed its nine candidate points per *texel*, so every
 * point was rehashed once per texel that could see it — about nine times the
 * necessary work, which is what kept the foam texture down at 256 with two
 * octaves. Baking the grid once makes the per-texel loop nine array reads.
 */
function featureGrid(cells: number, seed: number): Float32Array {
  const g = new Float32Array(cells * cells * 2);
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      const o = (y * cells + x) * 2;
      g[o] = x + hash2i(x, y, seed);
      g[o + 1] = y + hash2i(x, y, seed + 977);
    }
  }
  return g;
}

/**
 * Distance to the SECOND nearest feature point minus the nearest, scaled.
 *
 * This is the bubble-raft primitive. F2 - F1 is largest deep inside a cell and
 * falls to exactly zero on the wall between two cells, so a threshold on it
 * gives convex bubbles separated by hard dark films — which is what a mass of
 * whitewater actually looks like close up.
 *
 * `1 - F1`, which this file used to use, is a smooth radial falloff from every
 * cell centre. That is a field of soft round blobs: cotton wool. It was the
 * single biggest reason the bow and stern foam did not read as water.
 */
function cellCore(x: number, y: number, cells: number, g: Float32Array, k: number): number {
  const cx = Math.floor(x);
  const cy = Math.floor(y);
  // Squared distances throughout; two square roots at the end instead of nine.
  let f1 = 1e9;
  let f2 = 1e9;
  for (let j = -1; j <= 1; j++) {
    const gy = cy + j;
    // Wrap the LOOKUP but not the position, so the torus has no seam.
    const wy = ((gy % cells) + cells) % cells;
    const row = wy * cells;
    const offY = gy - wy;
    for (let i = -1; i <= 1; i++) {
      const gx = cx + i;
      const wx = ((gx % cells) + cells) % cells;
      const o = (row + wx) * 2;
      const dx = g[o] + (gx - wx) - x;
      const dy = g[o + 1] + offY - y;
      const d = dx * dx + dy * dy;
      if (d < f1) {
        f2 = f1;
        f1 = d;
      } else if (d < f2) {
        f2 = d;
      }
    }
  }
  return sat((Math.sqrt(f2) - Math.sqrt(f1)) * k);
}

function tex(data: Uint8Array, w: number, h: number, repeat: boolean): THREE.DataTexture {
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  // These are masks / packed data, never colour: keep them out of sRGB decode.
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

const b = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
const sat = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const sstep = (e0: number, e1: number, x: number) => {
  const t = sat((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/**
 * Droplet sprite. This is the sprite that makes spray read as water rather
 * than as a white dot, so it carries real shading data:
 *   R = sphere thickness  (for internal transmission / forward scatter)
 *   G = rim / Fresnel mask
 *   B = specular caustic pip, offset from centre
 *   A = coverage
 */
export function makeDropletTexture(size = 64): THREE.DataTexture {
  const d = new Uint8Array(size * size * 4);
  const c = (size - 1) * 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = (x - c) / c;
      const ny = (y - c) / c;
      const r = Math.hypot(nx, ny);
      const core = sstep(1.0, 0.66, r);
      const halo = Math.pow(sat(1 - r), 3.2) * 0.34;
      const alpha = sat(core + halo);
      const thick = Math.sqrt(Math.max(0, 1 - r * r));
      const rim = sstep(0.52, 0.97, r) * core;
      const px = nx + 0.3;
      const py = ny + 0.32;
      const pip = Math.exp(-(px * px + py * py) / 0.022) * 0.9;
      const i = (y * size + x) * 4;
      d[i] = b(thick);
      d[i + 1] = b(rim);
      d[i + 2] = b(pip);
      d[i + 3] = b(alpha);
    }
  }
  return tex(d, size, size, false);
}

/**
 * Torn sheet of aerated water, for mist, spindrift and spray sheets.
 *   R = coarse density detail
 *   G = fine erosion detail
 *   B = light-through thickness
 *   A = coverage
 *
 * THIS SPRITE IS THE COTTON WOOL. What was here was a radial falloff
 * ('pow(1 - r, 2.1)') multiplied by a smooth 4-period fBm: a soft round blob
 * with a gradient edge. Several hundred of them overlapping at the waterline is
 * a bank of cotton balls, and that is precisely what the owner saw and what the
 * ocean agent's crops called "whitecaps like torn tissue". No amount of shading
 * rescues a round silhouette with a soft edge.
 *
 * Three changes, in order of how much they matter:
 *
 *  1. The silhouette is now a THRESHOLD on a warped, eroded mask, so its edge is
 *     as steep as the texture allows instead of fading out over the sprite's
 *     whole radius. A hard edge is what makes water read as water.
 *  2. The lattice is 7 x 2 — anisotropic, long axis on v. v is the sprite's
 *     motion-stretch axis (see 'off.y' in the draw vertex shader), so a
 *     stretched sprite now draws out into filaments aligned with its own
 *     velocity rather than into an oval.
 *  3. 128 instead of 64. These sprites grow to ~2 m and sit a few metres from
 *     the camera, where a 64-texel sprite has nothing left to show.
 */
export function makeMistTexture(size = 128): THREE.DataTexture {
  const d = new Uint8Array(size * size * 4);
  const c = (size - 1) * 0.5;
  const fil = fbmStack(7, 2, 3, 5501);
  const warp = fbmStack(3, 3, 2, 733);
  const fine = fbmStack(9, 9, 3, 1279);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      const w = fbmS(u * 3, v * 3, warp) - 0.5;
      const f = fbmS(u * 7, v * 2, fil);
      const g = fbmS(u * 9, v * 9, fine);
      // Warp the radius so the outline is a torn rag rather than an ellipse,
      // and squash it on v so the untorn shape is already elongated.
      const nx = ((x - c) / c) * (1 + 0.55 * w);
      const ny = ((y - c) / c) * 0.80;
      const r = Math.hypot(nx, ny);
      const radial = sat(1 - r);
      // '1 - |2n - 1|' creases along every zero crossing of the fine octave.
      // Those creases are where the edge tears.
      const torn = 1 - Math.abs(g * 2 - 1);
      const mask = radial * (0.30 + 1.15 * f) * (0.66 + 0.62 * torn);
      const alpha = sstep(0.17, 0.35, mask);
      const i = (y * size + x) * 4;
      d[i] = b(f);
      d[i + 1] = b(g);
      d[i + 2] = b(Math.pow(radial, 1.3) * (0.55 + 0.45 * f));
      d[i + 3] = b(alpha);
    }
  }
  return tex(d, size, size, false);
}

/**
 * Foam fleck: a raft of aerated water lying ON the surface, not a drop in
 * flight.
 *   R = bubble raft, G = fine erosion, B = thickness, A = coverage
 *
 * These used to draw with the DROPLET sprite, which is a shaded sphere — so
 * every fleck of surface foam was a round ball with a bright rim, and a wave
 * crest's worth of them was a row of cotton tufts. A raft is flat, its outline
 * is jagged, and its interior is visibly cellular; all three are what
 * distinguishes it from a snowball at two metres.
 */
export function makeFleckTexture(size = 128): THREE.DataTexture {
  const d = new Uint8Array(size * size * 4);
  const c = (size - 1) * 0.5;
  const raft1 = featureGrid(6, 613);
  const raft2 = featureGrid(15, 907);
  const warp = fbmStack(3, 3, 2, 4001);
  const fine = fbmStack(8, 8, 3, 8087);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      const w = fbmS(u * 3, v * 3, warp) - 0.5;
      const g = fbmS(u * 8, v * 8, fine);
      const nx = ((x - c) / c) * (1 + 0.5 * w);
      const ny = ((y - c) / c) * (1 - 0.4 * w);
      const radial = sat(1 - Math.hypot(nx, ny));
      const cells =
        cellCore(u * 6, v * 6, 6, raft1, 2.3) * 0.58 +
        cellCore(u * 15, v * 15, 15, raft2, 3.0) * 0.42;
      const torn = 1 - Math.abs(g * 2 - 1);
      const mask = radial * (0.34 + 1.05 * cells) * (0.62 + 0.66 * torn);
      const alpha = sstep(0.19, 0.36, mask);
      const i = (y * size + x) * 4;
      d[i] = b(cells);
      d[i + 1] = b(g);
      d[i + 2] = b(Math.pow(radial, 1.6) * (0.5 + 0.5 * cells));
      d[i + 3] = b(alpha);
    }
  }
  return tex(d, size, size, false);
}

/**
 * Cannon / galley smoke puff.
 *   R = coarse billow, G = fine erosion, B = thickness for scattering, A = coverage
 */
export function makeSmokeTexture(size = 128): THREE.DataTexture {
  const d = new Uint8Array(size * size * 4);
  const c = (size - 1) * 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = (x - c) / c;
      const ny = (y - c) / c;
      const r = Math.hypot(nx, ny);
      const u = x / size;
      const v = y / size;
      const billow = fbm2(u * 3, v * 3, 3, 5, 203);
      const fine = fbm2(u * 9, v * 9, 9, 4, 511);
      // Warp the radial mask by the billow so the silhouette is lumpy.
      const rr = r * (1.0 - 0.34 * (billow - 0.5) * 2.0);
      const radial = Math.pow(sat(1 - rr), 1.5);
      const alpha = sat(radial * (0.35 + 1.1 * billow) * 1.35 - 0.05 * fine);
      const i = (y * size + x) * 4;
      d[i] = b(billow);
      d[i + 1] = b(fine);
      d[i + 2] = b(Math.pow(sat(1 - rr * 0.8), 1.9));
      d[i + 3] = b(alpha);
    }
  }
  return tex(d, size, size, false);
}

/**
 * Tileable foam / aerated water. Used by the wake ribbon, the bow sheet and the
 * hull skirt.
 *   R = bubble raft, G = flow filaments, B = micro-bubble grain,
 *   A = coverage with a ragged, high-gradient edge
 *
 * The channel roles are unchanged — `wake.ts` and `hullwater.ts` both depend on
 * them — but every channel is now crisp and multi-scale rather than smooth. The
 * owner's complaint was that water touching the hull is "a mass of soft round
 * blobs"; three things in the old bake guaranteed that, and all three are gone:
 *
 *  1. R was '1 - worleyF1': a smooth radial falloff from each cell centre, i.e.
 *     literally a field of soft round blobs. It is now F2 - F1, which gives
 *     convex cells separated by hard films (see 'cellCore').
 *  2. Nothing in the texture had a steep gradient, so every threshold a shader
 *     applied came out as a soft contour. A is now a ridged fractal, whose
 *     creases let the shaders cut a torn edge instead of a fading one.
 *  3. The finest feature was a 40-period smooth fBm — about 6 texels across at
 *     256. There was no detail left to see at the rail. The finest scale is now
 *     a 78-cell bubble field at 512.
 *
 * `u` is the ALONG-FLOW axis in every consumer, so G is stretched 24:1 on u.
 *
 * Resolution stays at 256. A 512 bake was tried and measured 3.9 s cold, which
 * is a boot stall, not a texture. The extra fineness comes instead from a third,
 * higher-frequency sample in the shaders, where a texture read is nearly free —
 * and because the primitives here are cheaper than the ones they replace, this
 * bake now costs roughly half of the old one.
 */
export function makeFoamTexture(size = 256): THREE.DataTexture {
  const d = new Uint8Array(size * size * 4);
  const raft1 = featureGrid(10, 3);
  const raft2 = featureGrid(22, 91);
  const raft3 = featureGrid(46, 137);
  // 11:1 anisotropic, long axis on u. Three octaves: the top one is only 13% of
  // the amplitude, but it is what puts a crisp edge on each filament.
  const sStreak = fbmStack(2, 22, 3, 707);
  const sMeander = fbmStack(3, 3, 2, 4409);
  const sRidge = fbmStack(6, 6, 3, 2311);
  const sCoarse = fbmStack(3, 3, 3, 1607);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      const coarse = fbmS(u * 3, v * 3, sCoarse);

      // R — bubble raft at three scales, so it still has structure when the
      // camera is at the rail rather than dissolving into one flat tone.
      //
      // 'k' MUST SCALE WITH THE CELL COUNT. F2 - F1 is measured in tile units,
      // so its magnitude inside a cell is proportional to the cell SPACING
      // (~0.3/cells). A fixed k of 2.4 against a 10-cell grid therefore peaked
      // at about 0.24 — never saturating, so every cell was a soft dome and the
      // films between them were mid-grey. That is a field of soft round blobs
      // wearing a Worley costume, and it is why the raft still read as suds
      // after F1 was replaced by F2 - F1. At k = 1.25 * cells the cells are fat
      // and flat-topped and the films are thin and dark, which is the proportion
      // real whitewater has, at every scale.
      const c1 = cellCore(u * 10, v * 10, 10, raft1, 12.5);
      const c2 = cellCore(u * 22, v * 22, 22, raft2, 27.5);
      const c3 = cellCore(u * 46, v * 46, 46, raft3, 57.5);
      // Steep: a 0.64-wide ramp put a soft gradient back on every cell wall.
      const bubbles = sstep(0.24, 0.60, c1 * 0.46 + c2 * 0.33 + c3 * 0.21);

      // G — filaments, meandered across the flow and thresholded so there is
      // clear water BETWEEN the streaks, then broken up along their length so
      // they start and stop instead of running the full width of the tile.
      const meander = fbmS(u * 3, v * 3, sMeander) - 0.5;
      const s1 = fbmS(u * 2, (v + meander * 0.05) * 22, sStreak);
      const breakup = 0.45 + 0.85 * coarse;
      const streak = sat(sstep(0.40, 0.62, s1) * breakup);

      // B — micro-bubble grain: the finest scale here, and what the shaders
      // magnify hard for near-hull detail.
      const sparkle = sat(c3 * (0.55 + 0.85 * coarse));

      // A — coverage. Ridged, not smooth: '1 - |2n - 1|' creases along every
      // zero crossing, and it is those creases that let a shader threshold this
      // into a torn breaking edge instead of a fading contour.
      // An fBm is bell-shaped around 0.5, so '1 - |2n - 1|' is biased HIGH;
      // it is weighted for its gradient here, not for its level.
      const ridge = 1 - Math.abs(fbmS(u * 6, v * 6, sRidge) * 2 - 1);
      const cover = sstep(0.20, 0.86, coarse * 0.72 + ridge * 0.28);

      const i = (y * size + x) * 4;
      d[i] = b(bubbles);
      d[i + 1] = b(streak);
      d[i + 2] = b(sparkle);
      d[i + 3] = b(cover);
    }
  }
  return tex(d, size, size, true);
}

/**
 * Rain streak. Tall, thin, bright core with tapered ends.
 *   R = core intensity, G = soft halo, A = coverage
 */
export function makeStreakTexture(w = 32, h = 128): THREE.DataTexture {
  const d = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const nx = ((x + 0.5) / w - 0.5) * 2;
      const t = (y + 0.5) / h;
      // Slightly thicker at the trailing (lower) end, like a real streak.
      const width = 0.32 + 0.5 * t;
      const across = sat(1 - Math.abs(nx) / width);
      const core = Math.pow(across, 2.6);
      const halo = Math.pow(across, 0.9) * 0.45;
      const along = Math.pow(Math.sin(Math.PI * t), 0.55);
      const i = (y * w + x) * 4;
      d[i] = b(core * along);
      d[i + 1] = b(halo * along);
      d[i + 2] = 0;
      d[i + 3] = b(sat(core + halo) * along);
    }
  }
  return tex(d, w, h, false);
}

export interface VfxTextures {
  droplet: THREE.DataTexture;
  mist: THREE.DataTexture;
  fleck: THREE.DataTexture;
  smoke: THREE.DataTexture;
  foam: THREE.DataTexture;
  streak: THREE.DataTexture;
  dispose(): void;
}

export function createVfxTextures(): VfxTextures {
  const droplet = makeDropletTexture(64);
  const mist = makeMistTexture(128);
  const fleck = makeFleckTexture(128);
  const smoke = makeSmokeTexture(128);
  const foam = makeFoamTexture(256);
  const streak = makeStreakTexture(32, 128);
  return {
    droplet,
    mist,
    fleck,
    smoke,
    foam,
    streak,
    dispose() {
      droplet.dispose();
      mist.dispose();
      fleck.dispose();
      smoke.dispose();
      foam.dispose();
      streak.dispose();
    },
  };
}
