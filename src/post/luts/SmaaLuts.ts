import * as THREE from 'three';

/**
 * Procedural SMAA lookup tables.
 *
 * These are *not* Jimenez's shipped `AreaTex`/`SearchTex` binaries — nothing is
 * downloaded here. Both tables are generated from first principles at init with
 * a layout of our own choosing, and the resolve shader in `shaders/smaa.ts` is
 * written against that layout. The maths is the standard MLAA reconstruction:
 *
 *   L-shape  (one end of the run turns): one triangle over the whole run
 *   Z-shape  (both ends turn, opposite): one line from -0.5 to +0.5
 *   U-shape  (both ends turn, same way): two triangles meeting at the midpoint
 *
 * Coverage is then the integral of that reconstructed boundary over the pixel,
 * split into the part above the pixel row boundary (`aPos`) and below (`aNeg`).
 * The integral is evaluated numerically — this runs once, on the CPU, and
 * numerics are far less error-prone here than a hand-derived case analysis.
 */

/** Max run length either side, in texels. Matches SMAA_MAX_SEARCH_STEPS. */
export const SMAA_MAX_DISTANCE = 12;
const BLOCK = SMAA_MAX_DISTANCE + 1;
/** round(4*e) is one of 0,1,3,4 — five slots, four used. */
const PATTERNS = 5;
export const SMAA_AREA_SIZE = BLOCK * PATTERNS;

/**
 * Endpoint displacement of the reconstructed boundary, in pixels, from
 * `round(4 * crossingEdge)`.
 *
 * The crossing edge is fetched with a 25/75 bilinear straddle of the two rows
 * that the edge line separates, so:
 *   0 -> no crossing edge, the run simply continues: no displacement
 *   1 -> crossing on the positive side only: boundary leaves at +0.5
 *   3 -> crossing on the negative side only: boundary leaves at -0.5
 *   4 -> crossing on both sides: ambiguous, MLAA declines to revise
 */
function endpointOffset(index: number): number {
  if (index === 1) return 0.5;
  if (index === 3) return -0.5;
  return 0;
}

const INTEGRATION_SAMPLES = 32;

function coverage(i1: number, i2: number, d1: number, d2: number): [number, number] {
  const h1 = endpointOffset(i1);
  const h2 = endpointOffset(i2);
  if (h1 === 0 && h2 === 0) return [0, 0];

  const d = d1 + d2 + 1;
  const uShape = h1 !== 0 && h2 !== 0 && Math.sign(h1) === Math.sign(h2);

  const boundary = (x: number): number => {
    if (!uShape) return h1 + ((h2 - h1) * x) / d;
    const mid = d * 0.5;
    return x < mid ? h1 * (1 - x / mid) : h2 * ((x - mid) / mid);
  };

  let pos = 0;
  let neg = 0;
  for (let k = 0; k < INTEGRATION_SAMPLES; k++) {
    const x = d1 + (k + 0.5) / INTEGRATION_SAMPLES;
    const y = boundary(x);
    if (y > 0) pos += y;
    else neg -= y;
  }
  return [pos / INTEGRATION_SAMPLES, neg / INTEGRATION_SAMPLES];
}

/**
 * RG8, `SMAA_AREA_SIZE` square. u indexes (i1, d1), v indexes (i2, d2).
 * Values are stored doubled because |coverage| never exceeds 0.5.
 */
export function makeSmaaAreaTexture(): THREE.DataTexture {
  const n = SMAA_AREA_SIZE;
  const data = new Uint8Array(n * n * 2);
  for (let i2 = 0; i2 < PATTERNS; i2++) {
    for (let d2 = 0; d2 < BLOCK; d2++) {
      const v = i2 * BLOCK + d2;
      for (let i1 = 0; i1 < PATTERNS; i1++) {
        for (let d1 = 0; d1 < BLOCK; d1++) {
          const u = i1 * BLOCK + d1;
          const [pos, neg] = coverage(i1, i2, d1, d2);
          const o = (v * n + u) * 2;
          data[o] = Math.round(Math.min(1, pos * 2) * 255);
          data[o + 1] = Math.round(Math.min(1, neg * 2) * 255);
        }
      }
    }
  }
  const tex = new THREE.DataTexture(data, n, n, THREE.RGFormat, THREE.UnsignedByteType);
  tex.name = 'post/smaaArea';
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

export const SMAA_SEARCH_SIZE = 33;

/**
 * Search decision table, R8, indexed by the two channels of one bilinear tap
 * that straddles a pair of texels along the run:
 *   u = average continuation-edge value of the pair
 *   v = average crossing-edge value of the pair
 *
 * Decoded value * 8 gives a code:
 *   0 = the line ended before this pair — stop, extend by 0
 *   1 = the line covers the near texel only — stop, extend by 1
 *   2 = the line covers both texels — continue, extend by 2
 *   3 = exactly one texel of the pair carries a crossing edge; which one is
 *       ambiguous from a bilinear average, so the shader takes one extra
 *       single-texel tap to disambiguate
 *   4 = both texels carry a crossing edge, so the near one terminates the run
 *
 * Quantising to 33 levels rather than 5 keeps the decision stable against
 * bilinear filtering error on the edge texture. The `crossing` axis picks up a
 * small (0.125 weight) bleed from the row on the far side of the edge line, so
 * the "some crossing present" threshold has to sit below that.
 */
export function makeSmaaSearchTexture(): THREE.DataTexture {
  const n = SMAA_SEARCH_SIZE;
  const data = new Uint8Array(n * n);
  for (let vi = 0; vi < n; vi++) {
    const crossing = vi / (n - 1);
    for (let ui = 0; ui < n; ui++) {
      const cont = ui / (n - 1);
      let code: number;
      if (cont < 0.3) code = 0;
      else if (cont < 0.75) code = 1;
      else if (crossing > 0.65) code = 4;
      else if (crossing > 0.05) code = 3;
      else code = 2;
      data[vi * n + ui] = Math.round((code / 8) * 255);
    }
  }
  const tex = new THREE.DataTexture(data, n, n, THREE.RedFormat, THREE.UnsignedByteType);
  tex.name = 'post/smaaSearch';
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}
