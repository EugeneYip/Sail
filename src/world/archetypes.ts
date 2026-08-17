/**
 * Island archetypes. Each `archHeight` case is a closed-form landform profile in
 * island-local metres; the generator evaluates two of them per island and mixes
 * spatially so neighbouring coasts blend instead of butting up.
 *
 * Heights are pre-erosion. Erosion supplies the drainage detail; these profiles
 * only have to get the *macro* form and the coastal slope right, because the
 * coastal slope is what decides where sand, rock and surf end up.
 */

import { ARCH, SPECIES } from './api';
import { billow2, clamp01, fbm2, gnoise2, ihash2, mix, ridged2, sstep, worley2 } from './wnoise';

export interface ArchMeta {
  /** Nominal land radius range, metres. */
  rMin: number;
  rMax: number;
  /** Peak-height multiplier range. */
  peakMin: number;
  peakMax: number;
  /** How readily gentle ground turns to sand, 0..1.5. */
  beachiness: number;
  /** Extra shallow reef shelf, 0..1 — drives turquoise water area. */
  reefiness: number;
  /** Base vegetation density multiplier. */
  vegetation: number;
  /** Species weights, indexed by SPECIES. */
  species: number[];
  /** Relative likelihood of a settlement. */
  settlement: number;
  /** Relative likelihood of a lighthouse. */
  lighthouse: number;
  /** Rock albedo, linear-ish sRGB triple typed by eye (converted at upload). */
  rock: [number, number, number];
  /** Sand albedo. */
  sand: [number, number, number];
  /** Dry vegetation tint. */
  flora: [number, number, number];
  /** Snow line as a fraction of max height; >1 disables snow. */
  snowLine: number;
}

const W = (palm = 0, pine = 0, broad = 0, scrub = 0, mangrove = 0, agave = 0): number[] => [
  palm,
  pine,
  broad,
  scrub,
  mangrove,
  agave,
];

export const ARCH_META: Record<number, ArchMeta> = {
  [ARCH.volcanic]: {
    rMin: 1500,
    rMax: 2400,
    peakMin: 1.0,
    peakMax: 2.3,
    beachiness: 0.55,
    reefiness: 0.35,
    vegetation: 1.15,
    species: W(0.3, 0.15, 0.35, 0.15, 0, 0.05),
    settlement: 0.8,
    lighthouse: 0.5,
    rock: [0.115, 0.1, 0.095],
    sand: [0.28, 0.245, 0.215],
    flora: [0.055, 0.105, 0.05],
    snowLine: 0.86,
  },
  [ARCH.atoll]: {
    rMin: 1100,
    rMax: 1900,
    peakMin: 0.5,
    peakMax: 1.0,
    beachiness: 1.5,
    reefiness: 1.0,
    vegetation: 0.75,
    species: W(0.82, 0, 0.04, 0.1, 0.04, 0),
    settlement: 0.25,
    lighthouse: 0.3,
    rock: [0.3, 0.29, 0.255],
    sand: [0.62, 0.585, 0.5],
    flora: [0.07, 0.135, 0.055],
    snowLine: 9,
  },
  [ARCH.cay]: {
    rMin: 380,
    rMax: 760,
    peakMin: 0.6,
    peakMax: 1.3,
    beachiness: 1.45,
    reefiness: 0.85,
    vegetation: 0.7,
    species: W(0.72, 0, 0.06, 0.16, 0.02, 0.04),
    settlement: 0.14,
    lighthouse: 0.4,
    rock: [0.3, 0.285, 0.25],
    sand: [0.63, 0.595, 0.505],
    flora: [0.075, 0.14, 0.06],
    snowLine: 9,
  },
  [ARCH.chalk]: {
    rMin: 1300,
    rMax: 2100,
    peakMin: 0.7,
    peakMax: 1.5,
    beachiness: 0.5,
    reefiness: 0.2,
    vegetation: 0.85,
    species: W(0, 0.2, 0.14, 0.56, 0, 0.1),
    settlement: 1.0,
    lighthouse: 1.0,
    rock: [0.5, 0.495, 0.455],
    sand: [0.42, 0.4, 0.36],
    flora: [0.075, 0.125, 0.055],
    snowLine: 9,
  },
  [ARCH.fjord]: {
    rMin: 1700,
    rMax: 2600,
    peakMin: 0.9,
    peakMax: 1.8,
    beachiness: 0.22,
    reefiness: 0.1,
    vegetation: 1.0,
    species: W(0, 0.72, 0.06, 0.22, 0, 0),
    settlement: 0.7,
    lighthouse: 0.85,
    rock: [0.135, 0.135, 0.13],
    sand: [0.22, 0.215, 0.205],
    flora: [0.038, 0.075, 0.04],
    snowLine: 0.7,
  },
  [ARCH.mangrove]: {
    rMin: 900,
    rMax: 1600,
    peakMin: 0.4,
    peakMax: 0.8,
    beachiness: 0.6,
    reefiness: 0.3,
    vegetation: 1.4,
    species: W(0.1, 0, 0.12, 0.1, 0.68, 0),
    settlement: 0.4,
    lighthouse: 0.2,
    rock: [0.13, 0.115, 0.09],
    sand: [0.32, 0.285, 0.225],
    flora: [0.045, 0.095, 0.045],
    snowLine: 9,
  },
  [ARCH.granite]: {
    rMin: 700,
    rMax: 1400,
    peakMin: 0.7,
    peakMax: 1.4,
    beachiness: 1.2,
    reefiness: 0.6,
    vegetation: 1.0,
    species: W(0.55, 0, 0.22, 0.18, 0, 0.05),
    settlement: 0.35,
    lighthouse: 0.4,
    rock: [0.3, 0.275, 0.245],
    sand: [0.6, 0.565, 0.485],
    flora: [0.06, 0.12, 0.05],
    snowLine: 9,
  },
  [ARCH.ridge]: {
    rMin: 1400,
    rMax: 2300,
    peakMin: 0.8,
    peakMax: 1.7,
    beachiness: 0.7,
    reefiness: 0.3,
    vegetation: 1.0,
    species: W(0.18, 0.28, 0.24, 0.24, 0, 0.06),
    settlement: 1.2,
    lighthouse: 0.75,
    rock: [0.185, 0.17, 0.15],
    sand: [0.4, 0.375, 0.335],
    flora: [0.062, 0.115, 0.05],
    snowLine: 0.82,
  },
};

const wtmp = new Float32Array(3);

/**
 * Land/seabed height in metres for one archetype.
 *
 * @param rn  Warped normalised radius: 1.0 is the nominal waterline.
 * @param th  Polar angle, radians.
 */
export function archHeight(
  arch: number,
  lx: number,
  lz: number,
  rn: number,
  th: number,
  seed: number,
  radiusM: number,
  peakScale: number,
): number {
  const ct = Math.cos(th);
  const st = Math.sin(th);
  const body = Math.max(0, 1 - rn);

  switch (arch) {
    case ARCH.volcanic: {
      const peak = 300 * peakScale;
      let h = Math.pow(body, 1.42) * peak;
      // Radial gullies: the noise depends only on angle, so its ridges run
      // straight down the flanks the way real volcanic barrancas do. The radius
      // term makes them splay slightly as they descend.
      const gr = 5.5 + rn * 3.5;
      const gully = ridged2(ct * gr, st * gr, seed + 77, 4);
      h -= (1 - gully) * peak * 0.135 * sstep(0.04, 0.3, rn) * (1 - rn * 0.5);
      // Summit caldera with a raised rim.
      h -= sstep(0.16, 0.03, rn) * peak * 0.2;
      const rim = Math.exp(-Math.pow((rn - 0.155) / 0.055, 2));
      h += rim * peak * 0.055;
      h += fbm2(lx * 0.0017, lz * 0.0017, seed + 5, 4) * 30 * (1 - rn * 0.65);
      // Narrow fringing reef then a steep fore-reef drop.
      h -= sstep(1.0, 1.05, rn) * 3.5 + sstep(1.04, 1.2, rn) * 48;
      return h;
    }

    case ARCH.atoll: {
      const ringR = 0.8 + 0.085 * fbm2(ct * 2.4, st * 2.4, seed + 3, 3);
      const d = rn - ringR;
      // Gaps in the motu chain become navigable passes.
      const gate = sstep(0.26, 0.62, fbm2(ct * 3.1, st * 3.1, seed + 91, 3) * 0.5 + 0.5);
      let h = -9.5 + 4.2 * fbm2(lx * 0.0013, lz * 0.0013, seed + 13, 3);
      const flat = Math.exp(-(d * d) / (0.085 * 0.085));
      h = mix(h, -0.85, sstep(0.18, 0.9, flat));
      const motu = Math.exp(-(d * d) / (0.042 * 0.042));
      h += motu * gate * (2.0 + 4.0 * (0.5 + 0.5 * fbm2(ct * 6.0, st * 6.0, seed + 41, 3)));
      h -= sstep(ringR + 0.035, ringR + 0.26, rn) * 62;
      return h;
    }

    case ARCH.cay: {
      let h = Math.pow(body, 1.65) * (6 + 7 * peakScale);
      h += fbm2(lx * 0.0042, lz * 0.0042, seed, 3) * 2.4 * body;
      // A hooked spit on one side reads as a real cay rather than a dome.
      const spit = Math.exp(-Math.pow((th - 1.1) / 0.7, 2)) * Math.exp(-Math.pow((rn - 1.05) / 0.16, 2));
      h += spit * 2.6;
      h -= sstep(1.0, 1.04, rn) * 1.2 + sstep(1.02, 1.45, rn) * 16 + sstep(1.4, 1.9, rn) * 40;
      return h;
    }

    case ARCH.chalk: {
      const top = 80 + 75 * peakScale;
      let plat = top + fbm2(lx * 0.00095, lz * 0.00095, seed + 2, 4) * 24;
      // Dry chines incised into the plateau, running out to the cliff edge.
      const chine = ridged2(lx * 0.0013, lz * 0.0013, seed + 8, 4);
      plat -= (1 - chine) * 30;
      const edge = sstep(0.982, 0.999, rn);
      let h = plat * (1 - edge) - edge * 2;
      // Wave-cut platform then a shallow, then away.
      h -= sstep(0.998, 1.012, rn) * 5 + sstep(1.008, 1.09, rn) * 15 + sstep(1.07, 1.3, rn) * 40;
      return h;
    }

    case ARCH.fjord: {
      const chan = ridged2(lx * 0.00044, lz * 0.00044, seed + 4, 5);
      const b = Math.pow(body, 0.8);
      let h = (chan * chan * 1.2 - 0.1) * (250 + 240 * peakScale) * b;
      // Squared inverse of the ridge field cuts the inlets well below sea level.
      h -= (1 - chan) * (1 - chan) * 105 * b;
      h += fbm2(lx * 0.0023, lz * 0.0023, seed + 6, 4) * 24 * b;
      h -= sstep(0.985, 1.05, rn) * 12 + sstep(1.03, 1.22, rn) * 74;
      return h;
    }

    case ARCH.mangrove: {
      worley2(lx * 0.00085, lz * 0.00085, seed + 17, wtmp);
      const chan = sstep(0.0, 0.11, wtmp[1] - wtmp[0]);
      const flat = 0.5 + 2.6 * (0.5 + 0.5 * fbm2(lx * 0.0021, lz * 0.0021, seed + 2, 3));
      let h = flat * Math.pow(body, 0.45) * chan - (1 - chan) * 2.4;
      h -= sstep(0.95, 1.1, rn) * 3.2 + sstep(1.05, 1.55, rn) * 28;
      return h;
    }

    case ARCH.granite: {
      let h = 0;
      // Rounded domes at hashed offsets — Seychelles granitics.
      for (let k = 0; k < 5; k++) {
        const hh = ihash2(k + 1, 7, seed);
        const a = ((hh & 4095) / 4095) * Math.PI * 2;
        const rr = (((hh >>> 12) & 4095) / 4095) * 0.55;
        const cx = Math.cos(a) * rr * radiusM;
        const cz = Math.sin(a) * rr * radiusM;
        const sc = 0.3 + (((hh >>> 24) & 255) / 255) * 0.5;
        const dx = (lx - cx) / (radiusM * 0.45 * sc);
        const dz = (lz - cz) / (radiusM * 0.45 * sc);
        h += Math.exp(-(dx * dx + dz * dz)) * (70 + 130 * peakScale) * sc;
      }
      // Boulder relief — billow inverted gives rounded stacked forms.
      h += (1 - billow2(lx * 0.0055, lz * 0.0055, seed + 9, 3)) * 11 * sstep(0.02, 0.25, h / 60);
      h *= Math.pow(clamp01(1.12 - rn), 0.55);
      h -= sstep(1.0, 1.06, rn) * 3 + sstep(1.04, 1.35, rn) * 34;
      return h;
    }

    default: {
      // ridge — a long spine with saddles, the classic inhabited island
      const a0 = ((ihash2(3, 11, seed) & 1023) / 1023) * Math.PI;
      const ca = Math.cos(a0);
      const sa = Math.sin(a0);
      const t = (lx * ca + lz * sa) / radiusM;
      const s = (-lx * sa + lz * ca) / radiusM;
      const curve = Math.sin(t * 1.7) * 0.22;
      const d = Math.abs(s - curve) / 0.44;
      let h = (1 - sstep(0, 1, d)) * (140 + 160 * peakScale);
      h *= 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(t * 4.3 + a0 * 3));
      h += fbm2(lx * 0.0016, lz * 0.0016, seed + 6, 4) * 34 * Math.pow(body, 0.6);
      h *= Math.pow(clamp01(1.1 - rn), 0.7);
      h -= sstep(0.99, 1.05, rn) * 5 + sstep(1.03, 1.3, rn) * 40;
      return h;
    }
  }
}

/** Warped normalised radius, plus the polar angle, for a local position. */
export function warpedRadius(lx: number, lz: number, radiusM: number, seed: number, out: Float32Array): void {
  const r = Math.sqrt(lx * lx + lz * lz);
  const th = Math.atan2(lz, lx);
  const ct = Math.cos(th);
  const st = Math.sin(th);
  // Angular lobing (seamless because the noise is sampled on a circle) plus a
  // planar term so the coastline is not radially symmetric.
  const lobe =
    1 +
    0.24 * fbm2(ct * 1.55, st * 1.55, seed + 11, 4) +
    0.11 * fbm2(lx * 0.00052, lz * 0.00052, seed + 31, 3) +
    0.05 * gnoise2(ct * 5.5, st * 5.5, seed + 53);
  out[0] = r / (radiusM * Math.max(0.45, lobe));
  out[1] = th;
}

export function speciesFor(meta: ArchMeta, u: number): number {
  let acc = 0;
  for (let i = 0; i < meta.species.length; i++) {
    acc += meta.species[i];
    if (u * 1.0000001 <= acc) return i;
  }
  return SPECIES.scrub;
}
