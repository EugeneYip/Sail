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
 * Rewrite `f` in place so its values are UNIFORM on 0..1 (rank / last rank).
 *
 * A silhouette is a threshold on a field, and a threshold is only as predictable
 * as the field's distribution. Measured, the raw lane fBm below spans 0.12..0.87
 * with an sd of 0.136 and 30% of its area inside one decile — so ANY threshold
 * either passes nearly all of it or nearly none, and the sprite comes out as a
 * solid slab with a frayed rim. After flattening, `linstep(1 - c - w, 1 - c + w, f)`
 * covers exactly the fraction `c`, so "72% covered with real gaps between the
 * filaments" is a number rather than a hope.
 */
function flattenField(f: Float32Array): void {
  const n = f.length;
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((a, bb) => f[a] - f[bb]);
  const inv = 1 / (n - 1);
  for (let r = 0; r < n; r++) f[order[r]] = r * inv;
}

/**
 * Torn SHEET of aerated water, for mist, spindrift and bow spray sheets.
 *   R = filament density
 *   G = fine erosion detail
 *   B = light-through thickness
 *   A = coverage
 *
 * THE SPRITE HAS TO BE ANISOTROPIC ON ITS OWN. IT CANNOT BORROW IT.
 *
 * What was here was a radially-enveloped mask on a 7 x 2 lattice, and measured
 * ('.tmp/texdump.mjs') it came out as a BALL: 44% of the sprite at alpha 1.0,
 * 38% at 0.0, and the boundary between them a circle with a frayed rim. The
 * anisotropic lattice was there; the radial envelope swamped it. Several hundred
 * of those overlapping at the bow is a bank of cotton wool, which is what the
 * owner has reported three times.
 *
 * The draw shader cannot rescue it and neither can motion stretch. The stretch
 * axis is the particle's SCREEN-space velocity, and the chase camera travels
 * with the ship, so a bow sheet's velocity relative to the eye is nearly the
 * ship's own: every sprite in the fan stretches by the same modest factor along
 * the same axis, and not one of them stops being round. A square quad has to
 * read as a torn sheet by itself.
 *
 * So the silhouette is now a fanned COMB, and there is no radial term in it:
 *
 *  1. Lanes. An 11 x 3 lattice — narrow across u, long along v — FLATTENED and
 *     then thresholded, so the 28% of clear water between the filaments is a
 *     measured quantity instead of whatever the fBm happened to leave. v is also
 *     the draw shader's stretch axis, so what stretch there is elongates
 *     filaments rather than an oval.
 *  2. A fan. The lanes shear with v and meander with a low-frequency warp, so
 *     they splay instead of reading as parallel bars — and the draw shader's
 *     per-particle rotation and u-mirror then give four visibly different draws
 *     of it.
 *  3. Ragged ends, per lane. Each lane starts and stops at its own v, so the
 *     sheet has no shared top or bottom edge to read as a cut line.
 */
export function makeMistTexture(size = 128): THREE.DataTexture {
  const d = new Uint8Array(size * size * 4);
  const lanes = fbmStack(11, 3, 3, 5501);
  const warp = fbmStack(3, 3, 2, 733);
  const fine = fbmStack(13, 5, 3, 1279);
  const ends = fbmStack(2, 4, 2, 91);
  const n = size * size;
  const lane = new Float32Array(n);
  const torn = new Float32Array(n);
  const env = new Float32Array(n);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      const w = fbmS(u * 3, v * 3, warp) - 0.5;
      // Shear with v and meander with the warp: the comb fans out.
      const uf = u + (v - 0.5) * 0.30 + w * 0.26;
      const i = y * size + x;
      lane[i] = fbmS(uf * 11, v * 3, lanes);
      const g = fbmS(uf * 13, v * 5, fine);
      // '1 - |2n - 1|' creases along every zero crossing of the fine octave, and
      // those creases are where the edge tears.
      torn[i] = 1 - Math.abs(g * 2 - 1);
      // Ragged ends per lane, not per sprite.
      const e = fbmS(uf * 2, v * 4, ends);
      const alongV = sstep(0.0, 0.05 + 0.26 * e, v) * sstep(1.0, 0.76 - 0.20 * e, v);
      // Across u the sheet stays full width until the last sixth, so it is a
      // sheet and not a lens. This is the term that used to be a radial falloff.
      const acrossU = sat(1 - Math.pow(Math.abs(2 * u - 1), 3.4));
      env[i] = acrossU * alongV;
      // G is written now; it is not part of the silhouette decision.
      d[i * 4 + 1] = b(g);
    }
  }
  flattenField(lane);
  for (let i = 0; i < n; i++) {
    // Peak coverage inside the sheet. 0.72 leaves 28% clear water between the
    // filaments; the envelope carries it to zero at the sprite's edges, so the
    // outermost lanes thin out into separate strands on their own.
    const cov = env[i] * 0.72;
    // Same construction as the ocean surface's foam coverage: perturb the
    // threshold with a zero-mean field, scaled so it vanishes at both ends of
    // the coverage range and cannot leak alpha where there should be none.
    const bite = Math.min(cov, 1 - cov) * 2;
    const thr = 1 - cov + bite * (torn[i] - 0.5) * 0.62;
    const alpha = sat((lane[i] - thr + 0.065) / 0.13);
    const o = i * 4;
    d[o] = b(lane[i]);
    d[o + 2] = b(Math.pow(lane[i], 1.2) * (0.45 + 0.55 * torn[i]) * env[i]);
    d[o + 3] = b(alpha);
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
 *
 * IT WAS STILL A SNOWBALL, and the number that says so is the radial alpha
 * profile of the region the vertex shader actually samples — it insets to
 * `position.xy * 0.80`, so texture radius beyond 0.8 is never seen:
 *
 *   old fleck  1.00 1.00 1.00 1.00 1.00 1.00 1.00 0.99 0.96 0.79
 *   droplet    1.00 1.00 1.00 1.00 1.00 1.00 1.00 1.00 0.98 0.79   <- the sphere
 *   mist       0.23 0.28 0.26 0.46 0.50 0.39 0.52 0.58 0.44 0.29
 *
 * The fleck was **69.7% fully opaque** over that inset against the droplet's
 * 60.3% — more solid than the sphere it was written to replace — in ONE opaque
 * component of 7151 px with nine 25 px specks beside it. The cellular detail
 * was all there; it never reached the alpha channel, because
 * `radial * (0.34 + 1.05 * cells)` carries an ADDITIVE FLOOR: where `cells` is
 * zero the mask is still `0.34 * radial`, which clears a 0.19 threshold across
 * the whole disc, so the cells could only brighten a solid silhouette from the
 * inside. A field of these at 25-60 m is the cauliflower.
 *
 * The fix is the construction `makeMistTexture` already uses and §40 already
 * proved: FLATTEN the field and threshold it at a coverage. Thresholding a
 * flattened field has expectation exactly `c` at any ramp width, so the
 * boundary can be as torn as the resolution allows while the area stays what
 * was asked for — detail and correctness stop competing, and the peak coverage
 * inside the raft becomes a stated number (0.62) instead of whatever an
 * `sstep` on an unnormalised mask happened to leave.
 *
 * Two notes on the field it thresholds:
 *   - it is Worley PLUS an fBm, not Worley alone. A raft made only of cell
 *     cores is a tiling of equal convex polygons — cracked mud, which is a
 *     different one-scale artefact and no improvement. The fBm breaks the
 *     tiling into patches of unequal size.
 *   - the envelope is a hard-warped radial (1.15 / 0.95 against the old
 *     0.5 / 0.4) raised to 2.2, so the outline is a torn patch pulled off
 *     centre rather than a circle with a wobble.
 *
 * The finest cell field is 19 across 128 px = 6.7 texels per cell. That is
 * about the floor worth baking: the quad shows 102 texels, so at a sprite 40 px
 * wide the mips have already averaged anything finer away.
 *
 * Measure with `.tmp/bake/silhouette.mjs`, which bakes this function in Node
 * against a stub `three` and prints the profile above. Tuning a silhouette
 * through captures is how a disc shipped under a comment calling it a raft.
 */
export function makeFleckTexture(size = 128): THREE.DataTexture {
  const d = new Uint8Array(size * size * 4);
  const c = (size - 1) * 0.5;
  const raft = featureGrid(9, 907);
  const bub = featureGrid(19, 1511);
  const patch = fbmStack(4, 4, 3, 613);
  const warp = fbmStack(3, 3, 2, 4001);
  const fine = fbmStack(8, 8, 3, 8087);
  const n = size * size;
  const field = new Float32Array(n);
  const torn = new Float32Array(n);
  const env = new Float32Array(n);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      const i = y * size + x;
      const w = fbmS(u * 3, v * 3, warp) - 0.5;
      const g = fbmS(u * 8, v * 8, fine);
      torn[i] = 1 - Math.abs(g * 2 - 1);
      // k scales with the cell count — see the note in makeFoamTexture.
      const coarse = cellCore(u * 9, v * 9, 9, raft, 11.25);
      const bubbles = cellCore(u * 19, v * 19, 19, bub, 23.75);
      field[i] = coarse * 0.42 + bubbles * 0.30 + fbmS(u * 4, v * 4, patch) * 0.28;
      const nx = ((x - c) / c) * (1 + 1.15 * w);
      const ny = ((y - c) / c) * (1 - 0.95 * w);
      env[i] = sat(1 - Math.pow(Math.hypot(nx, ny), 2.2));
      d[i * 4] = b(coarse * 0.45 + bubbles * 0.55);
      d[i * 4 + 1] = b(g);
    }
  }
  flattenField(field);
  for (let i = 0; i < n; i++) {
    // Peak coverage inside the raft. 0.60 leaves 40% of it open water, which is
    // what lets two overlapping flecks read as one broken sheet instead of two
    // stacked tokens.
    //
    // The 0.14 ramp is slightly wider than the mist sheet's 0.13. A field
    // thresholded with a narrow ramp is binary, and a first pass at 0.62/0.11
    // made every raft a hard-edged opaque patch: measured on the `night` frame
    // the fleck mask went from 758 components to 52 and the share of runs 3 px
    // or under collapsed from 54% to 9.8% — discrete discs traded for two merged
    // sheets of pack ice, the same one-scale failure in different clothes. Some
    // of the sprite has to sit in partial alpha, because partial alpha at high
    // spatial frequency is what fine structure IS.
    const cov = env[i] * 0.60;
    const bite = Math.min(cov, 1 - cov) * 2;
    const thr = 1 - cov + bite * (torn[i] - 0.5) * 0.66;
    const alpha = sat((field[i] - thr + 0.07) / 0.14);
    d[i * 4 + 2] = b(Math.pow(env[i], 1.3) * (0.45 + 0.55 * field[i]));
    d[i * 4 + 3] = b(alpha);
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
