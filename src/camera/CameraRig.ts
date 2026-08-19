import * as THREE from 'three';
import type { CameraModeName, Module, World } from '../types';
import { clamp01, damp, smoothstep, springDamp, wrapPi } from '../util/math';
import { defaultAnatomy, readAnatomy, type ShipAnatomy } from './Anatomy';
import { Autofocus, focalLengthMm, horizonDistance } from './Autofocus';
import { CameraSolve, type CameraContext, type CameraMode } from './CameraMode';
import { CameraCollider, type TerrainProbe } from './Collision';
import { CameraShake } from './Noise';
import { ShipFrame } from './ShipFrame';
import { createCameraExt, type CameraExt } from './ext';
import { BowspritMode } from './modes/Bowsprit';
import { ChaseMode } from './modes/Chase';
import { CinematicMode } from './modes/Cinematic';
import { FreeMode } from './modes/Free';
import { HelmMode } from './modes/Helm';
import { MastheadMode } from './modes/Masthead';
import { OrbitMode } from './modes/Orbit';

/**
 * The rig: mode dispatch, the final motion filters, collision, shake, the lens.
 *
 * A mode's job is composition — where the eye goes and what it looks at. This
 * file owns everything that is true of every camera regardless of the shot:
 *
 *   1. `ShipFrame` — one filtered ship transform, shared by all modes, which is
 *      where the anti-jitter work actually lives (see that file).
 *   2. A final second-order low-pass on the solved eye and, SEPARATELY AND
 *      SLOWER, on the look target. Two independent filters, not one on the
 *      resulting matrix: a slower target means the ship drifts inside the frame
 *      as it rises over a swell instead of being nailed to the same pixel,
 *      which is the difference between a camera and a boom arm.
 *   3. Collision: whisker probes against the hull and sail-plan proxies, and a
 *      probe against the ocean and terrain so a crest cannot engulf the lens.
 *   4. Shake: rotation only, layered gradient noise, never position.
 *   5. The lens: per-mode FOV and aperture, a real dioptre-space focus pull.
 *
 * Mode changes are hard CUTS, never blends. A blend between, say, the helm and
 * the masthead would fly the lens up through the rig; and a cut is what a film
 * does. Everything that carries state across frames is re-seeded on a cut and
 * `ext.camera.cut` goes true for exactly one frame so the post stack can throw
 * away its temporal history.
 *
 * Capture cooperation
 * -------------------
 * `capture:scene` arms a HOLD: `ctx.captureHold` goes true, and the two modes
 * with autonomous motion (`orbit`, `cinematic`) ease into a canonical pose over
 * ~3.4 s and then stop dead. Because the pose is static well before the harness
 * screenshots, the exact capture instant stops mattering and two runs of the
 * same build frame identically. Any real player input releases the hold
 * permanently.
 */

/** What C cycles through. `free` joins only when `settings.debug` is on. */
const PLAYER_CYCLE: readonly CameraModeName[] = [
  'chase',
  'helm',
  'bowsprit',
  'masthead',
  'orbit',
  'cinematic',
];

/** `settings.fov` is a USER OFFSET about this value, not an absolute FOV. */
const NEUTRAL_FOV = 58;
const MIN_FOV = 12;
const MAX_FOV = 110;

/** Height above the waterline of the default collision whisker origin. Inside
 *  the hull on purpose: the whisker asks "is anything between the SHIP and the
 *  lens", and the ship is allowed to be. */
const PIVOT_HEIGHT_M = 4;
const HULL_MARGIN_M = 1.2;
const RIG_MARGIN_M = 2.5;
/** Sail-plan cylinder radius = yardarm span plus a little cloth. */
const RIG_RADIUS_PAD_M = 1.5;

/** Free-look: mouse deltas are a step function, this is the anti-alias on it. */
const LOOK_SMOOTH_TIME = 0.1;
/** Seconds of no input before a framed mode drifts back to its composed axis. */
const LOOK_IDLE_SECONDS = 4;
/**
 * Yaw deviation, radians, over which the drift back to the composed axis fades
 * out completely. Below `LOOK_HOLD_FROM` an accidental nudge tidies itself up;
 * beyond `LOOK_HOLD_FULL` the player has clearly chosen an angle — parked on the
 * beam, or looking forward over the bow — and the camera must not creep out of
 * it while they watch. Taking a deliberate camera placement away from the player
 * is worse than leaving them slightly off-axis.
 */
const LOOK_HOLD_FROM = 0.55;
const LOOK_HOLD_FULL = 1.1;
const ZOOM_PER_NOTCH = 0.14;

/**
 * Signs applied to `input.lookYaw/lookPitch` before anything in this directory
 * sees them. Normalise ONCE, here, and never read `world.input.look*` again from
 * anywhere else in `src/camera` — `ctx.lookYawDelta/lookPitchDelta` carry the
 * corrected raw axes for the modes that need them.
 *
 * `input/Input.ts` accumulates BOTH axes as `-= movement`:
 *
 *   pendingYaw   -= e.movementX      drag right -> NEGATIVE  -> wrong, flip it
 *   pendingPitch -= e.movementY      drag up    -> POSITIVE  -> already right,
 *                                    because screen Y grows downward
 *
 * The contract on `CameraContext` is direct manipulation: +lookYaw swings the
 * view to starboard, +lookPitch tilts it up. So yaw needs the flip and pitch
 * does not, which is why "everything felt inverted" was never a single sign
 * error — it was one inverted axis plus four modes deriving their pose from the
 * EYE instead of the view direction.
 *
 * THE REAL YAW FIX IS ONE CHARACTER IN `Input.ts` (`-=` -> `+=` on the movementX
 * line); that file belongs to another agent, so the flip lives here for now.
 * When Input.ts is corrected, set this to +1 — and change nothing else, because
 * every mode is written against the normalised axis, not the raw one.
 */
const INPUT_LOOK_YAW_SIGN = -1;
const INPUT_LOOK_PITCH_SIGN = 1;

/** Continuous shake floor from the sea, at the top of the Douglas scale. */
const SEA_TREMBLE_MAX = 0.34;
/** Ship displacement in one frame beyond which this must be a floating-origin
 *  rebase and not sailing. 13 kn is 0.67 m at the 0.1 s dt clamp. */
const REBASE_JUMP_M = 40;

const AXIS_Z = new THREE.Vector3(0, 0, 1);
const WORLD_UP = new THREE.Vector3(0, 1, 0);

export class CameraRig implements Module {
  readonly name = 'camera';

  private world!: World;
  private frame = new ShipFrame();
  private collider = new CameraCollider();
  private shake = new CameraShake();
  private focus = new Autofocus();
  private solve = new CameraSolve();
  private anatomy: ShipAnatomy = defaultAnatomy();
  private ext: CameraExt = createCameraExt();
  private ctx!: CameraContext;

  private modes: CameraMode[] = [];
  private active!: CameraMode;
  private activeName: CameraModeName = 'chase';
  /** The mode V toggles back to. */
  private beforeFree: CameraModeName = 'chase';
  private modeTime = 0;

  /** Filtered rig output. */
  private pos = new THREE.Vector3();
  private tgt = new THREE.Vector3();
  private prevPos = new THREE.Vector3();
  private vPos = [{ v: 0 }, { v: 0 }, { v: 0 }];
  private vTgt = [{ v: 0 }, { v: 0 }, { v: 0 }];
  private needSnap = true;
  private pendingCut = true;

  /** Free-look: raw accumulator, then a smoothed value the modes see. */
  private yawRaw = 0;
  private pitchRaw = 0;
  private lookYaw = 0;
  private lookPitch = 0;
  private vYaw = { v: 0 };
  private vPitch = { v: 0 };
  private lookIdle = 0;

  private captureArmed = false;
  private captureTime = 0;
  private captureMode: CameraModeName = 'chase';
  /** Seconds left of re-asserting the captured mode — see `onCaptureScene`. */
  private captureLatch = 0;
  private sawPlayerInput = false;

  private lastSeenMode: CameraModeName = 'chase';
  private lastPublishedShake = -1;
  private lastPublishedAperture = -1;
  private apertureOverride = 0;
  private prevFreeKey = false;
  private anatomyTimer = 0;
  private hasPrevRigid = false;
  private prevRigid = new THREE.Vector3();

  private detach: (() => void)[] = [];

  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private qTmp = new THREE.Quaternion();
  private euler = new THREE.Euler();
  private raw = new THREE.Vector3();
  private scratch = new THREE.Vector3();

  init(world: World): void {
    this.world = world;
    this.modes = [
      new ChaseMode(),
      new HelmMode(),
      new BowspritMode(),
      new MastheadMode(),
      new OrbitMode(),
      new CinematicMode(),
      new FreeMode(),
    ];
    this.active = this.modes[0];
    this.activeName = 'chase';

    world.ext.camera = this.ext;

    readAnatomy(world, this.anatomy);
    this.applyProxies(world);
    this.frame.snap(world);

    this.ctx = {
      world,
      dt: 0,
      frame: this.frame,
      anatomy: this.anatomy,
      lookYaw: 0,
      lookPitch: 0,
      lookYawDelta: 0,
      lookPitchDelta: 0,
      modeTime: 0,
      captureHold: false,
      captureTime: 0,
    };

    this.detach.push(world.bus.on('origin:shift', (p) => this.onOriginShift(p)));
    this.detach.push(world.bus.on('capture:scene', () => this.onCaptureScene()));
    this.detach.push(world.bus.on('capture:focusIsland', () => this.onCaptureScene()));

    this.setMode(world.cam.mode, true);
  }

  update(world: World): void {
    const dt = world.time.dt;
    const input = world.input;
    const cam = world.cam;

    // --- the harness sets cam.mode and THEN emits capture:scene; the title
    // card's dismissal handler, which also runs on that event, sets it back to
    // 'chase'. Re-assert for a moment so an externally requested mode survives.
    if (this.captureLatch > 0) {
      this.captureLatch -= dt;
      cam.mode = this.captureMode;
    }

    this.refreshAnatomy(world, dt);
    this.guardRebase(world);
    this.frame.update(world, dt, this.ext.bypassFilter);

    const locked = cam.locked || input.uiFocus;
    this.readPlayerInput(world, dt, locked);
    this.resolveMode(world, input.cameraNext && !locked);

    if (this.captureArmed) this.captureTime += dt;
    this.modeTime += dt;

    // --- solve the shot
    const ctx = this.ctx;
    ctx.dt = dt;
    ctx.lookYaw = this.lookYaw;
    ctx.lookPitch = this.lookPitch;
    ctx.modeTime = this.modeTime;
    ctx.captureHold = this.captureArmed;
    ctx.captureTime = this.captureTime;

    this.solve.reset();
    this.frame.focusPoint(this.solve.pivot, PIVOT_HEIGHT_M);
    this.active.solve(ctx, this.solve);

    const cut = this.pendingCut || this.solve.cut;
    this.pendingCut = false;
    if (cut) this.onCut();

    // --- final motion filters. `bypassFilter` skips them so the debug harness
    // can measure what they are actually rejecting.
    const bypass = this.ext.bypassFilter;
    if (this.needSnap || bypass) {
      this.pos.copy(this.solve.position);
      this.tgt.copy(this.solve.target);
      this.prevPos.copy(this.pos);
      for (let i = 0; i < 3; i++) {
        this.vPos[i].v = 0;
        this.vTgt[i].v = 0;
      }
      this.needSnap = false;
    } else {
      this.smooth(this.pos, this.solve.position, this.vPos, this.solve.posSmoothTime, dt);
      this.smooth(this.tgt, this.solve.target, this.vTgt, this.solve.targetSmoothTime, dt);
    }

    // --- collision
    this.collider.moved = 0;
    if (!bypass) {
      if (this.solve.avoidHull) {
        this.collider.resolveHull(
          this.pos,
          this.solve.pivot,
          this.frame.mountPos,
          this.frame.smoothQuat,
          HULL_MARGIN_M,
        );
      }
      if (this.solve.avoidRig) {
        this.collider.resolveRig(
          this.pos,
          this.solve.pivot,
          this.frame.mountPos,
          this.frame.smoothQuat,
          RIG_MARGIN_M,
        );
      }
    }
    const terrain = (world.ext.world as TerrainProbe | undefined) ?? null;
    const submersion = this.collider.resolveSurfaces(
      this.pos,
      world.ocean,
      terrain,
      bypass ? -1000 : this.solve.waterClearance,
      dt,
    );

    // --- shake. Read cam.shake as a REQUEST only when somebody other than this
    // rig wrote it, otherwise last frame's published amplitude would feed back
    // and the shake would never decay.
    const requested = cam.shake === this.lastPublishedShake ? 0 : clamp01(cam.shake);
    const seaFloor =
      SEA_TREMBLE_MAX *
      clamp01((world.env.seaState - 2.5) / 5.5) *
      (0.35 + 0.65 * this.frame.speedNorm);
    this.shake.update(
      dt,
      world.time.elapsed,
      Math.max(this.frame.bowSlamNorm, requested),
      seaFloor,
      this.solve.shakeScale,
    );

    // --- orientation
    this.scratch.subVectors(this.tgt, this.pos);
    if (this.scratch.lengthSq() < 1e-6) {
      // Degenerate aim (a mode put the target on the eye) — keep the last
      // orientation rather than letting lookAt produce a garbage basis.
      this.q.copy(world.camera.quaternion);
    } else {
      this.m.lookAt(this.pos, this.tgt, WORLD_UP);
      this.q.setFromRotationMatrix(this.m);
    }
    if (Math.abs(this.solve.roll) > 1e-5) {
      this.qTmp.setFromAxisAngle(AXIS_Z, this.solve.roll);
      this.q.multiply(this.qTmp);
    }
    if (this.shake.amplitude > 1e-4) {
      this.euler.set(this.shake.pitch, this.shake.yaw, this.shake.roll, 'YXZ');
      this.qTmp.setFromEuler(this.euler);
      this.q.multiply(this.qTmp);
    }

    world.camera.position.copy(this.pos);
    world.camera.quaternion.copy(this.q);

    // --- lens
    const fov = THREE.MathUtils.clamp(
      this.solve.fov + (world.settings.fov - NEUTRAL_FOV),
      MIN_FOV,
      MAX_FOV,
    );
    if (Math.abs(world.camera.fov - fov) > 1e-3) {
      world.camera.fov = fov;
      world.camera.updateProjectionMatrix();
    }
    world.camera.updateMatrixWorld();

    // A slider in photo mode owns the aperture the moment the player touches it.
    if (cam.aperture !== this.lastPublishedAperture) this.apertureOverride = cam.aperture;
    const aperture = this.apertureOverride > 0 ? this.apertureOverride : this.solve.aperture;

    const seaLevel = world.ocean ? world.ocean.seaLevel : 0;
    let focusTarget: number;
    if (this.solve.focusMode === 'horizon') {
      focusTarget = horizonDistance(this.pos.y - seaLevel);
    } else if (this.solve.focusMode === 'fixed') {
      focusTarget = this.solve.focusFixed;
    } else {
      focusTarget = this.pos.distanceTo(this.solve.focusPoint);
    }
    if (cut) this.focus.snap(focusTarget);
    else this.focus.update(dt, focusTarget, this.solve.focusRate);

    cam.focusDistance = this.focus.distance;
    cam.aperture = aperture;
    cam.mode = this.activeName;
    cam.shake = this.shake.amplitude;
    this.lastPublishedAperture = aperture;
    this.lastPublishedShake = this.shake.amplitude;
    this.lastSeenMode = this.activeName;

    // --- publish. `submersion` is metres BELOW the surface, so altitude is its
    // negation; the -1e6 sentinel means the ocean module has not booted yet.
    const ext = this.ext;
    const known = submersion > -1e5;
    ext.mode = this.activeName;
    ext.shot = this.solve.shot;
    ext.cut = cut;
    ext.submersion = known ? submersion : -1000;
    ext.underwater = known ? clamp01(submersion / 0.35) : 0;
    ext.altitude = known ? -submersion : 1000;
    ext.waterProximity = 1 - clamp01(ext.altitude / 4);
    ext.shake = this.shake.amplitude;
    ext.fov = fov;
    ext.focalLengthMm = focalLengthMm(fov);
    ext.aperture = aperture;
    ext.focusDistance = this.focus.distance;
    ext.captureHold = this.captureArmed;
    ext.lookYaw = this.lookYaw;
    ext.lookPitch = this.lookPitch;
    if (cut || dt <= 1e-5) ext.velocity.set(0, 0, 0);
    else ext.velocity.subVectors(this.pos, this.prevPos).multiplyScalar(1 / dt);
    this.prevPos.copy(this.pos);

    world.stats.camMoved = this.collider.moved;
  }

  applySettings(world: World): void {
    // FOV is re-derived from settings.fov every frame; nothing to rebuild. The
    // proxies are cheap, and quality changes can arrive with a new ship.
    this.applyProxies(world);
  }

  dispose(): void {
    for (const off of this.detach) off();
    this.detach.length = 0;
  }

  /* ---------------------------------------------------------------- *
   *  input + mode selection
   * ---------------------------------------------------------------- */

  private readPlayerInput(world: World, dt: number, locked: boolean): void {
    const input = world.input;
    const mode = this.active;

    // Normalise the input signs once, at the boundary. Everything downstream —
    // including the fly-cam, which accumulates its own angles — reads these.
    const yawIn = input.lookYaw * INPUT_LOOK_YAW_SIGN;
    const pitchIn = input.lookPitch * INPUT_LOOK_PITCH_SIGN;
    const gate = locked ? 0 : 1;
    this.ctx.lookYawDelta = yawIn * gate;
    this.ctx.lookPitchDelta = pitchIn * gate;

    const activity = Math.abs(input.lookYaw) + Math.abs(input.lookPitch) + Math.abs(input.zoom);
    if (!locked && (activity > 1e-6 || input.cameraNext || input.keys.size > 0)) {
      this.notePlayerInput();
    }

    if (!locked && !mode.ownsLook) {
      if (activity > 1e-6) this.lookIdle = 0;
      else this.lookIdle += dt;

      if (mode.lookYawLimit > 0) {
        this.yawRaw += yawIn;
        // A mode that allows a full turn (a crow's nest, or the chase camera
        // swinging round to look at the bow) must not be clamped or it hits an
        // invisible wall; the angle stays continuous instead.
        if (mode.lookYawLimit < Math.PI) {
          this.yawRaw = THREE.MathUtils.clamp(this.yawRaw, -mode.lookYawLimit, mode.lookYawLimit);
        } else {
          this.yawRaw = wrapPi(this.yawRaw);
        }
      }
      if (mode.lookPitchMax > mode.lookPitchMin) {
        this.pitchRaw = THREE.MathUtils.clamp(
          this.pitchRaw + pitchIn,
          mode.lookPitchMin,
          mode.lookPitchMax,
        );
      }

      const recentre = mode.lookRecentreRate ?? 0;
      if (recentre > 0 && this.lookIdle > LOOK_IDLE_SECONDS) {
        // Pitch always settles — a lifted or dropped eye is a transient. Yaw
        // only settles while the deviation still reads as a nudge.
        const hold = smoothstep(LOOK_HOLD_FROM, LOOK_HOLD_FULL, Math.abs(this.yawRaw));
        if (hold < 1) this.yawRaw = damp(this.yawRaw, 0, recentre * (1 - hold), dt);
        this.pitchRaw = damp(this.pitchRaw, 0, recentre, dt);
      }

      if (input.zoom !== 0 && mode.distanceRange) {
        const r = mode.distanceRange;
        world.cam.distance = THREE.MathUtils.clamp(
          world.cam.distance * Math.exp(input.zoom * ZOOM_PER_NOTCH),
          r[0],
          r[1],
        );
      }
    }

    // Smooth the yaw along the SHORTEST ARC. `yawRaw` wraps at +-PI in the
    // 360-degree modes, and a spring chasing the raw value across that seam
    // would take the long way round — a full unwanted revolution of the camera
    // at exactly the angle where a player looking over the bow is sitting.
    const yawWant = this.lookYaw + wrapPi(this.yawRaw - this.lookYaw);
    this.lookYaw = wrapPi(springDamp(this.lookYaw, yawWant, this.vYaw, LOOK_SMOOTH_TIME, dt));
    this.lookPitch = springDamp(this.lookPitch, this.pitchRaw, this.vPitch, LOOK_SMOOTH_TIME, dt);
  }

  private resolveMode(world: World, cycle: boolean): void {
    // `input.justPressed` cannot be used from here: the input module clears its
    // fresh-key set at the end of its own update, which runs first.
    const freeKey = !world.input.uiFocus && world.input.pressed('v');
    const freeEdge = freeKey && !this.prevFreeKey;
    this.prevFreeKey = freeKey;

    if (cycle) {
      this.notePlayerInput();
      this.setMode(this.nextInCycle(world));
      return;
    }
    if (freeEdge && !world.cam.locked) {
      this.notePlayerInput();
      this.setMode(this.activeName === 'free' ? this.beforeFree : 'free');
      return;
    }
    if (world.cam.mode !== this.lastSeenMode && world.cam.mode !== this.activeName) {
      this.setMode(world.cam.mode);
    }
  }

  private nextInCycle(world: World): CameraModeName {
    if (this.activeName === 'free') return this.beforeFree;
    const cycle = PLAYER_CYCLE;
    let i = cycle.indexOf(this.activeName);
    i = (i + 1) % cycle.length;
    // Debug builds get the fly-cam on the end of the cycle too.
    if (i === 0 && world.settings.debug && this.activeName === cycle[cycle.length - 1]) {
      return 'free';
    }
    return cycle[i];
  }

  private setMode(name: CameraModeName, initial = false): void {
    const next = this.modeByName(name);
    if (!initial && next === this.active) {
      this.lastSeenMode = name;
      this.activeName = name;
      return;
    }
    if (this.activeName !== 'free') this.beforeFree = this.activeName;
    this.activeName = name;
    this.active = next;
    this.lastSeenMode = name;
    this.world.cam.mode = name;

    this.modeTime = 0;
    this.yawRaw = 0;
    this.pitchRaw = 0;
    this.lookYaw = 0;
    this.lookPitch = 0;
    this.vYaw.v = 0;
    this.vPitch.v = 0;
    this.lookIdle = 0;
    this.apertureOverride = 0;
    this.pendingCut = true;

    const ctx = this.ctx;
    ctx.lookYaw = 0;
    ctx.lookPitch = 0;
    ctx.modeTime = 0;
    ctx.captureHold = this.captureArmed;
    ctx.captureTime = this.captureTime;
    this.solve.reset();
    this.frame.focusPoint(this.solve.pivot, PIVOT_HEIGHT_M);
    next.enter(ctx, this.solve);
  }

  private modeByName(name: CameraModeName): CameraMode {
    for (let i = 0; i < this.modes.length; i++) {
      if (this.modes[i].name === name) return this.modes[i];
    }
    return this.modes[0];
  }

  private onCut(): void {
    this.needSnap = true;
    this.shake.reset();
    this.collider.reset();
  }

  private notePlayerInput(): void {
    this.sawPlayerInput = true;
    if (this.captureArmed) {
      this.captureArmed = false;
      this.captureLatch = 0;
    }
  }

  /* ---------------------------------------------------------------- *
   *  capture + floating origin
   * ---------------------------------------------------------------- */

  private onCaptureScene(): void {
    if (this.sawPlayerInput) return;
    this.captureMode = this.world.cam.mode;
    this.captureArmed = true;
    this.captureTime = 0;
    this.captureLatch = 2;
    this.pendingCut = true;
    if (this.captureMode !== this.activeName) this.setMode(this.captureMode);
    else this.active.enter(this.ctx, this.solve);
  }

  /**
   * `origin:shift` payload is the delta that was ADDED to every render-space
   * position when physics rebased the world. Everything the rig has cached in
   * render space moves with it, so the camera does not jump. `guardRebase`
   * catches a rebase that arrives without an event, whatever the sign
   * convention turns out to be.
   */
  private onOriginShift(payload?: unknown): void {
    const d = payload as { x?: number; y?: number; z?: number } | undefined;
    if (!d || typeof d.x !== 'number' || typeof d.y !== 'number' || typeof d.z !== 'number') return;
    this.applyShift(d.x, d.y, d.z);
  }

  private applyShift(dx: number, dy: number, dz: number): void {
    this.frame.shift(dx, dy, dz);
    for (let i = 0; i < this.modes.length; i++) this.modes[i].shift?.(dx, dy, dz);
    this.pos.set(this.pos.x + dx, this.pos.y + dy, this.pos.z + dz);
    this.tgt.set(this.tgt.x + dx, this.tgt.y + dy, this.tgt.z + dz);
    this.prevPos.set(this.prevPos.x + dx, this.prevPos.y + dy, this.prevPos.z + dz);
    this.solve.position.set(
      this.solve.position.x + dx,
      this.solve.position.y + dy,
      this.solve.position.z + dz,
    );
    this.solve.target.set(
      this.solve.target.x + dx,
      this.solve.target.y + dy,
      this.solve.target.z + dz,
    );
    if (this.hasPrevRigid) {
      this.prevRigid.set(this.prevRigid.x + dx, this.prevRigid.y + dy, this.prevRigid.z + dz);
    }
  }

  /** Backstop for a rebase with no event, or with the opposite sign. */
  private guardRebase(world: World): void {
    this.raw.copy(world.shipRoot.position);
    if (this.raw.lengthSq() === 0 && world.ship.position.lengthSq() > 0) {
      this.raw.copy(world.ship.position);
    }
    if (this.hasPrevRigid) {
      const dx = this.raw.x - this.prevRigid.x;
      const dy = this.raw.y - this.prevRigid.y;
      const dz = this.raw.z - this.prevRigid.z;
      if (dx * dx + dy * dy + dz * dz > REBASE_JUMP_M * REBASE_JUMP_M) {
        this.applyShift(dx, dy, dz);
      }
    }
    this.prevRigid.copy(this.raw);
    this.hasPrevRigid = true;
  }

  /* ---------------------------------------------------------------- *
   *  housekeeping
   * ---------------------------------------------------------------- */

  private refreshAnatomy(world: World, dt: number): void {
    this.anatomyTimer -= dt;
    if (this.anatomyTimer > 0) return;
    this.anatomyTimer = 1;
    readAnatomy(world, this.anatomy);
    this.applyProxies(world);
  }

  private applyProxies(world: World): void {
    const a = this.anatomy;
    this.collider.setHull(
      world.ship.beam || 13.3,
      Math.max(20, a.sternZ - a.bowZ),
      world.ship.draught || 6.4,
      a.bulwarkY,
    );
    this.collider.setRig(
      a.mainYardHalfSpan + RIG_RADIUS_PAD_M,
      a.deckY,
      a.mastheadY,
      a.mainMastZ,
    );
  }

  private smooth(
    out: THREE.Vector3,
    want: THREE.Vector3,
    v: { v: number }[],
    smoothTime: number,
    dt: number,
  ): void {
    if (smoothTime <= 1e-4) {
      out.copy(want);
      v[0].v = 0;
      v[1].v = 0;
      v[2].v = 0;
      return;
    }
    out.x = springDamp(out.x, want.x, v[0], smoothTime, dt);
    out.y = springDamp(out.y, want.y, v[1], smoothTime, dt);
    out.z = springDamp(out.z, want.z, v[2], smoothTime, dt);
  }
}
