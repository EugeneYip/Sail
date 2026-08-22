import * as THREE from 'three';
import type { World } from '../types';
import {
  CLOUD_LOW_BOTTOM_M,
  CLOUD_LOW_TOP_M,
  CLOUD_RESOLUTION_DIVISOR,
  CLOUD_SHADOW_EXTENT_M,
  CLOUD_SHADOW_SIZE,
  CLOUD_SHADOW_TEMPORAL_TAU_S,
  CLOUD_TEMPORAL_ALPHA,
  GROUND_RADIUS_KM,
  M_TO_KM,
} from './constants';
import { CloudField } from './CloudField';
import { SkyPass } from './Pass';
import {
  CLOUD_MARCH_FRAG,
  CLOUD_RESOLVE_FRAG,
  CLOUD_SHADOW_COPY_FRAG,
  CLOUD_SHADOW_FRAG,
  CLOUD_SHADOW_RESOLVE_FRAG,
} from './shaders/cloudPasses';
import type { SkyUniforms } from './SkyRender';
import { makeWhitePixel } from './Textures';

/** Texel size of the shadow map in metres — the snap grid for its centre. */
const SHADOW_TEXEL_M = CLOUD_SHADOW_EXTENT_M / CLOUD_SHADOW_SIZE;

/** One R16F slice-sized target. Three of these: raw, resolved, history. */
function makeShadowTarget(name: string): THREE.WebGLRenderTarget {
  const t = new THREE.WebGLRenderTarget(CLOUD_SHADOW_SIZE, CLOUD_SHADOW_SIZE, {
    type: THREE.HalfFloatType,
    format: THREE.RedFormat,
    colorSpace: THREE.NoColorSpace,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });
  t.texture.name = name;
  return t;
}

/**
 * Volumetric clouds: two layers, a quarter-resolution raymarch with temporal
 * reprojection, and a top-down transmittance slice for the rest of the game.
 *
 * ## Why it is affordable
 *
 * A 48-step march with a 6-step sun march at every dense sample is roughly 400
 * texture fetches per ray. At 1600x900 that would be 570 M fetches a frame and
 * nothing else would fit in the budget. Three things pay for it:
 *
 *   quarter resolution   half width and half height, so 1/4 of the rays. Clouds
 *                        are the lowest-frequency thing in the frame; a bilinear
 *                        upsample of a temporally converged buffer is
 *                        indistinguishable from marching every pixel.
 *   temporal integration The march is deliberately UNDER-sampled and the start
 *                        offset is dithered per pixel per frame. Eleven frames
 *                        of accumulation at alpha 0.09 makes 48 steps behave
 *                        like several hundred.
 *   geometric steps      Step length grows 5.5% per step, so a grazing 55 km
 *                        chord and a 3 km vertical one cost the same and both
 *                        are dense where the cloud is actually resolvable.
 *
 * ## Where it runs
 *
 * From `SkyRender.onDraw`, i.e. from inside the main scene render, immediately
 * before the sky fragment shader that consumes it. That is the only place with
 * the *final* camera matrices: the camera rig updates after the sky module, so
 * anything latched in `update()` is a frame stale and the clouds visibly swim
 * behind the ship. Rays are built from the UN-jittered projection so TAA's
 * sub-pixel offset never enters the reprojection.
 */
export class Clouds {
  readonly field: CloudField;
  /** Resolved cloud buffer: rgb = radiance the clouds add, a = sky survival. */
  get texture(): THREE.Texture {
    return this.history[this.current].texture;
  }
  readonly shadowMatrix = new THREE.Matrix4();
  /** 1/size of the resolved buffer, for the consumer's reconstruction filter. */
  readonly texel = new THREE.Vector2(1 / 800, 1 / 450);
  get shadowTexture(): THREE.Texture {
    return this.enabled ? this.shadow.texture : this.fallback;
  }

  /**
   * `shadow` is the PUBLISHED slice and its texture identity never changes:
   * EnvProbe.setClouds and the march's tCloudShadow bind it once, outside the
   * frame loop, so a ping-pong here would silently leave them on a stale half.
   * The filter therefore costs one extra copy rather than an identity swap.
   */
  private shadow: THREE.WebGLRenderTarget;
  private shadowRaw: THREE.WebGLRenderTarget;
  private shadowPrev: THREE.WebGLRenderTarget;
  private shadowCentre = new THREE.Vector2(NaN, NaN);
  private raw: THREE.WebGLRenderTarget;
  private history: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  private current = 0;

  private shadowPass: SkyPass;
  private shadowResolvePass: SkyPass;
  private shadowCopyPass: SkyPass;
  private marchPass: SkyPass;
  private resolvePass: SkyPass;
  private fallback = makeWhitePixel();

  private enabled = true;
  private reset = true;
  private lastFrame = -1;
  private width = 0;
  private height = 0;

  /* scratch — never allocate in render() */
  private camPos = new THREE.Vector3();
  private unjittered = new THREE.Matrix4();
  private unjitteredInv = new THREE.Matrix4();
  private rayMatrix = new THREE.Matrix4();
  private viewProj = new THREE.Matrix4();
  private prevViewProj = new THREE.Matrix4();
  private prevCamPos = new THREE.Vector3();

  private gl: WebGL2RenderingContext | null = null;
  private timing = false;
  private mark = 0;

  constructor(uniforms: SkyUniforms) {
    this.field = new CloudField(uniforms);

    this.shadow = makeShadowTarget('sky.cloudShadow');
    this.shadowRaw = makeShadowTarget('sky.cloudShadowRaw');
    this.shadowPrev = makeShadowTarget('sky.cloudShadowPrev');

    this.raw = makeCloudTarget(1, 1, 'sky.cloudRaw');
    this.history = [makeCloudTarget(1, 1, 'sky.cloudA'), makeCloudTarget(1, 1, 'sky.cloudB')];

    this.shadowPass = new SkyPass(CLOUD_SHADOW_FRAG, {
      ...uniforms,
      uShadowCentre: { value: new THREE.Vector2() },
      uShadowExtent: { value: CLOUD_SHADOW_EXTENT_M },
      uFrameIndex: { value: 0 },
    });
    this.shadowResolvePass = new SkyPass(CLOUD_SHADOW_RESOLVE_FRAG, {
      tRaw: { value: this.shadowRaw.texture },
      tHistory: { value: this.shadowPrev.texture },
      uHistShift: { value: new THREE.Vector2() },
      uAlpha: { value: 1 },
      uReset: { value: 1 },
    });
    this.shadowCopyPass = new SkyPass(CLOUD_SHADOW_COPY_FRAG, {
      tSrc: { value: this.shadow.texture },
    });
    this.marchPass = new SkyPass(CLOUD_MARCH_FRAG, {
      ...uniforms,
      tCloudShadow: { value: this.shadow.texture },
      uCloudShadowMatrix: { value: this.shadowMatrix },
      uRayMatrix: { value: this.rayMatrix },
      uCameraPosW: { value: this.camPos },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uFrameIndex: { value: 0 },
      uSteps: { value: 48 },
      uShafts: { value: 1 },
    });
    this.resolvePass = new SkyPass(CLOUD_RESOLVE_FRAG, {
      tRaw: { value: this.raw.texture },
      tHistory: { value: this.history[1].texture },
      uRayMatrix: { value: this.rayMatrix },
      uPrevViewProj: { value: this.prevViewProj },
      uCameraPosW: { value: this.camPos },
      uTexel: { value: new THREE.Vector2() },
      uMidRadius: {
        value: GROUND_RADIUS_KM + ((CLOUD_LOW_BOTTOM_M + CLOUD_LOW_TOP_M) * 0.5) * M_TO_KM,
      },
      uAlpha: { value: CLOUD_TEMPORAL_ALPHA },
      uReset: { value: 1 },
    });
  }

  /** Bake the field. Call once, during module init. */
  bake(world: World): void {
    this.field.bake(world.renderer);
    this.applySettings(world);
  }

  applySettings(world: World): void {
    const s = world.settings;
    this.enabled = s.volumetricClouds;
    this.marchPass.uniforms.uSteps.value = THREE.MathUtils.clamp(s.cloudSteps, 12, 96);
    // The shaft march is 10 extra samples of a 2D texture per ray; at low it is
    // the first thing to go, since without a temporal filter it would dither.
    this.marchPass.uniforms.uShafts.value = s.quality === 'low' ? 0 : 1;
    this.reset = true;
  }

  /** CPU-side field advection. Runs in the module update, before the camera moves. */
  update(world: World): void {
    // `debugStalls`, not `debug`: `end()` calls gl.finish(), which serialises
    // the pipeline and is why the cloud passes appeared to spike under load.
    this.timing = world.settings.debugStalls === true;
    this.field.update(world.env, world.origin, world.time.dt);
    const p = world.camera.position;
    const cx = Math.round(p.x / SHADOW_TEXEL_M) * SHADOW_TEXEL_M;
    const cz = Math.round(p.z / SHADOW_TEXEL_M) * SHADOW_TEXEL_M;
    (this.shadowPass.uniforms.uShadowCentre.value as THREE.Vector2).set(cx, cz);
    const e = CLOUD_SHADOW_EXTENT_M;

    // Realign the filter's history with the re-snapped centre. A world point at
    // current uv sat at uv + (centreNow - centrePrev)/extent in the previous
    // frame, and because the centre only ever moves in whole texels that offset
    // lands exactly on a texel — no resampling error accumulates. First frame
    // has no previous centre, so the shift is zero and `reset` covers it.
    const prev = this.shadowCentre;
    (this.shadowResolvePass.uniforms.uHistShift.value as THREE.Vector2).set(
      Number.isNaN(prev.x) ? 0 : (cx - prev.x) / e,
      Number.isNaN(prev.y) ? 0 : (cz - prev.y) / e,
    );
    this.shadowCentre.set(cx, cz);
    // World position -> shadow uv in .xy. Row 1 reads Z, not Y: the map is a
    // horizontal slice, so a receiver's altitude is not part of the lookup.
    this.shadowMatrix.set(
      1 / e, 0, 0, 0.5 - cx / e,
      0, 0, 1 / e, 0.5 - cz / e,
      0, 0, 0, 0,
      0, 0, 0, 1,
    );
  }

  /** Invalidate the temporal history — call on a camera cut. */
  invalidate(): void {
    this.reset = true;
  }

  /**
   * Render the shadow slice, the march and the resolve. Called from inside the
   * main scene render with the final camera.
   */
  render(world: World, camera: THREE.Camera, renderer: THREE.WebGLRenderer): void {
    if (!this.enabled) return;
    // The sky mesh draws once per scene render; if anything ever renders the
    // scene twice in a frame, the second pass must not re-march.
    if (this.lastFrame === world.time.frame) return;
    this.lastFrame = world.time.frame;

    // The rig runs after the sky module but before the render hook, so the cut
    // flag for THIS frame is already up by the time we get here.
    const camExt = world.ext.camera as { cut?: boolean } | undefined;
    if (camExt?.cut) this.reset = true;

    const proj = camera as THREE.PerspectiveCamera;
    const w = Math.max(1, Math.floor(world.size.width / CLOUD_RESOLUTION_DIVISOR));
    const h = Math.max(1, Math.floor(world.size.height / CLOUD_RESOLUTION_DIVISOR));
    if (w !== this.width || h !== this.height) {
      this.width = w;
      this.height = h;
      this.raw.setSize(w, h);
      this.history[0].setSize(w, h);
      this.history[1].setSize(w, h);
      (this.marchPass.uniforms.uResolution.value as THREE.Vector2).set(w, h);
      (this.resolvePass.uniforms.uTexel.value as THREE.Vector2).set(1 / w, 1 / h);
      this.texel.set(1 / w, 1 / h);
      this.reset = true;
    }

    // Undo TAA's jitter so both the march and the reprojection work in a single
    // stable screen space. `apply()` subtracts the NDC offset from elements 8
    // and 9 of the projection; adding it back is exact.
    const jitter = world.uniforms.uJitter.value as THREE.Vector2;
    this.unjittered.copy(proj.projectionMatrix);
    this.unjittered.elements[8] += jitter.x;
    this.unjittered.elements[9] += jitter.y;
    this.unjitteredInv.copy(this.unjittered).invert();
    this.camPos.setFromMatrixPosition(camera.matrixWorld);
    this.rayMatrix.multiplyMatrices(camera.matrixWorld, this.unjitteredInv);
    this.viewProj.multiplyMatrices(this.unjittered, camera.matrixWorldInverse);

    // A jump cut has no usable history at all. 40 m in one frame is far beyond
    // anything the rig does at speed, so this only fires on a real camera change.
    if (this.prevCamPos.distanceToSquared(this.camPos) > 1600) this.reset = true;

    this.begin();
    this.shadowPass.uniforms.uFrameIndex.value = world.time.frame % 64;
    this.shadowPass.render(renderer, this.shadowRaw);
    const su = this.shadowResolvePass.uniforms;
    su.uReset.value = this.reset ? 1 : 0;
    // Frame-rate independent: a fixed per-frame alpha would tie the filter's time
    // constant to the frame rate, and this is a buffer the player can hold still
    // and stare at. At 60 fps this lands on 0.055, next to CLOUD_TEMPORAL_ALPHA.
    su.uAlpha.value = 1 - Math.exp(-Math.max(world.time.dt, 1e-4) / CLOUD_SHADOW_TEMPORAL_TAU_S);
    this.shadowResolvePass.render(renderer, this.shadow);
    this.shadowCopyPass.render(renderer, this.shadowPrev);
    this.end(world, 'sky:cloudShadowMs');

    this.begin();
    this.marchPass.uniforms.uFrameIndex.value = world.time.frame % 64;
    this.marchPass.render(renderer, this.raw);
    this.end(world, 'sky:cloudMarchMs');

    const next = this.current ^ 1;
    this.begin();
    const ru = this.resolvePass.uniforms;
    ru.tHistory.value = this.history[this.current].texture;
    ru.uReset.value = this.reset ? 1 : 0;
    this.resolvePass.render(renderer, this.history[next]);
    this.end(world, 'sky:cloudResolveMs');

    this.current = next;
    this.prevViewProj.copy(this.viewProj);
    this.prevCamPos.copy(this.camPos);
    this.reset = false;
    world.stats['sky:cloudPasses'] = 5;
  }

  private begin(): void {
    if (this.timing) this.mark = performance.now();
  }

  private end(world: World, key: string): void {
    if (!this.timing) return;
    this.gl ??= world.renderer.getContext() as WebGL2RenderingContext;
    this.gl.finish();
    const dt = performance.now() - this.mark;
    const prev = world.stats[key] ?? dt;
    world.stats[key] = prev + (dt - prev) * 0.1;
  }

  dispose(): void {
    this.field.dispose();
    this.shadow.dispose();
    this.shadowRaw.dispose();
    this.shadowPrev.dispose();
    this.raw.dispose();
    this.history[0].dispose();
    this.history[1].dispose();
    this.shadowPass.dispose();
    this.shadowResolvePass.dispose();
    this.shadowCopyPass.dispose();
    this.marchPass.dispose();
    this.resolvePass.dispose();
    this.fallback.dispose();
  }
}

function makeCloudTarget(w: number, h: number, name: string): THREE.WebGLRenderTarget {
  const rt = new THREE.WebGLRenderTarget(w, h, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    colorSpace: THREE.NoColorSpace,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });
  rt.texture.name = name;
  return rt;
}
