import * as THREE from 'three';
import type { Environment } from '../types';
import { clamp01, smoothstep } from '../util/math';
import { AtmosphereCpu } from './AtmosphereCpu';
import {
  AIRGLOW,
  CLOUD_LOW_BOTTOM_M,
  CLOUD_LOW_TOP_M,
  CLOUD_MULTISCATTER_GAIN,
  EARTHSHINE_FRACTION,
  GROUND_RADIUS_KM,
  M_TO_KM,
  MIE_ABSORPTION,
  MIE_ANISOTROPY,
  MIE_SCALE_HEIGHT_KM,
  MIE_SCATTERING,
  MILKY_WAY_RADIANCE,
  MOON_IRRADIANCE_FULL,
  RADIANCE_SCALE,
  RAYLEIGH_SCALE_HEIGHT_KM,
  RAYLEIGH_SCATTERING,
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

/** Cloud-deck optics, supplied by `CloudField`. All 0..1. */
export interface CloudOptics {
  /** Mean sun transmittance through the deck — the shadow map's spatial mean. */
  beamTransmittance: number;
  /** Fraction of the above-deck irradiance that arrives below as diffuse. */
  diffuseTransmittance: number;
  /** How much of the sky hemisphere the deck actually hides. */
  skyOcclusion: number;
}

/**
 * Everything the rest of the game needs to know about the sky as NUMBERS: the
 * sun's colour and strength, the ambient and fog colours, how visible the stars
 * are. It is a CPU mirror of the GPU atmosphere rather than a readback, because
 * a readback either stalls the pipeline or lands two frames late — and a
 * directional light that disagrees with the sky behind it is instantly obvious.
 *
 * UNITS. This class is the single place `RADIANCE_SCALE` is applied and the
 * only boundary between model units and game units — the full contract is
 * documented next to `RADIANCE_SCALE` in `constants.ts`, and it is worth
 * reading before touching anything here. In short: every field below is in
 * game units, irradiance fields (`sunIrradiance`, `sunIntensity`,
 * `moonIntensity`) owe the caller a 1/PI, radiance fields (`skyColor`,
 * `groundColor`, `zenithColor`, `horizonColor`, `fogColor`, `sh`) do not.
 *
 * Nothing here is allowed a per-time-of-day correction. A scene that exposes
 * badly is a modelling bug, not a missing multiplier.
 */
export class Radiometry {
  readonly cpu = new AtmosphereCpu();

  /** Aerosol column multiplier, quantised so the LUT bakes are rare. */
  mieMul = 1;

  /**
   * Top-of-atmosphere solar irradiance in GAME units. The GPU LUT passes take
   * this as their `uSunIrradiance`, which is what puts the rendered sky on the
   * same scale as everything published here — do not reconstruct it from
   * SOLAR_IRRADIANCE * RADIANCE_SCALE at the call site.
   */
  readonly solarIrradiance = new THREE.Vector3()
    .copy(SOLAR_IRRADIANCE)
    .multiplyScalar(RADIANCE_SCALE);

  /** Direct sun irradiance on a surface facing it, game units. Cloud-attenuated. */
  readonly sunIrradiance = new THREE.Vector3();
  /**
   * The same before the cloud deck takes its cut. The rendered sun DISC must use
   * this: the volumetric clouds are drawn in front of it and do the occluding
   * themselves, so dimming the disc by the deck's spatial mean as well would
   * make the sun read wrong every time it shows through a gap.
   */
  readonly sunIrradianceClear = new THREE.Vector3();
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
  /** The sweep's raw, cloud-free result; `sh` is derived from it every frame. */
  private shClear = new Float32Array(27);
  private shCursor = 0;

  /* --- cloud coupling ------------------------------------------------- *
   * The volumetric deck is rendered on the GPU, but the numbers the rest of
   * the game reads have to agree with it, so the same optics are mirrored
   * here. `Clouds`/`CloudField` supplies the three scalars; everything else
   * below is derived, and the derivation is the *only* place cloud cover is
   * allowed to touch a published quantity.
   * ------------------------------------------------------------------- */

  /** Direction the clouds are lit from — the sun, or the moon after dark. */
  readonly cloudLightDir = new THREE.Vector3(0, 1, 0);
  /** Irradiance at deck altitude from that light, game units. */
  readonly cloudLightIrradiance = new THREE.Vector3();
  /** Isotropic ambient radiance a cloud top / base sees, gain already applied. */
  readonly cloudAmbientTop = new THREE.Vector3();
  readonly cloudAmbientBottom = new THREE.Vector3();

  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  private tmp3 = new THREE.Vector3();
  private radiance = new THREE.Vector3();
  private overcast = new THREE.Vector3();
  private skyIrradiance = new THREE.Vector3();
  private skyIrradianceAccum = new THREE.Vector3();

  init(): void {
    this.cpu.bake(this.mieMul);
  }

  /**
   * @param camAltKm  observer altitude, kilometres.
   * @param cloud     deck optics from `CloudField`. Omit for a cloud-free sky.
   */
  update(env: Environment, camAltKm: number, cloud?: CloudOptics): void {
    // DEADBAND, not plain quantisation. Baking the transmittance table is 2048
    // texels x a 24-step march — several milliseconds of JS — and both this and
    // the GPU LUT chain rebake whenever `mieMul` moves. The weather sim drifts
    // turbidity and visibility continuously, so a quantised value parked on a
    // step boundary flipped back and forth every single frame and re-baked every
    // single frame. Requiring a 4% change first makes the bake a
    // per-weather-event cost; 4% of aerosol column is invisible in the result.
    const target = aerosolMultiplier(env);
    if (Math.abs(target - this.mieMul) > 0.04 * Math.max(0.5, this.mieMul)) {
      this.mieMul = quantise(target, 0.02);
    }
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
        this.tmp.x * this.solarIrradiance.x,
        this.tmp.y * this.solarIrradiance.y,
        this.tmp.z * this.solarIrradiance.z,
      )
      .multiplyScalar(sunGate);

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
    const discScale = moonGate / Math.PI;
    this.moonDiscRadiance.set(
      this.tmp2.x * this.solarIrradiance.x * discScale,
      this.tmp2.y * this.solarIrradiance.y * discScale,
      this.tmp2.z * this.solarIrradiance.z * discScale,
    );
    // Earthshine is brightest at new moon, when the earth is full as seen from
    // the moon. The illuminated fraction is the standard half-angle relation.
    const illum = 0.5 * (1 - Math.cos(env.moonPhase * Math.PI * 2));
    this.moonEarthshine
      .copy(this.moonDiscRadiance)
      .multiplyScalar(EARTHSHINE_FRACTION * (1 - illum) * (1 - 0.6 * env.cloudCover));

    /* --- cloud deck: the direct beam -------------------------------- *
     * The clouds themselves are lit by the UNATTENUATED beam — they are what
     * is doing the attenuating. Everything below the deck sees the attenuated
     * one. Keeping both is what lets a sunlit cloud top stay brilliant over a
     * sea that has gone dark, which is the whole look of a squall.
     * --------------------------------------------------------------- */

    this.sunIrradianceClear.copy(this.sunIrradiance);

    // Irradiance at deck altitude, from whichever luminary is actually lighting
    // it. A hard switch is invisible: the moon only wins once the sun has set,
    // by which point the sun's contribution is four orders of magnitude down.
    const rDeck = GROUND_RADIUS_KM + (CLOUD_LOW_BOTTOM_M + CLOUD_LOW_TOP_M) * 0.5 * M_TO_KM;
    if (this.sunIntensity >= this.moonIntensity) {
      this.cloudLightDir.copy(env.sunDirection);
      this.cpu.transmittance(rDeck, Math.max(sunY, 0.0016), this.tmp3);
      this.cloudLightIrradiance.set(
        this.tmp3.x * this.solarIrradiance.x,
        this.tmp3.y * this.solarIrradiance.y,
        this.tmp3.z * this.solarIrradiance.z,
      ).multiplyScalar(sunGate);
    } else {
      this.cloudLightDir.copy(env.moonDirection);
      this.cloudLightIrradiance.copy(this.moonGlow);
    }

    const beamT = cloud ? cloud.beamTransmittance : 1;
    if (beamT < 1) {
      this.sunIrradiance.multiplyScalar(beamT);
      this.sunIntensity *= beamT;
      this.sunLuminance = luminance(this.sunIrradiance);
      this.moonIntensity *= beamT;
    }

    /* --- sky, ground, fog ------------------------------------------- */

    // Both luminaries are placed in the CPU model's own frame, sun at
    // (sunH, sunY, 0) and moon at (moonH, moonY, 0). The azimuth between them
    // is dropped; every quantity below is either straight up or an azimuthal
    // average, so it cannot survive into the answer.
    const sunH = Math.sqrt(Math.max(0, 1 - sunY * sunY));
    const moonH = Math.sqrt(Math.max(0, 1 - moonY * moonY));

    this.skyRadiance(1, sunY, moonY, camAltKm, sunY, this.radiance);
    this.zenithColor.setRGB(this.radiance.x, this.radiance.y, this.radiance.z);
    this.zenithLuminance = luminance(this.radiance);

    // Horizon: average four azimuths so a low sun does not swing the fog colour
    // hard toward whichever way the ship happens to be pointing.
    const horizY = 0.026;
    const horizH = Math.sqrt(1 - horizY * horizY);
    let hr = 0;
    let hg = 0;
    let hb = 0;
    for (let i = 0; i < 4; i++) {
      const az = (i / 4) * Math.PI * 2;
      const c = Math.cos(az) * horizH;
      this.skyRadiance(horizY, c * sunH + horizY * sunY, c * moonH + horizY * moonY, camAltKm, sunY, this.radiance);
      hr += this.radiance.x;
      hg += this.radiance.y;
      hb += this.radiance.z;
    }
    this.horizonColor.setRGB(hr / 4, hg / 4, hb / 4);

    this.accumulateSh(camAltKm, sunY, moonY);

    // Fog inscatter is the horizon sky. It needed a hand-tuned airglow and
    // moonlight floor when the horizon radiance was in the wrong units and went
    // to zero at night; now that skyRadiance() carries both terms analytically,
    // the horizon colour IS the fog colour and there is nothing left to trim.
    this.fogColor.copy(this.horizonColor);

    this.skyColor.setRGB(
      this.skyIrradiance.x / Math.PI,
      this.skyIrradiance.y / Math.PI,
      this.skyIrradiance.z / Math.PI,
    );

    /* --- cloud deck: the diffuse half ------------------------------- *
     * A cloud replaces the sky it hides. The blend below is the whole reason
     * `storm` reads as an overcast gale rather than as a dark blue sky: what
     * the deck sends down is a bright, near-neutral, almost isotropic field
     * about a stop under the clear sky, and it is what every material's ambient
     * term, the fog colour and the SH now see.
     * --------------------------------------------------------------- */

    // Cloud tops see the clear sky above them; bases see the sea plus the
    // horizon ring under the deck. Both arrive as isotropic radiance with the
    // multiple-scattering gain already applied — see CLOUD_MULTISCATTER_GAIN.
    const ambGain = 0.25 * CLOUD_MULTISCATTER_GAIN;
    this.cloudAmbientTop.set(this.skyColor.r, this.skyColor.g, this.skyColor.b).multiplyScalar(ambGain);
    this.cloudAmbientBottom
      .set(
        this.horizonColor.r * 0.25,
        this.horizonColor.g * 0.25,
        this.horizonColor.b * 0.25,
      )
      .multiplyScalar(ambGain);

    if (cloud && cloud.skyOcclusion > 0.001) {
      // Horizontal irradiance on top of the deck, then Lambert's law backwards:
      // E_below = PI * L_base and E_below = E_above * T_diffuse.
      const eAbove = this.tmp
        .copy(this.skyIrradiance)
        .addScaledVector(this.sunIrradianceClear, Math.max(0, sunY));
      this.overcast.copy(eAbove).multiplyScalar(cloud.diffuseTransmittance / Math.PI);
      // Transmitted cloud light is close to neutral: droplets scatter almost
      // achromatically, so whatever hue the beam had is largely washed out.
      const grey = luminance(this.overcast);
      this.overcast.lerp(this.tmp2.setScalar(grey), 0.7);

      const k = cloud.skyOcclusion;
      lerpColor(this.zenithColor, this.overcast, k);
      lerpColor(this.horizonColor, this.overcast, k);
      lerpColor(this.skyColor, this.overcast, k);
      this.fogColor.copy(this.horizonColor);
      this.zenithLuminance = colorLuminance(this.zenithColor);
      this.skyIrradiance.set(
        this.skyColor.r * Math.PI,
        this.skyColor.g * Math.PI,
        this.skyColor.b * Math.PI,
      );
    }

    this.skyLuminance = colorLuminance(this.skyColor);
    this.applyCloudSh(cloud);

    // Sea bounce: the sky and sun that the water reflects and scatters back up.
    const downwelling = this.tmp
      .set(this.skyColor.r, this.skyColor.g, this.skyColor.b)
      .multiplyScalar(Math.PI)
      .addScaledVector(this.sunIrradiance, Math.max(0, sunY));
    this.groundColor.setRGB(
      (downwelling.x * SEA_BOUNCE_ALBEDO.x) / Math.PI,
      (downwelling.y * SEA_BOUNCE_ALBEDO.y) / Math.PI,
      (downwelling.z * SEA_BOUNCE_ALBEDO.z) / Math.PI,
    );
    this.cloudAmbientBottom.x += this.groundColor.r * ambGain;
    this.cloudAmbientBottom.y += this.groundColor.g * ambGain;
    this.cloudAmbientBottom.z += this.groundColor.b * ambGain;

    /* --- stars ------------------------------------------------------ */

    this.starVisibility =
      (1 / (1 + this.zenithLuminance / STAR_WASHOUT)) * (1 - clamp01(env.cloudCover * 0.92));
    this.starBrightness = STAR_RADIANCE * this.starVisibility;
    this.milkyWayBrightness = MILKY_WAY_RADIANCE * this.starVisibility;
  }

  /** See the note on SH_UNIFORM. Runs every frame; the sweep does not. */
  private applyCloudSh(cloud?: CloudOptics): void {
    const k = cloud ? cloud.skyOcclusion : 0;
    if (k <= 0.001) {
      this.sh.set(this.shClear);
      return;
    }
    this.sh[0] = this.shClear[0] + (this.overcast.x * SH_UNIFORM - this.shClear[0]) * k;
    this.sh[1] = this.shClear[1] + (this.overcast.y * SH_UNIFORM - this.shClear[1]) * k;
    this.sh[2] = this.shClear[2] + (this.overcast.z * SH_UNIFORM - this.shClear[2]) * k;
    const damp = 1 - 0.72 * k;
    for (let i = 3; i < 27; i++) this.sh[i] = this.shClear[i] * damp;
  }

  /** Sun disc radiance, written into `out`. */
  sunDiscRadiance(out: THREE.Vector3): THREE.Vector3 {
    return out
      .copy(this.sunIrradianceClear)
      .multiplyScalar(SUN_DISC_RADIANCE_SCALE / SUN_SOLID_ANGLE);
  }

  /**
   * Sky radiance in GAME units, along a direction whose vertical component is
   * `dirY` and whose angles to the sun and moon have cosines `cosSun`/`cosMoon`.
   *
   * The one and only bridge out of the atmosphere model's own units:
   * `AtmosphereCpu` deliberately knows nothing about RADIANCE_SCALE so that it
   * stays a line-for-line mirror of the GPU shader, which is scaled instead by
   * the `uSunIrradiance` it is handed.
   *
   * It also adds the two terms the multiple-scattering model has no sun to
   * drive — airglow and the moon's own sky glow — with exactly the expressions
   * `shaders/skyRender.ts` uses. Without them the CPU sky is mathematically
   * black after astronomical twilight while the rendered sky plainly is not,
   * `uSkyColor` goes to zero, and every custom material loses its night fill.
   */
  private skyRadiance(
    dirY: number,
    cosSun: number,
    cosMoon: number,
    camAltKm: number,
    sunMu: number,
    out: THREE.Vector3,
  ): THREE.Vector3 {
    this.cpu.radiance(dirY, cosSun, camAltKm, sunMu, this.mieMul, out);
    out.multiplyScalar(RADIANCE_SCALE);

    const airmass = Math.min(1 / Math.max(dirY, 0.015), 22);
    const glow = Math.min(airmass, 6);
    out.x += AIRGLOW.x * glow;
    out.y += AIRGLOW.y * glow;
    out.z += AIRGLOW.z * glow;

    if (this.moonIntensity > 1e-7) {
      addWeakSourceSkyGlow(out, this.moonGlow, cosMoon, airmass, this.mieMul);
    }
    return out;
  }

  /**
   * One slice of the spherical-harmonic sweep. Spreading 48 directions over 4
   * frames keeps the cost at ~300 march steps a frame; the sun moves far too
   * slowly for the 67 ms of latency to be visible.
   */
  private accumulateSh(camAltKm: number, sunY: number, moonY: number): void {
    const sunH = Math.sqrt(Math.max(0, 1 - sunY * sunY));
    const moonH = Math.sqrt(Math.max(0, 1 - moonY * moonY));
    const w = (4 * Math.PI) / SH_SAMPLES;

    for (let s = 0; s < SH_PER_FRAME; s++) {
      const i = this.shCursor;
      const y = 1 - ((i + 0.5) / SH_SAMPLES) * 2;
      const ring = Math.sqrt(Math.max(0, 1 - y * y));
      const theta = GOLDEN_ANGLE * i;
      const x = Math.cos(theta) * ring;
      const z = Math.sin(theta) * ring;

      // cosTheta against a sun placed at (sunH, sunY, 0) — the CPU model's frame.
      this.skyRadiance(y, x * sunH + y * sunY, x * moonH + y * moonY, camAltKm, sunY, this.radiance);

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
          this.shClear[k * 3 + 0] = a[k * 3 + 0] * c;
          this.shClear[k * 3 + 1] = a[k * 3 + 1] * c;
          this.shClear[k * 3 + 2] = a[k * 3 + 2] * c;
        }
        a.fill(0);
        this.skyIrradiance.copy(this.skyIrradianceAccum);
        this.skyIrradianceAccum.set(0, 0, 0);
      }
    }
  }
}

/**
 * Fold the cloud deck into the published SH.
 *
 * The sweep in `accumulateSh` marches the CLOUD-FREE medium, because that is
 * what `AtmosphereCpu` models. Overcast does two things to that field: it
 * changes its magnitude, and it very nearly removes its directionality. Band 0
 * is blended to the deck's own radiance — a uniform radiance L projects to
 * L * 0.282095 * 4PI, which after the cosine convolution evaluates back to
 * exactly L — and bands 1-8 are damped rather than zeroed, since even a solid
 * deck is brighter overhead than it is toward the sea.
 */
const SH_UNIFORM = 4 * Math.PI * 0.282095;

/** A_l / PI for l = 0, 1, 2 with A = (PI, 2PI/3, PI/4). */
const SH_COSINE_CONVOLUTION = [1, 2 / 3, 2 / 3, 2 / 3, 0.25, 0.25, 0.25, 0.25, 0.25];
const SH_BASIS_SCRATCH = new Float64Array(9);

/** Rayleigh column density above sea level, dimensionless (1/km x km). */
const COLUMN_R = new THREE.Vector3()
  .copy(RAYLEIGH_SCATTERING)
  .multiplyScalar(RAYLEIGH_SCALE_HEIGHT_KM);
const MIE_PHASE_K = ((3 / (8 * Math.PI)) * (1 - MIE_ANISOTROPY ** 2)) / (2 + MIE_ANISOTROPY ** 2);

/**
 * Single-scattered sky glow from a weak source, added into `out`. The exact
 * CPU twin of `weakSourceSkyGlow` in `shaders/celestial.ts`: a plane-parallel
 * slab of the whole atmospheric column, self-shadowed by its own optical depth.
 * Cheap enough to evaluate per SH sample, and being the same expression as the
 * shader is the point — it is what keeps the night ambient equal to the night
 * sky the camera sees.
 */
function addWeakSourceSkyGlow(
  out: THREE.Vector3,
  irradiance: THREE.Vector3,
  cosTheta: number,
  airmass: number,
  mieMul: number,
): void {
  const colM = MIE_SCATTERING * MIE_SCALE_HEIGHT_KM * mieMul;
  const extM = (MIE_SCATTERING + MIE_ABSORPTION) * MIE_SCALE_HEIGHT_KM * mieMul;
  const cos2 = 1 + cosTheta * cosTheta;
  const pR = (3 / (16 * Math.PI)) * cos2;
  const g2 = MIE_ANISOTROPY ** 2;
  const d = Math.max(1e-4, 1 + g2 - 2 * MIE_ANISOTROPY * cosTheta);
  const pM = (MIE_PHASE_K * cos2) / (d * Math.sqrt(d));

  const sR = colM * pM * airmass;
  const gx = (COLUMN_R.x * pR * airmass + sR) * slabAttenuation((COLUMN_R.x + extM) * airmass);
  const gy = (COLUMN_R.y * pR * airmass + sR) * slabAttenuation((COLUMN_R.y + extM) * airmass);
  const gz = (COLUMN_R.z * pR * airmass + sR) * slabAttenuation((COLUMN_R.z + extM) * airmass);
  out.x += irradiance.x * gx;
  out.y += irradiance.y * gy;
  out.z += irradiance.z * gz;
}

/** (1 - e^-tau) / tau — the mean transmittance across an emitting slab. */
function slabAttenuation(tau: number): number {
  return (1 - Math.exp(-tau)) / Math.max(tau, 1e-4);
}

function luminance(v: THREE.Vector3): number {
  return 0.2126 * v.x + 0.7152 * v.y + 0.0722 * v.z;
}

function colorLuminance(c: THREE.Color): number {
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

/** In-place lerp of a Color toward a Vector3 radiance. */
function lerpColor(c: THREE.Color, to: THREE.Vector3, k: number): void {
  c.r += (to.x - c.r) * k;
  c.g += (to.y - c.g) * k;
  c.b += (to.z - c.b) * k;
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
