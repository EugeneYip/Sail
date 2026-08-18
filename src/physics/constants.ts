/**
 * Physical constants for the ship dynamics solver.
 *
 * Hull figures are the real USS Constitution (see AGENTS.md). Everything else
 * is either a textbook coefficient or a value tuned to reproduce a documented
 * behaviour of the real ship; the tuned ones say so and say what they match.
 *
 * Ship local frame: +X starboard, +Y up, -Z forward (bow). The hull origin is
 * at the waterline amidships, so submerged geometry has y < 0 and the topsides
 * y > 0.
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
 * Freeboard to the top of the bulwark amidships. The panel set is carried this
 * far above the waterline and capped with a deck, which is what stops the ship
 * submarining in a 6.5 m sea and what gives a sane righting arm past 25 deg of
 * heel. Without reserve buoyancy above the waterline a pressure-integral hull
 * capsizes at absurdly small angles.
 */
export const FREEBOARD = 6.6; // m

/** Half-beam lost between the waterline and the rail. Frigates tumble home hard. */
export const TUMBLEHOME = 0.12;
/** How much the ends fill out above the waterline — reserve buoyancy forward. */
export const TOPSIDE_FLARE = 0.35;

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
 * natural roll period. See the measured table in Hull.ts.
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
 *  Wave pressure
 * ------------------------------------------------------------------ */

/**
 * Depth over which wave-induced pressure decays (the Smith effect: the dynamic
 * pressure under a wave falls off as exp(-2*pi*d/lambda)). 16 m corresponds to
 * a ~100 m wave, which is what a fresh gale builds. Only the horizontal
 * (Froude-Krylov) part of the buoyancy is attenuated — the vertical part is
 * ordinary hydrostatics and must stay exact or she floats at the wrong depth.
 */
export const PRESSURE_DECAY = 16; // m
/** Residual Froude-Krylov gain after the Smith attenuation over the draught. */
export const FK_GAIN = Math.exp(-(0.45 * DRAUGHT) / PRESSURE_DECAY); // 0.83

/* ------------------------------------------------------------------ *
 *  Resistance
 * ------------------------------------------------------------------ */

/** Form factor (1+k) on the ITTC-57 friction line, for a hull of this fullness. */
export const FORM_FACTOR = 1.25;

/**
 * Wave-making resistance:
 *
 *   Cw = CW_BASE * Fn^4 / (1 - (Fn/FN_WALL)^CW_WALL_POWER)
 *
 * The Fn^4 numerator is the classical low-speed wave-making law; the
 * denominator is the hull-speed wall. The textbook 1.34*sqrt(LWL_ft) formula
 * gives 17.7 kn for a 53.3 m waterline, but the Constitution's documented top
 * speed is 13 kn — she is a Cb 0.47 displacement hull that hits a hard
 * resistance rise well before Fn 0.4, and she is sail-power limited on top of
 * that. FN_WALL 0.305 = 13.5 kn is the asymptote.
 *
 * The curve this produces (adding ITTC friction on 915 m^2 of wetted surface):
 *   8 kn   Fn 0.180    41 kN     easy
 *  10 kn   Fn 0.225    59 kN     still cheap
 *  12 kn   Fn 0.270   176 kN     leaning on it
 *  13 kn   Fn 0.293   551 kN     the wall
 *  13.5 kn Fn 0.305     inf      unreachable
 */
export const FN_WALL = 0.305;
export const CW_BASE = 0.9;
export const CW_WALL_POWER = 8;

/**
 * Lateral force coefficients for the hull treated as a very low aspect-ratio
 * foil (T^2/A_lat = 0.13). CY_LIFT is the circulatory part, CY_CROSS the
 * cross-flow drag that dominates at large drift angles. Together they mean the
 * ship must slip several degrees to generate any side force at all, which is
 * where leeway comes from.
 *
 * Lifting-line at that aspect ratio gives a slope of 2*pi*AR/(AR+2) = 0.38 per
 * radian; 0.52 allows for the keel, deadwood and the rudder acting as an end
 * plate. Anything near unity makes the hull an unrealistically good foil —
 * leeway collapses below a degree and she points like a Bermudan sloop.
 */
export const CY_LIFT = 0.52;
export const CY_CROSS = 1.1;

/**
 * Added resistance from drift, as a multiplier on sin^2(beta). A hull crabbing
 * at 8 deg drags a far bigger hole through the water than one going straight,
 * and that penalty is the mechanism that punishes pinching: pinch and leeway
 * grows, leeway costs speed, less speed means less lateral resistance and so
 * more leeway still. The no-go zone is this feedback loop, not a clamp.
 */
export const DRIFT_RESISTANCE_GAIN = 11.0;

/** Centre of lateral resistance, ship-local. Forward of amidships and deep. */
export const CLR_Y = -0.45 * DRAUGHT; // -2.88 m
export const CLR_Z = -1.8; // m, slightly forward of amidships
/**
 * The centre of lateral pressure walks forward as the drift angle grows — the
 * circulation is generated at the leading edge. Metres of travel per radian of
 * drift; at 6 deg of leeway the CLR is 1.5 m further forward, which is a large
 * part of where weather helm comes from.
 *
 * Capped, because a centre of pressure cannot leave the hull. Uncapped, a ship
 * sagging sideways at 25 deg before she gathers way puts her CLR 11 m ahead of
 * amidships, which slews her head to wind and leaves her stuck there.
 */
export const CLR_DRIFT_SHIFT = 14;
export const CLR_DRIFT_SHIFT_MAX = 5.5; // m

/**
 * Yaw moment produced by a heeled hull, per radian of heel per (m/s)^2 of
 * speed. A heeled hull is asymmetric: the immersed lee bow and the emerged
 * weather quarter make her carve to windward. This is a real manoeuvring
 * derivative (N_phi), not a scripted assist, and it is the second half of
 * weather helm — the first half is the sail plan's centre of effort moving aft
 * of the CLR, which falls out of the per-sail force sum on its own.
 */
export const YAW_FROM_HEEL = 2.8e4; // N*m per rad per (m/s)^2

/**
 * Roll damping: linear (wave radiation) + quadratic (eddy shedding off the
 * bilges). The Constitution has no bilge keels, so she is lightly damped and
 * keeps rolling — deliberately, it makes her feel alive. These are on top of
 * the per-panel normal drag, which supplies roughly half the total.
 */
export const ROLL_DAMP_LIN = 6.5e6; // N*m per rad/s
export const ROLL_DAMP_QUAD = 2.0e7; // N*m per (rad/s)^2
export const PITCH_DAMP_LIN = 2.4e8;
export const PITCH_DAMP_QUAD = 3.0e8;
export const HEAVE_DAMP = 2.0e5; // N per m/s

/** Normal-direction drag coefficient on a wetted hull panel. */
export const CD_PANEL_NORMAL = 0.45;

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
/** Separated normal force of the blade. Higher than a sail: it is a flat plate. */
export const RUDDER_CN_SEP = 1.85;
/** Parasitic drag of the blade and its stock. */
export const RUDDER_CD0 = 0.012;
/**
 * Inflow speed at the blade as a fraction of the ship's speed. The rudder sits
 * in the hull's boundary layer and in the dead water behind the deadwood, so it
 * never sees the full free-stream. Force goes as the square of this, so 0.86
 * costs a quarter of the theoretical rudder force — which is why she needs
 * several ship lengths to turn.
 */
export const RUDDER_WAKE = 0.86;

/**
 * The quartermaster. `input.steer` moves the wheel directly, but a square-rigger
 * carries a real weather helm — the centre of effort is metres abaft the centre
 * of lateral resistance and a heeled hull carves to windward — so with nobody at
 * the wheel she rounds up into the wind and stops inside a minute. There is
 * always a man on the wheel, and when the player is not commanding rudder he
 * holds the ordered course with a proportional-derivative hand: KP full rudder
 * per 14 deg of error, KD to stop him chasing the yaw.
 *
 * This is a control input, not a force. Nothing in the force model is scripted
 * by it, and holding a course she cannot sail still leaves her in irons.
 */
export const HELM_KP = 4.1; // rudder command per radian of heading error
export const HELM_KD = 11.0; // rudder command per rad/s of yaw rate

/* ------------------------------------------------------------------ *
 *  Rig
 * ------------------------------------------------------------------ */

/** Yards cannot brace past the shrouds. */
export const BRACE_MAX = 60 * (Math.PI / 180);
/** Seconds to brace from square to hard against the shrouds. */
export const BRACE_SLEW_TIME = 12;
/** Seconds for the topmen to set or furl one sail. */
export const SAIL_SLEW_TIME = 9;
/** Seconds to go from bare poles to a full press of sail, all hands. */
export const SAIL_LEVEL_TIME = 18;
/** Max sheeting angle of a fore-and-aft sail off the centreline. */
export const SHEET_MAX = 78 * (Math.PI / 180);
/** Seconds to sheet a fore-and-aft sail from centreline to hard out. */
export const SHEET_SLEW_TIME = 6;
/**
 * The ship module swings a boom or gaff to `sail.brace * 2.35`, so a
 * fore-and-aft sail stores its sheet angle divided by this. Physics multiplies
 * it back out; the two must agree or the cloth points the wrong way.
 */
export const SHEET_GAIN = 2.35;

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

/**
 * Heel at which the crew start letting fly, and the angle at which they do it
 * as fast as the halyards will run. A ship is not sailed to her capsize angle;
 * shortening sail when she is over-pressed is what the watch is for, and it is
 * why the gale scene stays on her feet instead of being knocked flat.
 */
export const REEF_HEEL = 26 * (Math.PI / 180);
export const REEF_PANIC_HEEL = 40 * (Math.PI / 180);

/* ------------------------------------------------------------------ *
 *  Solver
 * ------------------------------------------------------------------ */

/** Fixed inner step. Behaviour is identical at 30 and 240 fps. */
export const SUB_STEP = 1 / 120;
/** Give up rather than death-spiral; world dt is already clamped to 0.1 s. */
export const MAX_SUB_STEPS = 12;

/** Shift the world back when the ship gets this far from the origin. */
export const ORIGIN_SHIFT_RADIUS = 4000; // m
