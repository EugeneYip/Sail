import * as THREE from 'three';
import { FullscreenPass } from './FullscreenPass';
import type { Targets } from './Targets';
import { MOTION_BLUR_FRAG } from './shaders/motionBlur';
import { NEIGHBOUR_MAX_FRAG, TILE_MAX_FRAG } from './shaders/velocity';

/**
 * Velocity-buffer motion blur.
 *
 * Tile size and maximum blur length are the same number by construction: the
 * tile-max/neighbour-max dilation is only correct for displacements that stay
 * inside one tile of the pixel being shaded, so letting the blur run longer
 * than a tile produces exactly the streaks off object edges that make cheap
 * motion blur look broken. 20 px at 900 lines is about 1.3 degrees of pan per
 * frame before the cap bites, which no sane camera move reaches.
 */
const TILE = 20;
/**
 * Exposure time, seconds. A real shutter is a TIME, not a fraction of whatever
 * frame the engine happened to produce, and the velocity buffer is in uv per
 * frame — so the shutter fraction has to be `EXPOSURE_S / dt` or the blur
 * tracks the frame rate. 0.35 of a 60 fps frame is 5.83 ms, so this is the same
 * 126-degree look at the target frame rate and the same physical exposure away
 * from it. Non-negotiable 9 in AGENTS.md, and it matters most in the case that
 * hurts: a frame that took 50 ms used to get three times the smear, which is a
 * quality spiral exactly when the frame is already struggling.
 */
const EXPOSURE_S = 0.35 / 60;
/**
 * Ceiling on the shutter fraction. The buffer only knows ONE frame of motion, so
 * asking for more than a frame's worth of displacement is extrapolation; above
 * ~170 fps the honest answer is to stop lengthening the streak.
 */
const MAX_SHUTTER = 1;

export class MotionBlur {
  private tileX: FullscreenPass | null = null;
  private tileY: FullscreenPass | null = null;
  private neighbour: FullscreenPass | null = null;
  private blur: FullscreenPass | null = null;

  private width = 1;
  private height = 1;
  private tilesX = 1;
  private tilesY = 1;

  constructor(private readonly targets: Targets) {}

  resize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.tilesX = Math.max(1, Math.ceil(this.width / TILE));
    this.tilesY = Math.max(1, Math.ceil(this.height / TILE));
    this.targets.get('mbTileX', this.tilesX, this.height, 'rg16f', { nearest: true });
    this.targets.get('mbTile', this.tilesX, this.tilesY, 'rg16f', { nearest: true });
    this.targets.get('mbNeighbour', this.tilesX, this.tilesY, 'rg16f', { nearest: true });
  }

  release(): void {
    this.targets.release('mbTileX');
    this.targets.release('mbTile');
    this.targets.release('mbNeighbour');
  }

  render(
    renderer: THREE.WebGLRenderer,
    source: THREE.Texture,
    velocity: THREE.Texture,
    depth: THREE.Texture,
    near: number,
    far: number,
    dst: THREE.WebGLRenderTarget,
    taps: number,
    frame: number,
    dt: number,
  ): void {
    const tileXRt = this.targets.get('mbTileX', this.tilesX, this.height, 'rg16f', { nearest: true });
    const tileRt = this.targets.get('mbTile', this.tilesX, this.tilesY, 'rg16f', { nearest: true });
    const nbRt = this.targets.get('mbNeighbour', this.tilesX, this.tilesY, 'rg16f', { nearest: true });

    const x = this.getTileX();
    x.uniforms.tVelocity.value = velocity;
    (x.uniforms.uTexelSize.value as THREE.Vector2).set(1 / this.width, 1 / this.height);
    x.render(renderer, tileXRt);

    const y = this.getTileY();
    y.uniforms.tVelocity.value = tileXRt.texture;
    (y.uniforms.uTexelSize.value as THREE.Vector2).set(1 / this.tilesX, 1 / this.height);
    y.render(renderer, tileRt);

    const n = this.getNeighbour();
    n.uniforms.tTile.value = tileRt.texture;
    (n.uniforms.uTexelSize.value as THREE.Vector2).set(1 / this.tilesX, 1 / this.tilesY);
    n.render(renderer, nbRt);

    const b = this.getBlur(taps);
    b.uniforms.tColor.value = source;
    b.uniforms.tVelocity.value = velocity;
    b.uniforms.tNeighbourMax.value = nbRt.texture;
    b.uniforms.tDepth.value = depth;
    (b.uniforms.uResolution.value as THREE.Vector2).set(this.width, this.height);
    (b.uniforms.uTexelSize.value as THREE.Vector2).set(1 / this.width, 1 / this.height);
    (b.uniforms.uDepthRange.value as THREE.Vector2).set(near, far);
    b.uniforms.uShutter.value = Math.min(MAX_SHUTTER, EXPOSURE_S / Math.max(dt, 1e-4));
    b.uniforms.uMaxLength.value = TILE;
    b.uniforms.uFrame.value = frame;
    b.render(renderer, dst);
  }

  private getTileX(): FullscreenPass {
    if (!this.tileX) {
      this.tileX = new FullscreenPass('mb/tileX', TILE_MAX_FRAG, {
        tVelocity: { value: null },
        uDir: { value: new THREE.Vector2(1, 0) },
        uTexelSize: { value: new THREE.Vector2() },
        uTile: { value: TILE },
      });
    }
    return this.tileX;
  }

  private getTileY(): FullscreenPass {
    if (!this.tileY) {
      this.tileY = new FullscreenPass('mb/tileY', TILE_MAX_FRAG, {
        tVelocity: { value: null },
        uDir: { value: new THREE.Vector2(0, 1) },
        uTexelSize: { value: new THREE.Vector2() },
        uTile: { value: TILE },
      });
    }
    return this.tileY;
  }

  private getNeighbour(): FullscreenPass {
    if (!this.neighbour) {
      this.neighbour = new FullscreenPass('mb/neighbour', NEIGHBOUR_MAX_FRAG, {
        tTile: { value: null },
        uTexelSize: { value: new THREE.Vector2() },
      });
    }
    return this.neighbour;
  }

  private getBlur(taps: number): FullscreenPass {
    if (!this.blur) {
      this.blur = new FullscreenPass(
        'mb/blur',
        MOTION_BLUR_FRAG,
        {
          tColor: { value: null },
          tVelocity: { value: null },
          tNeighbourMax: { value: null },
          tDepth: { value: null },
          uResolution: { value: new THREE.Vector2() },
          uTexelSize: { value: new THREE.Vector2() },
          uShutter: { value: EXPOSURE_S * 60 },
          uMaxLength: { value: TILE },
          uFrame: { value: 0 },
          uDepthRange: { value: new THREE.Vector2(0.25, 60000) },
        },
        { MB_MAX_TAPS: taps },
      );
    }
    this.blur.setDefine('MB_MAX_TAPS', taps);
    return this.blur;
  }

  dispose(): void {
    this.tileX?.dispose();
    this.tileY?.dispose();
    this.neighbour?.dispose();
    this.blur?.dispose();
  }
}
