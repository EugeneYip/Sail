import { SPECTRUM_GLSL } from '../Spectrum';
import { NOISE_HALF } from '../Noise';

const VERT = /* glsl */ `void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }`;

/**
 * Static spectrum: h0(k) and h0(-k) for one cascade, packed as
 * (h0k.re, h0k.im, h0mk.re, h0mk.im).
 *
 * Mode numbering matches `Spectrum.modeVariance` and `CpuWaves.setParams`
 * exactly — texel i carries mode n = i < N/2 ? i : i - N, and the random pair
 * for mode (n, m) is fetched from the shared noise texture at (n + 256, m + 256)
 * so that a smaller CPU grid over the same tile picks the same numbers.
 */
export const H0_SHADER = {
  vertexShader: VERT,
  fragmentShader: /* glsl */ `
precision highp float;
precision highp sampler2D;
${SPECTRUM_GLSL}
uniform sampler2D uNoise;
uniform float uN;
uniform float uSize;
uniform float uKMin;
uniform float uKMax;
uniform float uOmegaWind;
uniform float uOmegaSwell;
uniform float uVarWind;
uniform float uVarSwell;
uniform vec2  uWindDir;
uniform vec2  uSwellDir;

float ocModeVariance(vec2 kv, float dk){
  float k2 = dot(kv, kv);
  if (k2 < 1e-12) return 0.0;
  float k = sqrt(k2);
  float w = ocCascadeWeight(k, uKMin, uKMax);
  if (w <= 1e-5) return 0.0;
  vec2 nk = kv / k;
  float omega = ocDispersion(k);
  float cw = clamp(dot(nk, uWindDir), -1.0, 1.0);
  float csw = clamp(dot(nk, uSwellDir), -1.0, 1.0);
  float sWind  = uVarWind  * ocSpectrumK(k, uOmegaWind,  OC_GAMMA_WIND)
               * ocSpreadDBH(omega, uOmegaWind, acos(cw));
  float sSwell = uVarSwell * ocSpectrumK(k, uOmegaSwell, OC_GAMMA_SWELL)
               * ocSpreadSech2(OC_BETA_SWELL, acos(csw));
  return (sWind + sSwell) / k * w * w * dk * dk;
}

void main(){
  vec2 p = floor(gl_FragCoord.xy);
  vec2 mode = p - uN * step(uN * 0.5, p);
  // DC has no mean displacement, and the grid's own Nyquist row has no
  // conjugate partner inside the grid, so both must be silent.
  if (dot(mode, mode) < 0.5 || mode.x < -uN * 0.5 + 0.5 || mode.y < -uN * 0.5 + 0.5) {
    gl_FragColor = vec4(0.0);
    return;
  }
  float dk = OC_TAU / uSize;
  vec2 kv = mode * dk;
  float ap = sqrt(ocModeVariance( kv, dk) * 0.5);
  float an = sqrt(ocModeVariance(-kv, dk) * 0.5);
  vec2 np = texelFetch(uNoise, ivec2( mode + ${NOISE_HALF}.0), 0).xy;
  vec2 nn = texelFetch(uNoise, ivec2(-mode + ${NOISE_HALF}.0), 0).xy;
  gl_FragColor = vec4(ap * np, an * nn);
}
`,
};

/**
 * Time propagation plus the packing that lets one RGBA FFT chain carry four real
 * output fields. Both chains are written in one pass, as two colour attachments,
 * because the phase rotation they share is most of the pass's work.
 *
 *   chain 0 -> (Dy, Dx, Dz, dDy/dx)
 *   chain 1 -> (dDy/dz, dDx/dx, dDz/dz, dDx/dz)
 *
 * The Jacobian terms come straight out of the transform (spectrum times i*k)
 * rather than from differencing the height map, which is what keeps the normals
 * sharp and the foam mask free of stair-stepping.
 */
export const PROPAGATE_SHADER = {
  vertexShader: VERT,
  fragmentShader: /* glsl */ `
precision highp float;
precision highp sampler2D;
${SPECTRUM_GLSL}
uniform sampler2D uH0;
uniform float uN;
uniform float uSize;
uniform float uTime;
uniform float uLambda;

layout(location = 1) out highp vec4 oChainB;

vec2 cmul(vec2 a, vec2 b){ return vec2(a.x*b.x - a.y*b.y, a.x*b.y + a.y*b.x); }

void main(){
  ivec2 ip = ivec2(gl_FragCoord.xy);
  vec2 p = vec2(ip);
  vec2 mode = p - uN * step(uN * 0.5, p);
  float dk = OC_TAU / uSize;
  vec2 kv = mode * dk;
  float k = length(kv);
  if (k < 1e-6) { gl_FragColor = vec4(0.0); oChainB = vec4(0.0); return; }

  vec4 h0 = texelFetch(uH0, ip, 0);
  float ph = ocDispersion(k) * uTime;
  float cs = cos(ph), sn = sin(ph);
  // h(k,t) = h0(k)e^{iwt} + conj(h0(-k))e^{-iwt}
  vec2 h = vec2((h0.x + h0.z) * cs - (h0.y + h0.w) * sn,
                (h0.x - h0.z) * sn + (h0.y - h0.w) * cs);

  float invK = 1.0 / k;
  float lam = uLambda;
  gl_FragColor = vec4(
    h * (1.0 + lam * kv.x * invK),
    cmul(h, vec2(-kv.x, -lam * kv.y * invK)));
  oChainB = vec4(
    cmul(h, vec2(0.0, kv.y + lam * kv.x * kv.x * invK)),
    cmul(h, vec2(lam * kv.y * kv.y * invK, lam * kv.x * kv.y * invK)));
}
`,
};
