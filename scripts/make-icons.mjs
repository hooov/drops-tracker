// Generates the monogram icons as PNGs with no dependencies. Run: node scripts/make-icons.mjs
// The mark is a lowercase d on Twitch purple whose bowl is a progress ring, like the chip in chat.
// Drawn in a 128-unit design space. The 128 px icon keeps the 96 px artwork inside 16 px of
// padding, as the Chrome Web Store asks; the toolbar sizes crop to the tile so they fill the slot.
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

const PURPLE = [145, 70, 255]; // #9146FF
const WHITE = [255, 255, 255];
const TRACK_ALPHA = 0.32; // Unfilled part of the ring: white over purple.

// Shapes, in design units.
const TILE = { x0: 16, y0: 16, x1: 112, y1: 112, r: 18 };
const STEM = { x0: 74, y0: 26, x1: 89, y1: 100 }; // Fully rounded ends.
const RING = { cx: 58, cy: 74, r: 20, w: 13, sweep: 252 }; // 70% of the circle, clockwise from 12 o'clock.

function inRoundRect(x, y, { x0, y0, x1, y1, r }) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const dx = Math.max(x0 + r - x, 0, x - (x1 - r));
  const dy = Math.max(y0 + r - y, 0, y - (y1 - r));
  return dx * dx + dy * dy <= r * r;
}
const inStem = (x, y) => inRoundRect(x, y, { ...STEM, r: (STEM.x1 - STEM.x0) / 2 });
function ringDistance(x, y) {
  return Math.abs(Math.hypot(x - RING.cx, y - RING.cy) - RING.r);
}
const inTrack = (x, y) => ringDistance(x, y) <= RING.w / 2;
function inArc(x, y) {
  const half = RING.w / 2;
  if (inTrack(x, y)) {
    const deg = (Math.atan2(x - RING.cx, -(y - RING.cy)) * 180) / Math.PI;
    if ((deg + 360) % 360 <= RING.sweep) return true;
  }
  // Round caps at both ends of the arc.
  for (const a of [0, RING.sweep]) {
    const t = (a * Math.PI) / 180;
    const ex = RING.cx + RING.r * Math.sin(t);
    const ey = RING.cy - RING.r * Math.cos(t);
    if ((x - ex) ** 2 + (y - ey) ** 2 <= half * half) return true;
  }
  return false;
}

// Colour and coverage of one design-space point.
function sample(x, y) {
  if (!inRoundRect(x, y, TILE)) return null;
  if (inStem(x, y) || inArc(x, y)) return WHITE;
  if (inTrack(x, y)) return PURPLE.map((c, i) => c + (WHITE[i] - c) * TRACK_ALPHA);
  return PURPLE;
}

// view: the design-space square mapped onto the whole canvas.
function png(size, view) {
  const SS = 8;
  const span = view.x1 - view.x0;
  const rows = [];
  for (let py = 0; py < size; py++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, hit = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = view.x0 + ((px + (sx + 0.5) / SS) / size) * span;
          const y = view.y0 + ((py + (sy + 0.5) / SS) / size) * span;
          const c = sample(x, y);
          if (!c) continue;
          r += c[0]; g += c[1]; b += c[2]; hit++;
        }
      }
      const o = 1 + px * 4;
      if (hit) {
        row[o] = Math.round(r / hit);
        row[o + 1] = Math.round(g / hit);
        row[o + 2] = Math.round(b / hit);
      }
      row[o + 3] = Math.round((hit / (SS * SS)) * 255);
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

const STORE = { x0: 0, y0: 0, x1: 128 }; // Padded, for the Web Store and the extensions page.
const TOOLBAR = { x0: TILE.x0, y0: TILE.y0, x1: TILE.x1 }; // Tile edge to edge.

const dir = new URL('../extension/icons/', import.meta.url);
mkdirSync(dir, { recursive: true });
for (const size of [16, 32, 48]) writeFileSync(new URL(`${size}.png`, dir), png(size, TOOLBAR));
writeFileSync(new URL('128.png', dir), png(128, STORE));
