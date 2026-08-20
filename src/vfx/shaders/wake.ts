import { GLSL } from '../../util/glsl';

/**
 * Shaders that write the world-anchored wake field.
 *
 * The field is a torus: 'uv = fract((worldXZ - anchor) / size)'. The anchor only
 * ever moves in whole multiples of 'size', so the mapping is invariant and the
 * buffer never has to be resampled — no accumulated bilinear smear, and a
 * floating-origin shift costs nothing.
 */

/**
 * Decay pass. One fullscreen quad with a multiplicative blend:
 *   dst.rgb = dst.rgb * src.rgb,  dst.a = dst.a * src.a
 * so writing (decay, 0, 0, 0) decays foam and zeroes height + slope, which the
 * ribbon then re-renders from scratch every frame.
 */
export const wakeDecayFrag = /* glsl */ `
precision highp float;
uniform float uDecay;
void main(){
  gl_FragColor = vec4(uDecay, 0.0, 0.0, 0.0);
}
`;

const trackFetch = /* glsl */ `
uniform sampler2D tTrack;
uniform float uRows;
uniform float uHead;
uniform float uSNow;
uniform float uMaxXi;
uniform vec2  uAnchor;
uniform float uWakeSize;
uniform vec2  uUvOffset;
uniform float uWakeLife;

// Track rows, all in rendered world space:
//   0: (x, z, sLaid, speed)
//   1: (tanX, tanZ, heel, maxHalf)
//   2: (rudder, valid, age, spare)
void fetchTrack(float row, out vec4 a, out vec4 b, out vec4 c){
  float idx = mod(uHead - row + uRows * 2.0, uRows);
  float u = (idx + 0.5) / uRows;
  a = texture2D(tTrack, vec2(u, 1.0 / 6.0));
  b = texture2D(tTrack, vec2(u, 3.0 / 6.0));
  c = texture2D(tTrack, vec2(u, 5.0 / 6.0));
}
`;

export const wakeRibbonVert = /* glsl */ `
precision highp float;
${trackFetch}
// position carries (trackRow, lateralParam, 0) — the real vertex position is
// built here from the track texture so only the track has to be re-uploaded.
attribute vec3 position;

varying float vXi;
varying float vEta;
varying vec2  vTan;
varying float vSpeed;
varying float vHeel;
varying float vRudder;
varying float vFade;
varying vec2  vWorld;

void main(){
  float aRow = position.x;
  float aSide = position.y;
  vec4 t0, t1, t2;
  fetchTrack(aRow, t0, t1, t2);

  float xi = max(uSNow - t0.z, 0.0);
  // Half-width must comfortably exceed the 19.47 deg cusp (tan = 0.35355) so
  // there is room to feather the rib edge to zero OUTSIDE the arms — a hard rib
  // boundary anywhere near the cusp shows up as a straight dark line drawn
  // across the sea. It must also stay inside the local turn radius or the ribs
  // fold over on the inside of a turn.
  // Named halfW because half is a reserved word in GLSL ES.
  float halfW = min(10.0 + 0.62 * xi, t1.w);
  vec2 tang = t1.xy;
  vec2 perp = vec2(tang.y, -tang.x);
  vec2 p = t0.xy + perp * (aSide * halfW);

  vXi = xi;
  vEta = aSide * halfW;
  vTan = tang;
  vSpeed = t0.w;
  vHeel = t1.z;
  vRudder = t2.x;
  // Fade at the tail of the ribbon, at its lateral edge, and by absolute age so
  // a ship that stops still sees its wake dissipate.
  float edge = 1.0 - smoothstep(0.86, 1.0, abs(aSide));
  vFade = t2.y * edge * (1.0 - smoothstep(uMaxXi * 0.7, uMaxXi, xi)) * exp(-t2.z / uWakeLife);
  vWorld = p;

  vec2 uv = (p - uAnchor) / uWakeSize + uUvOffset;
  gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
}
`;

/**
 * Kelvin ship-wave field of one submerged pressure source.
 *
 * Waves whose crest normal makes an angle t = tan(theta) with the track travel
 * at V*cos(theta), so k = k0*sec^2(theta) with k0 = g/V^2. Stationary phase for
 * a field point (xi astern, eta abeam) gives
 *     2|eta| t^2 - xi t + |eta| = 0
 * whose two roots are the transverse (small t) and divergent (large t) systems.
 * Real roots require xi^2 >= 8 eta^2, i.e. |eta|/xi <= 1/(2*sqrt2) — the
 * 19.4712 deg Kelvin half-angle, for free, with no magic numbers.
 *
 * Returns (elevation, d/dxi, d/deta) for unit source strength.
 */
const kelvin = /* glsl */ `
vec3 kelvinSource(float xi, float eta, float k0, float hs){
  if (xi <= 0.5) return vec3(0.0);
  float ae = abs(eta);
  float sgn = eta < 0.0 ? -1.0 : 1.0;
  float disc = xi * xi - 8.0 * ae * ae;
  if (disc <= 0.0) return vec3(0.0);
  float sq = sqrt(disc);
  // The divergent root is the numerically stable one; t- * t+ = 1/2.
  float tD = (xi + sq) / max(4.0 * ae, 1e-4);
  float tT = 0.5 / max(tD, 1e-4);

  float r = sqrt(xi * xi + eta * eta);
  // 1/sqrt(|phi''|): the roots merge on the cusp line, giving the bright arms.
  //
  // The clamp sets both the height AND the WIDTH of the caustic, and the width is
  // what decides whether the arm reads as a wave or as a drawn line. Stationary
  // phase is singular here, so the clamp is the only thing bounding it: at
  // 0.014 the peak was 2.9x and only ~6% of xi wide, which the ocean clipmap
  // resolves as a 2 px razor edge in the normal — and a razor edge in the normal
  // at golden hour flips the reflected sky from orange to zenith blue and draws a
  // hard line on the sea. 0.09 gives a 1.8x peak about a sixth of xi wide, which
  // is both closer to the real Airy envelope and inside what the mesh can carry.
  float caustic = pow(xi * xi / max(disc, 0.09 * xi * xi), 0.25);
  // Stationary phase is singular ON the cusp and simply undefined outside it, so
  // the raw solution steps from caustic x amp straight to zero across the cusp
  // line. That step is a hard 19.47 deg crease in both elevation and slope and
  // it read as two straight dark lines ruled across the water either side of the
  // ship. The true field decays as an Airy tail; a smooth window over the last
  // stretch of 'disc' reproduces the peak-just-inside-the-cusp look with a
  // continuous outer edge, which is what an Airy function actually does.
  caustic *= smoothstep(0.0, 1.0, disc / (0.30 * xi * xi));
  float spread = 1.0 / sqrt(1.0 + k0 * r * 0.5);

  vec3 acc = vec3(0.0);
  for (int s = 0; s < 2; s++){
    float t  = s == 0 ? tT : tD;
    float t2 = t * t;
    float rt = sqrt(1.0 + t2);
    float k  = k0 * (1.0 + t2);
    float phase = k0 * rt * (xi - ae * t);
    // A source at depth hs cannot radiate short waves — this is what makes the
    // divergent system vanish on the centreline instead of blowing up.
    float amp = exp(-k * hs) * spread * caustic * (s == 0 ? 1.0 : 0.9);
    vec2 kv = k0 * rt * vec2(1.0, -sgn * t);
    acc.x  += amp * cos(phase);
    acc.yz += -amp * sin(phase) * kv;
  }
  return acc;
}
`;

export const wakeRibbonFrag = /* glsl */ `
precision highp float;
${GLSL.common}
${kelvin}

uniform sampler2D tFoam;
uniform float uTime;
uniform float uDt;
uniform float uLwl;
uniform float uBeam;
uniform float uAmp;
uniform float uSrcDepth;
uniform float uCoreLen;
uniform float uSpeedN;
uniform float uChop;
uniform float uWakeSize;

varying float vXi;
varying float vEta;
varying vec2  vTan;
varying float vSpeed;
varying float vHeel;
varying float vRudder;
varying float vFade;
varying vec2  vWorld;

void main(){
  if (vFade <= 0.001) discard;

  float xi = vXi;
  float eta = vEta;
  float V = max(vSpeed, 1.2);
  float k0 = 9.81 / (V * V);

  // Bow source, plus a weaker stern source of opposite sign one Lpp aft. The
  // interference between the two is what gives a real ship's wake its
  // characteristic uneven transverse crests.
  vec3 kel = kelvinSource(xi, eta, k0, uSrcDepth);
  kel -= 0.6 * kelvinSource(xi - uLwl * 0.92, eta, k0, uSrcDepth * 1.15);

  // A hull at speed sits in its own hollow.
  float hollowL = exp(-sq(xi / (uLwl * 1.5)));
  float hollowW = exp(-sq(eta / (uBeam * 1.7)));
  float hollow = -0.42 * uSpeedN * hollowL * hollowW;

  float amp = uAmp * vFade;
  float height = kel.x * amp + hollow * vFade;

  // Slope in the (xi, eta) frame, rotated into world XZ. +xi points astern, so
  // the along-track world direction is -tangent.
  vec2 slopeLocal = kel.yz * amp;
  vec2 tang = vTan;
  vec2 nrm = vec2(tang.y, -tang.x);
  vec2 slopeW = (-tang) * slopeLocal.x + nrm * slopeLocal.y;
  slopeW += (-tang) * (-hollow * 2.0 * xi / sq(uLwl * 1.5)) * vFade;

  // NEAR-FIELD WINDOW ON GEOMETRY ONLY.
  //
  // The consumer adds G to the surface displacement in its VERTEX shader and BA
  // to the normal in its fragment shader. Far from the ship the ocean clipmap
  // ring is tens of metres per vertex, so a coherent signal out there is not
  // resolved as a wave — it is point-sampled into a hard-edged straight groove
  // hundreds of metres long, which reads as a black scar ruled across the water.
  // The transverse wavelength is lambda = TAU / k0, so confining the geometry to
  // a few wavelengths astern keeps it inside the dense part of the mesh and
  // scales correctly with speed. Foam (R) is deliberately NOT windowed: it is a
  // screen-space-stable coverage term, it is what should carry the trail into the
  // distance, and it costs the consumer nothing to resolve.
  float lambda = TAU / max(k0, 1e-3);
  float geoFade = 1.0 - smoothstep(3.0 * lambda, 7.0 * lambda, xi);

#ifdef WAKE_PASS_FOAM
  float aeta = abs(eta);

  // Detail sampled in world space, stretched along the track, so the foam does
  // not appear to slide forward as the ship moves.
  vec2 suv = vec2(dot(vWorld, tang) * 0.0075, dot(vWorld, nrm) * 0.042);
  vec4 fd = texture2D(tFoam, suv);
  vec4 fd2 = texture2D(tFoam, vWorld * 0.055 + vec2(uTime * 0.004, 0.0));
  float detail = fd.g * 0.55 + fd2.r * 0.45;
  float bubble = fd2.a * 0.6 + fd.r * 0.4;

  // WHY THE WEIGHTS BELOW LOOK LOPSIDED.
  // This channel is MAX-blended into a persistent buffer, so what survives at a
  // world point is the LARGEST value ever written there, not the value at the
  // current xi. A term centred on the track (hull froth, turbulent core) is
  // therefore recorded at its xi ~ 0 amplitude and then held for the whole life
  // of the trail, while a term that lives on the cusp line only ever fires as
  // that line sweeps outward past the point. Centre-line terms consequently
  // paint a uniform slab and must be kept narrow and dim; the arms cost nothing
  // and are what actually makes the wake read as a Kelvin V.

  // 1. Froth clinging to the wetted hull. A BAND along the topsides, not a
  //    filled footprint — filling it is what produced a solid white wedge.
  float hullT = linstep(uLwl * 1.06, 0.0, xi);
  float hbLocal = uBeam * 0.5 * pow(sin(PI * pow(saturate1(xi / uLwl), 0.58)), 0.62) + 0.7;
  float hullBand = exp(-sq((aeta - hbLocal) / 1.8));
  float hullFoam = hullBand * hullT * (0.55 + 0.45 * hullT);
  // A heeled ship buries the lee bow and throws far more water that side.
  float lee = sign(vHeel) * sign(eta);
  hullFoam *= 1.0 + lee * min(abs(vHeel) * 3.4, 0.85);

  // 2. Turbulent core the hull drags behind it. Deflected by the rudder. Narrow
  //    (roughly the beam), and torn into streaks rather than laid on solid.
  //
  //    LENGTH. A frigate's white turbulent core is spent within two or three
  //    ship lengths; what carries on for half a kilometre is the divergent arms
  //    and a slick, not white water. The old 0.55 * uCoreLen e-folding held the
  //    core near its peak for 150 m, and because this channel is MAX-blended
  //    into a persistent buffer that painted a continuous white slab from the
  //    stern to the far edge of the field. That slab is what read as snow.
  float washOff = -vRudder * 5.5 * linstep(uLwl * 0.75, uLwl + 45.0, xi);
  float coreW = uBeam * 0.34 + 0.8 + xi * 0.022;
  float core = exp(-pow(abs(eta - washOff) / coreW, 2.4));
  // Terminating, for the same reason as the arm below: no infinite faint tail.
  float coreLife = exp(-xi / (uCoreLen * 0.26))
                 * (1.0 - smoothstep(uCoreLen * 0.6, uCoreLen * 1.1, xi));
  float coreFoam = core * coreLife * saturate1(0.35 + 1.05 * detail);

  // 3. Breaking crests. The divergent arms break along the cusp; transverse
  //    crests break only close astern where they are still steep.
  float steep = length(slopeLocal) / max(amp, 1e-3);
  float crest = linstep(0.14, 0.42, steep) * step(0.0, kel.x);
  float cuspN = aeta / max(xi, 1.0) / 0.35355;            // 1 exactly on the cusp
  // Sit the band just INSIDE the cusp, where the Airy peak actually is.
  float cuspBand = exp(-sq((cuspN - 0.94) / 0.20));
  // Along the cusp the divergent phase advances at 0.9186 * k0 per metre, so the
  // arms are a row of separate crescents about 0.70 * V^2 metres apart, not a
  // painted line. That periodicity is the single strongest "this is a real ship
  // wake" cue in the whole effect.
  // ANY FLOOR HERE IS A DARK LINE. The previous 0.35 floor made the arm one
  // continuous band ruled hundreds of metres across the sea; dropping it to 0.06
  // was not enough, because the consumer composites foam partly by suppressing
  // the water's specular, so 0.06 is still bright enough to kill the reflection
  // and not bright enough to be white — which at golden hour and at night is a
  // thin dark line at exactly the Kelvin half-angle (DIAGNOSIS 8.5 / 17). The
  // floor is now exactly zero and the crescents are made WIDER instead
  // (exponent 2.4 -> 1.5), so the arm still reads as continuous where it is
  // bright without ever leaving a sub-visible residue where it is not.
  float armPhase = 0.9186 * k0 * xi;
  float crescent = pow(saturate1(cos(armPhase) * 0.5 + 0.5), 1.5);
  // TERMINATE THE ARM. DO NOT REPLACE THIS WITH AN EXPONENTIAL.
  //
  // 'cuspBand' is a narrow ridge, so wherever the arm's amplitude crosses the
  // consumer's visibility threshold it does so along a LINE. A consumer composites
  // foam partly by suppressing the water's specular reflection, so a value too
  // small to read as white still reads as a DARK line — and at golden hour, when
  // the reflection it suppresses is the bright orange sky, an unmistakable one.
  // That is DIAGNOSIS 8.5: three thin blue-grey lines ruled across the sea,
  // radiating from the ship at the Kelvin half-angle. An exp() tail never reaches
  // zero, so it always leaves that line somewhere; a smoothstep does, and past it
  // there is nothing to draw a line with. Anything that cannot be white must be
  // exactly nothing.
  float armTrail = 1.0 - smoothstep(uCoreLen * 1.0, uCoreLen * 2.2, xi);
  float armFoam = cuspBand * crescent * armTrail * (0.45 + 0.75 * bubble);
  float crestFoam = crest * (1.0 - smoothstep(uCoreLen * 0.30, uCoreLen * 0.75, xi))
                    * (0.5 + 0.6 * detail);

  // 4. The rudder itself sheds a short, ragged, very white wash.
  float rudW = 1.6 + xi * 0.09;
  float rud = exp(-sq((eta - washOff * 1.25) / rudW)) *
              linstep(uLwl * 0.8, uLwl * 1.05, xi) * exp(-(xi - uLwl) / 55.0) *
              (1.0 - smoothstep(uLwl * 2.4, uLwl * 4.2, xi));
  float rudFoam = rud * min(abs(vRudder) * 3.0, 1.0) * (0.4 + 0.9 * detail);

  float gate = smoothstep(0.05, 0.30, uSpeedN);
  // hullFoam 0.72 -> 0.95. This is the band clinging to the topsides — the froth
  // the owner is closest to and the one reported as too sparse. It could not be
  // raised while the consumer amplified this channel and clamped it, because the
  // band was already the first thing to saturate; the ocean surface now reads the
  // channel as COVERAGE and tears it with its own octaves, so more here buys a
  // denser torn band instead of a wider white slab.
  float foam = hullFoam * 0.95 + coreFoam * 0.62 + armFoam * 1.00 +
               crestFoam * 0.34 + rudFoam * 0.55;
  foam *= gate * vFade;
  // Chop tears the wake apart faster.
  foam *= mix(1.0, 0.72, uChop);
  // CEILING, not saturate — but the reason has changed and so has the number.
  //
  // It used to be 0.78 because the consumer amplified this channel and clamped
  // it ('saturate((foam - (breakup - 0.5) * 0.42) * 1.7)'), so anything near 1.0
  // here became a flat, pure-white, texture-free slab with no ragged edge left
  // to erode. The ocean surface now treats the channel as a COVERAGE FRACTION
  // and thresholds a flattened noise field against it, which cannot saturate an
  // area it was not given: 0.92 here reaches 0.81 coverage in the froth band,
  // i.e. four fifths solid with a fifth of clear water torn through it, and the
  // edge is decided by the ocean's own 5 cm octave rather than by this value.
  // A ceiling is still wanted so the band is never a perfect occluder.
  foam = min(foam * (0.66 + 0.5 * bubble), 0.92);

  gl_FragColor = vec4(foam, 0.0, 0.0, 0.0);
#else
  // Measured channel range with this window in place: G in about -0.7 .. +0.1 m.
  // The asymmetry is real and correct — it is the hull's own hollow, which is a
  // genuine depression and is now confined to the near field where the mesh can
  // resolve it. The Kelvin oscillation itself is only a few centimetres by the
  // time it is a wavelength or two astern.
  gl_FragColor = vec4(0.0, height * geoFade, slopeW.x * geoFade, slopeW.y * geoFade);
#endif
}
`;

/**
 * Instanced additive stamps into the wake field: spray landing, bow slams,
 * cannon splashes, heavy rain patches. Foam channel only.
 */
export const wakeStampVert = /* glsl */ `
precision highp float;
attribute vec3 position;
attribute vec4 aCentre;   // xz = world centre, z = radius, w = strength
attribute vec2 aShape;    // x = softness 0..1, y = seed
uniform vec2  uAnchor;
uniform float uWakeSize;
uniform vec2  uUvOffset;
varying vec2  vLocal;
varying float vStrength;
varying vec2  vShape;
varying vec2  vWorld;
void main(){
  vLocal = position.xy;
  vStrength = aCentre.w;
  vShape = aShape;
  vec2 p = aCentre.xy + position.xy * aCentre.z;
  vWorld = p;
  vec2 uv = (p - uAnchor) / uWakeSize + uUvOffset;
  gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const wakeStampFrag = /* glsl */ `
precision highp float;
${GLSL.common}
uniform sampler2D tFoam;
varying vec2  vLocal;
varying float vStrength;
varying vec2  vShape;
varying vec2  vWorld;
void main(){
  float r = length(vLocal);
  if (r > 1.0) discard;
  float e = pow(1.0 - r, mix(2.4, 0.7, vShape.x));
  float n = texture2D(tFoam, vWorld * 0.09 + vShape.y).a;
  gl_FragColor = vec4(vStrength * e * (0.5 + 0.9 * n), 0.0, 0.0, 0.0);
}
`;

/* ------------------------------------------------------------------ *
 *  Interaction field — fine ripples, cleared and redrawn every frame
 * ------------------------------------------------------------------ */

export const rippleVert = /* glsl */ `
precision highp float;
attribute vec3 position;
attribute vec4 aRipple;   // xy = world centre, z = age (s), w = strength
attribute vec4 aParams;   // x = outer radius, y = wavelength, z = kind, w = seed
uniform vec2  uOrigin;
uniform float uSize;
varying vec2  vLocal;
varying vec4  vR;
varying vec4  vP;
void main(){
  vLocal = position.xy;
  vR = aRipple;
  vP = aParams;
  vec2 p = aRipple.xy + position.xy * aParams.x;
  vec2 uv = (p - uOrigin) / uSize;
  gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const rippleFrag = /* glsl */ `
precision highp float;
${GLSL.common}
varying vec2 vLocal;
varying vec4 vR;
varying vec4 vP;
void main(){
  float r = length(vLocal);
  if (r > 1.0) discard;
  float R = vP.x;
  float dist = r * R;
  float age = vR.z;
  float lambda = vP.y;
  float k = TAU / lambda;
  // Deep-water capillary-ish group speed; the ring front outruns the crests.
  float c = sqrt(9.81 / k) * 0.62;
  float front = c * age;
  // Only the annulus behind the expanding front carries waves.
  float band = exp(-sq((dist - front) / max(front * 0.55 + lambda * 0.9, 0.4)));
  float decay = exp(-age * 2.2) / (1.0 + dist * 1.4);
  float phase = k * (dist - front) - age * 5.0;
  float env = band * decay * vR.w;
  float h = sin(phase) * env;
  // The impact point itself is briefly a bright dimple of aerated water.
  float splash = exp(-sq(dist / (lambda * 0.5))) * exp(-age * 6.0) * vR.w;
  float foam = (splash * 1.6 + abs(h) * 0.5) * (vP.z > 0.5 ? 1.8 : 1.0);
  // Radial slope. The envelope derivative is small next to k, so ignore it.
  float dhdr = k * cos(phase) * env;
  vec2 dir = r > 1e-4 ? vLocal / r : vec2(0.0);
  gl_FragColor = vec4(saturate1(foam), h - splash * 0.35, dhdr * dir.x, dhdr * dir.y);
}
`;
