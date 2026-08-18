import { GLSL } from '../../util/glsl';
import { POST_COMMON } from './common';

/**
 * FXAA 3.11-style quality path, adapted for an HDR input.
 *
 * Edge detection on raw radiance is useless — a 40:1 radiance ratio that
 * tonemaps to a 2:1 display ratio would read as a hard edge. Luma is therefore
 * taken through the reversible Karis compression and a square root, which is a
 * decent stand-in for the display transfer function, and the final blend is
 * done in the same compressed space so a bright sample cannot dominate.
 */
export const FXAA_FRAG = /* glsl */ `
precision highp float;
${GLSL.common}
${POST_COMMON}
uniform sampler2D tColor;
uniform vec2 uTexelSize;
uniform float uSubpix;        // 0..1 sub-pixel aliasing removal
uniform float uEdgeThreshold; // 0.125 default
uniform float uEdgeThresholdMin;
varying vec2 vUv;

#define FXAA_STEPS 12

vec3 fetch(vec2 uv) { return tmap(max(texture2D(tColor, uv).rgb, vec3(0.0))); }
float lum(vec3 c) { return sqrt(lwLuminance(c)); }

/**
 * Progressively longer strides — the reason FXAA 3.11 resolves long shallow
 * edges (a backstay against the sky) instead of just dimpling them.
 */
float strideAt(int i) {
  if (i < 4) return 1.0;
  if (i == 4) return 1.5;
  if (i < 9) return 2.0;
  if (i == 9) return 4.0;
  return 8.0;
}

void main() {
  vec2 rcp = uTexelSize;
  vec3 rgbM = fetch(vUv);
  float lumaM = lum(rgbM);
  float lumaN = lum(fetch(vUv + vec2(0.0, -rcp.y)));
  float lumaS = lum(fetch(vUv + vec2(0.0,  rcp.y)));
  float lumaW = lum(fetch(vUv + vec2(-rcp.x, 0.0)));
  float lumaE = lum(fetch(vUv + vec2( rcp.x, 0.0)));

  float rangeMin = min(lumaM, min(min(lumaN, lumaS), min(lumaW, lumaE)));
  float rangeMax = max(lumaM, max(max(lumaN, lumaS), max(lumaW, lumaE)));
  float range = rangeMax - rangeMin;

  if (range < max(uEdgeThresholdMin, rangeMax * uEdgeThreshold)) {
    gl_FragColor = vec4(tunmap(rgbM), 1.0);
    return;
  }

  float lumaNW = lum(fetch(vUv + vec2(-rcp.x, -rcp.y)));
  float lumaNE = lum(fetch(vUv + vec2( rcp.x, -rcp.y)));
  float lumaSW = lum(fetch(vUv + vec2(-rcp.x,  rcp.y)));
  float lumaSE = lum(fetch(vUv + vec2( rcp.x,  rcp.y)));

  float lumaNS = lumaN + lumaS;
  float lumaWE = lumaW + lumaE;
  float edgeH = abs(-2.0 * lumaW + lumaNW + lumaSW)
              + abs(-2.0 * lumaM + lumaNS) * 2.0
              + abs(-2.0 * lumaE + lumaNE + lumaSE);
  float edgeV = abs(-2.0 * lumaN + lumaNW + lumaNE)
              + abs(-2.0 * lumaM + lumaWE) * 2.0
              + abs(-2.0 * lumaS + lumaSW + lumaSE);
  bool horzSpan = edgeH >= edgeV;

  float luma1 = horzSpan ? lumaN : lumaW;
  float luma2 = horzSpan ? lumaS : lumaE;
  float grad1 = luma1 - lumaM;
  float grad2 = luma2 - lumaM;
  bool is1Steepest = abs(grad1) >= abs(grad2);
  float gradScaled = 0.25 * max(abs(grad1), abs(grad2));

  float stepLength = horzSpan ? rcp.y : rcp.x;
  float lumaLocalAvg = 0.0;
  if (is1Steepest) { stepLength = -stepLength; lumaLocalAvg = 0.5 * (luma1 + lumaM); }
  else             { lumaLocalAvg = 0.5 * (luma2 + lumaM); }

  vec2 currentUv = vUv;
  if (horzSpan) currentUv.y += stepLength * 0.5;
  else          currentUv.x += stepLength * 0.5;

  vec2 offset = horzSpan ? vec2(rcp.x, 0.0) : vec2(0.0, rcp.y);
  vec2 uv1 = currentUv - offset;
  vec2 uv2 = currentUv + offset;
  float lumaEnd1 = lum(fetch(uv1)) - lumaLocalAvg;
  float lumaEnd2 = lum(fetch(uv2)) - lumaLocalAvg;
  bool reached1 = abs(lumaEnd1) >= gradScaled;
  bool reached2 = abs(lumaEnd2) >= gradScaled;
  if (!reached1) uv1 -= offset;
  if (!reached2) uv2 += offset;

  if (!reached1 || !reached2) {
    for (int i = 2; i < FXAA_STEPS; i++) {
      if (!reached1) lumaEnd1 = lum(fetch(uv1)) - lumaLocalAvg;
      if (!reached2) lumaEnd2 = lum(fetch(uv2)) - lumaLocalAvg;
      reached1 = reached1 || abs(lumaEnd1) >= gradScaled;
      reached2 = reached2 || abs(lumaEnd2) >= gradScaled;
      if (reached1 && reached2) break;
      float q = strideAt(i);
      if (!reached1) uv1 -= offset * q;
      if (!reached2) uv2 += offset * q;
    }
  }

  float dist1 = horzSpan ? (vUv.x - uv1.x) : (vUv.y - uv1.y);
  float dist2 = horzSpan ? (uv2.x - vUv.x) : (uv2.y - vUv.y);
  bool isDir1 = dist1 < dist2;
  float distFinal = min(dist1, dist2);
  float edgeLength = dist1 + dist2;
  float pixelOffset = -distFinal / max(edgeLength, 1e-6) + 0.5;

  bool isLumaMSmaller = lumaM < lumaLocalAvg;
  bool correctVariation = ((isDir1 ? lumaEnd1 : lumaEnd2) < 0.0) != isLumaMSmaller;
  float finalOffset = correctVariation ? pixelOffset : 0.0;

  // Sub-pixel aliasing: a lone bright pixel has no long edge to follow, so fall
  // back to a filtered average weighted by how isolated it is.
  float lumaAvg = (1.0 / 12.0) * (2.0 * (lumaNS + lumaWE) + lumaNW + lumaNE + lumaSW + lumaSE);
  float subPixOffset = saturate1(abs(lumaAvg - lumaM) / max(range, 1e-6));
  subPixOffset = (-2.0 * subPixOffset + 3.0) * subPixOffset * subPixOffset;
  finalOffset = max(finalOffset, subPixOffset * subPixOffset * uSubpix);

  vec2 finalUv = vUv;
  if (horzSpan) finalUv.y += finalOffset * stepLength;
  else          finalUv.x += finalOffset * stepLength;

  gl_FragColor = vec4(tunmap(fetch(finalUv)), 1.0);
}
`;
