// Draws Island's app and tray icons in code (signed-distance shapes, 4x4
// supersampling) and writes PNG + ICO files with no image dependencies.
//
//   node scripts/make-icons.mjs
//
// App icon: a black capsule on a soft graphite tile with a warm status dot.
// Tray icon: a white capsule with a dark dot; the alert variant adds an orange badge.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const iconsDir = join(root, 'src-tauri', 'icons');
mkdirSync(iconsDir, { recursive: true });

// ---------------------------------------------------------------- PNG encoder

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const dir = Buffer.alloc(16 * images.length);
  let offset = 6 + dir.length;
  images.forEach(({ size, data }, i) => {
    const e = i * 16;
    dir[e] = size >= 256 ? 0 : size;
    dir[e + 1] = size >= 256 ? 0 : size;
    dir.writeUInt16LE(1, e + 4);
    dir.writeUInt16LE(32, e + 6);
    dir.writeUInt32LE(data.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([header, dir, ...images.map((i) => i.data)]);
}

// ---------------------------------------------------------------- shapes

const clamp01 = (v) => Math.min(1, Math.max(0, v));
// Distance to a rounded rectangle centred at (cx, cy), half extents (hw, hh), radius r.
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - hw + r;
  const qy = Math.abs(py - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
const sdCircle = (px, py, cx, cy, r) => Math.hypot(px - cx, py - cy) - r;

function over(dst, src) {
  const a = src[3] + dst[3] * (1 - src[3]);
  if (a <= 0) return [0, 0, 0, 0];
  return [0, 1, 2].map((i) => (src[i] * src[3] + dst[i] * dst[3] * (1 - src[3])) / a).concat(a);
}

/** layers: [{ sd(x,y) -> distance in px of the unit canvas, color(x,y) -> [r,g,b,a] }] */
function render(size, layers) {
  const out = Buffer.alloc(size * size * 4);
  const ss = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let acc = [0, 0, 0, 0];
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const u = (x + (sx + 0.5) / ss) / size;
          const v = (y + (sy + 0.5) / ss) / size;
          let px = [0, 0, 0, 0];
          for (const layer of layers) {
            const d = layer.sd(u, v) * size;
            const cover = clamp01(0.5 - d);
            if (cover <= 0) continue;
            const c = layer.color(u, v);
            px = over(px, [c[0], c[1], c[2], c[3] * cover]);
          }
          acc = acc.map((a, i) => a + px[i] * (i === 3 ? 1 : px[3]));
        }
      }
      const n = ss * ss;
      const a = acc[3] / n;
      const idx = (y * size + x) * 4;
      out[idx] = a > 0 ? Math.round(clamp01(acc[0] / n / a) * 255) : 0;
      out[idx + 1] = a > 0 ? Math.round(clamp01(acc[1] / n / a) * 255) : 0;
      out[idx + 2] = a > 0 ? Math.round(clamp01(acc[2] / n / a) * 255) : 0;
      out[idx + 3] = Math.round(clamp01(a) * 255);
    }
  }
  return out;
}

const hex = (h, a = 1) => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255, a];

function appIcon(size) {
  return render(size, [
    // tile
    { sd: (x, y) => sdRoundRect(x, y, 0.5, 0.5, 0.46, 0.46, 0.22), color: (_x, y) => {
      const t = y;
      return [0.16 - 0.08 * t, 0.165 - 0.08 * t, 0.18 - 0.08 * t, 1];
    } },
    // capsule rim
    { sd: (x, y) => sdRoundRect(x, y, 0.5, 0.5, 0.36, 0.145, 0.145), color: () => hex('#3a3a40') },
    // capsule body
    { sd: (x, y) => sdRoundRect(x, y, 0.5, 0.5, 0.345, 0.13, 0.13), color: () => hex('#050506') },
    // status dot
    { sd: (x, y) => sdCircle(x, y, 0.27, 0.5, 0.06), color: () => hex('#e8845f') },
    // text bar
    { sd: (x, y) => sdRoundRect(x, y, 0.52, 0.5, 0.15, 0.028, 0.028), color: () => hex('#f5f4ef', 0.92) },
    { sd: (x, y) => sdRoundRect(x, y, 0.75, 0.5, 0.035, 0.028, 0.028), color: () => hex('#f5f4ef', 0.45) },
  ]);
}

function trayIcon(size, alert) {
  const layers = [
    { sd: (x, y) => sdRoundRect(x, y, 0.5, 0.5, 0.47, 0.25, 0.25), color: () => hex('#1b1b1f', 0.9) },
    { sd: (x, y) => sdRoundRect(x, y, 0.5, 0.5, 0.43, 0.21, 0.21), color: () => hex('#f7f7f4') },
    { sd: (x, y) => sdCircle(x, y, 0.27, 0.5, 0.095), color: () => hex('#1b1b1f') },
  ];
  if (alert) {
    layers.push({ sd: (x, y) => sdCircle(x, y, 0.8, 0.22, 0.2), color: () => hex('#1b1b1f') });
    layers.push({ sd: (x, y) => sdCircle(x, y, 0.8, 0.22, 0.16), color: () => hex('#f0874f') });
  }
  return render(size, layers);
}

const write = (name, buf) => writeFileSync(join(iconsDir, name), buf);

for (const [name, size] of [['32x32.png', 32], ['128x128.png', 128], ['128x128@2x.png', 256], ['icon.png', 512]]) {
  write(name, png(size, appIcon(size)));
}
write('icon.ico', ico([16, 24, 32, 48, 64, 128, 256].map((s) => ({ size: s, data: png(s, appIcon(s)) }))));
for (const alert of [false, true]) {
  const base = alert ? 'tray-alert' : 'tray';
  write(`${base}.png`, png(32, trayIcon(32, alert)));
}
console.log(`icons written to ${iconsDir}`);
