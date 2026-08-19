/**
 * The lofted hull.
 *
 * The station sections come from dims.ts; this file turns them into surfaces:
 * the outer planking (split into copper / black / gunport-stripe meshes so each
 * gets its own material), the raised wale belts, the inboard bulwarks, the
 * spar deck, the gun-deck interior seen through the open ports, the keel, the
 * stem and beakhead, and the transom with its galleries and windows.
 *
 * Grid rows follow the longitudinal level curves, so plank runs are spiled to
 * the hull's own shape rather than being straight lines in UV space, and the
 * paint bands and gunport rows are exact edges of the mesh.
 */

import * as THREE from 'three';
import { makeRng, smoothstep } from '../../util/math';
import { TILE_ACROSS as TILE_ACROSS_M, TILE_ALONG as TILE_ALONG_M } from '../materials/textures';
import { MeshBuilder } from './Builder';
import {
  BULWARK_THICK, Bin, DECK_CAMBER, HULL_ROWS, HULL_THICK,
  ROW_COPPER_TOP, ROW_PORT_HEAD, ROW_PORT_SILL, ROW_SPAR_HEAD, ROW_SPAR_SILL,
  Station, Z_TRANSOM, buildPorts, deckSideY, gunDeckY, keelY, sheerY, tAtZ, zAt,
  type PortSpec,
} from '../dims';

export interface Bins {
  copper: MeshBuilder;
  black: MeshBuilder;
  stripe: MeshBuilder;
  buff: MeshBuilder;
  deck: MeshBuilder;
  oak: MeshBuilder;
  iron: MeshBuilder;
  brass: MeshBuilder;
  glass: MeshBuilder;
}

export function createBins(): Bins {
  return {
    copper: new MeshBuilder(),
    black: new MeshBuilder(),
    stripe: new MeshBuilder(),
    buff: new MeshBuilder(),
    deck: new MeshBuilder(),
    oak: new MeshBuilder(),
    iron: new MeshBuilder(),
    brass: new MeshBuilder(),
    glass: new MeshBuilder(),
  };
}

/**
 * One tile is 3.2 m of plank run by 4 planks. Re-exported under the local names
 * the spiling code below uses; the definition, and the reason it has to be a
 * single definition, are in `materials/textures.ts`.
 */
const TILE_ALONG = TILE_ALONG_M;
const TILE_ACROSS = TILE_ACROSS_M;

export interface HullResult {
  ports: PortSpec[];
  stations: Station[];
  /** Underwater sample points in ship local space, for the physics module. */
  hullPoints: THREE.Vector3[];
  /** Inboard half-breadth at the spar deck, by t — used to place furniture. */
  deckHalfWidth(t: number): number;
}

export function buildHull(bins: Bins, quality: number): HullResult {
  const rng = makeRng(0x5a11);
  const ports = buildPorts(rng);

  const stations = buildStations(ports);
  const ns = stations.length;
  const nr = HULL_ROWS.length;

  // ---- row heights, forced monotone so the section lookup stays valid
  const rowY: Float32Array[] = [];
  for (let i = 0; i < ns; i++) {
    const t = stations[i].t;
    const col = new Float32Array(nr);
    for (let j = 0; j < nr; j++) {
      let y = HULL_ROWS[j].y(t);
      if (j > 0 && y < col[j - 1] + 0.012) y = col[j - 1] + 0.012;
      col[j] = y;
    }
    rowY.push(col);
  }

  // ---- surface points for both sides, plus the inboard offset shells
  const P: THREE.Vector3[][] = [];
  for (let i = 0; i < ns; i++) {
    const st = stations[i];
    const col: THREE.Vector3[] = [];
    for (let j = 0; j < nr; j++) {
      const y = rowY[i][j];
      const proud = HULL_ROWS[j].proud;
      let w = st.widthAt(y);
      let yy = y;
      if (proud > 0) {
        const s = st.slopeAt(y);
        const inv = 1 / Math.hypot(1, s);
        w += proud * inv;
        yy += proud * -s * inv;
      }
      col.push(new THREE.Vector3(w, yy, st.z));
    }
    P.push(col);
  }

  // ---- arc lengths for spiled UVs
  const uLen: Float32Array[] = [];
  const vLen: Float32Array[] = [];
  for (let i = 0; i < ns; i++) {
    uLen.push(new Float32Array(nr));
    vLen.push(new Float32Array(nr));
  }
  for (let j = 0; j < nr; j++) {
    for (let i = 1; i < ns; i++) uLen[i][j] = uLen[i - 1][j] + P[i][j].distanceTo(P[i - 1][j]);
  }
  for (let i = 0; i < ns; i++) {
    for (let j = 1; j < nr; j++) vLen[i][j] = vLen[i][j - 1] + P[i][j].distanceTo(P[i][j - 1]);
  }

  // ---- which quad bands are cut away for a port
  const cut: Uint8Array[] = [];
  for (let i = 0; i < ns - 1; i++) cut.push(new Uint8Array(nr - 1));
  const portCols: { p: PortSpec; i0: number; i1: number }[] = [];
  for (const p of ports) {
    const jLo = p.gunDeck ? ROW_PORT_SILL : ROW_SPAR_SILL;
    const jHi = p.gunDeck ? ROW_PORT_HEAD : ROW_SPAR_HEAD;
    let i0 = -1;
    let i1 = -1;
    for (let i = 0; i < ns; i++) {
      if (i0 < 0 && stations[i].z >= p.z - p.halfWidth - 1e-4) i0 = i;
      if (stations[i].z <= p.z + p.halfWidth + 1e-4) i1 = i;
    }
    if (i0 < 0 || i1 <= i0) continue;
    portCols.push({ p, i0, i1 });
    for (let i = i0; i < i1; i++) for (let j = jLo; j < jHi; j++) cut[i][j] = 1;
  }

  // ---- outer planking, one mesh per paint bin
  const runs = bandRuns();
  for (const run of runs) {
    const b = binOf(bins, run.bin);
    for (const side of [1, -1] as const) {
      const nv = run.hi - run.lo + 1;
      b.grid(
        ns, nv,
        (i, j, out) => {
          const p = P[i][run.lo + j];
          out.set(side * p.x, p.y, p.z);
        },
        (i, j) => [uLen[i][run.lo + j] / TILE_ALONG, (vLen[i][run.lo + j] / TILE_ACROSS) * side],
        {
          // cross(d/di, d/dj) on this grid points INBOARD, so the outboard
          // planking has to be flipped on the starboard side, not the port one.
          flip: side > 0,
          skip: (i, j) => cut[i][run.lo + j] === 1,
          colorFn: (i, j, c) => hullColor(stations[i].t, run.lo + j, side, ports, c),
        },
      );
    }
  }

  // ---- gunport liners and lids
  for (const { p, i0, i1 } of portCols) {
    const jLo = p.gunDeck ? ROW_PORT_SILL : ROW_SPAR_SILL;
    const jHi = p.gunDeck ? ROW_PORT_HEAD : ROW_SPAR_HEAD;
    const th = p.gunDeck ? HULL_THICK : BULWARK_THICK;
    for (const side of [1, -1] as const) buildPortLiner(bins, stations, P, rowY, p, i0, i1, jLo, jHi, th, side);
  }

  // ---- keel, deadwood, sternpost and false keel
  buildKeel(bins);

  // ---- stem, cutwater, beakhead and head rails
  buildStem(bins, stations);

  // ---- transom, counter, galleries and taffrail
  buildTransom(bins, stations, rowY, P);

  // ---- inboard bulwarks, rail cap, hammock netting
  buildBulwarks(bins, stations, ports, quality);

  // ---- decks
  buildDecks(bins, stations);

  // ---- channels and chainplates for the shrouds
  buildChannels(bins);

  const hullPoints: THREE.Vector3[] = [];
  for (let k = 0; k < 11; k++) {
    const t = 0.04 + (k / 10) * 0.92;
    const st = new Station(t);
    for (const f of [0.1, 0.45, 0.8]) {
      const y = st.keel + (Math.min(0, 0) - st.keel) * f;
      const w = st.widthAt(y);
      hullPoints.push(new THREE.Vector3(w * 0.8, y, st.z), new THREE.Vector3(-w * 0.8, y, st.z));
    }
  }

  return {
    ports,
    stations,
    hullPoints,
    deckHalfWidth: (t: number) => {
      const st = new Station(t);
      return Math.max(0.2, st.widthAt(deckSideY(t)) - BULWARK_THICK);
    },
  };
}

/* ------------------------------------------------------------------ *
 *  Stations and bands
 * ------------------------------------------------------------------ */

function buildStations(ports: PortSpec[]): Station[] {
  const ts: number[] = [];
  const N = 72;
  for (let i = 0; i <= N; i++) ts.push(i / N);
  for (const p of ports) {
    ts.push(tAtZ(p.z - p.halfWidth), tAtZ(p.z + p.halfWidth));
  }
  ts.sort((a, b) => a - b);
  const out: Station[] = [];
  let last = -1;
  for (const t of ts) {
    if (t < 0 || t > 1) continue;
    if (t - last < 0.0012) continue;
    last = t;
    out.push(new Station(t));
  }
  return out;
}

function bandRuns(): { lo: number; hi: number; bin: Bin }[] {
  const runs: { lo: number; hi: number; bin: Bin }[] = [];
  let lo = 0;
  for (let j = 1; j < HULL_ROWS.length; j++) {
    const bin = HULL_ROWS[j].bin;
    const next = j + 1 < HULL_ROWS.length ? HULL_ROWS[j + 1].bin : -1;
    if (bin !== next) {
      runs.push({ lo, hi: j, bin });
      lo = j;
    }
  }
  return runs;
}

function binOf(bins: Bins, b: Bin): MeshBuilder {
  return b === Bin.Copper ? bins.copper : b === Bin.Stripe ? bins.stripe : bins.black;
}

/**
 * Baked weathering. The texture carries material detail; position-dependent
 * wear — scuffed wales, chipping at the bow, salt streaks under the gunports,
 * the weed line just above the copper — belongs here.
 */
function hullColor(t: number, row: number, side: number, ports: PortSpec[], c: THREE.Color): void {
  let l = 1;
  let warm = 1;
  const proud = HULL_ROWS[row].proud > 0;

  // Plank-run tonal jitter so nothing looks stamped.
  l *= 0.965 + 0.07 * fract(Math.sin(t * 91.7 + row * 13.3 + side) * 43758.5453);

  if (row <= ROW_COPPER_TOP) {
    // Copper: greener and dirtier low down, brighter where it dries out.
    const f = row / ROW_COPPER_TOP;
    l *= 0.82 + 0.3 * f;
    warm = 0.94 + 0.12 * f;
  } else if (row <= ROW_COPPER_TOP + 2) {
    // Weed / scum line just above the boot top.
    l *= 0.72 + 0.2 * (row - ROW_COPPER_TOP) / 2;
    warm = 0.9;
  }

  if (proud) {
    // Wales take the rub of every boat and fender that ever came alongside.
    l *= 1.16;
  }

  // Chipping and bare-metal scuff at the bow where spray hammers it.
  const bow = smoothstep(0.16, 0.02, t);
  l *= 1 + bow * 0.22;

  // Salt streaking under the gun-deck ports.
  if (row > ROW_PORT_HEAD) {
    let near = 0;
    for (const p of ports) {
      if (!p.gunDeck) continue;
      near = Math.max(near, smoothstep(1.5, 0.25, Math.abs(zAt(t) - p.z)));
    }
    l *= 1 + near * 0.06;
  }
  if (row > ROW_COPPER_TOP && row < ROW_PORT_SILL) {
    let near = 0;
    for (const p of ports) {
      if (!p.gunDeck) continue;
      near = Math.max(near, smoothstep(1.2, 0.3, Math.abs(zAt(t) - p.z)));
    }
    l *= 1 + near * 0.12;
  }

  c.setRGB(l * warm, l, l / Math.max(0.7, warm) * 0.99);
}

function fract(x: number): number {
  return x - Math.floor(x);
}

/* ------------------------------------------------------------------ *
 *  Gun ports
 * ------------------------------------------------------------------ */

function buildPortLiner(
  bins: Bins,
  stations: Station[],
  P: THREE.Vector3[][],
  rowY: Float32Array[],
  p: PortSpec,
  i0: number, i1: number, jLo: number, jHi: number,
  th: number,
  side: number,
): void {
  const b = bins.buff;
  b.setColorHexLinear(0xffffff, p.gunDeck ? 0.55 : 0.8);

  const inner = (i: number, j: number, out: THREE.Vector3) => {
    const st = stations[i];
    const y = rowY[i][j];
    const s = st.slopeAt(y);
    const inv = 1 / Math.hypot(1, s);
    const w = P[i][j].x - th * inv;
    out.set(side * w, y + th * s * inv, st.z);
  };
  const outer = (i: number, j: number, out: THREE.Vector3) => {
    out.set(side * P[i][j].x, P[i][j].y, P[i][j].z);
  };

  const a = new THREE.Vector3();
  const bb = new THREE.Vector3();
  const cc = new THREE.Vector3();
  const dd = new THREE.Vector3();
  const n = new THREE.Vector3();
  const e0 = new THREE.Vector3();
  const e1 = new THREE.Vector3();

  // A liner is a short tunnel, so every one of its faces looks in at the
  // aperture. Aiming at the aperture centre gets the sill, head and both jambs
  // right in one rule instead of four hand-chosen vertex orders that only
  // happened to be correct on one side of the ship.
  const aim = new THREE.Vector3();
  {
    const mid = ((i0 + i1) / 2) | 0;
    const jm = (jLo + jHi) >> 1;
    inner(mid, jm, a);
    outer(mid, jm, bb);
    aim.addVectors(a, bb).multiplyScalar(0.5);
  }
  const ctr = new THREE.Vector3();

  const quadFrom = (
    fa: (o: THREE.Vector3) => void, fb: (o: THREE.Vector3) => void,
    fc: (o: THREE.Vector3) => void, fd: (o: THREE.Vector3) => void,
  ) => {
    fa(a); fb(bb); fc(cc); fd(dd);
    n.crossVectors(e0.subVectors(bb, a), e1.subVectors(cc, a)).normalize();
    ctr.copy(a).add(bb).add(cc).add(dd).multiplyScalar(0.25);
    const flip = n.dot(e0.subVectors(aim, ctr)) < 0;
    if (flip) n.negate();
    const i0v = b.vert(a, n, 0, 0);
    const i1v = b.vert(bb, n, 0.5, 0);
    const i2v = b.vert(cc, n, 0.5, 0.5);
    const i3v = b.vert(dd, n, 0, 0.5);
    if (flip) b.quad(i0v, i3v, i2v, i1v);
    else b.quad(i0v, i1v, i2v, i3v);
  };

  // Sill and head: run along the columns so they follow the hull's sheer.
  for (let i = i0; i < i1; i++) {
    quadFrom(
      (o) => outer(i, jLo, o), (o) => outer(i + 1, jLo, o),
      (o) => inner(i + 1, jLo, o), (o) => inner(i, jLo, o),
    );
    quadFrom(
      (o) => inner(i, jHi, o), (o) => inner(i + 1, jHi, o),
      (o) => outer(i + 1, jHi, o), (o) => outer(i, jHi, o),
    );
  }
  // Jambs.
  for (let j = jLo; j < jHi; j++) {
    quadFrom(
      (o) => inner(i0, j, o), (o) => inner(i0, j + 1, o),
      (o) => outer(i0, j + 1, o), (o) => outer(i0, j, o),
    );
    quadFrom(
      (o) => outer(i1, j, o), (o) => outer(i1, j + 1, o),
      (o) => inner(i1, j + 1, o), (o) => inner(i1, j, o),
    );
  }

  // The lid: hinged at the head, closed flush or swung up and out.
  const mid = ((i0 + i1) / 2) | 0;
  const st = stations[mid];
  const yTop = rowY[mid][jHi];
  const yBot = rowY[mid][jLo];
  const wTop = st.widthAt(yTop);
  const s = st.slopeAt((yTop + yBot) * 0.5);
  const inv = 1 / Math.hypot(1, s);
  const nx = side * inv;
  const ny = -s * inv;
  const h = yTop - yBot;
  const lid = bins.black;
  lid.setColorHexLinear(0xffffff, 0.9);
  const hingeY = yTop - 0.02;
  const hingeX = side * (wTop + 0.03);

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const ang = p.open ? 1.32 : 0.03;
  // Hinge axis is horizontal, along the hull.
  q.setFromAxisAngle(new THREE.Vector3(0, 0, side), -ang);
  m.compose(new THREE.Vector3(hingeX, hingeY, st.z), q, new THREE.Vector3(1, 1, 1));
  lid.pushTransform(m);
  // Local frame: the lid hangs down from the hinge, faces outward along +nx.
  const lw = p.halfWidth + 0.07;
  const lh = h + 0.08;
  lid.box(nx * 0.035, -lh * 0.5 * inv, 0, 0.035, lh * 0.5, lw);
  lid.popTransform();

  // Hinge straps and the ring bolt.
  const ir = bins.iron;
  ir.setColorHexLinear(0xffffff, 1);
  for (const zo of [-lw * 0.6, lw * 0.6]) {
    ir.box(hingeX + nx * 0.03, hingeY + ny * 0.03, st.z + zo, 0.045, 0.055, 0.075);
  }
  if (!p.open) ir.box(hingeX + nx * 0.02, yBot + h * 0.42, st.z, 0.05, 0.05, 0.05);
}

/* ------------------------------------------------------------------ *
 *  Keel, stem and head
 * ------------------------------------------------------------------ */

function buildKeel(bins: Bins): void {
  const b = bins.copper;
  b.setColorHexLinear(0xffffff, 0.85);
  const N = 48;
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= N; i++) {
    const t = 0.012 + (i / N) * 0.955;
    pts.push(new THREE.Vector3(0, keelY(t) - 0.28, zAt(t)));
  }
  // Rectangular section: build as two side walls plus the sole.
  const hw = 0.4;
  const hh = 0.46;
  for (const side of [1, -1] as const) {
    b.grid(
      pts.length, 2,
      (i, j, out) => out.set(side * hw, pts[i].y + (j === 0 ? -hh : hh), pts[i].z),
      null,
      { flip: side > 0 },
    );
  }
  b.grid(
    pts.length, 2,
    (i, j, out) => out.set((j === 0 ? -hw : hw), pts[i].y - hh, pts[i].z),
    null,
    { flip: true },
  );
}

function buildStem(bins: Bins, stations: Station[]): void {
  const b = bins.black;
  b.setColorHexLinear(0xffffff, 1.08);

  // The stem itself: a raked timber from the forefoot to the top of the head.
  const stemPts: [number, number][] = [
    [-25.9, -5.6], [-27.0, -3.0], [-27.9, 0.0], [-28.5, 2.4],
    [-28.9, 4.4], [-29.0, 6.2], [-28.7, 8.1],
  ];
  const path: THREE.Vector3[] = stemPts.map(([z, y]) => new THREE.Vector3(0, y, z));
  const radii = stemPts.map((_, i) => 0.44 - i * 0.018);
  b.tube(path, radii, 7, true);

  // Cutwater / knee of the head: a thin vertical fin forward of the stem.
  const cw: [number, number][] = [
    [-28.0, -1.6], [-29.4, 0.6], [-30.6, 2.6], [-31.4, 4.4], [-31.6, 5.9],
  ];
  for (let i = 0; i < cw.length - 1; i++) {
    const [z0, y0] = cw[i];
    const [z1, y1] = cw[i + 1];
    const hw = 0.2 - i * 0.02;
    b.grid(
      2, 2,
      (ii, jj, out) => out.set((jj === 0 ? -hw : hw), ii === 0 ? y0 : y1, ii === 0 ? z0 : z1),
      null,
    );
    for (const side of [1, -1] as const) {
      b.grid(
        2, 2,
        (ii, jj, out) => {
          const z = ii === 0 ? z0 : z1;
          const y = ii === 0 ? y0 : y1;
          out.set(side * hw, y + (jj === 0 ? -0.55 : 0.0), z + (jj === 0 ? 0.5 : 0));
        },
        null,
        { flip: side > 0 },
      );
    }
  }

  // Head rails: two curved rails per side sweeping from the bow up to the
  // bowsprit, with the trailboard between them.
  for (const side of [1, -1] as const) {
    for (const [k, lift] of [[0, 0], [1, 1]] as const) {
      const rail: THREE.Vector3[] = [];
      const rad: number[] = [];
      for (let i = 0; i <= 9; i++) {
        const s = i / 9;
        const z = -25.4 - s * 6.0;
        const y = 5.3 + lift * 0.95 + s * (1.5 + lift * 0.55) - s * s * 0.55;
        const x = side * (1.6 + lift * 0.16) * (1 - s * s * 0.86);
        rail.push(new THREE.Vector3(x, y, z));
        rad.push(0.115 - s * 0.035);
      }
      b.tube(rail, rad, 6, true);
      void k;
    }
    // Trailboard: the carved panel between the rails.
    bins.brass.setColorHexLinear(0xffffff, 0.9);
    bins.brass.grid(
      8, 2,
      (i, j, out) => {
        const s = i / 7;
        const z = -25.5 - s * 5.4;
        const y = 5.5 + s * 1.5 - s * s * 0.5 + j * (0.85 - s * 0.35);
        out.set(side * (1.5 * (1 - s * s * 0.85)), y, z);
      },
      null,
      { flip: side < 0 },
    );
  }

  // Billethead: the carved scroll at the top of the cutwater.
  const g = bins.brass;
  g.setColorHexLinear(0xffffff, 1.0);
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2.4;
    const r = 0.62 * (1 - i / 12);
    g.box(0, 6.35 + Math.sin(a) * r, -31.5 + Math.cos(a) * r * 0.85, 0.11, 0.13, 0.13);
  }
  // Gammoning: the lashing that holds the bowsprit down to the stem.
  bins.iron.setColorHexLinear(0xffffff, 0.9);
  for (let i = 0; i < 5; i++) {
    bins.iron.box(0, 6.0 + i * 0.12, -28.4 - i * 0.18, 0.26, 0.05, 0.1);
  }

  // Catheads: the beams the anchors hang from.
  for (const side of [1, -1] as const) {
    const cat = bins.oak;
    cat.setColorHexLinear(0xffffff, 0.85);
    const t = tAtZ(-24.0);
    const st = new Station(t);
    const w = st.widthAt(sheerY(t) - 0.6);
    const a = new THREE.Vector3(side * (w - 0.8), sheerY(t) - 0.35, -23.6);
    const bp = new THREE.Vector3(side * (w + 1.85), sheerY(t) + 0.05, -25.4);
    cat.spar(a, bp, 0.24, 0.2, 6);
    bins.iron.box(bp.x, bp.y - 0.16, bp.z, 0.16, 0.16, 0.16);
  }
  void stations;
}

/* ------------------------------------------------------------------ *
 *  Transom
 * ------------------------------------------------------------------ */

function buildTransom(
  bins: Bins,
  stations: Station[],
  rowY: Float32Array[],
  P: THREE.Vector3[][],
): void {
  const last = stations.length - 1;
  const st = stations[last];
  const nr = HULL_ROWS.length;

  // The transom rakes aft going up and tucks in slightly at the edges.
  const rake = (y: number) => {
    const f = smoothstep(st.keel, st.sheer, y);
    return 1.85 * f * f;
  };
  const b = bins.black;

  // Counter: the band between the last station and the transom's own edge.
  for (const side of [1, -1] as const) {
    b.setColorHexLinear(0xffffff, 1.0);
    b.grid(
      nr, 2,
      (j, k, out) => {
        const p = P[last][j];
        const dz = k === 0 ? 0 : rake(p.y);
        const shrink = k === 0 ? 1 : 0.965;
        out.set(side * p.x * shrink, p.y, p.z + dz);
      },
      null,
      { flip: side < 0, swapUv: true,
        colorFn: (j, _k, c) => c.setScalar(0.94 + 0.1 * (j / nr)) },
    );
  }

  // The transom face: slightly convex, with the window band and the nameboard.
  const rows = 14;
  const cols = 15;
  const yOf = (j: number) => st.keel + (st.sheer - st.keel) * (j / (rows - 1));
  const wOf = (j: number) => st.widthAt(yOf(j)) * 0.965;
  b.setColorHexLinear(0xffffff, 0.98);
  b.grid(
    cols, rows,
    (i, j, out) => {
      const y = yOf(j);
      const w = wOf(j);
      const f = (i / (cols - 1)) * 2 - 1;
      // Convexity: the transom bulges aft in the middle.
      const bulge = 0.32 * (1 - f * f);
      out.set(f * w, y, st.z + rake(y) + bulge);
    },
    (i, j) => [(i / (cols - 1)) * (wOf(j) * 2) / TILE_ALONG, (yOf(j) - st.keel) / TILE_ACROSS],
    {
      colorFn: (i, j, c) => {
        const f = j / (rows - 1);
        c.setScalar(0.9 + 0.18 * f);
      },
    },
  );

  // Stern windows: two ranges of lights in the great cabin and the wardroom.
  const glass = bins.glass;
  const gilt = bins.brass;
  for (const [yc, hh, count] of [[st.keel + (st.sheer - st.keel) * 0.5, 0.62, 6],
    [st.keel + (st.sheer - st.keel) * 0.74, 0.5, 6]] as const) {
    const w = st.widthAt(yc) * 0.86;
    for (let i = 0; i < count; i++) {
      const f = (i + 0.5) / count * 2 - 1;
      const x = f * w;
      const z = st.z + rake(yc) + 0.32 * (1 - f * f) + 0.06;
      glass.setColorHexLinear(0x7f95a8, 0.55);
      glass.box(x, yc, z, w / count * 0.34, hh * 0.5, 0.05);
      gilt.setColorHexLinear(0xffffff, 0.75);
      // Frame.
      gilt.box(x, yc + hh * 0.55, z + 0.02, w / count * 0.4, 0.06, 0.06);
      gilt.box(x, yc - hh * 0.55, z + 0.02, w / count * 0.4, 0.06, 0.06);
      gilt.box(x - w / count * 0.38, yc, z + 0.02, 0.055, hh * 0.55, 0.06);
      gilt.box(x + w / count * 0.38, yc, z + 0.02, 0.055, hh * 0.55, 0.06);
      // Muntin.
      gilt.box(x, yc, z + 0.02, 0.03, hh * 0.5, 0.05);
    }
  }

  // Mouldings across the counter and under the taffrail.
  for (const f of [0.34, 0.62, 0.88]) {
    const y = st.keel + (st.sheer - st.keel) * f;
    const w = st.widthAt(y) * 0.975;
    const z = st.z + rake(y) + 0.2;
    b.setColorHexLinear(0xffffff, 1.15);
    b.grid(
      13, 2,
      (i, j, out) => {
        const fx = (i / 12) * 2 - 1;
        out.set(fx * w, y + (j - 0.5) * 0.19, z + 0.26 * (1 - fx * fx) + 0.06);
      },
      null,
    );
  }

  // Carved nameboard.
  gilt.setColorHexLinear(0xffffff, 1.0);
  {
    const y = st.keel + (st.sheer - st.keel) * 0.9;
    const w = st.widthAt(y) * 0.62;
    for (let i = 0; i < 12; i++) {
      const fx = (i / 11) * 2 - 1;
      const x = fx * w;
      gilt.box(x, y, st.z + rake(y) + 0.32 * (1 - fx * fx) + 0.1, w / 14, 0.15, 0.05);
    }
  }

  // Taffrail with turned stanchions.
  const oak = bins.oak;
  oak.setColorHexLinear(0xffffff, 0.8);
  {
    const y = st.sheer;
    const w = st.widthAt(y) * 0.96;
    for (let i = 0; i <= 10; i++) {
      const fx = (i / 10) * 2 - 1;
      const x = fx * w;
      const z = st.z + rake(y) + 0.3 * (1 - fx * fx);
      stanchion(oak, x, y, z, 0.45);
    }
    b.setColorHexLinear(0xffffff, 1.1);
    b.grid(
      13, 2,
      (i, j, out) => {
        const fx = (i / 12) * 2 - 1;
        out.set(fx * (w + 0.1), y + 0.46 + j * 0.1, st.z + rake(y) + 0.3 * (1 - fx * fx) + (j - 0.5) * 0.26);
      },
      null,
      { flip: true },
    );
  }

  // Quarter badges: the little galleries at the after corners.
  for (const side of [1, -1] as const) {
    const t = tAtZ(Z_TRANSOM - 4.4);
    const s2 = new THREE.Vector3();
    const stq = new Station(t);
    const yc = sheerY(t) - 1.9;
    const w = stq.widthAt(yc);
    b.setColorHexLinear(0xffffff, 1.05);
    b.grid(
      9, 7,
      (i, j, out) => {
        const a = (i / 8) * Math.PI - Math.PI * 0.5;
        const v = j / 6;
        const r = 0.72 * Math.sin(Math.PI * (0.15 + 0.7 * v));
        s2.set(
          side * (w - 0.15 + Math.cos(a) * r),
          yc - 0.9 + v * 2.0,
          Z_TRANSOM - 4.4 + Math.sin(a) * r * 1.5,
        );
        out.copy(s2);
      },
      null,
      { flip: side > 0 },
    );
    glass.setColorHexLinear(0x7f95a8, 0.5);
    glass.box(side * (w + 0.42), yc + 0.3, Z_TRANSOM - 4.4, 0.06, 0.34, 0.5);
    gilt.setColorHexLinear(0xffffff, 0.8);
    gilt.box(side * (w + 0.44), yc - 0.85, Z_TRANSOM - 4.4, 0.1, 0.12, 0.66);
    gilt.box(side * (w + 0.44), yc + 0.9, Z_TRANSOM - 4.4, 0.1, 0.12, 0.6);
  }
}

/* ------------------------------------------------------------------ *
 *  Bulwarks and rails
 * ------------------------------------------------------------------ */

function buildBulwarks(bins: Bins, stations: Station[], ports: PortSpec[], quality: number): void {
  const ns = stations.length;
  const b = bins.buff;

  const levels: ((t: number) => number)[] = [
    (t) => deckSideY(t),
    (t) => deckSideY(t) + (sheerY(t) - 1.15 - deckSideY(t)) * 0.5,
    (t) => sheerY(t) - 1.15,
    (t) => sheerY(t) - 0.785,
    (t) => sheerY(t) - 0.42,
    (t) => sheerY(t) - 0.19,
    (t) => sheerY(t),
  ];
  const SILL = 2;
  const HEAD = 4;

  const inner: THREE.Vector3[][] = [];
  for (let i = 0; i < ns; i++) {
    const st = stations[i];
    const col: THREE.Vector3[] = [];
    for (let j = 0; j < levels.length; j++) {
      const y = levels[j](st.t);
      col.push(new THREE.Vector3(Math.max(0.15, st.widthAt(y) - BULWARK_THICK), y, st.z));
    }
    inner.push(col);
  }

  const cutIn: Uint8Array[] = [];
  for (let i = 0; i < ns - 1; i++) cutIn.push(new Uint8Array(levels.length - 1));
  for (const p of ports) {
    if (p.gunDeck) continue;
    for (let i = 0; i < ns - 1; i++) {
      if (stations[i].z >= p.z - p.halfWidth - 1e-4 && stations[i + 1].z <= p.z + p.halfWidth + 1e-4) {
        for (let j = SILL; j < HEAD; j++) cutIn[i][j] = 1;
      }
    }
  }

  // Forecastle and quarterdeck ends: stop the bulwark short of the stem/transom.
  const iStart = stations.findIndex((s) => s.t > 0.055);
  const iEnd = stations.length - 1;

  for (const side of [1, -1] as const) {
    b.setColorHexLinear(0xffffff, 1);
    b.grid(
      iEnd - iStart + 1, levels.length,
      (i, j, out) => {
        const p = inner[i + iStart][j];
        out.set(side * p.x, p.y, p.z);
      },
      null,
      {
        // The inboard face of the bulwark looks in at the deck.
        flip: side < 0,
        skip: (i, j) => cutIn[i + iStart][j] === 1,
        colorFn: (i, j, c) => {
          // Buff paint gets scuffed low down where gear and feet hit it.
          const f = j / (levels.length - 1);
          c.setScalar(0.82 + 0.24 * f);
        },
      },
    );
  }

  // Rail cap: closes the bulwark's top edge.
  const black = bins.black;
  black.setColorHexLinear(0xffffff, 1.05);
  for (const side of [1, -1] as const) {
    black.grid(
      iEnd - iStart + 1, 2,
      (i, j, out) => {
        const st = stations[i + iStart];
        const y = sheerY(st.t) + 0.06;
        const wOut = st.widthAt(sheerY(st.t));
        const wIn = inner[i + iStart][levels.length - 1].x;
        out.set(side * (j === 0 ? wOut + 0.06 : wIn - 0.04), y, st.z);
      },
      null,
    );
  }

  // Hammock netting: iron cranes and a netted roll along the rail.
  const ir = bins.iron;
  ir.setColorHexLinear(0xffffff, 0.9);
  const step = quality >= 2 ? 1.5 : 2.4;
  for (const side of [1, -1] as const) {
    for (let z = -18; z < 19; z += step) {
      const t = tAtZ(z);
      const st = new Station(t);
      const y = sheerY(t);
      const w = st.widthAt(y);
      ir.box(side * (w + 0.02), y + 0.42, z, 0.035, 0.36, 0.035);
      ir.box(side * (w + 0.14), y + 0.78, z, 0.16, 0.035, 0.035);
    }
    // The hammocks themselves: a pale canvas roll.
    bins.buff.setColorHexLinear(0xd8d2c2, 1.0);
    bins.buff.grid(
      26, 6,
      (i, j, out) => {
        const z = -18 + (i / 25) * 37;
        const t = tAtZ(z);
        const st = new Station(t);
        const y = sheerY(t);
        const w = st.widthAt(y);
        const a = (j / 5) * Math.PI;
        const r = 0.33;
        out.set(side * (w + 0.06 + Math.sin(a) * r * 0.7), y + 0.46 + (1 - Math.cos(a)) * r, z);
      },
      null,
      { flip: side > 0, colorFn: (i, _j, c) => c.setScalar(0.9 + 0.14 * fract(Math.sin(i * 12.9898) * 43758.5453)) },
    );
  }
}

/* ------------------------------------------------------------------ *
 *  Decks
 * ------------------------------------------------------------------ */

function buildDecks(bins: Bins, stations: Station[]): void {
  const d = bins.deck;
  const NZ = 96;
  const NX = 20;
  const t0 = 0.045;
  const t1 = 0.968;

  const halfAt = (t: number) => {
    const st = new Station(t);
    return Math.max(0.25, st.widthAt(deckSideY(t)) - BULWARK_THICK);
  };

  d.setColorHexLinear(0xffffff, 1);
  d.grid(
    NZ, NX,
    (i, j, out) => {
      const t = t0 + (i / (NZ - 1)) * (t1 - t0);
      const w = halfAt(t);
      const f = (j / (NX - 1)) * 2 - 1;
      const y = deckSideY(t) + DECK_CAMBER * (1 - f * f);
      out.set(f * w, y, zAt(t));
    },
    (i, j) => {
      const t = t0 + (i / (NZ - 1)) * (t1 - t0);
      const w = halfAt(t);
      const f = (j / (NX - 1)) * 2 - 1;
      return [zAt(t) / TILE_ALONG, (f * w) / TILE_ACROSS];
    },
    {
      colorFn: (i, j, c) => {
        // Traffic wear: pale amidships along the gangways, darker at the edges.
        const f = Math.abs((j / (NX - 1)) * 2 - 1);
        c.setScalar(0.9 + 0.16 * (1 - f * f) + 0.05 * fract(Math.sin(i * 7.13) * 43758.5453));
      },
    },
  );

  // Gun deck: visible through the open ports. Darker and simpler.
  d.setColorHexLinear(0xffffff, 0.4);
  d.grid(
    40, 10,
    (i, j, out) => {
      const t = 0.08 + (i / 39) * 0.85;
      const st = new Station(t);
      const y = gunDeckY(t);
      const w = Math.max(0.3, st.widthAt(y) - HULL_THICK);
      const f = (j / 9) * 2 - 1;
      out.set(f * w, y + DECK_CAMBER * 0.5 * (1 - f * f), zAt(t));
    },
    null,
  );

  // Inboard shell of the gun deck, so an open port shows a lit interior edge.
  const b = bins.buff;
  b.setColorHexLinear(0xffffff, 0.42);
  for (const side of [1, -1] as const) {
    b.grid(
      40, 4,
      (i, j, out) => {
        const t = 0.08 + (i / 39) * 0.85;
        const st = new Station(t);
        const y0 = gunDeckY(t);
        const y1 = deckSideY(t) - 0.35;
        const y = y0 + (y1 - y0) * (j / 3);
        out.set(side * Math.max(0.3, st.widthAt(y) - HULL_THICK), y, zAt(t));
      },
      null,
      { flip: side < 0 },
    );
  }
  // Underside of the spar deck.
  d.setColorHexLinear(0xffffff, 0.3);
  d.grid(
    30, 8,
    (i, j, out) => {
      const t = 0.08 + (i / 29) * 0.85;
      const st = new Station(t);
      const y = deckSideY(t) - 0.3;
      const w = Math.max(0.3, st.widthAt(y) - HULL_THICK);
      const f = (j / 7) * 2 - 1;
      out.set(f * w, y, zAt(t));
    },
    null,
    { flip: true },
  );
  void stations;
}

/* ------------------------------------------------------------------ *
 *  Channels
 * ------------------------------------------------------------------ */

/** Where each mast's shrouds land on the channels. */
export const CHANNELS: readonly { mast: number; z0: number; z1: number }[] = [
  { mast: 0, z0: -15.2, z1: -10.4 },
  { mast: 1, z0: 2.0, z1: 7.4 },
  { mast: 2, z0: 16.6, z1: 20.2 },
];

function buildChannels(bins: Bins): void {
  const b = bins.black;
  const ir = bins.iron;
  for (const ch of CHANNELS) {
    for (const side of [1, -1] as const) {
      b.setColorHexLinear(0xffffff, 1.0);
      // A stout plank projecting from the hull just under the sheer moulding.
      b.grid(
        7, 2,
        (i, j, out) => {
          const z = ch.z0 + (i / 6) * (ch.z1 - ch.z0);
          const t = tAtZ(z);
          const st = new Station(t);
          const y = sheerY(t) - 0.85;
          const w = st.widthAt(y);
          out.set(side * (w + (j === 0 ? 0.02 : 0.92)), y + 0.06, z);
        },
        null,
        { flip: side < 0 },
      );
      b.grid(
        7, 2,
        (i, j, out) => {
          const z = ch.z0 + (i / 6) * (ch.z1 - ch.z0);
          const t = tAtZ(z);
          const st = new Station(t);
          const y = sheerY(t) - 0.85;
          const w = st.widthAt(y);
          out.set(side * (w + (j === 0 ? 0.02 : 0.92)), y - 0.06, z);
        },
        null,
        { flip: side > 0 },
      );
      // Outer edge with the deadeye score.
      b.grid(
        7, 2,
        (i, j, out) => {
          const z = ch.z0 + (i / 6) * (ch.z1 - ch.z0);
          const t = tAtZ(z);
          const st = new Station(t);
          const y = sheerY(t) - 0.85;
          const w = st.widthAt(y);
          out.set(side * (w + 0.92), y + (j === 0 ? -0.06 : 0.28), z);
        },
        null,
        { flip: side > 0 },
      );
      // Chainplates: iron straps from the channel down to the wale.
      ir.setColorHexLinear(0xffffff, 0.85);
      const n = 6;
      for (let i = 0; i < n; i++) {
        const z = ch.z0 + ((i + 0.5) / n) * (ch.z1 - ch.z0);
        const t = tAtZ(z);
        const st = new Station(t);
        const yTop = sheerY(t) - 0.85;
        const w = st.widthAt(yTop);
        const yBot = st.keel + (yTop - st.keel) * 0.72;
        const wBot = st.widthAt(yBot);
        const a = new THREE.Vector3(side * (w + 0.86), yTop + 0.1, z);
        const bp = new THREE.Vector3(side * (wBot + 0.05), yBot, z);
        ir.spar(a, bp, 0.05, 0.05, 4);
      }
    }
  }
}

/** A turned stanchion / baluster, used along the taffrail and quarter rails. */
export function stanchion(b: MeshBuilder, x: number, y: number, z: number, h: number): void {
  b.pushTransform(new THREE.Matrix4().makeTranslation(x, y, z));
  b.revolve(
    [
      [0.06, 0], [0.075, h * 0.1], [0.05, h * 0.25], [0.075, h * 0.42],
      [0.055, h * 0.62], [0.07, h * 0.82], [0.05, h],
    ],
    7,
  );
  b.popTransform();
}
