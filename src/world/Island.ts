import * as THREE from 'three';
import type { World } from '../types';
import { ARCH_META } from './archetypes';
import { HeightField, LOD_FACTOR, PATCH, selectNodes, type SelectResult } from './HeightField';
import type { GenResult } from './api';
import type { WorldResources } from './Resources';
import { shoreFrag, shoreVert } from './shaders/shore';
import { terrainFrag, terrainVert } from './shaders/terrain';
import type { SiteSpec } from './Sites';
import { clamp01, mix } from './wnoise';

/** Quadtree nodes emitted per island per pass. */
const MAX_NODES = 640;
/** Coarse shadow/height texture divisor. */
const COARSE_DIV = 4;

const scratchColor = new THREE.Color();

function linearColor(rgb: [number, number, number], out: THREE.Color): THREE.Color {
  return out.setRGB(rgb[0], rgb[1], rgb[2]).convertSRGBToLinear();
}

/**
 * One streamed island: the CPU heightfield mirror, the three data textures the
 * shaders read, and the two instanced CDLOD draws (land + shore shell).
 *
 * Everything lives in island-local metres. The render-space origin is pushed to
 * the shaders as `uIslandPos` every frame, which is what makes a floating-origin
 * rebase a single vector write instead of a rebuild.
 */
export class Island {
  readonly spec: SiteSpec;
  readonly id: number;
  /** 0 = requested, 1 = heightfield live, 2 = props + landmarks live. */
  stage = 0;
  /** Render-space centre, y = 0. */
  readonly center = new THREE.Vector3();
  readonly absCenter = new THREE.Vector3();
  hf: HeightField | null = null;
  maxHeight = 0;
  landRadius = 0;
  genMs = 0;

  /** Prop / landmark payloads, handed to the builders during stage 2. */
  scatter: Float32Array | null = null;
  scatterCount = 0;
  landmarkData: Float32Array | null = null;
  landmarkCount = 0;

  /** Parent for everything that is a real Object3D (props, landmarks). */
  readonly group = new THREE.Group();

  private texHeight: THREE.DataTexture | null = null;
  private texMat: THREE.DataTexture | null = null;
  private texCoarse: THREE.DataTexture | null = null;
  private terrainMat: THREE.ShaderMaterial | null = null;
  private shoreMat: THREE.ShaderMaterial | null = null;
  private terrainMesh: THREE.Mesh | null = null;
  private shoreMesh: THREE.Mesh | null = null;
  private geoT: THREE.InstancedBufferGeometry | null = null;
  private geoS: THREE.InstancedBufferGeometry | null = null;
  private attrT: THREE.InstancedBufferAttribute | null = null;
  private attrS: THREE.InstancedBufferAttribute | null = null;
  private nodeT = new Float32Array(MAX_NODES * 4);
  private nodeS = new Float32Array(MAX_NODES * 4);
  private lodEnd = new Float32Array(8);
  private lodStart = new Float32Array(8);

  nodesTerrain = 0;
  nodesShore = 0;
  /** Distance from the camera to the island's land edge, metres. */
  camDist = 1e9;

  constructor(spec: SiteSpec, id: number) {
    this.spec = spec;
    this.id = id;
    this.absCenter.set(spec.ax, 0, spec.az);
    this.group.name = `island-${id}`;
    this.group.matrixAutoUpdate = true;
  }

  /** Build every GPU resource from a finished generation job. */
  commit(res: GenResult, world: World, resources: WorldResources): void {
    const hf = new HeightField(res);
    this.hf = hf;
    this.maxHeight = res.maxHeight;
    this.landRadius = res.landRadius;
    this.genMs = res.genMs;
    this.scatter = res.scatter;
    this.scatterCount = res.scatterCount;
    this.landmarkData = res.landmarks;
    this.landmarkCount = res.landmarkCount;

    const n = res.gridN;

    // r = height (m), g = moisture code. NEAREST only: RG32F is not filterable
    // without an extension, and every read is a texelFetch anyway.
    const texH = new THREE.DataTexture(res.hm, n, n, THREE.RGFormat, THREE.FloatType);
    texH.minFilter = THREE.NearestFilter;
    texH.magFilter = THREE.NearestFilter;
    texH.wrapS = THREE.ClampToEdgeWrapping;
    texH.wrapT = THREE.ClampToEdgeWrapping;
    texH.generateMipmaps = false;
    texH.needsUpdate = true;
    this.texHeight = texH;

    const texM = new THREE.DataTexture(res.mat, n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
    texM.minFilter = THREE.LinearFilter;
    texM.magFilter = THREE.LinearFilter;
    texM.wrapS = THREE.ClampToEdgeWrapping;
    texM.wrapT = THREE.ClampToEdgeWrapping;
    texM.colorSpace = THREE.NoColorSpace;
    texM.generateMipmaps = false;
    texM.needsUpdate = true;
    this.texMat = texM;

    // Quarter-res filterable height for the sun-shadow march.
    const cn = n / COARSE_DIV;
    const cOff = -25;
    const cScale = Math.max(70, res.maxHeight + 30) - cOff;
    const cdata = new Uint8Array(cn * cn);
    const invS = 255 / cScale;
    for (let j = 0; j < cn; j++) {
      const sj = Math.min(n - 1, Math.round((j * (n - 1)) / (cn - 1)));
      for (let i = 0; i < cn; i++) {
        const si = Math.min(n - 1, Math.round((i * (n - 1)) / (cn - 1)));
        // Average of the 2x2 around the sample keeps thin ridges from vanishing
        // between decimated texels without inflating flat ground.
        const b = sj * n + si;
        const h =
          (res.hm[b * 2] +
            res.hm[(b + (si < n - 1 ? 1 : 0)) * 2] +
            res.hm[(b + (sj < n - 1 ? n : 0)) * 2] +
            res.hm[(b + (sj < n - 1 ? n : 0) + (si < n - 1 ? 1 : 0)) * 2]) *
          0.25;
        const v = (h - cOff) * invS;
        cdata[j * cn + i] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
    }
    const texC = new THREE.DataTexture(cdata, cn, cn, THREE.RedFormat, THREE.UnsignedByteType);
    texC.minFilter = THREE.LinearFilter;
    texC.magFilter = THREE.LinearFilter;
    texC.wrapS = THREE.ClampToEdgeWrapping;
    texC.wrapT = THREE.ClampToEdgeWrapping;
    texC.colorSpace = THREE.NoColorSpace;
    texC.generateMipmaps = false;
    texC.needsUpdate = true;
    this.texCoarse = texC;

    const metaA = ARCH_META[this.spec.archA];
    const metaB = ARCH_META[this.spec.archB];
    const bw = this.spec.blend * 0.5;
    const rock = new THREE.Color();
    const sand = new THREE.Color();
    const flora = new THREE.Color();
    linearColor(metaA.rock, rock).lerp(linearColor(metaB.rock, scratchColor), bw);
    linearColor(metaA.sand, sand).lerp(linearColor(metaB.sand, scratchColor), bw);
    linearColor(metaA.flora, flora).lerp(linearColor(metaB.flora, scratchColor), bw);
    // Cold climates green up and grey down; warm ones bleach the sand.
    const cold = clamp01((this.spec.climate - 0.45) * 2.2);
    flora.lerp(scratchColor.setRGB(0.035, 0.072, 0.042), cold * 0.5);
    sand.lerp(scratchColor.setRGB(0.19, 0.19, 0.185), cold * 0.45);

    const snowLine = Math.min(metaA.snowLine, metaB.snowLine);
    const reef = mix(metaA.reefiness, metaB.reefiness, bw) * (1 - cold * 0.8);

    const common = {
      tHeight: { value: texH },
      tMat: { value: texM },
      tCoarse: { value: texC },
      uHF: { value: new THREE.Vector4(n, res.extentM, hf.cell, 1 / n) },
      uHFC: { value: new THREE.Vector4(cn, cScale, cOff, 1 / cn) },
      uIslandPos: { value: new THREE.Vector3() },
      uLodStart: { value: this.lodStart },
      uLodEnd: { value: this.lodEnd },
      uPatch: { value: PATCH },
      uWaveH: { value: 1 },
      uSwellDir: { value: new THREE.Vector2(0, 1) },
      uSandCol: { value: sand },
      uRockCol: { value: rock },
    };

    const detail = resources.detail;
    this.terrainMat = new THREE.ShaderMaterial({
      name: 'world-terrain',
      glslVersion: THREE.GLSL3,
      uniforms: {
        ...world.uniforms,
        ...common,
        tDetail: { value: detail.albedo },
        tDetailN: { value: detail.normal },
        uFloraCol: { value: flora },
        uSnowLine: { value: snowLine > 5 ? 1e5 : snowLine * Math.max(120, res.maxHeight) },
        uNear: { value: 1 },
      },
      vertexShader: terrainVert,
      fragmentShader: terrainFrag,
      side: THREE.FrontSide,
    });

    this.shoreMat = new THREE.ShaderMaterial({
      name: 'world-shore',
      glslVersion: THREE.GLSL3,
      uniforms: {
        ...world.uniforms,
        ...common,
        uSeaY: { value: 0 },
        uReef: { value: reef },
      },
      vertexShader: shoreVert,
      fragmentShader: shoreFrag,
      transparent: true,
      depthWrite: false,
      side: THREE.FrontSide,
      // The shell is coplanar with the ocean surface at the waterline; a depth
      // bias is the only thing that keeps it from stippling against it.
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -8,
    });

    this.geoT = this.makeGeometry(resources);
    this.geoS = this.makeGeometry(resources);
    this.attrT = this.geoT.getAttribute('aNode') as THREE.InstancedBufferAttribute;
    this.attrS = this.geoS.getAttribute('aNode') as THREE.InstancedBufferAttribute;

    this.terrainMesh = new THREE.Mesh(this.geoT, this.terrainMat);
    this.terrainMesh.frustumCulled = false;
    this.terrainMesh.name = `island-${this.id}-land`;
    this.terrainMesh.castShadow = false;
    this.terrainMesh.receiveShadow = false;

    this.shoreMesh = new THREE.Mesh(this.geoS, this.shoreMat);
    this.shoreMesh.frustumCulled = false;
    this.shoreMesh.renderOrder = 3;
    this.shoreMesh.name = `island-${this.id}-shore`;

    this.group.add(this.terrainMesh, this.shoreMesh);
    world.scene.add(this.group);

    for (let l = 0; l < 8; l++) {
      const size = hf.nodeSize(Math.min(l, hf.maxLevel));
      this.lodEnd[l] = size * LOD_FACTOR;
      this.lodStart[l] = this.lodEnd[l] * 0.6;
    }

    this.stage = 1;
  }

  private makeGeometry(resources: WorldResources): THREE.InstancedBufferGeometry {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', resources.patchPos);
    g.setIndex(resources.patchIdx);
    const attr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_NODES * 4), 4);
    attr.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aNode', attr);
    g.instanceCount = 0;
    // We cull per node ourselves; three must not throw the whole island away.
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    return g;
  }

  /** Cheap per-frame work: LOD select, uniforms, origin follow. */
  updateFrame(
    world: World,
    camX: number,
    camZ: number,
    frustum: THREE.Frustum | null,
    lodScale: number,
    select: SelectResult,
    swellX: number,
    swellZ: number,
  ): void {
    this.center.set(this.absCenter.x - world.origin.x, 0, this.absCenter.z - world.origin.z);
    const hf = this.hf;
    if (!hf || !this.terrainMesh || !this.shoreMesh) return;

    const dx = camX - this.center.x;
    const dz = camZ - this.center.z;
    this.camDist = Math.max(0, Math.hypot(dx, dz) - this.landRadius);

    this.group.position.set(this.center.x, 0, this.center.z);

    for (let l = 0; l <= hf.maxLevel; l++) {
      this.lodEnd[l] = hf.nodeSize(l) * LOD_FACTOR * lodScale;
      this.lodStart[l] = this.lodEnd[l] * 0.6;
    }

    selectNodes(
      hf,
      camX,
      camZ,
      this.center.x,
      this.center.z,
      this.lodEnd,
      frustum,
      this.nodeT,
      this.nodeS,
      MAX_NODES,
      select,
    );
    this.nodesTerrain = select.terrain;
    this.nodesShore = select.shore;

    const attrT = this.attrT!;
    const attrS = this.attrS!;
    (attrT.array as Float32Array).set(this.nodeT.subarray(0, select.terrain * 4));
    (attrS.array as Float32Array).set(this.nodeS.subarray(0, select.shore * 4));
    attrT.needsUpdate = true;
    attrS.needsUpdate = true;
    this.geoT!.instanceCount = select.terrain;
    this.geoS!.instanceCount = select.shore;
    this.terrainMesh.visible = select.terrain > 0;
    this.shoreMesh.visible = select.shore > 0 && this.camDist < 26000;
    this.terrainMesh.position.copy(this.center);
    this.shoreMesh.position.copy(this.center);

    const tu = this.terrainMat!.uniforms;
    const su = this.shoreMat!.uniforms;
    (tu.uIslandPos.value as THREE.Vector3).copy(this.center);
    (su.uIslandPos.value as THREE.Vector3).copy(this.center);
    tu.uNear.value = this.camDist < 2600 ? 1 : this.camDist < 6000 ? 0.4 : 0;
    const waveH = world.env.waveHeight;
    tu.uWaveH.value = waveH;
    su.uWaveH.value = waveH;
    su.uSeaY.value = world.ocean?.seaLevel ?? 0;
    (tu.uSwellDir.value as THREE.Vector2).set(swellX, swellZ);
    (su.uSwellDir.value as THREE.Vector2).set(swellX, swellZ);
  }

  dispose(): void {
    this.group.removeFromParent();
    this.group.clear();
    this.geoT?.dispose();
    this.geoS?.dispose();
    this.terrainMat?.dispose();
    this.shoreMat?.dispose();
    this.texHeight?.dispose();
    this.texMat?.dispose();
    this.texCoarse?.dispose();
    this.geoT = null;
    this.geoS = null;
    this.terrainMesh = null;
    this.shoreMesh = null;
    this.hf = null;
    this.scatter = null;
    this.landmarkData = null;
  }
}
