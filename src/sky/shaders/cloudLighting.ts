import {
  CLOUD_AIR_SHADOW,
  CLOUD_ALBEDO,
  CLOUD_DIFFUSION_K,
  CLOUD_MULTISCATTER_GAIN,
  CLOUD_SHAFT_RANGE_M,
  CLOUD_SHAFT_STEPS,
  CLOUD_SUN_STEPS,
} from '../constants';

const f = (n: number) => (Number.isInteger(n) ? n.toFixed(1) : String(n));

/**
 * How a cloud sample is lit, and the two marches that feed it.
 *
 * The scattering integral is the same energy-conserving form the atmosphere uses
 * (Hillaire eq. 5): with a constant source S over a step of optical thickness
 * 'sigma * dt', the exact segment integral is 'S/sigma * (1 - exp(-sigma*dt))'.
 * Since 'S/sigma' is just 'albedo * (sunTerm + ambient)', no division appears in
 * the loop at all — which is why this stays cheap enough to run at 60 fps.
 *
 * Four things make a cloud read as a cloud rather than as noise:
 *
 *   Beer's-Powder      exp(-tau) alone makes every sunlit edge equally bright.
 *                      The '1 - exp(-2 tau)' factor reproduces the dark rim a
 *                      real cloud has where it is thin AND facing the light,
 *                      and it is blended in by view-light angle because it is a
 *                      backscatter effect — it must not eat the silver lining.
 *   dual-lobe HG       the forward lobe IS the silver lining; the small
 *                      backward lobe stops the anti-solar side going dead flat.
 *   multi-scatter      three octaves with halved extinction, scattering and
 *     octaves          phase eccentricity. Without them a deck this optically
 *                      thick has a black interior, which is the single most
 *                      obvious "hobby renderer" cloud failure.
 *   sky/sea ambient    a two-colour gradient by height, so undersides pick up
 *                      the sea and tops pick up the zenith.
 *
 * Depends on: GLSL.common, the atmosphere snippet, CLOUD_COMMON_GLSL.
 */
export const CLOUD_LIGHTING_GLSL = /* glsl */ `
#ifndef SKY_CLOUD_LIGHTING
#define SKY_CLOUD_LIGHTING

const int CLOUD_SUN_STEPS = ${CLOUD_SUN_STEPS};
const int CLOUD_SHAFT_STEPS = ${CLOUD_SHAFT_STEPS};
const float CLOUD_ALBEDO = ${CLOUD_ALBEDO};
const float CLOUD_MS_GAIN = ${CLOUD_MULTISCATTER_GAIN};
const float CLOUD_DIFFUSION_K = ${CLOUD_DIFFUSION_K};
const float CLOUD_SHAFT_RANGE_KM = ${f(CLOUD_SHAFT_RANGE_M / 1000)};
const float CLOUD_AIR_SHADOW = ${CLOUD_AIR_SHADOW};

uniform vec3  uCloudLightDir;
uniform vec3  uCloudLightIrradiance;
uniform vec3  uCloudAmbientTop;
uniform vec3  uCloudAmbientBottom;

/**
 * Optical depth from a sample toward the light. Five cone steps of geometrically
 * growing length plus one long reach: the near steps resolve the self-shadowing
 * that gives a cumulus tower its form, the far one catches a neighbouring tower
 * standing between this sample and the sun.
 */
float cloudLightDepth(vec3 p, vec3 lightDir){
  float tau = 0.0;
  float step = 0.09;
  vec3 q = p;
  float h;
  for (int i = 0; i < CLOUD_SUN_STEPS; i++) {
    q += lightDir * step;
    tau += cloudDensityAt(q, false, h) * step;
    step *= 1.65;
  }
  q = p + lightDir * 4.5;
  tau += cloudDensityAt(q, false, h) * 1.6;
  return tau * 1000.0 * CLOUD_SIGMA_T;
}

/**
 * Radiance scattered toward the viewer from one sample, divided by sigma_t —
 * i.e. exactly the factor the segment integral wants.
 */
vec3 cloudScatteredRadiance(float tauLight, float cosView, float hFrac){
  float powderMix = saturate1(-cosView * 0.5 + 0.5);

  // Multiple scattering needs optical depth to happen in. A sample at a wispy
  // edge, and the whole of a tau-0.5 cirrus slab, scatter essentially once — so
  // the octaves have to fade out with tau or they hand thin cloud five times the
  // radiance it has any right to. That was a large part of why edges and high
  // cloud read as a bright haze rather than as cloud.
  float ms = 1.0 - exp(-tauLight * 0.75);

  float sun = 0.0;
  float a = 1.0;   // scattering weight
  float b = 1.0;   // extinction weight
  float c = 1.0;   // phase eccentricity
  for (int n = 0; n < 4; n++) {
    float tau = tauLight * b;
    // Octave 0 IS single scattering, so it gets exact Beer-Lambert. The higher
    // octaves stand in for the diffusion regime, where a conservative slab
    // transmits 1/(1 + k*tau) — the two-stream result — not exp(-tau). Using
    // Beer for them is precisely why a naive octave march gives a 3 km
    // nimbostratus a black underside instead of the flat grey it really has.
    float trans = n == 0 ? exp(-tau) : 1.0 / (1.0 + CLOUD_DIFFUSION_K * tau);
    float powder = 1.0 - exp(-2.0 * tau);
    float gain = n == 0 ? 1.0 : CLOUD_MS_GAIN * ms;
    sun += a * gain * cloudPhase(cosView, c) * trans * mix(1.0, 2.0 * powder, powderMix);
    a *= 0.5;
    b *= 0.5;
    c *= 0.6;
  }

  // Ambient arrives already carrying the 1/(4 pi) an isotropic phase would
  // apply and the same multiple-scattering gain (see Radiometry.cloudAmbient*).
  float up = hFrac * hFrac * 0.65 + hFrac * 0.35;
  vec3 amb = mix(uCloudAmbientBottom, uCloudAmbientTop, up) * (0.28 + 0.72 * up);

  return (uCloudLightIrradiance * sun + amb) * CLOUD_ALBEDO;
}

/**
 * Crepuscular rays.
 *
 * The sky-view LUT is baked without clouds, so the air below an overcast deck
 * comes out of it far too bright. This march measures how much of the near
 * column actually sees the sun and returns a MULTIPLIER on the sky radiance
 * behind the clouds.
 *
 * Multiplicative and nothing else, deliberately. An earlier version also ADDED a
 * Mie forward-scatter term for the lit part of the column, which is inscatter
 * the LUT already carries: it fired at full strength with zero cloud cover, so
 * every clear sky got an extra unconditional haze layer around the sun. God rays
 * do not need an additive term — a per-pixel shadow on a Mie-bright column is
 * already a bright shaft against a darker background, which is what one is.
 *
 * The shadow is weighted two ways. By how much of the ray's scattering column
 * lies inside the marched segment: looking straight up almost none of it does,
 * so the zenith is untouched, while looking toward the horizon nearly all of it
 * does, which is what makes a storm horizon go properly leaden. And by the Mie
 * phase toward the sun, because the inscatter being shadowed is concentrated in
 * the forward lobe — that is what gives the shafts their contrast.
 */
float cloudAirShadow(vec3 pos, vec3 dir, float tEnd, vec3 sunDir, sampler2D shadowMap,
                     mat4 shadowMatrix, float jitter){
  if (sunDir.y < 0.02) return 1.0;
  float tMax = min(tEnd, CLOUD_SHAFT_RANGE_KM);
  if (tMax <= 0.05) return 1.0;

  float dt = tMax / float(CLOUD_SHAFT_STEPS);
  float t = dt * jitter;
  float lit = 0.0;
  float wsum = 0.0;
  float slant = 1.0 / max(sunDir.y, 0.02);

  for (int i = 0; i < CLOUD_SHAFT_STEPS; i++) {
    vec3 p = pos + dir * t;
    float alt = (length(p) - RG) * 1000.0;
    // Mie sits in the bottom ~1.2 km, and it is the aerosol that makes a shaft
    // visible, so weight the average by the aerosol density at the sample.
    float w = exp(-max(0.0, alt) / 1200.0);
    // The map is a sea-level slice: walk the sample back down the sun ray.
    vec3 wp = vec3(p.x * 1000.0, 0.0, p.z * 1000.0) - sunDir * (alt * slant);
    vec2 uv = (shadowMatrix * vec4(wp, 1.0)).xy;
    float s = (all(greaterThan(uv, vec2(0.0))) && all(lessThan(uv, vec2(1.0))))
      ? texture(shadowMap, uv).r
      : 1.0;
    lit += s * w;
    wsum += w;
    t += dt;
  }

  float litFrac = wsum > 1e-4 ? lit / wsum : 1.0;
  // Fraction of the Rayleigh column that lies inside the marched segment.
  float colFrac = 1.0 - exp(-tMax / 8.0);
  float fwd = 0.55 + 0.45 * saturate1(dot(dir, sunDir) * 0.5 + 0.5);
  return 1.0 - CLOUD_AIR_SHADOW * fwd * colFrac * (1.0 - litFrac);
}

/**
 * The whole cloud stack along one ray.
 *
 *   .rgb  radiance the clouds and the air in front of them add
 *   .a    what is left of the sky behind them
 *
 * The alpha folds cloud transmittance together with the aerial perspective in
 * front of the cloud, so a distant deck dissolves into haze instead of staying
 * crisply opaque at 40 km, and the composite in skyRender.ts stays one line:
 * 'L = L * cl.a + cl.rgb'.
 */
vec4 cloudMarch(vec3 pos, vec3 dir, vec3 sunDir, float steps, float jitter,
                sampler2D transLut, bool detail,
                sampler2D shadowMap, mat4 shadowMatrix, bool shafts){
  float rB, rT;
  cloudShells(rB, rT);

  vec3 L = vec3(0.0);
  float T = 1.0;
  float depthSum = 0.0;
  float depthWeight = 0.0;

  float cosView = dot(dir, uCloudLightDir);
  float t0 = 0.0;
  float t1 = 0.0;
  bool hit = uCoverage > 0.002 && layerSegment(pos, dir, rB, rT, t0, t1);

  if (hit) {
    // A grazing ray can run 300 km through the slab. Cap it: past ~55 km the
    // deck is below the visible horizon anyway, and marching further only buys
    // aliasing at the very bottom row of the sky.
    float seg = min(t1 - t0, 55.0);
    // Steps grow geometrically along the ray. A fixed step budget spread evenly
    // over a 55 km grazing chord would be 1.4 km apart at the camera, where the
    // deck is a few hundred metres across on screen; this spends the budget
    // where the cloud is actually resolvable and costs nothing extra.
    const float GROWTH = 1.055;
    // Cap on one step, km. Without it the last steps of an 80-step 55 km chord
    // are over 3 km long, the per-pixel start dither shifts the sample by that
    // much, and the far half of the deck comes back as pure noise for the
    // temporal filter to fail to remove. Capping costs reach — 42 km instead of
    // 55 — which is past the point where the deck is more aerial haze than
    // cloud, and buys 2.5x less variance where the big masses actually are.
    const float DT_MAX = 1.2;
    float dt = seg * (GROWTH - 1.0) / (pow(GROWTH, steps) - 1.0);
    float t = t0 + dt * jitter;
    float h;

    for (float i = 0.0; i < steps; i += 1.0) {
      if (T < 0.012) break;
      vec3 p = pos + dir * t;
      float density = cloudDensityAt(p, detail, h);
      if (density > 0.0015) {
        float sigma = density * CLOUD_SIGMA_T;
        float tauLight = cloudLightDepth(p, uCloudLightDir);
        vec3 S = cloudScatteredRadiance(tauLight, cosView, h);
        float stepT = exp(-sigma * dt * 1000.0);
        L += T * S * (1.0 - stepT);
        float w = T * (1.0 - stepT);
        depthSum += t * w;
        depthWeight += w;
        T *= stepT;
      }
      t += dt;
      dt = min(dt * GROWTH, DT_MAX);
      if (t - t0 > seg) break;
    }
  }

  float tCirrus;
  float tauC = cirrusOpticalDepth(pos, dir, tCirrus);
  if (tauC > 0.001) {
    float Tc = exp(-tauC);
    // Ice cloud is optically thin, so one slab with the same phase function is
    // indistinguishable from marching it, and the forward lobe still gives the
    // bright halo when the sun is behind a cirrus veil.
    vec3 S = cloudScatteredRadiance(tauC * 0.5, cosView, 1.0);
    L += T * S * (1.0 - Tc);
    float w = T * (1.0 - Tc);
    depthSum += tCirrus * w;
    depthWeight += w;
    T *= Tc;
  }

  // Aerial perspective in front of the clouds. Beyond ~30 km the deck is more
  // haze than cloud, and this is what makes the horizon read as distance.
  float meanDist = depthWeight > 1e-5 ? depthSum / depthWeight : 0.0;
  float Ta = 1.0;
  if (meanDist > 0.05) {
    float r = length(pos);
    vec3 tHere = sampleTransmittance(transLut, r, max(dir.y, -0.02));
    vec3 tThere = sampleTransmittance(transLut, length(pos + dir * meanDist), max(dir.y, -0.02));
    // Ratio of the two column transmittances is the segment transmittance.
    vec3 seg = clamp(tHere / max(tThere, vec3(1e-4)), vec3(0.0), vec3(1.0));
    Ta = lwLuminance(seg);
    L *= seg;
  }

  float air = 1.0;
  if (shafts && uCoverage > 0.002) {
    float tEnd = hit ? t0 : CLOUD_SHAFT_RANGE_KM;
    air = cloudAirShadow(pos, dir, tEnd, sunDir, shadowMap, shadowMatrix, jitter);
  }

  float alpha = (T + (1.0 - T) * (1.0 - Ta)) * air;
  return vec4(max(L, vec3(0.0)), clamp(alpha, 0.0, 1.0));
}
#endif
`;
