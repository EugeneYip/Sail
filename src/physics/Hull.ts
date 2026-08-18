import * as THREE from 'three';
import { catmullRom } from '../util/math';
import {
  ADDED_INERTIA_PITCH,
  ADDED_INERTIA_ROLL,
  ADDED_INERTIA_YAW,
  ADDED_MASS_HEAVE,
  ADDED_MASS_SURGE,
  ADDED_MASS_SWAY,
  BEAM,
  CG_Y,
  CG_Z,
  DISPLACED_VOLUME,
  DRAUGHT,
  FREEBOARD,
  GRAVITY,
  K_PITCH,
  K_ROLL,
  K_YAW,
  LWL,
  MASS,
  RHO_WATER,
  TOPSIDE_FLARE,
  TUMBLEHOME,
} from './constants';

/**
 * Parametric hull discretisation.
 *
 * The ship agent publishes `world.ext.ship.hullPoints`, but that is a bare
 * point cloud with no normals, areas or topology — useless for a pressure
 * integral — so these sections are built here from the AGENTS.md dimensions:
 * 53.3 m waterline, 13.3 m beam, 6.4 m draught, and the block coefficient of
 * 0.47 implied by the 2200 t displacement. The section shape is a frigate's:
 * near-vertical sides above the turn of the bilge, a hard bilge, a narrow keel,
 * a fine bow, a fine underwater run aft, and marked tumblehome above water.
 * If the ship agent ever publishes real offsets, `buildHull` is the only thing
 * that has to change.
 *
 * Panels tile the hull as a quad grid: 11 stations bow to stern by 7 girth
 * levels (rail -> waterline -> keel), mirrored to both sides, plus a deck cap.
 * 140 panels total. The deck cap matters: without it a submerged hull's
 * pressure integral grows without bound with depth, and she "floats" harder the
 * deeper she is pushed. The topsides matter for the same reason in reverse —
 * they are the reserve buoyancy that stops her burying her bow in a gale and
 * that keeps the righting arm growing past 25 deg.
 *
 * The 4x saving that makes this affordable is that all panels in one station
 * column share a single ocean sample (20 per substep, not 140): a 100 m wave is
 * smooth over a 5 m footprint, and roll restoring is preserved exactly because
 * each panel still uses its own submerged depth against the shared plane.
 *
 * Bow and transom caps are omitted. AREA_CLOSURE corrects the resulting volume
 * deficit so she floats exactly at her design waterline, and `measureClosure`
 * measures what the missing caps do to the horizontal (Froude-Krylov) part of
 * the integral so that can be corrected too.
 */

/** Half-beam envelope along the waterline, fraction of max half-beam. */
const HALF_BEAM_CURVE = [0.02, 0.34, 0.74, 0.95, 1.0, 0.99, 0.92, 0.74, 0.46, 0.3];

/** Keel depth along the length, fraction of DRAUGHT. Deepest at ~60% aft. */
const KEEL_CURVE = [0.42, 0.78, 0.94, 0.99, 1.0, 1.0, 0.99, 0.94, 0.84, 0.66];

/**
 * Section half-width as a function of depth fraction (0 = waterline, 1 = keel).
 * Nearly vertical to the turn of the bilge at t ~ 0.75, then tucking hard in to
 * the keel. This is what sets BM, and through BM the metacentric height.
 */
const SECTION_CURVE = [1.0, 0.995, 0.98, 0.95, 0.9, 0.79, 0.6, 0.36, 0.12, 0.05];

/**
 * Girth levels as a signed fraction: negative is above the waterline as a
 * fraction of FREEBOARD, positive is below as a fraction of the local keel
 * depth. Packed toward the waterline, where roll and wave immersion live.
 */
const GIRTH_T = [-1.0, -0.42, 0, 0.34, 0.62, 0.84, 1.0];

const STATIONS = 11;
const GIRTH = GIRTH_T.length;
/** Index of the waterline level in GIRTH_T. */
const WL_LEVEL = 2;

/** Sample a normalised control-point curve with Catmull-Rom, u in [0,1]. */
function curve(table: number[], u: number): number {
  const n = table.length - 1;
  const x = THREE.MathUtils.clamp(u, 0, 1) * n;
  const i = Math.min(n - 1, Math.floor(x));
  const t = x - i;
  const p0 = table[Math.max(0, i - 1)];
  const p1 = table[i];
  const p2 = table[i + 1];
  const p3 = table[Math.min(n, i + 2)];
  return catmullRom(p0, p1, p2, p3, t);
}

export interface Hull {
  /** Panel count. */
  readonly count: number;
  /** Panel centroids, ship-local, flat xyz. */
  readonly cx: Float32Array;
  readonly cy: Float32Array;
  readonly cz: Float32Array;
  /** Outward unit normals, ship-local, flat xyz. */
  readonly nx: Float32Array;
  readonly ny: Float32Array;
  readonly nz: Float32Array;
  /** Panel areas, m^2, including the closure correction. */
  readonly area: Float32Array;
  /**
   * Half the panel's vertical extent, m. Drives the smooth partial-immersion
   * blend — without it the waterline quantises to the panel rows and heave
   * turns into a staircase.
   */
  readonly half: Float32Array;
  /** Index into the column arrays — panels in a column share one ocean sample. */
  readonly column: Uint16Array;

  /** Number of ocean sample columns. */
  readonly columns: number;
  /** Column sample points, ship-local XZ (y is always 0). */
  readonly colX: Float32Array;
  readonly colZ: Float32Array;

  /** Deepest point of the hull, ship-local y. */
  readonly keelY: number;
  /** Bow and stern extremes, ship-local z. */
  readonly bowZ: number;
  readonly sternZ: number;
}

/** Half-width of the hull at length fraction u and girth parameter t. */
function halfWidth(u: number, t: number): number {
  const wl = Math.max(0, curve(HALF_BEAM_CURVE, u));
  if (t >= 0) return wl * (BEAM / 2) * Math.max(0, curve(SECTION_CURVE, t));
  // Above water: the ends fill out (reserve buoyancy forward) and the sides
  // fall in toward the rail.
  const s = Math.min(1, -t);
  const filled = wl + TOPSIDE_FLARE * s * (1 - wl);
  return filled * (BEAM / 2) * (1 - TUMBLEHOME * s * s);
}

/** Local y of girth level t at length fraction u. */
function levelY(u: number, t: number): number {
  return t >= 0 ? -DRAUGHT * curve(KEEL_CURVE, u) * t : FREEBOARD * -t;
}

export function buildHull(): Hull {
  const sidePanels = (STATIONS - 1) * (GIRTH - 1);
  const deckPanels = STATIONS - 1;
  const count = (sidePanels + deckPanels) * 2;

  const cx = new Float32Array(count);
  const cy = new Float32Array(count);
  const cz = new Float32Array(count);
  const nx = new Float32Array(count);
  const ny = new Float32Array(count);
  const nz = new Float32Array(count);
  const area = new Float32Array(count);
  const half = new Float32Array(count);
  const column = new Uint16Array(count);

  const columns = (STATIONS - 1) * 2;
  const colX = new Float32Array(columns);
  const colZ = new Float32Array(columns);

  // Vertex grid for one side: [station][girth] -> local position.
  const vx: number[][] = [];
  const vy: number[][] = [];
  const vz: number[][] = [];
  for (let i = 0; i < STATIONS; i++) {
    const u = i / (STATIONS - 1);
    const z = -LWL / 2 + u * LWL; // bow at -Z
    vx.push([]);
    vy.push([]);
    vz.push([]);
    for (let j = 0; j < GIRTH; j++) {
      const t = GIRTH_T[j];
      vx[i].push(halfWidth(u, t));
      vy[i].push(levelY(u, t));
      vz[i].push(z);
    }
  }

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const n = new THREE.Vector3();

  let p = 0;
  for (let side = 0; side < 2; side++) {
    const s = side === 0 ? 1 : -1; // starboard, then port
    for (let i = 0; i < STATIONS - 1; i++) {
      const col = side * (STATIONS - 1) + i;
      // One ocean sample per column, taken at the column's mid-girth footprint.
      colX[col] = (s * (vx[i][WL_LEVEL + 2] + vx[i + 1][WL_LEVEL + 2])) / 2;
      colZ[col] = (vz[i][0] + vz[i + 1][0]) / 2;

      for (let j = 0; j < GIRTH - 1; j++) {
        // Quad corners, wound so the cross product of the diagonals faces out.
        const x0 = s * vx[i][j];
        const x1 = s * vx[i + 1][j];
        const x2 = s * vx[i + 1][j + 1];
        const x3 = s * vx[i][j + 1];
        const y0 = vy[i][j];
        const y1 = vy[i + 1][j];
        const y2 = vy[i + 1][j + 1];
        const y3 = vy[i][j + 1];
        const z0 = vz[i][j];
        const z1 = vz[i + 1][j];
        const z2 = vz[i + 1][j + 1];
        const z3 = vz[i][j + 1];

        a.set(x2 - x0, y2 - y0, z2 - z0);
        b.set(x3 - x1, y3 - y1, z3 - z1);
        n.crossVectors(a, b);
        const twiceArea = n.length();
        if (twiceArea < 1e-9) continue;
        n.multiplyScalar(1 / twiceArea);
        // Outward means away from the centreline for the sides and down for the
        // bottom; both are satisfied by pointing away from the hull axis.
        if (n.x * s < 0 && Math.abs(n.x) > Math.abs(n.y)) n.negate();
        else if (Math.abs(n.y) >= Math.abs(n.x) && n.y > 0) n.negate();

        cx[p] = (x0 + x1 + x2 + x3) / 4;
        cy[p] = (y0 + y1 + y2 + y3) / 4;
        cz[p] = (z0 + z1 + z2 + z3) / 4;
        nx[p] = n.x;
        ny[p] = n.y;
        nz[p] = n.z;
        area[p] = twiceArea / 2;
        half[p] = Math.max(0.2, (Math.max(y0, y1, y2, y3) - Math.min(y0, y1, y2, y3)) / 2);
        column[p] = col;
        p++;
      }

      // Deck cap, centreline to rail. Closes the volume from above so a
      // swamped hull stops gaining buoyancy with depth.
      const w0 = vx[i][0];
      const w1 = vx[i + 1][0];
      const dz = vz[i + 1][0] - vz[i][0];
      const capArea = ((w0 + w1) / 2) * Math.abs(dz);
      if (capArea > 1e-6) {
        cx[p] = (s * (w0 + w1)) / 4;
        cy[p] = (vy[i][0] + vy[i + 1][0]) / 2;
        cz[p] = (vz[i][0] + vz[i + 1][0]) / 2;
        nx[p] = 0;
        ny[p] = 1;
        nz[p] = 0;
        area[p] = capArea;
        half[p] = 0.3; // a flat panel still needs a soft immersion blend
        column[p] = col;
        p++;
      }
    }
  }

  const hull: Hull = {
    count: p,
    cx, cy, cz, nx, ny, nz, area, half, column,
    columns, colX, colZ,
    keelY: -DRAUGHT,
    bowZ: -LWL / 2,
    sternZ: LWL / 2,
  };

  // Closure correction: scale areas so the pressure integral at the design
  // waterline displaces exactly DISPLACED_VOLUME, making up for the missing
  // bow and transom caps.
  const raw = verticalIntegral(hull, 0);
  if (raw > 1e-6) {
    const k = DISPLACED_VOLUME / raw;
    for (let i = 0; i < p; i++) area[i] *= k;
  }

  return hull;
}

/**
 * Submerged-fraction weighted `depth * area` for one panel, and the height of
 * the wetted centroid above the panel centroid.
 *
 * `d` is the depth of the panel centroid below the water plane and `h` its
 * vertical half-extent. A panel straddling the surface contributes only its
 * wetted part, and does so C1-continuously in `d` — which is the difference
 * between a hull that rides a wave and one that chatters.
 */
export function wetWeight(d: number, h: number): number {
  const t = d + h;
  if (t <= 0) return 0;
  if (d >= h) return d;
  return (t * t) / (4 * h);
}

/**
 * Volume implied by the vertical component of the pressure integral for an
 * upright hull whose origin sits `offsetY` above a flat sea. Used at init for
 * the closure correction and for the hydrostatic diagnostics.
 */
function verticalIntegral(hull: Hull, offsetY: number): number {
  let fy = 0;
  for (let i = 0; i < hull.count; i++) {
    const w = wetWeight(-(hull.cy[i] + offsetY), hull.half[i]);
    if (w <= 0) continue;
    fy -= w * hull.area[i] * hull.ny[i];
  }
  return fy;
}

/* ------------------------------------------------------------------ *
 *  Mass properties
 * ------------------------------------------------------------------ */

export interface MassProperties {
  mass: number;
  /** Centre of gravity, ship-local. */
  cg: THREE.Vector3;
  /** Effective mass along body X (sway), Y (heave), Z (surge), with added mass. */
  mBody: THREE.Vector3;
  /** Effective inertia about body X (pitch), Y (yaw), Z (roll), with added inertia. */
  iBody: THREE.Vector3;
  /** Reciprocals, precomputed — the solver runs these every substep. */
  invMBody: THREE.Vector3;
  invIBody: THREE.Vector3;
}

export function buildMassProperties(): MassProperties {
  const cg = new THREE.Vector3(0, CG_Y, CG_Z);
  const mBody = new THREE.Vector3(
    MASS * (1 + ADDED_MASS_SWAY),
    MASS * (1 + ADDED_MASS_HEAVE),
    MASS * (1 + ADDED_MASS_SURGE),
  );
  const iBody = new THREE.Vector3(
    MASS * K_PITCH * K_PITCH * (1 + ADDED_INERTIA_PITCH),
    MASS * K_YAW * K_YAW * (1 + ADDED_INERTIA_YAW),
    MASS * K_ROLL * K_ROLL * (1 + ADDED_INERTIA_ROLL),
  );
  return {
    mass: MASS,
    cg,
    mBody,
    iBody,
    invMBody: new THREE.Vector3(1 / mBody.x, 1 / mBody.y, 1 / mBody.z),
    invIBody: new THREE.Vector3(1 / iBody.x, 1 / iBody.y, 1 / iBody.z),
  };
}

/* ------------------------------------------------------------------ *
 *  Hydrostatic diagnostics
 * ------------------------------------------------------------------ */

export interface Hydrostatics {
  /** Equilibrium sinkage of the hull origin relative to a flat sea, metres. */
  floatY: number;
  /** Volume of displacement at equilibrium, m^3. */
  volume: number;
  /** Centre of buoyancy above the keel, metres. */
  kb: number;
  /** Metacentric radius BM = I_waterplane / V, metres. */
  bm: number;
  /** Metacentric height GM = KB + BM - KG, metres. */
  gm: number;
  /** Natural free-decay roll period, seconds. */
  rollPeriod: number;
  /** Righting arm GZ at 10 / 20 / 30 / 45 deg, metres. */
  gz: number[];
  /**
   * How much of the expected horizontal pressure force the open-ended panel set
   * actually produces, athwartships and fore-and-aft. The solver divides by
   * these so the Froude-Krylov surf force is right despite the missing caps.
   */
  closureX: number;
  closureZ: number;
}

/**
 * Measure the hull's hydrostatics numerically from the panel set. Called once
 * at init so the figures in constants.ts can be checked against reality rather
 * than asserted. `ShipDynamics` logs the result when `settings.debug` is on.
 *
 * Measured for the hull above (140 panels, closure factor 1.14):
 *   float offset   0.000 m    floats exactly on her design waterline
 *   volume        2146.3 m^3
 *   KB             4.22 m
 *   BM             2.39 m
 *   KG             5.66 m
 *   GM             0.95 m
 *   roll period   11.6 s      linearised; the solver's own free-decay period is
 *                             9.3 s, measured over eight cycles from a 20 deg
 *                             release on flat water (scripts/physics-test.mjs).
 *                             Shorter than the linear figure because the GZ
 *                             curve stiffens with angle — see below.
 *   GZ            0.18 / 0.39 / 0.61 / 1.02 m at 10 / 20 / 30 / 45 deg
 *
 * The GZ curve still rising at 45 deg is the topsides doing their job; with the
 * panel set truncated at the waterline it peaked at 20 deg and she could be
 * rolled over by a squall.
 */
export function measureHydrostatics(hull: Hull, mp: MassProperties): Hydrostatics {
  // Equilibrium sinkage: bisect on the vertical pressure integral.
  const target = DISPLACED_VOLUME;
  let lo = -2;
  let hi = 2;
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2;
    if (verticalIntegral(hull, mid) > target) lo = mid;
    else hi = mid;
  }
  const floatY = (lo + hi) / 2;
  const volume = verticalIntegral(hull, floatY);

  // Centre of buoyancy. By the divergence theorem the first moment of the
  // displaced volume is a surface integral: V*ybar = closed integral of
  // (y^2/2)*ny dA. The free-surface cap contributes nothing because y = 0
  // there, so summing the wetted panels alone is exact.
  let mz = 0;
  for (let i = 0; i < hull.count; i++) {
    const y = hull.cy[i] + floatY;
    if (y >= 0) continue;
    mz += ((y * y) / 2) * hull.ny[i] * hull.area[i];
  }
  const cbY = volume > 1e-9 ? mz / volume : -DRAUGHT / 2;
  const kb = cbY + DRAUGHT;

  // BM from the waterplane second moment, integrated over the waterline girth.
  let iT = 0;
  for (let i = 0; i < STATIONS - 1; i++) {
    const u0 = i / (STATIONS - 1);
    const u1 = (i + 1) / (STATIONS - 1);
    const dz = LWL / (STATIONS - 1);
    const bw = (halfWidth(u0, 0) + halfWidth(u1, 0)) / 2;
    iT += ((2 * bw * bw * bw) / 3) * dz; // 2 * integral of x^2 dx from 0..b
  }
  const bm = iT / volume;
  const kg = DRAUGHT + mp.cg.y;
  const gm = kb + bm - kg;

  // T = 2*pi*sqrt(I_roll / (displacement weight * GM)), I includes added inertia.
  const rollPeriod =
    gm > 1e-4 ? 2 * Math.PI * Math.sqrt(mp.iBody.z / (MASS * GRAVITY * gm)) : Infinity;

  const gz = [10, 20, 30, 45].map((deg) => rightingArm(hull, mp, deg * (Math.PI / 180)));
  const { closureX, closureZ } = measureClosure(hull);

  return { floatY, volume, kb, bm, gm, rollPeriod, gz, closureX, closureZ };
}

/**
 * Righting arm at a heel angle, measured directly off the panel set: heel the
 * hull, re-float it to the correct displacement, and read the transverse
 * offset of the centre of buoyancy from the centre of gravity.
 */
function rightingArm(hull: Hull, mp: MassProperties, heel: number): number {
  // Positive heel (starboard rail down) is a NEGATIVE rotation about body +Z,
  // so world = R(-heel) * local:  x' = x*c + y*s,  y' = -x*s + y*c.
  const c = Math.cos(heel);
  const s = Math.sin(heel);
  const wy = (i: number, sink: number): number => -hull.cx[i] * s + hull.cy[i] * c + sink;
  const vol = (sink: number): number => {
    let fy = 0;
    for (let i = 0; i < hull.count; i++) {
      const w = wetWeight(-wy(i, sink), hull.half[i]);
      if (w <= 0) continue;
      const nyW = -hull.nx[i] * s + hull.ny[i] * c;
      fy -= w * hull.area[i] * nyW;
    }
    return fy;
  };
  let lo = -4;
  let hi = 4;
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2;
    if (vol(mid) > DISPLACED_VOLUME) lo = mid;
    else hi = mid;
  }
  const sink = (lo + hi) / 2;

  // Transverse moment of the buoyancy about the (rotated) centre of gravity.
  let fy = 0;
  let mz = 0;
  const gx = mp.cg.x * c + mp.cg.y * s;
  const gy = -mp.cg.x * s + mp.cg.y * c + sink;
  for (let i = 0; i < hull.count; i++) {
    const py = wy(i, sink);
    const w = wetWeight(-py, hull.half[i]);
    if (w <= 0) continue;
    const nxW = hull.nx[i] * c + hull.ny[i] * s;
    const nyW = -hull.nx[i] * s + hull.ny[i] * c;
    const f = -w * hull.area[i];
    const px = hull.cx[i] * c + hull.cy[i] * s;
    fy += f * nyW;
    mz += (px - gx) * (f * nyW) - (py - gy) * (f * nxW);
  }
  return Math.abs(fy) > 1e-6 ? mz / fy : 0;
}

/**
 * How much of the exact horizontal pressure force the open panel set produces.
 * For any closed body the net pressure force in a linearly varying field is
 * rho*g*V along the field normal, so tilting the water plane by a known angle
 * and comparing Fx/Fy against Nx/Ny measures exactly what the missing bow and
 * transom caps cost. Values land near 1 athwartships (the sides close on
 * themselves) and lower fore-and-aft.
 */
function measureClosure(hull: Hull): { closureX: number; closureZ: number } {
  const tilt = 6 * (Math.PI / 180);
  const st = Math.sin(tilt);
  const ct = Math.cos(tilt);

  const axis = (lateral: boolean): number => {
    // Water plane normal, tilted about the other horizontal axis.
    const nX = lateral ? st : 0;
    const nZ = lateral ? 0 : st;
    const nY = ct;
    let fx = 0;
    let fy = 0;
    let fz = 0;
    for (let i = 0; i < hull.count; i++) {
      // Perpendicular depth below the tilted plane through the origin.
      const d = -(hull.cx[i] * nX + hull.cy[i] * nY + hull.cz[i] * nZ);
      const w = wetWeight(d, hull.half[i]);
      if (w <= 0) continue;
      const f = -w * hull.area[i];
      fx += f * hull.nx[i];
      fy += f * hull.ny[i];
      fz += f * hull.nz[i];
    }
    if (Math.abs(fy) < 1e-9) return 1;
    const got = (lateral ? fx : fz) / fy;
    const want = (lateral ? nX : nZ) / nY;
    return Math.abs(want) < 1e-9 ? 1 : THREE.MathUtils.clamp(got / want, 0.25, 4);
  };

  return { closureX: axis(true), closureZ: axis(false) };
}

/** Reference hydrostatic stiffness in heave, N per metre of sinkage. */
export function heaveStiffness(): number {
  let awp = 0;
  for (let i = 0; i < STATIONS - 1; i++) {
    const u0 = i / (STATIONS - 1);
    const u1 = (i + 1) / (STATIONS - 1);
    const dz = LWL / (STATIONS - 1);
    awp += (halfWidth(u0, 0) + halfWidth(u1, 0)) * dz;
  }
  return RHO_WATER * GRAVITY * awp;
}
