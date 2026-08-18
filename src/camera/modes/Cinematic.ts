import * as THREE from 'three';
import {
  aimOffset,
  anchorRelative,
  localToWorld,
  type CameraContext,
  type CameraMode,
  type CameraSolve,
} from '../CameraMode';
import { makeRng, smootherstep } from '../../util/math';

/**
 * The auto-director. Five shots, each with its own composition rules and its
 * own move, cut between every 8-14 seconds.
 *
 * Every shot is placed RELATIVE TO THE SHIP, never at a fixed world point. A
 * world-anchored camera would be more truthful — a real crew boat does not
 * accelerate to 11 knots — but the ship would leave frame in 6 seconds and, far
 * more importantly, two captures of the same build would frame completely
 * differently. Ship-relative placement plus a move parameter `u` gives the same
 * apparent motion (the ship crosses frame because the camera dollies past it)
 * and stays comparable.
 *
 * Determinism
 * -----------
 *   - `enter()` seeds a mulberry32 from a QUANTISED `world.time.elapsed`, so
 *     the shot order and the 8-14 s cut lengths are reproducible.
 *   - Under `ctx.captureHold` the director stops cutting entirely, locks to the
 *     requested shot (`ext.camera.requestShot`, default `waterline`) and eases
 *     `u` from its start value to that shot's `uHold` over 3.4 s, then holds
 *     dead still. The screenshot instant no longer matters, which is the only
 *     way a settle loop with 250 ms granularity can produce comparable frames.
 *
 * Nothing here can look through the hull: four of the five shots sit well
 * outside the hull proxy and aim inward, and the fifth is bolted to a yardarm.
 */

/** Shot ids, in index order. Published on `ext.camera.shot`. */
export const CINEMATIC_SHOTS = ['waterline', 'crane', 'longlens', 'bowdrop', 'yard'] as const;
export type CinematicShot = (typeof CINEMATIC_SHOTS)[number];

const SHOT_COUNT = CINEMATIC_SHOTS.length;
const MIN_SHOT_SECONDS = 8;
const MAX_SHOT_SECONDS = 14;
/** Seconds the capture ease takes before the pose is frozen. */
const CAPTURE_EASE_SECONDS = 3.4;
/** `elapsed` quantum the director's seed is derived from, seconds. */
const SEED_QUANTUM = 30;

/** Where each shot parks for a capture, in its own `u`. */
const U_HOLD = [0.42, 0.45, 0.5, 0.62, 0.35];

export class CinematicMode implements CameraMode {
  readonly name = 'cinematic';
  // An auto-director does not take direction. Free-look is disabled outright
  // rather than clamped so a stray mouse drag cannot break a composed frame.
  readonly lookYawLimit = 0;
  readonly lookPitchMin = 0;
  readonly lookPitchMax = 0;

  private rng: () => number = makeRng(1);
  private index = 0;
  private t = 0;
  private duration = 11;
  /** Latched at the cut so a slow turn cannot flip the camera across the ship. */
  private side = 1;
  private cutPending = false;

  private eye = new THREE.Vector3();
  private subject = new THREE.Vector3();

  enter(ctx: CameraContext): void {
    const quantum = Math.floor(ctx.world.time.elapsed / SEED_QUANTUM);
    this.rng = makeRng(quantum * 2654435761 + 0x9e37);
    this.index = Math.floor(this.rng() * SHOT_COUNT) % SHOT_COUNT;
    this.beginShot(ctx);
  }

  solve(ctx: CameraContext, out: CameraSolve): void {
    let u: number;

    if (ctx.captureHold) {
      const want = requestedShot(ctx);
      if (want !== this.index) {
        this.index = want;
        this.side = sunSide(ctx);
      }
      // Ease in from a little before the hold pose: visible settling motion,
      // then a dead stop that the screenshot timing cannot see.
      const hold = U_HOLD[this.index];
      const k = smootherstep(0, CAPTURE_EASE_SECONDS, ctx.captureTime);
      u = hold - 0.16 * (1 - k);
    } else {
      this.t += ctx.dt;
      if (this.t >= this.duration) {
        this.index = (this.index + 1 + Math.floor(this.rng() * (SHOT_COUNT - 1))) % SHOT_COUNT;
        this.beginShot(ctx);
      }
      u = this.t / this.duration;
    }

    out.cut = this.cutPending;
    this.cutPending = false;
    out.shot = CINEMATIC_SHOTS[this.index];

    switch (this.index) {
      case 0:
        this.waterline(ctx, out, u);
        break;
      case 1:
        this.crane(ctx, out, u);
        break;
      case 2:
        this.longLens(ctx, out, u);
        break;
      case 3:
        this.bowDrop(ctx, out, u);
        break;
      default:
        this.yard(ctx, out, u);
    }
  }

  private beginShot(ctx: CameraContext): void {
    this.t = 0;
    this.duration = MIN_SHOT_SECONDS + this.rng() * (MAX_SHOT_SECONDS - MIN_SHOT_SECONDS);
    this.side = sunSide(ctx);
    this.cutPending = true;
  }

  /* ---------------------------------------------------------------- *
   *  the shots
   * ---------------------------------------------------------------- */

  /**
   * WATERLINE — the lens two metres off the sea, the ship crossing the frame.
   *
   * - Eye rides the swell: the surface probe holds 2.4 m of clearance, so the
   *   camera rises and falls with the water like a boat would, and the crests
   *   pass in front of the hull.
   * - Dollies from 52 m ahead to 34 m astern while closing from 82 m to 64 m
   *   abeam, so the ship swings from a bow quarter to a stern quarter.
   * - Aims 14 m up the rig, which sets the axis ~9 deg above horizontal and
   *   drops the horizon to the lower third. Two thirds rig and sky, one third
   *   water, hull as a thin band on the line between them.
   * - The aim offset sweeps -8 -> +8 deg, sliding the ship from one third of
   *   frame width to the other. That, not the dolly, is what "crossing frame"
   *   means to the eye.
   */
  private waterline(ctx: CameraContext, out: CameraSolve, u: number): void {
    const e = smootherstep(0, 1, u);
    anchorRelative(ctx.frame, this.side * (82 - 18 * e), 52 - 86 * e, 2.4, this.eye);
    out.position.copy(this.eye);

    ctx.frame.focusPoint(this.subject, 14);
    aimOffset(this.eye, this.subject, this.side * (-0.14 + 0.28 * e), 0.01, out.target);

    out.fov = 54;
    out.aperture = 2.8;
    out.focusMode = 'point';
    out.focusPoint.copy(this.subject);
    out.focusRate = 2.2;
    out.shakeScale = 0.75;
    out.avoidHull = true;
    out.avoidRig = false;
    out.waterClearance = 2.4;
    out.posSmoothTime = 0.5;
    out.targetSmoothTime = 0.85;
  }

  /**
   * CRANE — a slow rise from just above the rail to above the trucks.
   *
   * - Climbs 8 m -> 92 m on a smootherstep, so it eases out of the deck and
   *   into the sky instead of starting and stopping abruptly.
   * - The aim descends 34 m -> 10 m as the eye climbs, which tips the axis from
   *   level to 30 deg down. The rig therefore passes DOWN through the frame
   *   while the camera passes UP through the rig: two opposed motions, which is
   *   what gives a crane its lift.
   * - Drifts 56 m -> 70 m out at the same time. Without it the ship would grow
   *   in frame as the axis tips down and the shot would feel like a zoom.
   * - 46 deg lens; f/3.5 tracking the aim point.
   */
  private crane(ctx: CameraContext, out: CameraSolve, u: number): void {
    const e = smootherstep(0, 1, u);
    const aimY = 34 - 24 * e;
    anchorRelative(ctx.frame, this.side * (56 + 14 * e), 24 - 6 * e, 8 + 84 * e, this.eye);
    out.position.copy(this.eye);

    ctx.frame.focusPoint(this.subject, aimY);
    aimOffset(this.eye, this.subject, this.side * 0.09, 0, out.target);

    out.fov = 46;
    out.aperture = 3.5;
    out.focusMode = 'point';
    out.focusPoint.copy(this.subject);
    out.focusRate = 1.8;
    out.shakeScale = 0.5;
    out.avoidHull = true;
    out.avoidRig = true;
    out.waterClearance = 3;
    out.posSmoothTime = 0.55;
    out.targetSmoothTime = 0.9;
  }

  /**
   * LONG LENS — the ship small in a very big sea.
   *
   * - 620 m off the beam on a 30 deg lens (~45 mm equivalent). The long focal
   *   length compresses the swell into stacked bands and stops the sea reading
   *   as empty blue: at this distance the wave field is the subject and the
   *   ship is the thing that gives it scale.
   * - Eye at 11 m, aim 3.4 deg below the horizon, which puts the horizon at
   *   38% of frame height. The ship sits on it, spanning about a fifth of the
   *   frame, with the remaining 62% water.
   * - Ship held ~8 deg off axis, drifting slowly across the near third.
   * - f/8. A landscape is sharp front to back; shallow focus here would be an
   *   affectation.
   */
  private longLens(ctx: CameraContext, out: CameraSolve, u: number): void {
    const e = smootherstep(0, 1, u);
    anchorRelative(ctx.frame, this.side * (600 + 40 * e), 190 - 380 * e, 11, this.eye);
    out.position.copy(this.eye);

    ctx.frame.focusPoint(this.subject, 20);
    aimOffset(this.eye, this.subject, this.side * (0.15 - 0.06 * e), -0.055, out.target);

    out.fov = 30;
    out.aperture = 8;
    out.focusMode = 'point';
    out.focusPoint.copy(this.subject);
    out.focusRate = 1.4;
    // A long lens magnifies angular shake as much as it magnifies the subject.
    out.shakeScale = 0.28;
    out.avoidHull = false;
    out.avoidRig = false;
    out.waterClearance = 3.5;
    out.posSmoothTime = 0.75;
    out.targetSmoothTime = 1.2;
  }

  /**
   * BOW DROP — from the water, ahead of the stem, as the bow comes down.
   *
   * - The eye closes from 72 m to 30 m ahead of the hull origin (45 m to 3 m
   *   ahead of the stem) and 16 m off the bow. The approach is what sells it:
   *   the bow grows through the shot and the last seconds are very close.
   * - Aims at the STEM HEAD through the ship's own attitude, not at the filtered
   *   anchor, so every degree of pitch swings the target and the bow visibly
   *   rises and falls against the horizon. This is the one shot that wants the
   *   hull's raw motion.
   * - 1.05 m above the water with only 0.55 m of clearance demanded: in any real
   *   sea a crest WILL take the lens under, which is deliberate — see
   *   `ext.camera.submersion`.
   * - Axis ~15 deg up puts the horizon at three quarters of frame height and
   *   leaves the bow towering over it. f/2.2, focused on the stem.
   */
  private bowDrop(ctx: CameraContext, out: CameraSolve, u: number): void {
    const e = smootherstep(0, 1, u);
    const { anatomy, frame } = ctx;
    anchorRelative(frame, this.side * (16 + 3 * e), 72 - 42 * e, 1.05, this.eye);
    out.position.copy(this.eye);

    localToWorld(frame, 0, anatomy.bowY, anatomy.bowZ, this.subject);
    aimOffset(this.eye, this.subject, this.side * 0.13, 0.05, out.target);
    // Whisker from the stem, not from inside the hull: this is the one shot
    // whose subject is a point on the outside of the ship.
    out.pivot.copy(this.subject);

    out.fov = 58;
    out.aperture = 2.2;
    out.focusMode = 'point';
    out.focusPoint.copy(this.subject);
    out.focusRate = 2.8;
    out.shakeScale = 1.25;
    out.avoidHull = true;
    out.avoidRig = false;
    out.waterClearance = 0.55;
    out.posSmoothTime = 0.4;
    out.targetSmoothTime = 0.5;
  }

  /**
   * YARD — out on the main yard, looking inboard along it.
   *
   * - Seated on the weather yardarm and sliding 18 m -> 10 m inboard over the
   *   shot, so the yard, its footrope and the head of the course sweep through
   *   the bottom of the frame as a single converging line into the mast.
   * - Aims 7 m below the yard and 15 m forward, which puts the mast and the
   *   fore rig in the upper half, the deck and the bow wave in the lower, and
   *   the horizon on the diagonal between them.
   * - Rigidly mounted: full heel, full pitch, no output smoothing. 24 m up on a
   *   13 m beam, eight degrees of heel move this camera three metres. Filtering
   *   that out would leave a shot with no reason to exist.
   */
  private yard(ctx: CameraContext, out: CameraSolve, u: number): void {
    const e = smootherstep(0, 1, u);
    const { anatomy, frame } = ctx;
    const x = this.side * (anatomy.mainYardHalfSpan - 2.5 - 8 * e);
    localToWorld(frame, x, anatomy.mainYardY + 1.4, anatomy.mainMastZ + 0.4, this.eye);
    out.position.copy(this.eye);

    localToWorld(
      frame,
      -x * 0.12,
      anatomy.mainYardY - 7,
      anatomy.mainMastZ - 15 - 4 * e,
      this.subject,
    );
    out.target.copy(this.subject);
    out.pivot.copy(this.subject);

    out.roll = frame.heel;
    out.fov = 62;
    out.aperture = 3.2;
    out.focusMode = 'point';
    out.focusPoint.copy(this.subject);
    out.focusRate = 3;
    out.shakeScale = 1.2;
    out.avoidHull = false;
    out.avoidRig = false;
    out.waterClearance = -50;
    out.posSmoothTime = 0;
    out.targetSmoothTime = 0;
  }
}

/** +1 when the sun bears to starboard, so the camera sits on the lit side. */
function sunSide(ctx: CameraContext): number {
  const sun = ctx.world.env.sunDirection;
  const bearing = Math.atan2(sun.x, -sun.z);
  const rel = Math.sin(bearing - ctx.frame.heading);
  // At night the sun is below the horizon and the choice is arbitrary; the
  // moon is usually the only key light, so fall back to it.
  if (sun.y < 0.02) {
    const moon = ctx.world.env.moonDirection;
    return Math.sin(Math.atan2(moon.x, -moon.z) - ctx.frame.heading) >= 0 ? 1 : -1;
  }
  return rel >= 0 ? 1 : -1;
}

function requestedShot(ctx: CameraContext): number {
  const ext = ctx.world.ext.camera as { requestShot?: string } | undefined;
  const want = ext?.requestShot ?? '';
  if (!want) return 0;
  const i = CINEMATIC_SHOTS.indexOf(want as CinematicShot);
  return i < 0 ? 0 : i;
}
