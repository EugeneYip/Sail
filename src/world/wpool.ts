import * as THREE from 'three';
import type { World } from '../types';
import { creatureFrag, creatureVert, spoutFrag, spoutVert } from './shaders/creature';
import { toInstanced } from './wgeom';

/**
 * An instanced draw of one animated body type. Sixteen floats per instance in
 * four vec4s; the pool is refilled from scratch every frame, so nothing here
 * needs a free list and there is no allocation in `update()`.
 *
 * Instances the caller does not push keep `instanceCount` below them, so an
 * empty pool costs one skipped draw and a full one costs a single call.
 */
export class CreaturePool {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  private geo: THREE.InstancedBufferGeometry;
  private xf: THREE.InstancedBufferAttribute;
  private mo: THREE.InstancedBufferAttribute;
  private bd: THREE.InstancedBufferAttribute;
  private ex: THREE.InstancedBufferAttribute;
  private axf: Float32Array;
  private amo: Float32Array;
  private abd: Float32Array;
  private aex: Float32Array;
  private n = 0;
  private readonly max: number;
  private lo = new THREE.Vector3();
  private hi = new THREE.Vector3();
  private bodyRadius: number;

  constructor(
    world: World,
    body: THREE.BufferGeometry,
    max: number,
    name: string,
    waveK: number,
    flapBend: number,
  ) {
    this.max = max;
    this.bodyRadius = body.boundingSphere?.radius ?? 1;
    this.geo = toInstanced(body);
    this.axf = new Float32Array(max * 4);
    this.amo = new Float32Array(max * 4);
    this.abd = new Float32Array(max * 4);
    this.aex = new Float32Array(max * 4);
    this.xf = new THREE.InstancedBufferAttribute(this.axf, 4);
    this.mo = new THREE.InstancedBufferAttribute(this.amo, 4);
    this.bd = new THREE.InstancedBufferAttribute(this.abd, 4);
    this.ex = new THREE.InstancedBufferAttribute(this.aex, 4);
    for (const a of [this.xf, this.mo, this.bd, this.ex]) a.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('aXf', this.xf);
    this.geo.setAttribute('aMo', this.mo);
    this.geo.setAttribute('aBd', this.bd);
    this.geo.setAttribute('aEx', this.ex);
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1);

    this.material = new THREE.ShaderMaterial({
      name,
      uniforms: {
        ...world.uniforms,
        uWaveK: { value: waveK },
        uFlapBend: { value: flapBend },
      },
      vertexShader: creatureVert,
      fragmentShader: creatureFrag,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(this.geo, this.material);
    this.mesh.name = name;
    this.mesh.renderOrder = 2;
    world.scene.add(this.mesh);
  }

  begin(): void {
    this.n = 0;
    this.lo.set(Infinity, Infinity, Infinity);
    this.hi.set(-Infinity, -Infinity, -Infinity);
  }

  push(
    x: number, y: number, z: number, yaw: number,
    pitch: number, roll: number, scale: number, phase: number,
    flapAmp: number, bendY: number, bendX: number, tint: number,
    waterY: number, wet: number,
  ): void {
    const i = this.n;
    if (i >= this.max) return;
    this.n++;
    const o = i * 4;
    this.axf[o] = x; this.axf[o + 1] = y; this.axf[o + 2] = z; this.axf[o + 3] = yaw;
    this.amo[o] = pitch; this.amo[o + 1] = roll; this.amo[o + 2] = scale; this.amo[o + 3] = phase;
    this.abd[o] = flapAmp; this.abd[o + 1] = bendY; this.abd[o + 2] = bendX; this.abd[o + 3] = tint;
    this.aex[o] = waterY; this.aex[o + 1] = wet; this.aex[o + 2] = 0; this.aex[o + 3] = 0;
    if (x < this.lo.x) this.lo.x = x;
    if (y < this.lo.y) this.lo.y = y;
    if (z < this.lo.z) this.lo.z = z;
    if (x > this.hi.x) this.hi.x = x;
    if (y > this.hi.y) this.hi.y = y;
    if (z > this.hi.z) this.hi.z = z;
  }

  end(): void {
    const g = this.geo;
    g.instanceCount = this.n;
    this.mesh.visible = this.n > 0;
    if (this.n === 0) return;
    this.xf.needsUpdate = true;
    this.mo.needsUpdate = true;
    this.bd.needsUpdate = true;
    this.ex.needsUpdate = true;
    // The instances are scattered, so the geometry's own sphere is useless for
    // culling; rebuild one that actually bounds them.
    const s = g.boundingSphere!;
    s.center.set((this.lo.x + this.hi.x) * 0.5, (this.lo.y + this.hi.y) * 0.5, (this.lo.z + this.hi.z) * 0.5);
    s.radius =
      0.5 * Math.hypot(this.hi.x - this.lo.x, this.hi.y - this.lo.y, this.hi.z - this.lo.z) +
      this.bodyRadius * 2;
  }

  get count(): number {
    return this.n;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geo.dispose();
    this.material.dispose();
  }
}

/**
 * The spouts. Camera-facing plumes with a floor on their screen size, so a
 * whale's blow stays visible at three kilometres — which is the only reason to
 * put a whale on the horizon at all.
 */
export class SpoutPool {
  readonly mesh: THREE.Mesh;
  private material: THREE.ShaderMaterial;
  private geo: THREE.InstancedBufferGeometry;
  private xf: THREE.InstancedBufferAttribute;
  private mo: THREE.InstancedBufferAttribute;
  private axf: Float32Array;
  private amo: Float32Array;
  private n = 0;
  private readonly max: number;
  private lo = new THREE.Vector3();
  private hi = new THREE.Vector3();

  constructor(world: World, max: number) {
    this.max = max;
    const quad = new THREE.InstancedBufferGeometry();
    quad.setAttribute(
      'position',
      new THREE.BufferAttribute(
        new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]),
        3,
      ),
    );
    quad.setIndex([0, 1, 2, 0, 2, 3]);
    quad.instanceCount = 0;
    this.axf = new Float32Array(max * 4);
    this.amo = new Float32Array(max * 4);
    this.xf = new THREE.InstancedBufferAttribute(this.axf, 4);
    this.mo = new THREE.InstancedBufferAttribute(this.amo, 4);
    this.xf.setUsage(THREE.DynamicDrawUsage);
    this.mo.setUsage(THREE.DynamicDrawUsage);
    quad.setAttribute('aXf', this.xf);
    quad.setAttribute('aMo', this.mo);
    quad.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1);
    this.geo = quad;

    this.material = new THREE.ShaderMaterial({
      name: 'world-spout',
      uniforms: {
        ...world.uniforms,
        uPxScale: { value: 0.002 },
        uMinPx: { value: 3.2 },
      },
      vertexShader: spoutVert,
      fragmentShader: spoutFrag,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(this.geo, this.material);
    this.mesh.name = 'world-spout';
    this.mesh.renderOrder = 6;
    world.scene.add(this.mesh);
  }

  begin(world: World): void {
    this.n = 0;
    this.lo.set(Infinity, Infinity, Infinity);
    this.hi.set(-Infinity, -Infinity, -Infinity);
    // World units per pixel, per metre of view distance.
    const fov = (world.camera.fov * Math.PI) / 180;
    const h = Math.max(1, world.size.height);
    this.material.uniforms.uPxScale.value = (2 * Math.tan(fov * 0.5)) / h;
  }

  push(x: number, y: number, z: number, size: number, age: number, lean: number, seed: number, bright: number): void {
    const i = this.n;
    if (i >= this.max) return;
    this.n++;
    const o = i * 4;
    this.axf[o] = x; this.axf[o + 1] = y; this.axf[o + 2] = z; this.axf[o + 3] = size;
    this.amo[o] = age; this.amo[o + 1] = lean; this.amo[o + 2] = seed; this.amo[o + 3] = bright;
    if (x < this.lo.x) this.lo.x = x;
    if (y < this.lo.y) this.lo.y = y;
    if (z < this.lo.z) this.lo.z = z;
    if (x > this.hi.x) this.hi.x = x;
    if (y > this.hi.y) this.hi.y = y;
    if (z > this.hi.z) this.hi.z = z;
  }

  end(): void {
    this.geo.instanceCount = this.n;
    this.mesh.visible = this.n > 0;
    if (this.n === 0) return;
    this.xf.needsUpdate = true;
    this.mo.needsUpdate = true;
    const s = this.geo.boundingSphere!;
    s.center.set((this.lo.x + this.hi.x) * 0.5, (this.lo.y + this.hi.y) * 0.5, (this.lo.z + this.hi.z) * 0.5);
    s.radius = 0.5 * Math.hypot(this.hi.x - this.lo.x, this.hi.y - this.lo.y, this.hi.z - this.lo.z) + 240;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geo.dispose();
    this.material.dispose();
  }
}
