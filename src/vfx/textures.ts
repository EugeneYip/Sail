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

/** Tileable Worley F1 distance, normalised roughly to 0..1. */
function worley(x: number, y: number, cells: number, seed: number): number {
  const cx = Math.floor(x);
  const cy = Math.floor(y);
  let best = 1e9;
  const w = (v: number) => ((v % cells) + cells) % cells;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const gx = cx + i;
      const gy = cy + j;
      const px = gx + hash2i(w(gx), w(gy), seed);
      const py = gy + hash2i(w(gx), w(gy), seed + 977);
      const dx = px - x;
      const dy = py - y;
      const d = dx * dx + dy * dy;
      if (d < best) best = d;
    }
  }
  return Math.min(1, Math.sqrt(best) * 1.35);
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
 * Soft aerated blob for mist, spindrift and spray sheets.
 *   R = coarse density detail
 *   G = fine erosion detail
 *   B = light-through thickness
 *   A = coverage
 */
export function makeMistTexture(size = 64): THREE.DataTexture {
  const d = new Uint8Array(size * size * 4);
  const c = (size - 1) * 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = (x - c) / c;
      const ny = (y - c) / c;
      const r = Math.hypot(nx, ny);
      const u = x / size;
      const v = y / size;
      const n1 = fbm2(u * 4, v * 4, 4, 4, 11);
      const n2 = fbm2(u * 10, v * 10, 10, 3, 47);
      const radial = Math.pow(sat(1 - r), 2.1);
      const alpha = sat(radial * (0.45 + 0.85 * n1) * 1.5);
      const i = (y * size + x) * 4;
      d[i] = b(n1);
      d[i + 1] = b(n2);
      d[i + 2] = b(Math.pow(sat(1 - r * 0.85), 1.4));
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
 *   R = bubble clusters (worley), G = stretched streaks, B = fine sparkle,
 *   A = coarse coverage
 */
export function makeFoamTexture(size = 256): THREE.DataTexture {
  const d = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const w1 = 1 - worley(u * 9, v * 9, 9, 3);
      const w2 = 1 - worley(u * 22, v * 22, 22, 91);
      const bubbles = sat(w1 * 0.72 + w2 * 0.45);
      // Streaks: strongly anisotropic fBm, long axis along +u (aft in wake UV).
      const streak = fbm2(u * 3.0, v * 15.0, 3, 4, 707);
      const sparkle = fbm2(u * 40, v * 40, 40, 2, 1301);
      const coarse = fbm2(u * 5, v * 5, 5, 4, 1607);
      const i = (y * size + x) * 4;
      d[i] = b(bubbles);
      d[i + 1] = b(streak);
      d[i + 2] = b(sparkle);
      d[i + 3] = b(coarse);
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
  smoke: THREE.DataTexture;
  foam: THREE.DataTexture;
  streak: THREE.DataTexture;
  dispose(): void;
}

export function createVfxTextures(): VfxTextures {
  const droplet = makeDropletTexture(64);
  const mist = makeMistTexture(64);
  const smoke = makeSmokeTexture(128);
  const foam = makeFoamTexture(256);
  const streak = makeStreakTexture(32, 128);
  return {
    droplet,
    mist,
    smoke,
    foam,
    streak,
    dispose() {
      droplet.dispose();
      mist.dispose();
      smoke.dispose();
      foam.dispose();
      streak.dispose();
    },
  };
}
