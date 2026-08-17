/**
 * Shared GLSL snippets. Compose with template literals:
 *
 *   fragmentShader: `${GLSL.common}${GLSL.simplex3d}${GLSL.fbm} void main(){...}`
 *
 * Every snippet is self-contained apart from the documented dependencies, and
 * every function is guarded so including a snippet twice is harmless.
 */

const common = /* glsl */ `
#ifndef LEEWARD_COMMON
#define LEEWARD_COMMON
#define PI  3.141592653589793
#define TAU 6.283185307179586
#define INV_PI 0.3183098861837907

float saturate1(float x){ return clamp(x, 0.0, 1.0); }
vec3  saturate3(vec3 x){ return clamp(x, 0.0, 1.0); }
float sq(float x){ return x*x; }
float pow5(float x){ float x2=x*x; return x2*x2*x; }
float remap(float x, float a, float b, float c, float d){ return c + (x-a)*(d-c)/(b-a); }
float remapc(float x, float a, float b, float c, float d){ return clamp(c + (x-a)*(d-c)/(b-a), min(c,d), max(c,d)); }
float linstep(float a, float b, float x){ return saturate1((x-a)/(b-a)); }

float luminance(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

// Hashes — Dave Hoskins, "Hash without Sine".
float hash11(float p){ p = fract(p*0.1031); p *= p+33.33; p *= p+p; return fract(p); }
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*0.1031); p3 += dot(p3, p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
float hash13(vec3 p3){ p3 = fract(p3*0.1031); p3 += dot(p3, p3.zyx+31.32); return fract((p3.x+p3.y)*p3.z); }
vec2  hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*vec3(0.1031,0.1030,0.0973)); p3 += dot(p3, p3.yzx+33.33); return fract((p3.xx+p3.yz)*p3.zy); }
vec3  hash32(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*vec3(0.1031,0.1030,0.0973)); p3 += dot(p3, p3.yxz+33.33); return fract((p3.xxy+p3.yzz)*p3.zyx); }
vec3  hash33(vec3 p3){ p3 = fract(p3*vec3(0.1031,0.1030,0.0973)); p3 += dot(p3, p3.yxz+33.33); return fract((p3.xxy+p3.yxx)*p3.zyx); }

// Interleaved gradient noise — the good cheap dither for TAA / dithering.
float ign(vec2 px){ return fract(52.9829189 * fract(dot(px, vec2(0.06711056, 0.00583715)))); }

// Blue-ish noise from a screen position and a frame index.
float animatedNoise(vec2 px, float frame){
  return fract(ign(px) + frame * 0.6180339887498949);
}

// Rotate a 2D vector.
mat2 rot2(float a){ float c=cos(a), s=sin(a); return mat2(c,-s,s,c); }

// Build an orthonormal basis around n (Duff et al., branchless).
void basis(vec3 n, out vec3 t, out vec3 b){
  float s = n.z >= 0.0 ? 1.0 : -1.0;
  float a = -1.0 / (s + n.z);
  float bb = n.x * n.y * a;
  t = vec3(1.0 + s * n.x * n.x * a, s * bb, -s * n.x);
  b = vec3(bb, s + n.y * n.y * a, -n.y);
}
#endif
`;

/** 2D value-gradient (Perlin-style) noise. Depends on: common. */
const noise2d = /* glsl */ `
#ifndef LEEWARD_NOISE2D
#define LEEWARD_NOISE2D
vec2 gradDir(vec2 p){ vec2 h = hash22(p) * TAU; return vec2(cos(h.x), sin(h.x)); }
float noise2(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f*f*f*(f*(f*6.0-15.0)+10.0);
  float a = dot(gradDir(i+vec2(0,0)), f-vec2(0,0));
  float b = dot(gradDir(i+vec2(1,0)), f-vec2(1,0));
  float c = dot(gradDir(i+vec2(0,1)), f-vec2(0,1));
  float d = dot(gradDir(i+vec2(1,1)), f-vec2(1,1));
  return mix(mix(a,b,u.x), mix(c,d,u.x), u.y) * 1.4142;
}
// Analytic-derivative variant: returns (value, d/dx, d/dy).
vec3 noise2d_d(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u  = f*f*f*(f*(f*6.0-15.0)+10.0);
  vec2 du = 30.0*f*f*(f*(f-2.0)+1.0);
  vec2 ga = gradDir(i+vec2(0,0)), gb = gradDir(i+vec2(1,0));
  vec2 gc = gradDir(i+vec2(0,1)), gd = gradDir(i+vec2(1,1));
  float va = dot(ga, f-vec2(0,0)), vb = dot(gb, f-vec2(1,0));
  float vc = dot(gc, f-vec2(0,1)), vd = dot(gd, f-vec2(1,1));
  float v = va + u.x*(vb-va) + u.y*(vc-va) + u.x*u.y*(va-vb-vc+vd);
  vec2 d = ga + u.x*(gb-ga) + u.y*(gc-ga) + u.x*u.y*(ga-gb-gc+gd)
         + du * (vec2(u.y,u.x)*(va-vb-vc+vd) + vec2(vb,vc) - va);
  return vec3(v, d);
}
#endif
`;

/** Ashima/Gustavson simplex noise, 3D. Depends on: nothing. */
const simplex3d = /* glsl */ `
#ifndef LEEWARD_SIMPLEX3D
#define LEEWARD_SIMPLEX3D
vec3 sx_mod289(vec3 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
vec4 sx_mod289(vec4 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
vec4 sx_perm(vec4 x){ return sx_mod289(((x*34.0)+1.0)*x); }
vec4 sx_taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }
float snoise3(vec3 v){
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = sx_mod289(i);
  vec4 p = sx_perm(sx_perm(sx_perm(
             i.z + vec4(0.0, i1.z, i2.z, 1.0))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0)*2.0 + 1.0;
  vec4 s1 = floor(b1)*2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = sx_taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}
#endif
`;

/** fBm / ridged / turbulence over snoise3. Depends on: simplex3d. */
const fbm = /* glsl */ `
#ifndef LEEWARD_FBM
#define LEEWARD_FBM
float fbm3(vec3 p, int octaves, float lacunarity, float gain){
  float a = 0.5, s = 0.0, norm = 0.0;
  for(int i=0;i<8;i++){
    if(i>=octaves) break;
    s += a * snoise3(p);
    norm += a;
    p *= lacunarity;
    a *= gain;
  }
  return s / max(norm, 1e-5);
}
float ridged3(vec3 p, int octaves, float lacunarity, float gain){
  float a = 0.5, s = 0.0, norm = 0.0;
  for(int i=0;i<8;i++){
    if(i>=octaves) break;
    float n = 1.0 - abs(snoise3(p));
    n *= n;
    s += a * n;
    norm += a;
    p *= lacunarity;
    a *= gain;
  }
  return s / max(norm, 1e-5);
}
float turbulence3(vec3 p, int octaves){
  float a = 0.5, s = 0.0, norm = 0.0;
  for(int i=0;i<8;i++){
    if(i>=octaves) break;
    s += a * abs(snoise3(p));
    norm += a;
    p *= 2.02;
    a *= 0.5;
  }
  return s / max(norm, 1e-5);
}
#endif
`;

/** Worley / cellular noise, 3D, returns F1 and F2. Depends on: common. */
const worley3d = /* glsl */ `
#ifndef LEEWARD_WORLEY3D
#define LEEWARD_WORLEY3D
vec2 worley3(vec3 p, float freq){
  p *= freq;
  vec3 id = floor(p);
  vec3 fd = fract(p);
  float f1 = 1e9, f2 = 1e9;
  for(int k=-1;k<=1;k++)
  for(int j=-1;j<=1;j++)
  for(int i=-1;i<=1;i++){
    vec3 o = vec3(float(i), float(j), float(k));
    // Tile so the texture wraps at freq.
    vec3 cell = mod(id + o, vec3(freq));
    vec3 pt = o + hash33(cell) - fd;
    float d = dot(pt, pt);
    if(d < f1){ f2 = f1; f1 = d; }
    else if(d < f2){ f2 = d; }
  }
  return vec2(sqrt(f1), sqrt(f2));
}
// Inverted, multi-octave — the classic cloud/billow basis.
float worleyFbm3(vec3 p, float freq){
  float a = worley3(p, freq).x;
  float b = worley3(p, freq*2.0).x;
  float c = worley3(p, freq*4.0).x;
  return (1.0-a) * 0.625 + (1.0-b) * 0.25 + (1.0-c) * 0.125;
}
#endif
`;

/** Colour-space + tonemap helpers. Depends on: common. */
const color = /* glsl */ `
#ifndef LEEWARD_COLOR
#define LEEWARD_COLOR
vec3 srgbToLinear(vec3 c){
  return mix(c/12.92, pow((c+0.055)/1.055, vec3(2.4)), step(0.04045, c));
}
vec3 linearToSrgb(vec3 c){
  c = max(c, vec3(0.0));
  return mix(c*12.92, pow(c, vec3(1.0/2.4))*1.055 - 0.055, step(0.0031308, c));
}
// AgX — the modern filmic curve. Far better highlight hue retention than ACES
// approximations, which is what keeps a bright sky from going cyan.
const mat3 AGX_IN = mat3(
  0.8566271, 0.0951212, 0.0482516,
  0.1373401, 0.7612019, 0.1014577,
  0.1118377, 0.0767050, 0.8113217);
const mat3 AGX_OUT = mat3(
   1.1271006, -0.1413173, -0.1413173,
  -0.1106066,  1.1578237, -0.1106066,
  -0.0164939, -0.0164939,  1.2519364);
vec3 agxDefaultContrast(vec3 x){
  vec3 x2 = x*x, x4 = x2*x2;
  return  15.5*x4*x2 - 40.14*x4*x + 31.96*x4 - 6.868*x2*x + 0.4298*x2 + 0.1191*x - 0.00232;
}
vec3 agx(vec3 col){
  const float MIN_EV = -12.47393, MAX_EV = 4.026069;
  col = AGX_IN * max(col, vec3(0.0));
  col = clamp(log2(col + 1e-10), MIN_EV, MAX_EV);
  col = (col - MIN_EV) / (MAX_EV - MIN_EV);
  col = agxDefaultContrast(col);
  col = AGX_OUT * col;
  // Punchy look: slight saturation restore, since AgX desaturates by design.
  float l = luminance(col);
  col = mix(vec3(l), col, 1.06);
  return clamp(col, 0.0, 1.0);
}
vec3 aces(vec3 x){
  const float a=2.51,b=0.03,c=2.43,d=0.59,e=0.14;
  return clamp((x*(a*x+b))/(x*(c*x+d)+e), 0.0, 1.0);
}
// Reinhard with a white point, useful for reflections where we want no clip.
vec3 reinhardExt(vec3 x, float white){
  return (x * (1.0 + x/(white*white))) / (1.0 + x);
}
#endif
`;

/** BRDF pieces for hand-written materials. Depends on: common. */
const brdf = /* glsl */ `
#ifndef LEEWARD_BRDF
#define LEEWARD_BRDF
float D_GGX(float NoH, float a){
  float a2 = a*a;
  float d = (NoH*a2 - NoH)*NoH + 1.0;
  return a2 / max(PI*d*d, 1e-7);
}
float V_SmithGGXCorrelated(float NoV, float NoL, float a){
  float a2 = a*a;
  float lv = NoL * sqrt(NoV*NoV*(1.0-a2)+a2);
  float ll = NoV * sqrt(NoL*NoL*(1.0-a2)+a2);
  return 0.5 / max(lv+ll, 1e-7);
}
vec3 F_Schlick(vec3 f0, float u){ return f0 + (vec3(1.0)-f0)*pow5(1.0-u); }
float F_SchlickF(float f0, float f90, float u){ return f0 + (f90-f0)*pow5(1.0-u); }
float Fd_Burley(float NoV, float NoL, float LoH, float rough){
  float f90 = 0.5 + 2.0*rough*LoH*LoH;
  return F_SchlickF(1.0, f90, NoL) * F_SchlickF(1.0, f90, NoV) * INV_PI;
}
// Environment BRDF approximation (Karis, mobile-friendly split-sum).
vec3 envBRDFApprox(vec3 f0, float rough, float NoV){
  const vec4 c0 = vec4(-1.0, -0.0275, -0.572, 0.022);
  const vec4 c1 = vec4( 1.0,  0.0425,  1.04, -0.04);
  vec4 r = rough*c0 + c1;
  float a004 = min(r.x*r.x, exp2(-9.28*NoV))*r.x + r.y;
  vec2 ab = vec2(-1.04, 1.04)*a004 + r.zw;
  return f0*ab.x + ab.y;
}
// Fresnel for water: exact Schlick with a 0.02 f0 gives too-weak grazing
// reflection; this matches the dielectric curve much better at low angles.
float fresnelWater(float cosTheta){
  float f = pow5(1.0 - cosTheta);
  return 0.02 + 0.98 * f;
}
#endif
`;

/** Height-to-normal, triplanar and detail-tiling helpers. Depends on: common. */
const surface = /* glsl */ `
#ifndef LEEWARD_SURFACE
#define LEEWARD_SURFACE
// Reoriented normal mapping — the correct way to layer a detail normal.
vec3 blendNormalRNM(vec3 base, vec3 detail){
  vec3 t = base + vec3(0.0, 0.0, 1.0);
  vec3 u = detail * vec3(-1.0, -1.0, 1.0);
  return normalize(t * dot(t, u) - u * t.z);
}
// Break up obvious tiling by rotating the UV per hashed cell and blending.
vec4 stochasticTile(sampler2D tex, vec2 uv, float scale){
  vec2 p = uv * scale;
  vec2 id = floor(p);
  vec2 f  = fract(p);
  vec4 sum = vec4(0.0);
  float wsum = 0.0;
  for(int j=0;j<2;j++)
  for(int i=0;i<2;i++){
    vec2 o = vec2(float(i), float(j));
    vec2 cell = id + o;
    vec2 off = hash22(cell);
    float w = (1.0 - abs(f.x - o.x)) * (1.0 - abs(f.y - o.y));
    sum += texture2D(tex, uv * scale + off * 7.31) * w;
    wsum += w;
  }
  return sum / max(wsum, 1e-5);
}
// Triplanar projection for cliffs and rocks — no UV needed.
vec4 triplanar(sampler2D tex, vec3 wp, vec3 n, float scale){
  vec3 b = pow(abs(n), vec3(4.0));
  b /= max(b.x+b.y+b.z, 1e-5);
  return texture2D(tex, wp.zy*scale)*b.x
       + texture2D(tex, wp.xz*scale)*b.y
       + texture2D(tex, wp.xy*scale)*b.z;
}
#endif
`;

/** Atmospheric fog applied in a forward material. Depends on: common. */
const fog = /* glsl */ `
#ifndef LEEWARD_FOG
#define LEEWARD_FOG
// Height-attenuated exponential fog with a forward-scattering sun lobe. Call
// with scene-linear colour; returns scene-linear colour.
vec3 applyAerial(vec3 col, float dist, vec3 viewDir, vec3 sunDir,
                 vec3 fogColor, vec3 sunColor, float density, float camHeight, float worldHeight){
  float hAvg = max(0.0, (camHeight + worldHeight) * 0.5);
  float heightFalloff = exp(-hAvg / 1400.0);
  float t = 1.0 - exp(-dist * density * heightFalloff);
  // Mie-ish forward scatter so looking toward the sun glows.
  float cosT = max(0.0, dot(viewDir, sunDir));
  float mie = pow(cosT, 8.0);
  vec3 inscatter = fogColor + sunColor * mie * 0.55;
  return mix(col, inscatter, clamp(t, 0.0, 1.0));
}
#endif
`;

export const GLSL = {
  common,
  noise2d,
  simplex3d,
  fbm,
  worley3d,
  color,
  brdf,
  surface,
  fog,
  /** Everything, for shaders that use a bit of each. */
  all: common + noise2d + simplex3d + fbm + worley3d + color + brdf + surface + fog,
} as const;
