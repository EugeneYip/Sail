import { GLSL } from '../../util/glsl';
import { POST_COMMON } from './common';

/**
 * SMAA 1x — three passes, orthogonal patterns only (no diagonal detection),
 * against the procedural LUTs in 'luts/SmaaLuts.ts'.
 *
 * Conventions used consistently across all three passes:
 *   edges.r = there is an edge between this pixel and the one at -x
 *   edges.g = there is an edge between this pixel and the one at +y
 *   "positive side" of a horizontal edge line is +y; of a vertical line it is -x
 *     (a proper 90 degree rotation, not a reflection, so one area LUT serves both)
 *   blend.xy = (this pixel blends toward +y, the +y pixel blends toward this one)
 *   blend.zw = (this pixel blends toward -x, the -x pixel blends toward this one)
 */

/** Pass 1 — luma edge detection with local contrast adaptation. */
export const SMAA_EDGES_FRAG = /* glsl */ `
precision highp float;
${GLSL.common}
${POST_COMMON}
uniform sampler2D tColor;
uniform vec2 uTexelSize;
uniform float uThreshold;
varying vec2 vUv;

float lum(vec2 uv) { return sqrt(lwLuminance(tmap(max(texture2D(tColor, uv).rgb, vec3(0.0))))); }

void main() {
  vec2 t = uTexelSize;
  float L  = lum(vUv);
  float Lw = lum(vUv - vec2(t.x, 0.0));
  float Lu = lum(vUv + vec2(0.0, t.y));

  vec2 delta = abs(L - vec2(Lw, Lu));
  vec2 edges = step(vec2(uThreshold), delta);

  if (edges.x + edges.y > 0.0) {
    // Local contrast adaptation: an edge that is much weaker than a neighbour
    // is interior gradient, not a silhouette. Without this SMAA happily
    // "anti-aliases" the sky gradient and the water, which is pure blur.
    float Le = lum(vUv + vec2(t.x, 0.0));
    float Ld = lum(vUv - vec2(0.0, t.y));
    float Lww = lum(vUv - vec2(2.0 * t.x, 0.0));
    float Luu = lum(vUv + vec2(0.0, 2.0 * t.y));
    vec2 deltaFar = abs(vec2(Lw, Lu) - vec2(Lww, Luu));
    vec2 deltaNear = abs(L - vec2(Le, Ld));
    float maxDelta = max(max(deltaNear.x, deltaNear.y), max(deltaFar.x, deltaFar.y));
    maxDelta = max(maxDelta, max(delta.x, delta.y));
    edges *= step(0.5 * maxDelta, delta);
  }

  gl_FragColor = vec4(edges, 0.0, 1.0);
}
`;

/** Pass 2 — run search + coverage lookup. */
export const SMAA_WEIGHTS_FRAG = /* glsl */ `
precision highp float;
${GLSL.common}
uniform sampler2D tEdges;
uniform sampler2D tArea;
uniform sampler2D tSearch;
uniform vec2 uTexelSize;
uniform float uMaxDistance;
uniform float uAreaSize;
uniform float uAreaBlock;
uniform vec2 uSearchScale;   // (n-1)/n, 0.5/n
varying vec2 vUv;

float searchCode(vec2 e) {
  vec2 uv = clamp(e, 0.0, 1.0) * uSearchScale.x + uSearchScale.y;
  return floor(texture2D(tSearch, uv).x * 8.0 + 0.5);
}

vec2 areaLookup(float i1, float d1, float i2, float d2) {
  float u = (i1 * uAreaBlock + min(d1, uAreaBlock - 1.0) + 0.5) / uAreaSize;
  float v = (i2 * uAreaBlock + min(d2, uAreaBlock - 1.0) + 0.5) / uAreaSize;
  // Stored doubled: |coverage| never exceeds half a pixel.
  return texture2D(tArea, vec2(u, v)).rg * 0.5;
}

/**
 * Walk a run in one direction, two texels per bilinear tap.
 *
 * 'along' steps along the edge line, 'lean' is the small perpendicular offset
 * that keeps the continuation channel almost entirely on our own row/column
 * while still letting a crossing edge on the far side stop the search.
 * 'crossShift' is 0 when the crossing-edge channel points the same way we are
 * walking and -1 when it points the other way.
 */
float runLength(vec2 along, vec2 lean, float crossShift, bool horizontal) {
  float dist = 0.0;
  for (int s = 0; s < 6; s++) {
    if (float(s) * 2.0 >= uMaxDistance) break;
    vec2 tap = vUv + along * (1.5 + 2.0 * float(s)) + lean;
    vec2 e = texture2D(tEdges, tap).rg;
    vec2 ce = horizontal ? vec2(e.g, e.r) : vec2(e.r, e.g);
    float code = searchCode(ce);
    if (code < 0.5) break;
    if (code < 1.5) { dist += 1.0; break; }
    if (code < 2.5) { dist += 2.0; continue; }
    if (code < 3.5) {
      // One of the pair carries a crossing edge; find out which.
      vec2 near = vUv + along * (1.0 + 2.0 * float(s)) + lean;
      vec2 ne = texture2D(tEdges, near).rg;
      float nc = horizontal ? ne.r : ne.g;
      dist += (nc > 0.05 ? 1.0 : 2.0) + crossShift;
      break;
    }
    dist += 1.0 + crossShift;
    break;
  }
  return max(dist, 0.0);
}

void main() {
  vec2 t = uTexelSize;
  vec2 e = texture2D(tEdges, vUv).rg;
  vec4 weights = vec4(0.0);

  if (e.g > 0.5) {
    // Horizontal edge line along the +y boundary of this pixel.
    float d1 = runLength(vec2(-t.x, 0.0), vec2(0.0, 0.125 * t.y), 0.0, true);
    float d2 = runLength(vec2( t.x, 0.0), vec2(0.0, 0.125 * t.y), -1.0, true);
    float e1 = texture2D(tEdges, vUv + vec2(-d1 * t.x, 0.25 * t.y)).r;
    float e2 = texture2D(tEdges, vUv + vec2((d2 + 1.0) * t.x, 0.25 * t.y)).r;
    vec2 a = areaLookup(floor(4.0 * e1 + 0.5), d1, floor(4.0 * e2 + 0.5), d2);
    // a.x is coverage on the +y side: the pixel above blends down toward us.
    // a.y is coverage on our side: we blend up.
    weights.xy = vec2(a.y, a.x);
  }

  if (e.r > 0.5) {
    // Vertical edge line along the -x boundary of this pixel. Rotated frame:
    // walk in y, positive side is -x.
    float d1 = runLength(vec2(0.0, -t.y), vec2(-0.125 * t.x, 0.0), -1.0, false);
    float d2 = runLength(vec2(0.0,  t.y), vec2(-0.125 * t.x, 0.0), 0.0, false);
    float e1 = texture2D(tEdges, vUv + vec2(-0.25 * t.x, -(d1 + 1.0) * t.y)).g;
    float e2 = texture2D(tEdges, vUv + vec2(-0.25 * t.x, d2 * t.y)).g;
    vec2 a = areaLookup(floor(4.0 * e1 + 0.5), d1, floor(4.0 * e2 + 0.5), d2);
    weights.zw = vec2(a.y, a.x);
  }

  gl_FragColor = weights;
}
`;

/** Pass 3 — neighbourhood blending. */
export const SMAA_BLEND_FRAG = /* glsl */ `
precision highp float;
${GLSL.common}
uniform sampler2D tColor;
uniform sampler2D tBlend;
uniform vec2 uTexelSize;
varying vec2 vUv;

void main() {
  vec2 t = uTexelSize;
  vec4 own = texture2D(tBlend, vUv);
  float up    = own.x;
  float left  = own.z;
  float down  = texture2D(tBlend, vUv - vec2(0.0, t.y)).y;
  float right = texture2D(tBlend, vUv + vec2(t.x, 0.0)).w;

  float sumV = up + down;
  float sumH = left + right;
  if (sumV + sumH < 1e-4) {
    gl_FragColor = vec4(texture2D(tColor, vUv).rgb, 1.0);
    return;
  }

  // Only the dominant axis blends; doing both double-filters corners.
  vec3 c;
  if (sumV >= sumH) {
    vec2 w = vec2(up, down) / sumV;
    // Offsetting the sample position by the weight *is* the mix, for free.
    vec3 a = texture2D(tColor, vUv + vec2(0.0,  up   * t.y)).rgb;
    vec3 b = texture2D(tColor, vUv + vec2(0.0, -down * t.y)).rgb;
    c = a * w.x + b * w.y;
  } else {
    vec2 w = vec2(left, right) / sumH;
    vec3 a = texture2D(tColor, vUv + vec2(-left  * t.x, 0.0)).rgb;
    vec3 b = texture2D(tColor, vUv + vec2( right * t.x, 0.0)).rgb;
    c = a * w.x + b * w.y;
  }
  gl_FragColor = vec4(max(c, vec3(0.0)), 1.0);
}
`;
