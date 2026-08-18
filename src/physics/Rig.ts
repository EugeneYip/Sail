import * as THREE from 'three';
import type { SailState } from '../types';
import { DEG, clamp01, smoothstep } from '../util/math';

/**
 * Rig geometry and thin-membrane aerofoil curves.
 *
 * The sail plan itself is declared in `core/State.ts`; this file adds the
 * geometry that file does not carry — where each sail sits and how big it is in
 * each direction — keyed by sail id.
 *
 * The important and slightly counter-intuitive point about a square sail: its
 * aerodynamic CHORD runs along the yard (athwartships when square) and its SPAN
 * is the vertical hoist. So the aspect ratio is hoist/yard, which for a course
 * is about 0.7 — brutally low. That single fact is why a square-rigger cannot
 * point: at low aspect ratio the induced drag is enormous, the lift/drag ratio
 * is barely 2, and there is no way to get a forward force component at a narrow
 * apparent wind angle. It is also why she is magnificent downwind, where the
 * yards go square, the angle of attack is 90 degrees and the sail works as a
 * pure drag device with a CD near 1.5.
 */

export interface SailGeometry {
  /** Fore-aft station of the mast or stay foot, ship-local z (negative = fwd). */
  z: number;
  /** Centre of effort height above the waterline, m. */
  y: number;
  /** Vertical hoist — the aerodynamic span, m. */
  hoist: number;
  /** Yard length for square sails, foot length for fore-and-aft, m. */
  chord: number;
  /** Aspect ratio, span^2/area. */
  ar: number;
}

/**
 * Positions are consistent with a 53.3 m hull (bow at z = -26.65) and the real
 * mast heights of 60/67/52 m. Headsail stays run out along the bowsprit and
 * jibboom, which carry LOA to 62 m, so the flying jib foot at z = -33 is the
 * furthest forward anything gets.
 */
const GEOMETRY: Record<string, SailGeometry> = {
  // Headsails — tall, narrow, genuinely efficient. These are what let her
  // claw to windward at all, and what balances the spanker's yaw moment.
  'flying-jib': { z: -33, y: 20, hoist: 17, chord: 9.2, ar: 3.71 },
  'outer-jib': { z: -29, y: 18, hoist: 20, chord: 11.8, ar: 3.39 },
  'inner-jib': { z: -25, y: 16, hoist: 20, chord: 12.8, ar: 3.13 },
  'fore-staysail': { z: -20, y: 14, hoist: 18, chord: 12.4, ar: 2.89 },

  // Fore mast, 60 m.
  'fore-course': { z: -11, y: 15.0, hoist: 15.3, chord: 22.0, ar: 0.70 },
  'fore-topsail': { z: -11, y: 30.0, hoist: 16.7, chord: 19.5, ar: 0.86 },
  'fore-topgallant': { z: -11, y: 42.0, hoist: 11.2, chord: 14.5, ar: 0.77 },
  'fore-royal': { z: -11, y: 51.0, hoist: 8.7, chord: 10.5, ar: 0.83 },

  // Main mast, 67 m — the tallest and the most powerful.
  'main-course': { z: 3, y: 16.0, hoist: 17.3, chord: 24.5, ar: 0.71 },
  'main-topsail': { z: 3, y: 32.5, hoist: 18.8, chord: 21.5, ar: 0.87 },
  'main-topgallant': { z: 3, y: 46.0, hoist: 12.8, chord: 16.0, ar: 0.80 },
  'main-royal': { z: 3, y: 56.0, hoist: 9.4, chord: 12.0, ar: 0.78 },

  // Mizzen, 52 m. No course — a mizzen course would spend its life in the
  // main's wake, which is exactly what the blanketing model predicts.
  'mizzen-topsail': { z: 18, y: 27.0, hoist: 14.8, chord: 17.0, ar: 0.87 },
  'mizzen-topgallant': { z: 18, y: 38.0, hoist: 10.0, chord: 13.0, ar: 0.77 },
  'mizzen-royal': { z: 18, y: 46.0, hoist: 7.5, chord: 9.6, ar: 0.78 },
  // Gaff spanker, sheeted to a boom that overhangs the transom.
  spanker: { z: 22, y: 13.0, hoist: 19.0, chord: 13.5, ar: 1.48 },
};

const FALLBACK: SailGeometry = { z: 0, y: 20, hoist: 12, chord: 16, ar: 0.8 };

export function geometryFor(sail: SailState): SailGeometry {
  return GEOMETRY[sail.id] ?? FALLBACK;
}

/* ------------------------------------------------------------------ *
 *  Aerofoil coefficients
 * ------------------------------------------------------------------ */

/**
 * Angle of attack at which a membrane of this aspect ratio stalls. Low aspect
 * ratio surfaces stall late — a course hangs on to about 25 degrees while a
 * high-aspect jib is done by 19.
 */
export function stallAngle(ar: number): number {
  return (15 + 13 / (ar + 0.5)) * DEG;
}

/**
 * Incidence a cambered sail carries at zero geometric angle of attack. A square
 * sail bellies deeply and so carries more than a flat-cut jib.
 */
function camberIncidence(triangular: boolean): number {
  return (triangular ? 5 : 7) * DEG;
}

/**
 * Normal-force coefficient once the flow has fully separated. A flat plate
 * broadside measures ~1.9; a square sail measures nearer 1.45 because it is
 * curved and leaks air round the leeches, and a jib less still.
 */
function separatedCN(triangular: boolean): number {
  return triangular ? 1.35 : 1.45;
}

/** Parasitic drag of cloth, bolt ropes and the spar behind it. */
const CD_PROFILE = 0.08;
/** Oswald span efficiency of a sail — poor, it is a single cambered membrane. */
const OSWALD = 0.85;
/** Width of the stall blend, radians. */
const STALL_BLEND = 14 * DEG;

export interface Coefficients {
  cl: number;
  cd: number;
}

/**
 * Lift and drag for a thin lifting surface at absolute angle of attack `alpha`
 * (radians, 0..PI/2 measured from the chord).
 *
 * Attached flow uses a lifting-line lift slope 2*PI*AR/(AR+2) with induced drag
 * CL^2/(PI*AR*e); separated flow uses a flat-plate normal force resolved into
 * lift and drag. The two are blended across the stall so the curve is smooth
 * and behaves correctly all the way to 90 degrees, where CL goes to zero and CD
 * to the separated normal force. Writes into `out` — no allocation.
 *
 * `camber` is the incidence the section carries at zero geometric angle,
 * `cnSep` its fully separated normal force, `cd0` its parasitic drag. A sail
 * and a rudder are the same equation with different numbers in those three.
 */
export function foilCoefficients(
  alpha: number,
  ar: number,
  camber: number,
  cnSep: number,
  cd0: number,
  out: Coefficients,
): Coefficients {
  const a = Math.abs(alpha);
  const slope = (2 * Math.PI * ar) / (ar + 2);
  const clAtt = slope * (a + camber);
  const cdInduced = (clAtt * clAtt) / (Math.PI * ar * OSWALD);

  const cn = cnSep * Math.sin(a);
  const clSep = cn * Math.cos(a);
  const cdSep = cn * Math.sin(a);

  const stall = stallAngle(ar);
  const sigma = smoothstep(stall, stall + STALL_BLEND, a);

  out.cl = (1 - sigma) * clAtt + sigma * clSep;
  // Keep a floor of the separated drag below the stall too, otherwise CD dips
  // unphysically at moderate incidence.
  out.cd = cd0 + (1 - sigma) * Math.max(cdInduced, cdSep * 0.35) + sigma * cdSep;
  return out;
}

export function sailCoefficients(
  alpha: number,
  ar: number,
  triangular: boolean,
  out: Coefficients,
): Coefficients {
  return foilCoefficients(
    alpha,
    ar,
    camberIncidence(triangular),
    separatedCN(triangular),
    CD_PROFILE,
    out,
  );
}

/* ------------------------------------------------------------------ *
 *  Luffing
 * ------------------------------------------------------------------ */

/** Below this incidence the sail is edge-on and cannot hold its shape. */
const LUFF_FULL = 4 * DEG;
const LUFF_CLEAR = 11 * DEG;
/** Hysteresis so a sail on the edge of drawing does not chatter frame to frame. */
const LUFF_HYST = 2.2 * DEG;

/**
 * Target luff for an angle of attack, with hysteresis: a sail already shivering
 * needs a little more incidence to fill than a drawing sail needs to collapse.
 * This value drives the cloth shader and the flapping sound, so it has to move
 * smoothly and for a physical reason.
 */
export function luffTarget(alpha: number, currentLuff: number): number {
  const shift = (currentLuff > 0.5 ? 1 : -1) * LUFF_HYST;
  return 1 - clamp01(smoothstep(LUFF_FULL + shift, LUFF_CLEAR + shift, Math.abs(alpha)));
}

/** A sail fills with a bang and collapses nearly as fast. Per-second rates. */
export const LUFF_FILL_RATE = 3.6;
export const LUFF_COLLAPSE_RATE = 5.2;

/* ------------------------------------------------------------------ *
 *  Optimum brace
 * ------------------------------------------------------------------ */

/** Angle of attack the crew trims for — just short of the stall peak. */
export function targetIncidence(ar: number): number {
  return stallAngle(ar) - 3 * DEG;
}

/**
 * Brace angle that puts a square sail at `target` incidence to an apparent wind
 * travelling in direction (wx, wz) in the ship frame.
 *
 * The ship module rotates a yard about +Y by `brace`, so the sail normal is
 * R_y(b) applied to (0,0,1) = (sin b, 0, cos b) — square yards face aft. Then
 * sin(alpha) = w.n = wx*sin b + wz*cos b = cos(b - psi) with psi = atan2(wx, wz),
 * hence b = psi +/- (PI/2 - target). Both roots are legal braces on opposite
 * tacks; the caller picks whichever drives the ship forward.
 */
export function braceSolutions(wx: number, wz: number, target: number, out: THREE.Vector2): THREE.Vector2 {
  const psi = Math.atan2(wx, wz);
  const k = Math.PI / 2 - target;
  out.set(psi + k, psi - k);
  return out;
}
