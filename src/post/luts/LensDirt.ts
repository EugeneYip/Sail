import * as THREE from 'three';

/**
 * Procedural lens dirt mask, baked once at init.
 *
 * The mask multiplies the *bloom* only, so it is invisible unless something
 * bright is in frame. What it has to look like is therefore not "dirt" but
 * "what a dirty front element does to a strong light source": a few hundred
 * dust motes, a handful of long cleaning scratches, and a broad low-frequency
 * smear from a thumb. Uniform noise reads as film damage, not as glass.
 *
 * 16:9 and deliberately low resolution — a speck is ~6 screen pixels at 1600
 * wide, which is the right size for dust, and the whole thing is 36 KB.
 */
const W = 256;
const H = 144;

/** Deterministic — the dirt must not change between runs or between captures. */
function makeRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function smoothNoise(rnd: () => number, w: number, h: number): Float32Array {
  const lat = new Float32Array(w * h);
  for (let i = 0; i < lat.length; i++) lat[i] = rnd();
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const fy = (y / H) * h;
    const y0 = Math.floor(fy);
    const ty = fy - y0;
    const wy = ty * ty * (3 - 2 * ty);
    for (let x = 0; x < W; x++) {
      const fx = (x / W) * w;
      const x0 = Math.floor(fx);
      const tx = fx - x0;
      const wx = tx * tx * (3 - 2 * tx);
      const i00 = (y0 % h) * w + (x0 % w);
      const i10 = (y0 % h) * w + ((x0 + 1) % w);
      const i01 = ((y0 + 1) % h) * w + (x0 % w);
      const i11 = ((y0 + 1) % h) * w + ((x0 + 1) % w);
      const a = lat[i00] + (lat[i10] - lat[i00]) * wx;
      const b = lat[i01] + (lat[i11] - lat[i01]) * wx;
      out[y * W + x] = a + (b - a) * wy;
    }
  }
  return out;
}

export function makeLensDirtTexture(): THREE.DataTexture {
  const rnd = makeRandom(0x5ea17e11);
  const acc = new Float32Array(W * H);

  // Thumb smear: two octaves of very low frequency, biased so most of the
  // frame is clean and a couple of regions are hazy.
  const n1 = smoothNoise(rnd, 5, 3);
  const n2 = smoothNoise(rnd, 11, 7);
  for (let i = 0; i < acc.length; i++) {
    const v = n1[i] * 0.68 + n2[i] * 0.32;
    acc[i] = Math.max(0, v - 0.52) * 1.35;
  }

  const splat = (cx: number, cy: number, radius: number, amp: number): void => {
    const r = Math.max(0.6, radius);
    const x0 = Math.max(0, Math.floor(cx - r - 1));
    const x1 = Math.min(W - 1, Math.ceil(cx + r + 1));
    const y0 = Math.max(0, Math.floor(cy - r - 1));
    const y1 = Math.min(H - 1, Math.ceil(cy + r + 1));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        const d = Math.sqrt(dx * dx + dy * dy) / r;
        if (d >= 1) continue;
        const f = 1 - d * d;
        acc[y * W + x] += amp * f * f;
      }
    }
  };

  // Dust. A power distribution on the radius: mostly invisible motes, a few
  // that actually read.
  for (let i = 0; i < 620; i++) {
    const cx = rnd() * W;
    const cy = rnd() * H;
    const t = rnd();
    const radius = 0.5 + Math.pow(t, 3.2) * 5.5;
    splat(cx, cy, radius, 0.35 + rnd() * 0.9);
  }

  // Cleaning scratches: long, thin, faint, all roughly one diagonal family
  // because that is how a lens cloth is actually dragged across the glass.
  for (let i = 0; i < 26; i++) {
    const ang = -0.55 + (rnd() - 0.5) * 0.9;
    const len = 20 + rnd() * 120;
    let x = rnd() * W;
    let y = rnd() * H;
    const dx = Math.cos(ang);
    const dy = Math.sin(ang);
    const amp = 0.1 + rnd() * 0.22;
    const rad = 0.55 + rnd() * 0.7;
    const steps = Math.ceil(len);
    for (let s = 0; s < steps; s++) {
      // Wobble so the scratch is not a ruler line.
      const wob = Math.sin(s * 0.21 + i) * 0.35;
      splat(x - dy * wob, y + dx * wob, rad, amp * (0.4 + 0.6 * Math.sin((s / steps) * Math.PI)));
      x += dx;
      y += dy;
      if (x < -4 || x > W + 4 || y < -4 || y > H + 4) break;
    }
  }

  let max = 0;
  for (let i = 0; i < acc.length; i++) max = Math.max(max, acc[i]);
  const inv = max > 0 ? 1 / max : 1;

  const data = new Uint8Array(W * H);
  for (let i = 0; i < acc.length; i++) {
    data[i] = Math.round(Math.min(1, acc[i] * inv) * 255);
  }

  const tex = new THREE.DataTexture(data, W, H, THREE.RedFormat, THREE.UnsignedByteType);
  tex.name = 'post/lensDirt';
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/** 1x1 black, used wherever an optional input texture is switched off. */
export function makeBlackTexture(): THREE.DataTexture {
  const tex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat);
  tex.name = 'post/black';
  tex.needsUpdate = true;
  return tex;
}
