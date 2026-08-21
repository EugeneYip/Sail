/**
 * Aerial perspective for the ship.
 *
 * WHY THIS EXISTS. The ship was the only opaque geometry in the frame rendered
 * as if the air between it and the camera were a vacuum. `src/ocean` hazes the
 * sea (`shaders/surface.ts`), `src/world` hazes islands, other vessels and
 * wildlife (`worldAerial`), `src/vfx` hazes spray and rain (`applyAerial`), and
 * `scene.fog` is never set — so every ship material carried no distance term at
 * all.
 *
 * That is not a subtle omission at the ranges the ship is actually viewed at.
 * Measured on the `orbit` scene (camera 143 m from the hull, visibility 32 km,
 * `uFogColor` luminance 0.632): the in-scatter the hull should receive is
 * 1.71% x 0.632 = 1.08e-2 of radiance, against a measured radiance of 3.5e-4 on
 * the shaded black topsides. **Thirty times the whole signal.** So 17% of the
 * hull band clipped to exactly RGB(0,0,0) and the hull read as a paper cut-out
 * with a hard silhouette edge, while a sunlit surface at 0.1-2.5 radiance moves
 * by 1% and is left alone.
 *
 * It is therefore NOT a black-point lift or an exposure change: it is
 * distance-dependent, so the helm camera at 2 m gets essentially none of it and
 * the orbit camera gets all of it, and it is bounded above by the horizon
 * radiance the sea and sky already agree on.
 *
 * WHY IT IS DUPLICATED rather than imported. This mirrors
 * `src/world/shaders/wcommon.ts::worldAerial` term for term — the same scale
 * height, the same Koschmieder density floor, the same forward-scattering lobe
 * and the same depth-blueing — because a ship and an island at the same range
 * must haze identically or the frame comes apart. It is copied because
 * non-negotiable 2 forbids importing another subsystem's module; `src/util` is
 * the only shared home and `GLSL.fog`'s `applyAerial` uses a different, less
 * physical sun lobe (a flat 0.55 that does not go out at night).
 *
 * uFogColor, uSkyColor and uGroundColor are RADIANCE, so no 1/PI is owed here;
 * uSunIntensity and uMoonIntensity are IRRADIANCE, which is why the sun lobe
 * carries an explicit small coefficient rather than a bare multiply. See
 * `sky/constants.ts`.
 */

/**
 * Uniform declarations for `lwShipAerial`. Include this ONLY in a material that
 * does not already carry `SHARED_UNIFORM_DECL`, or the declarations collide.
 */
export const SHIP_AERIAL_UNIFORMS = /* glsl */ `
uniform vec3  uSunDirection;
uniform vec3  uSunColor;
uniform float uSunIntensity;
uniform vec3  uMoonColor;
uniform float uMoonIntensity;
uniform vec3  uFogColor;
uniform float uFogDensity;
uniform float uVisibility;
`;

/**
 * The term itself. Needs three's own `vViewPosition`, `cameraPosition` and
 * `viewMatrix`, all of which every lit three material already has, so no
 * material has to add a world-position varying for this.
 *
 * Depends on: the uniforms above (or `SHARED_UNIFORM_DECL`).
 */
export const SHIP_AERIAL_FN = /* glsl */ `
#ifndef LW_SHIP_AERIAL
#define LW_SHIP_AERIAL
#define LW_AERIAL_SCALE_H 1350.0

/**
 * Slant path through an exponential-height atmosphere, in metres of
 * sea-level-equivalent air. Falls back to the flat integral when the camera and
 * the fragment are within a metre of the same altitude, where the closed form
 * divides by nothing useful.
 */
float lwAerialPath(float camY, float wY, float dist){
  float hc = max(camY, 0.0);
  float hw = max(wY, 0.0);
  float dh = hw - hc;
  if (abs(dh) < 1.0) return dist * exp(-hc / LW_AERIAL_SCALE_H);
  return dist * (LW_AERIAL_SCALE_H / dh)
       * (exp(-hc / LW_AERIAL_SCALE_H) - exp(-hw / LW_AERIAL_SCALE_H));
}

/** Scene-linear colour in, scene-linear colour out. Call at the end. */
vec3 lwShipAerial(vec3 col){
  float dist = length(vViewPosition);
  // vViewPosition is -mvPosition.xyz, so -vViewPosition is the fragment in view
  // space and normalizing it gives camera -> fragment. 'inverseTransformDirection'
  // takes that back to world without needing an inverse-view uniform.
  vec3 dirW = inverseTransformDirection(normalize(-vViewPosition), viewMatrix);
  float wy = cameraPosition.y + dirW.y * dist;
  // Weather publishes both a density and a visibility; honour whichever implies
  // the thicker air. Radiometry sets uFogDensity to the Koschmieder value for
  // the published visibility, so the max() is normally a tie and exists for the
  // presets that override one and not the other.
  float density = max(uFogDensity, 3.912 / max(uVisibility, 200.0));
  float t = 1.0 - exp(-lwAerialPath(cameraPosition.y, wy, dist) * density);
  float cosT = max(0.0, dot(dirW, uSunDirection));
  float mie = pow(cosT, 8.0) * 0.5 + pow(cosT, 2.0) * 0.07;
  vec3 inscatter = uFogColor * (1.0 + vec3(-0.16, -0.03, 0.24) * t)
                 + uSunColor * (uSunIntensity * 0.016 * mie)
                 + uMoonColor * (uMoonIntensity * 0.02);
  return mix(col, inscatter, clamp(t, 0.0, 1.0));
}
#endif
`;
