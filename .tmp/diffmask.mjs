/**
 * Visualise what an ablation removed: base vs variant, drawn as the base frame
 * dimmed with every changed pixel painted magenta, so the SHAPE of the removed
 * mesh is legible instead of just a pixel count.
 *
 *   node .tmp/diffmask.mjs base.png variant.png out.png [thr=24] [x y w h scale]
 */
import { readFile, writeFile } from 'node:fs/promises';
import { inflateSync, deflateSync } from 'node:zlib';

const [aPath, bPath, out, thrS, xs, ys, ws, hs, ss] = process.argv.slice(2);
const THR = thrS ? +thrS : 24;

function decode(buf) {
  let p = 8;
  let ihdr = null;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], color: data[9], interlace: data[12] };
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[ihdr.color];
  const raw = inflateSync(Buffer.concat(idat));
  const stride = ihdr.w * ch;
  const px = Buffer.alloc(ihdr.h * stride);
  let q = 0;
  for (let y = 0; y < ihdr.h; y++) {
    const f = raw[q++];
    const row = raw.subarray(q, q + stride);
    q += stride;
    const cur = px.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= ch ? prev[i - ch] : 0;
      let v = row[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 0xff;
    }
  }
  return { w: ihdr.w, h: ihdr.h, ch, px };
}
function crc32(buf) { let c = ~0; for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; }
function chunk(type, data) { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'latin1'), data]); const cr = Buffer.alloc(4); cr.writeUInt32BE(crc32(td)); return Buffer.concat([l, td, cr]); }
function encode(w, h, rgb) {
  const stride = w * 3;
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) { raw[y * (stride + 1)] = 0; rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride); }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

const A = decode(await readFile(aPath));
const B = decode(await readFile(bPath));
const X = xs !== undefined ? +xs : 0;
const Y = ys !== undefined ? +ys : 0;
const W = ws !== undefined ? +ws : A.w;
const H = hs !== undefined ? +hs : A.h;
const S = ss !== undefined ? +ss : 1;
const ow = W * S, oh = H * S;
const dst = Buffer.alloc(ow * oh * 3);
let n = 0;
for (let y = 0; y < oh; y++) {
  const sy = Math.min(A.h - 1, Y + Math.floor(y / S));
  for (let x = 0; x < ow; x++) {
    const sx = Math.min(A.w - 1, X + Math.floor(x / S));
    const i = (sy * A.w + sx) * A.ch;
    const j = (sy * B.w + sx) * B.ch;
    const d = Math.abs(A.px[i] - B.px[j]) + Math.abs(A.px[i + 1] - B.px[j + 1]) + Math.abs(A.px[i + 2] - B.px[j + 2]);
    const di = (y * ow + x) * 3;
    if (d > THR) {
      n++;
      dst[di] = 255; dst[di + 1] = 0; dst[di + 2] = 255;
    } else {
      dst[di] = A.px[i] >> 2; dst[di + 1] = A.px[i + 1] >> 2; dst[di + 2] = A.px[i + 2] >> 2;
    }
  }
}
await writeFile(out, encode(ow, oh, dst));
console.log(`${out} ${ow}x${oh} changed=${n}`);
