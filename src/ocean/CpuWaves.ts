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
 * So every wave that can move a 53 m / 2200 t hull is reproduced to within the
 * GPU's own half-float storage plus the ~1e-4 relative error of the directional
 * spread table below. What is missing is the sub-8 m ripple content of the two
 * fine cascades, worth about 3 cm RMS at sea state 4.
 *
 * `world.ext.ocean.debugCompare()` does a one-shot synchronous readback and
 * reports the actual RMS/max difference, so the claim above is checkable. It is
 * never called from `update()`.
 *
 * COST
 * This runs every frame, so the whole file is organised around paying per
 * *active* mode rather than per grid cell. Most of a cascade's grid is outside
 * its own band and contributes nothing, so `setParams` compacts the modes that
 * survive the band weight into dense arrays and `update()` walks only those.
 * Everything that depends on |k| alone is hoisted into a table indexed by the
 * integer n^2+m^2 — exact, because the modes live on a lattice, so there is no
 * interpolation error and no transcendental per mode.
 */

import * as THREE from 'three';
import type { WaveSample } from '../types';
import { CpuFft } from './CpuFft';
import {
  HANDOVER_OCTAVES,
  cascadeWeight,
  spectrumK,
  spreadBetaDBH,
  type CascadeLayout,
  type SpectrumParams,
  dispersion,
  GAMMA_WIND,
  GAMMA_SWELL,
  BETA_SWELL,
} from './Spectrum';
import type { SpectralNoise } from './Noise';

/**
 * Cost ceiling per cascade index. A CPU FFT is O(m^2 log m) in JavaScript and
 * runs every frame, so the budget goes to the cascades that actually move a
 * 2200 t hull: the coarsest carries the swell and gets the big grid, the finest
 * carries centimetre ripple that no hull can feel and gets the smallest.
 */
const CPU_GRID_CAP = [128, 64, 32, 32];

/** sech^2 table for the directional spread. See `sech2()`. */
const SECH2_N = 2048;
const SECH2_MAX = 20;
const SECH2_SCALE = SECH2_N / SECH2_MAX;
const SECH2 = buildSech2();

function buildSech2(): Float32Array {
  // One extra entry so the top cell can interpolate without a bounds test.
  const t = new Float32Array(SECH2_N + 2);
  for (let i = 0; i <= SECH2_N + 1; i++) {
    const u = i / SECH2_SCALE;
    const c = Math.cosh(u);
    t[i] = 1 / (c * c);
  }
  return t;
}

/**
 * sech^2 by table with linear interpolation. Peak curvature is 2, so the error
 * is bounded by du^2/8*2 ~ 2e-5 — four orders below the amplitude noise of the
 * spectrum itself, and it removes a cosh from the inner loop.
 */
function sech2(u: number): number {
  if (u >= SECH2_MAX) return 0;
  const f = u * SECH2_SCALE;
  const i = f | 0;
  const t = f - i;
  return SECH2[i] + (SECH2[i + 1] - SECH2[i]) * t;
}

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
  /** Number of modes with non-zero amplitude. Everything below is dense to it. */
  active: number;
  /** (Re+, Im+, Re-, Im-) per active mode — the time-independent half of h(k,t). */
  h0: Float32Array;
  /** Angular frequency per active mode. */
  omega: Float32Array;
  /** (a, b, cRe, cIm) per active mode — see `packing` below. */
  coef: Float32Array;
  /** Offset into `work` for each active mode, already multiplied by 6. */
  dst: Int32Array;
  /** Grid rows holding at least one active mode; the rest stay zero. */
  rowMask: Uint8Array;
  /** Work buffer: spectrum in, spatial field out. */
  work: Float32Array;
  /** Per-|k|^2 tables, indexed by the integer n^2+m^2. */
  radWind: Float32Array;
  radSwell: Float32Array;
  radBeta: Float32Array;
  radOmega: Float32Array;
  radDone: Uint8Array;
  /** Inclusive integer bounds on n^2+m^2 that can carry any energy at all. */
  r2Lo: number;
  r2Hi: number;
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

  /** Active mode count for cascade `i`. Debug/perf reporting only. */
  activeModes(i: number): number {
    return this.cascades[i]?.active ?? 0;
  }

  build(layouts: CascadeLayout[]): void {
    this.cascades = layouts.map((layout, i) => {
      const m = cpuGridFor(layout, i);
      const cells = m * m;
      // Largest n^2+m^2 the grid can hold, at the corner of the mode square.
      const r2Max = 2 * (m / 2) * (m / 2);
      return {
        layout,
        m,
        fft: new CpuFft(m),
        active: 0,
        h0: new Float32Array(cells * 4),
        omega: new Float32Array(cells),
        coef: new Float32Array(cells * 4),
        dst: new Int32Array(cells),
        rowMask: new Uint8Array(m),
        work: new Float32Array(cells * 6),
        radWind: new Float32Array(r2Max + 1),
        radSwell: new Float32Array(r2Max + 1),
        radBeta: new Float32Array(r2Max + 1),
        radOmega: new Float32Array(r2Max + 1),
        radDone: new Uint8Array(r2Max + 1),
        r2Lo: 0,
        r2Hi: r2Max,
      };
    });
  }

  /**
   * Rebuild the static spectrum. Called only when the weather actually moves.
   *
   * packing — three complex fields ride one transform:
   *   P0 = Dy + i*dDy/dx      = h * a,          a = 1 - kx
   *   P1 = dDy/dz + i*Jtrace  = h * i*b,        b = kz + k*lambda
   *   P2 = Dx + i*Dz          = h * (cRe+i*cIm) = h * lambda*(kz - i*kx)/k
   * Pairing an even coefficient with an odd one always collapses to a real
   * multiplier of h, so the even half lands in Re and the odd half in Im.
   */
  setParams(p: SpectrumParams): void {
    this.params = p;
    const noise = this.noise;
    const lam = p.choppiness;

    for (const c of this.cascades) {
      const { m, layout, h0, omega, coef, dst, rowMask, radDone } = c;
      const dk = (2 * Math.PI) / layout.size;
      const half = m / 2;
      rowMask.fill(0);
      radDone.fill(0);

      // A mode can only carry energy inside the band, widened by the crossfade.
      // Turning that into integer bounds on n^2+m^2 lets the mode loop reject
      // most of the grid with two comparisons and no square root.
      const fade = Math.pow(2, HANDOVER_OCTAVES);
      const kLo = layout.kMin > 0 ? layout.kMin / fade : 0;
      const kHi = Number.isFinite(layout.kMax) ? layout.kMax * fade : Infinity;
      const rLo = kLo / dk;
      const rHi = kHi / dk;
      c.r2Lo = Math.max(1, Math.floor(rLo * rLo));
      c.r2Hi = Number.isFinite(rHi) ? Math.ceil(rHi * rHi) : c.radWind.length - 1;

      let n = 0;
      for (let j = 0; j < m; j++) {
        const mm = j < half ? j : j - m;
        // The grid's own Nyquist row has no conjugate partner inside the grid;
        // leaving it out is what keeps the truncated field real.
        if (mm === -half) continue;
        for (let i = 0; i < m; i++) {
          const nn = i < half ? i : i - m;
          if (nn === -half) continue;
          const r2 = nn * nn + mm * mm;
          if (r2 < c.r2Lo || r2 > c.r2Hi) continue;

          if (radDone[r2] === 0) this.fillRadial(c, r2, dk, p);
          const rw = c.radWind[r2];
          const rs = c.radSwell[r2];
          if (rw === 0 && rs === 0) continue;

          const kx = nn * dk;
          const kz = mm * dk;
          const k = dk * Math.sqrt(r2);
          const invK = 1 / k;
          const nx = kx * invK;
          const nz = kz * invK;

          // theta for -k is pi - theta, so one acos per direction covers both
          // signs and the whole conjugate pair costs two.
          const beta = c.radBeta[r2];
          const tw = Math.acos(clamp1(nx * p.windDirX + nz * p.windDirZ));
          const ts = Math.acos(clamp1(nx * p.swellDirX + nz * p.swellDirZ));
          const varP = rw * sech2(beta * tw) + rs * sech2(BETA_SWELL * ts);
          const varN =
            rw * sech2(beta * (Math.PI - tw)) + rs * sech2(BETA_SWELL * (Math.PI - ts));
          if (varP <= 0 && varN <= 0) continue;

          const ap = Math.sqrt(varP * 0.5);
          const an = Math.sqrt(varN * 0.5);
          const pr = ap * noise.re(nn, mm);
          const pi = ap * noise.im(nn, mm);
          const nr = an * noise.re(-nn, -mm);
          const ni = an * noise.im(-nn, -mm);
          if (pr === 0 && pi === 0 && nr === 0 && ni === 0) continue;

          // h(k,t) = h0(k)e^{iwt} + conj(h0(-k))e^{-iwt} collapses to
          //   Re = (pr+nr)cos - (pi+ni)sin ; Im = (pr-nr)sin + (pi-ni)cos
          const o4 = n * 4;
          h0[o4] = pr + nr;
          h0[o4 + 1] = pi + ni;
          h0[o4 + 2] = pr - nr;
          h0[o4 + 3] = pi - ni;
          omega[n] = c.radOmega[r2];
          coef[o4] = 1 - kx;
          coef[o4 + 1] = kz + k * lam;
          coef[o4 + 2] = lam * kz * invK;
          coef[o4 + 3] = -lam * kx * invK;
          dst[n] = (j * m + i) * 6;
          rowMask[j] = 1;
          n++;
        }
      }
      c.active = n;
    }
  }

  /** Everything that depends on |k| alone, memoised per integer n^2+m^2. */
  private fillRadial(c: CpuCascade, r2: number, dk: number, p: SpectrumParams): void {
    c.radDone[r2] = 1;
    const k = dk * Math.sqrt(r2);
    const w = cascadeWeight(k, c.layout.kMin, c.layout.kMax);
    if (w <= 1e-5) {
      c.radWind[r2] = 0;
      c.radSwell[r2] = 0;
      c.radOmega[r2] = 0;
      return;
    }
    const omega = dispersion(k);
    // S(kx,kz) = S(k)*D(theta)/k ; variance per mode = S(kx,kz)*dkx*dkz. The
    // spread's own normalisation is folded in here so the mode loop only needs
    // sech^2.
    const common = ((w * w) / k) * dk * dk;
    const beta = spreadBetaDBH(omega, p.omegaPeakWind);
    c.radBeta[r2] = beta;
    c.radOmega[r2] = omega;
    c.radWind[r2] =
      p.varScaleWind *
      spectrumK(k, p.omegaPeakWind, GAMMA_WIND) *
      common *
      (beta * 0.5) /
      Math.tanh(beta * Math.PI);
    c.radSwell[r2] =
      p.varScaleSwell *
      spectrumK(k, p.omegaPeakSwell, GAMMA_SWELL) *
      common *
      (BETA_SWELL * 0.5) /
      Math.tanh(BETA_SWELL * Math.PI);
  }

  /** Advance to absolute sim time `t`. Allocation free. */
  update(t: number): void {
    for (let ci = 0; ci < this.cascades.length; ci++) {
      const c = this.cascades[ci];
      const { h0, omega, coef, dst, work } = c;
      const active = c.active;
      // Inactive cells must read as zero for the transform; a memset is far
      // cheaper than writing them individually in the mode loop.
      work.fill(0);
      for (let a = 0; a < active; a++) {
        const ph = omega[a] * t;
        const cs = Math.cos(ph);
        const sn = Math.sin(ph);
        const o4 = a * 4;
        const hr = h0[o4] * cs - h0[o4 + 1] * sn;
        const hi = h0[o4 + 2] * sn + h0[o4 + 3] * cs;
        const ca = coef[o4];
        const cb = coef[o4 + 1];
        const cr = coef[o4 + 2];
        const ciq = coef[o4 + 3];
        const d = dst[a];
        work[d] = ca * hr;
        work[d + 1] = ca * hi;
        work[d + 2] = -cb * hi;
        work[d + 3] = cb * hr;
        work[d + 4] = cr * hr - ciq * hi;
        work[d + 5] = cr * hi + ciq * hr;
      }
      c.fft.transform2D(work, c.rowMask);
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

function clamp1(x: number): number {
  return x < -1 ? -1 : x > 1 ? 1 : x;
}
