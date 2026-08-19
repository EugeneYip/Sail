import * as THREE from 'three';
import {
  anchorRelative,
  orbitAxisTilt,
  orbitElevation,
  type CameraContext,
  type CameraMode,
  type CameraSolve,
} from '../CameraMode';
import { damp, smoothstep, springDamp, wrapPi } from '../../util/math';

/**
 * The default view: behind and above, looking slightly down.
 *
 * Composition rules
 * -----------------
 * - Eye height and look height are both fractions of the follow distance, so
 *   the framing is scale-invariant: zoom in or out and the horizon stays on the
 *   upper-third line and the hull stays on the lower third. At the default 76 m
 *   the eye sits 27.8 m up and aims at 13.2 m on the rig, a 10.9 deg downward
 *   axis, which puts the horizon at 67% of frame height with a 58 deg lens.
 * - The lens looks PARALLEL to the ship's course rather than at the hull. The
 *   lateral eye offset then places the ship off-centre for free and the frame
 *   automatically contains the water the ship is sailing into. That is leading
 *   room, and it costs one multiply.
 * - That offset is specified WHERE IT IS OBSERVED: as the hull's position in
 *   normalised device x, not as a fraction of the follow distance. Those two are
 *   only the same at one field of view, and this mode changes FOV with speed, so
 *   the old distance-fraction form pushed the hull further off-centre exactly
 *   when the lens got wider. At full heel and full rudder together it put the
 *   bow past the right frame edge — a hard fail on the rubric's composition
 *   axis. In NDC the bound is a single clamp and it is exact.
 * - The lateral offset is signed by heel, so the camera sits on the lee quarter:
 *   the deck tilts toward the lens and reads as a surface instead of an edge.
 * - The look target leads further ahead as speed rises, dropping the hull in
 *   frame and opening up the sea ahead.
 * - Royals and topgallants are deliberately cropped off the top. Fitting all
 *   67 m of rig at this distance costs 5 deg of axis tilt and puts the horizon at
 *   46% of frame height, which is the postcard; cropping makes the ship look big.
 *   `orbit` is where the whole profile fits.
 *
 *   The crop has to be DECISIVE, though, and it was not: measured on the `noon`
 *   capture the mainmast truck terminated eight pixels from the top of a 900-line
 *   frame. Eight pixels is not a crop, it is a coincidence, and it fails
 *   `RUBRIC.md`'s composition axis exactly as grazing the side edge did. See
 *   `LOOK_HEIGHT_PER_M`.
 *
 * The camera pulls back at speed with FOV, not distance, because distance is
 * what every composition rule above is written in terms of — moving it slides
 * the horizon and re-frames the shot, whereas 6 deg of extra FOV adds peripheral
 * motion (the real speed cue) while leaving the framing anchored.
 *
 * Free look
 * ---------
 * A full 360 deg orbit of the ship, because the first thing a player does with a
 * sailing game is look at the bow, and the 60 deg yaw clamp this mode used to
 * carry made that impossible for no reason anyone could name. The eye AND the
 * look target both rotate about the anchor, so the ship stays framed all the way
 * round and yaw = 180 deg is the bow seen head-on rather than empty sea ahead of
 * it. The pitch axis is a real orbit too, on the sphere through the composed
 * pose, so looking up drops the lens toward the water and looking down lifts it
 * over the rig; once the orbit saturates against the sea or the top, the rest of
 * the pitch pans the axis instead of dying. The only limits are the three
 * physical ones (`MIN_EYE_ABOVE_SEA_M`, `MAX_EYE_ELEVATION`, `MAX_AXIS_TILT`).
 * Signs follow the contract on `CameraContext`: drag right, the view goes right;
 * drag up, it looks up.
 *
 * What does NOT come round with the eye is the COMPOSITION. The lateral offset
 * and the leading room above are rules about the shot from astern, and carrying
 * them rigidly to the bow put the head rig off the frame edge; they fade over the
 * first quarter turn instead. See `FRAMING_FADE_FROM`. The fade is exactly 1 at
 * zero look, so the composed shot and every capture of it are unchanged.
 */

/** Yaw rate treated as a full-rudder turn, rad/s. */
const FULL_TURN_RATE = 0.085;
/** Heel treated as full lee-side bias, radians (~12.6 deg). */
const FULL_HEEL = 0.22;

const EYE_HEIGHT_PER_M = 0.26;
const EYE_HEIGHT_BASE = 8;
/**
 * Aim height, as a fraction of the follow distance plus a base. These two set the
 * axis tilt, and through it BOTH the horizon's height in frame and how much of
 * the rig is cropped off the top — which is why the pair is load-bearing and why
 * it is stated here rather than derived.
 *
 * 0.115 put the axis 7.9 deg down at the default 76 m, and that landed the
 * mainmast truck EIGHT PIXELS from the top of a 900-line frame: not a crop, a
 * coincidence, and a `RUBRIC.md` composition failure of exactly the kind grazing
 * the side edge was. 0.083 puts the axis 9.1 deg down, which carries the truck
 * about 60 lines clear OUTSIDE the frame and lifts the horizon from 38% of frame
 * height to 36% — further onto the upper-third line, not off it.
 *
 * Cropping rather than fitting is a choice, and this is the arithmetic behind it:
 * clearing all 67 m of truck at 76 m needs the axis at 2.8 deg down, which puts
 * the horizon at 46% of frame height. That is the postcard the mode's header
 * warns about, and a cropped rig is standard tall-ship framing while a centred
 * horizon is a textbook fault. The real fix is a longer default follow distance —
 * at 95 m the whole rig clears the top by 60 lines with the horizon still at
 * 38% — but the default lives in `world.cam.distance`, outside this directory.
 *
 * One consequence to know about: crop depth falls as the camera pulls back, so
 * somewhere it must pass through zero, and with these constants that crossover is
 * near 88 m. A player parked there will see the truck touch the edge. It cannot
 * be designed away — any aim that always cropped would be aiming at the water by
 * 200 m — so it is placed where nobody sits rather than at the default.
 */
const LOOK_HEIGHT_PER_M = 0.083;
const LOOK_HEIGHT_BASE = 4.5;
/** Fraction of the eye's lateral offset the look target inherits. Below 1 the
 *  axis converges very slightly on the ship, which keeps it from drifting out
 *  of frame at long distances. */
const TARGET_SIDE_FOLLOW = 0.9;

/**
 * Where the hull sits, as NDC x: 0 is frame centre, ±1 is the frame edge. The
 * signs are negative because a camera displaced to starboard (positive `side`)
 * puts the hull to port of the axis. The cap is the load-bearing number — the
 * hull spans about 0.5 NDC at the default distance, so 0.30 leaves it well
 * inside the frame while still sitting on a thirds line.
 *
 * This was inverted on screen until `ShipFrame.right` was corrected to starboard:
 * the hull sat on the outside of the turn, into its own leading room, with the
 * rig running off the frame edge.
 *
 * MIN is the fix for the other half of the problem. Both terms below are signed
 * by how hard she is heeling or turning, and in the commonest state of all — a
 * steady upright reach — both are near zero, so the hull settled onto the
 * centreline. Measured on the `noon` and `golden` captures it sat at NDC -0.10
 * and -0.06: dead centre, which `RUBRIC.md` calls an outright failure on the
 * composition axis. The offset now has a floor, and heel and rudder modulate it
 * between MIN and MAX instead of creating it from nothing.
 */
const SHIP_NDC_FROM_HEEL = -0.17;
const SHIP_NDC_FROM_TURN = -0.15;
const MIN_SHIP_NDC = 0.19;
const MAX_SHIP_NDC = 0.3;
/**
 * How decisively she must lean or turn the OTHER way before the camera changes
 * quarters. Without hysteresis the hull would slide across frame centre every
 * time the heel crossed zero in a swell; with it, the swap happens on a tack and
 * essentially never otherwise.
 */
const SHIP_NDC_FLIP = 0.07;
const LEAD_BASE_M = 6;
const LEAD_PER_SPEED_M = 26;

/**
 * How far the player must yaw off the composed axis before the framing offsets
 * start giving way, and where they finish giving way — radians of look yaw.
 *
 * FROM is past any accidental nudge, so the composed shot and everything near it
 * is untouched. FULL is a quarter turn, by which point the player is plainly
 * aiming the camera themselves rather than looking at the shot the mode composed.
 * See the fade in `solve` for why the rules cannot simply rotate with the eye.
 */
const FRAMING_FADE_FROM = 0.45;
const FRAMING_FADE_FULL = 1.6;
/** What is left of the framing offsets at and beyond FULL. Not zero: a residual
 *  keeps the subject off the centreline instead of dead-centre and symmetrical. */
const FRAMING_AT_HALF_TURN = 0.35;

const FOV_BASE = 58;
const FOV_AT_TOP_SPEED = 64.5;
const BANK_PER_TURN = 0.038; // 2.2 deg at full rudder
const HEEL_TO_ROLL = 0.1;

/**
 * Free-look orbit limits, and all three are physical.
 *
 * `MIN_EYE_ABOVE_SEA_M` is metres above the anchor's waterline the lens may not
 * go below — a little more than `waterClearance`, so the geometry stops the eye
 * before the water clamp has to shove it. `MAX_EYE_ELEVATION` stops the orbit
 * short of vertical, where a world-up look-at basis degenerates and the roll
 * flips. `MAX_AXIS_TILT` caps the pan that takes over once the orbit saturates:
 * the aim point rises as `tan(tilt)`, so it must stop well short of a right
 * angle or it runs to infinity.
 */
const MIN_EYE_ABOVE_SEA_M = 5;
const MAX_EYE_ELEVATION = 1.3;
const MAX_AXIS_TILT = 0.9;

export const CHASE_MIN_DISTANCE = 34;
export const CHASE_MAX_DISTANCE = 260;

export class ChaseMode implements CameraMode {
  readonly name = 'chase';
  /** A full circle, wrapped rather than clamped — see the header. */
  readonly lookYawLimit = Math.PI;
  /**
   * Wide, because the GEOMETRY is what limits the look, not this pair: the eye
   * orbits until it is `MIN_EYE_ABOVE_SEA_M` off the water (looking up) or
   * reaches `MAX_EYE_ELEVATION` (looking down), and whatever pitch is left over
   * pans the axis instead of dying against a wall. These bounds sit just past
   * where all of that saturates.
   */
  readonly lookPitchMin = -1.15;
  readonly lookPitchMax = 1.15;
  /** Drifts back to the composed frame a few seconds after you let go. Slow
   *  enough (a ~2 s time constant) that it reads as the camera settling rather
   *  than as the game taking the controls off you, and the rig fades it out
   *  entirely once the yaw deviation is clearly deliberate, so a player parked
   *  on the bow stays parked. */
  readonly lookRecentreRate = 0.5;
  readonly distanceRange = [CHASE_MIN_DISTANCE, CHASE_MAX_DISTANCE] as const;

  private dist = 76;
  private vDist = { v: 0 };
  private fov = FOV_BASE;
  /** Hull position in NDC x, smoothed. Converted to metres in `solve`. */
  private shipNdc = 0;
  /**
   * Which side of frame centre the hull sits on: -1 puts it to port of centre,
   * +1 to starboard. Hysteretic, so it does not flap — see `shipNdcTarget`.
   */
  side: -1 | 1 = -1;
  private lead = LEAD_BASE_M;
  private roll = 0;
  private eye = new THREE.Vector3();

  enter(ctx: CameraContext): void {
    this.dist = clampDistance(ctx.world.cam.distance);
    this.vDist.v = 0;
    this.fov = FOV_BASE + (FOV_AT_TOP_SPEED - FOV_BASE) * ctx.frame.speedNorm;
    // Seed the quarter from the state she is actually in, so entering the mode
    // mid-turn does not slide the hull across the frame to get there. Below the
    // flip threshold the default quarter stands rather than being re-decided on
    // noise.
    const bias = signedBias(ctx);
    if (Math.abs(bias) > SHIP_NDC_FLIP) this.side = bias > 0 ? 1 : -1;
    this.shipNdc = shipNdcTarget(this, ctx);
    this.lead = LEAD_BASE_M + LEAD_PER_SPEED_M * ctx.frame.speedNorm;
    this.roll = rollTarget(ctx);
  }

  solve(ctx: CameraContext, out: CameraSolve): void {
    const { frame, dt } = ctx;

    this.dist = springDamp(this.dist, clampDistance(ctx.world.cam.distance), this.vDist, 0.45, dt);
    const d = this.dist;

    // Every framing quantity is smoothed independently and slowly. A single
    // spring on the final position would couple speed changes into the height.
    this.fov = damp(this.fov, FOV_BASE + (FOV_AT_TOP_SPEED - FOV_BASE) * frame.speedNorm, 1.2, dt);
    this.shipNdc = damp(this.shipNdc, shipNdcTarget(this, ctx), 1.5, dt);
    this.lead = damp(this.lead, LEAD_BASE_M + LEAD_PER_SPEED_M * frame.speedNorm, 1.1, dt);
    this.roll = damp(this.roll, rollTarget(ctx), 2.0, dt);

    const eyeY = EYE_HEIGHT_PER_M * d + EYE_HEIGHT_BASE;
    const lookY = LOOK_HEIGHT_PER_M * d + LOOK_HEIGHT_BASE;

    // NDC x -> metres of lateral eye offset. Because the target only inherits
    // TARGET_SIDE_FOLLOW of that offset the axis converges slightly on the hull,
    // so the observed offset is a little smaller than the eye's — divide it back
    // out rather than leaving the framing a few percent tighter than asked for.
    // Measured on the COMPOSED geometry, not the orbited one: the rule is a
    // statement about the default shot, and feeding the yawed distance back in
    // made the offset breathe as the player looked around.
    const converge = 1 - (1 - TARGET_SIDE_FOLLOW) * (d / (d + this.lead));
    const tanHalfX =
      Math.tan(THREE.MathUtils.degToRad(this.fov) * 0.5) *
      (ctx.world.size.width / Math.max(1, ctx.world.size.height));
    const sideM = (-this.shipNdc * d * tanHalfX) / converge;

    // --- free look. Elevation first: the eye rides the sphere through the
    // composed pose, so zero look is exactly the framing above.
    const radius = Math.hypot(d, eyeY);
    const elev = orbitElevation(d, eyeY, ctx.lookPitch, MIN_EYE_ABOVE_SEA_M, MAX_EYE_ELEVATION);
    const horiz = radius * Math.cos(elev);
    const eyeUp = radius * Math.sin(elev);
    // Pitch the orbit refused to absorb (the lens would be in the sea, or over
    // the top) tilts the AXIS instead of dying against the limit. At full look-up
    // that lowers the hull in frame and stands the rig against the sky, which is
    // what the player was reaching for.
    const tilt = orbitAxisTilt(d, eyeY, ctx.lookPitch, elev, MAX_AXIS_TILT);

    // The two FRAMING offsets — the lateral placement and the leading room — fade
    // out as the player yaws away from the composed shot. The orbit itself does
    // not; only the composition rules do.
    //
    // Both rules are statements about the shot from ASTERN, and rotating them
    // rigidly round to the bow carries them somewhere they mean nothing. Leading
    // room is the plainer case: it exists to hold the water she is sailing INTO,
    // and at half a turn that water is behind the lens, so the rotated form aims
    // the camera astern of its own subject. The lateral offset fails less visibly
    // and hurts more. It is set in NDC at the composed distance, where the near
    // end of the subject is the taffrail 49 m off; swing round to the bow and the
    // near end is the jibboom at 33 m, so the same metres of offset subtend half
    // again the angle and push the head rig clean off the frame edge. Measured on
    // `shots/cam-bow-chase.png`: the ship crushed against the left edge with the
    // jibboom and headsails clipped, and two thirds of the frame empty sea. That
    // is `RUBRIC.md`'s "awkwardly clipped at the frame edge", arrived at by
    // obeying a composition rule outside the shot it was written for.
    //
    // It fades TO a fraction and not to zero, so the bow shot is off the
    // centreline rather than a dead-symmetrical head-on mirror. At lookYaw = 0
    // the factor is exactly 1, so the composed shot — and every capture of it —
    // is arithmetically unchanged.
    const framing =
      1 -
      (1 - FRAMING_AT_HALF_TURN) *
        smoothstep(FRAMING_FADE_FROM, FRAMING_FADE_FULL, Math.abs(wrapPi(ctx.lookYaw)));
    const sideF = sideM * framing;
    const leadF = this.lead * framing;

    // Yaw rotates the whole composed offset — eye AND target — about the anchor.
    // Positive lookYaw carries the eye to PORT, which is what swings the view to
    // starboard; rotating the target with it is what keeps the ship framed at
    // every angle instead of sliding off at a quarter turn.
    const cy = Math.cos(ctx.lookYaw);
    const sy = Math.sin(ctx.lookYaw);
    const tgtSideM = sideF * TARGET_SIDE_FOLLOW;
    const eyeSide = sideF * cy - horiz * sy;
    const eyeFwd = -horiz * cy - sideF * sy;
    const tgtSide = tgtSideM * cy + leadF * sy;
    const tgtFwd = leadF * cy - tgtSideM * sy;

    anchorRelative(frame, eyeSide, eyeFwd, eyeUp, this.eye);
    out.position.copy(this.eye);
    anchorRelative(frame, tgtSide, tgtFwd, lookY + (horiz + leadF) * Math.tan(tilt), out.target);

    out.roll = this.roll;
    out.fov = this.fov;
    out.aperture = 4;
    out.focusMode = 'point';
    frame.focusPoint(out.focusPoint, 9);
    out.focusRate = 2.6;
    out.shakeScale = 1;
    out.avoidHull = true;
    out.avoidRig = true;
    out.waterClearance = 3.2;
    // The eye is already smooth (everything above it is spring filtered); the
    // TARGET gets nearly twice the smooth time, which is what lets the hull rise
    // and fall inside the frame over a swell instead of being pinned to it.
    out.posSmoothTime = 0.34;
    out.targetSmoothTime = 0.62;
    out.shot = '';
  }
}

function clampDistance(d: number): number {
  return THREE.MathUtils.clamp(d, CHASE_MIN_DISTANCE, CHASE_MAX_DISTANCE);
}


/**
 * Where to put the hull in frame, as NDC x, split into a SIDE and a MAGNITUDE.
 *
 * The side is hysteretic and lives on the mode, because it is a decision, not a
 * measurement: once the camera has chosen a quarter it stays there until she is
 * decisively over the other way. The magnitude is a measurement — how hard she
 * is leaning or turning — and it only ever pushes the hull FURTHER off centre,
 * never back onto the centreline.
 */
function signedBias(ctx: CameraContext): number {
  const heelBias = THREE.MathUtils.clamp(ctx.frame.heel / FULL_HEEL, -1, 1);
  const turnBias = THREE.MathUtils.clamp(ctx.frame.turnRate / FULL_TURN_RATE, -1, 1);
  return heelBias * SHIP_NDC_FROM_HEEL + turnBias * SHIP_NDC_FROM_TURN;
}

function shipNdcTarget(mode: ChaseMode, ctx: CameraContext): number {
  const signed = signedBias(ctx);

  if (signed > SHIP_NDC_FLIP) mode.side = 1;
  else if (signed < -SHIP_NDC_FLIP) mode.side = -1;

  const reach = THREE.MathUtils.clamp(Math.abs(signed) / MAX_SHIP_NDC, 0, 1);
  return mode.side * (MIN_SHIP_NDC + (MAX_SHIP_NDC - MIN_SHIP_NDC) * reach);
}

function rollTarget(ctx: CameraContext): number {
  const turnBias = THREE.MathUtils.clamp(ctx.frame.turnRate / FULL_TURN_RATE, -1, 1);
  // Negative roll tilts the horizon's inside edge down, i.e. banks into the turn.
  return -turnBias * BANK_PER_TURN + ctx.frame.heel * HEEL_TO_ROLL;
}
