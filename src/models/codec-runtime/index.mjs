const MAX_PIXELS = 16_777_216;
const MAX_DECODED_BYTES = 64 * 1024 * 1024;
const DECODE_TIMEOUT_SECONDS = 30;
const NATIVE_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

let sharpModule;

export class ImageCodecUnavailableError extends Error {
  constructor() {
    super("The pinned image codec runtime is unavailable.");
    this.name = "ImageCodecUnavailableError";
  }
}

async function loadSharp() {
  if (!sharpModule) {
    try {
      const loaded = await import("sharp");
      if (typeof loaded.default !== "function") throw new Error("missing decoder export");
      sharpModule = loaded.default;
    } catch {
      throw new ImageCodecUnavailableError();
    }
  }
  return sharpModule;
}

/**
 * Decode an entire PNG, JPEG, or still WebP image into a bounded RGBA buffer.
 * Header parsing alone is not enough to authorize an artifact: libvips and its
 * format decoders must consume the compressed pixel stream and return every
 * pixel within the configured byte, pixel, and processing limits.
 */
export async function decodeOpenAIImageRgba(bytes) {
  const sharp = await loadSharp();
  const options = {
    failOn: "warning",
    limitInputPixels: MAX_PIXELS,
    limitInputChannels: 5,
    page: 0,
    pages: 1,
    animated: false,
    sequentialRead: true,
  };
  try {
    const metadata = await sharp(bytes, options).timeout({ seconds: DECODE_TIMEOUT_SECONDS }).metadata();
    if (!["png", "jpeg", "webp"].includes(metadata.format) || !Number.isSafeInteger(metadata.width) || !Number.isSafeInteger(metadata.height) ||
        metadata.width < 1 || metadata.height < 1 || metadata.width * metadata.height > MAX_PIXELS ||
        (metadata.pages !== undefined && metadata.pages !== 1) || typeof metadata.hasAlpha !== "boolean") {
      throw new Error("unsupported decoded metadata");
    }
    const preserveUshort = metadata.depth === "ushort";
    const expectedBytes = metadata.width * metadata.height * 4 * (preserveUshort ? 2 : 1);
    if (expectedBytes > MAX_DECODED_BYTES) throw new Error("decoded pixels exceed bounded buffer size");
    let pipeline = sharp(bytes, options);
    if (preserveUshort) pipeline = pipeline.toColourspace("rgb16");
    const decoded = await pipeline
      .ensureAlpha()
      .raw(preserveUshort ? { depth: "ushort" } : undefined)
      .timeout({ seconds: DECODE_TIMEOUT_SECONDS })
      .toBuffer({ resolveWithObject: true });
    const { data, info } = decoded;
    try {
      if (info.format !== "raw" || info.width !== metadata.width || info.height !== metadata.height ||
          info.channels !== 4 || info.depth !== (preserveUshort ? "ushort" : "uchar") || data.byteLength !== expectedBytes) {
        throw new Error("decoded pixels did not match bounded metadata");
      }
      let hasTransparency = false;
      if (preserveUshort) {
        const readSample = NATIVE_LITTLE_ENDIAN
          ? (offset) => data.readUInt16LE(offset)
          : (offset) => data.readUInt16BE(offset);
        for (let offset = 6; offset < data.length; offset += 8) {
          if (readSample(offset) !== 0xffff) { hasTransparency = true; break; }
        }
      } else {
        for (let offset = 3; offset < data.length; offset += 4) {
          if (data[offset] !== 0xff) { hasTransparency = true; break; }
        }
      }
      return Object.freeze({
        format: metadata.format,
        width: metadata.width,
        height: metadata.height,
        has_alpha: metadata.hasAlpha,
        has_transparency: metadata.hasAlpha && hasTransparency,
      });
    } finally {
      data.fill(0);
    }
  } catch (error) {
    if (error instanceof ImageCodecUnavailableError) throw error;
    throw new Error("Image content failed bounded pixel decoding.");
  }
}
