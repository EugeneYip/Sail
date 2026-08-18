import * as THREE from 'three';
import type { Environment } from '../types';
import { clamp01, smoothstep } from '../util/math';
import { AtmosphereCpu } from './AtmosphereCpu';
import {
  AIRGLOW,
  EARTHSHINE_FRACTION,
  GROUND_RADIUS_KM,
  MILKY_WAY_RADIANCE,
  MOON_IRRADIANCE_FULL,
  RADIANCE_SCALE,
  SEA_BOUNCE_ALBEDO,
  SOLAR_IRRADIANCE,
  STAR_RADIANCE,
  STAR_WASHOUT,
  SUN_DISC_RADIANCE_SCALE,
  SUN_SOLID_ANGLE,
} from './constants';

/** Directions the hemispheric irradiance sweep visits, one Fibonacci sphere. */
const SH_SAMPLES = 48;
const SH_PER_FRAME = 12;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/**
 * Everything the rest of the game needs to know about the sky as NUMBERS: the
 * sun's colour and strength, the ambient and fog colours, how visible the stars
 * are. It is a CPU mirror of the GPU atmosphere rather than a readback, because
 * a readback either stalls the pipeline or lands two frames late — and a
 * directional light that disagrees with the sky behind it is instantly obvious.
 *
 * Units: everything published here is scene-linear radiance or irradiance with
 * RADIANCE_SCALE already applied, i.e. directly usable by materials.
 */
export class Radiometry {
  readonly cpu = new AtmosphereCpu();

  /** Aerosol column multiplier, quantised so the LUT bakes are rare. */
  mieMul = 1;

  /** Direct sun irradiance on a surface facing it, game units. */
  readonly sunIrradiance = new THREE.Vector3();
  readonly sunColor = new THREE.Color(1, 1, 1);
  sunIntensity = 0;

  readonly moonColor = new THREE.Color(0.55, 0.68, 0.95);
  moonIntensity = 0;
  /** Top-of-atmosphere moon irradiance, for the analytic moon sky glow. */
  readonly moonGlow = new THREE.Vector3();
  readonly moonDiscRadiance = new THREE.Vector3();
  readonly moonEarthshine = new THREE.Vector3();

  /** Mean sky radiance over the upper hemisphere: E_sky / PI. */
  readonly skyColor = new THREE.Color();
  /** Radiance bounced back up off the sea. */
  readonly groundColor = new THREE.Color();
  readonly zenithColor = new THREE.Color();
  readonly horizonColor = new THREE.Color();
  readonly fogColor = new THREE.Color();

  starVisibility = 0;
  starBrightness = 0;
  milkyWayBrightness = 0;
  /** Sky luminance at the zenith, game units — drives star washout and the HUD. */
  zenithLuminance = 0;
  skyLuminance = 0;
  sunLuminance = 0;

  /**
   * Ambient irradiance as 9 RGB spherical-harmonic coefficients, in the
   * Ramamoorthi basis and already convolved with the clamped-cosine lobe and
   * divided by PI. Evaluating the basis against a surface normal therefore
   * yields the OUTGOING RADIANCE of a white Lambertian surface — multiply by
   * albedo and you are done.
   */
  readonly sh = new Float32Array(27);
  private shAccum = new Float32Array(27);
  private shCursor = 0;

  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  private radiance = new THREE.Vector3();
  private skyIrradiance = new THREE.Vector3();
  private skyIrradianceAccum = new THREE.Vector3();

  init(): void {
    this.cpu.bake(this.mieMul);
  }

  /**
   * @param camAltKm  observer altitude, kilometres.
   */
  update(env: Environment, camAltKm: number): void {
    this.mieMul = quantise(aerosolMultiplier(env), 0.02);
    this.cpu.bake(this.mieMul);

    const r = GROUND_RADIUS_KM + camAltKm;
    const sunY = env.sunDirection.y;
    const moonY = env.moonDirection.y;
    this.cpu.updateMultiScatter(camAltKm, sunY, this.mieMul);

    /* --- direct sun ------------------------------------------------- */

    // Refraction plus the disc's own 0.53 deg means the sun keeps delivering
    // light until its centre is ~0.9 deg below the geometric horizon.
    const sunGate = smoothstep(-0.018, 0.007, sunY);
    this.cpu.transmittance(r, Math.max(sunY, 0.0016), this.tmp);
    this.sunIrradiance
      .set(
        this.tmp.x * SOLAR_IRRADIANCE.x,
        this.tmp.y * SOLAR_IRRADIANCE.y,
        this.tmp.z * SOLAR_IRRADIANCE.z,
      )
      .multiplyScalar(RADIANCE_SCALE * sunGate);

    const sunPeak = Math.max(this.sunIrradiance.x, this.sunIrradiance.y, this.sunIrradiance.z);
    this.sunIntensity = sunPeak;
    if (sunPeak > 1e-6) {
      this.sunColor.setRGB(
        this.sunIrradiance.x / sunPeak,
        this.sunIrradiance.y / sunPeak,
        this.sunIrradiance.z / sunPeak,
      );
    }
    this.sunLuminance = luminance(this.sunIrradiance);

    /* --- moon ------------------------------------------------------- */

    this.cpu.transmittance(r, Math.max(moonY, 0.0016), this.tmp2);
    const moonGate = smoothstep(-0.02, 0.01, moonY);
    const moonScalar = MOON_IRRADIANCE_FULL * RADIANCE_SCALE * env.moonIntensity * moonGate;
    this.moonGlow.set(
      this.tmp2.x * moonScalar,
      this.tmp2.y * moonScalar,
      this.tmp2.z * moonScalar,
    );

    // Purkinje: at scotopic levels the eye's peak sensitivity shifts 50 nm blue
    // and rods carry no colour, so moonlight reads cold even though the regolith
    // is warm grey. Film and every night scene ever shot agree; go with it.
    const moonPeak = Math.max(this.moonGlow.x, this.moonGlow.y, this.moonGlow.z);
    this.moonIntensity = moonPeak;
    this.moonColor.setRGB(0.5, 0.66, 1.0);

    // The disc itself keeps its true warm-grey albedo; only the LIGHT is shifted.
    const discScale = (RADIANCE_SCALE / Math.PI) * moonGate;
    this.moonDiscRadiance.set(
      this.tmp2.x * SOLAR_IRRADIANCE.x * discScale,
      this.tmp2.y * SOLAR_IRRADIANCE.y * discScale,
      this.tmp2.z * SOLAR_IRRADIANCE.z * discScale,
    );
    // Earthshine is brightest at new moon, when the earth is full as seen from
    // the moon. The illuminated fraction is the standard half-angle relation.
    const illum = 0.5 * (1 - Math.cos(env.moonPhase * Math.PI * 2));
    this.moonEarthshine
      .copy(this.moonDiscRadiance)
      .multiplyScalar(EARTHSHINE_FRACTION * (1 - illum) * (1 - 0.6 * env.cloudCover));

    /* --- sky, ground, fog ------------------------------------------- */

    this.cpu.radiance(1, sunY, camAltKm, sunY, this.mieMul, this.radiance);
    this.zenithColor.setRGB(this.radiance.x, this.radiance.y, this.radiance.z);
    this.zenithLuminance = luminance(this.radiance);

    // Horizon: average four azimuths so a low sun does not swing the fog colour
    // hard toward whichever way the ship happens to be pointing.
    const horizY = 0.026;
    const sunH = Math.sqrt(Math.max(0, 1 - sunY * sunY));
    let hr = 0;
    let hg = 0;
    let hb = 0;
    for (let i = 0; i < 4; i++) {
      const az = (i / 4) * Math.PI * 2;
      const cosTheta = Math.cos(az) * sunH * Math.sqrt(1 - horizY * horizY) + horizY * sunY;
      this.cpu.radiance(horizY, cosTheta, camAltKm, sunY, this.mieMul, this.radiance);
      hr += this.radiance.x;
      hg += this.radiance.y;
      hb += this.radiance.z;
    }
    this.horizonColor.setRGB(hr / 4, hg / 4, hb / 4);

    this.accumulateSh(camAltKm, sunY);

    // Fog inscatter is the horizon sky, warmed slightly toward the low-sun side
    // because most of what a fogged pixel scatters comes from near the sun.
    this.fogColor.copy(this.horizonColor);
    const moonFog = this.moonGlow.length() * 0.6;
    this.fogColor.r += AIRGLOW.x * 8 + moonFog * 0.5;
    this.fogColor.g += AIRGLOW.y * 8 + moonFog * 0.66;
    this.fogColor.b += AIRGLOW.z * 8 + moonFog * 1.0;

    // Sea bounce: the sky and sun that the water reflects and scatters back up.
    const downwelling = this.tmp.copy(this.skyIrradiance);
    downwelling.x += this.sunIrradiance.x * Math.max(0, sunY);
    downwelling.y += this.sunIrradiance.y * Math.max(0, sunY);
    downwelling.z += this.sunIrradiance.z * Math.max(0, sunY);
    this.groundColor.setRGB(
      (downwelling.x * SEA_BOUNCE_ALBEDO.x) / Math.PI,
      (downwelling.y * SEA_BOUNCE_ALBEDO.y) / Math.PI,
      (downwelling.z * SEA_BOUNCE_ALBEDO.z) / Math.PI,
    );

    this.skyColor.setRGB(
      this.skyIrradiance.x / Math.PI,
      this.skyIrradiance.y / Math.PI,
      this.skyIrradiance.z / Math.PI,
    );
    this.skyLuminance = luminance(this.skyIrradiance) / Math.PI;

    /* --- stars ------------------------------------------------------ */

    this.starVisibility =
      (1 / (1 + this.zenithLuminance / STAR_WASHOUT)) * (1 - clamp01(env.cloudCover * 0.92));
    this.starBrightness = STAR_RADIANCE * this.starVisibility;
    this.milkyWayBrightness = MILKY_WAY_RADIANCE * this.starVisibility;
  }

  /** Sun disc radiance, written into `out`. */
  sunDiscRadiance(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.sunIrradiance).multiplyScalar(SUN_DISC_RADIANCE_SCALE / SUN_SOLID_ANGLE);
  }

  /**
   * One slice of the spherical-harmonic sweep. Spreading 48 directions over 4
   * frames keeps the cost at ~300 march steps a frame; the sun moves far too
   * slowly for the 67 ms of latency to be visible.
   */
  private accumulateSh(camAltKm: number, sunY: number): void {
    const sunH = Math.sqrt(Math.max(0, 1 - sunY * sunY));
    const w = (4 * Math.PI) / SH_SAMPLES;

    for (let s = 0; s < SH_PER_FRAME; s++) {
      const i = this.shCursor;
      const y = 1 - ((i + 0.5) / SH_SAMPLES) * 2;
      const ring = Math.sqrt(Math.max(0, 1 - y * y));
      const theta = GOLDEN_ANGLE * i;
      const x = Math.cos(theta) * ring;
      const z = Math.sin(theta) * ring;

      // cosTheta against a sun placed at (sunH, sunY, 0) — the CPU model's frame.
      const cosTheta = x * sunH + y * sunY;
      this.cpu.radiance(y, cosTheta, camAltKm, sunY, this.mieMul, this.radiance);

      const a = this.shAccum;
      const yb0 = 0.282095;
      const yb1 = 0.488603 * y;
      const yb2 = 0.488603 * z;
      const yb3 = 0.488603 * x;
      const yb4 = 1.092548 * x * y;
      const yb5 = 1.092548 * y * z;
      const yb6 = 0.315392 * (3 * z * z - 1);
      const yb7 = 1.092548 * x * z;
      const yb8 = 0.546274 * (x * x - y * y);
      const basis = SH_BASIS_SCRATCH;
      basis[0] = yb0;
      basis[1] = yb1;
      basis[2] = yb2;
      basis[3] = yb3;
      basis[4] = yb4;
      basis[5] = yb5;
      basis[6] = yb6;
      basis[7] = yb7;
      basis[8] = yb8;
      for (let k = 0; k < 9; k++) {
        const b = basis[k] * w;
        a[k * 3 + 0] += this.radiance.x * b;
        a[k * 3 + 1] += this.radiance.y * b;
        a[k * 3 + 2] += this.radiance.z * b;
      }
      if (y > 0) {
        this.skyIrradianceAccum.x += this.radiance.x * y * w;
        this.skyIrradianceAccum.y += this.radiance.y * y * w;
        this.skyIrradianceAccum.z += this.radiance.z * y * w;
      }

      this.shCursor++;
      if (this.shCursor >= SH_SAMPLES) {
        this.shCursor = 0;
        // Convolve with the clamped-cosine lobe and divide by PI in one step.
        const conv = SH_COSINE_CONVOLUTION;
        for (let k = 0; k < 9; k++) {
          const c = conv[k];
          this.sh[k * 3 + 0] = a[k * 3 + 0] * c;
          this.sh[k * 3 + 1] = a[k * 3 + 1] * c;
          this.sh[k * 3 + 2] = a[k * 3 + 2] * c;
        }
        a.fill(0);
        this.skyIrradiance.copy(this.skyIrradianceAccum);
        this.skyIrradianceAccum.set(0, 0, 0);
      }
    }
  }
}

/** A_l / PI for l = 0, 1, 2 with A = (PI, 2PI/3, PI/4). */
const SH_COSINE_CONVOLUTION = [1, 2 / 3, 2 / 3, 2 / 3, 0.25, 0.25, 0.25, 0.25, 0.25];
const SH_BASIS_SCRATCH = new Float64Array(9);

function luminance(v: THREE.Vector3): number {
  return 0.2126 * v.x + 0.7152 * v.y + 0.0722 * v.z;
}

function quantise(v: number, step: number): number {
  return Math.round(v / step) * step;
}

/**
 * Turbidity and visibility both mean "more aerosol". Turbidity is the clean-air
 * haze the weather director tracks; visibility folds in fog and rain, which are
 * a much denser column and have to reach the sky too or a fog bank looks like a
 * grey sheet pasted under a clear blue sky.
 */
function aerosolMultiplier(env: Environment): number {
  const fromTurbidity = 0.25 + 0.45 * Math.pow(Math.max(0, env.turbidity - 1), 1.15);
  const fromVisibility = THREE.MathUtils.clamp(11000 / Math.max(200, env.visibility) - 0.36, 0, 7);
  return THREE.MathUtils.clamp(fromTurbidity + fromVisibility, 0.2, 9);
}
