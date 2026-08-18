/**
 * A small triangle-soup builder.
 *
 * Everything the ship is made of goes through this so that each material
 * family ends up as exactly one merged BufferGeometry — which is what keeps the
 * whole ship inside its draw-call budget. Besides the usual position/normal/uv
 * it carries two extras:
 *
 *   color  — per-part tonal variation and baked dirt, multiplied into albedo
 *   aPart  — index into the animated-transform uniform array (see shaders/parts)
 */

import * as THREE from 'three';

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _n = new THREE.Vector3();

export class MeshBuilder {
  readonly pos: number[] = [];
  readonly nrm: number[] = [];
  readonly uv: number[] = [];
  readonly col: number[] = [];
  readonly part: number[] = [];
  readonly idx: number[] = [];

  /** Current vertex colour (linear). */
  readonly color = new THREE.Color(1, 1, 1);
  /** Current animated-part slot. */
  partIndex = 0;

  private xf = new THREE.Matrix4();
  private nxf = new THREE.Matrix3();
  private xfStack: THREE.Matrix4[] = [];
  private hasXf = false;

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  setColor(r: number, g: number, b: number): this {
    this.color.setRGB(r, g, b);
    return this;
  }
  setColorHexLinear(hex: number, scale = 1): this {
    this.color.setHex(hex).convertSRGBToLinear().multiplyScalar(scale);
    return this;
  }

  pushTransform(m: THREE.Matrix4): this {
    this.xfStack.push(this.xf.clone());
    this.xf.multiply(m);
    this.nxf.setFromMatrix4(this.xf);
    this.hasXf = true;
    return this;
  }
  popTransform(): this {
    const m = this.xfStack.pop();
    if (m) this.xf.copy(m);
    else this.xf.identity();
    this.nxf.setFromMatrix4(this.xf);
    this.hasXf = this.xfStack.length > 0 || !isIdentity(this.xf);
    return this;
  }

  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number): number {
    if (this.hasXf) {
      _v0.set(x, y, z).applyMatrix4(this.xf);
      x = _v0.x;
      y = _v0.y;
      z = _v0.z;
      _v1.set(nx, ny, nz).applyMatrix3(this.nxf).normalize();
      nx = _v1.x;
      ny = _v1.y;
      nz = _v1.z;
    }
    const i = this.pos.length / 3;
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.uv.push(u, v);
    this.col.push(this.color.r, this.color.g, this.color.b);
    this.part.push(this.partIndex);
    return i;
  }

  vert(p: THREE.Vector3, n: THREE.Vector3, u: number, v: number): number {
    return this.vertex(p.x, p.y, p.z, n.x, n.y, n.z, u, v);
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }
  quad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, a, c, d);
  }

  /* ---------------------------------------------------------------- *
   *  Primitives
   * ---------------------------------------------------------------- */

  /**
   * Parametric surface over a (nu x nv) grid. `fn` writes the position for
   * (i, j); normals are taken from the sampled grid by central difference so
   * the caller never has to differentiate anything by hand. `skip(i, j)`
   * suppresses the quad whose lower-left corner is (i, j).
   */
  grid(
    nu: number,
    nv: number,
    fn: (i: number, j: number, out: THREE.Vector3) => void,
    uvFn: (i: number, j: number) => [number, number],
    opts: {
      flip?: boolean;
      skip?: (i: number, j: number) => boolean;
      colorFn?: (i: number, j: number, out: THREE.Color) => void;
      partFn?: (i: number, j: number) => number;
    } = {},
  ): Int32Array {
    const pts = new Float32Array(nu * nv * 3);
    const p = new THREE.Vector3();
    for (let i = 0; i < nu; i++) {
      for (let j = 0; j < nv; j++) {
        fn(i, j, p);
        const k = (i * nv + j) * 3;
        pts[k] = p.x;
        pts[k + 1] = p.y;
        pts[k + 2] = p.z;
      }
    }
    const at = (i: number, j: number, out: THREE.Vector3) => {
      const ii = Math.max(0, Math.min(nu - 1, i));
      const jj = Math.max(0, Math.min(nv - 1, j));
      const k = (ii * nv + jj) * 3;
      return out.set(pts[k], pts[k + 1], pts[k + 2]);
    };
    const ids = new Int32Array(nu * nv);
    const baseColor = this.color.clone();
    const basePart = this.partIndex;
    for (let i = 0; i < nu; i++) {
      for (let j = 0; j < nv; j++) {
        at(i + 1, j, _v0).sub(at(i - 1, j, _v1));
        at(i, j + 1, _v1).sub(at(i, j - 1, _v2));
        _n.crossVectors(_v0, _v1);
        if (_n.lengthSq() < 1e-14) _n.set(0, 1, 0);
        else _n.normalize();
        if (opts.flip) _n.negate();
        const [u, v] = uvFn(i, j);
        if (opts.colorFn) {
          this.color.copy(baseColor);
          opts.colorFn(i, j, this.color);
        }
        if (opts.partFn) this.partIndex = opts.partFn(i, j);
        at(i, j, _v2);
        ids[i * nv + j] = this.vert(_v2, _n, u, v);
      }
    }
    this.color.copy(baseColor);
    this.partIndex = basePart;
    for (let i = 0; i < nu - 1; i++) {
      for (let j = 0; j < nv - 1; j++) {
        if (opts.skip && opts.skip(i, j)) continue;
        const a = ids[i * nv + j];
        const b = ids[(i + 1) * nv + j];
        const c = ids[(i + 1) * nv + j + 1];
        const d = ids[i * nv + j + 1];
        if (opts.flip) this.quad(a, d, c, b);
        else this.quad(a, b, c, d);
      }
    }
    return ids;
  }

  /** Axis-aligned box centred at (cx, cy, cz). */
  box(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, uvScale = 1): void {
    const faces: [number, number, number, number, number, number][] = [
      [1, 0, 0, hx, hy, hz],
      [-1, 0, 0, hx, hy, hz],
      [0, 1, 0, hx, hy, hz],
      [0, -1, 0, hx, hy, hz],
      [0, 0, 1, hx, hy, hz],
      [0, 0, -1, hx, hy, hz],
    ];
    for (const [nx, ny, nz] of faces) {
      // Build an orthonormal frame around the face normal.
      let ux = 0;
      let uy = 0;
      let uz = 0;
      if (Math.abs(ny) > 0.5) {
        ux = 1;
      } else {
        uy = 1;
      }
      const vx = ny * uz - nz * uy;
      const vy = nz * ux - nx * uz;
      const vz = nx * uy - ny * ux;
      const su = Math.abs(ux) * hx + Math.abs(uy) * hy + Math.abs(uz) * hz;
      const sv = Math.abs(vx) * hx + Math.abs(vy) * hy + Math.abs(vz) * hz;
      const ox = nx * hx;
      const oy = ny * hy;
      const oz = nz * hz;
      const corner = (a: number, b: number) =>
        this.vertex(
          cx + ox + ux * su * a + vx * sv * b,
          cy + oy + uy * su * a + vy * sv * b,
          cz + oz + uz * su * a + vz * sv * b,
          nx, ny, nz,
          (a * 0.5 + 0.5) * su * 2 * uvScale,
          (b * 0.5 + 0.5) * sv * 2 * uvScale,
        );
      const a0 = corner(-1, -1);
      const a1 = corner(1, -1);
      const a2 = corner(1, 1);
      const a3 = corner(-1, 1);
      this.quad(a0, a1, a2, a3);
    }
  }

  /**
   * Swept tube through a polyline with per-node radius. Used for masts, spars,
   * booms and any rope that gets real geometry.
   */
  tube(
    path: readonly THREE.Vector3[],
    radii: readonly number[],
    radial = 8,
    caps = true,
    uvScale = 1,
  ): void {
    const n = path.length;
    if (n < 2) return;
    const tan: THREE.Vector3[] = [];
    for (let i = 0; i < n; i++) {
      const a = path[Math.max(0, i - 1)];
      const b = path[Math.min(n - 1, i + 1)];
      tan.push(new THREE.Vector3().subVectors(b, a).normalize());
    }
    // Parallel-transport a reference frame to avoid twisting.
    let ref = new THREE.Vector3(0, 1, 0);
    if (Math.abs(tan[0].dot(ref)) > 0.9) ref = new THREE.Vector3(1, 0, 0);
    const frames: [THREE.Vector3, THREE.Vector3][] = [];
    let prevU = new THREE.Vector3().crossVectors(ref, tan[0]).normalize();
    for (let i = 0; i < n; i++) {
      const u = prevU.clone().sub(tan[i].clone().multiplyScalar(prevU.dot(tan[i]))).normalize();
      const v = new THREE.Vector3().crossVectors(tan[i], u).normalize();
      frames.push([u, v]);
      prevU = u;
    }
    let len = 0;
    const lens: number[] = [0];
    for (let i = 1; i < n; i++) {
      len += path[i].distanceTo(path[i - 1]);
      lens.push(len);
    }
    const ids: number[][] = [];
    const p = new THREE.Vector3();
    const nn = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      const row: number[] = [];
      const [u, v] = frames[i];
      for (let k = 0; k <= radial; k++) {
        const a = (k / radial) * Math.PI * 2;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        nn.set(u.x * ca + v.x * sa, u.y * ca + v.y * sa, u.z * ca + v.z * sa).normalize();
        p.copy(path[i]).addScaledVector(nn, radii[i]);
        row.push(this.vert(p, nn, (k / radial) * radii[i] * 6.283 * uvScale, lens[i] * uvScale));
      }
      ids.push(row);
    }
    for (let i = 0; i < n - 1; i++) {
      for (let k = 0; k < radial; k++) {
        // Wound so the face normal from the winding agrees with the stored
        // outward normal — otherwise every spar is back-face culled and you
        // see the inside of the tube shaded by a normal pointing away.
        this.quad(ids[i][k], ids[i][k + 1], ids[i + 1][k + 1], ids[i + 1][k]);
      }
    }
    if (caps) {
      for (const [i, sign] of [[0, -1], [n - 1, 1]] as const) {
        const t = tan[i].clone().multiplyScalar(sign);
        const c = this.vert(path[i], t, 0.5, 0.5);
        const ring: number[] = [];
        const [u, v] = frames[i];
        for (let k = 0; k <= radial; k++) {
          const a = (k / radial) * Math.PI * 2;
          nn.set(
            u.x * Math.cos(a) + v.x * Math.sin(a),
            u.y * Math.cos(a) + v.y * Math.sin(a),
            u.z * Math.cos(a) + v.z * Math.sin(a),
          );
          p.copy(path[i]).addScaledVector(nn, radii[i]);
          ring.push(this.vert(p, t, 0.5 + 0.5 * Math.cos(a), 0.5 + 0.5 * Math.sin(a)));
        }
        for (let k = 0; k < radial; k++) {
          if (sign < 0) this.tri(c, ring[k + 1], ring[k]);
          else this.tri(c, ring[k], ring[k + 1]);
        }
      }
    }
  }

  /** Straight tapered spar between two points. */
  spar(a: THREE.Vector3, b: THREE.Vector3, r0: number, r1: number, radial = 8, taperEnds = false): void {
    const n = taperEnds ? 7 : 2;
    const path: THREE.Vector3[] = [];
    const radii: number[] = [];
    for (let i = 0; i < n; i++) {
      const s = i / (n - 1);
      path.push(new THREE.Vector3().lerpVectors(a, b, s));
      // A real yard tapers to its arms; the middle stays full.
      const base = r0 + (r1 - r0) * s;
      radii.push(taperEnds ? base * (0.42 + 0.58 * Math.sin(Math.PI * (0.12 + 0.76 * s))) : base);
    }
    this.tube(path, radii, radial, true);
  }

  /** Solid of revolution around +Y from a (radius, y) profile. */
  revolve(profile: readonly [number, number][], segments = 12, uvScale = 1): void {
    const n = profile.length;
    const ids: number[][] = [];
    const p = new THREE.Vector3();
    const nn = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      const [r, y] = profile[i];
      const rp = profile[Math.min(n - 1, i + 1)];
      const rm = profile[Math.max(0, i - 1)];
      const dr = rp[0] - rm[0];
      const dy = rp[1] - rm[1];
      const row: number[] = [];
      for (let k = 0; k <= segments; k++) {
        const a = (k / segments) * Math.PI * 2;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        nn.set(dy * ca, -dr, dy * sa).normalize();
        p.set(r * ca, y, r * sa);
        row.push(this.vert(p, nn, (k / segments) * uvScale, y * uvScale));
      }
      ids.push(row);
    }
    for (let i = 0; i < n - 1; i++) {
      for (let k = 0; k < segments; k++) {
        // Same winding correction as `tube`.
        this.quad(ids[i][k], ids[i + 1][k], ids[i + 1][k + 1], ids[i][k + 1]);
      }
    }
  }

  /** Flat ring/annulus in the XZ plane, optionally rectangular outside. */
  disc(cy: number, rInner: number, rOuter: number, segments = 16, up = true): void {
    const nY = up ? 1 : -1;
    const ids: number[][] = [];
    for (const r of [rInner, rOuter]) {
      const row: number[] = [];
      for (let k = 0; k <= segments; k++) {
        const a = (k / segments) * Math.PI * 2;
        row.push(
          this.vertex(r * Math.cos(a), cy, r * Math.sin(a), 0, nY, 0, r * Math.cos(a), r * Math.sin(a)),
        );
      }
      ids.push(row);
    }
    for (let k = 0; k < segments; k++) {
      if (up) this.quad(ids[0][k], ids[0][k + 1], ids[1][k + 1], ids[1][k]);
      else this.quad(ids[0][k], ids[1][k], ids[1][k + 1], ids[0][k + 1]);
    }
  }

  /** Extrude a closed 2D polygon (in XY) along +Z, with flat caps. */
  prism(poly: readonly [number, number][], z0: number, z1: number, capNormalFlip = false): void {
    const n = poly.length;
    const side: number[][] = [];
    for (let i = 0; i < n; i++) {
      const [x0, y0] = poly[i];
      const [x1, y1] = poly[(i + 1) % n];
      const ex = x1 - x0;
      const ey = y1 - y0;
      const l = Math.hypot(ex, ey) || 1;
      const nx = ey / l;
      const ny = -ex / l;
      const a = this.vertex(x0, y0, z0, nx, ny, 0, 0, 0);
      const b = this.vertex(x1, y1, z0, nx, ny, 0, l, 0);
      const c = this.vertex(x1, y1, z1, nx, ny, 0, l, z1 - z0);
      const d = this.vertex(x0, y0, z1, nx, ny, 0, 0, z1 - z0);
      this.quad(a, b, c, d);
      side.push([a, b, c, d]);
    }
    // Fan the caps from the polygon centroid — all our polys are convex enough.
    let cx = 0;
    let cy = 0;
    for (const [x, y] of poly) {
      cx += x / n;
      cy += y / n;
    }
    for (const [z, nz] of [[z0, -1], [z1, 1]] as const) {
      const sgn = capNormalFlip ? -nz : nz;
      const c = this.vertex(cx, cy, z, 0, 0, sgn, cx, cy);
      const ring = poly.map(([x, y]) => this.vertex(x, y, z, 0, 0, sgn, x, y));
      for (let i = 0; i < n; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % n];
        if (sgn > 0) this.tri(c, a, b);
        else this.tri(c, b, a);
      }
    }
  }

  /** Append another builder's contents, offset by a transform. */
  append(other: MeshBuilder, m?: THREE.Matrix4): void {
    const base = this.pos.length / 3;
    const nm = m ? new THREE.Matrix3().setFromMatrix4(m) : null;
    const p = new THREE.Vector3();
    const nn = new THREE.Vector3();
    for (let i = 0; i < other.pos.length / 3; i++) {
      p.set(other.pos[i * 3], other.pos[i * 3 + 1], other.pos[i * 3 + 2]);
      nn.set(other.nrm[i * 3], other.nrm[i * 3 + 1], other.nrm[i * 3 + 2]);
      if (m) {
        p.applyMatrix4(m);
        nn.applyMatrix3(nm!).normalize();
      }
      this.pos.push(p.x, p.y, p.z);
      this.nrm.push(nn.x, nn.y, nn.z);
      this.uv.push(other.uv[i * 2], other.uv[i * 2 + 1]);
      this.col.push(other.col[i * 3], other.col[i * 3 + 1], other.col[i * 3 + 2]);
      this.part.push(other.part[i]);
    }
    for (const k of other.idx) this.idx.push(k + base);
  }

  get triangleCount(): number {
    return this.idx.length / 3;
  }

  toGeometry(withPart = true): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    if (withPart) g.setAttribute('aPart', new THREE.Float32BufferAttribute(this.part, 1));
    g.setIndex(this.pos.length / 3 > 65535
      ? new THREE.Uint32BufferAttribute(this.idx, 1)
      : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

function isIdentity(m: THREE.Matrix4): boolean {
  const e = m.elements;
  return (
    e[0] === 1 && e[5] === 1 && e[10] === 1 && e[15] === 1 &&
    e[12] === 0 && e[13] === 0 && e[14] === 0
  );
}

/** Convenience: a matrix that places a unit-Y object along an arbitrary axis. */
export function alignY(from: THREE.Vector3, to: THREE.Vector3, out = new THREE.Matrix4()): THREE.Matrix4 {
  const dir = new THREE.Vector3().subVectors(to, from);
  const len = dir.length() || 1e-6;
  dir.divideScalar(len);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  return out.compose(from, q, new THREE.Vector3(1, len, 1));
}
