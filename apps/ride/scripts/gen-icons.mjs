// PWA icons (road into the mountains, pixel look) as PNG – no external dependencies.
// PNG writer copied from C:/data/li-auto/scripts/gen-icons.mjs. Run: npm run icons -w ride
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const OUT = new URL('../public/icons/', import.meta.url);

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

function png(size, pixel) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixel(x / size, y / size);
      const o = y * (size * 3 + 1) + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Motif in unit coordinates; `pad` shrinks it into the safe zone of maskable icons. */
const scene = (pad) => (u, v) => {
  const PIX = 32;
  const x = (Math.floor(u * PIX) + 0.5) / PIX;
  const y = (Math.floor(v * PIX) + 0.5) / PIX;
  const sx = (x - 0.5) / (1 - 2 * pad) + 0.5;
  const sy = (y - 0.5) / (1 - 2 * pad) + 0.5;
  const horizon = 0.55;
  if (sy < horizon) {
    const far = 0.32 + 0.1 * Math.abs(Math.sin(sx * 7)) + 0.12 * Math.abs(sx - 0.35);
    const near = 0.42 + 0.08 * Math.abs(Math.sin(sx * 4 + 1));
    if (sy > near) return [58, 104, 52];
    if (sy > far) return sy < far + 0.04 ? [236, 240, 246] : [120, 132, 150];
    const t = sy / horizon;
    return [Math.round(40 + 120 * t), Math.round(80 + 110 * t), Math.round(150 + 80 * t)];
  }
  // road in perspective towards the vanishing point (0.5, horizon)
  const depth = (sy - horizon) / (1 - horizon);
  const half = 0.03 + depth * 0.42;
  const d = Math.abs(sx - 0.5);
  if (d < half) {
    if (d < 0.012 + depth * 0.02 && Math.floor(depth * 9) % 2 === 0) return [255, 212, 0];
    return [92, 92, 98];
  }
  return [103 - Math.round(depth * 20), 150 - Math.round(depth * 30), 70];
};

mkdirSync(OUT, { recursive: true });
for (const [name, size, pad] of [
  ['icon-192.png', 192, 0],
  ['icon-512.png', 512, 0],
  ['icon-maskable-512.png', 512, 0.1],
  ['apple-touch-icon.png', 180, 0],
]) {
  writeFileSync(new URL(name, OUT), png(size, scene(pad)));
  console.log(`icons/${name} (${size}px)`);
}
