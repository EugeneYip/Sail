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
 * Per-vertex `aAux` is (partKind, pivotZ, bulge, roughness):
 *   partKind 0 = fixed, 1 = square yard and sail, 2 = fore-and-aft sail
 *   pivotZ   the mast or stay this part swings about, ship-local metres
 *   bulge    0..1 shape of the cloth's belly, signed and scaled per instance
 *
 * Per-instance:
 *   aXf (x, y, z, heading)   heading is a meteorological bearing
 *   aMo (heel, pitch, scale, brace)
 *   aBd (sheet, bulge, tint, spare)
 */
export const vesselVert = /* glsl */ `
precision highp float;
${SHARED_UNIFORM_DECL}
${GLSL.common}

attribute vec3 aCol;
attribute vec4 aAux;
attribute vec4 aXf;
attribute vec4 aMo;
attribute vec4 aBd;

varying vec3  vWorld;
varying vec3  vNormal;
varying vec3  vCol;
varying float vDist;
varying float vCloth;
varying float vRough;
varying float vSub;

void main(){
  vec3 p = position;
  vec3 n = normal;
  float kind = aAux.x;

  if (kind > 0.5) {
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
  vWorld = wp;
  vNormal = n;
  vCol = aCol * aBd.z;
  vDist = distance(wp, uCameraPos);
  vCloth = step(0.5, kind);
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

varying vec3  vWorld;
varying vec3  vNormal;
varying vec3  vCol;
varying float vDist;
varying float vCloth;
varying float vRough;
varying float vSub;

void main(){
  vec3 V = normalize(uCameraPos - vWorld);
  vec3 N = normalize(vNormal);
  // Canvas is a surface with two faces and no thickness.
  if (vCloth > 0.5 && dot(N, V) < 0.0) N = -N;

  vec3 albedo = vCol;
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
  gl_FragColor = vec4(col, 1.0);
}
`;
