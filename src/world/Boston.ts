import * as THREE from 'three';
import type { World } from '../types';
import { makeRng } from '../util/math';
import { MeshBuilder, mixRGB, srgb, type Aux, type RGB } from './wgeom';
import { vesselFrag, vesselShared, vesselVert } from './shaders/vessel';

/**
 * Same arrangement as the vessels: blending on, but NOT in the transparent
 * list, so the town keeps its opaque sort and its depth write and only her
 * shipping's masts — which are a twentieth of a pixel wide at eight kilometres
 * — get a partial alpha. See `ROPE_BLEND` in `Vessels.ts`.
 */
const TOWN_BLEND = {
  transparent: false,
  depthWrite: true,
  blending: THREE.CustomBlending,
  blendSrc: THREE.SrcAlphaFactor,
  blendDst: THREE.OneMinusSrcAlphaFactor,
  blendSrcAlpha: THREE.OneFactor,
  blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
} as const;

/**
 * Boston, from seaward, about 1800.
 *
 * The ship is the Constitution, so this is her home port and it is worth doing
 * as a recognisable landfall rather than as generic buildings. What a master
 * actually saw coming up the outer harbour, and what is modelled here:
 *
 *   - the Brewsters and the outer drumlins, low green humps in a line
 *   - Boston Light on the outermost of them, white, tapered, 1783
 *   - Castle Island with its low fort commanding the channel
 *   - the Trimountain behind the town: Beacon Hill in the middle, Copp's Hill
 *     to the north, Fort Hill to the south
 *   - Bulfinch's new State House on the crest of Beacon Hill, 1798, its dome
 *     still shingled and pale rather than gilded
 *   - church spires, Old North's the tallest and northernmost
 *   - Long Wharf running half a kilometre into the harbour, and the thicket of
 *     masts alongside it, which is the single most legible thing about a
 *     seaport of this date
 *
 * Built in slices of about 1.5 ms so the landfall never costs a hitch, and held
 * in ABSOLUTE voyage coordinates — unlike the wildlife, a harbour is a place,
 * and it has to still be there when you come back for it.
 */

const BUILD_BUDGET_MS = 1.5;
/** Town scale. Real Boston peninsula is about 3 km on its long axis. */
const TOWN_LEN = 2600;
const TOWN_DEPTH = 900;
/**
 * Where the ridge crest lies, metres inland of the waterfront.
 *
 * This number, not the hill height, is what decides whether there is a skyline
 * at all. The ground used to rise monotonically inland (`inland = z / 700`), so
 * the highest ground was always at the BACK of the peninsula — which means the
 * State House dome, at 300 m in, stood against hillside and not against sky.
 * Only the top nine metres of a fifty-six-metre-tall landmark had anything
 * behind it to be a silhouette against, and a silhouette is the whole of what
 * you can see of a town at eight kilometres. Beacon Hill really is like this:
 * it crests where the State House stands and falls away to the Charles behind.
 */
const CREST_Z = 330;
/**
 * Beacon Hill's summit, metres. EXAGGERATED, and this is the size of the lie.
 *
 * The Trimountain summits were 45-60 m. At eight kilometres and a 50 degree
 * vertical field, one metre of height is 0.121 px, so a faithful 50 m hill is
 * SIX PIXELS — less than the cloud it stands under, and the first capture of
 * this town put it on the horizon and the horizon stayed flat. 90 m reads.
 *
 * The trade is deliberate and it is the smaller of two lies available. The old
 * arrangement also used 90 m but threw two thirds of it away on the near slope
 * and put the crest behind the town, so the ridge you actually saw was 57 m and
 * the dome had no sky behind it: an exaggeration that cost the recognisability
 * it was spent on. Moving the crest forward means the visible summit is now the
 * number written here, so 90 m of hill buys 11 px of skyline instead of 7.
 *
 * Nothing else is exaggerated to match: the State House is at its real 52 m to
 * the finial, Old North at its real 58 m. They read because the ground under
 * them now falls away behind, not because they were inflated.
 */
const BEACON_H = 90;

/**
 * Seaward profile. The ground reaches SHELF_DEPTH metres down SHELF_RUN metres
 * off the shoreline, so the harbour has a floor that is nowhere near sea level.
 */
const SHELF_RUN = 300;
const SHELF_DEPTH = 34;
/** How fast the ground gets out of the water: the beach is deliberately narrow. */
const BEACH_RUN = 26;
const BERM_H = 2.4;
/** Metres inland over which the hills take over from the berm. */
const HILL_RUN = 200;
/** Underside of the closed land volume. Below the shelf, so the solid is sealed. */
const LAND_FLOOR = -52;
/** Where a harbour drumlin's base sits. Well under the deepest trough. */
const ISLAND_BASE_Y = -18;

/**
 * The navigable corridor, town-local: a funnel from the roads in to the head of
 * Long Wharf. This is the piece the environment never had — with nothing
 * declaring where the water was supposed to be, nothing kept the land out of it.
 * Islands are held clear of this and the shoreline is built around it.
 */
const CHANNEL_X = 60;
const CHANNEL_HEAD_Z = -400;
function channelHalfWidth(z: number): number {
  const t = Math.min(1, Math.max(0, (-z + CHANNEL_HEAD_Z) / 2600));
  return 240 + 520 * t;
}

const smoothstep01 = (s: number): number => s * s * (3 - 2 * s);
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * How much land there is at a place: 1 on the peninsula, 0 out in the harbour.
 *
 * This is what stops the footprint being a rectangle. Without it the grid simply
 * ended at x = +-1300 and at its last inland row, and because the hill Gaussians
 * are spent by then the ground out there was nothing but the 2.4 m berm — a low
 * spit running to a ruler-straight edge, walled off to the floor. Seen from
 * anywhere but dead ahead those two side walls and the back wall are the hard
 * diagonal land boundaries in the player's frames.
 *
 * Multiplied in, the mask takes the ground down to the shelf instead, so the
 * land's own boundary is a depth contour and the peninsula ends in water on
 * three sides — which is also what Beacon Hill actually does, falling away to
 * the Charles behind.
 */
function landMask(x: number, d: number): number {
  const lat = 1 - smoothstep01(clamp01((Math.abs(x) - 1090) / 300));
  const back = 1 - smoothstep01(clamp01((d - 690) / 310));
  return Math.min(lat, back);
}

/** Stable per-position jitter, so the terrain and what stands on it agree. */
function landJitter(x: number, z: number): number {
  const v = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return v - Math.floor(v);
}

/**
 * The shoreline: the town-local z at which the ground crosses mean sea level,
 * as a function of x.
 *
 * Wiggly on purpose. The old waterfront was the front row of a rectangular grid
 * at constant z, which is what made the harbour edge a straight barrier 2600 m
 * long — visible as a knife cut from any station and as a hard diagonal once the
 * town's bearing was not square to the eye. Three octaves give coves and points
 * with a 130 m throw, so no run of the shore is straight for long.
 */
function shoreZ(x: number): number {
  const t = x / (TOWN_LEN * 0.5);
  return -40
    + 74 * Math.sin(t * 2.15 + 0.6)
    + 38 * Math.sin(t * 5.1 - 1.3)
    + 17 * Math.sin(t * 9.7 + 2.2);
}

interface Slice {
  label: string;
  run: (b: MeshBuilder, rng: () => number) => void;
}

export class Boston {
  private mesh: THREE.Mesh | null = null;
  private material: THREE.ShaderMaterial | null = null;
  private builder: MeshBuilder | null = null;
  private slices: Slice[] = [];
  private sliceIndex = 0;
  private rng = makeRng(0xb05104);

  /** Absolute voyage coordinates of the town centre, or null when not placed. */
  private absX = 0;
  private absZ = 0;
  private placed = false;
  private bearing = 0;
  private nextEvent = 0;
  private world!: World;
  private xf!: THREE.InstancedBufferAttribute;
  private mo!: THREE.InstancedBufferAttribute;
  private bd!: THREE.InstancedBufferAttribute;

  /**
   * Mean seconds between landfalls. Long: a harbour on the horizon should be
   * something you remember from a voyage, not a thing that happens every lap.
   */
  private static readonly MEAN_GAP_S = 1100;
  private static readonly RETIRE_M = 46000;

  init(world: World): void {
    this.world = world;
    this.nextEvent = -1;
    void this.nextEvent;
    this.nextEvent = Boston.MEAN_GAP_S * 0.7;
  }

  /**
   * `range` metres, dead on the bow. Dead ahead rather than the usual random
   * bearing because the whole question about a landfall is what its silhouette
   * does, and a silhouette cannot be A/B'd from two crops taken at two
   * different bearings.
   */
  showcase(world: World, range = 4200): void {
    this.place(world, range, 0);
    this.nextEvent = 1e6;
  }

  private draw(mean: number): number {
    return -mean * Math.log(1 - this.rng() * 0.999);
  }

  /** Put the town on the horizon at `range` metres, roughly on the bow. */
  private place(world: World, range: number, offBow?: number): void {
    const r = this.rng;
    const b = world.ship.heading + (offBow ?? (r() - 0.5) * 0.7);
    this.absX = world.ship.position.x + world.origin.x + Math.sin(b) * range;
    this.absZ = world.ship.position.z + world.origin.z - Math.cos(b) * range;
    /*
     * The town faces the sea: her long axis across the approach, her waterfront
     * toward you and her hills receding.
     *
     * This was `b + PI/2`, and that is a quarter turn out. The vertex shader
     * maps town-local +Z to (-sin, cos) of this angle, and at b + PI/2 that
     * came out PERPENDICULAR to the line of sight — so the 900 m depth axis was
     * what spread across the frame and the 2600 m length ran away from the eye.
     * Three hills laid out along x were therefore stacked one behind another,
     * and the landfall measured 850 m wide when it should have measured 2600:
     * the Trimountain could not read as three humps because it was never
     * presented as three of anything. Measured before the change and after it.
     */
    this.bearing = b + Math.PI;
    this.placed = true;
    if (!this.builder && !this.mesh) this.beginBuild();
    world.bus.emit('world:landfall', { name: 'Boston', range });
  }

  private beginBuild(): void {
    this.builder = new MeshBuilder();
    this.sliceIndex = 0;
    this.slices = [
      { label: 'peninsula', run: (b, r) => this.buildLand(b, r) },
      { label: 'islands', run: (b, r) => this.buildIslands(b, r) },
      { label: 'town1', run: (b, r) => this.buildTown(b, r, 90) },
      { label: 'town2', run: (b, r) => this.buildTown(b, r, 90) },
      { label: 'town3', run: (b, r) => this.buildTown(b, r, 90) },
      { label: 'town4', run: (b, r) => this.buildTown(b, r, 80) },
      { label: 'landmarks', run: (b, r) => this.buildLandmarks(b, r) },
      // Two slices: the shipping is 168 hulls now and one slice of it overran
      // the 1.5 ms budget, which is the whole point of slicing.
      { label: 'wharf', run: (b, r) => this.buildWharf(b, r, 0) },
      { label: 'shipping', run: (b, r) => this.buildWharf(b, r, 1) },
    ];
  }

  /* ---------------------------------------------------------------- *
   *  geometry
   * ---------------------------------------------------------------- */

  /**
   * The peninsula: three hills on a low neck, lofted as a ridge of
   * cross-sections so the skyline is a silhouette rather than a box.
   */
  private buildLand(b: MeshBuilder, rng: () => number): void {
    void rng;
    const grass = srgb(0x54603a);
    const dry = srgb(0x6d6b46);
    const beach = srgb(0xb9ac8b);
    const seabed = srgb(0x2c3a34);
    const aux: Aux = [0, 0, 0, 0.9];

    const nx = 84;
    // Past the town on every side, so the mask has room to take the ground down
    // to the shelf and the boundary ring is a uniform depth instead of a cliff.
    const gridHalf = TOWN_LEN * 0.5 + 260;
    /*
     * Rows are offsets FROM THE SHORELINE, not constant z.
     *
     * That is the whole trick, and it is what the old grid could not do. Its rows
     * were lines of constant z, so the waterline was wherever those lines happened
     * to cross sea level — which, with the height clamped to zero seaward, was an
     * entire 75 m band of rows at once. Here the row at offset 0 IS the shoreline:
     * `landHeight` is zero at d = 0 by construction, so that row lies exactly on
     * the waterline and every other row is strictly above or strictly below it.
     * The crossing is a curve one row thick, and it costs no extra vertices.
     */
    const OFF = [-460, -330, -235, -160, -105, -62, -30, -12, 0, 12, 30, 62,
      105, 160, 235, 330, 470, 650, 840, 1040, 1240];
    const rows: number[][] = [];
    for (const d of OFF) {
      const row: number[] = [];
      for (let i = 0; i < nx; i++) {
        const x = -gridHalf + (i / (nx - 1)) * gridHalf * 2;
        const z = shoreZ(x) + d;
        const y = this.landHeight(x, z);
        row.push(b.vert(x, y, z, this.landColour(x, z, y, grass, dry, beach, seabed), aux));
      }
      rows.push(row);
    }
    /*
     * Stitched INLAND -> SEAWARD, and that is not cosmetic.
     *
     * `finish()` derives normals from winding and the town's fragment shader is a
     * bare `normalize(vNormal)` with no `gl_FrontFacing` flip. Stitched the other
     * way the quads run +x by +z-inland, whose cross product points DOWN, so the
     * peninsula was lit as a downward-facing surface: no direct sun ever reached
     * it and the whole of Boston rendered as a near-black slab against a bright
     * harbour. That is most of what read as "giant dark terrain" in the reports.
     * Reversed, the same vertices give an upward normal and the land is lit.
     */
    b.tube([...rows].reverse(), false);

    /*
     * Close the volume.
     *
     * The old land was a single open height surface plus one skirt band across the
     * front, so its sides, its back and its underside were all missing. Rendered
     * `DoubleSide`, that meant a camera anywhere inside the footprint saw the
     * unlit inside of a shell — a black void with the town's buildings hanging
     * detached in it, which is exactly the frame the player sent.
     *
     * Making it opaque from more angles would have kept the bad topology. Instead
     * the boundary ring is walled down to a floor and the floor is capped, so the
     * land is a closed solid and there is no interior surface to expose.
     */
    const nz = rows.length;
    const ring: number[] = [];
    const ringXZ: [number, number][] = [];
    const push = (j: number, i: number): void => {
      ring.push(rows[j][i]);
      const x = -gridHalf + (i / (nx - 1)) * gridHalf * 2;
      ringXZ.push([x, shoreZ(x) + OFF[j]]);
    };
    for (let i = 0; i < nx; i++) push(0, i);
    for (let j = 1; j < nz; j++) push(j, nx - 1);
    for (let i = nx - 2; i >= 0; i--) push(nz - 1, i);
    for (let j = nz - 2; j >= 1; j--) push(j, 0);

    const floor: number[] = [];
    const wall = mixRGB(seabed, srgb(0x1b211e), 0.5);
    for (const [x, z] of ringXZ) floor.push(b.vert(x, LAND_FLOOR, z, wall, aux));
    b.tube([ring, floor], true);

    let cx = 0;
    let cz = 0;
    for (const [x, z] of ringXZ) { cx += x; cz += z; }
    cx /= ringXZ.length;
    cz /= ringXZ.length;
    const hub = b.vert(cx, LAND_FLOOR, cz, wall, aux);
    for (let k = 0; k < floor.length; k++) {
      b.tri(hub, floor[(k + 1) % floor.length], floor[k]);
    }
  }

  /**
   * The Trimountain, as a silhouette.
   *
   * Three humps only read as three if the saddles between them are deep enough
   * to see. At eight kilometres a metre is an eighth of a pixel, so a saddle has
   * to drop 25-30 m to be worth two pixels of notch — which means the humps have
   * to be NARROW. The old profile gave Beacon a sigma of 338 m against a
   * 1300 m half-length, so it swallowed both its neighbours and the ridge came
   * out as one broad swell with two imperceptible shoulders.
   */
  /**
   * Ground height, town-local: POSITIVE inland, NEGATIVE to seaward.
   *
   * The old version ended with `shore = clamp((z + 60) / 150, 0, 1)`, which
   * pinned the height to exactly 0 for every z <= -60 while the grid's front row
   * sat at z = -135. That is a 2600 x 75 m plate at precisely mean sea level,
   * coplanar with the ocean: it surfaced in every wave trough, it gave the
   * harbour a straight knife-cut edge, and it is the pale plane the player was
   * sailing across. 152 vertices sat at exactly y = 0 and a quarter of the whole
   * town was inside +-5 m of it.
   *
   * Now the height is a signed function of distance from `shoreZ`, so the surface
   * crosses zero on a CURVE and keeps going down past it. Nothing is coplanar
   * with the sea, because only the contour itself is ever at sea level.
   *
   * Pure, unlike the old one. That took the rng and so handed a building a
   * different jitter than it had given the terrain underneath it, which let
   * buildings float or sink by up to 1.2 m.
   */
  private landHeight(x: number, z: number): number {
    const halfL = TOWN_LEN * 0.5;
    const t = x / halfL;
    // Copp's Hill to the north, Beacon in the middle, Fort Hill to the south.
    const hills = Math.max(
      BEACON_H * Math.exp(-Math.pow((t + 0.04) / 0.155, 2)),
      Math.max(
        BEACON_H * 0.60 * Math.exp(-Math.pow((t + 0.58) / 0.135, 2)),
        BEACON_H * 0.52 * Math.exp(-Math.pow((t - 0.54) / 0.15, 2)),
      ),
    );
    // A ridge that crests over the town and falls away behind it, so everything
    // built on the crest has sky behind it instead of more hill.
    const ridge = z < CREST_Z
      ? 0.16 + 0.84 * Math.pow(Math.max(0, z) / CREST_Z, 1.25)
      : Math.max(0.32, 1 - 0.68 * Math.pow((z - CREST_Z) / (TOWN_DEPTH - CREST_Z), 1.25));

    const d = z - shoreZ(x);
    /*
     * Both branches are zero at d = 0, so blending each of them against the
     * shelf by the same mask stays continuous across the waterline: where the
     * mask is partial the coast simply retreats, and where it reaches zero there
     * is no coast at all, only harbour.
     */
    const m = landMask(x, d);
    const inner = d <= 0
      ? -SHELF_DEPTH * smoothstep01(Math.min(1, -d / SHELF_RUN))
      : BERM_H * smoothstep01(Math.min(1, d / BEACH_RUN))
        + (hills * ridge + (landJitter(x, z) - 0.5) * 2.4)
          * smoothstep01(Math.min(1, d / HILL_RUN));
    return inner * m - SHELF_DEPTH * (1 - m);
  }

  private landColour(x: number, z: number, y: number, grass: RGB, dry: RGB,
                     beach: RGB, seabed: RGB): RGB {
    // Keyed on the height that was actually built, so the masked ends read as
    // seabed rather than as beach sand sitting 20 m under water.
    if (y < -0.15) return mixRGB(beach, seabed, Math.min(1, -y / 11));
    const d = z - shoreZ(x);
    if (y < BERM_H * 0.95) return beach;
    const t = Math.min(1, Math.max(0, (d - BEACH_RUN * 1.6) / 260));
    return mixRGB(mixRGB(beach, grass, t), dry, 0.25 + 0.2 * Math.sin(x * 0.004));
  }

  /** The harbour islands: low drumlins in a line seaward of the town. */
  private buildIslands(b: MeshBuilder, rng: () => number): void {
    const grass = srgb(0x4d5a36);
    const rock = srgb(0x5b5952);
    const aux: Aux = [0, 0, 0, 0.92];
    const spots = [
      [-1500, -2600, 340, 26],
      [-450, -3150, 300, 21],
      [700, -2500, 260, 18],
      [1700, -3000, 420, 31],
      [1150, -1350, 220, 12],
      [-1900, -1500, 200, 14],
    ];
    for (const [cx0, cz, rad, h] of spots) {
      /*
       * Held clear of the navigable corridor. Two of these six sat inside it —
       * (-450, -3150) and (700, -2500) overlapped the channel by 490 m and 250 m
       * — so a ship standing in on the fairway ran into a drumlin. Pushed out to
       * the near edge plus their own radius plus 60 m of water.
       */
      const need = channelHalfWidth(cz) + rad + 60;
      const off = cx0 - CHANNEL_X;
      const cx = Math.abs(off) < need
        ? CHANNEL_X + (off < 0 ? -need : need)
        : cx0;
      const ringN = 14;
      const rings: number[][] = [];
      for (let k = 0; k < 5; k++) {
        const s = k / 4;
        const rr = rad * Math.cos(s * Math.PI * 0.5);
        /*
         * Base at ISLAND_BASE_Y, summit still at h. The old form was
         * `h * sin(..) - 3`, which put the base 3 m under a sea running metres:
         * the drumlins flooded and re-emerged instead of having a shore. Lifting
         * the whole curve off a deeper base keeps the summit exactly where it was
         * — Boston Light stands on the outermost of these at y = 26.
         */
        const y = ISLAND_BASE_Y
          + (h - ISLAND_BASE_Y) * Math.sin(s * Math.PI * 0.5) * (0.7 + 0.3 * s);
        const ring: number[] = [];
        for (let j = 0; j < ringN; j++) {
          const th = (j / ringN) * Math.PI * 2;
          const wob = 0.78 + 0.34 * Math.sin(th * 3 + cx * 0.01);
          ring.push(
            b.vert(
              cx + Math.cos(th) * rr * wob,
              y + (rng() - 0.5) * 1.2,
              cz + Math.sin(th) * rr * wob * 0.72,
              mixRGB(rock, grass, Math.min(1, Math.max(0, y) / Math.max(1, h * 0.5))),
              aux,
            ),
          );
        }
        rings.push(ring);
      }
      // Summit-first, for the same reason the peninsula is stitched inland-first:
      // wound base-first these drumlins carried inward, downward normals and so
      // rendered unlit, which is why the harbour islands were dark lumps.
      // Measured before the change: 0 of 426 vertices had an upward normal.
      b.tube([...rings].reverse(), true);
      const cap = b.vert(cx, h, cz, grass, aux);
      const top = rings[rings.length - 1];
      for (let j = 0; j < ringN; j++) b.tri(cap, top[(j + 1) % ringN], top[j]);
    }
  }

  /** Brick and clapboard, packed on the slopes and thinning inland. */
  private buildTown(b: MeshBuilder, rng: () => number, count: number): void {
    const brick = srgb(0x7a4a3a);
    const clap = srgb(0xa9a494);
    const slate = srgb(0x4a4c52);
    const aux: Aux = [0, 0, 0, 0.86];
    const halfL = TOWN_LEN * 0.5;

    for (let n = 0; n < count; n++) {
      const u = rng();
      // Densest on the waterfront and up the near slope of Beacon Hill.
      const x = -halfL * 0.86 + u * TOWN_LEN * 0.86;
      // Measured INLAND OF THE SHORELINE, not from a fixed z. The shore wanders
      // 130 m now, so a constant-z band would have put the waterfront houses in
      // the water on the points and 130 m up the hill in the coves.
      const z = shoreZ(x) + 12 + Math.pow(rng(), 1.5) * 640;
      const ground = this.landHeight(x, z);
      if (ground < 0.6) continue;
      const w = 7 + rng() * 13;
      const d = 7 + rng() * 12;
      const h = 6 + rng() * 9 + (z < 160 ? 3 : 0);
      const wall = rng() < 0.62 ? brick : clap;
      b.box(x, ground + h * 0.5, z, w * 0.5, h * 0.5, d * 0.5, wall, aux);
      // A darker, slightly smaller cap reads as a pitched slate roof at range.
      b.box(x, ground + h + 1.6, z, w * 0.44, 1.7, d * 0.44, slate, aux);
    }
  }

  /** The things that make it Boston and not a town. */
  private buildLandmarks(b: MeshBuilder, rng: () => number): void {
    const aux: Aux = [0, 0, 0, 0.8];
    // Deliberately near-white: at 5 km the aerial perspective eats everything
    // that is not much brighter than the haze, and the spires and the dome are
    // the only parts of the silhouette a player can actually name.
    const stone = srgb(0xdcd6c2);
    const white = srgb(0xf4f1e6);
    const lead = srgb(0xb6b8b6);
    const halfL = TOWN_LEN * 0.5;

    /*
     * The State House, ON the crest of Beacon Hill.
     *
     * Bulfinch's dome is 15 m across and this one is 24. That is the one thing
     * in the town that is inflated on purpose: at eight kilometres 15 m is
     * 1.8 px, and a dome two pixels wide is a bump. 24 m is three, which is
     * enough to read as round against a straight ridge — and roundness is what
     * names it. Its height is NOT inflated: 52 m to the finial, which is what
     * Bulfinch built, and it clears the ridge only because the ridge now falls
     * away behind it.
     */
    const shX = -halfL * 0.04;
    const shZ = CREST_Z;
    const shY = this.landHeight(shX, shZ);
    const DOME_R = 12;
    // Shingled in 1798, so pale, not gold — and the brightest thing in the town,
    // because at five kilometres the haze eats anything that is not.
    const shingle = srgb(0xefe8d2);
    b.box(shX, shY + 11, shZ, 34, 11, 15, srgb(0x8d5a44), aux);
    b.box(shX, shY + 24, shZ, 15, 3, 15, stone, aux);
    b.cyl(shX, shY + 27, shZ, shX, shY + 34, shZ, DOME_R * 1.06, DOME_R, 12, stone, aux);
    const domeRings: number[][] = [];
    for (let k = 0; k <= 5; k++) {
      const s = k / 5;
      const rr = DOME_R * Math.cos(s * Math.PI * 0.5);
      const yy = shY + 34 + 12 * Math.sin(s * Math.PI * 0.5);
      const ring: number[] = [];
      for (let j = 0; j < 12; j++) {
        const th = (j / 12) * Math.PI * 2;
        ring.push(b.vert(shX + Math.cos(th) * rr, yy, shZ + Math.sin(th) * rr, k > 3 ? shingle : lead, aux));
      }
      domeRings.push(ring);
    }
    b.tube(domeRings, true);
    // The lantern and finial, as a rope rather than a 1.8 m cylinder: at eight
    // kilometres that cylinder is a fifth of a pixel and it is the topmost
    // point of the whole landfall, so it is exactly the thing that must not
    // blink in and out as the ship moves.
    b.rope(shX, shY + 45, shZ, shX, shY + 52, shZ, 1.7, 0.7, 3, 0.8, shingle);

    /*
     * Spires. Old North is the tall one and it stands at the far end of the
     * town over the low hill — 58 m, which is its real height, and it is on the
     * crest so the whole steeple is against sky. The others are shorter and
     * further down the slope, which is what makes the tall one legible: a
     * skyline is read from its outline, and an outline needs a hierarchy.
     */
    const spires: readonly (readonly [number, number, number])[] = [
      [-halfL * 0.58, CREST_Z - 24, 58],
      [-halfL * 0.28, 214, 42],
      [halfL * 0.05, 156, 38],
      [halfL * 0.32, 246, 45],
      [halfL * 0.60, 190, 36],
    ];
    /*
     * Towers 13 m square and spires 6 m at the base. Old North's tower is
     * nearer 9 m and its spire nearer 4, so both are exaggerated about 1.4x —
     * stated, because at eight kilometres 9 m is ONE pixel and the spire above
     * it was 0.5 m at the top, which is a twentieth of a pixel. Measured on the
     * skyline profile before this change: the tallest spire in the town reached
     * 6 px of the 10 px it stands, because its top four pixels were sub-pixel
     * geometry and simply were not drawn. The spire itself is a rope, so what
     * is left of it past resolution fades instead of blinking.
     */
    for (const [sx, sz, sh] of spires) {
      const g = this.landHeight(sx, sz);
      b.box(sx, g + sh * 0.32, sz, 6.5, sh * 0.32, 6.5, white, aux);
      b.rope(sx, g + sh * 0.6, sz, sx, g + sh, sz, 3.0, 0.9, 3, 0.8, white);
    }

    // --- Boston Light on the outermost drumlin, and the fort on Castle Island
    b.cyl(1700, 26, -3000, 1700, 26 + 24, -3000, 4.6, 3.2, 10, white, aux);
    b.cyl(1700, 50, -3000, 1700, 54, -3000, 3.6, 3.2, 10, srgb(0x2f3338), aux);

    const fx = 1150;
    const fz = -1350;
    const fy = 12;
    for (let j = 0; j < 5; j++) {
      const th = (j / 5) * Math.PI * 2;
      const nth = ((j + 1) / 5) * Math.PI * 2;
      const r0 = 105;
      b.box(
        fx + Math.cos((th + nth) * 0.5) * r0 * 0.82,
        fy + 4,
        fz + Math.sin((th + nth) * 0.5) * r0 * 0.82,
        26,
        4.5,
        13,
        srgb(0x8a7f68),
        aux,
      );
    }
    b.box(fx, fy + 6, fz, 30, 6, 30, srgb(0x7d7360), aux);
  }

  /**
   * Long Wharf and the shipping. A forest of masts alongside a quay is the most
   * legible thing about a seaport, and at 8 km it is the only thing you can
   * read apart from the hills.
   */
  /**
   * Long Wharf and the shipping — the thicket of masts that is the single most
   * legible thing about a seaport of this date, and the hardest thing here to
   * draw honestly.
   *
   * A lower mast is 60-80 cm through at the deck. At eight kilometres that is a
   * TWENTIETH of a pixel, and drawn as a tapered cylinder it was one of two
   * things: nothing at all, or a hard black pixel wherever it happened to cross
   * a pixel centre, moving from mast to mast as the ship sailed. Sixty-four of
   * them made a sparse crawling stipple, not a thicket. As `rope()` ribbons
   * each mast contributes exactly its own coverage instead, so a hundred of
   * them sum to the faint grey haze a hundred masts actually look like, and it
   * holds still.
   *
   * Emitted FAR TO NEAR, because a ribbon widened to a pixel at this range is
   * sixteen metres wide in world space, so masts overlap heavily and the mesh
   * writes depth. Far first means each nearer mast blends over what is already
   * there instead of a nearer one discarding all the rest. The order is only
   * right from seaward, which is the side a harbour is approached from; sail
   * past and look back and the thicket thins, which is the graceful way for
   * this to fail.
   */
  private buildWharf(b: MeshBuilder, rng: () => number, part: number): void {
    const aux: Aux = [0, 0, 0, 0.85];
    const timber = srgb(0x6b5a44);
    // Weathered and slushed dark, because contrast against the haze is what
    // makes a mast visible at all and a bright spar has none.
    const spar = srgb(0x584631);
    const stone = srgb(0x8b8474);

    if (part === 0) {
      /*
       * land -> seawall -> pier -> open water, in that order.
       *
       * All three used to be one thing: a slab. Long Wharf was
       * `box(60, 2.4, -230, 17, 2.4, 250)`, i.e. y in [0, 4.8] over 500 m of
       * z — half a kilometre of deck lying flat ON the water plane with nothing
       * under it and nothing at either end. The quays were the same at y in
       * [0, 4.0], and they sat at constant z along the whole 2600 m frontage, so
       * together they read as one continuous plate covering the harbour edge.
       */

      // The seawall. Straddles the waterline: footed at -6, coping at +3.6, and
      // set 8 m inland of the contour so the wall IS the shore rather than a
      // separate object standing in front of it. Seven runs, 980 m of the 2600 m
      // frontage, so the shore between them is still beach and there is no
      // full-width plate anywhere.
      for (const [qx, qw] of [[-1010, 130], [-700, 150], [-390, 150],
        [-120, 110], [350, 170], [700, 150], [1010, 120]] as const) {
        b.box(qx, -1.2, shoreZ(qx) + 8, qw, 4.8, 16, stone, aux);
      }

      // Long Wharf. Deck ABOVE the water at y in [3.2, 5.2] rather than through
      // it, carried on two rows of piles that run down past the trough, and
      // abutted into the shore at its landward end instead of stopping in mid-air.
      const wharfX = 60;
      const root = shoreZ(wharfX) + 20;
      const head = -480;
      const midZ = (root + head) * 0.5;
      const halfZ = (root - head) * 0.5;
      b.box(wharfX, 4.2, midZ, 17, 1.0, halfZ, timber, aux);
      b.box(wharfX, 1.6, shoreZ(wharfX) + 12, 15, 1.9, 26, stone, aux);
      for (let pz = head + 14; pz < root - 10; pz += 27) {
        for (const side of [-1, 1]) {
          b.box(wharfX + side * 13, -3.4, pz, 1.2, 6.7, 1.2, spar, aux);
        }
      }
      // The warehouse at the root of the wharf, standing ON the deck.
      b.box(wharfX, 9.8, shoreZ(wharfX) - 44, 12, 4.6, 34, timber, aux);
      return;
    }

    // Moored across the whole frontage, not down one wharf: a rank of masts
    // that recedes along the line of sight stacks into two vertical lines
    // instead of spreading into a thicket.
    const ships: { x: number; z: number; h: number; r: number; len: number; yards: number }[] = [];
    for (let n = 0; n < 152; n++) {
      const alongside = n % 4 !== 3;
      ships.push({
        // Alongside the quays that run the length of the waterfront, or out in
        // the roads. Both spread ACROSS the frontage: seventy masts stacked down
        // one wharf occupy ten pixels of screen at this range and blend into a
        // single line, which is the same mistake as laying the hills out along
        // the line of sight.
        x: alongside ? -1080 + rng() * 2160 : -900 + rng() * 1900,
        z: alongside ? -170 - rng() * 130 : -330 - rng() * 460,
        h: 17 + rng() * 26,
        r: 0.30 + rng() * 0.15,
        len: 8 + rng() * 8,
        yards: 1 + (rng() < 0.6 ? 1 : 0),
      });
    }
    // Long Wharf keeps its own crowd, since it is the one named quay.
    for (let n = 0; n < 16; n++) {
      ships.push({
        x: 60 + (n % 2 === 0 ? 1 : -1) * (24 + rng() * 12),
        z: -460 + rng() * 400,
        h: 20 + rng() * 24,
        r: 0.32 + rng() * 0.13,
        len: 9 + rng() * 8,
        yards: 1 + (rng() < 0.6 ? 1 : 0),
      });
    }
    ships.sort((p, q) => q.z - p.z);
    for (const s of ships) {
      // Afloat, not aground: the shoreline wanders 130 m, so a mooring drawn at a
      // fixed z could land 100 m up the beach on a point.
      s.z = Math.min(s.z, shoreZ(s.x) - 26);
      // Out in the roads, keep the fairway clear. Alongside the quays and down
      // Long Wharf they stay where they are — that IS the head of the channel and
      // an empty waterfront would be the wrong fix.
      if (s.z < -520) {
        const need = channelHalfWidth(s.z) + 40 + rng() * 180;
        const off = s.x - CHANNEL_X;
        if (Math.abs(off) < need) s.x = CHANNEL_X + (off < 0 ? -need : need);
      }
      b.rope(s.x, 0.5, s.z, s.x + (rng() - 0.5) * 1.4, s.h, s.z, s.r, s.r * 0.34, 3, 0.85, spar);
      // One or two yards: without them a mast is a stick, not a ship.
      for (let k = 0; k < s.yards; k++) {
        const yy = s.h * (0.42 + k * 0.26);
        const hs = 3.5 + rng() * 4.5;
        b.rope(s.x - hs, yy, s.z, s.x + hs, yy, s.z, s.r * 0.4, s.r * 0.4, 3, 0.85, spar);
      }
      // A dark hull under her, just proud of the water.
      b.box(s.x, 1.1, s.z, 3.4, 1.5, s.len, srgb(0x2a2722), aux);
    }
  }

  /* ---------------------------------------------------------------- *
   *  frame
   * ---------------------------------------------------------------- */

  update(world: World, dt: number): void {
    // --- appearance
    this.nextEvent -= dt;
    if (this.nextEvent <= 0) {
      if (this.placed) {
        this.nextEvent = this.draw(Boston.MEAN_GAP_S);
      } else {
        this.place(world, 5000 + this.rng() * 3600);
        this.nextEvent = this.draw(Boston.MEAN_GAP_S * 1.6);
      }
    }

    // --- time-sliced build
    if (this.builder) {
      const t0 = performance.now();
      while (this.sliceIndex < this.slices.length && performance.now() - t0 < BUILD_BUDGET_MS) {
        this.slices[this.sliceIndex].run(this.builder, this.rng);
        this.sliceIndex++;
      }
      world.stats['world.bostonBuildMs'] = performance.now() - t0;
      if (this.sliceIndex >= this.slices.length) {
        this.commit(world, this.builder);
        this.builder = null;
        this.slices.length = 0;
      }
      return;
    }

    const mesh = this.mesh;
    if (!mesh || !this.placed) return;

    // Absolute -> render space, exactly as the islands do it, so a rebase costs
    // nothing and a landfall you sail away from is still where you left it.
    const rx = this.absX - world.origin.x;
    const rz = this.absZ - world.origin.z;
    const d = Math.hypot(rx - world.ship.position.x, rz - world.ship.position.z);
    if (d > Boston.RETIRE_M) {
      this.placed = false;
      mesh.visible = false;
      return;
    }
    mesh.visible = true;
    this.xf.setXYZW(0, rx, 0, rz, this.bearing);
    this.xf.needsUpdate = true;
    (mesh.geometry.boundingSphere as THREE.Sphere).center.set(rx, 120, rz);
    world.stats['world.bostonRangeM'] = Math.round(d);
  }

  private commit(world: World, b: MeshBuilder): void {
    const body = b.finish('world-boston');
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', body.getAttribute('position'));
    geo.setAttribute('normal', body.getAttribute('normal'));
    geo.setAttribute('aCol', body.getAttribute('aCol'));
    geo.setAttribute('aAux', body.getAttribute('aAux'));
    geo.setIndex(body.getIndex());
    geo.instanceCount = 1;
    this.xf = new THREE.InstancedBufferAttribute(new Float32Array([0, 0, 0, 0]), 4);
    this.mo = new THREE.InstancedBufferAttribute(new Float32Array([0, 0, 1, 0]), 4);
    this.bd = new THREE.InstancedBufferAttribute(new Float32Array([0, 0, 1, 0]), 4);
    this.xf.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aXf', this.xf);
    geo.setAttribute('aMo', this.mo);
    geo.setAttribute('aBd', this.bd);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), TOWN_LEN);

    this.material = new THREE.ShaderMaterial({
      name: 'world-boston',
      // A town has no gunport stripe, and a zero half-height is what switches
      // the fragment shader's band filter off.
      uniforms: {
        ...world.uniforms,
        ...vesselShared,
        uStripe: { value: new THREE.Vector4(0, 0, 0, 0) },
        uPorts: { value: new THREE.Vector4(0, 0, 0, 0) },
      },
      vertexShader: vesselVert,
      fragmentShader: vesselFrag,
      side: THREE.DoubleSide,
      ...TOWN_BLEND,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'world-boston';
    this.mesh.renderOrder = 1;
    this.mesh.userData.town = { len: TOWN_LEN, depth: TOWN_DEPTH, hill: BEACON_H };
    this.mesh.visible = false;
    world.scene.add(this.mesh);
    world.stats['world.bostonTris'] = (body.getIndex()?.count ?? 0) / 3;
  }

  dispose(): void {
    this.mesh?.removeFromParent();
    this.mesh?.geometry.dispose();
    this.material?.dispose();
    this.mesh = null;
    this.material = null;
    this.builder = null;
  }
}
