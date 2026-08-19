/**
 * Crop + integer-upscale a PNG with no browser and no dependencies.
 *
 * '.tmp/crop.mjs' launches Chromium and its 30 s default timeout fails whenever
 * several agents are running their own headless browsers, which is most of the
 * time. This does the same job with zlib and a hand-rolled PNG codec.
 *
 *   node .tmp/pngcrop.mjs <src> <out> <x> <y> <w> <h> [scale=2]
 */
import { readFile, writeFile } from 'node:fs/promises';
import { inflateSync, deflateSync } from 'node:zlib';

const [src, out, xs, ys, ws, hs, ss] = process.argv.slice(2);
const X = +xs, Y = +ys, W = +ws, H = +hs;
const S = ss ? +ss : 2;

function decode(buf) {
  let p = 8;
  let ihdr = null;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      ihdr = {
        w: data.readUInt32BE(0), h: data.readUInt32BE(4),
        depth: data[8], color: data[9], interlace: data[12],
      };
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (!ihdr) throw new Error('no IHDR');
  if (ihdr.depth !== 8 || ihdr.interlace !== 0) throw new Error(`unsupported PNG depth/interlace ${ihdr.depth}/${ihdr.interlace}`);
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[ihdr.color];
  if (!ch) throw new Error(`unsupported colour type ${ihdr.color}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = ihdr.w * ch;
  const px = Buffer.alloc(ihdr.h * stride);
  let q = 0;
  for (let y = 0; y < ihdr.h; y++) {
    const filter = raw[q++];
    const row = raw.subarray(q, q + stride);
    q += stride;
    const cur = px.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= ch ? prev[i - ch] : 0;
      let v = row[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 0xff;
    }
  }
  return { w: ihdr.w, h: ihdr.h, ch, px };
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encode(w, h, rgb) {
  const stride = w * 3;
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const img = decode(await readFile(src));
const ow = W * S;
const oh = H * S;
const dst = Buffer.alloc(ow * oh * 3);
for (let y = 0; y < oh; y++) {
  const sy = Math.min(img.h - 1, Y + Math.floor(y / S));
  for (let x = 0; x < ow; x++) {
    const sx = Math.min(img.w - 1, X + Math.floor(x / S));
    const si = (sy * img.w + sx) * img.ch;
    const di = (y * ow + x) * 3;
    dst[di] = img.px[si];
    dst[di + 1] = img.ch === 1 ? img.px[si] : img.px[si + 1];
    dst[di + 2] = img.ch === 1 ? img.px[si] : img.px[si + 2];
  }
}
await writeFile(out, encode(ow, oh, dst));
console.log(`${out} ${ow}x${oh} (src ${img.w}x${img.h} ch${img.ch})`);
