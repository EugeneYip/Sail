import * as THREE from 'three';

/**
 * A tiny mesh builder for the world's hand-written props — gulls, dolphins,
 * whales, other vessels, a harbour town.
 *
 * Every vertex carries a baked linear albedo and a four-float `aux` whose
 * meaning belongs to the material that consumes it (see `shaders/creature.ts`
 * and `shaders/vessel.ts`). Baking the colour per vertex is what lets one
 * program draw a black hull, a buff gunport stripe, copper sheathing and a
 * canvas sail without a texture or a second material.
 *
 * Normals are accumulated from the faces at `finish()`, so a box built with
 * four vertices per face comes out flat and a loft that shares its rings comes
 * out smooth. That is the whole reason there is no `normal` argument — with the
 * single exception of `rope()`, whose triangles have no area to accumulate from.
 */
export class MeshBuilder {
  private pos: number[] = [];
  private col: number[] = [];
  private aux: number[] = [];
  private idx: number[] = [];
  /** Vertices whose normal is dictated rather than accumulated. */
  private nfix = new Map<number, RGB>();

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  get triangleCount(): number {
    return this.idx.length / 3;
  }

  vert(x: number, y: number, z: number, c: RGB, a: Aux): number {
    const i = this.pos.length / 3;
    this.pos.push(x, y, z);
    this.col.push(c[0], c[1], c[2]);
    this.aux.push(a[0], a[1], a[2], a[3]);
    return i;
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  quad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, a, c, d);
  }

  /**
   * Stitch a ribbon of equal-length rings into a tube. `rings[i][j]` is vertex
   * index j of ring i; every ring must have the same length. `closed` welds the
   * last column back onto the first.
   */
  tube(rings: number[][], closed: boolean): void {
    for (let i = 0; i + 1 < rings.length; i++) {
      const a = rings[i];
      const b = rings[i + 1];
      const n = a.length;
      const last = closed ? n : n - 1;
      for (let j = 0; j < last; j++) {
        const k = (j + 1) % n;
        this.quad(a[j], a[k], b[k], b[j]);
      }
    }
  }

  /** Axis-aligned box with flat faces. */
  box(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, c: RGB, a: Aux): void {
    const s = BOX_FACES;
    for (let f = 0; f < 6; f++) {
      const o = f * 12;
      const i0 = this.vert(cx + s[o] * hx, cy + s[o + 1] * hy, cz + s[o + 2] * hz, c, a);
      const i1 = this.vert(cx + s[o + 3] * hx, cy + s[o + 4] * hy, cz + s[o + 5] * hz, c, a);
      const i2 = this.vert(cx + s[o + 6] * hx, cy + s[o + 7] * hy, cz + s[o + 8] * hz, c, a);
      const i3 = this.vert(cx + s[o + 9] * hx, cy + s[o + 10] * hy, cz + s[o + 11] * hz, c, a);
      // Reversed. `finish()` takes its face normal as (b - a) x (c - a), and under
      // that order the table's own winding comes out INWARD: the +Y face reads
      // e1 x e2 = (2,0,0) x (2,0,2) = (0,-4,0). Measured on a committed box whose
      // top face is at a known height, all four of its vertices carried
      // normal.y = -1, so every box was lit as though its roof were its floor.
      // That is why Boston's quays, wharf and buildings rendered as black slabs.
      //
      // Only Boston reaches this method -- the ship has its own MeshBuilder --
      // so the correction is contained. `tube`, `cyl` and `rope` here share the
      // same inverted convention and are NOT touched: those are also reached by
      // the vessels, the buoys and the creatures, and re-lighting all of them is
      // its own pass with its own verification.
      this.quad(i0, i3, i2, i1);
    }
  }

  /** Tapered cylinder from p0 to p1. `seg` >= 3. Caps are flat fans. */
  cyl(
    x0: number, y0: number, z0: number,
    x1: number, y1: number, z1: number,
    r0: number, r1: number, seg: number, c: RGB, a: Aux,
  ): void {
    const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
    const len = Math.hypot(dx, dy, dz) || 1;
    const ax = dx / len, ay = dy / len, az = dz / len;
    // Any perpendicular will do; pick the axis the direction leans on least.
    let ux = 0, uy = 1, uz = 0;
    if (Math.abs(ay) > 0.9) { ux = 1; uy = 0; }
    let tx = uy * az - uz * ay;
    let ty = uz * ax - ux * az;
    let tz = ux * ay - uy * ax;
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl; ty /= tl; tz /= tl;
    const bx = ay * tz - az * ty;
    const by = az * tx - ax * tz;
    const bz = ax * ty - ay * tx;

    const ring0: number[] = [];
    const ring1: number[] = [];
    for (let j = 0; j < seg; j++) {
      const th = (j / seg) * Math.PI * 2;
      const cs = Math.cos(th), sn = Math.sin(th);
      const ox = tx * cs + bx * sn, oy = ty * cs + by * sn, oz = tz * cs + bz * sn;
      ring0.push(this.vert(x0 + ox * r0, y0 + oy * r0, z0 + oz * r0, c, a));
      ring1.push(this.vert(x1 + ox * r1, y1 + oy * r1, z1 + oz * r1, c, a));
    }
    this.tube([ring0, ring1], true);
    if (r0 > 1e-4) {
      const hub = this.vert(x0, y0, z0, c, a);
      for (let j = 0; j < seg; j++) this.tri(hub, ring0[(j + 1) % seg], ring0[j]);
    }
    if (r1 > 1e-4) {
      const hub = this.vert(x1, y1, z1, c, a);
      for (let j = 0; j < seg; j++) this.tri(hub, ring1[j], ring1[(j + 1) % seg]);
    }
  }

  /**
   * A rope: two vertices per station, both at the axis, expanded into a
   * camera-facing ribbon by the vertex shader.
   *
   * Why not a thin `cyl()`. A 5 cm shroud at 400 m is a fifth of a pixel wide,
   * the renderer asks for no MSAA, and a sub-pixel opaque triangle rasterises
   * with BINARY coverage — it lands on a pixel centre or it does not, and which
   * flips as the camera moves. Thirty of them doing that at once is a crawling
   * net, and it is why the standing rigging on these hulls simply was not there
   * past a couple of cables. Emitted as a degenerate strip instead, the shader
   * widens it to a pixel and scales its alpha by the rope's true coverage, so
   * the ink is conserved at every range. That fix, and its measurements, come
   * straight from the player's own rig — see `src/ship/shaders/line.ts`.
   *
   * `aux` is (LINE_KIND [+1 to follow a square yard], side, radius m, rough);
   * `side` and the radius are filled in here, so callers pass kind and rough.
   * The normal carries the rope's own axis, which is what the shader needs to
   * build the ribbon; it cannot be accumulated from a zero-area triangle.
   */
  rope(
    x0: number, y0: number, z0: number,
    x1: number, y1: number, z1: number,
    r0: number, r1: number, kind: number, rough: number, c: RGB, spans = 1,
  ): void {
    const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
    const len = Math.hypot(dx, dy, dz) || 1;
    const t: RGB = [dx / len, dy / len, dz / len];
    const rows: number[][] = [];
    for (let i = 0; i <= spans; i++) {
      const s = i / spans;
      const x = x0 + dx * s, y = y0 + dy * s, z = z0 + dz * s;
      const r = r0 + (r1 - r0) * s;
      const row: number[] = [];
      for (const side of [-1, 1]) {
        const v = this.vert(x, y, z, c, [kind, side, r, rough]);
        this.nfix.set(v, t);
        row.push(v);
      }
      rows.push(row);
    }
    this.tube(rows, false);
  }

  /** Flat double-sided-looking blade: a quad strip swept from root to tip. */
  blade(pts: number[], c: RGB, auxAt: (t: number, edge: number) => Aux): void {
    // pts is [x,y,z, halfChordX,halfChordY,halfChordZ] per station.
    const n = pts.length / 6;
    const lo: number[] = [];
    const hi: number[] = [];
    for (let i = 0; i < n; i++) {
      const o = i * 6;
      const t = n > 1 ? i / (n - 1) : 0;
      lo.push(this.vert(pts[o] - pts[o + 3], pts[o + 1] - pts[o + 4], pts[o + 2] - pts[o + 5], c, auxAt(t, -1)));
      hi.push(this.vert(pts[o] + pts[o + 3], pts[o + 1] + pts[o + 4], pts[o + 2] + pts[o + 5], c, auxAt(t, 1)));
    }
    for (let i = 0; i + 1 < n; i++) this.quad(lo[i], hi[i], hi[i + 1], lo[i + 1]);
  }

  finish(name: string): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.name = name;
    const pos = new Float32Array(this.pos);
    const nrm = new Float32Array(pos.length);
    const idx = this.idx;
    for (let i = 0; i < idx.length; i += 3) {
      const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
      const e1x = pos[b] - pos[a], e1y = pos[b + 1] - pos[a + 1], e1z = pos[b + 2] - pos[a + 2];
      const e2x = pos[c] - pos[a], e2y = pos[c + 1] - pos[a + 1], e2z = pos[c + 2] - pos[a + 2];
      // Un-normalised cross product: area-weighting falls out for free and is
      // what keeps a long thin triangle from dominating a vertex normal.
      const nx = e1y * e2z - e1z * e2y;
      const ny = e1z * e2x - e1x * e2z;
      const nz = e1x * e2y - e1y * e2x;
      nrm[a] += nx; nrm[a + 1] += ny; nrm[a + 2] += nz;
      nrm[b] += nx; nrm[b + 1] += ny; nrm[b + 2] += nz;
      nrm[c] += nx; nrm[c + 1] += ny; nrm[c + 2] += nz;
    }
    for (let i = 0; i < nrm.length; i += 3) {
      const l = Math.hypot(nrm[i], nrm[i + 1], nrm[i + 2]) || 1;
      nrm[i] /= l; nrm[i + 1] /= l; nrm[i + 2] /= l;
    }
    for (const [v, n] of this.nfix) {
      nrm[v * 3] = n[0]; nrm[v * 3 + 1] = n[1]; nrm[v * 3 + 2] = n[2];
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setAttribute('aCol', new THREE.BufferAttribute(new Float32Array(this.col), 3));
    g.setAttribute('aAux', new THREE.BufferAttribute(new Float32Array(this.aux), 4));
    g.setIndex(idx.length > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    return g;
  }
}

export type RGB = readonly [number, number, number];
export type Aux = readonly [number, number, number, number];

/** A hex colour typed by eye, converted once to the scene-linear space. */
export function srgb(hex: number): RGB {
  const c = new THREE.Color(hex).convertSRGBToLinear();
  return [c.r, c.g, c.b];
}

export function mixRGB(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export function scaleRGB(a: RGB, k: number): RGB {
  return [a[0] * k, a[1] * k, a[2] * k];
}

/** Copy the source geometry into an InstancedBufferGeometry, ready for per-instance attributes. */
export function toInstanced(src: THREE.BufferGeometry): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', src.getAttribute('position'));
  g.setAttribute('normal', src.getAttribute('normal'));
  g.setAttribute('aCol', src.getAttribute('aCol'));
  g.setAttribute('aAux', src.getAttribute('aAux'));
  g.setIndex(src.getIndex());
  g.instanceCount = 0;
  return g;
}

/** Unit-cube corner triples, four per face. `box()` reverses them; see there. */
const BOX_FACES = [
  1, -1, -1, 1, -1, 1, 1, 1, 1, 1, 1, -1, // +X
  -1, -1, 1, -1, -1, -1, -1, 1, -1, -1, 1, 1, // -X
  -1, 1, -1, 1, 1, -1, 1, 1, 1, -1, 1, 1, // +Y
  -1, -1, 1, 1, -1, 1, 1, -1, -1, -1, -1, -1, // -Y
  -1, -1, 1, -1, 1, 1, 1, 1, 1, 1, -1, 1, // +Z
  1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, -1, // -Z
];
