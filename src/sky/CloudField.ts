import * as THREE from 'three';
import type { Environment } from '../types';
import { clamp01 } from '../util/math';
import {
  CLOUD_BASE_NOISE_SIZE,
  CLOUD_BASE_TILE_M,
  CLOUD_COLUMNS_PER_RAY,
  CLOUD_DETAIL_NOISE_SIZE,
  CLOUD_DETAIL_TILE_M,
  CLOUD_LOW_BOTTOM_M,
  CLOUD_LOW_TOP_M,
  CLOUD_WEATHER_EXTENT_M,
  CLOUD_WEATHER_SIZE,
  CLOUD_WIND_GAIN,
} from './constants';
import { SkyPass } from './Pass';
import { CLOUD_BASE_FRAG, CLOUD_DETAIL_FRAG, CLOUD_WEATHER_FRAG } from './shaders/cloudNoise';
import type { SkyUniforms } from './SkyRender';

/** Vertical wind shear across the deck, metres of horizontal offset at the top. */
const SHEAR_M = 950;

/**
 * The cloud density field: three baked textures plus the handful of uniforms
 * that turn `env.cloudCover` / `env.cloudType` into a shape.
 *
 * Everything is procedural and baked once. The base volume is 128^3 of
 * Perlin-Worley plus three octaves of inverted Worley, which is ~200 hash
 * evaluations per texel over 2 M texels — a real cost, but it is paid once at
 * init and it is the difference between clouds that have internal structure and
 * clouds that are an alpha wash.
 *
 * The volumes are TILEABLE (see `tileGrad3` / the `mod` in `worley3`), so the
 * field is infinite by construction and the only thing that stops it looking
 * periodic is that the weather map wraps at 48 km while the base wraps at 6 km
 * and the detail at 750 m — three incommensurate scales beating against each
 * other, plus a vertical shear that rotates the deck's apparent pattern with
 * altitude.
 */
export class CloudField {
  readonly base: THREE.WebGL3DRenderTarget;
  readonly detail: THREE.WebGL3DRenderTarget;
  readonly weather: THREE.WebGLRenderTarget;

  /** Accumulated wind scroll, metres, wrapped to the weather extent. */
  private scroll = new THREE.Vector2();
  private detailScroll = new THREE.Vector2();
  private cirrusScroll = new THREE.Vector2();
  private windDir = new THREE.Vector2(1, 0);

  /** Mean sun transmittance through the deck — the CPU mirror of the shadow map. */
  beamTransmittance = 1;
  /** Fraction of the above-deck irradiance that reaches the sea as diffuse. */
  diffuseTransmittance = 1;
  /** How much of the sky the deck actually covers, for the ambient blend. */
  skyOcclusion = 0;

  constructor(private readonly uniforms: SkyUniforms) {
    this.base = make3D(CLOUD_BASE_NOISE_SIZE);
    this.detail = make3D(CLOUD_DETAIL_NOISE_SIZE);
    this.weather = new THREE.WebGLRenderTarget(CLOUD_WEATHER_SIZE, CLOUD_WEATHER_SIZE, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.NoColorSpace,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });

    uniforms.tCloudBase.value = this.base.texture;
    uniforms.tCloudDetail.value = this.detail.texture;
    uniforms.tWeather.value = this.weather.texture;
    uniforms.uWeatherExtent.value = CLOUD_WEATHER_EXTENT_M;
    uniforms.uBaseScale.value = 1 / CLOUD_BASE_TILE_M;
    uniforms.uDetailScale.value = 1 / CLOUD_DETAIL_TILE_M;
    uniforms.uLayerBottom.value = CLOUD_LOW_BOTTOM_M;
    uniforms.uLayerTop.value = CLOUD_LOW_TOP_M;
  }

  /** Bake all three textures. Synchronous, ~one-off. */
  bake(renderer: THREE.WebGLRenderer): void {
    const basePass = new SkyPass(CLOUD_BASE_FRAG, {
      uSlice: { value: 0 },
      uSize: { value: CLOUD_BASE_NOISE_SIZE },
    });
    for (let z = 0; z < CLOUD_BASE_NOISE_SIZE; z++) {
      basePass.uniforms.uSlice.value = z;
      basePass.render(renderer, this.base as unknown as THREE.WebGLRenderTarget, z);
    }
    basePass.dispose();

    const detailPass = new SkyPass(CLOUD_DETAIL_FRAG, {
      uSlice: { value: 0 },
      uSize: { value: CLOUD_DETAIL_NOISE_SIZE },
    });
    for (let z = 0; z < CLOUD_DETAIL_NOISE_SIZE; z++) {
      detailPass.uniforms.uSlice.value = z;
      detailPass.render(renderer, this.detail as unknown as THREE.WebGLRenderTarget, z);
    }
    detailPass.dispose();

    const weatherPass = new SkyPass(CLOUD_WEATHER_FRAG, {});
    weatherPass.render(renderer, this.weather);
    weatherPass.dispose();
  }

  /**
   * Advect the field and translate the weather director's two knobs into the
   * shape uniforms. `originXZ` is the floating-origin offset, so the deck stays
   * put in absolute coordinates while the ship sails under it.
   */
  update(env: Environment, originXZ: THREE.Vector3, dt: number): void {
    const u = this.uniforms;
    const cover = clamp01(env.cloudCover);
    const type = clamp01(env.cloudType);
    const rain = clamp01(env.rain);

    this.windDir.set(env.windVector.x, env.windVector.z);
    if (this.windDir.lengthSq() < 1e-6) this.windDir.set(1, 0);
    else this.windDir.normalize();

    // Sampling coordinates move AGAINST the wind so the pattern advects with it.
    const speed = env.windSpeed * CLOUD_WIND_GAIN;
    this.scroll.x = wrap(this.scroll.x - this.windDir.x * speed * dt, CLOUD_WEATHER_EXTENT_M);
    this.scroll.y = wrap(this.scroll.y - this.windDir.y * speed * dt, CLOUD_WEATHER_EXTENT_M);
    // The detail layer creeps relative to the base, which is what makes a
    // cumulus boil rather than slide across the sky as a rigid stamp.
    this.detailScroll.x = wrap(this.detailScroll.x - this.windDir.y * speed * 0.22 * dt, CLOUD_DETAIL_TILE_M);
    this.detailScroll.y = wrap(this.detailScroll.y + this.windDir.x * speed * 0.22 * dt, CLOUD_DETAIL_TILE_M);
    // Cirrus rides a much faster upper-level jet.
    this.cirrusScroll.x = wrap(this.cirrusScroll.x - this.windDir.x * speed * 1.9 * dt, CLOUD_WEATHER_EXTENT_M);
    this.cirrusScroll.y = wrap(this.cirrusScroll.y - this.windDir.y * speed * 1.9 * dt, CLOUD_WEATHER_EXTENT_M);

    (u.uFieldOffset.value as THREE.Vector2).set(
      originXZ.x + this.scroll.x,
      originXZ.z + this.scroll.y,
    );
    (u.uDetailOffset.value as THREE.Vector2).copy(this.detailScroll);
    (u.uCirrusOffset.value as THREE.Vector2).copy(this.cirrusScroll);
    (u.uWindDir.value as THREE.Vector2).copy(this.windDir);

    u.uCoverage.value = cover;
    u.uCloudType.value = type;
    u.uShear.value = SHEAR_M * (0.5 + 0.5 * type);
    // Erosion has to fall away as the deck thickens: shredding the edges of a
    // solid nimbostratus is what makes rain clouds look like dirty cotton wool.
    u.uErosion.value = 0.42 * (1 - 0.55 * clamp01(cover * 1.1 - 0.25)) * (1 - 0.4 * rain);
    // A raining deck is optically much deeper than fair-weather cumulus.
    u.uDensityScale.value = (0.72 + 0.5 * type) * (1 + 1.35 * rain);

    // Cirrus is not the same phenomenon as the low deck and does not follow its
    // cover: high cloud is common on an otherwise clear day and is hidden, not
    // removed, once the low deck closes over. This is now the FRACTION OF SKY the
    // cirrus band covers, and it is deliberately modest — the value that reads as
    // "a few high streaks" is a quarter of the sky, not half of it.
    u.uCirrusAmount.value = (0.1 + 0.48 * cover) * (1 - 0.8 * clamp01(cover * 1.3 - 0.45));

    // Deck slab optical depth along the vertical, for the CPU radiometry mirror.
    const tauVertical =
      (CLOUD_LOW_TOP_M - CLOUD_LOW_BOTTOM_M) * 0.45 * 0.045 * (u.uDensityScale.value as number);
    const sunY = Math.max(env.sunDirection.y, 0.04);
    const slant = 1 / sunY;
    // Chance the beam intercepts the deck at all. A low sun sees far more of it,
    // which is exactly why the last hour before an overcast sunset goes flat.
    //
    // The base of the power is the PER-COLUMN coverage the GPU field actually
    // builds, not the knob. `coverageAt` inverts the slant multiplicity now (see
    // CLOUD_COLUMNS_PER_RAY), so raising the knob here as if it were a column
    // probability would charge the sun for a deck four times denser than the one
    // on screen — the exact "deck you see versus deck every material is lit by"
    // divergence that shader's floor comment was written about.
    const column = 1 - Math.pow(1 - cover, 1 / CLOUD_COLUMNS_PER_RAY);
    const hit = clamp01(1 - Math.pow(1 - column, 0.45 + 0.5 * slant));
    this.beamTransmittance = Math.max(
      0.035,
      1 - hit + hit * Math.exp(-Math.min(tauVertical * slant, 60)),
    );
    // A thick water cloud reflects ~0.7 and absorbs little, so most of what it
    // does not send back up arrives below as diffuse.
    this.diffuseTransmittance = clamp01(
      Math.max(0.12, 0.62 * Math.exp(-tauVertical * 0.055)) * (1 - 0.25 * rain),
    );
    this.skyOcclusion = clamp01(Math.pow(cover, 0.72) * 0.97);
  }

  dispose(): void {
    this.base.dispose();
    this.detail.dispose();
    this.weather.dispose();
  }
}

function wrap(v: number, period: number): number {
  const m = v % period;
  return m < 0 ? m + period : m;
}

/** Tiling RGBA8 volume — what both cloud noise textures want. */
function make3D(size: number): THREE.WebGL3DRenderTarget {
  const rt = new THREE.WebGL3DRenderTarget(size, size, size, {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    colorSpace: THREE.NoColorSpace,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.RepeatWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });
  rt.texture.wrapR = THREE.RepeatWrapping;
  return rt;
}
