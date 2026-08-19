/**
 * Texel-truth probe for the ship's procedural texture library.
 *
 * The scene capture harness is unusable at load 170; this bakes the same maps
 * the game bakes and magnifies them to the EXACT screen scale the owner sees at
 * a given viewing distance, so "does the grain hold at 2 m" is answerable
 * without a GPU.
 *
 *   node .tmp/bakeprobe/probe.mjs
 *
 * Writes .tmp/bakeprobe/out/<family>-<map>.png plus a contrast report.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as T from './textures.mjs';

const OUT = new URL('./out/', import.meta.url);
mkdirSync(OUT, { recursive: true });

/* ---------------- minimal PNG encoder ---------------- */
const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(rgb, w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    rgb.copy ? rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3)
      : Buffer.from(rgb.buffer, y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------- sampling ---------------- */
/** Bilinear tap of an RGBA Uint8Array at fractional texel coords, wrapped. */
function tap(data, size, x, y, out) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const w = (ix, iy) => (((iy % size) + size) % size) * size * 4 + (((ix % size) + size) % size) * 4;
  const a = w(x0, y0), b = w(x0 + 1, y0), c = w(x0, y0 + 1), d = w(x0 + 1, y0 + 1);
  for (let k = 0; k < 3; k++) {
    const ab = data[a + k] + (data[b + k] - data[a + k]) * fx;
    const cd = data[c + k] + (data[d + k] - data[c + k]) * fx;
    out[k] = ab + (cd - ab) * fy;
  }
}

/**
 * Magnify a region of a baked map to true screen pixels.
 *
 * @param set     TexSet from the library
 * @param which   'map' | 'normalMap' | 'ormMap'
 * @param tile    [alongM, acrossM] metres covered by one tile
 * @param cropM   [alongM, acrossM] metres of surface to show
 * @param distM   viewing distance in metres
 */
function magnify(set, which, tile, cropM, distM, outW = 560) {
  const img = set[which].image;
  const size = img.width;
  const data = img.data;
  // Screen px per metre for a 1600px-wide, 50-degree-horizontal-FOV frame.
  const pxPerM = 1600 / (2 * distM * Math.tan((50 * Math.PI / 180) / 2));
  const w = Math.min(outW, Math.round(cropM[0] * pxPerM));
  const h = Math.round((cropM[1] / cropM[0]) * w);
  const rgb = Buffer.alloc(w * h * 3);
  const px = [0, 0, 0];
  // Texels per metre on each axis.
  const tpmU = size / tile[0], tpmV = size / tile[1];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      tap(data, size, (x / w) * cropM[0] * tpmU, (y / h) * cropM[1] * tpmV, px);
      const i = (y * w + x) * 3;
      rgb[i] = px[0]; rgb[i + 1] = px[1]; rgb[i + 2] = px[2];
    }
  }
  return { buf: png(rgb, w, h), w, h, pxPerM, tpmU, tpmV };
}

/**
 * Contrast statistics AFTER magnification — this is what the eye gets.
 * `hf` is the mean absolute difference between neighbouring screen pixels,
 * i.e. how much visible structure survives; a flat surface scores ~0.
 */
function stats(set, which, tile, cropM, distM) {
  const img = set[which].image;
  const size = img.width, data = img.data;
  const pxPerM = 1600 / (2 * distM * Math.tan((50 * Math.PI / 180) / 2));
  const w = Math.round(cropM[0] * pxPerM), h = Math.round(cropM[1] * pxPerM);
  const tpmU = size / tile[0], tpmV = size / tile[1];
  const lum = new Float64Array(w * h);
  const px = [0, 0, 0];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      tap(data, size, (x / w) * cropM[0] * tpmU, (y / h) * cropM[1] * tpmV, px);
      lum[y * w + x] = (px[0] * 0.2126 + px[1] * 0.7152 + px[2] * 0.0722) / 255;
    }
  }
  let mean = 0;
  for (let i = 0; i < lum.length; i++) mean += lum[i];
  mean /= lum.length;
  let sd = 0;
  for (let i = 0; i < lum.length; i++) sd += (lum[i] - mean) ** 2;
  sd = Math.sqrt(sd / lum.length);
  let hf = 0, n = 0;
  for (let y = 1; y < h; y++) {
    for (let x = 1; x < w; x++) {
      hf += Math.abs(lum[y * w + x] - lum[y * w + x - 1]);
      hf += Math.abs(lum[y * w + x] - lum[(y - 1) * w + x]);
      n += 2;
    }
  }
  return { mean, sd, hf: hf / n, w, h };
}

/** Green channel of the ORM = roughness; report its spread separately. */
const TILE_HULL = [3.2, 1.28];
const TILE_SAIL = [2.6, 2.44];

const FAMILIES = [
  ['deck', T.makeDeck(512), TILE_HULL, [0.55, 0.55]],
  ['black', T.makeHullBlack(512), TILE_HULL, [0.55, 0.55]],
  ['oak', T.makeOak(512), TILE_HULL, [0.4, 0.4]],
  ['canvas', T.makeCanvas(512), TILE_SAIL, [0.55, 0.55]],
  ['copper', T.makeCopper(256), TILE_HULL, [0.55, 0.55]],
  ['rope', T.makeRope(128), [0.5, 0.16], [0.16, 0.16]],
];

const DIST = 2.0;
const rows = [];
for (const [name, set, tile, cropM] of FAMILIES) {
  for (const which of ['map', 'normalMap', 'ormMap']) {
    const m = magnify(set, which, tile, cropM, DIST);
    writeFileSync(new URL(`./out/${name}-${which}.png`, import.meta.url), m.buf);
    const s = stats(set, which, tile, cropM, DIST);
    rows.push({
      family: name, map: which,
      texelPerM: `${m.tpmU.toFixed(0)}x${m.tpmV.toFixed(0)}`,
      magU: (m.pxPerM / m.tpmU).toFixed(1), magV: (m.pxPerM / m.tpmV).toFixed(1),
      mean: s.mean.toFixed(3), sd: s.sd.toFixed(4), hf: s.hf.toFixed(5),
    });
  }
}
console.log(`viewing distance ${DIST} m, 1600px / 50deg  =>  ${(1600 / (2 * DIST * Math.tan(25 * Math.PI / 180))).toFixed(0)} screen px per metre`);
console.log('mag = screen px per texel (>1 means the texture is being magnified, i.e. blurred)');
console.log('hf  = mean |neighbour difference| in screen space; < 0.004 reads as FLAT');
console.table(rows);
