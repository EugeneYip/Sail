import * as THREE from 'three';
import type { World } from '../types';
import { FullscreenPass } from './FullscreenPass';
import type { Targets } from './Targets';
import { DOF_COMBINE_FRAG, DOF_GATHER_FRAG, DOF_NEAR_MAX_FRAG, DOF_PREPARE_FRAG } from './shaders/dof';

/**
 * Physical depth of field.
 *
 * The lens is the camera rig's, not a made-up one: focal length comes from the
 * live vertical FOV and the 24 mm frame height the rig reports, the f-number
 * from `cam.aperture`, the focal plane from `cam.focusDistance`. At the
 * defaults (58 deg, f/2.8, focus at 80 m) that is roughly 3 px of blur on
 * rigging two metres from the lens and 0.05 px at the horizon — barely there,
 * which is the correct amount for a scene whose subject is 80 m away.
 *
 * The gather runs at half resolution with 16 taps. Cutting taps is the first
 * thing to give up under budget pressure; cutting the near-field pass is the
 * last, because a hard-edged foreground is the classic tell that a DoF is fake.
 */
const SENSOR_HEIGHT_MM = 24;
/** Full-res pixels. Also the near-field search radius, so it bounds cost. */
const MAX_COC_FRACTION = 0.022;

export class DepthOfField {
  private prepare: FullscreenPass | null = null;
  private nearMax: FullscreenPass | null = null;
  private far: FullscreenPass | null = null;
  private near: FullscreenPass | null = null;
  private combine: FullscreenPass | null = null;

  private width = 1;
  private height = 1;
  private maxCoc = 8;

  constructor(private readonly targets: Targets) {}

  resize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.maxCoc = Math.min(26, Math.max(5, this.height * MAX_COC_FRACTION));
    const hw = Math.max(1, this.width >> 1);
    const hh = Math.max(1, this.height >> 1);
    this.targets.get('dofHalf', hw, hh, 'rgba16f');
    this.targets.get('dofFar', hw, hh, 'rgba16f');
    this.targets.get('dofNear', hw, hh, 'rgba16f');
    this.targets.get('dofNearMax', Math.max(1, hw >> 2), Math.max(1, hh >> 2), 'r16f');
  }

  release(): void {
    this.targets.release('dofHalf');
    this.targets.release('dofFar');
    this.targets.release('dofNear');
    this.targets.release('dofNearMax');
  }

  /** True when the lens is stopped down / focused far enough to be a no-op. */
  private writeCocUniforms(world: World, u: Record<string, THREE.IUniform>): boolean {
    const cam = world.camera;
    const ext = world.ext.camera as
      | { sensorHeightMm?: number; aperture?: number; focusDistance?: number }
      | undefined;

    const sensorH = (ext?.sensorHeightMm ?? SENSOR_HEIGHT_MM) / 1000;
    const fovRad = (cam.fov * Math.PI) / 180;
    const focal = sensorH / 2 / Math.tan(fovRad / 2);
    const nStop = Math.max(0.7, ext?.aperture ?? world.cam.aperture);
    const focus = Math.max(focal * 1.05, ext?.focusDistance ?? world.cam.focusDistance);

    (u.uCocParams.value as THREE.Vector2).set((focal * focal) / nStop, focal);
    (u.uCocScale.value as THREE.Vector2).set(this.height / sensorH, 1 / this.maxCoc);
    u.uFocus.value = focus;
    (u.uDepthRange.value as THREE.Vector2).set(cam.near, cam.far);
    u.uMaxCoc.value = this.maxCoc;

    // Hyperfocal check: if everything from the near plane out is inside the
    // circle of confusion, there is nothing to do.
    const hyperfocal = (focal * focal) / (nStop * 0.00003) + focal;
    return focus < hyperfocal * 1.5;
  }

  private cocUniforms(): Record<string, THREE.IUniform> {
    return {
      uCocParams: { value: new THREE.Vector2() },
      uCocScale: { value: new THREE.Vector2() },
      uFocus: { value: 80 },
      uDepthRange: { value: new THREE.Vector2(0.25, 60000) },
      uMaxCoc: { value: 8 },
    };
  }

  /**
   * Returns true when it wrote `dst`; false when the lens produced no visible
   * blur and the caller should keep using `source`.
   */
  render(
    renderer: THREE.WebGLRenderer,
    world: World,
    source: THREE.Texture,
    depth: THREE.Texture,
    dst: THREE.WebGLRenderTarget,
    taps: number,
  ): boolean {
    const hw = Math.max(1, this.width >> 1);
    const hh = Math.max(1, this.height >> 1);
    const half = this.targets.get('dofHalf', hw, hh, 'rgba16f');
    const farRt = this.targets.get('dofFar', hw, hh, 'rgba16f');
    const nearRt = this.targets.get('dofNear', hw, hh, 'rgba16f');
    const nearMaxRt = this.targets.get('dofNearMax', Math.max(1, hw >> 2), Math.max(1, hh >> 2), 'r16f');

    const p = this.getPrepare();
    if (!this.writeCocUniforms(world, p.uniforms)) return false;
    p.uniforms.tColor.value = source;
    p.uniforms.tDepth.value = depth;
    (p.uniforms.uFullTexel.value as THREE.Vector2).set(1 / this.width, 1 / this.height);
    p.render(renderer, half);

    const nm = this.getNearMax();
    nm.uniforms.tHalf.value = half.texture;
    (nm.uniforms.uHalfTexel.value as THREE.Vector2).set(1 / hw, 1 / hh);
    nm.render(renderer, nearMaxRt);

    const farPass = this.getFar(taps);
    const nearPass = this.getNear(taps);
    const frame = world.time.frame;
    for (let i = 0; i < 2; i++) {
      const g = i === 0 ? farPass : nearPass;
      g.uniforms.tHalf.value = half.texture;
      g.uniforms.tNearMax.value = nearMaxRt.texture;
      (g.uniforms.uHalfTexel.value as THREE.Vector2).set(1 / hw, 1 / hh);
      g.uniforms.uMaxCoc.value = this.maxCoc;
      g.uniforms.uFrame.value = frame;
    }
    farPass.render(renderer, farRt);
    nearPass.render(renderer, nearRt);

    const c = this.getCombine();
    this.writeCocUniforms(world, c.uniforms);
    c.uniforms.tColor.value = source;
    c.uniforms.tDepth.value = depth;
    c.uniforms.tFar.value = farRt.texture;
    c.uniforms.tNear.value = nearRt.texture;
    c.render(renderer, dst);
    return true;
  }

  private getPrepare(): FullscreenPass {
    if (!this.prepare) {
      this.prepare = new FullscreenPass('dof/prepare', DOF_PREPARE_FRAG, {
        tColor: { value: null },
        tDepth: { value: null },
        uFullTexel: { value: new THREE.Vector2() },
        ...this.cocUniforms(),
      });
    }
    return this.prepare;
  }

  private getNearMax(): FullscreenPass {
    if (!this.nearMax) {
      this.nearMax = new FullscreenPass('dof/nearMax', DOF_NEAR_MAX_FRAG, {
        tHalf: { value: null },
        uHalfTexel: { value: new THREE.Vector2() },
      });
    }
    return this.nearMax;
  }

  private gatherUniforms(): Record<string, THREE.IUniform> {
    return {
      tHalf: { value: null },
      tNearMax: { value: null },
      uHalfTexel: { value: new THREE.Vector2() },
      uMaxCoc: { value: 8 },
      uFrame: { value: 0 },
    };
  }

  private getFar(taps: number): FullscreenPass {
    if (!this.far) {
      this.far = new FullscreenPass('dof/far', DOF_GATHER_FRAG, this.gatherUniforms(), {
        DOF_TAPS: taps,
      });
    }
    this.far.setDefine('DOF_TAPS', taps);
    return this.far;
  }

  private getNear(taps: number): FullscreenPass {
    if (!this.near) {
      this.near = new FullscreenPass('dof/near', DOF_GATHER_FRAG, this.gatherUniforms(), {
        DOF_TAPS: taps,
        DOF_NEAR: 1,
      });
    }
    this.near.setDefine('DOF_TAPS', taps);
    return this.near;
  }

  private getCombine(): FullscreenPass {
    if (!this.combine) {
      this.combine = new FullscreenPass('dof/combine', DOF_COMBINE_FRAG, {
        tColor: { value: null },
        tDepth: { value: null },
        tFar: { value: null },
        tNear: { value: null },
        ...this.cocUniforms(),
      });
    }
    return this.combine;
  }

  dispose(): void {
    this.prepare?.dispose();
    this.nearMax?.dispose();
    this.far?.dispose();
    this.near?.dispose();
    this.combine?.dispose();
  }
}
