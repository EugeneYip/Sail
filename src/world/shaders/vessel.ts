import { GLSL } from '../../util/glsl';
import { SHARED_UNIFORM_DECL } from '../../core/SharedUniforms';
import { WORLD_AERIAL, WORLD_LIGHTING } from './wcommon';

/**
 * Other vessels, and the harbour town. One program, one draw per hull type,
 * with the whole ship — planking, rail, deck, masts, yards and canvas — in a
 * single geometry whose albedo is baked per vertex. That is what lets a black
 * hull, a buff gunport stripe, copper sheathing and a sunlit sail share a draw
 * call without a texture.
 *
 * Per-vertex `aAux` is (partKind, ..., ..., roughness), and the middle two
 * channels mean different things per kind because the geometry is built once
 * and there is no room for an attribute that most vertices would not use:
 *
 *   kind 0  fixed hull, deck, spar   (stripeDist m, unused)
 *   kind 1  square yard and its sail (pivotZ, bulge)
 *   kind 2  fore-and-aft sail        (pivotZ, bulge)
 *   kind 3  rope                     (side +-1, radius m)
 *
 * Per-instance:
 *   aXf (x, y, z, heading)   heading is a meteorological bearing
 *   aMo (heel, pitch, scale, brace)
 *   aBd (sheet, bulge, tint, spare)
 *
 * TWO FEATURES ARE CARRIED BY A BOX FILTER RATHER THAN BY GEOMETRY, and both
 * for the same reason: at the range a close pass actually happens, a brig has
 * ten pixels of freeboard and her rigging is a fifth of a pixel wide, so
 * anything drawn as ordinary opaque triangles is either absent or aliasing.
 *
 *   - the gunport stripe and its ports are painted in the fragment shader from
 *     the exact area of the band inside each pixel, so the stripe holds its ink
 *     down to a tenth of a pixel and is a hard edge when it is resolved
 *   - a rope is a degenerate strip widened to a pixel by the vertex shader,
 *     with its coverage taken analytically. There is NO alpha floor: an alpha
 *     floor is what made the player's own 0.2 px ratlines four times too dark.
 */

/** Shared by reference with every vessel and town material; see `Wildlife`. */
export const vesselShared = { uViewportH: { value: 900 } };

const LINE_COVERAGE = /* glsl */ `
/**
 * Exact area of a strip of half-width 'r' inside a one-pixel box centred 'd'
 * from its axis, both in pixels. The integral over d is 2r for every r, so
 * total ink is preserved at any distance and no floor is needed: a rope thinner
 * than a pixel simply gets fainter, which is what a rope thinner than a pixel
 * does.
 */
float wLineCoverage(float d, float r) {
  return clamp(min(d + 0.5, r) - max(d - 0.5, -r), 0.0, 1.0);
}

/** The same filter with an explicit pixel width 'w', for a band measured in metres. */
float wBandCoverage(float d, float r, float w) {
  return clamp((min(d + 0.5 * w, r) - max(d - 0.5 * w, -r)) / max(w, 1e-6), 0.0, 1.0);
}
`;

export const vesselVert = /* glsl */ `
precision highp float;
${SHARED_UNIFORM_DECL}
${GLSL.common}

attribute vec3 aCol;
attribute vec4 aAux;
attribute vec4 aXf;
attribute vec4 aMo;
attribute vec4 aBd;

uniform float uViewportH;

varying vec3  vWorld;
varying vec3  vNormal;
varying vec3  vCol;
varying float vDist;
varying float vCloth;
varying float vRough;
varying float vSub;
varying vec3  vPaint;   // (stripe distance m, hull-local z m, instance tint)
varying vec2  vEdge;    // (signed offset px, rope half-width px); y < 0 = not a rope

void main(){
  vec3 p = position;
  vec3 n = normal;
  float kind = aAux.x;
  float rope = step(2.5, kind);
  float cloth = (1.0 - rope) * step(0.5, kind);

  if (cloth > 0.5) {
    // A square sail bellies fore-and-aft, a fore-and-aft sail bellies sideways,
    // and both belly to leeward. The sheet angle already carries which tack she
    // is on, so its sign is what a gaff sail's belly follows.
    if (kind > 1.5) p.x -= aAux.z * abs(aBd.y) * sign(aBd.x);
    else            p.z += aAux.z * aBd.y;
    // Swing the yard or the sheet about its own mast.
    float ang = kind > 1.5 ? aBd.x : aMo.w;
    float ca = cos(ang), sa = sin(ang);
    float dz = p.z - aAux.y;
    p = vec3(p.x * ca - dz * sa, p.y, aAux.y + p.x * sa + dz * ca);
    n = vec3(n.x * ca - n.z * sa, n.y, n.x * sa + n.z * ca);
  }

  // Paint coordinates come off the REST cut, before any of the transforms, so
  // the stripe stays where it was painted whatever she is doing.
  vPaint = vec3(mix(aAux.y, 1e4, rope), position.z, aBd.z);

  p *= aMo.z;

  float cp = cos(aMo.y), sp = sin(aMo.y);
  p = vec3(p.x, p.y * cp - p.z * sp, p.y * sp + p.z * cp);
  n = vec3(n.x, n.y * cp - n.z * sp, n.y * sp + n.z * cp);
  float cr = cos(aMo.x), sr = sin(aMo.x);
  p = vec3(p.x * cr + p.y * sr, -p.x * sr + p.y * cr, p.z);
  n = vec3(n.x * cr + n.y * sr, -n.x * sr + n.y * cr, n.z);
  float cy = cos(aXf.w), sy = sin(aXf.w);
  p = vec3(p.x * cy - p.z * sy, p.y, p.x * sy + p.z * cy);
  n = vec3(n.x * cy - n.z * sy, n.y, n.x * sy + n.z * cy);

  vec3 wp = aXf.xyz + p;
  vEdge = vec2(0.0, -1.0);

  if (rope > 0.5) {
    // 'n' carries the rope's own axis for these vertices, not a surface normal.
    vec3 T = normalize(n);
    vec3 toEye = uCameraPos - wp;
    float el = length(toEye);
    vec3 V = el > 1e-4 ? toEye / el : vec3(0.0, 0.0, 1.0);
    vec3 right = cross(T, V);
    float rl = length(right);
    right = rl > 1e-3 ? right / rl : normalize(cross(T, vec3(0.0, 1.0, 0.0)) + vec3(1e-4, 0.0, 0.0));
    // 'right' is perpendicular to the view direction by construction, so it
    // lies in the screen plane and 'ppm' converts it to pixels exactly.
    float viewZ = -(viewMatrix * vec4(wp, 1.0)).z;
    float ppm = projectionMatrix[1][1] * 0.5 * uViewportH / max(0.08, viewZ);
    float rPx = aAux.z * aMo.z * ppm;
    float wPx = max(rPx + 1.0, 1.0);
    wp += right * (aAux.y * wPx / max(ppm, 1e-6));
    vEdge = vec2(aAux.y * wPx, rPx);
    // The honest average normal of a cylinder is the view direction with the
    // axial part taken out, and below two pixels of ribbon that is the only
    // normal a pixel containing the whole rope can have.
    n = V - T * dot(T, V);
    float nl = length(n);
    n = nl > 1e-4 ? n / nl : V;
  }

  vWorld = wp;
  vNormal = n;
  vCol = aCol * aBd.z;
  vDist = distance(wp, uCameraPos);
  vCloth = cloth;
  vRough = aAux.w;
  vSub = aXf.y - wp.y;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

export const vesselFrag = /* glsl */ `
precision highp float;
${SHARED_UNIFORM_DECL}
${GLSL.common}
${GLSL.brdf}
${WORLD_LIGHTING}
${WORLD_AERIAL}
${LINE_COVERAGE}

/** (rgb, half-height in metres). Half-height 0 means this hull is unpainted. */
uniform vec4 uStripe;
/** (port spacing m, port half-length m, port half-height m, half-run m). */
uniform vec4 uPorts;

varying vec3  vWorld;
varying vec3  vNormal;
varying vec3  vCol;
varying float vDist;
varying float vCloth;
varying float vRough;
varying float vSub;
varying vec3  vPaint;
varying vec2  vEdge;

void main(){
  vec3 V = normalize(uCameraPos - vWorld);
  vec3 N = normalize(vNormal);
  // Canvas is a surface with two faces and no thickness.
  if (vCloth > 0.5 && dot(N, V) < 0.0) N = -N;

  vec3 albedo = vCol;

  // --- the gunport stripe, and her ports, box-filtered onto the planking.
  //
  // Painted here rather than baked into the vertex colours because the band is
  // a quarter of a metre on a brig: at the range a close pass happens that is
  // one and a half pixels, and by half a mile it is a tenth of one. Filtered,
  // it keeps its ink all the way out and stays a hard edge close to.
  if (uStripe.w > 0.0) {
    float d = vPaint.x;
    float w = max(fwidth(d), 1e-4);
    float cov = wBandCoverage(d, uStripe.w, w);
    if (uPorts.x > 0.0) {
      // Lids are hull colour, so at range they average into the stripe and
      // darken it instead of strobing in and out of existence.
      float wz = max(fwidth(vPaint.y), 1e-4);
      float along = mod(vPaint.y + uPorts.x * 0.5, uPorts.x) - uPorts.x * 0.5;
      float pz = wBandCoverage(along, uPorts.y, wz);
      float py = wBandCoverage(d, uPorts.z, w);
      float run = 1.0 - linstep(uPorts.w, uPorts.w * 1.16, abs(vPaint.y));
      cov *= 1.0 - pz * py * run * 0.94;
    }
    albedo = mix(albedo, uStripe.rgb * vPaint.z, cov);
  }

  vec3 col = worldDirect(N, albedo, 1.0, vRough, V) + worldAmbient(N, 1.0) * albedo;

  // Sun through the cloth. A sail lit from behind is brighter than one lit from
  // in front, and getting that backwards is the fastest way to make a distant
  // ship look pasted on.
  float back = max(0.0, dot(-N, uSunDirection));
  col += albedo * uSunColor * (uSunIntensity * pow(back, 1.5) * vCloth * 1.15) * INV_PI;

  // Below her own waterline.
  float sub = linstep(0.0, 1.1, vSub);
  col = mix(col, col * vec3(0.2, 0.46, 0.54), sub * 0.8);

  col = worldAerial(col, vWorld, vDist);
  // Opaque everywhere except a rope, which contributes exactly its coverage.
  float alpha = vEdge.y < 0.0 ? 1.0 : wLineCoverage(vEdge.x, vEdge.y);
  gl_FragColor = vec4(col, alpha);
}
`;
