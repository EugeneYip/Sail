import type { Module } from '../types';
import { Sky } from './Sky';

/**
 * SKY & ATMOSPHERE — owned by the sky agent.
 *
 * STATUS
 *   Atmosphere, sun, moon, stars and key light are wired and rendering.
 *   Volumetric clouds are the next step; `world.ext.sky.cloudShadowMap` is a
 *   white 1x1 until they land, so consumers can write their code against the
 *   final shape today and get "no cloud shadow" as the answer.
 *
 * WHAT IS HERE
 *   Sky.ts            module: owns everything, publishes the handshake
 *   Radiometry.ts     CPU mirror of the medium: light colours, ambient, SH
 *   AtmosphereLuts.ts the four GPU LUTs (Hillaire 2020)
 *   AtmosphereCpu.ts  the same medium integrated on the CPU
 *   SkyRender.ts      the fullscreen sky object in the main scene
 *   EnvProbe.ts       equirect sky -> scene.environment IBL
 *   SunLight.ts       key light + fitted, texel-snapped shadow frustum
 *   Sidereal.ts       world -> equatorial rotation for the star field
 *   Textures.ts       baked lunar albedo, stellar colour ramp
 *
 * WHAT THE SKY WRITES EVERY FRAME
 *   world.uniforms.uSunDirection   unit vector toward the sun
 *   world.uniforms.uSunColor       hue only: max component is always 1
 *   world.uniforms.uSunIntensity   scalar; colour * intensity = irradiance on a
 *                                  surface facing the sun, scene-linear
 *   world.uniforms.uMoonDirection  unit vector toward the moon
 *   world.uniforms.uMoonColor      Purkinje-shifted, hue only
 *   world.uniforms.uMoonIntensity  same convention as the sun, ~1/300 of it
 *   world.uniforms.uSkyColor       MEAN SKY RADIANCE over the upper hemisphere,
 *                                  i.e. E_sky / PI. Multiply by albedo for the
 *                                  ambient term on an up-facing Lambertian.
 *   world.uniforms.uGroundColor    radiance bounced back up off the sea
 *   world.uniforms.uFogColor       aerial inscatter colour (horizon radiance)
 *   world.uniforms.uFogDensity     extinction, 1/m — Koschmieder from visibility
 *   world.uniforms.uVisibility     metres, mirrors env.visibility
 *   world.env.sunColor             same value as uSunColor
 *   world.env.sunIntensity         same value as uSunIntensity
 *   world.scene.environment        PMREM-filtered sky, for standard materials
 *
 * WHAT THE SKY PUBLISHES — `world.ext.sky`
 *
 *   envMap             THREE.Texture   256x128 equirect RGBA16F, scene-linear
 *                                      radiance, sun disc EXCLUDED (the
 *                                      directional light carries it). Already
 *                                      assigned to scene.environment.
 *   irradianceSH       Float32Array(27) 9 RGB coefficients, r,g,b interleaved,
 *                                      Ramamoorthi basis order
 *                                        0: 0.282095
 *                                        1: 0.488603*y   2: 0.488603*z
 *                                        3: 0.488603*x   4: 1.092548*x*y
 *                                        5: 1.092548*y*z 6: 0.315392*(3z^2-1)
 *                                        7: 1.092548*x*z 8: 0.546274*(x^2-y^2)
 *                                      ALREADY convolved with the clamped
 *                                      cosine lobe and divided by PI, so
 *                                      dot(basis(n), sh) is the outgoing
 *                                      radiance of a white Lambertian surface.
 *                                      Multiply by albedo, do not divide by PI.
 *   transmittanceLUT   THREE.Texture   256x64 RGBA16F. Bruneton (r, mu)
 *                                      parameterisation; see transmittanceUv()
 *                                      in shaders/atmosphere.ts.
 *   aerialLUT          THREE.Texture   32x32x32 RGBA16F froxels. rgb =
 *                                      inscattered radiance, a = mean
 *                                      transmittance. w maps linearly to
 *                                      distance along the view ray over
 *                                      [0, aerialMaxDistance].
 *   aerialMatrix       THREE.Matrix4   clip -> world used when the volume was
 *                                      filled. Refreshed on even frames only.
 *   aerialMaxDistance  number          metres, far plane of the froxel volume
 *   cloudShadowMap     THREE.Texture   R = fraction of sunlight reaching the
 *                                      surface. White 1x1 until clouds land.
 *   cloudShadowMatrix  THREE.Matrix4   world position -> cloudShadowMap uv in
 *                                      .xy. Sample only when both are in [0,1].
 *   cloudShadowStrength number         0..1, how much of the map to apply
 *   sunLuminance       number          luminance of the direct sun irradiance
 *   skyLuminance       number          luminance of the mean sky radiance
 *   zenithColor        THREE.Color     live reference, do not mutate
 *   horizonColor       THREE.Color     live reference, do not mutate
 *
 * The Colors and the Matrix4s are LIVE references that are rewritten in place
 * every frame. Read them, copy them, never write to them.
 *
 * SHADOWS — a deliberate limitation, stated plainly.
 *   `settings.shadowCascades` does not currently drive real cascade splits. Real
 *   CSM in three needs every receiving material patched at the
 *   `lights_fragment_begin` include, and materials belong to the ship, world and
 *   ocean agents, not to the sky. Rather than reach across those boundaries, the
 *   sun uses ONE shadow map fitted tightly to the ship and texel-snapped, and
 *   the cascade count is spent tightening that frustum instead. At ultra
 *   (4096 map, 4 cascades) that is ~3.4 cm per texel with the sun high, which
 *   resolves standing rigging; the cost is that shadows are not maintained
 *   beyond ~150 m from the ship, which on an empty ocean has nothing to fall on.
 *   If the ship or world agent wants true cascades, ask for a material-side
 *   hook and this module can fill an array of maps and matrices.
 */
export function createSkyModules(): Module[] {
  return [new Sky()];
}

export type { SkyHandshake } from './Sky';
