/**
 * CPU mirror of the GPU wave field.
 *
 * WHY THIS AND NOT A READBACK
 * Physics calls `sample()` a few hundred times a frame, so it has to be a plain
 * CPU evaluation. Reading the GPU displacement back would either stall the
 * pipeline or arrive two frames late. Instead we run the *same* inverse FFT on
 * the CPU at a lower grid resolution, over the same tile, with the same spectrum
 * and — crucially — the same random numbers, indexed by mode number (see
 * `Noise.ts`). The CPU field is therefore not a similar-looking approximation:
 * it is the GPU field with its highest-wavenumber modes truncated.
 *
 * ACCURACY
 * Grid sizes are chosen so each cascade's whole band fits below the CPU grid's
 * Nyquist wherever it matters:
 *   cascade 0 (2048 m tile, waves >  85 m) — 64x64, exact
 *   cascade 1 ( 512 m tile, waves >  21 m) — 64x64, exact
 *   cascade 2 ( 128 m tile, waves > 5.3 m) — 32x32, exact above 8 m
 *   cascade 3 (  32 m tile, waves > 0.25 m) — 32x32, exact above 2 m
 * So every wave that can move a 53 m / 2200 t hull is reproduced bit-for-bit
 * (modulo the GPU's half-float storage, ~0.05% of amplitude). What is missing is
 * the sub-8 m ripple content of the two fine cascades.
 *
 * `world.ext.ocean.debugCompare()` does a one-shot synchronous readback and
 * reports the actual RMS/max difference, so the claim above is checkable. It is
 * never called from `update()`.
 */

import * as THREE from 'three';
import type { WaveSample } from '../types';
import { CpuFft } from './CpuFft';
import {
  HANDOVER_OCTAVES,
  modeVariance,
  type CascadeLayout,
  type SpectrumParams,
  dispersion,
} from './Spectrum';
import type { SpectralNoise } from './Noise';

/**
 * Cost ceiling per cascade index. A CPU FFT is O(m^2 log m) in JavaScript and
 * runs every frame, so the budget goes to the cascades that actually move a
 * 2200 t hull: the coarsest carries the swell and gets the big grid, the finest
 * carries centimetre ripple that no hull can feel and gets the smallest.
 */
const CPU_GRID_CAP = [128, 64, 32, 32];

function pow2ceil(x: number): number {
  let n = 16;
  while (n < x) n *= 2;
  return n;
}

/**
 * Grid that just covers a cascade's band. A grid of m over a tile of L reaches
 * k = pi*m/L, so covering the band (including the top of the crossfade, which
 * is kMax shifted up by HANDOVER_OCTAVES) needs m >= kTop*L/pi. Capped both by
 * the budget above and by the GPU's own mode count — carrying modes the GPU
 * does not render would make the CPU field wronger, not righter.
 */
function cpuGridFor(layout: CascadeLayout, index: number): number {
  const cap = CPU_GRID_CAP[Math.min(index, CPU_GRID_CAP.length - 1)];
  if (!Number.isFinite(layout.kMax)) return Math.min(cap, layout.n);
  const kTop = layout.kMax * Math.pow(2, HANDOVER_OCTAVES);
  const need = pow2ceil((kTop * layout.size) / Math.PI);
  return Math.max(16, Math.min(cap, layout.n, need));
}

interface CpuCascade {
  layout: CascadeLayout;
  m: number;
  fft: CpuFft;
  /** (sr, si, dr, di) per mode — the time-independent half of h(k,t). */
  h0: Float32Array;
  /** Angular frequency per mode. */
  omega: Float32Array;
  /** Three complex packing coefficients per mode. */
  coef: Float32Array;
  /** Work buffer: spectrum in, spatial field out. */
  work: Float32Array;
}

export class CpuWaves {
  private cascades: CpuCascade[] = [];
  private params: SpectrumParams | null = null;
  private noise: SpectralNoise;
  /** Scratch for sample(): never allocate per call. */
  private acc = new Float32Array(6);
  /** Floating-origin offset, already reduced onto the coarsest tile. */
  private originX = 0;
  private originZ = 0;

  constructor(noise: SpectralNoise) {
    this.noise = noise;
  }

  /**
   * The GPU samples the cascades in wrapped-absolute XZ. Adding the same offset
   * here is what keeps the two fields the same field rather than two
   * realisations that merely look alike.
   */
  setOrigin(x: number, z: number): void {
    this.originX = x;
    this.originZ = z;
  }

  /** CPU grid size actually chosen for cascade `i`. */
  gridSize(i: number): number {
    return this.cascades[i]?.m ?? 0;
  }

  build(layouts: CascadeLayout[]): void {
    this.cascades = layouts.map((layout, i) => {
      const m = cpuGridFor(layout, i);
      return {
        layout,
        m,
        fft: new CpuFft(m),
        h0: new Float32Array(m * m * 4),
        omega: new Float32Array(m * m),
        coef: new Float32Array(m * m * 6),
        work: new Float32Array(m * m * 6),
      };
    });
  }

  /** Rebuild the static spectrum. Called only when the weather actually moves. */
  setParams(p: SpectrumParams): void {
    this.params = p;
    const noise = this.noise;
    for (const c of this.cascades) {
      const { m, layout } = c;
      const dk = (2 * Math.PI) / layout.size;
      const half = m / 2;
      for (let j = 0; j < m; j++) {
        const mm = j < half ? j : j - m;
        for (let i = 0; i < m; i++) {
          const nn = i < half ? i : i - m;
          const idx = j * m + i;
          // The grid's own Nyquist row has no conjugate partner inside the
          // grid; zero it so the truncated field stays real.
          if (nn === -half || mm === -half || (nn === 0 && mm === 0)) {
            c.h0[idx * 4] = 0;
            c.h0[idx * 4 + 1] = 0;
            c.h0[idx * 4 + 2] = 0;
            c.h0[idx * 4 + 3] = 0;
            c.omega[idx] = 0;
            continue;
          }
          const kx = nn * dk;
          const kz = mm * dk;
          const k = Math.hypot(kx, kz);
          const varP = modeVariance(kx, kz, dk, p, layout);
          const varN = modeVariance(-kx, -kz, dk, p, layout);
          const ap = Math.sqrt(varP * 0.5);
          const an = Math.sqrt(varN * 0.5);
          const pr = ap * noise.re(nn, mm);
          const pi = ap * noise.im(nn, mm);
          const nr = an * noise.re(-nn, -mm);
          const ni = an * noise.im(-nn, -mm);
          // h(k,t) = h0(k)e^{iwt} + conj(h0(-k))e^{-iwt} collapses to
          //   Re = (pr+nr)cos - (pi+ni)sin ; Im = (pr-nr)sin + (pi-ni)cos
          c.h0[idx * 4] = pr + nr;
          c.h0[idx * 4 + 1] = pi + ni;
          c.h0[idx * 4 + 2] = pr - nr;
          c.h0[idx * 4 + 3] = pi - ni;
          c.omega[idx] = dispersion(k);

          const invK = 1 / k;
          const lam = p.choppiness;
          // P0 = Dy + i*sx  -> h * (1 - kx). Pairing an even coefficient with
          // an odd one always collapses to a real multiplier of h; the even
          // half lands in Re and the odd half in Im after the transform.
          c.coef[idx * 6] = 1 - kx;
          c.coef[idx * 6 + 1] = 0;
          // P1 = sz + i*(Jxx+Jzz) -> h * i*(kz + k*lam)
          c.coef[idx * 6 + 2] = 0;
          c.coef[idx * 6 + 3] = kz + k * lam;
          // P2 = Dx + i*Dz -> h * (lam/k)(kz - i*kx)
          c.coef[idx * 6 + 4] = lam * kz * invK;
          c.coef[idx * 6 + 5] = -lam * kx * invK;
        }
      }
    }
  }

  /** Advance to absolute sim time `t`. Allocation free. */
  update(t: number): void {
    for (const c of this.cascades) {
      const { m, h0, omega, coef, work } = c;
      const count = m * m;
      for (let i = 0; i < count; i++) {
        const w = omega[i];
        const o4 = i * 4;
        const o6 = i * 6;
        if (w === 0) {
          work[o6] = 0; work[o6 + 1] = 0;
          work[o6 + 2] = 0; work[o6 + 3] = 0;
          work[o6 + 4] = 0; work[o6 + 5] = 0;
          continue;
        }
        const ph = w * t;
        const cs = Math.cos(ph);
        const sn = Math.sin(ph);
        const hr = h0[o4] * cs - h0[o4 + 1] * sn;
        const hi = h0[o4 + 2] * sn + h0[o4 + 3] * cs;
        for (let ch = 0; ch < 3; ch++) {
          const cr = coef[o6 + ch * 2];
          const ci = coef[o6 + ch * 2 + 1];
          work[o6 + ch * 2] = cr * hr - ci * hi;
          work[o6 + ch * 2 + 1] = cr * hi + ci * hr;
        }
      }
      c.fft.transform2D(work);
    }
  }

  /**
   * Bilinear-accumulate all six fields at world XZ into `this.acc`:
   *   [Dy, sx, sz, Jsum, Dx, Dz]
   */
  private gather(wx: number, wz: number): void {
    const x = wx + this.originX;
    const z = wz + this.originZ;
    const acc = this.acc;
    acc[0] = 0; acc[1] = 0; acc[2] = 0; acc[3] = 0; acc[4] = 0; acc[5] = 0;
    for (let ci = 0; ci < this.cascades.length; ci++) {
      const c = this.cascades[ci];
      const m = c.m;
      const inv = m / c.layout.size;
      const fx = x * inv;
      const fz = z * inv;
      let i0 = Math.floor(fx);
      let j0 = Math.floor(fz);
      const tx = fx - i0;
      const tz = fz - j0;
      i0 = ((i0 % m) + m) % m;
      j0 = ((j0 % m) + m) % m;
      const i1 = i0 + 1 === m ? 0 : i0 + 1;
      const j1 = j0 + 1 === m ? 0 : j0 + 1;
      const w = c.work;
      const b00 = (j0 * m + i0) * 6;
      const b10 = (j0 * m + i1) * 6;
      const b01 = (j1 * m + i0) * 6;
      const b11 = (j1 * m + i1) * 6;
      const w00 = (1 - tx) * (1 - tz);
      const w10 = tx * (1 - tz);
      const w01 = (1 - tx) * tz;
      const w11 = tx * tz;
      for (let k = 0; k < 6; k++) {
        acc[k] += w[b00 + k] * w00 + w[b10 + k] * w10 + w[b01 + k] * w01 + w[b11 + k] * w11;
      }
    }
  }

  height(wx: number, wz: number): number {
    const x = wx + this.originX;
    const z = wz + this.originZ;
    let h = 0;
    for (let ci = 0; ci < this.cascades.length; ci++) {
      const c = this.cascades[ci];
      const m = c.m;
      const inv = m / c.layout.size;
      const fx = x * inv;
      const fz = z * inv;
      let i0 = Math.floor(fx);
      let j0 = Math.floor(fz);
      const tx = fx - i0;
      const tz = fz - j0;
      i0 = ((i0 % m) + m) % m;
      j0 = ((j0 % m) + m) % m;
      const i1 = i0 + 1 === m ? 0 : i0 + 1;
      const j1 = j0 + 1 === m ? 0 : j0 + 1;
      const w = c.work;
      h +=
        w[(j0 * m + i0) * 6] * (1 - tx) * (1 - tz) +
        w[(j0 * m + i1) * 6] * tx * (1 - tz) +
        w[(j1 * m + i0) * 6] * (1 - tx) * tz +
        w[(j1 * m + i1) * 6] * tx * tz;
    }
    return h;
  }

  sample(x: number, z: number, out: WaveSample): WaveSample {
    this.gather(x, z);
    const a = this.acc;
    const p = this.params;
    out.height = a[0];
    out.dx = a[4];
    out.dz = a[5];
    // Full displaced-surface normal needs the whole Jacobian; on the CPU we
    // carry only its trace, so split it evenly and drop the shear term.
    const jh = 1 + a[3] * 0.5;
    out.normal.set(-a[1], Math.max(jh, 0.05), -a[2]).normalize();
    if (p) {
      // Deep-water linear theory: horizontal orbital velocity is w*eta along
      // the wave direction, vertical velocity is -w times the along-direction
      // horizontal displacement. Uses the dominant wave's frequency.
      const w = p.peakOmega;
      out.velocity.set(
        w * a[0] * p.windDirX,
        -w * (a[4] * p.windDirX + a[5] * p.windDirZ),
        w * a[0] * p.windDirZ,
      );
    } else {
      out.velocity.set(0, 0, 0);
    }
    return out;
  }

  /** Instantaneous fold-based foam estimate, 0..1. No persistence — see Foam.ts. */
  foamAt(x: number, z: number): number {
    this.gather(x, z);
    const fold = 1 + this.acc[3];
    return THREE.MathUtils.clamp((0.62 - fold) * 2.4, 0, 1);
  }

  /** Largest |Dy| on the coarsest grid — a safe bound for culling. */
  maxHeight(): number {
    let mx = 0;
    for (const c of this.cascades) {
      const count = c.m * c.m;
      let cm = 0;
      for (let i = 0; i < count; i++) {
        const v = Math.abs(c.work[i * 6]);
        if (v > cm) cm = v;
      }
      mx += cm;
    }
    return mx;
  }
}
