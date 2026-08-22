import * as THREE from 'three';

/**
 * Procedural 3D look LUTs.
 *
 * Four looks are authored as parameter sets, baked into 32^3 cubes at init and
 * stacked along Z into a single `Data3DTexture` (32 x 32 x 32*4). Blending
 * between looks then costs two tetrahedral lookups in the composite instead of a
 * per-frame CPU rebake of 32768 texels — the time of day changes every frame, so
 * a CPU rebake would be a permanent 1-2 ms hitch.
 *
 * The domain is display-referred AND display-ENCODED: these run after `agx()`,
 * which ends on the AgX outset matrix without the EOTF, so its output is already
 * sRGB-gamma in [0,1] and nothing after it re-encodes (see composite.ts). That is
 * where a look LUT belongs — grading scene-linear radiance means the grade fights
 * the tone curve — and it is why `pivot` sits near 0.45: AgX puts an 18 % grey
 * card at 0.496 in this domain, so a pivot just below that adds contrast while
 * leaving middle grey almost exactly where the meter put it.
 *
 * These were authored while a stray second sRGB encode was lifting middle grey
 * from 0.50 to 0.72, so everything was tuned against an image that was already
 * three-quarters white: contrast near 1.0, saturation near 1.0, and lifted black
 * floors all looked reasonable there and are far too timid on a correct frame.
 * The numbers below are the re-authored set. The parameters that carry the look
 * are `contrast`, `vibrance` and `blueTeal`; `gain`/`lift` are trims, not the
 * grade, and pushing them is how a frame ends up looking like a filter.
 */

export interface Look {
  name: string;
  /**
   * -1 cool .. +1 warm, applied as a von-Kries-ish channel balance.
   *
   * These went up by ~0.09 each when the AgX inset matrix was un-transposed
   * (DIAGNOSIS 74). The transposed inset had been handing the grade a frame
   * already +9 codes warm in R-B, and every look here was authored to sit on
   * top of that, so their temps had drifted cool to cancel it. With the inset
   * neutral, that cool bias was left uncompensated and every frame went cold;
   * these values put a neutral back where it was on screen. That is why a look
   * called 'Cold Morning' now carries a slightly positive temp -- the number is
   * the look's own white balance now, and no longer half a tonemapper fix.
   */
  temp: number;
  gain: [number, number, number];
  lift: [number, number, number];
  gamma: [number, number, number];
  contrast: number;
  pivot: number;
  saturation: number;
  /** Extra saturation applied only to already-dull colours. */
  vibrance: number;
  shadowTint: [number, number, number];
  highlightTint: [number, number, number];
  /** Shifts where the shadow/highlight split sits, -0.3 .. +0.3. */
  toneBalance: number;
  /** Rotates blues toward teal — the single most "cinematic ocean" move there is. */
  blueTeal: number;
  /** Highlight soft-clip strength, keeps a low sun off flat white. */
  shoulder: number;
  /** Film base density: absolute black is a video look, not a film look. */
  blackFloor: number;
}

/** Ordered by sun elevation; the composite picks the two that bracket it. */
export const LOOK_KEYS = [-0.2, 0.0, 0.16, 0.5];

export const LOOKS: Look[] = [
  {
    name: 'Blue Hour',
    temp: -0.132,
    gain: [0.9, 0.96, 1.12],
    lift: [0.004, 0.006, 0.012],
    gamma: [1.0, 1.0, 1.06],
    contrast: 1.12,
    pivot: 0.3,
    // Rods are achromatic: a saturated night reads as a teal filter, not as night.
    saturation: 0.68,
    vibrance: 0.16,
    shadowTint: [0.84, 0.93, 1.2],
    highlightTint: [0.94, 0.99, 1.08],
    toneBalance: -0.08,
    blueTeal: 0.04,
    shoulder: 0.22,
    blackFloor: 0.003,
  },
  {
    name: 'Cold Morning',
    temp: 0.022,
    gain: [1.0, 1.0, 1.035],
    lift: [0.002, 0.003, 0.007],
    gamma: [1.0, 1.0, 1.0],
    contrast: 1.16,
    pivot: 0.44,
    saturation: 1.04,
    vibrance: 0.2,
    shadowTint: [0.92, 0.98, 1.12],
    highlightTint: [1.07, 1.01, 0.95],
    toneBalance: 0.0,
    blueTeal: 0.14,
    shoulder: 0.3,
    blackFloor: 0.002,
  },
  {
    name: 'Amber Reach',
    temp: 0.227,
    gain: [1.055, 1.0, 0.935],
    lift: [0.0, 0.002, 0.006],
    gamma: [0.99, 1.0, 1.025],
    contrast: 1.18,
    pivot: 0.45,
    saturation: 1.1,
    vibrance: 0.14,
    // A warm key wants a genuinely cool fill or the whole frame reads as one
    // sepia wash, which is the classic golden-hour failure. The shadow tint is
    // the only thing in the grade that can put the blue back into water that is
    // reflecting a sky the sun has already left.
    shadowTint: [0.83, 0.95, 1.24],
    highlightTint: [1.1, 1.02, 0.89],
    toneBalance: 0.06,
    blueTeal: 0.12,
    // A low sun is the one thing guaranteed to be blown out; give it a shoulder.
    shoulder: 0.42,
    blackFloor: 0.0018,
  },
  {
    name: 'Open Sea',
    temp: 0.069,
    gain: [1.0, 1.0, 1.012],
    lift: [0.0, 0.0005, 0.002],
    gamma: [1.0, 1.0, 1.0],
    contrast: 1.22,
    pivot: 0.46,
    saturation: 1.12,
    vibrance: 0.16,
    shadowTint: [0.94, 0.99, 1.1],
    highlightTint: [1.03, 1.01, 0.98],
    toneBalance: 0.02,
    blueTeal: 0.2,
    shoulder: 0.32,
    blackFloor: 0.0012,
  },
];

export const LUT_SIZE = 32;

const LUMA = [0.2126, 0.7152, 0.0722] as const;

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function applyLook(look: Look, rgb: [number, number, number]): [number, number, number] {
  let [r, g, b] = rgb;

  // White balance. Kept luma-neutral so temp does not double as an exposure.
  const t = look.temp;
  const wbR = 1 + 0.34 * t;
  const wbG = 1 + 0.04 * t;
  const wbB = 1 - 0.3 * t;
  const wbNorm = 1 / (LUMA[0] * wbR + LUMA[1] * wbG + LUMA[2] * wbB);
  r *= wbR * wbNorm;
  g *= wbG * wbNorm;
  b *= wbB * wbNorm;

  r = r * look.gain[0] + look.lift[0];
  g = g * look.gain[1] + look.lift[1];
  b = b * look.gain[2] + look.lift[2];

  r = Math.pow(Math.max(r, 0), 1 / look.gamma[0]);
  g = Math.pow(Math.max(g, 0), 1 / look.gamma[1]);
  b = Math.pow(Math.max(b, 0), 1 / look.gamma[2]);

  // Contrast about the pivot. Above the pivot this is the straight line the
  // looks were authored against, unchanged. Below it the line is replaced by the
  // log-space slope it was approximating, because the line has an x-intercept at
  // `pivot * (1 - 1/contrast)` — 0.083 for Open Sea, sRGB code 21 — so every
  // value AgX placed below code 21 came out NEGATIVE and the `clamp01` in the
  // black-floor line below turned it into black. The 32-node lattice then
  // quantised that intercept up to a whole node, so the entire bottom 16 codes
  // of the AgX output sat flat on the floor.
  //
  // Measured whole-frame, one frozen frame, against the same frame with
  // `uLookAmount` 0 (which is AgX alone): AgX code 12 -> 0.1, 16 -> 0.4,
  // 24 -> 5.1, 32 -> 13.5, and unity only above 116. That is the shadow crush
  // DIAGNOSIS §68a attributed to the cos^4 vignette. It is not the vignette:
  // ablating the vignette in the same frame moves the transfer by under a code
  // at every level, and the vignette runs on scene-linear radiance BEFORE the
  // tonemap, which is the correct side of it.
  //
  // The two branches meet at the pivot with the same value and the same slope —
  // d/dx of `pivot * (x/pivot)^c` is exactly `c` at x = pivot — so there is no
  // kink, and by construction nothing above the pivot moves by a single code.
  const con = (x: number): number => {
    if (x >= look.pivot) return (x - look.pivot) * look.contrast + look.pivot;
    return x <= 0 ? 0 : look.pivot * Math.pow(x / look.pivot, look.contrast);
  };
  r = con(r);
  g = con(g);
  b = con(b);

  // Split tone. A smoothstep on luma, biased by toneBalance, so shadows and
  // highlights get independent tints without a visible crossover band.
  let luma = LUMA[0] * r + LUMA[1] * g + LUMA[2] * b;
  const s = clamp01((luma - look.toneBalance - 0.15) / 0.7);
  const w = s * s * (3 - 2 * s);
  r *= look.shadowTint[0] + (look.highlightTint[0] - look.shadowTint[0]) * w;
  g *= look.shadowTint[1] + (look.highlightTint[1] - look.shadowTint[1]) * w;
  b *= look.shadowTint[2] + (look.highlightTint[2] - look.shadowTint[2]) * w;

  // Blue -> teal: lift green in proportion to how much blue dominates red.
  const blueness = clamp01((b - r) * 1.6);
  g += (b - g) * blueness * look.blueTeal;

  luma = LUMA[0] * r + LUMA[1] * g + LUMA[2] * b;
  const mx = Math.max(r, Math.max(g, b));
  const mn = Math.min(r, Math.min(g, b));
  const sat = mx > 1e-4 ? (mx - mn) / mx : 0;
  // Vibrance pushes dull colours only; that is what keeps skin/canvas from
  // going lurid while still deepening a flat grey sea.
  const satBoost = look.saturation + look.vibrance * (1 - sat);
  r = luma + (r - luma) * satBoost;
  g = luma + (g - luma) * satBoost;
  b = luma + (b - luma) * satBoost;

  // Highlight shoulder: soft-clip the top so a sun disc rolls off instead of
  // hitting a flat white plateau. Only bites above ~0.72.
  const knee = 0.72;
  const shoulder = (x: number): number => {
    if (x <= knee) return x;
    const over = (x - knee) / Math.max(1e-4, 1 - knee);
    const rolled = 1 - Math.exp(-over * (1 + look.shoulder * 2));
    return knee + (1 - knee) * (over * (1 - look.shoulder) + rolled * look.shoulder);
  };
  r = shoulder(r);
  g = shoulder(g);
  b = shoulder(b);

  const f = look.blackFloor;
  r = f + clamp01(r) * (1 - f);
  g = f + clamp01(g) * (1 - f);
  b = f + clamp01(b) * (1 - f);

  return [r, g, b];
}

/**
 * Bake every look into one stacked 3D texture. RGBA float: 32*32*128*16 bytes
 * = 2.1 MB, uploaded once.
 */
export function makeLookTexture(): THREE.Data3DTexture {
  const n = LUT_SIZE;
  const slabs = LOOKS.length;
  const data = new Float32Array(n * n * n * slabs * 4);
  const inv = 1 / (n - 1);
  let o = 0;
  for (let s = 0; s < slabs; s++) {
    const look = LOOKS[s];
    for (let z = 0; z < n; z++) {
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const [r, g, b] = applyLook(look, [x * inv, y * inv, z * inv]);
          data[o++] = r;
          data[o++] = g;
          data[o++] = b;
          data[o++] = 1;
        }
      }
    }
  }
  const tex = new THREE.Data3DTexture(data, n, n, n * slabs);
  tex.name = 'post/look';
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.FloatType;
  // Tetrahedral interpolation fetches exact corners; hardware filtering would
  // both fight it and bleed across the slab boundaries.
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.wrapR = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Which two look slabs bracket this sun elevation, and how far between them.
 * Written into a reusable object — this runs every frame.
 */
export function resolveLookBlend(sunY: number, out: { a: number; b: number; mix: number }): void {
  if (sunY <= LOOK_KEYS[0]) {
    out.a = 0;
    out.b = 0;
    out.mix = 0;
    return;
  }
  const last = LOOK_KEYS.length - 1;
  if (sunY >= LOOK_KEYS[last]) {
    out.a = last;
    out.b = last;
    out.mix = 0;
    return;
  }
  for (let i = 0; i < last; i++) {
    if (sunY < LOOK_KEYS[i + 1]) {
      const t = (sunY - LOOK_KEYS[i]) / (LOOK_KEYS[i + 1] - LOOK_KEYS[i]);
      out.a = i;
      out.b = i + 1;
      out.mix = t * t * (3 - 2 * t);
      return;
    }
  }
}
