'use strict';
/* Generates build/icon.png (1024²) — no image libs. electron-builder derives
 * .icns / .ico from it. Re-run if you want to tweak the mark. */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const N = 1024;
const buf = Buffer.alloc(N * N * 4);
const px = (x, y, r, g, b, a = 255) => {
  const i = (y * N + x) * 4;
  buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a;
};
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const BG = hex('#0b0f14');
const CY = hex('#37e0d8');
const DK = hex('#0b0f14');

// rounded-rect test
const inRoundRect = (x, y, x0, y0, x1, y1, rad) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + rad), x1 - rad);
  const cy = Math.min(Math.max(y, y0 + rad), y1 - rad);
  return (x - cx) ** 2 + (y - cy) ** 2 <= rad * rad;
};

for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    let c = BG;
    // speech bubble body
    if (inRoundRect(x, y, 168, 176, 856, 720, 120)) c = CY;
    // tail
    if (y >= 700 && y <= 860 && x >= 300 && x <= 300 + (y - 700)) c = CY;
    // three message bars punched out of the bubble
    if (c === CY) {
      for (const by of [312, 428, 544]) {
        if (y >= by && y <= by + 64 && x >= 268 && x <= (by === 544 ? 620 : 756)) c = DK;
      }
    }
    px(x, y, c[0], c[1], c[2]);
  }
}

// ---- minimal PNG encoder ----
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (b) => {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0);
ihdr.writeUInt32BE(N, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const raw = Buffer.alloc(N * (N * 4 + 1));
for (let y = 0; y < N; y++) {
  raw[y * (N * 4 + 1)] = 0; // filter: none
  buf.copy(raw, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4);
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
const out = path.join(__dirname, '..', 'build', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log('wrote', out, png.length, 'bytes');
