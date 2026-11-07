// Generates the droplet icons as PNGs with no dependencies. Run: node scripts/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const t = Buffer.from(type);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

// Coverage of a point in unit space by a rounded square background and a droplet.
function inRoundedSquare(x, y) {
  const r = 0.22;
  const dx = Math.max(Math.abs(x - 0.5) - (0.5 - r), 0);
  const dy = Math.max(Math.abs(y - 0.5) - (0.5 - r), 0);
  return dx * dx + dy * dy <= r * r;
}
function inDroplet(x, y) {
  const cx = 0.5, cy = 0.6, r = 0.24;
  if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) return true;
  const top = 0.14;
  if (y < top || y > cy) return false;
  return Math.abs(x - cx) <= r * ((y - top) / (cy - top)) ** 1.3;
}

function png(size) {
  const SS = 4;
  const rows = [];
  for (let py = 0; py < size; py++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let px = 0; px < size; px++) {
      let bg = 0, fg = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          if (inRoundedSquare(x, y)) { bg++; if (inDroplet(x, y)) fg++; }
        }
      }
      const total = SS * SS;
      const f = bg ? fg / bg : 0;
      const o = 1 + px * 4;
      row[o] = Math.round(145 * (1 - f) + 255 * f);
      row[o + 1] = Math.round(71 * (1 - f) + 255 * f);
      row[o + 2] = Math.round(255 * (1 - f) + 255 * f);
      row[o + 3] = Math.round((bg / total) * 255);
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const dir = new URL('../extension/icons/', import.meta.url);
mkdirSync(dir, { recursive: true });
for (const size of [16, 48, 128]) writeFileSync(new URL(`${size}.png`, dir), png(size));
