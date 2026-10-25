// Рисует иконки приложения и трея без внешних зависимостей: build/icon.ico, resources/*.png
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const root = path.resolve(import.meta.dirname, '..');
const GRAPHITE = [27, 31, 35];
const EDGE = [44, 51, 58];
const JADE = [61, 220, 151];

function png(size, pixel) {
  const SS = 4;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = pixel((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size);
          if (px) { r += px[0] * px[3]; g += px[1] * px[3]; b += px[2] * px[3]; a += px[3]; }
        }
      }
      const n = SS * SS;
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = a ? Math.round(r / a) : 0;
      raw[o + 1] = a ? Math.round(g / a) : 0;
      raw[o + 2] = a ? Math.round(b / a) : 0;
      raw[o + 3] = Math.round((a / n) * 255);
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const inRoundRect = (u, v, r) => {
  const dx = Math.max(Math.abs(u - 0.5) - (0.5 - r), 0);
  const dy = Math.max(Math.abs(v - 0.5) - (0.5 - r), 0);
  return Math.hypot(dx, dy) <= r;
};
const dist = (u, v) => Math.hypot(u - 0.5, v - 0.5);

// Приложение: графитовая плитка, нефритовое кольцо и точка.
const appIcon = (u, v) => {
  if (!inRoundRect(u, v, 0.22)) return null;
  const d = dist(u, v);
  if (d <= 0.07) return [...JADE, 1];
  if (d >= 0.27 && d <= 0.35) return [...JADE, 1];
  if (!inRoundRect(u, v, 0.2)) return [...EDGE, 1];
  return [...GRAPHITE, 1];
};
// Трей: кольцо на прозрачном фоне; в активном состоянии добавлена залитая середина.
const trayIcon = (active) => (u, v) => {
  const d = dist(u, v);
  if (d <= (active ? 0.26 : 0.1)) return [...JADE, 1];
  if (d >= 0.34 && d <= 0.46) return [...JADE, 1];
  return null;
};

function ico(sizes) {
  const images = sizes.map((s) => png(s, appIcon));
  const head = Buffer.alloc(6); head.writeUInt16LE(1, 2); head.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const dir = images.map((img, i) => {
    const e = Buffer.alloc(16);
    e[0] = sizes[i] >= 256 ? 0 : sizes[i]; e[1] = e[0];
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(img.length, 8); e.writeUInt32LE(offset, 12);
    offset += img.length;
    return e;
  });
  return Buffer.concat([head, ...dir, ...images]);
}

fs.mkdirSync(path.join(root, 'build'), { recursive: true });
fs.mkdirSync(path.join(root, 'resources'), { recursive: true });
fs.writeFileSync(path.join(root, 'build/icon.ico'), ico([16, 32, 48, 64, 128, 256]));
fs.writeFileSync(path.join(root, 'build/icon.png'), png(512, appIcon));
fs.writeFileSync(path.join(root, 'resources/icon.png'), png(256, appIcon));
fs.writeFileSync(path.join(root, 'resources/tray.png'), png(32, trayIcon(false)));
fs.writeFileSync(path.join(root, 'resources/tray-active.png'), png(32, trayIcon(true)));
console.log('Иконки созданы.');
