import * as THREE from 'three';
import { clamp01, smoothstep, toKnots } from '../util/math';
import { addTorque, type Wrench } from './Wrench';
import {
  CW_BASE,
  CY_LIFT,
  DRIFT_RESISTANCE_GAIN,
  FN_WALL,
  YAW_DAMP_LIN,
} from './constants';

/**
 * Assist mode — the arcade handling layer, ON by default.
 *
 * This is NOT a second physics model. The 6-DOF solver, the panel pressure
 * integral, the 16-sail aerodynamics, the roll period, the wave-following and
 * the wake are all exactly what they are in Pro mode. Assist does three things
 * and nothing else:
 *
 *   1. adds two forces — a forward drive at the centre of gravity and a yaw
 *      moment at the helm — which are summed into the same wrench as every
 *      other force, on the same substep, and integrated by the same integrator;
 *   2. relaxes five hull coefficients (`ASSIST_HYDRO` below): the wave-making
 *      pole, the drift penalty, the lateral-force slope and the linear yaw
 *      damping. Same equations, different numbers;
 *   3. lets the watch work the ship faster — yards, sheets and canvas — so the
 *      throttle answers in seconds rather than half a minute.
 *
 * Nothing here touches mass, inertia, added mass, buoyancy, GM, roll or pitch
 * damping, or the sail force model. Heel, pitch, wave-following, the roll
 * period and the sense of 2200 tonnes are the same ship. What changes is what
 * she will do when you ask her.
 *
 * WHY A DRIVE FORCE AND NOT MORE SAIL AREA. The obvious "arcade" hack is to
 * multiply the rig force, but the rig's force acts 25 m above the centre of
 * lateral resistance, so multiplying it multiplies heel with it and she lies
 * on her ear at 30 deg. The drive force is applied at the CG, where by
 * definition it produces no torque, so acceleration is decoupled from heel and
 * heel stays exactly as measured. The same argument applies to the turn: a pure
 * yaw moment turns her without kicking the stern out, and the hull's own
 * lateral force still has to swing the velocity vector round, so the turn is
 * still a coordinated turn with real drift in it.
 */

/* ------------------------------------------------------------------ *
 *  Drive
 * ------------------------------------------------------------------ */

/**
 * Assist thrust at a standstill, newtons, tapering to zero at the ceiling
 * below. For scale, the whole rig makes about 300 kN on a beam reach in 10 m/s
 * of wind and the hull needs ~50 kN to hold 9.5 kn, so this is several times
 * the natural drive — which is the point. Against 2.35e6 kg of ship-plus-added-
 * mass it is 0.89 m/s^2 from rest.
 *
 *   dv/dt = (F0/m)(1 - (v/vmax)^2)   =>   v(t) = vmax * tanh(t / tau)
 *
 * with tau = m*vmax/F0 ~ 10 s, so she is at half speed in 7 s and ninety per
 * cent in 15 — while still visibly taking a quarter of a minute to wind up,
 * which is the part of 2200 tonnes worth keeping.
 */
export const ASSIST_THRUST = 2.1e6; // N

/**
 * Reference speed the assist drive tapers to on a beam reach in a 10 m/s
 * breeze, m/s. Multiplied by the angle and wind gains below to give the actual
 * ceiling; the real rig then adds its own force on top, so she settles a little
 * either side of it depending on the point of sail.
 *
 * This is DELIBERATELY above the physical hull-speed wall of 13.5 kn — about
 * 16.6 kn on a reach. A 2200 t displacement hull cannot exceed her wave-making
 * limit, and Pro mode respects that absolutely; assist buys the sense of speed
 * by moving the wall (see `ASSIST_HYDRO.fnWall`) rather than by pretending it
 * is not there.
 */
export const ASSIST_TOP_SPEED = 9.3; // m/s

/**
 * How the assist ceiling varies with true wind angle:
 *
 *   gain = A - B*cos(TWA) - C*cos^2(TWA)
 *
 * 0.42 head to wind, 0.92 on a beam reach, a maximum of 0.96 at TWA 113 and
 * 0.86 dead before it. That is a real polar shape — a broad reach is her best
 * point of sail in assist exactly as it is in Pro, and beating is much slower
 * than reaching — but the head-to-wind figure is deliberately NOT zero. That is
 * the no-go zone gone: steer straight at the wind in assist and she still makes
 * way at around 7 kn instead of stopping dead and refusing the helm.
 */
export const ASSIST_ANGLE_A = 0.92;
export const ASSIST_ANGLE_B = 0.22;
export const ASSIST_ANGLE_C = 0.28;

/**
 * Assist ceiling scaling with true wind: floor, reference, ceiling. The floor
 * is what she can still do in a flat calm — about 5 kn, ghosting. Slow enough
 * that you want the wind back, fast enough that a calm is never a dead end.
 */
export const ASSIST_WIND_FLOOR = 0.3;
export const ASSIST_WIND_REF = 10; // m/s
export const ASSIST_WIND_CEIL = 1.15;

/**
 * True wind speed over which the angle term fades in. Below this there is no
 * meaningful wind direction, so the ceiling falls back to its beam-reach shape
 * and she keeps sailing in whatever direction she is pointed.
 */
export const ASSIST_CALM_LO = 0.5; // m/s
export const ASSIST_CALM_HI = 3.5; // m/s

/* ------------------------------------------------------------------ *
 *  Helm
 * ------------------------------------------------------------------ */

/**
 * Peak assist yaw moment at hard over, N*m. The rudder alone makes about
 * 5e6 N*m at 7 m/s, and nothing at all at rest, because its force goes as the
 * square of the water speed. This roughly triples the authority at speed and,
 * through ASSIST_TURN_FLOOR, leaves a third of it available when she is barely
 * moving — which is what stops the player from ever being unable to turn.
 *
 * Tuned by eye as much as by number: 1.5e7 turned her inside her own length,
 * which reads as a skid rather than a turn however good it is for the lap time.
 * At this value she carves about 1.3 lengths of radius at cruising speed.
 */
export const ASSIST_TURN = 1.15e7; // N*m
/** Fraction of the assist yaw moment available at a standstill. */
export const ASSIST_TURN_FLOOR = 0.38;
/** Water speed at which the assist yaw moment reaches full value, m/s. */
export const ASSIST_TURN_REF = 4;

/** Seconds for the wheel to go from amidships to hard over. 4.5 s in Pro. */
export const ASSIST_RUDDER_SLEW_TIME = 1.5;
/** Course-hold gains. Softer P and harder D than Pro: the ship answers faster. */
export const ASSIST_HELM_KP = 3;
export const ASSIST_HELM_KD = 15;

/* ------------------------------------------------------------------ *
 *  Sail handling
 * ------------------------------------------------------------------ */

/** How much faster the watch works the yards, sheets and canvas in assist. */
export const ASSIST_HAND_RATE = 3;
/** Seconds for a manual brace bias to be trimmed out again. 25 s in Pro. */
export const ASSIST_BIAS_DECAY_TIME = 8;

/* ------------------------------------------------------------------ *
 *  Relaxed hull coefficients
 * ------------------------------------------------------------------ */

/**
 * The five hull numbers assist mode relaxes. Same equations in `Hydro`, read
 * through this struct instead of straight off the constants, so Pro mode is
 * bit-for-bit what it always was: `PRO_HYDRO` IS the constants.
 */
export interface HydroTuning {
  /** Froude number of the wave-making pole — the hull-speed wall. */
  fnWall: number;
  /** Wave-making coefficient scale. */
  cwBase: number;
  /** Added resistance per sin^2 of drift angle. This is what punishes pinching. */
  driftResistanceGain: number;
  /** Circulatory lateral-force slope of the hull. Higher = less leeway. */
  cyLift: number;
  /** Linear yaw damping per m/s of speed. This is what fights the rudder. */
  yawDampLin: number;
}

export const PRO_HYDRO: HydroTuning = {
  fnWall: FN_WALL,
  cwBase: CW_BASE,
  driftResistanceGain: DRIFT_RESISTANCE_GAIN,
  cyLift: CY_LIFT,
  yawDampLin: YAW_DAMP_LIN,
};

/**
 * Assist hull coefficients.
 *
 *   fnWall 0.305 -> 0.42     moves the wave-making asymptote from 13.5 kn to
 *                            18.6 kn. Without this the resistance pole makes
 *                            any assist thrust irrelevant past 13 kn: at 8 m/s
 *                            the Pro curve asks for 20 MN.
 *   cwBase 0.9 -> 0.5        flattens the approach to that wall so the last
 *                            three knots are gettable rather than asymptotic.
 *   drift gain 11 -> 3.2     a crabbing hull no longer drags a hole through
 *                            the water. This is the single term that creates
 *                            the pinching death-spiral, so relaxing it is most
 *                            of why she can sail upwind at all in assist.
 *   cyLift 0.52 -> 1.15      the hull grips sideways like a keelboat rather
 *                            than a barn door, so leeway roughly halves and she
 *                            goes where she is pointed.
 *   yawDamp x0.70            the turn is not fought so hard once it starts.
 *
 * Untouched: mass, added mass, inertia, GM, roll and pitch damping, heave
 * damping, panel drag, the friction line and the whole sail force model.
 */
export const ASSIST_HYDRO: HydroTuning = {
  fnWall: 0.42,
  cwBase: 0.5,
  driftResistanceGain: 3.2,
  cyLift: 1.15,
  yawDampLin: YAW_DAMP_LIN * 0.7,
};

/* ------------------------------------------------------------------ *
 *  The layer itself
 * ------------------------------------------------------------------ */

/**
 * Stateless apart from its diagnostics. One instance lives on ShipDynamics and
 * `apply` is called once per substep, after the hull and rig forces are in the
 * wrench and before the integrator runs. Allocation-free.
 */
export class Assist {
  /** Forward force applied last substep, N. Published for the HUD/debug. */
  drive = 0;
  /** Yaw moment applied last substep, N*m. */
  turn = 0;

  /**
   * @param out        the substep's force accumulator
   * @param throttle   canvas the player has ordered, 0..1
   * @param helm       rudder angle as a fraction of hard over, -1..1
   * @param twa        true wind angle, radians, 0 = head to wind
   * @param windSpeed  true wind at the 10 m reference height, m/s
   * @param axial      forward speed through the water, m/s
   * @param waterSpeed horizontal speed through the water, m/s
   */
  apply(
    out: Wrench,
    throttle: number,
    helm: number,
    twa: number,
    windSpeed: number,
    axial: number,
    waterSpeed: number,
  ): void {
    // Point of sail. Faded out in a flat calm, where there is no wind direction
    // to speak of and the honest answer would be "you are stuck".
    const c = Math.cos(twa);
    const shaped = ASSIST_ANGLE_A - ASSIST_ANGLE_B * c - ASSIST_ANGLE_C * c * c;
    const breeze = smoothstep(ASSIST_CALM_LO, ASSIST_CALM_HI, windSpeed);
    const angleGain = shaped + (1 - breeze) * (ASSIST_ANGLE_A - shaped);

    const windGain = THREE.MathUtils.clamp(
      ASSIST_WIND_FLOOR + (1 - ASSIST_WIND_FLOOR) * (windSpeed / ASSIST_WIND_REF),
      ASSIST_WIND_FLOOR,
      ASSIST_WIND_CEIL,
    );

    // Quadratic taper to the ceiling for this point of sail and this breeze —
    // a propeller curve, not a speed clamp: it can only ever push forward, so
    // the rig is free to carry her past the ceiling on her best point of sail
    // and she coasts down on her own resistance rather than being braked.
    const ceiling = Math.max(ASSIST_TOP_SPEED * angleGain * windGain, 0.5);
    const s = axial / ceiling;
    const taper = s <= 0 ? 1 : s >= 1 ? 0 : 1 - s * s;

    const f = ASSIST_THRUST * clamp01(throttle) * taper;
    this.drive = f;
    // Forward is -Z. At the centre of gravity, so it adds no heel and no pitch:
    // acceleration is decoupled from the ship's attitude by construction.
    out.fz -= f;

    // The helm. Positive rudder is a turn to starboard, and heading rate is
    // -wby, so a starboard turn wants a negative yaw moment.
    const speedGain =
      ASSIST_TURN_FLOOR + (1 - ASSIST_TURN_FLOOR) * clamp01(waterSpeed / ASSIST_TURN_REF);
    const t = -ASSIST_TURN * THREE.MathUtils.clamp(helm, -1, 1) * speedGain;
    this.turn = t;
    addTorque(out, 0, t, 0);
  }
}

/** The assist ceiling in knots, for the HUD and the tests. */
export const ASSIST_TOP_SPEED_KNOTS = toKnots(ASSIST_TOP_SPEED);
