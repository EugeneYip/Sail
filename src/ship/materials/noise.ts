/**
 * Tileable CPU noise for the procedural texture library.
 *
 * Everything is periodic on the [0,1) UV square so the textures tile
 * seamlessly: the lattice index is wrapped modulo the octave's cell count
 * before hashing. The anisotropic variants take separate periods per axis,
 * which is what makes wood grain, rope lay and salt streaking directional.
 */

export function lattice(ix: number, iy: number, seed: number): number {
  let h = (ix * 374761393 + iy * 668265263 + seed * 1274126177) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function wrap(i: number, per: number): number {
  return ((i % per) + per) % per;
}

export function vnoise(x: number, y: number, perX: number, perY: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const wx0 = wrap(x0, perX);
  const wx1 = wrap(x0 + 1, perX);
  const wy0 = wrap(y0, perY);
  const wy1 = wrap(y0 + 1, perY);
  const a = lattice(wx0, wy0, seed);
  const b = lattice(wx1, wy0, seed);
  const c = lattice(wx0, wy1, seed);
  const d = lattice(wx1, wy1, seed);
  const ab = a + (b - a) * ux;
  const cd = c + (d - c) * ux;
  return ab + (cd - ab) * uy;
}

/** Anisotropic tileable fBm over the unit square. */
export function fbm(
  u: number, v: number, perX: number, perY: number, octaves: number, seed: number, gain = 0.5,
): number {
  let amp = 0.5;
  let sum = 0;
  let norm = 0;
  let px = perX;
  let py = perY;
  for (let i = 0; i < octaves; i++) {
    sum += amp * vnoise(u * px, v * py, px, py, seed + i * 7919);
    norm += amp;
    amp *= gain;
    px *= 2;
    py *= 2;
  }
  return sum / norm;
}

/** Ridged multifractal — thin bright filaments. Good for grain and rope lay. */
export function ridged(
  u: number, v: number, perX: number, perY: number, octaves: number, seed: number,
): number {
  let amp = 0.5;
  let sum = 0;
  let norm = 0;
  let px = perX;
  let py = perY;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(vnoise(u * px, v * py, px, py, seed + i * 6151) * 2 - 1);
    sum += amp * n * n;
    norm += amp;
    amp *= 0.5;
    px *= 2;
    py *= 2;
  }
  return sum / norm;
}

/** Tileable Worley F1, normalised to roughly 0..1 over one cell. */
export function worley(u: number, v: number, per: number, seed: number): number {
  const px = u * per;
  const py = v * per;
  const ix = Math.floor(px);
  const iy = Math.floor(py);
  let best = 9;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const cx = wrap(ix + i, per);
      const cy = wrap(iy + j, per);
      const dx = ix + i + lattice(cx, cy, seed) - px;
      const dy = iy + j + lattice(cx, cy, seed + 977) - py;
      const d = dx * dx + dy * dy;
      if (d < best) best = d;
    }
  }
  return Math.sqrt(best);
}

/** Worley that also reports which cell won, for per-cell randomisation. */
export function worleyCell(u: number, v: number, per: number, seed: number, out: { d: number; r: number }): void {
  const px = u * per;
  const py = v * per;
  const ix = Math.floor(px);
  const iy = Math.floor(py);
  let best = 9;
  let bx = 0;
  let by = 0;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const cx = wrap(ix + i, per);
      const cy = wrap(iy + j, per);
      const dx = ix + i + lattice(cx, cy, seed) - px;
      const dy = iy + j + lattice(cx, cy, seed + 977) - py;
      const d = dx * dx + dy * dy;
      if (d < best) {
        best = d;
        bx = cx;
        by = cy;
      }
    }
  }
  out.d = Math.sqrt(best);
  out.r = lattice(bx, by, seed + 5501);
}

export function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
