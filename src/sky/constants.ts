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

/* ------------------------------------------------------------------ *
 *  THE RADIOMETRIC UNITS CONTRACT
 *
 *  One convention, applied once, with no per-scene correction anywhere.
 *  `src/sky/Radiometry.ts` is the single source of truth: it is the only
 *  place `RADIANCE_SCALE` is ever applied, and every other module reads
 *  numbers that already have it baked in.
 *
 *  MODEL UNITS. The atmosphere integrator — `AtmosphereCpu` and its GPU
 *  twin in `shaders/atmosphere.ts` — works in units where the
 *  top-of-atmosphere solar irradiance is 1.0. Nothing outside those two
 *  files ever sees a model-unit value.
 *
 *  GAME UNITS = MODEL UNITS x RADIANCE_SCALE. Since TOA solar illuminance
 *  is 1.33e5 lux, one game unit is ~1e4 lux of irradiance or ~1e4 cd/m^2
 *  of radiance (see LUMINANCE_PER_UNIT). Useful anchors at noon, clear,
 *  turbidity 2:
 *
 *      sun irradiance, surface facing it      ~12
 *      mean sky radiance (uSkyColor)          ~0.1 .. 0.5
 *      sunlit 18% grey, Lambertian            ~0.7
 *      sunlit white canvas                    ~2.5
 *      deep sea                               ~0.05 .. 0.15
 *      sun disc (SUN_DISC_RADIANCE_SCALE)     ~1.8e3
 *      moonlit sea, full moon                 ~3e-4
 *
 *  IRRADIANCE vs RADIANCE. This is the part that is easy to get wrong, so
 *  it is stated once and not repeated:
 *
 *    IRRADIANCE (E), game units, on a surface facing the light —
 *      uSunIntensity, uMoonIntensity, DirectionalLight.intensity.
 *      A material owes the 1/PI: `albedo * uSunIntensity * NoL * INV_PI`.
 *      three's own lighting follows the same rule (BRDF_Lambert divides by
 *      PI), which is why `sun.intensity = radiometry.sunIntensity` is
 *      correct rather than off by PI.
 *
 *    RADIANCE (L), game units, ready to use —
 *      uSkyColor, uGroundColor, uFogColor, zenithColor, horizonColor,
 *      irradianceSH, envMap, aerialLUT. The 1/PI is already applied.
 *      A material multiplies by albedo and adds: `albedo * uSkyColor`.
 *
 *  The post stack owns the only exposure multiplier in the frame
 *  (`uExposure`, applied in post/shaders/prepare.ts). No material and no
 *  sky term may scale itself to "look right" — if a time of day exposes
 *  badly the model is wrong, not the scale.
 * ------------------------------------------------------------------ */

export const RADIANCE_SCALE = 13.0;

/**
 * Photometric calibration of one game unit. TOA solar illuminance is
 * ~1.33e5 lux, so `1.0` game unit is ~1.02e4 cd/m^2 — a sunlit white wall
 * at noon lands near 2.5, i.e. ~2.6e4 cd/m^2, which is what a meter reads.
 * Used for perceptual thresholds (star wash-out) that have to be stated in
 * real photometric terms to mean anything.
 */
export const TOA_SOLAR_ILLUMINANCE_LUX = 133000;
export const LUMINANCE_PER_UNIT = TOA_SOLAR_ILLUMINANCE_LUX / RADIANCE_SCALE;

/** Solid angle of the solar disc, steradians. */
export const SUN_SOLID_ANGLE = 2 * Math.PI * (1 - Math.cos(SUN_ANGULAR_RADIUS));

/**
 * The sun disc is rendered at 1% of its physical radiance. Physically the disc
 * is ~1.5e5 in the same units where a sunlit white sail is ~2, and putting that
 * in the HDR buffer wrecks any average-luminance auto-exposure and turns bloom
 * into a white sheet. 1% keeps the disc ~700x brighter than white — still a
 * hard clip with a strong glare — while the RATIO between noon and sunset is
 * preserved, so the sun visibly dims as it sets.
 */
export const SUN_DISC_RADIANCE_SCALE = 0.01;

/** Earthshine as a fraction of the sunlit lunar surface, at new moon. */
export const EARTHSHINE_FRACTION = 0.014;

/**
 * Star and Milky Way radiance, game units. Real first-magnitude stars are ~1e-5
 * of the daytime sky; at that level they never survive tone mapping at any
 * exposure that also keeps the moon from clipping. These are tuned so the sky
 * reads right at night rather than being radiometrically exact.
 */
export const STAR_RADIANCE = 0.055;
export const MILKY_WAY_RADIANCE = 0.0042;
/**
 * Zenith radiance at which stars are half washed out, game units. 1e-3 is
 * ~10 cd/m^2 — the sky brightness at which the naked eye loses all but the
 * first-magnitude stars, so they appear through nautical twilight and are gone
 * well before sunrise. Stated in game units because that is what
 * `Radiometry.zenithLuminance` is in; divide by LUMINANCE_PER_UNIT to check it.
 */
export const STAR_WASHOUT = 0.001;

/**
 * Airglow. The 557.7 nm oxygen line plus the OH Meinel bands: a real, permanent
 * emission layer at ~90 km that is why a moonless, starless night sky is very
 * dark green-grey rather than black.
 */
export const AIRGLOW = new THREE.Vector3(0.000055, 0.000082, 0.000072);

/** Sea albedo used for the ground-bounce ambient term, linear RGB. */
export const SEA_BOUNCE_ALBEDO = new THREE.Vector3(0.028, 0.045, 0.062);

/**
 * Koschmieder's constant for a 2% contrast threshold: V = 3.912 / beta. Kept
 * here as well as in env/Optics so the two modules cannot write inconsistent
 * values into `uFogDensity` — they are deriving the same physical quantity.
 */
export const KOSCHMIEDER = 3.912;

/* ------------------------------------------------------------------ *
 *  Shadows
 * ------------------------------------------------------------------ */

/** Half-extent of the sun's shadow frustum with the sun high, metres. */
export const SHADOW_RADIUS_MIN_M = 74;
/** ...and with the sun on the horizon, where shadows run long. */
export const SHADOW_RADIUS_MAX_M = 200;
/** Distance the shadow camera is pulled back along the light axis, metres. */
export const SHADOW_PULLBACK_M = 420;

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
/**
 * Froxel slices. WebGL2 cannot render to several layers of a 3D target in one
 * draw, so this number IS the draw count of the aerial pass — at 32 it was 32 of
 * the sky module's 34 passes per frame. The volume maps LINEARLY over
 * AERIAL_MAX_KM, so 16 slices is 2 km per slice, and inscattered radiance over
 * open ocean varies far more slowly than that. See AERIAL_PERIOD in Sky.ts for
 * the matching refresh rate.
 */
export const AERIAL_SLICES = 16;
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
/**
 * Metres covered by one wrap of the base and detail volumes. Both divide
 * CLOUD_WEATHER_EXTENT_M exactly (8x and 64x), which is what lets the
 * accumulated wind scroll be wrapped modulo the weather extent without any of
 * the three fields jumping — and wrapping it is what keeps the field coordinates
 * inside fp32's useful range after an hour of sailing.
 */
export const CLOUD_BASE_TILE_M = 6000;
export const CLOUD_DETAIL_TILE_M = 750;
/** Cirrus samples the weather map at this multiple of the low deck's extent. */
export const CLOUD_CIRRUS_MAP_SCALE = 2;

export const CLOUD_SHADOW_SIZE = 512;
/** Metres covered by the cloud shadow map, centred on the camera. */
export const CLOUD_SHADOW_EXTENT_M = 26000;

/** Wind multiplier at cloud altitude — the deck runs ahead of the surface wind. */
export const CLOUD_WIND_GAIN = 1.6;

/**
 * Extinction of the low deck at unit field density, 1/m. Measured cumulus runs
 * 0.01–0.06 1/m; at 0.045 a 1 km chord of solid cloud has optical depth 45, so
 * the deck is properly opaque and its interior is lit only by multiple
 * scattering — which is exactly where the octave approximation earns its keep.
 */
export const CLOUD_EXTINCTION_PER_M = 0.045;
/**
 * Single-scattering albedo. Liquid water barely absorbs in the visible, so this
 * is very close to 1 and cloud colour comes almost entirely from the light, not
 * from the medium. Nudged below 1 so an infinitely deep march still converges.
 */
export const CLOUD_ALBEDO = 0.98;
/**
 * Energy gain applied to the multiple-scattering octaves.
 *
 * The octave approximation is known to under-light. Summed to infinity it
 * converges to twice the isotropic phase — 0.16 sr^-1 — while a semi-infinite
 * cloud of albedo 0.98 really returns about 0.85 of what falls on it, which as a
 * Lambertian is 0.27 sr^-1. This is that shortfall, applied only to octaves 1
 * and up so that single scattering — and with it the silver lining, which is a
 * single-scattering phenomenon — stays exactly as physics gives it.
 *
 * The anchor is checkable: at noon, E_sun is ~12 game units, so a thick sunlit
 * cumulus top must land near 0.85 * 12 / PI = 3.2 units of radiance, i.e. about
 * 30 % brighter than a sunlit white sail. That is the number this is set for.
 */
export const CLOUD_MULTISCATTER_GAIN = 4.5;

/**
 * Two-stream diffusion coefficient, `T = 1/(1 + k tau)`.
 *
 * k = 0.75 (1 - g_eff). A single Mie scatter has g ~= 0.85, but after enough
 * scatters the effective asymmetry decays toward zero; 0.19 corresponds to
 * g_eff = 0.75, which is where the multiple-scattering octaves live. Only the
 * octaves use it — single scattering stays exact Beer-Lambert.
 */
export const CLOUD_DIFFUSION_K = 0.19;

/** Cirrus optical depth at full cover, along the vertical. Ice cloud is thin. */
export const CLOUD_CIRRUS_OPTICAL_DEPTH = 0.55;
/** Thickness of the cirrus shell, metres — used only for the ray path length. */
export const CLOUD_CIRRUS_THICKNESS_M = 900;

/** Sun-march samples per lit cloud sample, and for the shadow map. */
export const CLOUD_SUN_STEPS = 5;
export const CLOUD_SHADOW_STEPS = 14;
/** Samples in the below-deck shaft march that produces crepuscular rays. */
export const CLOUD_SHAFT_STEPS = 10;
/** Distance the shaft march covers, metres. Beyond this the deck is at grazing. */
export const CLOUD_SHAFT_RANGE_M = 26000;
/**
 * How much of the sky's inscattered radiance the deck is allowed to shadow.
 * The sky-view LUT is baked cloud-free, so the air under an overcast deck comes
 * out of it too bright; this is the correction, and the gaps in it are the
 * crepuscular rays. Full strength would be 1.0 — held below that because the
 * LUT's multiple-scattering term genuinely does still light shadowed air.
 */
export const CLOUD_AIR_SHADOW = 0.55;

/**
 * Temporal accumulation weight for the quarter-res cloud buffer, per frame at
 * 60 Hz. 0.09 needs ~11 frames to converge, which is what lets 40 march steps
 * look like 400; the neighbourhood clamp in the resolve is what stops that
 * becoming a smear when the camera turns.
 */
export const CLOUD_TEMPORAL_ALPHA = 0.09;
/** Divisor on each screen axis for the cloud raymarch target. */
export const CLOUD_RESOLUTION_DIVISOR = 2;
