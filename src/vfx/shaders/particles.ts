import { GLSL } from '../../util/glsl';
import { SHARED_UNIFORM_DECL } from '../../core/SharedUniforms';

/**
 * GPU particle state lives in three RGBA32F textures, stepped with one MRT
 * fragment pass per frame and rendered as one instanced draw.
 *
 *   T0  xyz = world position, w = age (seconds; < 0 means dead)
 *   T1  xyz = velocity m/s,   w = total lifetime
 *   T2  x = base size (m), y = kind, z = seed, w = wind drag coefficient
 *
 * Emission is a second, tiny pass: a 'THREE.Points' draw straight into the same
 * MRT, one point per new particle, at the destination texel. That keeps the
 * whole system to two passes plus one draw, whatever the particle count.
 */

export const KIND = {
  DROPLET: 0,
  SHEET: 1,
  MIST: 2,
  SPINDRIFT: 3,
  FLECK: 4,
  FLASH: 5,
  MOTE: 6,
  GLITTER: 7,
  SMOKE: 8,
} as const;

const probe = /* glsl */ `
uniform sampler2D tProbe;
uniform mat3 uProbeMat;
// R = height, GB = surface slope, A = crest measure.
vec4 probeAt(vec2 xz){
  vec2 uv = (uProbeMat * vec3(xz, 1.0)).xy;
  return texture(tProbe, clamp(uv, vec2(0.001), vec2(0.999)));
}
`;

export const simVert = /* glsl */ `
precision highp float;
in vec3 position;
out vec2 vUv;
void main(){
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const simFrag = /* glsl */ `
precision highp float;
${GLSL.common}
${GLSL.simplex3d}
${probe}
in vec2 vUv;
uniform sampler2D tPos;
uniform sampler2D tVel;
uniform sampler2D tPar;
uniform float uDt;
uniform float uTime;
uniform vec3  uAir;        // air velocity, m/s
uniform float uTurb;       // gust turbulence amplitude
uniform vec3  uShift;      // floating-origin correction applied this frame
layout(location = 0) out vec4 oPos;
layout(location = 1) out vec4 oVel;
layout(location = 2) out vec4 oPar;

void main(){
  vec4 P = texture(tPos, vUv);
  vec4 V = texture(tVel, vUv);
  vec4 A = texture(tPar, vUv);
  oPar = A;

  float age = P.w;
  if (age < 0.0){ oPos = vec4(P.xyz, -1.0); oVel = V; return; }
  age += uDt;
  if (age >= V.w){ oPos = vec4(P.xyz, -1.0); oVel = V; return; }

  float kind = A.y;
  vec3 pos = P.xyz + uShift;
  vec3 vel = V.xyz;
  float dt = uDt;

  // Gravity: droplets fall like ballistic water, torn spray and mist are
  // essentially neutrally buoyant and go where the air goes.
  float gScale = 1.0;
  if (kind > 1.5 && kind < 2.5) gScale = 0.10;      // MIST
  else if (kind > 2.5 && kind < 3.5) gScale = 0.34; // SPINDRIFT
  else if (kind > 3.5 && kind < 4.5) gScale = 0.0;  // FLECK, rides the surface
  else if (kind > 4.5 && kind < 5.5) gScale = -0.4; // FLASH, rises
  else if (kind > 5.5 && kind < 6.5) gScale = 0.02; // MOTE
  else if (kind > 7.5) gScale = -0.16;              // SMOKE, hot and buoyant
  else if (kind > 6.5) gScale = 0.0;                // GLITTER
  else if (kind > 0.5) gScale = 0.72;               // SHEET
  vel.y -= 9.81 * gScale * dt;

  // Wind coupling. Small droplets have a huge area-to-mass ratio so they lose
  // their launch velocity fast and end up travelling with the air.
  vec3 rel = uAir - vel;
  vel += rel * min(A.w * dt, 0.95);

  if (uTurb > 0.001 && kind > 1.5){
    vec3 q = pos * 0.055 + vec3(0.0, uTime * 0.35, uTime * 0.13);
    vec3 turb = vec3(snoise3(q), snoise3(q + 31.7) * 0.6, snoise3(q + 71.3));
    vel += turb * uTurb * dt;
  }

  pos += vel * dt;

  vec4 pr = probeAt(pos.xz);
  float wy = pr.r;
  if (kind > 3.5 && kind < 4.5){
    // Foam flecks stick to the surface and drift with the orbital motion.
    pos.y = wy + 0.04;
  } else if (kind < 4.5 && pos.y < wy){
    // Water lands in water. Kill it just under the surface so the last frame
    // still fades out rather than popping.
    if (pos.y < wy - 0.35) { oPos = vec4(pos, -1.0); oVel = vec4(vel, V.w); return; }
    vel.y *= -0.12;
    vel.xz *= 0.55;
    age = max(age, V.w - 0.14);
  } else if (kind > 7.5 && pos.y < wy + 0.4){
    // Smoke rolls along the surface rather than sinking through it.
    pos.y = wy + 0.4;
    vel.y = max(vel.y, 0.0);
  }

  oPos = vec4(pos, age);
  oVel = vec4(vel, V.w);
}
`;

/** Kill every slot. A float render target cannot be cleared to age = -1. */
export const killFrag = /* glsl */ `
precision highp float;
layout(location = 0) out vec4 oPos;
layout(location = 1) out vec4 oVel;
layout(location = 2) out vec4 oPar;
void main(){
  oPos = vec4(0.0, 0.0, 0.0, -1.0);
  oVel = vec4(0.0);
  oPar = vec4(0.0);
}
`;

export const emitVert = /* glsl */ `
precision highp float;
in vec3 position;     // NDC of the destination texel
in vec3 aPos;
in vec4 aVel;         // xyz velocity, w lifetime
in vec4 aPar;
out vec3 ePos;
out vec4 eVel;
out vec4 ePar;
void main(){
  ePos = aPos; eVel = aVel; ePar = aPar;
  gl_PointSize = 1.0;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const emitFrag = /* glsl */ `
precision highp float;
in vec3 ePos;
in vec4 eVel;
in vec4 ePar;
layout(location = 0) out vec4 oPos;
layout(location = 1) out vec4 oVel;
layout(location = 2) out vec4 oPar;
void main(){
  oPos = vec4(ePos, 0.0);
  oVel = eVel;
  oPar = ePar;
}
`;

/* ------------------------------------------------------------------ *
 *  Render
 * ------------------------------------------------------------------ */

export const drawVert = /* glsl */ `
precision highp float;
${GLSL.common}
${SHARED_UNIFORM_DECL}
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
attribute vec3 position;
attribute float aId;
uniform sampler2D tPos;
uniform sampler2D tVel;
uniform sampler2D tPar;
uniform sampler2D tProbe;
uniform mat3 uProbeMat;
uniform float uTexSize;
uniform float uStretch;

varying vec2  vUv;
varying float vAlpha;
varying float vKind;
varying float vSeed;
varying float vLt;
varying vec3  vWorld;
varying float vWaterY;
varying float vViewZ;
varying float vFacing;

void main(){
  float col = mod(aId, uTexSize);
  float row = floor(aId / uTexSize);
  vec2 st = (vec2(col, row) + 0.5) / uTexSize;
  vec4 P = texture2D(tPos, st);
  vec4 V = texture2D(tVel, st);
  vec4 A = texture2D(tPar, st);

  if (P.w < 0.0){
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  float lt = saturate1(P.w / max(V.w, 1e-3));
  float kind = A.y;
  vKind = kind; vSeed = A.z; vLt = lt;

  // Size lifecycle. Droplets barely change; smoke inflates hard. Mist used to
  // triple, which turned spindrift into a bank of cumulus at the waterline.
  float grow = 1.0;
  if (kind > 1.5 && kind < 2.5) grow = 0.45 + 1.35 * pow(lt, 0.6);
  else if (kind > 0.5 && kind < 1.5) grow = 0.5 + 1.2 * pow(lt, 0.6);
  else if (kind > 2.5 && kind < 3.5) grow = 0.6 + 1.1 * lt;
  else if (kind > 4.5 && kind < 5.5) grow = 0.6 + 2.2 * lt;
  else if (kind > 7.5) grow = 0.30 + 2.9 * pow(lt, 0.5);
  float size = A.x * grow;

  // Opacity lifecycle: quick in, slow out, plus a per-kind ceiling.
  float fadeIn = smoothstep(0.0, 0.06, lt);
  float fadeOut = 1.0 - smoothstep(0.62, 1.0, lt);
  if (kind > 1.5 && kind < 2.5) fadeOut = 1.0 - smoothstep(0.25, 1.0, lt);
  else if (kind > 7.5) { fadeIn = smoothstep(0.0, 0.09, lt); fadeOut = 1.0 - smoothstep(0.18, 1.0, lt); }
  float alpha = fadeIn * fadeOut;

  vec3 wpos = P.xyz;
  vWorld = wpos;
  vWaterY = texture2D(tProbe, clamp((uProbeMat * vec3(wpos.xz, 1.0)).xy, vec2(0.001), vec2(0.999))).r;

  vec4 mv = viewMatrix * vec4(wpos, 1.0);
  vViewZ = -mv.z;
  vec3 vv = mat3(viewMatrix) * V.xyz;

  // Motion stretch along the screen-space velocity.
  vec2 d = vv.xy;
  float dl = length(d);
  vec2 axis = dl > 1e-4 ? d / dl : vec2(0.0, 1.0);
  bool drift = kind > 2.5 && kind < 3.5;
  bool sheet = kind > 0.5 && kind < 1.5;
  // A TORN SHEET IS NOT A BALL. Sheets took uStretch against a base size of
  // ~1 m, so 'dl * 0.028 / 1.0' gave about 1.3x elongation and every one of them
  // drew as a near-circular puff of the mist sprite — a metre-wide ball of
  // cotton wool, and there are hundreds of them at the bow. Their stretch is now
  // divided by a nominal 0.25 m instead of their own inflated radius, which is
  // what actually makes them ribbons.
  float stretchAmt = drift ? uStretch * 2.2 : (kind < 1.5 ? uStretch : uStretch * 0.25);
  float stretchRef = sheet ? 0.25 : max(size, 0.02);
  float stretch = 1.0 + min(dl * stretchAmt / stretchRef, drift ? 14.0 : (sheet ? 7.0 : 6.0));

  vec2 off = vec2(position.x * size, position.y * size * stretch);
  vec2 o = vec2(off.x * axis.y + off.y * axis.x, -off.x * axis.x + off.y * axis.y);
  mv.xy += o;
  gl_Position = projectionMatrix * mv;

  // PER-PARTICLE SPRITE VARIATION. The quad is oriented along the screen-space
  // velocity, and every particle from one emitter shares nearly that velocity —
  // so without this every sprite in the fan showed the SAME texture at the SAME
  // orientation, which is what turns an anisotropic torn rag into a field of
  // identical ovals. A rotation of up to +-0.35 rad plus a mirror in u gives
  // four visually distinct draws of the same texture and costs two multiplies.
  // The 0.80 inset keeps the rotated corners inside the sprite, where the
  // texture's alpha is ~0 anyway.
  float rot = (vSeed - 0.5) * 0.70;
  float cr = cos(rot), sr = sin(rot);
  vec2 q = mat2(cr, -sr, sr, cr) * position.xy * 0.80;
  if (fract(A.z * 7.31) > 0.5) q.x = -q.x;
  vUv = q * 0.5 + 0.5;

  // How much of the sun is coming at us through the drop.
  vec3 view = normalize(uCameraPos - wpos);
  vFacing = dot(view, -uSunDirection);
  vAlpha = alpha;
}
`;

export const drawFrag = /* glsl */ `
precision highp float;
${GLSL.common}
${GLSL.fog}
${SHARED_UNIFORM_DECL}
uniform sampler2D tDroplet;
uniform sampler2D tMist;
uniform sampler2D tFleck;
uniform sampler2D tSmoke;
uniform float uSoftY;
uniform float uOpacity;
#ifdef VFX_DEPTH_SOFT
uniform sampler2D tDepth;
uniform vec2  uInvRes;
uniform vec2  uNearFar;
#endif

varying vec2  vUv;
varying float vAlpha;
varying float vKind;
varying float vSeed;
varying float vLt;
varying vec3  vWorld;
varying float vWaterY;
varying float vViewZ;
varying float vFacing;

void main(){
  float kind = vKind;
  // DROPLET, FLECK, MOTE and GLITTER are discrete bodies of water and use the
  // droplet sprite. SHEET is torn cloth of water, not a drop, so it shades with
  // the mist path.
  bool hard = kind < 0.5 || (kind > 3.5 && kind < 4.5) || (kind > 5.5 && kind < 7.5);
  bool smoke = kind > 7.5;
  // FLECK is a raft of foam lying on the surface, not a drop in flight. It used
  // to draw with the droplet sprite — a shaded sphere — so every fleck of
  // surface foam was a round white ball with a bright rim, and a crest's worth
  // of them was a row of cotton tufts. It gets its own flat, jagged, cellular
  // sprite.
  bool fleck = kind > 3.5 && kind < 4.5;
  vec4 tx = smoke ? texture2D(tSmoke, vUv)
                  : fleck ? texture2D(tFleck, vUv)
                  : (hard ? texture2D(tDroplet, vUv) : texture2D(tMist, vUv));
  float cover = tx.a;
  if (cover < 0.004) discard;

  float thick = (hard && !smoke && !fleck) ? tx.r : tx.b;
  float rim = (hard && !fleck) ? tx.g : 0.0;
  float pip = (hard && !fleck) ? tx.b : 0.0;

  // RADIOMETRY (see the units contract in src/sky/constants.ts).
  // uSunIntensity / uMoonIntensity are IRRADIANCE and owe the material a 1/PI;
  // uSkyColor / uFogColor are RADIANCE and must not be divided again. 'sun' is
  // therefore pre-divided here and every use below multiplies it raw — leaving
  // the INV_PI off made spray and foam PI x too bright and, because foam is the
  // brightest large object in frame, it dragged auto-exposure down over the
  // whole image.
  //
  // WHAT THE COEFFICIENTS BELOW MEAN, so nobody 'tunes' them back up. A sprite is
  // an optically thin scattering slab: its emergent radiance is E/PI times the
  // NORMALISED phase function, and its optical depth is carried by 'a', not by
  // the colour. So every coefficient on 'sun' is a phase-function value and must
  // average to about 1 over the sphere — roughly 0.3..0.8 to the side and back,
  // with the large excess confined to the forward lobe, which is exactly where
  // real spray gets its glow. Values summing well above 1 in the side direction
  // (they used to reach 2.45) say "each individual droplet is brighter than a
  // sunlit sail", which is what buried the ship in white.
  vec3 sun = uSunColor * uSunIntensity * INV_PI;
  vec3 sky = uSkyColor;
  vec3 moon = uMoonColor * uMoonIntensity * INV_PI;

  // Water droplets are dielectric spheres: they scatter forward very strongly,
  // pick up a bright Fresnel rim, and carry a hot specular pip. The forward
  // lobe is dispersed, which is what makes backlit spray shimmer.
  float fwd = saturate1(vFacing);
  float lobe = pow(fwd, 3.0) * 0.5 + pow(fwd, 24.0) * 2.4;
  vec3 spectral = vec3(1.0) + vec3(-0.16, 0.03, 0.24) * (pow(fwd, 9.0) - pow(fwd, 40.0)) * 2.2;

  vec3 col;
  float a = cover * vAlpha * uOpacity;

  if (kind > 4.5 && kind < 5.5) {
    // Muzzle flash: pure emission, no shading, additive.
    col = vec3(9.0, 5.0, 1.9) * (1.0 - vLt) * (0.4 + cover);
    gl_FragColor = vec4(col * cover * vAlpha, 0.0);
    return;
  }
  if (kind > 6.5 && kind < 7.5) {
    // Sun glitter: a tiny specular chip on the surface. A mirror facet returns
    // sun *radiance*, not irradiance/PI, so this one is legitimately hot.
    float g = pow(saturate1(vFacing), 2.0);
    col = sun * (0.15 + 1.6 * g) * (0.5 + pip);
    gl_FragColor = vec4(col * cover * vAlpha, 0.0);
    return;
  }

  if (smoke) {
    // Powder smoke: dense, self-shadowing, strongly forward scattering. It
    // greys out and thins as it entrains air.
    float dens = 1.0 - 0.55 * vLt;
    float ss = pow(fwd, 2.2) * 0.55 + 0.16;
    vec3 albedo = mix(vec3(0.90, 0.89, 0.86), vec3(0.42, 0.43, 0.47), vLt * 0.7);
    col = albedo * (sun * (0.10 + 0.55 * ss * (1.0 - thick * 0.6))
                    + sky * (0.55 + 0.35 * (1.0 - thick)));
    col += moon * 0.16;
    // Kept well below 1 so a plume builds density by overlapping many
    // translucent puffs instead of each one alone saturating to white.
    a *= dens * 0.5;
  } else if (hard) {
    float wrap = 0.42 + 0.58 * saturate1(uSunDirection.y * 1.6 + 0.15);
    col = sun * wrap * (0.26 + 0.40 * thick) * spectral;
    col += sun * lobe * thick * 0.34 * spectral;
    // Sky fill on a scatterer can never exceed the radiance arriving at it.
    col += sky * (0.30 + 0.34 * rim);
    // Specular pip: a curved mirror of the disc, so scaled against radiance.
    col += sun * pip * 0.85;
    // A foam fleck is a raft of aerated water lying on the surface, not a drop in
    // flight: it is diffuse, and its albedo is the sea-foam albedo the ocean
    // surface uses (0.38), not a droplet's near-unit scattering. The bubble
    // channel varies the interior — a raft is not one flat tone, and a flat tone
    // is what made these read as paint however good the outline was.
    if (fleck) col = 0.38 * (0.72 + 0.52 * tx.r) * (sky + sun * 0.9);
    col += moon * 0.25;
  } else {
    // Mist / torn sheet: an optically thin scattering slab.
    float wrap = 0.5 + 0.5 * saturate1(uSunDirection.y * 1.3 + 0.25);
    col = sun * wrap * (0.20 + 0.34 * thick) * spectral;
    col += sun * lobe * 0.38 * (1.0 - thick * 0.5) * spectral;
    col += sky * 0.46;
    col += moon * 0.25;
    // Torn sheets and mist are the biggest sprites in the pool, so they are what
    // actually fills the frame. 0.5 let a few hundred of them stack into an opaque
    // curtain that swallowed the whole bow.
    a *= 0.30;
  }

  // Soft against the water: fade as the sprite approaches the real surface, so
  // spray dissolves into foam instead of showing a cut line.
  float above = vWorld.y - vWaterY;
  a *= smoothstep(-0.25, uSoftY, above);
  // Soft against the near plane so particles do not pop through the camera.
  a *= smoothstep(0.4, 1.6, vViewZ);

#ifdef VFX_DEPTH_SOFT
  // Soft against everything else. 'tDepth' is post's standalone 'sceneDepth'
  // copy — last frame's non-linear window depth, safe to sample inside the
  // scene pass (sampling the live attachment forms a feedback loop and the
  // driver drops the draw). Without this, spray shows a hard cut line wherever
  // it crosses the sea surface or the hull.
  float dz = texture2D(tDepth, gl_FragCoord.xy * uInvRes).r;
  float n = uNearFar.x, f = uNearFar.y;
  float sceneZ = (2.0 * n * f) / (f + n - (dz * 2.0 - 1.0) * (f - n));
  // Fade band scales with distance: at range a metre is sub-pixel, and a fixed
  // band there just makes far spray vanish.
  float band = (smoke ? 3.0 : 1.1) * (1.0 + vViewZ * 0.02);
  a *= saturate1((sceneZ - vViewZ) / band);
#endif

  vec3 view = normalize(vWorld - uCameraPos);
  col = applyAerial(col, vViewZ, view, uSunDirection, uFogColor, uSunColor,
                    uFogDensity, uCameraPos.y, vWorld.y);

  gl_FragColor = vec4(col * a, a);
}
`;
