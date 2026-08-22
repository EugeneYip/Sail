import * as THREE from 'three';
import type { World } from '../types';
import { clamp01, damp, fromKnots, springDamp, wrapPi } from '../util/math';

/**
 * The filtered ship transform every camera mode follows.
 *
 * The ship is solved by a physics integrator sitting on a wavy surface, so its
 * raw transform carries two very different signals on top of each other:
 *
 *   - LOW frequency (0.05-0.3 Hz): the hull rising over a swell, heeling into a
 *     gust, swinging through a tack. This is the motion you came to watch.
 *   - HIGH frequency (> 3 Hz): integrator chatter, per-frame wave-sample
 *     differences, rudder ringing. On screen this is indistinguishable from
 *     noise, and following it is what makes a camera feel cheap.
 *
 * Everything here exists to pass the first and reject the second. All filters
 * are second order (either `springDamp`, which is a critically damped 2nd-order
 * low-pass, or two cascaded 1st-order slerps), so rejection rises at
 * -40 dB/decade instead of the -20 dB/decade a single lerp gives you.
 *
 * They are also SUB-STEPPED, and that is not an optimisation — see
 * `FILTER_SUBSTEP`. Without it this file is the whole of `DIAGNOSIS.md` §85a.
 */

/** Follow-anchor dead zone. Ship motion smaller than this moves nothing. */
const ANCHOR_DEAD_ZONE_M = 1.4;
/** Heading dead zone, radians (~1.0 deg). */
const HEADING_DEAD_ZONE = 0.0175;

const ANCHOR_SMOOTH_TIME = 0.55;
/** Corner ~0.42 Hz: swell (0.08-0.17 Hz) passes, chatter (>3 Hz) is gone. */
const HEAVE_LOW_SMOOTH_TIME = 0.75;
/** The long-term mean the swell oscillates about. */
const HEAVE_MEAN_SMOOTH_TIME = 4.0;
/**
 * Fraction of the swell-period heave that detached cameras follow. Below 1 the
 * ship rises and falls WITHIN the frame instead of being pinned to it, which is
 * the single biggest reason a helicopter shot looks like a helicopter shot.
 */
const HEAVE_FOLLOW = 0.55;
const HEADING_SMOOTH_TIME = 0.5;
/** Per-stage rate of the two cascaded attitude filters. Corner ~1.4 Hz. */
const ATTITUDE_RATE = 9;
/** Mount-point position filter — fast enough to keep deck cameras rigid. */
const MOUNT_SMOOTH_TIME = 0.11;

const TOP_SPEED_MS = fromKnots(13);
/** Bow vertical acceleration that counts as a full-strength slam, m/s^2. */
const BOW_SLAM_FULL = 45;

/**
 * Longest step any filter in this file may take, seconds.
 *
 * `damp` and `springDamp` are exact for a target that is CONSTANT over the step,
 * and every filter here tracks a target that is moving. A zero-order hold on a
 * moving target leaves a steady-state lag of
 *
 *     v/rate - v*dt/2 + O(dt^2)
 *
 * so the lag SHRINKS as the frame lengthens — and for a deck-mounted camera that
 * lag is the only thing between the eye and the hull it is bolted to. Measured on
 * these very primitives (`.tmp/zoherr.mjs`), a 16.7 ms frame against a 66.7 ms
 * one: every scalar channel loses ~25 ms of lag, and the attitude cascade loses
 * **43.8 ms**, because it is two stages and each pays its own half-step. At
 * 3 deg/s of hull rotation on the main top's 38 m lever arm that is 87 mm of
 * camera position, there and back again, every time the clock stutters — which
 * is `DIAGNOSIS.md` §85a's vibration: 12-13% positional sign reversals in the
 * three ship-mounted modes against 0.8% in the two tethered ones, under an
 * irregular clock only.
 *
 * The cure is to stop letting the display set the filters' step. `update` runs
 * `ceil(dt / FILTER_SUBSTEP)` equal sub-steps with the raw ship transform
 * interpolated across them, so a 66.7 ms frame produces what four 16.7 ms frames
 * would have produced and the lag is the same either way.
 *
 * 1/240 rather than 1/60 because the sub-step COUNT is an integer. A coarse
 * sub-step puts a discontinuity in the lag exactly where players live — dt
 * crossing 16.7 ms would flip between one step and two — whereas at 1/240 the
 * flip is between four and five and the residual is negligible. Across dt from 1
 * to 4 refresh intervals, INCLUDING fractional ones (a real machine does not
 * deliver whole multiples), the lag spread falls from 43.8 ms to 0.69 ms:
 * `.tmp/zohfix.mjs` scores this against the alternatives. It costs four passes
 * of scalar arithmetic and two slerps per frame at 60 fps.
 *
 * A FIELD rather than a constant so a probe can set it huge, collapse the loop
 * back to one step of the whole frame, and reproduce the defect in the SAME page
 * load as the fix. A before/after taken from two different loads minutes apart is
 * how §43 and §49 recorded two contradictory results for one question.
 */
const FILTER_SUBSTEP = 1 / 240;
/** `dt` is clamped to 0.1 s in `core/Engine`, so this bound is never the active one. */
const MAX_SUBSTEPS = 24;

export class ShipFrame {
  /** Raw transform straight off `shipRoot`, unfiltered. */
  readonly rigidPos = new THREE.Vector3();
  readonly rigidQuat = new THREE.Quaternion();
  /** Attitude with chatter removed, swell retained. Deck mounts use this. */
  readonly smoothQuat = new THREE.Quaternion();
  /** Lightly filtered hull origin for deck-mounted cameras. */
  readonly mountPos = new THREE.Vector3();
  /** Heavily filtered follow anchor (dead zone + spring) for detached cameras. */
  readonly anchor = new THREE.Vector3();
  /**
   * Unit basis from the filtered heading only — never tilted. `right` is
   * STARBOARD, i.e. 90 deg clockwise from `forward` seen from above, matching
   * the ship-local +X of `types/index.ts`. It used to be built as
   * `(forward.z, 0, -forward.x)`, which is port, and every mode in this
   * directory was written against the documented starboard convention — so the
   * chase offset, the orbit's sunlit-side choice and four of the five cinematic
   * shots were all silently mirrored. Do not "simplify" this back.
   */
  readonly forward = new THREE.Vector3(0, 0, -1);
  readonly right = new THREE.Vector3(1, 0, 0);
  /** Filtered world velocity, m/s. */
  readonly velocity = new THREE.Vector3();

  /** Continuous (never wrapping) filtered heading, radians. */
  heading = 0;
  /** Filtered heel/pitch, radians. */
  heel = 0;
  pitch = 0;
  /** Filtered yaw rate, rad/s. Positive = turning to starboard. */
  turnRate = 0;
  /** Filtered lateral acceleration in ship space, m/s^2. Positive = to starboard. */
  lateralAccel = 0;
  /** Filtered speed over ground, m/s, and 0..1 against 13 kn. */
  speed = 0;
  speedNorm = 0;
  /** Heave the filter rejected this frame, metres. Diagnostic only. */
  heaveResidual = 0;
  /** 0..1 normalised bow slam. */
  bowSlamNorm = 0;
  /** Low-frequency vertical position of the hull (before HEAVE_FOLLOW). */
  heaveLow = 0;

  /** See `FILTER_SUBSTEP`. Writable so a probe can defeat the sub-stepping. */
  substep = FILTER_SUBSTEP;

  private ready = false;
  private q1 = new THREE.Quaternion();
  private dzCentre = new THREE.Vector3();
  private headingContinuous = 0;
  private headingRawPrev = 0;
  /** Dead-zone centre for the heading channel. */
  private headingDz = 0;
  private prevVel = new THREE.Vector3();
  private tmp = new THREE.Vector3();

  /** This frame's raw ship state, and last frame's — the ends of the sub-step
   *  interpolation. Hoisted, because `update` may never allocate. */
  private rawPos = new THREE.Vector3();
  private rawQuat = new THREE.Quaternion();
  private prevRawPos = new THREE.Vector3();
  private prevRawQuat = new THREE.Quaternion();
  private prevHeel = 0;
  private prevPitch = 0;
  private prevVelIn = new THREE.Vector3();

  private vAnchorX = { v: 0 };
  private vAnchorZ = { v: 0 };
  private vHeaveLow = { v: 0 };
  private vHeaveMean = { v: 0 };
  private vHeading = { v: 0 };
  private vMountX = { v: 0 };
  private vMountY = { v: 0 };
  private vMountZ = { v: 0 };
  private heaveMean = 0;

  /**
   * @param bypass DEBUG — re-seed every filter from the raw transform on each
   *  frame, so the frame IS the raw ship. Drives `ext.camera.bypassFilter`,
   *  which exists to measure what the filters are actually rejecting.
   */
  update(world: World, dt: number, bypass = false): void {
    if (bypass) {
      this.snap(world);
      return;
    }
    const root = world.shipRoot;
    const ship = world.ship;

    // `shipRoot.position/quaternion` are this frame's values (the ship module
    // runs before the camera); `matrixWorld` would be one frame stale because
    // the renderer refreshes it after all module updates.
    this.rawPos.copy(root.position);
    this.rawQuat.copy(root.quaternion);
    if (this.rawPos.lengthSq() === 0 && ship.position.lengthSq() > 0) {
      this.rawPos.copy(ship.position);
      this.rawQuat.copy(ship.quaternion);
    }

    const headingRaw = ship.heading;
    if (!this.ready) this.snap(world, headingRaw);

    const n =
      dt <= this.substep ? 1 : Math.min(MAX_SUBSTEPS, Math.ceil(dt / this.substep - 1e-9));
    const h = dt / n;
    // Unwrap ONCE, here: the accumulator must not see the +-PI seam, and it must
    // not see the whole frame's turn n times over either.
    const dHeading = wrapPi(headingRaw - this.headingRawPrev) / n;
    this.headingRawPrev = headingRaw;

    for (let i = 1; i <= n; i++) {
      const f = i / n;
      // The last sub-step is COPIED, not interpolated, so `rigidPos`/`rigidQuat`
      // still mean exactly what they say when `update` returns — `lerpVectors`
      // at alpha 1 is only exact to a rounding error, and `shift` treats these
      // as the ship's true render-space pose.
      if (i === n) {
        this.rigidPos.copy(this.rawPos);
        this.rigidQuat.copy(this.rawQuat);
      } else {
        this.rigidPos.lerpVectors(this.prevRawPos, this.rawPos, f);
        this.rigidQuat.slerpQuaternions(this.prevRawQuat, this.rawQuat, f);
      }
      this.step(
        h,
        dHeading,
        this.prevHeel + (ship.heel - this.prevHeel) * f,
        this.prevPitch + (ship.pitch - this.prevPitch) * f,
        f,
        ship.velocity,
      );
    }

    this.prevRawPos.copy(this.rawPos);
    this.prevRawQuat.copy(this.rawQuat);
    this.prevHeel = ship.heel;
    this.prevPitch = ship.pitch;
    this.prevVelIn.copy(ship.velocity);
    this.bowSlamNorm = clamp01(Math.abs(ship.bowSlam) / BOW_SLAM_FULL);
  }

  /**
   * One sub-step of every filter. `rigidPos`/`rigidQuat` carry the interpolated
   * raw transform for this sub-step; the scalar targets are interpolated by the
   * caller because they come off `world.ship`, which this method must not read —
   * reading the frame's END state from inside a sub-step is exactly the
   * zero-order hold `FILTER_SUBSTEP` exists to remove.
   */
  private step(
    dt: number,
    dHeading: number,
    heelTarget: number,
    pitchTarget: number,
    f: number,
    velIn: THREE.Vector3,
  ): void {
    // --- heading: continuous angle, then dead zone, then spring.
    this.headingContinuous += dHeading;

    let hTarget = this.headingContinuous;
    const hErr = hTarget - this.headingDz;
    if (hErr > HEADING_DEAD_ZONE) this.headingDz = hTarget - HEADING_DEAD_ZONE;
    else if (hErr < -HEADING_DEAD_ZONE) this.headingDz = hTarget + HEADING_DEAD_ZONE;
    hTarget = this.headingDz;

    const hPrev = this.heading;
    this.heading = springDamp(this.heading, hTarget, this.vHeading, HEADING_SMOOTH_TIME, dt);
    if (dt > 1e-5) {
      this.turnRate = damp(this.turnRate, (this.heading - hPrev) / dt, 3.2, dt);
    }

    this.forward.set(Math.sin(this.heading), 0, -Math.cos(this.heading));
    this.right.set(-this.forward.z, 0, this.forward.x);

    // --- attitude: two cascaded slerps == 2nd-order, -40 dB/decade.
    const k = 1 - Math.exp(-ATTITUDE_RATE * dt);
    this.q1.slerp(this.rigidQuat, k);
    this.smoothQuat.slerp(this.q1, k);
    this.heel = damp(this.heel, heelTarget, ATTITUDE_RATE * 0.7, dt);
    this.pitch = damp(this.pitch, pitchTarget, ATTITUDE_RATE * 0.7, dt);

    // --- vertical: split the swell from the chatter, then follow only part of
    // the swell so the hull moves relative to the frame.
    const yRaw = this.rigidPos.y;
    this.heaveLow = springDamp(this.heaveLow, yRaw, this.vHeaveLow, HEAVE_LOW_SMOOTH_TIME, dt);
    this.heaveMean = springDamp(this.heaveMean, yRaw, this.vHeaveMean, HEAVE_MEAN_SMOOTH_TIME, dt);
    this.heaveResidual = yRaw - this.heaveLow;

    // --- horizontal: dead zone, then spring. The dead-zone centre only moves
    // when the hull leaves a sphere of radius ANCHOR_DEAD_ZONE_M around it, so
    // small oscillations produce exactly zero camera motion.
    this.tmp.set(this.rigidPos.x - this.dzCentre.x, 0, this.rigidPos.z - this.dzCentre.z);
    const err = this.tmp.length();
    if (err > ANCHOR_DEAD_ZONE_M) {
      const s = (err - ANCHOR_DEAD_ZONE_M) / err;
      this.dzCentre.x += this.tmp.x * s;
      this.dzCentre.z += this.tmp.z * s;
    }
    this.anchor.x = springDamp(this.anchor.x, this.dzCentre.x, this.vAnchorX, ANCHOR_SMOOTH_TIME, dt);
    this.anchor.z = springDamp(this.anchor.z, this.dzCentre.z, this.vAnchorZ, ANCHOR_SMOOTH_TIME, dt);
    this.anchor.y = this.heaveMean + HEAVE_FOLLOW * (this.heaveLow - this.heaveMean);

    // --- mount position for deck cameras: rigid enough to feel bolted down,
    // filtered enough that solver chatter never reaches the lens.
    this.mountPos.x = springDamp(this.mountPos.x, this.rigidPos.x, this.vMountX, MOUNT_SMOOTH_TIME, dt);
    this.mountPos.y = springDamp(this.mountPos.y, this.rigidPos.y, this.vMountY, MOUNT_SMOOTH_TIME, dt);
    this.mountPos.z = springDamp(this.mountPos.z, this.rigidPos.z, this.vMountZ, MOUNT_SMOOTH_TIME, dt);

    // --- derived scalars
    this.prevVel.copy(this.velocity);
    const p = this.prevVelIn;
    this.velocity.x = damp(this.velocity.x, p.x + (velIn.x - p.x) * f, 2.4, dt);
    this.velocity.y = damp(this.velocity.y, p.y + (velIn.y - p.y) * f, 2.4, dt);
    this.velocity.z = damp(this.velocity.z, p.z + (velIn.z - p.z) * f, 2.4, dt);
    if (dt > 1e-5) {
      const ax = (this.velocity.x - this.prevVel.x) / dt;
      const az = (this.velocity.z - this.prevVel.z) / dt;
      this.lateralAccel = damp(this.lateralAccel, ax * this.right.x + az * this.right.z, 2.0, dt);
    }
    this.speed = damp(this.speed, this.velocity.length(), 1.6, dt);
    this.speedNorm = clamp01(this.speed / TOP_SPEED_MS);
  }

  /** Re-seed every filter from the ship's current state — used on the first
   *  frame, on a hard cut and after a floating-origin rebase. */
  snap(world: World, headingRaw = world.ship.heading): void {
    const root = world.shipRoot;
    this.rigidPos.copy(root.position);
    this.rigidQuat.copy(root.quaternion);
    if (this.rigidPos.lengthSq() === 0 && world.ship.position.lengthSq() > 0) {
      this.rigidPos.copy(world.ship.position);
      this.rigidQuat.copy(world.ship.quaternion);
    }
    this.q1.copy(this.rigidQuat);
    this.smoothQuat.copy(this.rigidQuat);
    this.mountPos.copy(this.rigidPos);
    this.dzCentre.copy(this.rigidPos);
    this.anchor.copy(this.rigidPos);
    this.heaveLow = this.rigidPos.y;
    this.heaveMean = this.rigidPos.y;
    this.headingContinuous = headingRaw;
    this.headingRawPrev = headingRaw;
    this.headingDz = headingRaw;
    this.heading = headingRaw;
    this.heel = world.ship.heel;
    this.pitch = world.ship.pitch;
    this.turnRate = 0;
    this.lateralAccel = 0;
    this.heaveResidual = 0;
    this.bowSlamNorm = clamp01(Math.abs(world.ship.bowSlam) / BOW_SLAM_FULL);
    this.velocity.copy(world.ship.velocity);
    this.prevVel.copy(this.velocity);
    this.speed = this.velocity.length();
    this.speedNorm = clamp01(this.speed / TOP_SPEED_MS);
    this.forward.set(Math.sin(this.heading), 0, -Math.cos(this.heading));
    this.right.set(-this.forward.z, 0, this.forward.x);
    this.vAnchorX.v = 0;
    this.vAnchorZ.v = 0;
    this.vHeaveLow.v = 0;
    this.vHeaveMean.v = 0;
    this.vHeading.v = 0;
    this.vMountX.v = 0;
    this.vMountY.v = 0;
    this.vMountZ.v = 0;
    // The sub-step interpolation reads last frame's raw state, so a snap that
    // left it behind would ramp every filter from a stale pose on the next
    // frame — which is the one thing a snap exists to prevent.
    this.rawPos.copy(this.rigidPos);
    this.rawQuat.copy(this.rigidQuat);
    this.prevRawPos.copy(this.rigidPos);
    this.prevRawQuat.copy(this.rigidQuat);
    this.prevHeel = this.heel;
    this.prevPitch = this.pitch;
    this.prevVelIn.copy(world.ship.velocity);
    this.ready = true;
  }

  /** Floating-origin rebase: every cached world-space position shifts by d. */
  shift(dx: number, dy: number, dz: number): void {
    this.rigidPos.set(this.rigidPos.x + dx, this.rigidPos.y + dy, this.rigidPos.z + dz);
    this.rawPos.set(this.rawPos.x + dx, this.rawPos.y + dy, this.rawPos.z + dz);
    this.prevRawPos.set(this.prevRawPos.x + dx, this.prevRawPos.y + dy, this.prevRawPos.z + dz);
    this.mountPos.set(this.mountPos.x + dx, this.mountPos.y + dy, this.mountPos.z + dz);
    this.dzCentre.set(this.dzCentre.x + dx, this.dzCentre.y + dy, this.dzCentre.z + dz);
    this.anchor.set(this.anchor.x + dx, this.anchor.y + dy, this.anchor.z + dz);
    this.heaveLow += dy;
    this.heaveMean += dy;
  }

  /** Point on the hull that autofocus and look targets aim at by default. */
  focusPoint(out: THREE.Vector3, heightAboveWaterline: number): THREE.Vector3 {
    return out.set(this.anchor.x, this.anchor.y + heightAboveWaterline, this.anchor.z);
  }
}
