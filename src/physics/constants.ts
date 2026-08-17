/**
 * Physical constants for the ship dynamics solver.
 *
 * Hull figures are the real USS Constitution (see AGENTS.md). Everything else
 * is either a textbook coefficient or a value tuned to reproduce a documented
 * behaviour of the real ship; the tuned ones say so and say what they match.
 *
 * Ship local frame: +X starboard, +Y up, -Z forward (bow). The hull origin is
 * at the waterline amidships, so all submerged geometry has y < 0.
 */

export const RHO_WATER = 1025; // kg/m^3, seawater
export const RHO_AIR = 1.225; // kg/m^3, 15 C at sea level
export const GRAVITY = 9.81; // m/s^2
export const NU_WATER = 1.19e-6; // m^2/s, kinematic viscosity of seawater at 15 C

/* ------------------------------------------------------------------ *
 *  Hull
 * ------------------------------------------------------------------ */

export const LWL = 53.3; // m, gun-deck length ~= waterline length
export const BEAM = 13.3; // m
export const DRAUGHT = 6.4; // m
export const MASS = 2200e3; // kg, 2200 tonnes displacement
export const DISPLACED_VOLUME = MASS / RHO_WATER; // 2146.3 m^3

/** Block coefficient implied by the figures above: a fast, fine-ended frigate. */
export const BLOCK_COEFF = DISPLACED_VOLUME / (LWL * BEAM * DRAUGHT); // 0.473

/**
 * Wetted surface, Denny-Mumford: S ~= 1.7*L*T + V/T.
 * 1.7*53.3*6.4 + 2146/6.4 = 580 + 335 = 915 m^2.
 */
export const WETTED_AREA = 1.7 * LWL * DRAUGHT + DISPLACED_VOLUME / DRAUGHT;

/** Underwater lateral (profile) area, ~0.9 of the L x T rectangle. */
export const LATERAL_AREA = 0.9 * LWL * DRAUGHT; // 307 m^2

/**
 * Centre of gravity, ship-local. Just below the waterline: a frigate carries
 * ~250 t of iron and shingle ballast on the keel to hold KG down against 67 m
 * of top-hamper. KG = DRAUGHT + CG_Y = 5.66 m.
 *
 * This is the single knob that sets the metacentric height, and through it the
 * natural roll period. With the parametric hull in Hull.ts it measures
 * KB 4.22 + BM 2.39 - KG 5.66 = GM 0.950 m, giving a free-decay roll period of
 * 11.6 s. See the measured table in Hull.ts.
 */
export const CG_Y = -0.74; // m, below the waterline
export const CG_Z = 0.4; // m, marginally aft of amidships

/**
 * Radii of gyration. Roll inertia is far smaller than pitch/yaw because the
 * mass is concentrated near the centreline; the ratio here is ~1:7, which is
 * why she rolls in ~11 s but pitches slowly and turns like a barn door.
 */
export const K_ROLL = 0.38 * BEAM; // 5.05 m
export const K_PITCH = 0.25 * LWL; // 13.33 m
export const K_YAW = 0.26 * LWL; // 13.86 m

/**
 * Added mass (fraction of displacement) and added inertia (fraction of the dry
 * inertia). A hull accelerating sideways or vertically has to shove a volume of
 * water comparable to its own displacement out of the way; surge is small
 * because the hull is slender fore-and-aft. Omitting these is what makes naive
 * boat sims feel like bathtub toys.
 */
export const ADDED_MASS_SURGE = 0.07;
export const ADDED_MASS_SWAY = 1.0;
export const ADDED_MASS_HEAVE = 0.95;
export const ADDED_INERTIA_ROLL = 0.25;
export const ADDED_INERTIA_PITCH = 0.85;
export const ADDED_INERTIA_YAW = 0.6;

/* ------------------------------------------------------------------ *
 *  Resistance
 * ------------------------------------------------------------------ */

/** Form factor (1+k) on the ITTC-57 friction line, for a hull of this fullness. */
export const FORM_FACTOR = 1.25;

/**
 * Wave-making resistance. The textbook hull-speed formula 1.34*sqrt(LWL_ft)
 * gives 17.7 kn for a 53.3 m waterline, but the Constitution's documented top
 * speed is 13 kn: she is power-limited, not purely wave-limited, and a Cb 0.47
 * displacement hull has a hard resistance hump well before Fn 0.4.
 *
 * FN_HUMP is where the hump starts to bite and FN_WALL is the asymptote. At
 * Fn = V/sqrt(g*LWL), 12.5 kn = 6.43 m/s = Fn 0.281 and 13.5 kn = Fn 0.304.
 */
export const FN_HUMP = 0.20;
export const FN_WALL = 0.305; // 13.5 kn — unreachable in practice
export const CW_BASE = 0.9; // scales the Fn^4 low-speed wave-making term
export const CW_HUMP = 34; // scales the steep near-hump rise

/**
 * Lateral force coefficients for the hull treated as a very low aspect-ratio
 * foil (T^2/A_lat = 0.13). CY_LIFT is the circulatory part, CY_CROSS the
 * cross-flow drag that dominates at large drift angles. Together they mean the
 * ship must slip several degrees to generate any side force at all, which is
 * where leeway comes from.
 */
export const CY_LIFT = 1.9;
export const CY_CROSS = 1.25;

/** Centre of lateral resistance, ship-local. Forward of amidships and deep. */
export const CLR_Y = -0.45 * DRAUGHT; // -2.88 m
export const CLR_Z = -1.8; // m, slightly forward of amidships

/**
 * Roll damping: linear (wave radiation) + quadratic (eddy shedding off the
 * bilges). The Constitution has no bilge keels, so she is lightly damped and
 * keeps rolling — deliberately, it makes her feel alive.
 */
export const ROLL_DAMP_LIN = 3.2e7; // N*m per rad/s
export const ROLL_DAMP_QUAD = 9.0e7; // N*m per (rad/s)^2
export const PITCH_DAMP_LIN = 5.5e8;
export const PITCH_DAMP_QUAD = 6.0e8;
export const HEAVE_DAMP = 7.0e5; // N per m/s

/**
 * Yaw damping, per m/s of forward speed. This is what fights the rudder and
 * sets the turning circle: at 6 m/s and 20 deg of rudder it settles near
 * 3 deg/s, a turning radius of ~110 m, i.e. two ship lengths of radius and
 * four of tactical diameter.
 */
export const YAW_DAMP_LIN = 1.55e7; // N*m*s/rad per m/s
export const YAW_DAMP_QUAD = 2.4e8; // N*m per (rad/s)^2

/* ------------------------------------------------------------------ *
 *  Rudder
 * ------------------------------------------------------------------ */

export const RUDDER_AREA = 12.5; // m^2
export const RUDDER_ASPECT = 1.6;
export const RUDDER_Z = 25.0; // m aft of the hull origin
export const RUDDER_Y = -3.4; // m below the waterline
export const RUDDER_MAX = 35 * (Math.PI / 180); // hard over
export const RUDDER_STALL = 22 * (Math.PI / 180); // stalls before hard over
/** Seconds for the wheel to go from amidships to hard over. Six turns of it. */
export const RUDDER_SLEW_TIME = 4.5;

/* ------------------------------------------------------------------ *
 *  Rig
 * ------------------------------------------------------------------ */

/** Yards cannot brace past the shrouds. */
export const BRACE_MAX = 60 * (Math.PI / 180);
/** Seconds to brace from square to hard against the shrouds. */
export const BRACE_SLEW_TIME = 12;
/** Seconds for the topmen to set or furl one sail. */
export const SAIL_SLEW_TIME = 9;
/** Max sheeting angle of a fore-and-aft sail off the centreline. */
export const SHEET_MAX = 78 * (Math.PI / 180);
export const SHEET_SLEW_TIME = 6;

/**
 * Wind boundary layer over open water, power law V(h) = V10 * (h/10)^ALPHA.
 * ALPHA 0.125 is the standard open-sea value: only ~16% more wind at royal
 * height than at deck level. That sounds small until you square it for dynamic
 * pressure and multiply by a 50 m lever arm — which is exactly why the upper
 * sails drive the ship and also why they are the first thing you take in.
 */
export const WIND_SHEAR_ALPHA = 0.125;
export const WIND_REF_HEIGHT = 10; // m

/** Above-water windage of hull, masts, yards and furled canvas. */
export const WINDAGE_LATERAL = 430; // m^2
export const WINDAGE_FRONTAL = 95; // m^2
export const WINDAGE_CD = 0.85;
export const WINDAGE_Y = 6.5; // m, centroid above the waterline

/* ------------------------------------------------------------------ *
 *  Solver
 * ------------------------------------------------------------------ */

/** Fixed inner step. Behaviour is identical at 30 and 240 fps. */
export const SUB_STEP = 1 / 120;
/** Give up rather than death-spiral; world dt is already clamped to 0.1 s. */
export const MAX_SUB_STEPS = 12;

/** Shift the world back when the ship gets this far from the origin. */
export const ORIGIN_SHIFT_RADIUS = 4000; // m
