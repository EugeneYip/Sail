// .tmp/bakeprobe/three-stub.js
var RGBAFormat = 1023;
var UnsignedByteType = 1009;
var SRGBColorSpace = "srgb";
var NoColorSpace = "";
var RepeatWrapping = 1e3;
var LinearFilter = 1006;
var LinearMipmapLinearFilter = 1008;
var DataTexture = class {
  constructor(data, w, h) {
    this.image = { data, width: w, height: h };
    this.data = data;
  }
  dispose() {
  }
};

// src/ship/materials/noise.ts
function lattice(ix, iy, seed) {
  let h = ix * 374761393 + iy * 668265263 + seed * 1274126177 | 0;
  h = Math.imul(h ^ h >>> 13, 1274126177);
  return ((h ^ h >>> 16) >>> 0) / 4294967296;
}
function wrap(i, per) {
  return (i % per + per) % per;
}
function vnoise(x, y, perX, perY, seed) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const wx0 = wrap(x0, perX);
  const wx1 = wrap(x0 + 1, perX);
  const wy0 = wrap(y0, perY);
  const wy1 = wrap(y0 + 1, perY);
  const a = lattice(wx0, wy0, seed);
  const b = lattice(wx1, wy0, seed);
  const c = lattice(wx0, wy1, seed);
  const d = lattice(wx1, wy1, seed);
  const ab = a + (b - a) * ux;
  const cd = c + (d - c) * ux;
  return ab + (cd - ab) * uy;
}
function fbm(u, v, perX, perY, octaves, seed, gain = 0.5) {
  let amp = 0.5;
  let sum = 0;
  let norm = 0;
  let px = perX;
  let py = perY;
  for (let i = 0; i < octaves; i++) {
    sum += amp * vnoise(u * px, v * py, px, py, seed + i * 7919);
    norm += amp;
    amp *= gain;
    px *= 2;
    py *= 2;
  }
  return sum / norm;
}
function ridged(u, v, perX, perY, octaves, seed) {
  let amp = 0.5;
  let sum = 0;
  let norm = 0;
  let px = perX;
  let py = perY;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(vnoise(u * px, v * py, px, py, seed + i * 6151) * 2 - 1);
    sum += amp * n * n;
    norm += amp;
    amp *= 0.5;
    px *= 2;
    py *= 2;
  }
  return sum / norm;
}
function worleyCell(u, v, per, seed, out) {
  const px = u * per;
  const py = v * per;
  const ix = Math.floor(px);
  const iy = Math.floor(py);
  let best = 9;
  let bx = 0;
  let by = 0;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const cx = wrap(ix + i, per);
      const cy = wrap(iy + j, per);
      const dx = ix + i + lattice(cx, cy, seed) - px;
      const dy = iy + j + lattice(cx, cy, seed + 977) - py;
      const d = dx * dx + dy * dy;
      if (d < best) {
        best = d;
        bx = cx;
        by = cy;
      }
    }
  }
  out.d = Math.sqrt(best);
  out.r = lattice(bx, by, seed + 5501);
}
function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
function mix(a, b, t) {
  return a + (b - a) * t;
}

// src/ship/materials/textures.ts
var TEXTURES = [];
function bake(size, normalStrength, fn) {
  const alb = new Uint8Array(size * size * 4);
  const orm = new Uint8Array(size * size * 4);
  const hgt = new Float32Array(size * size);
  const px = { r: 0.5, g: 0.5, b: 0.5, h: 0.5, rough: 0.6, ao: 1, metal: 0 };
  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      px.r = 0.5;
      px.g = 0.5;
      px.b = 0.5;
      px.h = 0.5;
      px.rough = 0.6;
      px.ao = 1;
      px.metal = 0;
      fn(u, v, px);
      const i = y * size + x;
      alb[i * 4] = clamp01(px.r) * 255;
      alb[i * 4 + 1] = clamp01(px.g) * 255;
      alb[i * 4 + 2] = clamp01(px.b) * 255;
      alb[i * 4 + 3] = 255;
      orm[i * 4] = clamp01(px.ao) * 255;
      orm[i * 4 + 1] = clamp01(px.rough) * 255;
      orm[i * 4 + 2] = clamp01(px.metal) * 255;
      orm[i * 4 + 3] = 255;
      hgt[i] = px.h;
    }
  }
  const nrm = new Uint8Array(size * size * 4);
  const at = (x, y) => hgt[(y % size + size) % size * size + (x % size + size) % size];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1);
      const dy = at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1);
      let nx = -dx * normalStrength;
      let ny = -dy * normalStrength;
      const nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l;
      ny /= l;
      const i = (y * size + x) * 4;
      nrm[i] = (nx * 0.5 + 0.5) * 255;
      nrm[i + 1] = (ny * 0.5 + 0.5) * 255;
      nrm[i + 2] = (nz / l * 0.5 + 0.5) * 255;
      nrm[i + 3] = 255;
    }
  }
  const mk = (data, srgb) => {
    const t = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
    t.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
    t.wrapS = RepeatWrapping;
    t.wrapT = RepeatWrapping;
    t.magFilter = LinearFilter;
    t.minFilter = LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 8;
    t.needsUpdate = true;
    TEXTURES.push(t);
    return t;
  };
  return { map: mk(alb, true), normalMap: mk(nrm, false), ormMap: mk(orm, false), normalScale: 1 };
}
function disposeTextures() {
  for (const t of TEXTURES) t.dispose();
  TEXTURES.length = 0;
}
var PLANKS_PER_TILE = 4;
function plankLayout(u, v, seed, sectionsPerTile, out) {
  const pv = v * PLANKS_PER_TILE;
  out.row = Math.floor(pv);
  out.across = pv - out.row;
  out.seam = Math.min(out.across, 1 - out.across);
  const off = lattice(out.row, 3, seed) * 0.9;
  const pu = (u + off) * sectionsPerTile;
  out.sect = Math.floor(pu);
  const su = pu - out.sect;
  out.butt = Math.min(su, 1 - su);
  out.tone = lattice(out.row, out.sect, seed + 31) * 2 - 1;
}
var _pl = { row: 0, across: 0, seam: 1, sect: 0, butt: 1, tone: 0 };
var _cell = { d: 0, r: 0 };
function oakGrain(u, v, seed) {
  const warp = fbm(u, v, 4, 4, 2, seed + 5) - 0.5;
  const g = ridged(u + warp * 0.05, v + warp * 0.012, 3, 110, 3, seed);
  const fibre = fbm(u, v, 220, 26, 2, seed + 17) - 0.5;
  return g * 0.85 + fibre * 0.3;
}
function makeOak(size = 512) {
  return bake(size, 2.2, (u, v, p) => {
    plankLayout(u, v, 11, 2, _pl);
    const grain = oakGrain(u, v, 11);
    let l = 0.42 + grain * 0.13 + _pl.tone * 0.045;
    worleyCell(u, v, 7, 23, _cell);
    const knot = _cell.r < 0.13 ? smoothstep(0.16, 0.02, _cell.d) : 0;
    l = mix(l, 0.2, knot * 0.85);
    const seam = smoothstep(0.03, 0, _pl.seam) + smoothstep(0.035, 0, _pl.butt) * 0.8;
    l = mix(l, 0.13, clamp01(seam));
    p.r = l * 1.09;
    p.g = l * 0.93;
    p.b = l * 0.72;
    p.h = grain * 0.35 - clamp01(seam) * 1.1 - knot * 0.5 + _pl.tone * 0.06;
    p.rough = 0.62 + grain * 0.12 + knot * 0.1;
    p.ao = 1 - clamp01(seam) * 0.55 - knot * 0.25;
    p.metal = 0;
  });
}
function makeHullBlack(size = 512) {
  return bake(size, 2.6, (u, v, p) => {
    plankLayout(u, v, 11, 2, _pl);
    const grain = oakGrain(u, v, 11);
    let l = 0.135 + grain * 0.028 + _pl.tone * 0.014;
    const fade = fbm(u, v, 5, 5, 3, 71);
    l += fade * 0.045;
    worleyCell(u, v, 26, 41, _cell);
    const chip = _cell.r < 0.1 ? smoothstep(0.28, 0.06, _cell.d) : 0;
    const chipDeep = _cell.r < 0.04 ? smoothstep(0.2, 0.04, _cell.d) : 0;
    const streak = clamp01((fbm(u, v, 90, 4, 3, 133) - 0.5) * 3.2);
    const salt = streak * smoothstep(0.35, 0.75, fbm(u, v, 6, 3, 2, 211));
    const seam = smoothstep(0.028, 0, _pl.seam) * 0.8 + smoothstep(0.03, 0, _pl.butt) * 0.5;
    l = mix(l, 0.12, clamp01(seam));
    let r = l;
    let g = l;
    let b = l * 1.03;
    r = mix(r, 0.3, chip * 0.55);
    g = mix(g, 0.29, chip * 0.55);
    b = mix(b, 0.28, chip * 0.55);
    r = mix(r, 0.42, chipDeep * 0.7);
    g = mix(g, 0.34, chipDeep * 0.7);
    b = mix(b, 0.24, chipDeep * 0.7);
    r = mix(r, 0.62, salt * 0.4);
    g = mix(g, 0.63, salt * 0.4);
    b = mix(b, 0.61, salt * 0.4);
    p.r = r;
    p.g = g;
    p.b = b;
    p.h = grain * 0.22 - clamp01(seam) * 1.2 - chip * 0.5 + salt * 0.1;
    p.rough = 0.58 + fade * 0.14 + chip * 0.24 + salt * 0.16;
    p.ao = 1 - clamp01(seam) * 0.4 - chip * 0.15;
    p.metal = 0;
  });
}
function makeStripeWhite(size = 512) {
  return bake(size, 2.4, (u, v, p) => {
    plankLayout(u, v, 11, 2, _pl);
    const grain = oakGrain(u, v, 11);
    const fade = fbm(u, v, 5, 5, 3, 71);
    let l = 0.66 + grain * 0.045 + _pl.tone * 0.018 - fade * 0.075;
    worleyCell(u, v, 24, 61, _cell);
    const chip = _cell.r < 0.11 ? smoothstep(0.26, 0.05, _cell.d) : 0;
    const grime = clamp01((fbm(u, v, 70, 5, 3, 307) - 0.45) * 2.6);
    const seam = smoothstep(0.026, 0, _pl.seam) * 0.9 + smoothstep(0.03, 0, _pl.butt) * 0.5;
    l = mix(l, 0.5, clamp01(seam));
    l = mix(l, 0.44, grime * 0.5);
    p.r = mix(l * 1, 0.4, chip * 0.6);
    p.g = mix(l * 0.965, 0.33, chip * 0.6);
    p.b = mix(l * 0.855, 0.24, chip * 0.6);
    p.h = grain * 0.2 - clamp01(seam) * 1.2 - chip * 0.5;
    p.rough = 0.44 + fade * 0.16 + chip * 0.28 + grime * 0.2;
    p.ao = 1 - clamp01(seam) * 0.4 - chip * 0.15;
  });
}
function makeBuff(size = 256) {
  return bake(size, 2, (u, v, p) => {
    plankLayout(u, v, 13, 2, _pl);
    const grain = oakGrain(u, v, 13);
    const fade = fbm(u, v, 5, 5, 3, 91);
    let l = 0.6 + grain * 0.06 + _pl.tone * 0.03 - fade * 0.07;
    const seam = smoothstep(0.03, 0, _pl.seam) * 0.9;
    l = mix(l, 0.4, clamp01(seam));
    const grime = clamp01((fbm(u, v, 60, 6, 3, 401) - 0.48) * 2.4);
    l = mix(l, 0.34, grime * 0.45);
    p.r = l * 1.06;
    p.g = l * 0.88;
    p.b = l * 0.53;
    p.h = grain * 0.2 - clamp01(seam) * 1;
    p.rough = 0.5 + fade * 0.16 + grime * 0.2;
    p.ao = 1 - clamp01(seam) * 0.4;
  });
}
function makeDeck(size = 512) {
  return bake(size, 2.8, (u, v, p) => {
    plankLayout(u, v, 17, 3, _pl);
    const grain = oakGrain(u, v, 17);
    const traffic = fbm(u, v, 4, 4, 3, 151);
    let l = 0.5 + grain * 0.1 + _pl.tone * 0.05;
    l += (traffic - 0.5) * 0.13;
    worleyCell(u, v, 9, 71, _cell);
    const knot = _cell.r < 0.1 ? smoothstep(0.14, 0.02, _cell.d) : 0;
    l = mix(l, 0.24, knot * 0.8);
    const seam = smoothstep(0.045, 0.012, _pl.seam);
    const butt = smoothstep(0.02, 4e-3, _pl.butt);
    const caulk = clamp01(seam + butt * 0.9);
    p.r = mix(l * 1.02, 0.055, caulk);
    p.g = mix(l * 0.93, 0.05, caulk);
    p.b = mix(l * 0.76, 0.048, caulk);
    p.h = grain * 0.3 - caulk * 1.4 - knot * 0.4 + _pl.tone * 0.1;
    p.rough = 0.55 + grain * 0.14 - traffic * 0.1 + caulk * 0.2;
    p.ao = 1 - caulk * 0.6 - knot * 0.2;
  });
}
function makeCopper(size = 256) {
  return bake(size, 3.2, (u, v, p) => {
    const pv = v * 4;
    const row = Math.floor(pv);
    const av = pv - row;
    const pu = (u + row * 0.5) * 3;
    const col = Math.floor(pu);
    const au = pu - col;
    const lapV = smoothstep(0.1, 0, av) + smoothstep(0.9, 1, av) * 0.7;
    const lapU = smoothstep(0.05, 0, au) + smoothstep(0.95, 1, au) * 0.6;
    const lap = clamp01(lapV + lapU * 0.8);
    const tone = lattice(row, col, 5) * 2 - 1;
    const patina = fbm(u, v, 7, 7, 4, 313);
    const grime = fbm(u, v, 30, 14, 3, 419);
    const green = clamp01(patina * 1.35 - 0.2);
    let r = mix(0.4, 0.2, green) + tone * 0.03;
    let g = mix(0.24, 0.3, green) + tone * 0.02;
    let b = mix(0.15, 0.24, green) + tone * 0.015;
    r = mix(r, 0.12, lap * 0.55);
    g = mix(g, 0.15, lap * 0.55);
    b = mix(b, 0.12, lap * 0.55);
    const speck = grime > 0.62 ? (grime - 0.62) * 2 : 0;
    r += speck * 0.05;
    g += speck * 0.06;
    b += speck * 0.03;
    p.r = r;
    p.g = g;
    p.b = b;
    p.h = -lap * 1.3 + (patina - 0.5) * 0.25 + tone * 0.12;
    p.rough = 0.55 + green * 0.28 + lap * 0.15 + speck * 0.1;
    p.ao = 1 - lap * 0.5;
    p.metal = mix(0.55, 0.12, green);
  });
}
function makeRope(size = 128) {
  return bake(size, 3.4, (u, v, p) => {
    const s = (u * 6 + v) % 1;
    const strand = Math.sin(s * Math.PI * 2) * 0.5 + 0.5;
    const fuzz = fbm(u, v, 64, 20, 3, 503);
    const l = 0.42 + Math.pow(strand, 0.7) * 0.34 + (fuzz - 0.5) * 0.13;
    p.r = l * 1.02;
    p.g = l * 0.98;
    p.b = l * 0.92;
    p.h = Math.pow(strand, 0.6) * 1.4 + (fuzz - 0.5) * 0.3;
    p.rough = 0.82 - strand * 0.08;
    p.ao = 0.72 + strand * 0.28;
  });
}
function makeCanvas(size = 512) {
  return bake(size, 1.9, (u, v, p) => {
    const weftPhase = v * 190 % 1;
    const warpPhase = u * 150 % 1;
    const weave = (Math.sin(weftPhase * Math.PI * 2) * 0.5 + 0.5) * 0.55 + (Math.sin(warpPhase * Math.PI * 2) * 0.5 + 0.5) * 0.45;
    const slub = fbm(u, v, 130, 100, 2, 601);
    const pv = v * 4;
    const pRow = Math.floor(pv);
    const av = pv - pRow;
    const seam = smoothstep(0.055, 0.02, Math.min(av, 1 - av));
    const stitch = seam * (Math.sin(u * 260) * 0.5 + 0.5);
    const tone = lattice(pRow, Math.floor(u * 3), 9) * 2 - 1;
    const soil = fbm(u, v, 6, 6, 4, 617);
    const mildew = clamp01((fbm(u, v, 12, 9, 3, 733) - 0.52) * 3);
    worleyCell(u, v, 6, 809, _cell);
    const patch = _cell.r < 0.07 ? smoothstep(0.2, 0.14, _cell.d) : 0;
    let l = 0.7 + (weave - 0.5) * 0.075 + (slub - 0.5) * 0.05 + tone * 0.022;
    l -= soil * 0.07;
    l = mix(l, 0.6, patch * 0.5);
    l = mix(l, 0.44, seam * 0.35);
    p.r = mix(l * 1, l * 0.72, mildew * 0.6);
    p.g = mix(l * 0.965, l * 0.73, mildew * 0.6);
    p.b = mix(l * 0.875, l * 0.62, mildew * 0.6);
    p.h = (weave - 0.5) * 0.5 + seam * 0.9 + stitch * 0.35 + patch * 0.4 + (slub - 0.5) * 0.3;
    p.rough = 0.78 + (weave - 0.5) * 0.06 + mildew * 0.1;
    p.ao = 1 - seam * 0.22 - patch * 0.1;
  });
}
function makeIron(size = 256) {
  return bake(size, 2.4, (u, v, p) => {
    const facet = fbm(u, v, 12, 12, 3, 907);
    const pit = fbm(u, v, 48, 48, 3, 911);
    worleyCell(u, v, 14, 919, _cell);
    const rust = _cell.r < 0.18 ? smoothstep(0.28, 0.08, _cell.d) : 0;
    let l = 0.1 + facet * 0.07 + (pit - 0.5) * 0.04;
    p.r = mix(l, 0.3, rust * 0.7);
    p.g = mix(l, 0.15, rust * 0.7);
    p.b = mix(l * 1.05, 0.08, rust * 0.7);
    p.h = (facet - 0.5) * 0.9 + (pit - 0.5) * 0.5 - rust * 0.3;
    p.rough = 0.44 + facet * 0.2 + rust * 0.32;
    p.ao = 1 - rust * 0.18;
    p.metal = mix(0.9, 0.2, rust);
  });
}
function makeBrass(size = 128) {
  return bake(size, 2, (u, v, p) => {
    const swirl = fbm(u, v, 10, 10, 3, 1009);
    const fine = fbm(u, v, 60, 60, 2, 1013);
    const tarnish = clamp01((fbm(u, v, 5, 5, 3, 1019) - 0.42) * 2.4);
    const l = 0.62 + swirl * 0.14 + (fine - 0.5) * 0.06;
    p.r = mix(l * 1, l * 0.5, tarnish);
    p.g = mix(l * 0.8, l * 0.52, tarnish);
    p.b = mix(l * 0.35, l * 0.42, tarnish);
    p.h = (swirl - 0.5) * 0.5 + (fine - 0.5) * 0.4;
    p.rough = 0.22 + tarnish * 0.42 + swirl * 0.1;
    p.ao = 1 - tarnish * 0.12;
    p.metal = mix(0.95, 0.55, tarnish);
  });
}
export {
  disposeTextures,
  makeBrass,
  makeBuff,
  makeCanvas,
  makeCopper,
  makeDeck,
  makeHullBlack,
  makeIron,
  makeOak,
  makeRope,
  makeStripeWhite
};
