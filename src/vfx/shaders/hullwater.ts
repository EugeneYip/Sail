import { GLSL } from '../../util/glsl';
import { SHARED_UNIFORM_DECL } from '../../core/SharedUniforms';

/**
 * The raised, breaking, foaming water the hull pushes around: the bow wave
 * sheet with its overturning lip, the quarter wave at the after shoulder, the
 * transom pad and rooster tail, and the wetted-hull skirt that carries the
 * boot-top band and the foam streaks running aft.
 *
 * All of it is parented to 'shipRoot', so it inherits the ship's visual heave,
 * pitch and roll for free. The waterline is passed in as six sampled heights
 * (port/starboard x bow/mid/stern) converted to ship-local Y, so the sheet sits
 * on the real sea surface rather than on y = 0.
 */

const hullCommon = /* glsl */ `
uniform float uBeam;
uniform float uLwl;
uniform float uSpeed;
uniform float uSpeedN;
uniform float uHeel;
uniform float uRudder;
uniform float uSlam;
uniform float uChop;
uniform vec3  uWaterPort;   // ship-local water Y at (bow, mid, stern), port side
uniform vec3  uWaterStbd;

// Waterline half-beam of a fine-bowed frigate. t = 0 at the stem, 1 at the transom.
float halfBeamAt(float t){
  float u = clamp(t, 0.0, 1.0);
  float fwd = pow(sin(PI * pow(u, 0.58)), 0.62);
  float transom = 0.42 + 0.58 * (1.0 - smoothstep(0.72, 1.0, u));
  return uBeam * 0.5 * fwd * transom;
}

// Quadratic through the three sampled water heights.
float waterYAt(float t, float side){
  vec3 w = side < 0.0 ? uWaterPort : uWaterStbd;
  float u = clamp(t, 0.0, 1.0);
  return u < 0.5
    ? mix(w.x, w.y, u * 2.0)
    : mix(w.y, w.z, (u - 0.5) * 2.0);
}

float hash1(float n){ return fract(sin(n) * 43758.5453123); }
float ruffle(float a, float b, float t){
  return sin(a * 6.13 + t * 3.7) * 0.5 + sin(a * 17.7 - t * 5.1 + b * 3.0) * 0.3
       + sin(a * 41.0 + t * 8.3) * 0.2;
}

/**
 * Metres above the LOCAL water surface that broken water reaches on the hull
 * side at station t. THIS IS THE FIX FOR THE 'SQUARE, TIDY HORIZONTAL
 * WATERFALL'.
 *
 * A moving hull does not carry a level band of foam. The bow wave breaks against
 * the forward shoulder and runs several metres UP the side; the midbody is
 * nearly dry above the boot top; the after shoulder lifts again as the buttocks
 * close in; the transom drags its own wash. The old skirt gated its foam with a
 * single 'smoothstep' on height-above-water, i.e. a cut at a CONSTANT height for
 * the whole length of the ship on both sides — a dead-level top edge with an
 * airbrushed gradient under it, which is exactly a weir lip. Nothing else in the
 * shader could recover from that, because the silhouette was decided by a
 * quantity that did not vary along the hull at all.
 *
 * At 13 kn with 10 deg of heel this returns ~3.2 m at the lee bow shoulder,
 * ~0.6 m amidships and ~1.5 m at the quarter. That variation along the length IS
 * the effect.
 */
float frothReach(float t, float side){
  float shoulder = exp(-sq((t - 0.11) / 0.115));
  float quarter  = exp(-sq((t - 0.78) / 0.155));
  float transom  = smoothstep(0.90, 1.0, t);
  // A heeled ship buries its lee bow and throws far more water that side. Held
  // to +-0.55 rather than +-0.85: at 0.85 the weather side of a hull heeled 20
  // deg went completely dry, and a weather bow at 15 kn is not dry.
  float lee = sign(uHeel) * side;
  float heelGain = 1.0 + lee * min(abs(uHeel) * 2.2, 0.55);
  // A slam is a bow event: it lifts the shoulder, not the midbody.
  float slamGain = 1.0 + min(uSlam * 0.035, 0.9) * shoulder;
  float drive = smoothstep(0.035, 0.40, uSpeedN) * (0.50 + 0.62 * uSpeedN);
  // The 0.30 base left the midbody essentially dry, so a frigate at 16 kn met
  // the sea on a bare contour with no white in it. 0.55 is about a half metre of
  // froth amidships, which is what a hull at speed actually carries, and because
  // the reach is now per-station and the edge is a texture threshold, raising it
  // cannot bring the level band back.
  float reach = 0.55 + 2.35 * shoulder + 0.80 * quarter + 0.50 * transom
              + 0.30 * uChop;
  return reach * drive * heelGain * slamGain;
}
`;

export const hullWaterVert = /* glsl */ `
precision highp float;
${GLSL.common}
${SHARED_UNIFORM_DECL}
${hullCommon}
attribute vec3 position;   // x = t along hull, y = j across sheet, z = side (-1/+1)
attribute float aPart;     // 0 = bow/quarter sheet, 1 = transom pad

uniform mat4 modelMatrix;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;

varying vec3  vWorld;
varying float vJ;
varying float vT;
varying float vSide;
varying float vAer;      // aeration 0..1
varying float vThick;
varying float vPart;
varying float vStream;   // metres travelled along the sheet, for the foam UV

void main(){
  float t = position.x;
  float j = position.y;
  float side = position.z;
  vPart = aPart;
  vT = t; vJ = j; vSide = side;

  // Stagnation rise: the height the oncoming stream would climb to if brought
  // to rest. Real bow waves reach a good fraction of it.
  float stag = uSpeed * uSpeed / 19.62;
  float wl = waterYAt(t, side);
  vec3 p;

  if (aPart < 0.5) {
    float hb = halfBeamAt(t);
    // A heeled ship buries its lee bow: that side throws far more water.
    float lee = sign(uHeel) * side;
    float heelGain = 1.0 + lee * min(abs(uHeel) * 4.2, 1.1);
    // Bow crest just aft of the stem, plus the quarter wave at the after
    // shoulder where the buttocks close in again.
    float bowBump = exp(-sq((t - 0.085) / 0.150));
    float quarter = 0.5 * exp(-sq((t - 0.80) / 0.14));
    float slamGain = 1.0 + min(uSlam * 0.05, 1.4);
    float crestRaw = stag * (0.80 * bowBump * slamGain + quarter) * heelGain
                  * smoothstep(0.03, 0.30, uSpeedN);
    // EXTENT — READ THIS BEFORE RAISING ANY COEFFICIENT HERE.
    //
    // A bow wave does not keep growing with the stagnation rise. The crest
    // breaks once it is steep enough, and for a fine-bowed hull the breaking
    // crest tops out at a fraction of the beam however hard you drive it.
    // Unbounded, which is how this read, 16 kn with 15 deg of heel and a slam
    // gave stag = 3.6 m, heelGain = 2.1, slamGain = 2.4 and therefore
    // crest = 14 m — and because the sheet's WIDTH is derived from the crest
    // (below), a plate 48 m across and 14 m tall. That is the flat white slab
    // off the bow, and it is the "wake footprint far larger than the ship".
    // Capping keeps the low-speed response linear and exact while bounding the
    // extent at something a 13 m beam can actually throw. A HYPERBOLA, not
    // '1 - exp()': the exponential is within 5% of its asymptote once the drive
    // reaches 3x the cap, so at 16 kn with heel the crest PLATEAUED at exactly
    // the cap across the whole forward tenth of the hull — a 10 m long
    // flat-topped ridge of constant height, which is half of why the bow still
    // read as a slab. The hyperbola compresses by the same factor at the peak
    // but keeps ~2.5x more contrast along t, so the crest still has a shape.
    float crestCap = uBeam * 0.17;
    float crest = crestCap * max(crestRaw, 0.0) / (crestCap + max(crestRaw, 0.0));

    float ruf = ruffle(t * 9.0 + side * 3.0, side, uTime) * (0.10 + 0.16 * uChop);
    // j = 0 at the hull/water root, 1 at the tip of the overturning lip. The lip
    // pitches further over the faster we go, which is what turns a smooth bow
    // wave into a breaking one.
    float rise = smoothstep(0.0, 0.66, j);
    float over = smoothstep(0.54, 1.0, j);
    float curl = 0.55 + 0.55 * uSpeedN;
    float y = crest * (rise * (1.0 + ruf * 0.5) - over * curl);
    // The sheet is thrown outboard and slightly aft as it climbs. The outboard
    // reach is bounded twice over: 'crest' is already capped, and heelGain is
    // clamped here as well, so the widest the sheet can get is about one beam
    // outboard of the hull — a bow wave, not a raft.
    float width = (0.75 + crest * 0.90) * min(heelGain, 1.55);
    float outb = hb + width * (j * 0.9 + over * 0.5);
    float zAft = (t + over * 0.045 * (1.0 + uSpeedN)) * uLwl - uLwl * 0.5;

    p = vec3(side * outb, wl + y, zAft);
    vAer = saturate1(0.55 + 0.45 * rise + ruf * 0.4);
    // Thin at the lip, thick at the root — drives both opacity and scattering.
    vThick = (1.0 - over * 0.75) * (0.35 + 0.65 * (1.0 - j)) * saturate1(crest * 1.5);
    vStream = t * uLwl + j * 3.0;
    vJ = j;
  } else {
    // Transom pad + rooster tail. t runs aft of the transom, j across.
    float aft = t;
    float across = j;
    float wash = -uRudder * 0.55;
    float w = uBeam * 0.52 * (1.0 + 0.25 * aft);
    float pad = exp(-aft * 2.1) * (1.0 - abs(across) * 0.35);
    float plume = exp(-sq((across - wash) / 0.3)) * exp(-sq((aft - 0.22) / 0.24));
    float ruf = ruffle(aft * 7.0 + across * 5.0, across, uTime * 1.6) * 0.2;
    float yRaw = stag * (0.5 * pad + 0.85 * plume) * (1.0 + ruf)
              * smoothstep(0.04, 0.34, uSpeedN);
    // Capped the same way as the bow crest, and for the same reasons.
    float padCap = uBeam * 0.20;
    float yr = max(yRaw, 0.0);
    float y = padCap * yr / (padCap + yr);
    // 0.34 * Lwl put the transom pad 21 m astern, which is a third of the ship
    // again on the end of it. A frigate's transom wash is spent inside 12 m.
    p = vec3(across * w, wl + y * 0.9, uLwl * 0.5 + aft * uLwl * 0.20);
    vAer = saturate1(0.52 + 0.34 * plume + ruf);
    vThick = saturate1((0.42 * pad + plume) * 1.15);
    vStream = aft * 24.0;
  }

  vec4 wp = modelMatrix * vec4(p, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

export const hullWaterFrag = /* glsl */ `
precision highp float;
${GLSL.common}
${GLSL.fog}
${SHARED_UNIFORM_DECL}
uniform sampler2D tFoam;
uniform float uSpeedN;
uniform float uOpacity;

varying vec3  vWorld;
varying float vJ;
varying float vT;
varying float vSide;
varying float vAer;
varying float vThick;
varying float vPart;
varying float vStream;

void main(){
  if (vThick < 0.004) discard;

  // Foam detail flows aft at the ship's speed relative to the hull. u runs ALONG
  // the flow, which is the axis the foam texture's filaments are stretched on.
  float flow = uTime * (2.0 + uSpeedN * 9.0);
  vec2 uvA = vec2(vStream * 0.055 - flow * 0.05, (vJ + vSide * 0.5) * 0.6);
  vec2 uvB = vec2(vStream * 0.145 - flow * 0.11, vJ * 1.7 + vSide);
  // A third, much finer octave. The sheet is a few hundred triangles, so the
  // extra tap is nothing, and without it there is no structure left to see once
  // the camera is at the rail — which is exactly where the foam was being
  // described as a mass of soft blobs.
  vec2 uvC = vec2(vStream * 0.40 - flow * 0.29, vJ * 4.6 - vSide * 0.5);
  // A fourth octave, ~5 cm per feature at the hull. It is the only tap with a
  // gradient steep enough to tear the SILHOUETTE at the pixel scale when the
  // camera is at the rail, which is the range this is now judged at.
  vec2 uvD = vec2(vStream * 1.15 - flow * 0.66, vJ * 12.0 + vSide * 0.75);
  vec4 fa = texture2D(tFoam, uvA);
  vec4 fb = texture2D(tFoam, uvB);
  vec4 fc = texture2D(tFoam, uvC);
  vec4 fd = texture2D(tFoam, uvD);
  float bubbles = fa.r * 0.32 + fb.r * 0.27 + fc.r * 0.23 + fd.r * 0.18;
  // G is the filament channel at every scale. This used to read fb.b, the
  // isotropic grain, as if it were a streak, which cost the effect its
  // directionality — half the reason the foam did not read as moving water.
  float streaks = saturate1(fa.g * 0.40 + fb.g * 0.28 + fc.g * 0.24 + fd.g * 0.22);
  float grain = fc.b * 0.40 + fb.b * 0.24 + fd.b * 0.36;

  // COVERAGE IS A THRESHOLD ON NOISE. AERATION MOVES THE THRESHOLD, NOT THE
  // FIELD. This is the whole fix for the flat white plate.
  //
  // What was here added aeration INTO the field and then thresholded the sum.
  // On the body of the sheet vAer is ~1, so the sum was ~1.2 against a threshold
  // of 0.30 and 'cover' clamped to exactly 1 over the entire surface. With the
  // texture contributing nothing, the silhouette fell through to
  // 'vThick * edge' — both vertex-interpolated, hence linear across every
  // triangle. That is why the bow sheet photographed as a hard-edged,
  // straight-sided, perfectly uniform polygon: a flat white slab off the bow.
  //
  // With aeration on the threshold instead, coverage can never saturate
  // everywhere at once: the field's own range bounds it. Fully aerated water
  // sits at a low threshold and reads as near-solid froth with holes punched in
  // it; marginal water puts the threshold through the middle of the noise and
  // breaks into filaments with the texture's gradient at every edge.
  float field = bubbles * 0.42 + streaks * 0.28 + fa.a * 0.16 + grain * 0.14;
  float aer = saturate1(vAer * (0.34 + 0.86 * vThick));
  // The lip tears: the threshold also climbs towards the free edge, so the
  // outer fringe breaks into filaments rather than ending on a smooth contour.
  float thr = mix(0.70, 0.19, aer) + 0.24 * smoothstep(0.30, 1.0, vJ);
  float cover = smoothstep(thr - 0.055, thr + 0.055, field);

  // INTERIOR STRUCTURE. A raft of whitewater is not one tone: the films between
  // the bubbles are dark, the filaments catch the light along the flow, and
  // there is large-scale variation across the whole sheet. A ragged outline
  // around a single flat value still reads as cut paper, which is what the
  // stern pad looked like.
  float tone = clamp(0.50 + 0.58 * bubbles + 0.34 * streaks - 0.26 * grain, 0.40, 1.30);

  // Aerated water is a bright, strongly forward-scattering medium.
  vec3 view = normalize(uCameraPos - vWorld);
  float sunDot = dot(view, -uSunDirection);
  float forward = pow(saturate1(sunDot), 5.0);
  // The lip is thin enough to light through, and it disperses slightly.
  vec3 disperse = vec3(1.06, 1.0, 0.92) + vec3(-0.10, 0.02, 0.16) * forward;

  // FOAM IS NOT WHITE PAINT. Broadband albedo of whitecaps and aerated water is
  // 0.4..0.55 (Koepke 1984, Frouin 1996); the ocean surface uses 0.38 for the
  // same substance. At the 0.86..0.93 this used to carry, the bow wave was
  // brighter than a sunlit sail and did not match the foam three metres away on
  // the sea, which is the tell that gives away a painted-on effect.
  vec3 albedo = mix(vec3(0.16, 0.26, 0.28), vec3(0.44, 0.47, 0.49) * tone, cover);
  // Wrap lighting: foam has no meaningful normal, it is a scattering slab.
  // uSunIntensity is irradiance and owes the 1/PI; uSkyColor / uGroundColor are
  // radiance and must not be divided again (src/sky/constants.ts).
  vec3 sun = uSunColor * uSunIntensity * INV_PI;
  float wrap = 0.55 + 0.45 * saturate1(uSunDirection.y * 1.4);
  vec3 lit = albedo * (sun * wrap * disperse
                       + uSkyColor * 0.85 + uGroundColor * 0.12);
  // Light coming THROUGH the thin part of the lip. Backlit breaking water is
  // the whole reason a bow wave reads as water rather than as paint.
  lit += sun * forward * (1.0 - vThick) * 0.40 * cover * disperse;
  lit += uMoonColor * uMoonIntensity * INV_PI * 0.2;

  // THE BREAKING EDGE. Water at the point of breaking is brightest in a thin
  // line along the crest, not uniformly across the sheet, and it is that line
  // the eye uses to tell breaking water from a painted highlight.
  //
  // Two factors, and both have to be narrow. The first picks out the coverage
  // CONTOUR — the film edge, wherever it happens to fall. The second confines it
  // to the band of j where the sheet is actually overturning: with the old
  // 'smoothstep(0.22, 0.80, vJ)' the highlight was smeared over more than half
  // the sheet's width, which is a wash, not a crest line.
  float lip = exp(-sq((field - thr) / 0.060)) * exp(-sq((vJ - 0.62) / 0.19));
  lit += sun * wrap * disperse * lip * 0.85;

  // FOAM MUST REMOVE GLOSS, NOT JUST ADD WHITE. Unbroken water is a mirror;
  // aerated water is a diffuse scattering medium with no coherent reflection. So
  // the sheet carries a sharp sun glint at its root, where the water is still a
  // coherent film, and the glint dies exactly where the foam takes over. Adding
  // brightness without taking the specular away is what makes foam read as paint.
  float gloss = (1.0 - cover) * (1.0 - smoothstep(0.12, 0.60, vJ));
  vec3 half3 = normalize(view + uSunDirection);
  // A mirror returns sun RADIANCE, so this is scaled against 'sun * PI'.
  lit += sun * PI * pow(saturate1(half3.y), 46.0) * gloss * 0.5;

  float edge = smoothstep(0.0, 0.06, vJ) * (1.0 - smoothstep(0.86, 1.0, vJ));
  if (vPart > 0.5) {
    // The pad's 'edge' only ever faded ALONG the wash, so both of its lateral
    // boundaries were hard cuts at |across| = 1 — a flat plate with two ruled
    // sides, which is what the transom photographed as from beam-on. A transom
    // wash is a wedge that frays outward: fade across as well, and narrow that
    // fade with distance astern so the wedge closes instead of running straight.
    float across = abs(vJ);
    float taper = 1.0 - 0.38 * vT;
    edge = (1.0 - smoothstep(0.45, 1.0, vT))
         * (1.0 - smoothstep(0.42 * taper, 1.0 * taper, across));
  }
  // ALPHA IS CARRIED BY THE TEXTURE, NOT BY THE INTERPOLATED THICKNESS.
  //
  // 'vThick * cover' with cover pinned at 1 made vThick the sole author of the
  // silhouette, and vThick is linear across a triangle — a straight edge. The
  // bubble term is what actually decides where this sheet ends now; vThick only
  // gates how much of it there can be. Peak is held at 0.95: a bow wave is
  // nearly opaque but never a perfect occluder, and the last 5% of the sea
  // showing through is what keeps it looking wet.
  float a = min(cover * (0.34 + 0.66 * bubbles) * (0.30 + 0.88 * vThick)
                * edge * uOpacity * 1.75, 0.95);
  if (a < 0.006) discard;

  float dist = length(uCameraPos - vWorld);
  lit = applyAerial(lit, dist, -view, uSunDirection, uFogColor, uSunColor,
                    uFogDensity, uCameraPos.y, vWorld.y);

  gl_FragColor = vec4(lit * a, a);
}
`;

/* ------------------------------------------------------------------ *
 *  Wetted hull skirt — boot-top band + foam streaks
 * ------------------------------------------------------------------ */

export const hullSkirtVert = /* glsl */ `
precision highp float;
${GLSL.common}
${SHARED_UNIFORM_DECL}
${hullCommon}
attribute vec3 position;   // x = t along hull, y = v vertical 0..1, z = side
uniform mat4 modelMatrix;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform float uSkirtDrop;   // metres the band reaches BELOW the local water
uniform float uSkirtFloor;  // ship-local Y the band may never go under
uniform float uSkirtCeil;   // ship-local Y of the rail; water cannot cling higher

varying vec3  vWorld;
varying float vT;
varying float vD;       // metres above the local water surface
varying float vSide;
varying float vStream;
varying float vEnv;     // metres of froth reach at this station

void main(){
  float t = position.x;
  float v = position.y;
  float side = position.z;
  float hb = halfBeamAt(t);
  float wl = waterYAt(t, side);
  float env = frothReach(t, side);
  vEnv = env;

  // The rows straddle the REAL water surface at every station instead of a fixed
  // ship-local band, so (a) the band can never be clipped by a straight edge in
  // ship-local Y when a crest lifts the water, and (b) every row is spent inside
  // the strip that is actually shaded rather than most of them sitting in dry
  // air amidships.
  float y = clamp(wl + mix(-uSkirtDrop, env * 1.35 + 0.45, v), uSkirtFloor, uSkirtCeil);
  // Flare the section slightly above the waterline, like real topsides.
  float flare = 1.0 + max(y, 0.0) * 0.035;
  vec3 p = vec3(side * (hb * flare + 0.09), y, t * uLwl - uLwl * 0.5);

  vT = t; vSide = side;
  vD = y - wl;
  vStream = t * uLwl;
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

export const hullSkirtFrag = /* glsl */ `
precision highp float;
${GLSL.common}
${GLSL.fog}
${SHARED_UNIFORM_DECL}
uniform sampler2D tFoam;
uniform float uSpeedN;
uniform float uOpacity;
uniform float uChop;

/**
 * Depth, in metres below the local water, over which what the band draws has to
 * be gone. Two scales because they are two different physical things: the
 * entrained air alongside a hull at speed is a free-surface effect a few tens of
 * centimetres deep, while the plating stays visibly wet and dark a little
 * further under. Both are ABSOLUTE depths and not fractions of the froth reach —
 * how high a hull throws its bow wave says nothing about how far the surface
 * drags bubbles down.
 */
const float FROTH_SINK_M = 0.35;
const float WETTED_SINK_M = 0.55;

/**
 * The froth threshold's three stops, in units of 'streakField' and chosen
 * against its measured histogram (see the note at the threshold itself).
 * THR_WET is the wetted line, THR_TORN the top of the froth reach, THR_DRY the
 * value the submerged ramp climbs to — which must clear the field's maximum of
 * 1.006 by more than the 0.075 ramp half-width.
 */
const float THR_WET = 0.20;
const float THR_TORN = 0.72;
const float THR_DRY = 1.15;

varying vec3  vWorld;
varying float vT;
varying float vD;
varying float vSide;
varying float vStream;
varying float vEnv;

void main(){
  float flow = uTime * (1.5 + uSpeedN * 11.0);
  // Streaks are long along the hull and thin vertically. Three scales: this is
  // the surface the owner is closest to, so it is the one that most needs detail
  // that survives magnification.
  vec2 uvA = vec2(vStream * 0.028 - flow * 0.055, vD * 0.22 + vSide * 0.5);
  vec2 uvB = vec2(vStream * 0.085 - flow * 0.13, vD * 0.55 + vSide);
  vec2 uvC = vec2(vStream * 0.25 - flow * 0.33, vD * 1.7 + vSide * 0.25);
  // Fourth scale, ~4 cm per feature. The topsides are the surface the camera
  // gets closest to, so this is where the finest tap earns its keep.
  vec2 uvD = vec2(vStream * 0.78 - flow * 0.92, vD * 5.4 + vSide * 0.75);
  float s1 = texture2D(tFoam, uvA).g;
  // Was tFoam.b — the isotropic grain channel — which produced blotches
  // instead of streaks. All four taps now read the filament channel.
  float s2 = texture2D(tFoam, uvB).g;
  float s3 = texture2D(tFoam, uvC).g;
  vec4 fd = texture2D(tFoam, uvD);
  float s4 = fd.g;
  float bub = texture2D(tFoam, uvB * vec2(2.0, 3.0)).r * 0.55 + fd.r * 0.45;
  float grain = texture2D(tFoam, uvC).b;

  // Boot top: the strip that has just been wetted, riding the local surface. The
  // wetted line on a real hull is a sharp, ragged edge; a plain gradient over
  // half a metre reads as an airbrushed band. Two scales of displacement, the
  // finer one unconditional, because at +-14 cm of wobble on a soft ramp the
  // edge was still smooth at the rail.
  float wetEdge = (grain - 0.5) * (0.16 + 0.26 * uChop) + (fd.b - 0.5) * 0.09;
  // NOTHING THIS BAND DRAWS BELONGS MORE THAN A FOOT UNDER THE WATER.
  //
  // The band straddles the local surface by 'uSkirtDrop' (2.4 m) so that a crest
  // lifting the water cannot expose a straight cut along its bottom. That is the
  // only job the submerged rows have: below the wetted line the SEA is drawing
  // the water and the hull is drawing the hull, and anything this band adds there
  // is paint over both. This limit has now been wrong twice in the same way: it
  // was 'step(-1.6, vD)', a hard cut at a constant depth, and the fix for that
  // was a FEATHER between a constant 2.05 and a constant 1.25 m — softer, still
  // dead level, and with 1.25 m of solid band standing above it. 'submerged' then
  // ran at a flat 1.0 from 0.9 m down to the floor on top of that. Softening a
  // ruled line does not stop it being ruled; putting it where the water is does.
  // Both are now spent inside the strip the surface has actually wetted, and the
  // same textured displacement rides the lower boundary as the upper one.
  float wetSink = saturate1((-vD + wetEdge) / WETTED_SINK_M);
  float wetBand = (1.0 - smoothstep(0.0, 0.13 + uChop * 0.22, vD + wetEdge))
                  * (1.0 - wetSink);
  float submerged = (1.0 - smoothstep(-0.9, 0.05, vD)) * (1.0 - wetSink);

  // FOAM STREAKS, AND AN EDGE THAT IS NOT A LINE.
  //
  // 'vEnv' is the froth reach at this station (see frothReach) — several metres
  // at the bow shoulder, half a metre amidships. One extra tap, whose v depends
  // only on the side, undulates that reach ALONG the hull as it scrolls aft, so
  // the boundary is a moving irregular contour rather than a ruled line. The
  // height is then normalised by it and used to drive the THRESHOLD on the
  // filament field, not to multiply the result: near the water the threshold is
  // low and the froth is near-solid; approaching the reach only the strongest
  // filaments survive, so the top of the band tears into streaks carrying the
  // texture's own gradient at every edge. A multiplied 'climb' ramp — which is
  // what was here — can only ever produce a fade, and a fade at a constant
  // height is the tidy waterfall lip the owner reported.
  float undulate = texture2D(tFoam, vec2(vStream * 0.034 - flow * 0.048,
                                         vSide * 0.37 + 0.11)).a;
  float reach = max(vEnv * (0.45 + 1.05 * undulate), 0.05);
  float above = saturate1(vD / reach);
  float streakField = s1 * 0.36 + s2 * 0.26 + s3 * 0.20 + s4 * 0.24;
  // THE THRESHOLD HAS TO KEEP CLIMBING BELOW THE WATER, AND IT HAS TO STAY
  // INSIDE THE FIELD ABOVE IT. THIS IS THE FIX FOR THE FLAT PALE PLATE ALONG THE
  // WATERLINE, AND IT IS §40's MECHANISM ONE MODULE OVER.
  //
  // 'above' saturates, so it returned 0 for EVERY fragment at or below the local
  // water — 52.9% of the band's area, measured — and the whole submerged strip
  // was thresholded at the ramp's floor. Integrated against the real 256^2 bake
  // ('.tmp/skirtint.mjs'), 0.20 is this field's own 25th PERCENTILE: 75% of it
  // clears the threshold, and the submerged strip rendered a mean alpha of 0.72
  // at sd 0.29 — a near-uniform three-quarter wash of whitewater 2.4 m deep and
  // 53 m long, bounded underneath by the 'uSkirtFloor' clamp, which is a
  // dead-level line in ship-local Y. A uniform partial wash inside a smooth
  // contour is a flat pale plate; a threshold that lands outside the field's
  // informative range is not a threshold, it is a constant, and then the
  // silhouette falls through to the geometry's own boundary.
  //
  // Measured quantiles of streakField over 57600 samples of the real bake:
  //   p05 0.043  p25 0.200  p50 0.331  p75 0.465  p95 0.661  max 1.006
  // so the old top of 0.94 was past the maximum: the froth 'frothReach' places
  // ABOVE the water rendered 0.06 coverage at half a metre and 0.003 above
  // 1.6 m — nothing at all. Every scrap of white this band produced was under
  // the water, where it had no business being, and none of it was where the
  // reach put it. THR_TORN is inside the field so the reach renders; THR_DRY
  // clears the field's maximum by more than the ramp's half-width, so the
  // submerged tail is EXACTLY zero and not merely nearly zero. Nearly zero over
  // 53 m of hull is what a plate is made of.
  float sink = saturate1(-vD / FROTH_SINK_M);
  float thr = mix(THR_WET, THR_TORN, pow(above, 0.68)) + sink * (THR_DRY - THR_WET);
  // Intensity follows the reach too: bright where the water is being torn at the
  // shoulders, thin along the midbody. The old 'bowGain' floored at 0.35 for
  // everything aft of t = 0.25, which is what made the band uniform end to end.
  float gain = 0.36 + 0.95 * saturate1(vEnv * 0.55);
  float streak = smoothstep(thr - 0.075, thr + 0.075, streakField)
                 * (0.42 + 0.78 * bub) * gain;
  // A real hull carries a near-continuous white lip exactly at the wetted line
  // whatever else is happening further up. At 0.18 there was none, so the water
  // met the plating on a bare contour with no froth in it at all.
  float foamA = min(streak * smoothstep(0.05, 0.32, uSpeedN)
                    + wetBand * (0.30 + 0.62 * bub) * 0.42 * uSpeedN, 0.90);
  // The transom is a flat face with its own wash behind it; ending the side band
  // on a vertical cut there reads as a seam.
  foamA *= 1.0 - 0.55 * smoothstep(0.945, 1.0, vT);
  // THE BREAKING EDGE. Water at the point of breaking is brightest in a thin
  // line along the film edge, not uniformly over the froth, and that line is
  // what the eye uses to tell breaking water from a painted highlight. Picked
  // out as the coverage CONTOUR (wherever the threshold happens to cut the
  // field) and confined to the upper half of the band, which is where the sheet
  // is actually tearing rather than merely wet.
  float lip = exp(-sq((streakField - thr) / 0.055))
            * smoothstep(0.22, 0.72, above) * smoothstep(0.05, 0.35, uSpeedN);

  vec3 view = normalize(uCameraPos - vWorld);
  float wrap = 0.5 + 0.5 * saturate1(uSunDirection.y * 1.5);
  vec3 sun = uSunColor * uSunIntensity * INV_PI;
  // Same foam albedo as the bow sheet and the ocean surface — see the note there.
  // The bubble raft modulates it: a raft is not one flat tone.
  vec3 foamCol = vec3(0.44, 0.47, 0.49) * (0.82 + 0.30 * bub)
                 * (sun * wrap + uSkyColor * 0.9);
  foamCol += sun * wrap * lip * 0.55;
  // FOAM KILLS GLOSS. Aerated water scatters; it does not reflect. So foam has to
  // take the specular AWAY, not merely add white over the top of it — and where
  // the foam is only partial it roughens what is left, so the lobe widens as it
  // dims rather than staying a hard pinpoint.
  float glossy = 1.0 - 0.94 * foamA;
  float lobe = mix(8.0, 26.0, glossy);
  // Wet paint: darker, much glossier. A mirror returns sun RADIANCE, so this
  // term is scaled against 'sun * PI', not 'sun'.
  float spec = pow(saturate1(dot(reflect(-uSunDirection, vec3(0.0, 1.0, 0.0)), view)), lobe);
  vec3 wetCol = uSkyColor * (0.55 - 0.16 * foamA) + sun * spec * 7.0 * glossy;

  float wetA = (wetBand * 0.5 + submerged * 0.34) * (0.35 + 0.65 * uWetness * 0.5 + 0.4);
  wetA = saturate1(wetA * uOpacity);
  foamA = saturate1(foamA * uOpacity);

  float a = foamA + wetA * (1.0 - foamA);
  if (a < 0.004) discard;
  // Aerial perspective must be applied to the UN-premultiplied colour: the
  // inscatter inside applyAerial adds a sun glow that is NOT scaled by alpha, so
  // pre-scaling only the fog colour by 'a' (which is what was here) left that
  // glow at full strength on a nearly transparent band.
  vec3 rgb = (foamCol * foamA + wetCol * wetA * (1.0 - foamA)) / a;

  float dist = length(uCameraPos - vWorld);
  rgb = applyAerial(rgb, dist, -view, uSunDirection, uFogColor, uSunColor,
                    uFogDensity, uCameraPos.y, vWorld.y);
  gl_FragColor = vec4(rgb * a, a);
}
`;
