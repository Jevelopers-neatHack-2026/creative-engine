import { deflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  return crc >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function chunk(name, data) {
  const type = Buffer.from(name, "ascii");
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length, 0);
  type.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, 8 + data.length)), 8 + data.length);
  return result;
}

export function makePng({ width = 16, height = 16, transparent = false } = {}) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const start = y * (width * 4 + 1);
    rows[start] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = start + 1 + x * 4;
      rows[offset] = (x * 13) & 0xff;
      rows[offset + 1] = (y * 17) & 0xff;
      rows[offset + 2] = 127;
      rows[offset + 3] = transparent && x === 0 && y === 0 ? 0 : 255;
    }
  }
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function makePng16Rgba({ width = 16, height = 16, alpha = 0xffff } = {}) {
  if (!Number.isSafeInteger(width) || width < 1 || width > 4096 || !Number.isSafeInteger(height) || height < 1 || height > 4096 ||
      width * height > 16_777_216 || (width * 8 + 1) * height > 64 * 1024 * 1024 ||
      !Number.isSafeInteger(alpha) || alpha < 0 || alpha > 0xffff) {
    throw new TypeError("PNG16 fixture dimensions and alpha must be bounded integers.");
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 16;
  header[9] = 6;
  const rowBytes = width * 8;
  const rows = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * (rowBytes + 1);
    for (let x = 0; x < width; x += 1) {
      const pixelOffset = rowOffset + 1 + x * 8;
      rows.writeUInt16BE(0x7530, pixelOffset);
      rows.writeUInt16BE(0x7530, pixelOffset + 2);
      rows.writeUInt16BE(0x7530, pixelOffset + 4);
      rows.writeUInt16BE(alpha, pixelOffset + 6);
    }
  }
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function makeInvalidIndexedPng({ width = 16, height = 16 } = {}) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 3;
  const palette = Buffer.from([255, 0, 0]);
  const rows = Buffer.alloc((width + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const offset = row * (width + 1);
    rows[offset] = 0;
    rows.fill(255, offset + 1, offset + width + 1);
  }
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", header),
    chunk("PLTE", palette),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function corruptPngCrc(bytes = makePng()) {
  const copy = Buffer.from(bytes);
  copy[copy.length - 5] ^= 0x01;
  return copy;
}
