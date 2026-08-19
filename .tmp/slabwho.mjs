/**
 * Which mesh drew the slab?
 *
 * The whole-frame diff bbox in frozenablate.mjs is useless for this: nearly
 * every mesh in the scene changes SOME pixel near the ship, so almost all the
 * boxes come out spanning the frame. This restricts the same diff to the
 * rectangle the slab actually occupies and ranks by how much of that rectangle
 * each mesh owns. The mesh that drew it will account for most of the rect; a
 * mesh that merely reflects into it will account for a few percent.
 *
 *   node .tmp/slabwho.mjs /tmp/frozen3 940 598 230 62
 */
import { readFile, readdir } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import { join } from 'node:path';

const [dir, X, Y, W, H] = process.argv.slice(2);
const rect = { x: +X, y: +Y, w: +W, h: +H };

function decode(buf) {
  let p = 8, ihdr = null;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), color: data[9] };
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
      cur[i] = v & 255;
    }
  }
  return { w: ihdr.w, h: ihdr.h, ch, px };
}

const base = decode(await readFile(join(dir, '00-base.png')));
function rectDiff(img) {
  let n = 0, sum = 0;
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      const i = (y * base.w + x) * base.ch;
      const d = Math.abs(base.px[i] - img.px[i]) + Math.abs(base.px[i + 1] - img.px[i + 1])
              + Math.abs(base.px[i + 2] - img.px[i + 2]);
      if (d > 8) { n++; sum += d; }
    }
  }
  return { n, pct: (100 * n / (rect.w * rect.h)).toFixed(1), mean: n ? (sum / n).toFixed(0) : 0 };
}

const files = (await readdir(dir)).filter((f) => f.endsWith('.png') && f !== '00-base.png').sort();
const rows = [];
for (const f of files) rows.push({ f, ...rectDiff(decode(await readFile(join(dir, f)))) });
rows.sort((a, b) => b.n - a.n);
console.log(`rect ${rect.w}x${rect.h} at ${rect.x},${rect.y} = ${rect.w * rect.h} px\n`);
for (const r of rows) {
  if (r.n < 20) continue;
  console.log(`${r.f.replace('.png', '').padEnd(34)} ${String(r.n).padStart(6)} px  ${String(r.pct).padStart(5)}%  mean=${r.mean}`);
}
