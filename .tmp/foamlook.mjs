/**
 * Bake the foam texture outside the browser, time it, and write each channel as
 * a viewable greyscale PNG plus an RGB composite. Looking at the four channels
 * is the only way to tell "crisp bubble raft" from "cotton wool" before spending
 * a capture on it.
 */
import { writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

const crc = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return (buf) => { let c = -1; for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
})();
function png(w, h, rgb) {
  const raw = Buffer.alloc(h * (w * 3 + 1));
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3); }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

const mod = await import(pathToFileURL(process.argv[2] || 'src/vfx/textures.ts').href);
const t0 = performance.now();
const tex = mod.makeFoamTexture(Number(process.env.SIZE || 512));
const ms = performance.now() - t0;
const { width: w, height: h, data } = tex.image;
console.log(`bake ${w}x${h} in ${ms.toFixed(1)} ms`);

const names = ['R-bubble-raft', 'G-flow-filaments', 'B-micro-grain', 'A-coverage'];
for (let c = 0; c < 4; c++) {
  const rgb = Buffer.alloc(w * h * 3);
  let mn = 255, mx = 0, sum = 0;
  for (let i = 0; i < w * h; i++) {
    const v = data[i * 4 + c];
    rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = v;
    if (v < mn) mn = v; if (v > mx) mx = v; sum += v;
  }
  // Mean absolute Laplacian: how much local contrast the channel actually has.
  // Cotton wool scores near zero here however bright it is.
  let lap = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const at = (xx, yy) => data[(yy * w + xx) * 4 + c];
    lap += Math.abs(4 * at(x, y) - at(x - 1, y) - at(x + 1, y) - at(x, y - 1) - at(x, y + 1));
  }
  console.log(`  ${names[c].padEnd(18)} min=${String(mn).padStart(3)} max=${String(mx).padStart(3)} mean=${(sum / (w * h)).toFixed(1).padStart(6)} contrast=${(lap / ((w - 2) * (h - 2))).toFixed(2)}`);
  await writeFile(`${process.env.OUT || '/tmp/foam'}-${names[c]}.png`, png(w, h, rgb));
}
