/**
 * CPU inverse FFT, three complex channels interleaved per element.
 *
 * Same convention as `Fft.ts` (+i twiddle, no 1/N), so a CPU grid of size M over
 * the same tile reproduces the GPU field exactly for every mode it carries.
 * Three channels ride together because the per-butterfly index arithmetic — not
 * the multiply-add — is what costs in JavaScript; transforming six real fields
 * in one pass amortises it.
 */

const CH = 3;
const STRIDE = CH * 2;

export class CpuFft {
  readonly n: number;
  private rev: Int32Array;
  private twCos: Float32Array;
  private twSin: Float32Array;
  private stageOffset: Int32Array;
  /** Scratch row/column buffer so the strided pass stays cache friendly. */
  private line: Float32Array;

  constructor(n: number) {
    this.n = n;
    const bits = Math.log2(n) | 0;
    this.rev = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.twCos = new Float32Array(n);
    this.twSin = new Float32Array(n);
    this.stageOffset = new Int32Array(bits);
    let off = 0;
    for (let s = 0; s < bits; s++) {
      const m = 1 << (s + 1);
      const half = m >> 1;
      this.stageOffset[s] = off;
      for (let j = 0; j < half; j++) {
        const a = (2 * Math.PI * j) / m;
        this.twCos[off + j] = Math.cos(a);
        this.twSin[off + j] = Math.sin(a);
      }
      off += half;
    }
    this.line = new Float32Array(n * STRIDE);
  }

  /**
   * In-place 2D inverse transform. `data` is n*n elements of 3 interleaved
   * complex values, row-major (index = (row * n + col) * 6).
   */
  transform2D(data: Float32Array): void {
    const n = this.n;
    for (let row = 0; row < n; row++) this.transformLine(data, row * n * STRIDE, STRIDE);
    for (let col = 0; col < n; col++) this.transformLine(data, col * STRIDE, n * STRIDE);
  }

  private transformLine(data: Float32Array, base: number, stride: number): void {
    const n = this.n;
    const line = this.line;
    const rev = this.rev;

    // Gather into a contiguous scratch line, applying the bit reversal.
    for (let i = 0; i < n; i++) {
      const s = base + rev[i] * stride;
      const d = i * STRIDE;
      line[d] = data[s];
      line[d + 1] = data[s + 1];
      line[d + 2] = data[s + 2];
      line[d + 3] = data[s + 3];
      line[d + 4] = data[s + 4];
      line[d + 5] = data[s + 5];
    }

    const twCos = this.twCos;
    const twSin = this.twSin;
    let stage = 0;
    for (let len = 2; len <= n; len <<= 1, stage++) {
      const half = len >> 1;
      const toff = this.stageOffset[stage];
      const lenStride = len * STRIDE;
      const halfStride = half * STRIDE;
      for (let blk = 0; blk < n * STRIDE; blk += lenStride) {
        for (let j = 0; j < half; j++) {
          const wr = twCos[toff + j];
          const wi = twSin[toff + j];
          const ai = blk + j * STRIDE;
          const bi = ai + halfStride;
          for (let c = 0; c < STRIDE; c += 2) {
            const br = line[bi + c];
            const bim = line[bi + c + 1];
            const tr = br * wr - bim * wi;
            const ti = br * wi + bim * wr;
            const ar = line[ai + c];
            const aim = line[ai + c + 1];
            line[ai + c] = ar + tr;
            line[ai + c + 1] = aim + ti;
            line[bi + c] = ar - tr;
            line[bi + c + 1] = aim - ti;
          }
        }
      }
    }

    for (let i = 0; i < n; i++) {
      const s = i * STRIDE;
      const d = base + i * stride;
      data[d] = line[s];
      data[d + 1] = line[s + 1];
      data[d + 2] = line[s + 2];
      data[d + 3] = line[s + 3];
      data[d + 4] = line[s + 4];
      data[d + 5] = line[s + 5];
    }
  }
}
