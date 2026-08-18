/**
 * Deterministic island siting.
 *
 * The ocean is tiled into `SITE_M` squares in ABSOLUTE voyage coordinates. A
 * tile either holds one island or open water, decided by a hash and a
 * low-frequency archipelago mask, so the same heading always finds the same
 * land no matter how you got there and nothing needs to be remembered.
 *
 * Centres are jittered by at most `JITTER` of the tile so two neighbouring
 * heightfields can never overlap in space: worst-case centre separation is
 * `SITE_M * (1 - 2 * JITTER)`, which is kept above `EXTENT_MAX`.
 */

import { ARCH, ARCH_NAMES } from './api';
import { ARCH_META } from './archetypes';
import { clamp01, fbm2, hash01, ihash2, mix } from './wnoise';

export const SITE_M = 9000;
const JITTER = 0.2;
/** Heightfield side length cap, metres — see the overlap argument above. */
export const EXTENT_MAX = 5400;
export const RADIUS_MAX = EXTENT_MAX / 2.9;
export const RADIUS_MIN = 340;

export interface SiteSpec {
  key: number;
  tileX: number;
  tileZ: number;
  /** Absolute voyage-space centre. */
  ax: number;
  az: number;
  seed: number;
  archA: number;
  archB: number;
  blend: number;
  radiusM: number;
  extentM: number;
  peakScale: number;
  /** 0 = tropical, 1 = cold temperate. */
  climate: number;
  forced: boolean;
}

export function siteKey(tx: number, tz: number): number {
  // 16-bit signed fields; the world wraps after ~590 000 km, which is fine.
  return ((tx & 0xffff) << 16) | (tz & 0xffff);
}

/**
 * Large-scale archipelago mask. Chains of islands with real open water between
 * them read as a sea; uniform scattering reads as a tech demo.
 */
function chainMask(ax: number, az: number): number {
  const a = fbm2(ax * 0.0000122, az * 0.0000122, 20461, 4);
  const b = fbm2(ax * 0.0000401 + 11.3, az * 0.0000401 - 4.7, 33107, 3);
  return clamp01(0.46 + a * 1.25 + b * 0.35);
}

/** 0 = tropical, 1 = cold. Slowly banded so a long passage changes the flora. */
export function climateAt(ax: number, az: number): number {
  const band = Math.sin(az * 0.0000068 + 0.7) * 0.5 + 0.5;
  return clamp01(band * 0.8 + 0.2 * (fbm2(ax * 0.0000094, az * 0.0000094, 7717, 3) * 0.5 + 0.5));
}

const WARM = [ARCH.volcanic, ARCH.atoll, ARCH.cay, ARCH.granite, ARCH.mangrove, ARCH.ridge];
const WARM_W = [0.24, 0.15, 0.19, 0.16, 0.09, 0.17];
const COLD = [ARCH.fjord, ARCH.chalk, ARCH.ridge, ARCH.granite, ARCH.volcanic, ARCH.cay];
const COLD_W = [0.3, 0.22, 0.22, 0.12, 0.08, 0.06];

function pickArch(u: number, climate: number): number {
  const cold = climate > 0.5;
  const list = cold ? COLD : WARM;
  const w = cold ? COLD_W : WARM_W;
  let acc = 0;
  for (let i = 0; i < list.length; i++) {
    acc += w[i];
    if (u <= acc) return list[i];
  }
  return list[list.length - 1];
}

/** Primary archetype of a tile — also read by neighbours so coasts blend. */
function archOf(tx: number, tz: number, worldSeed: number): number {
  const h = ihash2(tx, tz, worldSeed + 5501);
  const ax = (tx + 0.5) * SITE_M;
  const az = (tz + 0.5) * SITE_M;
  return pickArch((h >>> 8) / 16777216, climateAt(ax, az));
}

/** The island in tile (tx, tz), or null for open water. */
export function siteFor(tx: number, tz: number, worldSeed: number): SiteSpec | null {
  const h = ihash2(tx, tz, worldSeed);
  const jx = ((h & 4095) / 4095 - 0.5) * 2 * JITTER;
  const jz = (((h >>> 12) & 4095) / 4095 - 0.5) * 2 * JITTER;
  const ax = (tx + 0.5 + jx) * SITE_M;
  const az = (tz + 0.5 + jz) * SITE_M;

  if (hash01(tx, tz, worldSeed + 991) > chainMask(ax, az)) return null;

  const climate = climateAt(ax, az);
  const archA = archOf(tx, tz, worldSeed);
  // Blend toward whichever neighbour the tile leans against, so a chalk coast
  // gives way to a chalk coast rather than butting up against a volcano.
  const nx = tx + (jx >= 0 ? 1 : -1);
  const nz = tz + (jz >= 0 ? 1 : -1);
  const archB = ((h >>> 26) & 1) === 0 ? archOf(nx, tz, worldSeed) : archOf(tx, nz, worldSeed);
  const blend = archB === archA ? 0 : 0.25 + (((h >>> 4) & 255) / 255) * 0.45;

  const meta = ARCH_META[archA];
  const ur = ((h >>> 20) & 4095) / 4095;
  const radiusM = Math.min(RADIUS_MAX, Math.max(RADIUS_MIN, mix(meta.rMin, meta.rMax, ur)));
  const up = ((h >>> 14) & 1023) / 1023;

  return {
    key: siteKey(tx, tz),
    tileX: tx,
    tileZ: tz,
    ax,
    az,
    seed: (ihash2(tx, tz, worldSeed + 13337) & 0x7fffffff) | 1,
    archA,
    archB,
    blend,
    radiusM,
    extentM: Math.min(EXTENT_MAX, radiusM * 2.9),
    peakScale: mix(meta.peakMin, meta.peakMax, up),
    climate,
    forced: false,
  };
}

export function archNameOf(spec: SiteSpec): string {
  return ARCH_NAMES[spec.archA] ?? 'ridge';
}
