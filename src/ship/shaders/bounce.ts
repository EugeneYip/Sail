/**
 * The ship's own bounce light.
 *
 * WHY THIS EXISTS. `sky/EnvProbe` is the ship's only ambient: a 256x128
 * SKY-ONLY equirect rendered from (0, 30, 0) and PMREM'd into
 * `scene.environment`. It was verified to be the right magnitude — forcing
 * `ship-black`'s albedo to 1.0 with the sun off puts the hull at sRGB 94, which
 * matches the probe's own cosine-weighted irradiance — so the IBL is not broken.
 * But the probe cannot contain the two brightest things in a ship surface's
 * hemisphere after the sun, because neither is sky:
 *
 *   CANVAS. 3968 m2 of albedo-0.62 flax hanging directly over the deck.
 *   `sky/constants.ts` anchors sunlit white canvas at ~2.5 radiance against a
 *   mean sky of 0.1-0.5, so where the sail plan fills a surface's hemisphere it
 *   replaces the sky with something five to eight times brighter. This is the
 *   whole reason a shaded belaying pin, fife rail or yard at two metres reads as
 *   a flat unlit silhouette: at that range aerial perspective contributes
 *   nothing (t is 1e-4) and the sky is the only fill in the model.
 *
 *   FOAM. A breaking bow wave at the waterline. Open water is already in the
 *   probe's lower hemisphere at about the right radiance — its cosine-weighted
 *   'down' irradiance measures within 30% of the CPU radiometry's own SH — so
 *   only the FOAM EXCESS is added here, not the water.
 *
 * RADIOMETRY. uSunIntensity is IRRADIANCE, so the 1/PI that turns it into a
 * Lambertian's outgoing radiance is ours; uSkyColor is RADIANCE and a Lambertian
 * under a uniform sky of radiance L simply leaves at `albedo * L`, so that half
 * owes nothing. See the units contract in `sky/constants.ts`. The function
 * returns a RADIANCE for the caller to multiply by albedo, exactly like
 * uSkyColor, and it is added to indirect DIFFUSE only: `env` has always meant
 * reflection and this is not a reflection.
 *
 * THE VIEW FACTORS ARE GEOMETRIC ESTIMATES, not measurements, and are named so
 * they can be argued with. The sail plan is roughly 50 m tall and 50 m long with
 * its foot 6 m above the rail, so from the deck it covers most of the sky and
 * from an outboard topside — whose normal points away from it — very little;
 * `n.y` is the cheap proxy for that and 0.22 is the deck's share. The wave's own
 * view factor dies with height above the water: the wale is about 5 m up and the
 * rail 9 m, hence a 6 m falloff.
 */

/**
 * Depends on: INV_PI (GLSL.common), and uSunColor / uSunIntensity /
 * uSunDirection / uSkyColor either from `SHARED_UNIFORM_DECL` or declared by the
 * caller.
 */
export const SHIP_BOUNCE_FN = /* glsl */ `
#ifndef LW_SHIP_BOUNCE
#define LW_SHIP_BOUNCE

/** Off-white weathered flax, same value 'makeCanvas' bakes. */
#define LW_CANVAS_ALB 0.62
/** Representative cosine over a square rig's sail plan. */
#define LW_CANVAS_COS 0.45
/** Cosine-weighted share of an UP-facing surface's hemisphere that is canvas. */
#define LW_CANVAS_VIEW 0.22
/**
 * Foam EXCESS albedo over the water already in the probe: about a quarter of the
 * near field breaking, at 0.70 against water's 0.06.
 */
#define LW_FOAM_ALB 0.16
/** Cosine-weighted share of a DOWN-facing surface's hemisphere at the waterline. */
#define LW_FOAM_VIEW 0.35
/** Height above the water over which the near wave's view factor dies, metres. */
#define LW_FOAM_H 6.0

vec3 lwShipBounce(vec3 nW, float heightM){
  float up = clamp(nW.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 sunE = uSunColor * uSunIntensity;
  // Outgoing radiance of each secondary source: sun (irradiance, so 1/PI) plus
  // the sky it also stands under (radiance, so no 1/PI).
  vec3 canvasL = LW_CANVAS_ALB * (sunE * (LW_CANVAS_COS * INV_PI) + uSkyColor);
  vec3 foamL = LW_FOAM_ALB * (sunE * (max(uSunDirection.y, 0.0) * INV_PI) + uSkyColor);
  float fFoam = (1.0 - up) * exp(-max(heightM, 0.0) / LW_FOAM_H);
  return canvasL * (LW_CANVAS_VIEW * up) + foamL * (LW_FOAM_VIEW * fFoam);
}
#endif
`;
