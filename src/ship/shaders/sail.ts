/**
 * The sail deformation, done entirely in the vertex shader.
 *
 * Every sail is the same unit (u, v) grid, instanced once per sail. The shape
 * comes from four corner uniforms per sail, so the whole suit of canvas is one
 * draw call plus one shadow draw call — and, more usefully, any sail can be
 * evaluated at any (u, v), which is what lets the normal be taken by difference
 * of the *final* deformed surface instead of being interpolated from the flat
 * cut. Camber, folds and the furled bundle therefore all shade correctly.
 *
 * (u, v) is (chord, span): u = 0 at the port leech of a square sail or at the
 * luff of a fore-and-aft sail, v = 0 at the head. Internally the pair is
 * swapped into (p, q), where p runs ALONG the spar the sail furls to and q runs
 * ACROSS it — so one piece of code furls a square sail to its yard and a jib to
 * its stay.
 *
 * Four things are stacked on the flat cut, in this order:
 *
 *   1. FURL. The first (1 - set) of q is rolled into a bundle lashed to the
 *      spar and the remaining cloth is compressed into the hoist that is left.
 *      set = 1 leaves the sail alone, set = 0 puts every vertex in the roll, and
 *      the values between read as reef bands. Nothing is ever scaled to zero.
 *   2. CAMBER. A membrane aerofoil: draft deepest ~40% aft of the luff, flatter
 *      at head and foot where the bolt ropes hold it, driven by the signed
 *      'camber' the rig solver writes every frame.
 *   3. SHIVER. As 'luff' rises the circulation has collapsed, so the camber goes
 *      with it while folds travel aft from the luff and the cloth bags and
 *      drops. Physics supplies a hysteretic signal, so it is smooth both ways.
 *   4. BREATHING. A tiny slow ripple even on a full sail, so a drawing rig is
 *      never a static shell.
 */

import { lwFloat } from '../../util/glsl';
import { RIG_FEATHER_M, RIG_KNEE_M, RIG_N, RIG_SLOTS } from '../build/rigEnvelope';

/** Draft position along the chord: sin(PI * c^k) peaks at the k-th root of 1/2. */
const DRAFT_AT = 0.4;
const DRAFT_EXP = Math.log(0.5) / Math.log(DRAFT_AT);
/**
 * Belly depth as a fraction of the chord at camber = 1.
 *
 * `Aero.ts` writes `camber = sgn * (0.05 + 0.35 * fill) * set`, so the deepest
 * draft a sail can carry is 0.40 times this. It used to be 0.42, i.e. 17 per
 * cent of the chord — nearly double what a square sail stands, and the single
 * biggest cause of the owner's "ropes pass through the sails": on a 26 m course
 * chord that is a 4.4 m belly, which reaches the lower shrouds when it goes aft
 * and the fore braces and the mast stays when it goes forward. Measured with
 * `.tmp/ropesail.mjs`, bringing it to a real 11 per cent removes most of the
 * intersections on its own, without moving a single rope.
 */
const CAMBER_GAIN = 0.275;
/**
 * Radius of a fully gathered bundle as a fraction of the sail's hoist, and the
 * hard cap in metres.
 *
 * The fraction alone is wrong dimensionally — the cloth of a deep course is
 * spread along the whole length of its yard, so the roll's radius grows far
 * more slowly than its hoist does. Uncapped it gave the main course a 0.98 m
 * radius: a two-metre-thick sausage that swallowed the yard, its footropes and
 * every stirrup. A furled course is about a metre through.
 */
const BUNDLE_R = 0.078;
const BUNDLE_R_MAX_M = 0.5;
/**
 * Turns of canvas in a fully gathered bundle. The whole roll is resolved by the
 * span rows of the grid — 15 of them at high quality — so 2.2 turns gave under
 * seven samples per turn and the bundle faceted into hard alternating bands
 * instead of reading as rolled cloth. Keep this under about a sixth of the row
 * count or the spiral aliases.
 */
const BUNDLE_TURNS = 1.2;
/** Gaskets across the spar that pinch the bundle in. */
const GASKETS = 4;
/**
 * Folds in a shivering sail, in cycles across the chord. Fixed in CHORD
 * fractions rather than metres so the grid always resolves them: at a
 * wavelength of a few metres a 25-vertex row aliases the folds into a flat
 * shimmer, which is exactly how a luffing sail ends up looking like nothing at
 * all happened.
 */
const FOLD_CYCLES = 2.4;
const FOLD_CYCLES_FINE = 5.3;

/**
 * Uniforms and `lwSailPoint`, shared by the cloth material, its depth material
 * and the RIGGING material — so the shadow, and any rope bound to the cloth,
 * come from the shape you can actually see.
 * Depends on: GLSL.common (for PI).
 *
 * `withInstanceAttr` declares `iSail`, which only the two cloth programs have
 * in their geometry. The rigging program must not declare it: three binds the
 * attributes its compiled program reports active, and one a driver declined to
 * strip would be looked for in a geometry that has none.
 */
export function sailDecl(count: number, withInstanceAttr = true): string {
  const n = Math.max(1, count);
  return /* glsl */ `
#ifndef SHIP_SAIL_DECL
#define SHIP_SAIL_DECL
#define SAIL_N ${n}

uniform vec3 uSailA[SAIL_N];
uniform vec3 uSailB[SAIL_N];
uniform vec3 uSailC[SAIL_N];
uniform vec3 uSailD[SAIL_N];
// set, luff, camber, flip (1 = the starboard leech is the luff on this tack)
uniform vec4 uSailState[SAIL_N];
// animated-part slot, fore-and-aft flag, roach in metres, phase seed
uniform vec4 uSailInfo[SAIL_N];
/**
 * 0 = drawing or merely slack, 1 = fully ABACK — the wind on the forward face,
 * pressing the cloth back onto the mast and the standing rigging.
 *
 * THIS IS A HOOK AND IT IS CURRENTLY ALL ZEROS. 'SailState' in
 * 'src/types/index.ts' has no aback field yet (see the note in 'build/sails.ts'
 * where this array is filled), so every term below that multiplies by 'abk'
 * multiplies by exactly 0.0 and the drawing and shivering shapes are
 * bit-identical to what they were before the hook existed. Nothing needs
 * editing when physics lands the field: the read is defensive, so the cloth
 * starts rendering aback on the next frame.
 */
uniform float uSailAback[SAIL_N];
uniform vec2 uSailStep;
uniform float uSailTime;

/**
 * The standing rigging, as something the cloth can take up against. Built in
 * 'build/rigEnvelope.ts' from the very endpoints 'build/rigging.ts' draws.
 *   uRigPlane = (A, B, C, halfWidth)  limit surface  z <= A + B*|x| + C*y
 *   uRigBand  = (P, Q, y0, y1)        its footprint: |x| within halfWidth of
 *                                     P + Q*y, and y in [y0, y1]
 */
uniform vec4 uRigPlane[${RIG_N}];
uniform vec4 uRigBand[${RIG_N}];

${withInstanceAttr ? 'attribute float iSail;' : ''}

/** Which mast's rigging a sail can reach, or -1 for the head sails and spanker. */
int lwSailRigBase(float part) {
  int p = int(part + 0.5);
  if (p >= 1 && p <= 4) return 0;
  if (p >= 5 && p <= 8) return ${RIG_SLOTS};
  if (p >= 9 && p <= 12) return ${2 * RIG_SLOTS};
  return -1;
}

/**
 * CONTACT. A course sheeted home bellies a tenth of its chord, and the shroud
 * gang it moves into is seized to the channel and cannot get out of the way — so
 * the cloth stops there, as canvas does, and goes flat where it bears.
 *
 * The alternative was a smaller camber constant, which is a lie told everywhere
 * to fix something that happens in two narrow stripes: the gang crosses a course
 * on a diagonal from outboard-low to inboard-high, so what this leaves is a fold
 * running up the sail over the lee rigging and a crease down the middle where the
 * mast prints through. Both are what a photograph of a close-hauled square
 * rigger shows, and the belly between them keeps its full depth.
 *
 * Done in SHIP space, because that is where the rigging is: the point is pushed
 * through its yard's brace first, clamped, and the correction carried back — so
 * bracing round moves the cloth into the gang and the cloth answers.
 */
vec3 lwRigContact(vec3 P, float part) {
  int base = lwSailRigBase(part);
  if (base < 0) return P;
  vec3 W = shipPart(P, part);
  float ax = abs(W.x);
  float z = W.z;
  for (int k = 0; k < ${RIG_SLOTS}; k++) {
    vec4 pl = uRigPlane[base + k];
    vec4 bd = uRigBand[base + k];
    float dx = abs(ax - (bd.x + bd.y * W.y));
    float mask = (1.0 - smoothstep(pl.w, pl.w + ${lwFloat(RIG_FEATHER_M)}, dx))
      * smoothstep(bd.z - ${lwFloat(RIG_FEATHER_M)}, bd.z, W.y)
      * (1.0 - smoothstep(bd.w, bd.w + ${lwFloat(RIG_FEATHER_M)}, W.y));
    if (mask <= 0.0) continue;
    // Soft min against the limit: the cloth begins to flatten a knee short of
    // contact, so a sail that merely comes close does not snap to the plane.
    float lim = pl.x + pl.y * ax + pl.z * W.y;
    float d = lim - z;
    const float K = ${lwFloat(RIG_KNEE_M)};
    float soft = d > K ? d : (d > -K ? (d + K) * (d + K) / (4.0 * K) : 0.0);
    z = mix(z, lim - soft, mask);
  }
  return P - shipPartNInv(vec3(0.0, 0.0, W.z - z), part);
}

/**
 * One point on a sail.
 *   aux = (chord from the port leech, span from the head, depth into the
 *          furled bundle, luff)
 *   met = (seam-space u, panel-space v, metres from the nearer chord edge,
 *          metres from the nearer span edge)
 */
vec3 lwSailPoint(int si, vec2 uv, out vec4 aux, out vec4 met) {
  vec3 A = uSailA[si];
  vec3 B = uSailB[si];
  vec3 C = uSailC[si];
  vec3 D = uSailD[si];
  vec4 st = uSailState[si];
  vec4 nf = uSailInfo[si];

  float setv  = clamp(st.x, 0.0, 1.0);
  float luffv = clamp(st.y, 0.0, 1.0);
  float camb  = st.z;
  float flip  = st.w;
  float fa    = nf.y;
  float roach = nf.z;
  float seed  = nf.w;
  float abk   = clamp(uSailAback[si], 0.0, 1.0);

  float u = clamp(uv.x, 0.0, 1.0);
  float v = clamp(uv.y, 0.0, 1.0);

  // p along the spar the sail gathers to, q across it.
  float p = mix(u, v, fa);
  float q = mix(v, u, fa);
  vec3 E00 = A;
  vec3 E10 = mix(B, D, fa);
  vec3 E01 = mix(D, B, fa);
  vec3 E11 = C;

  float gath = 1.0 - setv;
  float qs = clamp((q - gath) / max(1.0 - gath, 1e-4), 0.0, 1.0);
  float qg = qs * setv;
  float rollT = clamp((gath - q) / max(gath, 1e-4), 0.0, 1.0);

  vec3 r0 = mix(E00, E10, p);
  vec3 r1 = mix(E01, E11, p);
  vec3 s0 = mix(E00, E01, qg);
  vec3 s1 = mix(E10, E11, qg);
  vec3 P  = mix(s0, s1, p);

  float qLen = max(length(r1 - r0), 1e-3);
  float pLen = max(length(s1 - s0), 1e-3);
  float chordLen = mix(pLen, qLen, fa);
  float spanLen  = mix(qLen, pLen, fa);

  vec3 pDir = normalize(s1 - s0 + vec3(1e-5, 0.0, 0.0));
  vec3 qDir = normalize(r1 - r0 + vec3(0.0, -1e-5, 0.0));
  // Square sail: p is port to starboard and q is head to foot, so this comes out
  // +Z — the sail normal the rig solver uses at zero brace. Fore-and-aft: p is
  // head to foot and q is luff to leech, giving +X, again what the solver uses.
  // Getting this wrong points the cloth one way and the force the other.
  vec3 nrm = normalize(cross(qDir, pDir));

  // The foot is cut up in the middle so the sail clears the stay below it.
  P.y += roach * sin(PI * p) * pow(qg, 1.4);

  float cDraw = mix(p, qs, fa);
  float sDraw = mix(qs, p, fa);
  float cl = mix(cDraw, 1.0 - cDraw, flip);
  float cm = cl * chordLen;

  // Membrane aerofoil. Flat at the head where it is bent to the jackstay, still
  // fairly flat at the foot where the bolt rope and the sheets hold it.
  float chordProf = sin(PI * pow(clamp(cl, 0.0, 1.0), ${lwFloat(DRAFT_EXP)}));
  float spanProf = pow(smoothstep(0.0, 0.38, sDraw), 0.85)
                 * (1.0 - 0.3 * smoothstep(0.55, 1.0, sDraw));
  float draft = camb * chordLen * ${lwFloat(CAMBER_GAIN)} * chordProf * spanProf;
  // The free leech curls instead of being pinned flat by the profile.
  draft += camb * chordLen * 0.05 * pow(cl, 3.0) * spanProf;
  // ABACK collapses the aerofoil. A membrane pressed on its forward face cannot
  // hold a draft at all — it goes to a shallow REVERSED dish, which is why the
  // factor is negative as well as small.
  draft *= mix(1.0, -0.30, abk);
  P += nrm * draft;

  // Shivering: folds run aft from the luff, and the cloth stops carrying load.
  //
  // An aback sail is the opposite of a shivering one and this is the whole
  // point of separating the two states: slack cloth FLOGS, loudly and with big
  // travelling folds, while aback cloth is pressed hard against mast and
  // rigging and goes QUIET and taut. So aback subtracts the shake rather than
  // adding to it, and it does not let the foot drop either.
  float quiet = 1.0 - 0.88 * abk;
  float ph1 = cl * ${lwFloat(FOLD_CYCLES)} * 6.2831853 - uSailTime * 5.4 + seed * 6.2831853;
  float ph2 = cl * ${lwFloat(FOLD_CYCLES_FINE)} * 6.2831853 - uSailTime * 9.1
            + seed * 2.7 + sDraw * 2.4;
  float grow = smoothstep(0.0, 0.22, cl) * spanProf;
  float shake = sin(ph1) * 0.68 + sin(ph2) * 0.32 * smoothstep(0.3, 0.9, cl);
  P += nrm * shake * grow * luffv * chordLen * 0.085 * quiet;
  P.y -= luffv * spanLen * 0.06 * grow * quiet;

  // What replaces the belly when the sail is aback: the mast and the standing
  // rigging printing through the cloth from behind.
  //
  // A square sail taken aback wraps the lower mast, so it is held FORWARD on
  // the centreline of its yard and bags aft in two lobes either side. A
  // fore-and-aft sail has its own stay doing the same thing at the luff. Two
  // half-sine lobes about p = 0.5 give that in closed form, and because the
  // relief is a shape rather than a wobble it holds still — which is the cue
  // that says "pinned" rather than "flogging".
  float lobe = sin(PI * fract(p * 2.0)) * (1.0 - fa) + sin(PI * p) * fa;
  P -= nrm * abk * chordLen * 0.055 * lobe * spanProf;
  // Hard creases radiating from the contact, unlike the soft travelling folds
  // of a shiver: the cloth is stretched over an edge, so it kinks.
  float kink = 1.0 - smoothstep(0.0, 0.10, abs(fract(p * 2.0 + 0.5) - 0.5) * 2.0);
  P += nrm * abk * chordLen * 0.022 * kink * spanProf * (1.0 - fa);

  // A full sail still breathes.
  P += nrm * sin(cl * 7.5 + uSailTime * 1.7 + seed * 5.1)
           * (1.0 - luffv) * chordLen * 0.008 * spanProf;

  // The gathered cloth: a roll of canvas, fat in the bunt and pinched at each
  // gasket, spiralling outward so the last cloth taken in lies on top.
  float bunt = 0.55 + 0.45 * pow(max(sin(PI * p), 0.0), 0.6);
  float gask = 1.0 - 0.36 * pow(abs(cos(p * PI * ${lwFloat(GASKETS)})), 16.0);
  float R = min(spanLen * ${lwFloat(BUNDLE_R)}, ${lwFloat(BUNDLE_R_MAX_M)})
         * gath * bunt * gask;
  float rr = 0.30 + 0.70 * (1.0 - rollT);
  float ang = rollT * 6.2831853 * ${lwFloat(BUNDLE_TURNS)};
  vec3 rollP = r0 + qDir * (R - R * rr * cos(ang)) + nrm * (R * rr * sin(ang));
  P = mix(P, rollP, step(q, gath) * step(1e-4, gath));

  // Last, so it constrains whatever shape the four stages above arrived at.
  P = lwRigContact(P, nf.x);

  aux = vec4(cDraw, sDraw, rollT, luffv);
  // In METRES: (span from the head, chord from the luff, distance to the nearer
  // leech, hoist of the cloth still drawing). The fragment shader wants real
  // distances so seams, bolt ropes and reef points hold a fixed physical size
  // at any range.
  float hoistM = spanLen * setv;
  met = vec4(sDraw * hoistM, cm, min(cDraw, 1.0 - cDraw) * chordLen, hoistM);
  return P;
}
#endif
`;
}

/**
 * Everything `SAIL_VERT_BODY` writes on its way out, in ONE place.
 *
 * There are two programs that run that body — the cloth material and its
 * `MeshDepthMaterial` — and they need these names with different qualifiers: the
 * cloth material passes them to its fragment shader as `varying`, while the
 * depth material has no fragment consumer and declares them as plain
 * file-scope locals.
 *
 * They used to be written out by hand in both places, and adding 'vAback' to one
 * of them shipped a `MeshDepthMaterial` that wrote an undeclared identifier:
 * every sail shadow silently stopped compiling, and `npm run typecheck` cannot
 * see it, because `check-glsl.mjs` only looks for backticks in template text and
 * has no idea an alternate material path exists. The only thing that catches it
 * is a real compile — `node scripts/capture.mjs --console` and grep for
 * 'ERROR:'. So the list is generated from one array now, and the next varying
 * added here reaches both programs whether or not anyone remembers to.
 */
const SAIL_VERT_OUT_DECLS: readonly [string, string][] = [
  ['vec4', 'vSail'],
  ['vec4', 'vCloth'],
  ['vec2', 'vSailUv'],
  ['vec3', 'vSailWP'],
  ['vec3', 'vSailTan'],
  ['float', 'vAback'],
];

/**
 * Declarations for the values `SAIL_VERT_BODY` writes.
 * @param varying `true` for the cloth material, `false` for its depth material.
 */
export function sailVertOuts(varying: boolean): string {
  const q = varying ? 'varying ' : '';
  return SAIL_VERT_OUT_DECLS.map(([t, n]) => `${q}${t} ${n};`).join('\n');
}

/**
 * Vertex body. Evaluates the sail three times for an exact normal, then pushes
 * position and normal through the animated-part transform so a braced yard
 * carries its sail round and a sheeted jib swings about its own stay.
 * Requires the varyings 'vSail' / 'vCloth' / 'vSailWP' / 'vSailTan' / 'vAback'
 * and the locals 'vPosL' / 'vNormalL' / 'vSailUv' to be declared, and
 * 'shipPart' from PARTS_DECL.
 */
export const SAIL_VERT_BODY = /* glsl */ `
  int lwSi = int(iSail + 0.5);
  vec4 lwAux;
  vec4 lwMet;
  vec4 lwJunk;
  vec4 lwJunk2;
  vec2 lwUv = position.xy;
  // lwSailPoint clamps its parameter, so at the leech and the foot a forward
  // difference would be zero and the normal would collapse. Step inward there
  // instead and put the sign back on the cross product.
  float lwSx = lwUv.x + uSailStep.x > 1.0 ? -1.0 : 1.0;
  float lwSy = lwUv.y + uSailStep.y > 1.0 ? -1.0 : 1.0;
  vec3 lwP  = lwSailPoint(lwSi, lwUv, lwAux, lwMet);
  vec3 lwPu = lwSailPoint(lwSi, lwUv + vec2(lwSx * uSailStep.x, 0.0), lwJunk, lwJunk2);
  vec3 lwPv = lwSailPoint(lwSi, lwUv + vec2(0.0, lwSy * uSailStep.y), lwJunk, lwJunk2);
  vec3 lwN = cross(lwPv - lwP, lwPu - lwP) * (lwSx * lwSy);
  float lwNl = length(lwN);
  lwN = lwNl > 1e-9 ? lwN / lwNl : vec3(0.0, 0.0, 1.0);

  float lwPart = uSailInfo[lwSi].x;
  vPosL = shipPart(lwP, lwPart);
  vNormalL = shipPartN(lwN, lwPart);
  vSailUv = lwMet.xy;
  vSail = lwAux;
  // w carries how hard the cloth is loaded, which is what decides whether the
  // fragment shader draws tension creases at all.
  vCloth = vec4(lwMet.z, lwMet.w, uSailInfo[lwSi].y, abs(uSailState[lwSi].z));
  vSailWP = (modelMatrix * vec4(vPosL, 1.0)).xyz;
  vAback = uSailAback[lwSi];
  // World-space chord tangent, for perturbing the normal with creases. The
  // difference is taken in the same direction the normal was, so it stays
  // consistent at the leech and foot where lwSailPoint's clamp reverses the
  // step. Passing it costs one varying and saves a 2x2 derivative solve in
  // every sail fragment.
  vSailTan = normalize(mat3(modelMatrix)
    * shipPartN((lwPu - lwP) * lwSx + vec3(1e-6, 0.0, 0.0), lwPart));
`;

/** Metres of sailcloth per texture tile, along the seams and across them. */
export const SEAM_TILE_M = 2.6;
export const PANEL_TILE_M = 2.44;
/** Width of one cloth in a sail, metres. Two-foot canvas, seamed and roped. */
export const PANEL_WIDTH_M = 0.61;
