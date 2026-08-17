import * as THREE from 'three';

/**
 * Atmosphere model constants — Hillaire 2020 ("A Scalable and Production Ready
 * Sky and Atmosphere Rendering Technique") with Bruneton's LUT parameterisation.
 *
 * Lengths are KILOMETRES inside the atmosphere maths: the published scattering
 * coefficients are 1/km and the planet radius in metres wrecks float precision
 * in a froxel march. Convert at the boundary with M_TO_KM.
 */

export const M_TO_KM = 0.001;
export const KM_TO_M = 1000;

export const GROUND_RADIUS_KM = 6360.0;
export const ATMOSPHERE_TOP_KM = 6460.0;

/** Rayleigh scattering at sea level, 1/km, sRGB primaries. */
export const RAYLEIGH_SCATTERING = new THREE.Vector3(0.005802, 0.013558, 0.033100);
export const RAYLEIGH_SCALE_HEIGHT_KM = 8.0;

/** Mie for a clean maritime aerosol at sea level, 1/km. */
export const MIE_SCATTERING = 0.003996;
export const MIE_ABSORPTION = 0.004440;
export const MIE_SCALE_HEIGHT_KM = 1.2;
/** Forward-scattering anisotropy of the aerosol phase function. */
export const MIE_ANISOTROPY = 0.8;

/**
 * Ozone absorption, 1/km, distributed in a 10..40 km tent peaking at 25 km.
 * This layer is what turns dusk deep blue-violet instead of muddy brown: it
 * eats the residual yellow-green out of the long twilight path.
 */
export const OZONE_ABSORPTION = new THREE.Vector3(0.000650, 0.001881, 0.000085);
export const OZONE_CENTRE_KM = 25.0;
export const OZONE_HALF_WIDTH_KM = 15.0;

/** Ocean albedo seen by the atmosphere as its lower boundary, linear RGB. */
export const GROUND_ALBEDO = new THREE.Vector3(0.055, 0.075, 0.095);

/**
 * Top-of-atmosphere solar spectrum reduced to linear sRGB and normalised to
 * unit luminance. The sun is a 5778 K black body, so it is very slightly warm
 * relative to D65 even before the atmosphere touches it.
 */
export const SOLAR_IRRADIANCE = new THREE.Vector3(1.0, 0.9585, 0.9182);

/** Sun angular radius, radians (0.5334 deg diameter). */
export const SUN_ANGULAR_RADIUS = 0.0046543;
/** Moon mean angular radius, radians (0.5182 deg diameter). */
export const MOON_ANGULAR_RADIUS = 0.0045232;

/**
 * Atmospheric refraction at the horizon, radians (34 arcmin). The sun's disc is
 * still fully visible when its geometric centre is 0.83 deg BELOW the horizon,
 * which is exactly why sunset takes as long as it does.
 */
export const HORIZON_REFRACTION = 0.0098;

/**
 * Scene-linear radiance scale. Internally the model works in units where the
 * top-of-atmosphere solar irradiance is 1.0; the rest of the game is calibrated
 * around `uSunIntensity ~ 12` and `uSkyColor ~ 0.4` (see SharedUniforms
 * defaults), so everything the sky publishes is multiplied by this on the way
 * out. Sun light, sky radiance, fog and the env map all share it, which is what
 * keeps direct and indirect light consistent.
 */
export const RADIANCE_SCALE = 13.0;

/** Physical conversion for star visibility thresholds: 1.0 radiance -> cd/m^2. */
export const LUMINANCE_PER_UNIT = 100000 / RADIANCE_SCALE;

/**
 * Cinematic moon. A physically exact full moon delivers 2.5e-6 of the sun's
 * illuminance; rendering that honestly needs a 4000x exposure swing that would
 * destroy the star thresholds and any hope of a stable auto-exposure. This is
 * the one deliberately non-physical constant in the module.
 */
export const MOON_IRRADIANCE_FULL = 0.0026;
/** Moon albedo tint — lunar regolith is a warm grey, not blue. */
export const MOON_ALBEDO = new THREE.Vector3(0.135, 0.122, 0.108);

/* ------------------------------------------------------------------ *
 *  LUT sizes
 * ------------------------------------------------------------------ */

export const TRANSMITTANCE_W = 256;
export const TRANSMITTANCE_H = 64;
export const MULTISCATTER_SIZE = 32;
export const SKYVIEW_W = 192;
export const SKYVIEW_H = 108;
export const AERIAL_SIZE = 32;
export const AERIAL_SLICES = 32;
/** Far plane of the froxel volume, km. Published as aerialMaxDistance. */
export const AERIAL_MAX_KM = 32.0;

export const ENVMAP_W = 128;
export const ENVMAP_H = 64;

/* ------------------------------------------------------------------ *
 *  Clouds
 * ------------------------------------------------------------------ */

/** Low deck: stratocumulus/cumulus, metres above sea level. */
export const CLOUD_LOW_BOTTOM_M = 900;
export const CLOUD_LOW_TOP_M = 4200;
/** Cirrus shell altitude, metres. */
export const CLOUD_HIGH_M = 7600;

export const CLOUD_BASE_NOISE_SIZE = 128;
export const CLOUD_DETAIL_NOISE_SIZE = 32;
export const CLOUD_WEATHER_SIZE = 512;
/** Metres covered by one wrap of the weather texture. */
export const CLOUD_WEATHER_EXTENT_M = 48000;

export const CLOUD_SHADOW_SIZE = 512;
/** Metres covered by the cloud shadow map, centred on the camera. */
export const CLOUD_SHADOW_EXTENT_M = 26000;

/** Wind multiplier at cloud altitude — the deck runs ahead of the surface wind. */
export const CLOUD_WIND_GAIN = 1.6;
