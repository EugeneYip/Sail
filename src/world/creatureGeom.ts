import * as THREE from 'three';
import { MeshBuilder, mixRGB, srgb, type RGB } from './wgeom';

/**
 * Procedural bodies for the world's animals. All built at true scale in ship
 * local axes (-Z forward, +Y up, +X starboard) so a per-instance scale of 1 is
 * a real animal.
 *
 * `aAux` is (bodyT, spanT, membrane, spare) — see `shaders/creature.ts`.
 */

type Section = readonly [z: number, halfWidth: number, halfHeight: number, yCentre: number];

/** Elliptical loft with countershaded colour, capped at both ends. */
function loftBody(
  b: MeshBuilder,
  sections: readonly Section[],
  ringN: number,
  back: RGB,
  flank: RGB,
  belly: RGB,
  bodyT: (z: number) => number,
): void {
  const rings: number[][] = [];
  for (const [z, hw, hh, yc] of sections) {
    const t = bodyT(z);
    const ring: number[] = [];
    for (let j = 0; j < ringN; j++) {
      const th = (j / ringN) * Math.PI * 2;
      const cs = Math.cos(th);
      const x = hw * Math.sin(th);
      const y = yc + hh * cs;
      const col = cs >= 0 ? mixRGB(flank, back, cs) : mixRGB(flank, belly, -cs);
      ring.push(b.vert(x, y, z, col, [t, 0, 0, 0]));
    }
    rings.push(ring);
  }
  b.tube(rings, true);

  const nose = sections[0];
  const tail = sections[sections.length - 1];
  const noseIdx = b.vert(0, nose[3], nose[0] - nose[2] * 0.5, mixRGB(flank, back, 0.4), [bodyT(nose[0]), 0, 0, 0]);
  const tailIdx = b.vert(0, tail[3], tail[0] + tail[2] * 0.4, mixRGB(flank, back, 0.4), [bodyT(tail[0]), 0, 0, 0]);
  const first = rings[0];
  const last = rings[rings.length - 1];
  for (let j = 0; j < ringN; j++) {
    b.tri(noseIdx, first[j], first[(j + 1) % ringN]);
    b.tri(tailIdx, last[(j + 1) % ringN], last[j]);
  }
}

/**
 * A herring gull, 1.45 m span. The black primaries matter more than anything
 * else here: a wholly pale gull disappears against a bright sky.
 */
export function buildGull(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const back = srgb(0xa9aeb4);
  const flank = srgb(0xdadbd6);
  const belly = srgb(0xf4f3ee);

  loftBody(
    b,
    [
      [-0.34, 0.008, 0.008, 0],
      [-0.29, 0.020, 0.016, -0.004],
      [-0.23, 0.044, 0.042, 0],
      [-0.14, 0.060, 0.058, 0],
      [0.0, 0.068, 0.062, 0],
      [0.14, 0.055, 0.050, 0.004],
      [0.27, 0.026, 0.024, 0.010],
    ],
    8,
    back,
    flank,
    belly,
    () => 0,
  );

  // Wings: swept back, thinning outboard, primaries almost black.
  const primaries = srgb(0x24262a);
  for (const side of [1, -1]) {
    const stations = [
      [0.05 * side, 0.018, -0.03, 0, 0, 0.105],
      [0.30 * side, 0.032, -0.01, 0, 0, 0.088],
      [0.58 * side, 0.040, 0.035, 0, 0, 0.064],
      [0.72 * side, 0.030, 0.11, 0, 0, 0.026],
    ].flat();
    const wingCol = mixRGB(back, primaries, 0.45);
    b.blade(stations, wingCol, (t) => [0, t, 1, 0]);
  }

  // Tail fan.
  const tailCol = mixRGB(flank, belly, 0.5);
  const t0 = b.vert(0, 0.012, 0.25, tailCol, [0, 0, 0.6, 0]);
  const tl = b.vert(-0.085, 0.016, 0.43, tailCol, [0, 0, 1, 0]);
  const tr = b.vert(0.085, 0.016, 0.43, tailCol, [0, 0, 1, 0]);
  const tm = b.vert(0, 0.014, 0.46, tailCol, [0, 0, 1, 0]);
  b.tri(t0, tl, tm);
  b.tri(t0, tm, tr);

  // Bill: small, but it is the difference between a bird and a dart.
  b.cyl(0, -0.004, -0.30, 0, -0.012, -0.40, 0.010, 0.003, 5, srgb(0xd8a520), [0, 0, 0, 0]);

  return b.finish('world-gull');
}

/** A common dolphin, 2.6 m. */
export function buildDolphin(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const back = srgb(0x1d242e);
  const flank = srgb(0x7b8794);
  const belly = srgb(0xdedacd);
  const L0 = -1.3;
  const L1 = 1.15;
  const bodyT = (z: number) => (z - L0) / (L1 - L0);

  loftBody(
    b,
    [
      [-1.30, 0.014, 0.013, -0.02],
      [-1.10, 0.055, 0.050, -0.022],
      [-0.95, 0.100, 0.098, 0],
      [-0.60, 0.190, 0.200, 0],
      [-0.20, 0.220, 0.235, 0],
      [0.20, 0.185, 0.200, 0.005],
      [0.60, 0.115, 0.135, 0.010],
      [0.90, 0.055, 0.085, 0.015],
      [1.15, 0.020, 0.038, 0.020],
    ],
    10,
    back,
    flank,
    belly,
    bodyT,
  );

  const finCol = mixRGB(back, flank, 0.18);
  // Dorsal fin, in the vertical plane: half-chord runs along Z.
  b.blade(
    [0, 0.20, -0.02, 0, 0, 0.155, 0.005, 0.40, 0.06, 0, 0, 0.115, 0.01, 0.56, 0.20, 0, 0, 0.048].slice(),
    finCol,
    (t) => [bodyT(-0.02 + t * 0.22), 0, 0.55, 0],
  );
  for (const side of [1, -1]) {
    b.blade(
      [
        0.15 * side, -0.10, -0.42, 0, 0, 0.100,
        0.34 * side, -0.15, -0.30, 0, 0, 0.070,
        0.47 * side, -0.20, -0.18, 0, 0, 0.030,
      ],
      finCol,
      (t) => [bodyT(-0.42 + t * 0.24), 0, 0.7, 0],
    );
  }
  // Flukes: horizontal, so the half-chord runs along Z and the span along X.
  b.blade(
    [
      -0.42, 0.030, 1.30, 0, 0, 0.045,
      -0.20, 0.024, 1.19, 0, 0, 0.105,
      0.0, 0.020, 1.15, 0, 0, 0.075,
      0.20, 0.024, 1.19, 0, 0, 0.105,
      0.42, 0.030, 1.30, 0, 0, 0.045,
    ],
    finCol,
    () => [1, 0, 0.6, 0],
  );

  return b.finish('world-dolphin');
}

/**
 * A humpback, 14 m. The pale five-metre flippers are the whole silhouette —
 * without them a whale is an anonymous log.
 */
export function buildWhale(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const back = srgb(0x15171b);
  const flank = srgb(0x3a3d42);
  const belly = srgb(0xa9a494);
  const L0 = -6.6;
  const L1 = 7.0;
  const bodyT = (z: number) => (z - L0) / (L1 - L0);

  loftBody(
    b,
    [
      [-6.60, 0.12, 0.10, -0.1],
      [-5.80, 0.58, 0.50, -0.05],
      [-4.60, 1.06, 0.96, 0],
      [-3.00, 1.56, 1.50, 0],
      [-1.00, 1.74, 1.72, 0],
      [1.00, 1.50, 1.58, 0.05],
      [3.00, 1.00, 1.16, 0.10],
      [4.80, 0.52, 0.68, 0.16],
      [6.20, 0.22, 0.34, 0.20],
      [7.00, 0.08, 0.16, 0.22],
    ],
    12,
    back,
    flank,
    belly,
    bodyT,
  );

  // Dorsal hump: low and blunt, not a fin.
  b.blade(
    [0, 1.45, 0.2, 0, 0, 1.05, 0, 1.90, 0.5, 0, 0, 0.72, 0, 2.10, 0.95, 0, 0, 0.28],
    mixRGB(back, flank, 0.3),
    (t) => [bodyT(0.2 + t * 0.75), 0, 0.35, 0],
  );

  const flipper = mixRGB(belly, srgb(0xe6e0cf), 0.4);
  for (const side of [1, -1]) {
    b.blade(
      [
        1.20 * side, -0.65, -3.40, 0, 0, 0.72,
        2.60 * side, -0.55, -3.00, 0, 0, 0.60,
        4.00 * side, -0.30, -2.40, 0, 0, 0.44,
        5.00 * side, 0.05, -1.70, 0, 0, 0.20,
      ],
      flipper,
      (t) => [bodyT(-3.4 + t * 1.7), 0, 0.65, 0],
    );
  }
  // Flukes with the notched trailing edge that makes a sounding whale readable.
  b.blade(
    [
      -3.30, 0.35, 7.85, 0, 0, 0.35,
      -1.70, 0.26, 7.35, 0, 0, 0.72,
      -0.35, 0.22, 7.00, 0, 0, 0.30,
      0.0, 0.22, 6.90, 0, 0, 0.16,
      0.35, 0.22, 7.00, 0, 0, 0.30,
      1.70, 0.26, 7.35, 0, 0, 0.72,
      3.30, 0.35, 7.85, 0, 0, 0.35,
    ],
    mixRGB(back, belly, 0.22),
    () => [1, 0, 0.55, 0],
  );

  return b.finish('world-whale');
}

/** A 0.34 m baitfish. Beats laterally, so the pod driver sets `bendX`. */
export function buildFish(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const back = srgb(0x1d3340);
  const flank = srgb(0x7d8f92);
  const belly = srgb(0xe2e6df);
  const L0 = -0.17;
  const L1 = 0.14;
  const bodyT = (z: number) => (z - L0) / (L1 - L0);

  loftBody(
    b,
    [
      [-0.17, 0.004, 0.004, 0],
      [-0.12, 0.018, 0.024, 0],
      [-0.05, 0.028, 0.042, 0],
      [0.03, 0.022, 0.036, 0],
      [0.10, 0.010, 0.018, 0],
      [0.14, 0.004, 0.010, 0],
    ],
    7,
    back,
    flank,
    belly,
    bodyT,
  );
  b.blade(
    [0, 0, 0.13, 0, 0.030, 0, 0, 0, 0.20, 0, 0.055, 0],
    mixRGB(back, flank, 0.5),
    () => [1, 0, 0.8, 0],
  );
  return b.finish('world-fish');
}
