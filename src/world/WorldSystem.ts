import * as THREE from 'three';
import type { Module, QualityTier, World } from '../types';
import GenWorker from './gen.worker?worker&inline';
import { DEEP_DEPTH, type GenRequest, type GenResult, type IslandInfo, type LandQuery, type WorldExt } from './api';
import { ARCH_NAMES } from './api';
import { Island } from './Island';
import type { SelectResult } from './HeightField';
import { WorldResources } from './Resources';
import { EXTENT_MAX, SITE_M, siteFor, siteKey, type SiteSpec } from './Sites';
import { shoreFrag, shoreVert } from './shaders/shore';
import { terrainFrag, terrainVert } from './shaders/terrain';
import { PATCH } from './HeightField';
import { WorldProps } from './Props';
import { WorldLandmarks } from './Landmarks';

/** Where the voyage starts in absolute coordinates — picked for a good landfall. */
const START_X = 4100;
const START_Z = -1250;
const WORLD_SEED = 20250817;

const GRID_N = 512;

interface Tier {
  loadR: number;
  unloadR: number;
  maxIslands: number;
  lodScale: number;
  droplets: number;
  scatterMax: number;
  workers: number;
}

const TIERS: Record<QualityTier, Tier> = {
  low: { loadR: 15000, unloadR: 19000, maxIslands: 4, lodScale: 0.5, droplets: 14000, scatterMax: 900, workers: 1 },
  medium: { loadR: 20000, unloadR: 25000, maxIslands: 6, lodScale: 0.68, droplets: 26000, scatterMax: 1800, workers: 1 },
  high: { loadR: 25000, unloadR: 31000, maxIslands: 8, lodScale: 0.86, droplets: 42000, scatterMax: 3000, workers: 2 },
  ultra: { loadR: 30000, unloadR: 37000, maxIslands: 10, lodScale: 1, droplets: 60000, scatterMax: 4200, workers: 2 },
};

interface Pending {
  spec: SiteSpec;
  priority: number;
}

const scratchV = new THREE.Vector3();
const scratchM = new THREE.Matrix4();

/**
 * Streaming procedural archipelago.
 *
 * Islands are hashed out of a fixed 9 km site lattice (`Sites.ts`), generated
 * off-thread (`gen.worker.ts`), mirrored on the CPU for queries
 * (`HeightField.ts`) and drawn as two instanced CDLOD passes per island
 * (`Island.ts`). Nothing about the world is stored: sail away and back and the
 * same island regenerates identically.
 */
export class WorldSystem implements Module {
  readonly name = 'world';

  private world!: World;
  private resources!: WorldResources;
  private props!: WorldProps;
  private landmarks!: WorldLandmarks;
  private workers: Worker[] = [];
  private busy: number[] = [];
  private islands = new Map<number, Island>();
  private inflight = new Map<number, SiteSpec>();
  private queue: Pending[] = [];
  private results: GenResult[] = [];
  private nextId = 1;
  private tier: Tier = TIERS.ultra;

  private rescanTimer = 0;
  private lastScanX = 1e9;
  private lastScanZ = 1e9;

  private forced: SiteSpec | null = null;
  private forcedPending = false;

  private frustum = new THREE.Frustum();
  private select: SelectResult = { terrain: 0, shore: 0 };
  private infoList: IslandInfo[] = [];
  private infoDirty = true;
  private landQuery: LandQuery & { bearing: number } = {
    distance: Infinity,
    position: new THREE.Vector3(),
    islandId: -1,
    bearing: 0,
  };

  private genMsAvg = 0;
  private worstMs = 0;
  private warmup: THREE.Mesh[] = [];
  private ext!: WorldExt;

  private offSub: (() => void)[] = [];

  init(world: World): void {
    this.world = world;
    this.resources = new WorldResources();
    this.props = new WorldProps(this.resources);
    this.landmarks = new WorldLandmarks(this.resources);
    this.applyTier();

    // The voyage starts at a hand-picked spot in the lattice so the very first
    // horizon has land on it.
    world.origin.set(START_X, 0, START_Z);

    this.publishExt();
    this.warmPrograms();

    this.offSub.push(
      world.bus.on('capture:focusIsland', () => this.focusIsland()),
      world.bus.on('origin:shift', () => {
        this.infoDirty = true;
        this.rescanTimer = 0;
      }),
      world.bus.on('world:focusIsland', () => this.focusIsland()),
    );
  }

  applySettings(world: World): void {
    this.applyTier();
    this.props.applySettings(world);
    void world;
  }

  private applyTier(): void {
    const t = TIERS[this.world.settings.quality] ?? TIERS.high;
    this.tier = t;
    while (this.workers.length < t.workers) {
      const w = new GenWorker();
      const index = this.workers.length;
      w.onmessage = (ev: MessageEvent<GenResult>) => {
        this.busy[index] = 0;
        this.results.push(ev.data);
      };
      this.workers.push(w);
      this.busy.push(0);
    }
  }

  /* ---------------------------------------------------------------- *
   *  streaming
   * ---------------------------------------------------------------- */

  private request(spec: SiteSpec, priority: number): void {
    if (this.islands.has(spec.key) || this.inflight.has(spec.key)) return;
    for (const q of this.queue) if (q.spec.key === spec.key) return;
    this.queue.push({ spec, priority });
  }

  private pumpWorkers(): void {
    if (this.queue.length === 0) return;
    for (let i = 0; i < this.workers.length; i++) {
      if (this.busy[i]) continue;
      if (this.queue.length === 0) return;
      // Nearest first — the island you are sailing at must win every race.
      let best = 0;
      for (let k = 1; k < this.queue.length; k++) {
        if (this.queue[k].priority < this.queue[best].priority) best = k;
      }
      const job = this.queue.splice(best, 1)[0];
      const spec = job.spec;
      if (this.islands.has(spec.key)) continue;
      const req: GenRequest = {
        id: spec.key,
        seed: spec.seed,
        gridN: GRID_N,
        extentM: spec.extentM,
        archA: spec.archA,
        archB: spec.archB,
        blend: spec.blend,
        radiusM: spec.radiusM,
        peakScale: spec.peakScale,
        climate: spec.climate,
        swellBearing: this.world.env.swellBearing,
        erosionDroplets: spec.forced ? Math.max(this.tier.droplets, 52000) : this.tier.droplets,
        scatterMax: Math.round(this.tier.scatterMax * Math.min(1.6, this.world.settings.propDensity || 1)),
        forceLandmarks: spec.forced,
      };
      this.inflight.set(spec.key, spec);
      this.busy[i] = 1;
      this.workers[i].postMessage(req);
    }
  }

  private rescan(shipX: number, shipZ: number): void {
    const t = this.tier;
    const world = this.world;
    const ax = shipX + world.origin.x;
    const az = shipZ + world.origin.z;
    const tx = Math.round(ax / SITE_M);
    const tz = Math.round(az / SITE_M);
    const span = Math.ceil(t.loadR / SITE_M) + 1;

    let count = this.islands.size + this.inflight.size;
    const forced = this.forced;

    for (let j = -span; j <= span; j++) {
      for (let i = -span; i <= span; i++) {
        const spec = siteFor(tx + i, tz + j, WORLD_SEED);
        if (!spec) continue;
        const d = Math.hypot(spec.ax - ax, spec.az - az);
        if (d > t.loadR) continue;
        if (forced && Math.hypot(spec.ax - forced.ax, spec.az - forced.az) < EXTENT_MAX) continue;
        if (this.islands.has(spec.key) || this.inflight.has(spec.key)) continue;
        if (count >= t.maxIslands) continue;
        this.request(spec, d);
        count++;
      }
    }

    // Hysteresis: unload only well past the load ring so a tile on the boundary
    // cannot thrash between generated and freed.
    for (const [key, isl] of this.islands) {
      if (isl.spec.forced) continue;
      const d = Math.hypot(isl.absCenter.x - ax, isl.absCenter.z - az);
      if (d > t.unloadR) {
        this.props.release(isl);
        this.landmarks.release(isl);
        isl.dispose();
        this.islands.delete(key);
        this.infoDirty = true;
      }
    }
    for (let k = this.queue.length - 1; k >= 0; k--) {
      const s = this.queue[k].spec;
      if (Math.hypot(s.ax - ax, s.az - az) > t.unloadR) this.queue.splice(k, 1);
    }
  }

  /** Drop a deterministic island a comfortable landfall distance off the bow. */
  private focusIsland(): void {
    const world = this.world;
    const h = world.ship.heading;
    const fx = Math.sin(h);
    const fz = -Math.cos(h);
    const dist = 2900;
    const ax = world.ship.position.x + world.origin.x + fx * dist;
    const az = world.ship.position.z + world.origin.z + fz * dist;

    const spec: SiteSpec = {
      key: -7,
      tileX: Math.round(ax / SITE_M),
      tileZ: Math.round(az / SITE_M),
      ax,
      az,
      seed: 0x51a1d,
      archA: 0, // volcanic
      archB: 7, // ridge
      blend: 0.42,
      radiusM: 1560,
      extentM: 4520,
      peakScale: 1.55,
      climate: 0.3,
      forced: true,
    };

    const old = this.islands.get(-7);
    if (old) {
      this.props.release(old);
      this.landmarks.release(old);
      old.dispose();
      this.islands.delete(-7);
    }
    this.inflight.delete(-7);
    this.forced = spec;
    this.forcedPending = true;
    this.queue.length = 0;
    this.request(spec, -1e9);
    this.infoDirty = true;

    // Anything the forced island would overlap has to go.
    for (const [key, isl] of this.islands) {
      if (Math.hypot(isl.absCenter.x - ax, isl.absCenter.z - az) < EXTENT_MAX) {
        this.props.release(isl);
        this.landmarks.release(isl);
        isl.dispose();
        this.islands.delete(key);
      }
    }
    this.rescanTimer = 0;
  }

  /* ---------------------------------------------------------------- *
   *  frame
   * ---------------------------------------------------------------- */

  update(world: World): void {
    const t0 = performance.now();
    const ms = world.time.rawDt * 1000;
    if (ms > this.worstMs && world.time.frame > 60 && ms < 400) this.worstMs = ms;

    const cam = world.camera;
    scratchV.setFromMatrixPosition(cam.matrixWorld);
    const camX = scratchV.x;
    const camZ = scratchV.z;

    this.rescanTimer -= world.time.dt;
    const shipX = world.ship.position.x;
    const shipZ = world.ship.position.z;
    if (
      this.rescanTimer <= 0 ||
      Math.abs(shipX - this.lastScanX) > 600 ||
      Math.abs(shipZ - this.lastScanZ) > 600
    ) {
      this.rescanTimer = 0.75;
      this.lastScanX = shipX;
      this.lastScanZ = shipZ;
      this.rescan(shipX, shipZ);
      this.infoDirty = true;
    }
    this.pumpWorkers();

    // One island materialises per frame at most: the texture upload it triggers
    // is the single biggest cost in the whole streaming path.
    if (this.results.length > 0) {
      const res = this.results.shift()!;
      const spec = this.inflight.get(res.id);
      this.inflight.delete(res.id);
      if (spec && !this.islands.has(res.id)) {
        const isl = new Island(spec, this.nextId++);
        isl.commit(res, world, this.resources);
        this.islands.set(res.id, isl);
        this.genMsAvg = this.genMsAvg === 0 ? res.genMs : this.genMsAvg * 0.8 + res.genMs * 0.2;
        this.infoDirty = true;
        if (spec.forced) this.forcedPending = false;
      }
    }

    // --- frustum, one frame stale (the camera rig runs after us); widened so a
    // fast turn cannot reveal an unselected node at the screen edge.
    scratchM.copy(cam.projectionMatrix);
    scratchM.elements[0] *= 0.82;
    scratchM.elements[5] *= 0.82;
    scratchM.multiply(cam.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(scratchM);

    const swell = world.env.swellBearing;
    const wind = world.env.windBearing;
    // Breakers follow the swell but lean toward the live wind: it is the wind
    // that decides which shore is the rough one on any given day.
    let sx = -Math.sin(swell) * 0.68 - Math.sin(wind) * 0.32;
    let sz = Math.cos(swell) * 0.68 + Math.cos(wind) * 0.32;
    const sl = Math.hypot(sx, sz) || 1;
    sx /= sl;
    sz /= sl;

    let nodes = 0;
    for (const isl of this.islands.values()) {
      isl.updateFrame(world, camX, camZ, this.frustum, this.tier.lodScale, this.select, sx, sz);
      nodes += isl.nodesTerrain + isl.nodesShore;
    }

    const budget = 2.0 - (performance.now() - t0);
    this.props.update(world, this.islands, camX, camZ, budget);
    this.landmarks.update(world, this.islands, camX, camZ);

    if (this.infoDirty) this.rebuildInfo();

    const st = this.ext.stats;
    st.islands = this.islands.size;
    st.nodes = nodes;
    st.pending = this.queue.length + this.inflight.size;
    st.genMsLast = this.genMsAvg;
    st.genMsAvg = this.genMsAvg;
    st.sliceMs = performance.now() - t0;
    st.props = this.props.liveInstances;
    world.stats['world.islands'] = this.islands.size;
    world.stats['world.nodes'] = nodes;
    world.stats['world.worstMs'] = this.worstMs;
  }

  private rebuildInfo(): void {
    this.infoDirty = false;
    const list = this.infoList;
    list.length = 0;
    for (const isl of this.islands.values()) {
      list.push({
        id: isl.id,
        tileX: isl.spec.tileX,
        tileZ: isl.spec.tileZ,
        center: isl.center,
        position: isl.center,
        absCenter: isl.absCenter,
        halfExtent: isl.spec.extentM * 0.5,
        landRadius: isl.landRadius,
        radius: isl.landRadius,
        maxHeight: isl.maxHeight,
        archetype: ARCH_NAMES[isl.spec.archA] ?? 'ridge',
        stage: isl.stage,
      });
    }
    list.sort((a, b) => a.center.lengthSq() - b.center.lengthSq());
  }

  /* ---------------------------------------------------------------- *
   *  published API
   * ---------------------------------------------------------------- */

  private publishExt(): void {
    const self = this;
    this.ext = {
      sampleTerrainHeight: (x, z) => self.heightAt(x, z),
      sampleDepth: (x, z) => Math.max(0, -self.heightAt(x, z)),
      nearestLand: (x, z, maxRadius = 40000) => self.nearestLand(x, z, maxRadius),
      clearanceAhead: (x, z, heading, maxDist, clearanceM = 8) =>
        self.clearanceAhead(x, z, heading, maxDist, clearanceM),
      islands: this.infoList,
      tiles: this.infoList,
      landmarks: this.landmarks.list,
      stats: { islands: 0, nodes: 0, pending: 0, genMsLast: 0, genMsAvg: 0, sliceMs: 0, props: 0 },
      seed: WORLD_SEED,
      applyOriginShift: () => {
        self.infoDirty = true;
      },
    };
    this.world.ext.world = this.ext;
  }

  private heightAt(x: number, z: number): number {
    let best = DEEP_DEPTH;
    for (const isl of this.islands.values()) {
      const hf = isl.hf;
      if (!hf) continue;
      const lx = x - isl.center.x;
      const lz = z - isl.center.z;
      const half = hf.extent * 0.5;
      if (lx < -half || lx > half || lz < -half || lz > half) continue;
      const h = hf.height(lx, lz);
      if (h > best) best = h;
    }
    return best;
  }

  private nearestLand(x: number, z: number, maxRadius: number): (LandQuery & { bearing: number }) | null {
    let bestIsl: Island | null = null;
    let bestD = maxRadius;
    for (const isl of this.islands.values()) {
      if (!isl.hf || isl.landRadius <= 0) continue;
      const d = Math.max(0, Math.hypot(x - isl.center.x, z - isl.center.z) - isl.landRadius);
      if (d < bestD) {
        bestD = d;
        bestIsl = isl;
      }
    }
    if (!bestIsl || !bestIsl.hf) return null;

    // Walk in from the outside along the line to the centre until the seabed
    // breaks the surface — accurate enough for a chart bearing and a fog horn.
    const hf = bestIsl.hf;
    const cx = bestIsl.center.x;
    const cz = bestIsl.center.z;
    const dx = cx - x;
    const dz = cz - z;
    const len = Math.hypot(dx, dz) || 1;
    const ux = dx / len;
    const uz = dz / len;
    let hit = -1;
    const step = Math.max(16, len / 96);
    for (let t = Math.max(0, len - bestIsl.landRadius - step); t <= len; t += step) {
      if (hf.height(x + ux * t - cx, z + uz * t - cz) > 0.25) {
        hit = t;
        break;
      }
    }
    if (hit < 0) return null;
    // Refine to a couple of metres.
    let lo = Math.max(0, hit - step);
    let hi = hit;
    for (let k = 0; k < 6; k++) {
      const mid = (lo + hi) * 0.5;
      if (hf.height(x + ux * mid - cx, z + uz * mid - cz) > 0.25) hi = mid;
      else lo = mid;
    }
    const q = this.landQuery;
    q.distance = hi;
    q.position.set(x + ux * hi, hf.height(x + ux * hi - cx, z + uz * hi - cz), z + uz * hi);
    q.islandId = bestIsl.id;
    q.bearing = Math.atan2(ux, -uz);
    return q;
  }

  private clearanceAhead(
    x: number,
    z: number,
    heading: number,
    maxDist: number,
    clearanceM: number,
  ): number {
    const ux = Math.sin(heading);
    const uz = -Math.cos(heading);
    const step = Math.max(20, maxDist / 120);
    for (let t = step; t <= maxDist; t += step) {
      if (this.heightAt(x + ux * t, z + uz * t) > -clearanceM) return t;
    }
    return maxDist;
  }

  /* ---------------------------------------------------------------- *
   *  program warm-up
   * ---------------------------------------------------------------- */

  /**
   * Compile the terrain and shore programs during init. Without this the first
   * island to stream in costs a 100 ms compile stall exactly when the player is
   * looking at it.
   */
  private warmPrograms(): void {
    const world = this.world;
    const dummyF = new THREE.DataTexture(new Float32Array(4 * 2), 2, 2, THREE.RGFormat, THREE.FloatType);
    dummyF.minFilter = THREE.NearestFilter;
    dummyF.magFilter = THREE.NearestFilter;
    dummyF.needsUpdate = true;
    const dummyB = new THREE.DataTexture(new Uint8Array(4 * 4), 2, 2, THREE.RGBAFormat);
    dummyB.needsUpdate = true;
    const dummyR = new THREE.DataTexture(new Uint8Array(4), 2, 2, THREE.RedFormat);
    dummyR.needsUpdate = true;

    const common = {
      tHeight: { value: dummyF },
      tMat: { value: dummyB },
      tCoarse: { value: dummyR },
      uHF: { value: new THREE.Vector4(2, 100, 50, 0.5) },
      uHFC: { value: new THREE.Vector4(2, 100, 0, 0.5) },
      uIslandPos: { value: new THREE.Vector3(0, -9000, 0) },
      uLodStart: { value: new Float32Array(8) },
      uLodEnd: { value: new Float32Array(8) },
      uPatch: { value: PATCH },
      uWaveH: { value: 1 },
      uSwellDir: { value: new THREE.Vector2(0, 1) },
      uSandCol: { value: new THREE.Color(0.5, 0.5, 0.5) },
      uRockCol: { value: new THREE.Color(0.2, 0.2, 0.2) },
    };
    const detail = this.resources.detail;
    const mats = [
      new THREE.ShaderMaterial({
        name: 'world-terrain',
        glslVersion: THREE.GLSL3,
        uniforms: {
          ...world.uniforms,
          ...common,
          tDetail: { value: detail.albedo },
          tDetailN: { value: detail.normal },
          uFloraCol: { value: new THREE.Color(0.1, 0.2, 0.1) },
          uSnowLine: { value: 1e5 },
          uNear: { value: 0 },
        },
        vertexShader: terrainVert,
        fragmentShader: terrainFrag,
      }),
      new THREE.ShaderMaterial({
        name: 'world-shore',
        glslVersion: THREE.GLSL3,
        uniforms: { ...world.uniforms, ...common, uSeaY: { value: 0 }, uReef: { value: 0.5 } },
        vertexShader: shoreVert,
        fragmentShader: shoreFrag,
        transparent: true,
        depthWrite: false,
      }),
    ];

    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', this.resources.patchPos);
    geo.setIndex(this.resources.patchIdx);
    const attr = new THREE.InstancedBufferAttribute(new Float32Array(4), 4);
    geo.setAttribute('aNode', attr);
    geo.instanceCount = 0;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, -9000, 0), 1);

    for (const m of mats) {
      const mesh = new THREE.Mesh(geo, m);
      mesh.frustumCulled = false;
      mesh.position.set(0, -9000, 0);
      world.scene.add(mesh);
      this.warmup.push(mesh);
    }
    try {
      world.renderer.compile(world.scene, world.camera);
    } catch {
      /* compile is best-effort; the material still works if it throws */
    }
    // Kept in the scene but never drawn, so the program cache keeps its
    // reference and the first real island reuses it.
    for (const m of this.warmup) m.visible = false;
    this.props.warm(world);
  }

  dispose(): void {
    for (const off of this.offSub) off();
    this.offSub.length = 0;
    for (const w of this.workers) w.terminate();
    this.workers.length = 0;
    for (const isl of this.islands.values()) {
      this.props.release(isl);
      this.landmarks.release(isl);
      isl.dispose();
    }
    this.islands.clear();
    for (const m of this.warmup) {
      m.removeFromParent();
      (m.material as THREE.Material).dispose();
    }
    this.warmup.length = 0;
    this.props.dispose();
    this.landmarks.dispose();
    this.resources.dispose();
  }
}
