/**
 * Animated-part transforms, done in the vertex shader.
 *
 * Yards brace, the rudder swings, the wheel turns and the spanker boom sweeps —
 * but every one of those lives inside a single merged BufferGeometry so the whole
 * hull-and-rig is a handful of draw calls. Each vertex carries an `aPart` slot;
 * the CPU writes one pivot + quaternion per slot per frame and the shader
 * applies it. Slot 0 is identity, so static geometry costs one array fetch.
 *
 * The rigging material uses the same snippet on its per-instance endpoints,
 * which is what makes a braced yard drag its braces around with it.
 */

import { PART_COUNT } from '../dims';

export const PARTS_DECL = /* glsl */ `
#ifndef SHIP_PARTS_DECL
#define SHIP_PARTS_DECL
#define SHIP_PART_COUNT ${PART_COUNT}
uniform vec4 uPartQ[SHIP_PART_COUNT];
uniform vec3 uPartP[SHIP_PART_COUNT];

vec3 shipPartRot(vec3 v, vec4 q){
  vec3 t = 2.0 * cross(q.xyz, v);
  return v + q.w * t + cross(q.xyz, t);
}
vec3 shipPart(vec3 p, float pi){
  int i = int(pi + 0.5);
  vec3 c = uPartP[i];
  return c + shipPartRot(p - c, uPartQ[i]);
}
vec3 shipPartN(vec3 n, float pi){
  return shipPartRot(n, uPartQ[int(pi + 0.5)]);
}
#endif
`;
