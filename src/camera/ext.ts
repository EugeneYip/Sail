import * as THREE from 'three';
import type { CameraModeName } from '../types';

/**
 * Published on `world.ext.camera` — the camera rig's side channel to other
 * subsystems. Allocated once in `init` and mutated in place; never replaced, so
 * a consumer may cache the reference.
 *
 * The post agent is the main consumer: `underwater`/`submersion` drive the
 * underwater look, `cut` says "throw away your temporal history this frame",
 * `focalLengthMm`/`aperture`/`focusDistance` are a physically coherent lens for
 * a real CoC-based depth of field, and `waterProximity` is the cue for lens
 * droplets. Audio can use `velocity` for doppler and `mode` for mix changes.
 */
export interface CameraExt {
  /** Mirrors `world.cam.mode`. */
  mode: CameraModeName;
  /** Cinematic sub-shot id ('waterline' | 'crane' | 'longlens' | 'bowdrop' |
   *  'yard'), or '' outside cinematic mode. */
  shot: string;
  /** True on the single frame a cinematic cut or mode change happened. Post
   *  should reset TAA/motion-blur history when this is true. */
  cut: boolean;
  /**
   * Metres the eye is below the ocean (or terrain) surface at the eye's own XZ.
   * <= 0 means above water. Only the shots that ask for it ever go positive —
   * `waterClearance` on every other mode keeps the lens clear — so a positive
   * value is always deliberate, not an accident to be papered over.
   */
  submersion: number;
  /** 0..1 blend for the underwater look; reaches 1 at 0.35 m below. */
  underwater: number;
  /** 0..1, how near the eye is to the surface (1 at the surface, 0 above 4 m). */
  waterProximity: number;
  /** Eye height above the ocean surface, metres. */
  altitude: number;
  /** Applied rotational shake amplitude, 0..1. Same value as `cam.shake`. */
  shake: number;
  /** Camera world velocity, m/s. Non-zero on cuts is suppressed. */
  velocity: THREE.Vector3;
  /** Final vertical FOV in degrees, including the user offset. */
  fov: number;
  /** 35 mm-equivalent focal length for the current FOV. */
  focalLengthMm: number;
  /** Frame height the focal length refers to, mm. */
  sensorHeightMm: number;
  /** Mirrors `cam.aperture`. */
  aperture: number;
  /** Mirrors `cam.focusDistance`. */
  focusDistance: number;
  /** True while the rig holds a deterministic pose for a screenshot. */
  captureHold: boolean;
  /**
   * The smoothed free-look axes the active mode was solved with, radians, after
   * the input sign normalisation and the mode's clamps.
   *
   * Published so the drag-direction assertions in `.tmp/camdrag.mjs` can check
   * the ACCUMULATOR and the resulting view direction separately. A sign error is
   * trivially easy to "fix" into a different wrong state — two mistakes that
   * cancel look correct from the outside — and this is what tells them apart.
   * Per the contract on `CameraContext`: +lookYaw swings the view to starboard,
   * +lookPitch tilts it up.
   */
  lookYaw: number;
  lookPitch: number;
  /**
   * INPUT, not output. Set to a cinematic shot id before (or with) a
   * `capture:scene` to pin the director to that shot for the capture:
   * 'waterline' | 'crane' | 'longlens' | 'bowdrop' | 'yard'. Empty means the
   * capture default, which is 'waterline'. Ignored outside a capture hold.
   */
  requestShot: string;
  /** DEBUG ONLY — set true from the console to bypass every jitter filter and
   *  follow the raw ship transform. Used to measure the filters' rejection. */
  bypassFilter: boolean;
}

export function createCameraExt(): CameraExt {
  return {
    mode: 'chase',
    shot: '',
    cut: false,
    submersion: -1000,
    underwater: 0,
    waterProximity: 0,
    altitude: 0,
    shake: 0,
    velocity: new THREE.Vector3(),
    fov: 58,
    focalLengthMm: 22,
    sensorHeightMm: 24,
    aperture: 4,
    focusDistance: 80,
    captureHold: false,
    lookYaw: 0,
    lookPitch: 0,
    requestShot: '',
    bypassFilter: false,
  };
}
