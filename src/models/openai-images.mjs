import { createHash, randomUUID } from "node:crypto";
import { inflateSync } from "node:zlib";
import { decodeOpenAIImageRgba, ImageCodecUnavailableError } from "./codec-runtime/index.mjs";

const GENERATION_ENDPOINT = "https://api.openai.com/v1/images/generations";
const EDIT_ENDPOINT = "https://api.openai.com/v1/images/edits";
const RETRY_MAPPING_REF = "openai-images-direct/retry-policy-v1";
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_RESPONSE_BYTES = Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 1024 * 1024;
const MAX_DECODED_BYTES = 64 * 1024 * 1024;
const MAX_PROVIDER_CONTEXT_BYTES = 1024 * 1024;
const MAX_PIXELS = 16_777_216;
const HASH = /^sha256:[a-f0-9]{64}$/;
const OPAQUE_REF = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;
const PROVIDER_REQUEST_REF = /^provider-request-[a-f0-9]{64}$/;
const SENSITIVE_ID_VALUE = /(?:\bbearer\s+\S+|\bbasic\s+\S+|\bsk-(?:proj-)?[A-Za-z0-9_-]{4,}|\bgh[pousr]_[A-Za-z0-9]{8,}\b|\b(?:rk|pk)-[A-Za-z0-9_-]{8,}|\b(?:xox[baprs]-|github_pat_|glpat-)[A-Za-z0-9_-]{8,}|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|https?:\/\/)/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  return crc >>> 0;
});
const PRIVATE_PROVIDER_REQUEST_IDS = new WeakMap();

/** The documented candidate pin is explicit and never auto-selected. Owner capability evidence is still required. */
export const OPENAI_IMAGE_CANDIDATE_PROFILES = Object.freeze({
  "gpt-image-2.5-sunburst-2026-09-08": Object.freeze({
    model_id: "gpt-image-2.5-sunburst-2026-09-08",
    docs_checked_at: "2026-10-10",
    documentation_status: "candidate_unselected",
    qualities: Object.freeze(["low", "medium", "high", "xhigh", "max"]),
    formats: Object.freeze(["png", "jpeg", "webp"]),
    transparent_formats: Object.freeze(["png", "webp"]),
    moderation: Object.freeze(["auto", "low"]),
    size_policy: "multiples_of_16_up_to_3840x2160_ratio_1_to_3",
    response_encoding: "base64",
    supports_input_fidelity: false,
    supports_streaming: false,
  }),
  "gpt-image-2.5-flare-2026-09-08": Object.freeze({
    model_id: "gpt-image-2.5-flare-2026-09-08",
    docs_checked_at: "2026-10-10",
    documentation_status: "candidate_unselected",
    qualities: Object.freeze(["low", "medium", "high", "xhigh", "max"]),
    formats: Object.freeze(["png", "jpeg", "webp"]),
    transparent_formats: Object.freeze(["png", "webp"]),
    moderation: Object.freeze(["auto", "low"]),
    size_policy: "multiples_of_16_up_to_3840x2160_ratio_1_to_3",
    response_encoding: "base64",
    supports_input_fidelity: false,
    supports_streaming: false,
  }),
});

export class OpenAIImagesProviderError extends Error {
  constructor(code, message, { outcome = "unknown", http_status, retry, provider_request_ref, field } = {}) {
    super(message);
    this.name = "OpenAIImagesProviderError";
    this.code = code;
    this.provider_outcome = outcome;
    if (http_status !== undefined) this.http_status = http_status;
    if (retry !== undefined) this.retry = Object.freeze(retry);
    if (provider_request_ref !== undefined) this.provider_request_ref = provider_request_ref;
    if (field !== undefined) this.field = field;
  }
}

function attachUsageObservation(error, usage, privateProviderRequestId) {
  if (usage !== undefined && !Object.hasOwn(error, "usage")) {
    Object.defineProperty(error, "usage", { value: usage, enumerable: true, configurable: false, writable: false });
  }
  const rawId = privateProviderRequestId ?? (usage && PRIVATE_PROVIDER_REQUEST_IDS.get(usage));
  if (typeof rawId === "string") PRIVATE_PROVIDER_REQUEST_IDS.set(error, rawId);
}

function fail(code, message, options) {
  const { private_provider_request_id: privateProviderRequestId, usage, ...publicOptions } = options ?? {};
  const error = new OpenAIImagesProviderError(code, message, publicOptions);
  attachUsageObservation(error, usage, privateProviderRequestId);
  throw error;
}

/** Internal runtime accessor; deliberately not re-exported from the public model barrel. */
export function readPrivateOpenAIImageRequestId(value) {
  return value !== null && typeof value === "object" ? PRIVATE_PROVIDER_REQUEST_IDS.get(value) : undefined;
}

function isRecord(value) {
  try {
    return value !== null && typeof value === "object" && !Array.isArray(value) &&
      (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  } catch { return false; }
}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function hashJson(value) {
  return sha256(Buffer.from(JSON.stringify(value), "utf8"));
}

function freezeJson(value) {
  if (Array.isArray(value)) {
    for (const item of value) freezeJson(item);
    return Object.freeze(value);
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) freezeJson(item);
    return Object.freeze(value);
  }
  return value;
}

function snapshotJson(value, field) {
  let serialized;
  try { serialized = JSON.stringify(value); } catch {
    fail("invalid_provider_input", "Provider context must be bounded JSON data.", { outcome: "failed", field });
  }
  if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > MAX_PROVIDER_CONTEXT_BYTES) {
    fail("invalid_provider_input", "Provider context must be bounded JSON data.", { outcome: "failed", field });
  }
  try { return freezeJson(JSON.parse(serialized)); } catch {
    fail("invalid_provider_input", "Provider context must be bounded JSON data.", { outcome: "failed", field });
  }
}

function snapshotProviderInput(value) {
  if (!isRecord(value)) fail("invalid_provider_input", "Trusted runtime provider input is incomplete.", { outcome: "failed" });
  return Object.freeze({
    scope: snapshotJson(value.scope, "scope"),
    actor_id: value.actor_id,
    job_id: value.job_id,
    attempt: snapshotJson(value.attempt, "attempt"),
    brief: snapshotJson(value.brief, "brief"),
    base_design: value.base_design === null ? null : snapshotJson(value.base_design, "base_design"),
    plan: snapshotJson(value.plan, "plan"),
    ...(value.decision_result === undefined ? {} : { decision_result: snapshotJson(value.decision_result, "decision_result") }),
    transport_attempt_id: value.transport_attempt_id,
    dispatch_intent_ref: value.dispatch_intent_ref,
    reservation_ref: value.reservation_ref,
    recordTransportAttempt: value.recordTransportAttempt,
    signal: value.signal,
    deadline_at: value.deadline_at,
    attempt_number: value.attempt_number,
    started_at: value.started_at,
  });
}

function isDate(value) {
  return typeof value === "string" && ISO_DATE.test(value) && Number.isFinite(Date.parse(value));
}

function checkRef(value, field) {
  if (typeof value !== "string" || !OPAQUE_REF.test(value) || SENSITIVE_ID_VALUE.test(value)) {
    fail("invalid_configuration", "A bounded opaque reference is required.", { outcome: "failed", field });
  }
  return value;
}

function checkTargetProfile(modelId) {
  const profile = typeof modelId === "string" && Object.hasOwn(OPENAI_IMAGE_CANDIDATE_PROFILES, modelId)
    ? OPENAI_IMAGE_CANDIDATE_PROFILES[modelId] : undefined;
  if (!profile) fail("unsupported_model_profile", "No explicit documented image model profile is configured.", { outcome: "failed", field: "model" });
  return profile;
}

function imageSize(value, profile) {
  if (value === "auto") return null;
  if (typeof value !== "string" || !/^(?:[1-9]\d{0,3})x(?:[1-9]\d{0,3})$/.test(value)) {
    fail("unsupported_image_configuration", "Image size must use a documented width x height value or auto.", { outcome: "failed", field: "size" });
  }
  const [width, height] = value.split("x").map(Number);
  const maxW = width >= height ? 3840 : 2160;
  const maxH = width >= height ? 2160 : 3840;
  if (width < 16 || height < 16 || width > maxW || height > maxH || width * height > MAX_PIXELS ||
      width / height < 1 / 3 || width / height > 3 || width % 16 !== 0 || height % 16 !== 0 ||
      profile.size_policy !== "multiples_of_16_up_to_3840x2160_ratio_1_to_3") {
    fail("unsupported_image_configuration", "Image dimensions exceed the pinned documented capability profile.", { outcome: "failed", field: "size" });
  }
  return { width, height };
}

function profileDimensionsMatch(info, profile) {
  if (!Number.isSafeInteger(info.width) || !Number.isSafeInteger(info.height) || info.width < 16 || info.height < 16) return false;
  const maxWidth = info.width >= info.height ? 3840 : 2160;
  const maxHeight = info.width >= info.height ? 2160 : 3840;
  return profile.size_policy === "multiples_of_16_up_to_3840x2160_ratio_1_to_3" &&
    info.width <= maxWidth && info.height <= maxHeight && info.width * info.height <= MAX_PIXELS &&
    info.width % 16 === 0 && info.height % 16 === 0 && info.width / info.height >= 1 / 3 && info.width / info.height <= 3;
}

function validateConfiguration(configuration, profile, operation) {
  if (!isRecord(configuration)) fail("invalid_configuration", "Explicit image configuration is required.", { outcome: "failed", field: "configuration" });
  const allowed = new Set(["quality", "size", "output_format", "background", "moderation"]);
  if (Object.keys(configuration).some((key) => !allowed.has(key))) {
    fail("unsupported_image_configuration", "Image configuration contains an unsupported option.", { outcome: "failed", field: "configuration" });
  }
  const { quality, size, output_format, background, moderation } = configuration;
  const dimensions = imageSize(size, profile);
  if (!profile.qualities.includes(quality) || !profile.formats.includes(output_format) ||
      !["opaque", "transparent"].includes(background) || !profile.moderation.includes(moderation) ||
      (background === "transparent" && !profile.transparent_formats.includes(output_format))) {
    fail("unsupported_image_configuration", "Requested quality, format, background, or moderation is outside the explicit model profile.", { outcome: "failed", field: "configuration" });
  }
  if (operation !== "generate" && operation !== "edit") {
    fail("unsupported_operation", "Only direct Images generation and edit operations are supported.", { outcome: "failed", field: "operation" });
  }
  return Object.freeze({ quality, size, output_format, background, moderation, dimensions });
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function paeth(left, above, upperLeft) {
  const prediction = left + above - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const aboveDistance = Math.abs(prediction - above);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  return aboveDistance <= upperLeftDistance ? above : upperLeft;
}

function inspectPng(bytes) {
  const reject = () => fail("image_bytes_invalid", "PNG bytes are not a bounded, decodable image.", { outcome: "unknown" });
  if (bytes.length < 45 || bytes.length > MAX_IMAGE_BYTES || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) reject();
  let offset = 8;
  let width;
  let height;
  let bitDepth;
  let colorType;
  let interlace;
  let sawHeader = false;
  let sawPalette = false;
  let sawData = false;
  let dataFinished = false;
  let sawEnd = false;
  let idatSize = 0;
  const idat = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (length > MAX_IMAGE_BYTES || end > bytes.length) reject();
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    const checksum = bytes.readUInt32BE(offset + 8 + length);
    if (!/^[A-Za-z]{4}$/.test(type) || crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== checksum || sawEnd) reject();
    if (!sawHeader && type !== "IHDR") reject();
    if (type === "IHDR") {
      if (sawHeader || length !== 13) reject();
      sawHeader = true;
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
      const legal = colorType === 0 ? [1, 2, 4, 8, 16]
        : colorType === 2 ? [8, 16]
          : colorType === 3 ? [1, 2, 4, 8]
            : colorType === 4 || colorType === 6 ? [8, 16] : [];
      if (!width || !height || width > 4096 || height > 4096 || width * height > MAX_PIXELS ||
          !legal.includes(bitDepth) || data[10] !== 0 || data[11] !== 0 || interlace !== 0) reject();
    } else if (type === "PLTE") {
      if (sawData || sawPalette || colorType === 0 || colorType === 4 || length < 3 || length > 768 || length % 3 !== 0 ||
          (colorType === 3 && length / 3 > 2 ** bitDepth)) reject();
      sawPalette = true;
    } else if (type === "IDAT") {
      if (dataFinished || (colorType === 3 && !sawPalette)) reject();
      sawData = true;
      idatSize += length;
      if (idatSize > MAX_IMAGE_BYTES) reject();
      idat.push(data);
    } else if (type === "IEND") {
      if (!sawData || length !== 0) reject();
      sawEnd = true;
    } else {
      if (sawData) dataFinished = true;
      if (type.charCodeAt(0) >= 65 && type.charCodeAt(0) <= 90) reject();
    }
    if (sawData && type !== "IDAT" && type !== "IEND") dataFinished = true;
    offset = end;
    if (sawEnd) break;
  }
  if (!sawHeader || !sawData || !sawEnd || offset !== bytes.length || (colorType === 3 && !sawPalette)) reject();
  const channels = colorType === 0 || colorType === 3 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : 4;
  const rowBytes = Math.ceil(width * channels * bitDepth / 8);
  const decodedSize = (rowBytes + 1) * height;
  if (decodedSize > MAX_DECODED_BYTES) reject();
  let decoded;
  try {
    const compressed = Buffer.concat(idat);
    const inflated = inflateSync(compressed, { maxOutputLength: decodedSize, info: true });
    if (inflated.engine.bytesWritten !== compressed.length) reject();
    decoded = inflated.buffer;
  } catch {
    reject();
  }
  if (decoded.length !== decodedSize) reject();
  const bytesPerPixel = Math.max(1, Math.ceil(channels * bitDepth / 8));
  const pixels = Buffer.allocUnsafe(rowBytes * height);
  for (let row = 0; row < height; row += 1) {
    const sourceOffset = row * (rowBytes + 1);
    const filter = decoded[sourceOffset];
    if (filter > 4) reject();
    const rowOffset = row * rowBytes;
    for (let column = 0; column < rowBytes; column += 1) {
      const raw = decoded[sourceOffset + column + 1];
      const left = column >= bytesPerPixel ? pixels[rowOffset + column - bytesPerPixel] : 0;
      const above = row > 0 ? pixels[rowOffset + column - rowBytes] : 0;
      const upperLeft = row > 0 && column >= bytesPerPixel ? pixels[rowOffset + column - rowBytes - bytesPerPixel] : 0;
      const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? above
        : filter === 3 ? Math.floor((left + above) / 2) : paeth(left, above, upperLeft);
      pixels[rowOffset + column] = (raw + predictor) & 0xff;
    }
  }
  // Indexed PNG is rejected because validating all packed palette indices is
  // outside this small dependency-free decoder's supported subset.
  if (colorType === 3) reject();
  const hasAlpha = colorType === 4 || colorType === 6;
  let hasTransparency = false;
  if (hasAlpha) {
    const bytesPerSample = bitDepth === 16 ? 2 : 1;
    const alphaChannel = colorType === 4 ? 1 : 3;
    for (let row = 0; row < height && !hasTransparency; row += 1) {
      const rowOffset = row * rowBytes;
      for (let column = 0; column < width; column += 1) {
        const alphaOffset = rowOffset + (column * channels + alphaChannel) * bytesPerSample;
        const alpha = bytesPerSample === 1 ? pixels[alphaOffset] : pixels.readUInt16BE(alphaOffset);
        if (alpha < (bitDepth === 16 ? 0xffff : 0xff)) { hasTransparency = true; break; }
      }
    }
  }
  return { format: "png", width, height, has_alpha: hasAlpha, has_transparency: hasTransparency };
}

function jpegHuffmanTable(bytes, start, end, reject) {
  if (start >= end) reject();
  const info = bytes[start++];
  const tableClass = info >> 4;
  const tableId = info & 0x0f;
  if (tableClass > 1 || tableId > 3 || start + 16 > end) reject();
  const counts = [...bytes.subarray(start, start + 16)];
  start += 16;
  const symbolCount = counts.reduce((sum, count) => sum + count, 0);
  if (symbolCount < 1 || symbolCount > 256 || start + symbolCount > end) reject();
  let slots = 1;
  for (const count of counts) {
    slots = slots * 2 - count;
    if (slots < 0) reject();
  }
  const symbols = bytes.subarray(start, start + symbolCount);
  const codes = new Map();
  let code = 0;
  let symbolIndex = 0;
  for (let length = 1; length <= 16; length += 1) {
    for (let index = 0; index < counts[length - 1]; index += 1) {
      codes.set(`${length}:${code++}`, symbols[symbolIndex++]);
    }
    code <<= 1;
  }
  return { tableClass, tableId, codes, end: start + symbolCount };
}

function inspectJpeg(bytes) {
  const reject = () => fail("image_bytes_invalid", "JPEG bytes are not a bounded, decodable baseline image.", { outcome: "unknown" });
  if (bytes.length < 16 || bytes.length > MAX_IMAGE_BYTES || bytes[0] !== 0xff || bytes[1] !== 0xd8) reject();
  let offset = 2;
  let width;
  let height;
  let components;
  let maxH = 0;
  let maxV = 0;
  let restartInterval = 0;
  let frameSeen = false;
  let scanSeen = false;
  let endSeen = false;
  const quantizationTables = new Set();
  const huffmanTables = new Map();

  const scanEntropy = (start, scanComponents) => {
    const mcuColumns = Math.ceil(width / (8 * maxH));
    const mcuRows = Math.ceil(height / (8 * maxV));
    const mcuCount = mcuColumns * mcuRows;
    let position = start;
    let currentByte = 0;
    let remainingBits = 0;
    const readBit = () => {
      if (remainingBits === 0) {
        if (position >= bytes.length) reject();
        currentByte = bytes[position++];
        if (currentByte === 0xff) {
          if (position >= bytes.length || bytes[position++] !== 0x00) reject();
        }
        remainingBits = 8;
      }
      remainingBits -= 1;
      return (currentByte >> remainingBits) & 1;
    };
    const readBits = (count) => {
      let value = 0;
      for (let bit = 0; bit < count; bit += 1) value = (value << 1) | readBit();
      return value;
    };
    const readSymbol = (table) => {
      if (!table) reject();
      let code = 0;
      for (let length = 1; length <= 16; length += 1) {
        code = (code << 1) | readBit();
        const symbol = table.codes.get(`${length}:${code}`);
        if (symbol !== undefined) return symbol;
      }
      reject();
    };
    const decodeBlock = (component) => {
      const dc = huffmanTables.get(`0:${component.dcTable}`);
      const ac = huffmanTables.get(`1:${component.acTable}`);
      const dcSize = readSymbol(dc);
      if (dcSize > 11) reject();
      if (dcSize > 0) readBits(dcSize);
      let coefficient = 1;
      while (coefficient < 64) {
        const symbol = readSymbol(ac);
        const run = symbol >> 4;
        const size = symbol & 0x0f;
        if (size === 0) {
          if (run === 0) break;
          if (run !== 15) reject();
          coefficient += 16;
        } else {
          if (size > 10) reject();
          coefficient += run;
          if (coefficient >= 64) reject();
          readBits(size);
          coefficient += 1;
        }
      }
    };
    for (let mcu = 0; mcu < mcuCount; mcu += 1) {
      for (const component of scanComponents) {
        for (let block = 0; block < component.h * component.v; block += 1) decodeBlock(component);
      }
      if (restartInterval > 0 && (mcu + 1) < mcuCount && (mcu + 1) % restartInterval === 0) {
        if (remainingBits > 0 && (currentByte & ((1 << remainingBits) - 1)) !== (1 << remainingBits) - 1) reject();
        remainingBits = 0;
        if (bytes[position++] !== 0xff || bytes[position++] !== 0xd0 + (((mcu + 1) / restartInterval - 1) % 8)) reject();
      }
    }
    if (remainingBits > 0 && (currentByte & ((1 << remainingBits) - 1)) !== (1 << remainingBits) - 1) reject();
    while (bytes[position] === 0xff && bytes[position + 1] === 0xff) position += 1;
    if (bytes[position] !== 0xff || ![0xd9].includes(bytes[position + 1])) reject();
    return position;
  };

  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) reject();
    while (bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) reject();
    const marker = bytes[offset++];
    if (marker === 0xd9) { endSeen = true; break; }
    if (marker === 0xd8 || marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) reject();
    if (marker === 0x01) continue;
    if (offset + 2 > bytes.length) reject();
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) reject();
    const segmentStart = offset + 2;
    const segmentEnd = offset + length;
    if (marker === 0xdb) {
      let cursor = segmentStart;
      while (cursor < segmentEnd) {
        const spec = bytes[cursor++];
        const precision = spec >> 4;
        const tableId = spec & 0x0f;
        const size = 64 * (precision + 1);
        if (precision > 1 || tableId > 3 || cursor + size > segmentEnd) reject();
        for (let index = 0; index < size; index += precision + 1) {
          if (precision === 0 ? bytes[cursor + index] === 0 : bytes.readUInt16BE(cursor + index) === 0) reject();
        }
        cursor += size;
        quantizationTables.add(tableId);
      }
    } else if (marker === 0xc4) {
      let cursor = segmentStart;
      while (cursor < segmentEnd) {
        const table = jpegHuffmanTable(bytes, cursor, segmentEnd, reject);
        huffmanTables.set(`${table.tableClass}:${table.tableId}`, table);
        cursor = table.end;
      }
    } else if (marker === 0xc0) {
      if (frameSeen || length < 11 || bytes[segmentStart] !== 8) reject();
      height = bytes.readUInt16BE(segmentStart + 1);
      width = bytes.readUInt16BE(segmentStart + 3);
      const componentCount = bytes[segmentStart + 5];
      if (!width || !height || width > 4096 || height > 4096 || width * height > MAX_PIXELS ||
          componentCount < 1 || componentCount > 4 || length !== 8 + componentCount * 3) reject();
      components = new Map();
      for (let index = 0; index < componentCount; index += 1) {
        const cursor = segmentStart + 6 + index * 3;
        const id = bytes[cursor];
        const sampling = bytes[cursor + 1];
        const h = sampling >> 4;
        const v = sampling & 0x0f;
        const quantizationTable = bytes[cursor + 2];
        if (components.has(id) || h < 1 || h > 4 || v < 1 || v > 4 || quantizationTable > 3) reject();
        components.set(id, { id, h, v, quantizationTable });
        maxH = Math.max(maxH, h);
        maxV = Math.max(maxV, v);
      }
      frameSeen = true;
    } else if (marker === 0xdd) {
      if (length !== 4) reject();
      restartInterval = bytes.readUInt16BE(segmentStart);
    } else if (marker === 0xda) {
      if (!frameSeen || scanSeen || length < 8) reject();
      const scanCount = bytes[segmentStart];
      if (scanCount !== components.size || length !== 6 + 2 * scanCount) reject();
      const scanComponents = [];
      const selected = new Set();
      for (let index = 0; index < scanCount; index += 1) {
        const cursor = segmentStart + 1 + index * 2;
        const id = bytes[cursor];
        const selector = bytes[cursor + 1];
        const component = components.get(id);
        const dcTable = selector >> 4;
        const acTable = selector & 0x0f;
        if (!component || selected.has(id) || dcTable > 3 || acTable > 3 ||
            !quantizationTables.has(component.quantizationTable) ||
            !huffmanTables.has(`0:${dcTable}`) || !huffmanTables.has(`1:${acTable}`)) reject();
        selected.add(id);
        scanComponents.push({ ...component, dcTable, acTable });
      }
      const spectral = segmentStart + 1 + 2 * scanCount;
      if (bytes[spectral] !== 0 || bytes[spectral + 1] !== 63 || bytes[spectral + 2] !== 0) reject();
      scanSeen = true;
      offset = scanEntropy(segmentEnd, scanComponents);
      continue;
    } else if ((marker >= 0xc1 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))) {
      reject(); // This bounded decoder accepts baseline sequential DCT only.
    } else if ((marker < 0xe0 || marker > 0xef) && marker !== 0xfe) {
      reject(); // Reject unknown non-APP metadata markers rather than skipping data semantics.
    }
    offset += length;
  }
  if (!frameSeen || !scanSeen || !endSeen || offset !== bytes.length) reject();
  return { format: "jpeg", width, height, has_alpha: false, has_transparency: false };
}

function inspectWebpStructure(bytes) {
  const reject = () => fail("image_bytes_invalid", "WebP bytes are not a bounded, structurally decodable image.", { outcome: "unknown" });
  if (bytes.length < 25 || bytes.length > MAX_IMAGE_BYTES || bytes.toString("ascii", 0, 4) !== "RIFF" ||
      bytes.toString("ascii", 8, 12) !== "WEBP" || bytes.readUInt32LE(4) !== bytes.length - 8) reject();
  let offset = 12;
  let width;
  let height;
  let imageWidth;
  let imageHeight;
  let hasAlpha = false;
  let sawImage = false;
  let sawExtendedHeader = false;
  while (offset + 8 <= bytes.length) {
    const type = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end + (size % 2) > bytes.length) reject();
    if (type === "VP8X") {
      if (size !== 10 || width !== undefined || offset !== 12 || (bytes[start] & 0xc3) !== 0) reject();
      sawExtendedHeader = true;
      hasAlpha = (bytes[start] & 0x10) !== 0;
      width = 1 + bytes.readUIntLE(start + 4, 3);
      height = 1 + bytes.readUIntLE(start + 7, 3);
    } else if (type === "VP8 ") {
      if (size < 10 || sawImage || (sawExtendedHeader && hasAlpha)) reject();
      const frameTag = bytes.readUIntLE(start, 3);
      if ((frameTag & 1) !== 0 || (frameTag >>> 5) < 1 || (frameTag >>> 5) > size - 10 ||
          bytes[start + 3] !== 0x9d || bytes[start + 4] !== 0x01 || bytes[start + 5] !== 0x2a) reject();
      imageWidth = bytes.readUInt16LE(start + 6) & 0x3fff;
      imageHeight = bytes.readUInt16LE(start + 8) & 0x3fff;
      width = width ?? imageWidth;
      height = height ?? imageHeight;
      if (sawExtendedHeader && (imageWidth !== width || imageHeight !== height)) reject();
      sawImage = true;
    } else if (type === "VP8L") {
      if (size <= 5 || sawImage || bytes[start] !== 0x2f || (bytes[start + 4] >>> 5) !== 0) reject();
      const bits = bytes[start + 1] | (bytes[start + 2] << 8) | (bytes[start + 3] << 16) | (bytes[start + 4] << 24);
      imageWidth = 1 + (bits & 0x3fff);
      imageHeight = 1 + ((bits >>> 14) & 0x3fff);
      const imageHasAlpha = (bytes[start + 4] & 0x10) !== 0;
      width = width ?? imageWidth;
      height = height ?? imageHeight;
      if ((sawExtendedHeader && (imageWidth !== width || imageHeight !== height || imageHasAlpha !== hasAlpha))) reject();
      hasAlpha = imageHasAlpha;
      sawImage = true;
    } else if (type === "ANMF" || type === "ALPH") {
      // Animated and separately-compressed alpha profiles are not accepted by this adapter.
      reject();
    }
    offset = end + (size % 2);
  }
  if (offset !== bytes.length || !sawImage || !width || !height || width > 4096 || height > 4096 || width * height > MAX_PIXELS) reject();
  return { format: "webp", width, height, has_alpha: hasAlpha, has_transparency: hasAlpha };
}

async function decodeAndVerifyPixels(bytes, structure) {
  let decoded;
  try { decoded = await decodeOpenAIImageRgba(bytes); } catch (error) {
    if (error instanceof ImageCodecUnavailableError) {
      fail("image_decoder_unavailable", "The pinned bounded image decoder is unavailable.", { outcome: "unknown" });
    }
    fail("image_bytes_invalid", "Image pixel content did not pass bounded decoding.", { outcome: "unknown" });
  }
  if (structure.format !== decoded.format || structure.width !== decoded.width || structure.height !== decoded.height ||
      structure.has_alpha !== decoded.has_alpha || (structure.format !== "webp" && structure.has_transparency !== decoded.has_transparency)) {
    fail("image_bytes_invalid", "Decoded pixels do not match the checked image container.", { outcome: "unknown" });
  }
  return Object.freeze({ ...structure, has_alpha: decoded.has_alpha, has_transparency: decoded.has_transparency });
}

/** Bounded image decoders used for provider outputs and edit inputs. */
export async function inspectOpenAIImageBytes(value) {
  if (!(value instanceof Uint8Array)) fail("image_bytes_invalid", "Image input must be a byte array.", { outcome: "unknown" });
  const bytes = Buffer.from(value);
  if (bytes.length > MAX_IMAGE_BYTES) fail("image_bytes_invalid", "Image bytes exceed the provider boundary limit.", { outcome: "unknown" });
  if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return decodeAndVerifyPixels(bytes, inspectPng(bytes));
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return decodeAndVerifyPixels(bytes, inspectJpeg(bytes));
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    return decodeAndVerifyPixels(bytes, inspectWebpStructure(bytes));
  }
  fail("image_bytes_invalid", "Image bytes are not PNG, JPEG, or WebP.", { outcome: "unknown" });
}

function decodeBase64(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 8 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    fail("provider_response_invalid", "Provider returned malformed base64 image data.", { outcome: "unknown" });
  }
  const bytes = Buffer.from(value, "base64");
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || bytes.toString("base64") !== value) {
    fail("provider_response_invalid", "Provider returned malformed or oversized image data.", { outcome: "unknown" });
  }
  return bytes;
}

async function readJsonBounded(response) {
  try {
    const declared = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
      try { await response.body?.cancel(); } catch { /* The response body is not public evidence. */ }
      fail("provider_response_invalid", "Provider response exceeded the bounded JSON size.", { outcome: "unknown" });
    }
    const reader = response.body?.getReader?.();
    if (!reader) fail("provider_response_invalid", "Provider response body is unavailable.", { outcome: "unknown" });
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        fail("provider_response_invalid", "Provider response exceeded the bounded JSON size.", { outcome: "unknown" });
      }
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks, total).toString("utf8");
    const parsed = JSON.parse(text);
    if (!isRecord(parsed)) fail("provider_response_invalid", "Provider response did not match the expected JSON object shape.", { outcome: "unknown" });
    return parsed;
  } catch (error) {
    if (error instanceof OpenAIImagesProviderError) throw error;
    fail("provider_response_invalid", "Provider returned an unreadable JSON response.", { outcome: "unknown" });
  }
}

function safeProviderRequestRef(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 16_384) return undefined;
  if (PROVIDER_REQUEST_REF.test(value)) return value;
  return `provider-request-${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function responseHeader(response, name) {
  try {
    const value = response.headers?.get?.(name);
    return typeof value === "string" ? value : undefined;
  } catch { return undefined; }
}

function exactUsage(value) {
  return Number.isSafeInteger(value) && value >= 0 ? String(value) : undefined;
}

function freezeUsageObservation(result) {
  const privateProviderRequestId = PRIVATE_PROVIDER_REQUEST_IDS.get(result);
  const frozen = Object.freeze(result);
  if (typeof privateProviderRequestId === "string") {
    PRIVATE_PROVIDER_REQUEST_IDS.set(frozen, privateProviderRequestId);
  }
  return frozen;
}

/** Preserve allowlisted provider counters; only a reviewed owner profile may map them for settlement. */
export function normalizeOpenAIImageUsage(raw, { transport_attempt_id, provider_request_id } = {}) {
  const result = { completeness: "unknown", missing_fields: ["usage.profile_mapping_pending"] };
  if (transport_attempt_id !== undefined) result.transport_attempt_id = checkRef(transport_attempt_id, "transport_attempt_id");
  const safeRequestRef = safeProviderRequestRef(provider_request_id);
  if (safeRequestRef) result.provider_request_id = safeRequestRef;
  if (typeof provider_request_id === "string") PRIVATE_PROVIDER_REQUEST_IDS.set(result, provider_request_id);
  if (!isRecord(raw)) {
    result.missing_fields = Object.freeze(["usage"]);
    return freezeUsageObservation(result);
  }

  const missing = new Set(result.missing_fields);
  for (const name of ["input_tokens", "output_tokens", "total_tokens"]) {
    if (!Object.hasOwn(raw, name)) { missing.add(`usage.${name}`); continue; }
    const quantity = exactUsage(raw[name]);
    if (quantity === undefined) missing.add(`usage.${name}`);
    else result[name] = Number(quantity);
  }
  for (const parent of ["input_tokens", "output_tokens"]) {
    const detailsKey = `${parent}_details`;
    if (!Object.hasOwn(raw, detailsKey)) { missing.add(`usage.${detailsKey}`); continue; }
    const details = raw[detailsKey];
    if (!isRecord(details)) { missing.add(`usage.${detailsKey}`); continue; }
    const safeDetails = {};
    for (const part of ["text_tokens", "image_tokens"]) {
      if (!Object.hasOwn(details, part)) { missing.add(`usage.${detailsKey}.${part}`); continue; }
      const quantity = exactUsage(details[part]);
      if (quantity === undefined) missing.add(`usage.${detailsKey}.${part}`);
      else safeDetails[part] = Number(quantity);
    }
    if (Object.keys(details).some((key) => !["text_tokens", "image_tokens"].includes(key))) {
      missing.add(`usage.${detailsKey}.unmapped_fields`);
    }
    result[detailsKey] = Object.freeze(safeDetails);
  }
  if (Object.keys(raw).some((key) => ![
    "input_tokens", "output_tokens", "total_tokens", "input_tokens_details", "output_tokens_details",
  ].includes(key))) missing.add("usage.unmapped_fields");
  result.missing_fields = Object.freeze([...missing]);
  return freezeUsageObservation(result);
}

function usageFromPayload(payload, transportAttemptId, rawProviderRequestId) {
  if (!isRecord(payload) || !Object.hasOwn(payload, "usage")) return undefined;
  return normalizeOpenAIImageUsage(payload.usage, {
    transport_attempt_id: transportAttemptId,
    provider_request_id: rawProviderRequestId,
  });
}

function parseRetryAfter(value, nowMs) {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const text = value.trim();
  if (/^(?:0|[1-9]\d*)$/.test(text)) {
    const seconds = Number(text);
    return Number.isFinite(seconds) ? Math.ceil(seconds * 1000) : undefined;
  }
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - nowMs) : undefined;
}

/** Advisory only: returning eligible never dispatches and does not authorize a new paid attempt. */
export function evaluateOpenAIImageRetry({ retry_after, attempt_number, started_at, now_at, deadline_at,
  max_attempts = 3, max_elapsed_ms = 60_000, max_delay_ms = 10_000, next_attempt_authorized = false }) {
  const start = Date.parse(started_at);
  const now = Date.parse(now_at);
  const deadline = Date.parse(deadline_at);
  const delay = parseRetryAfter(retry_after, now);
  let stop_reason;
  if (!Number.isSafeInteger(max_attempts) || max_attempts < 1 ||
      !Number.isSafeInteger(max_elapsed_ms) || max_elapsed_ms < 1 ||
      !Number.isSafeInteger(max_delay_ms) || max_delay_ms < 0) stop_reason = "invalid_retry_policy";
  else if (!Number.isInteger(attempt_number) || attempt_number < 1 || attempt_number >= max_attempts) stop_reason = "attempt_limit";
  else if (![start, now, deadline].every(Number.isFinite) || now < start || !Number.isFinite(delay)) stop_reason = "retry_after_invalid";
  else if (delay > max_delay_ms) stop_reason = "delay_limit";
  else if (now - start + delay >= max_elapsed_ms || now + delay >= deadline) stop_reason = "time_limit";
  else if (next_attempt_authorized !== true) stop_reason = "fresh_authorization_required";
  if (stop_reason) return Object.freeze({ decision: "stop", stop_reason, delay_ms: delay ?? null, automatic_retry: false });
  return Object.freeze({ decision: "eligible_for_separately_authorized_attempt", delay_ms: delay,
    automatic_retry: false, new_billable_identity_required: true });
}

function targetBinding({ attempt, operation, profile, config, endpoint, nodeVersion, deadlineAt,
  inputSha256, promptSha256, planSha256, parentArtifactSha256, maskContentSha256 }) {
  return Object.freeze({
    service: "openai",
    endpoint,
    model: profile.model_id,
    sdk_name: "native-fetch",
    sdk_version: nodeVersion,
    configuration_sha256: hashJson({ model_id: profile.model_id, config }),
    operation,
    operation_kind: attempt.operation_kind,
    input_sha256: inputSha256,
    prompt_sha256: promptSha256,
    plan_sha256: planSha256,
    ...(parentArtifactSha256 ? { parent_artifact_sha256: parentArtifactSha256 } : {}),
    ...(maskContentSha256 ? { mask_content_sha256: maskContentSha256 } : {}),
    deadline_at: deadlineAt,
    transport_policy: Object.freeze({
      maximum_transport_attempts: 1,
      automatic_retry: false,
      stop_on: Object.freeze(["cancelled", "deadline", "revoked", "lease_expired", "capability_expired"]),
    }),
    tenant_id: attempt.tenant_id,
    project_id: attempt.project_id,
    budget_scope_id: attempt.budget_scope_id,
    billable_attempt_id: attempt.billable_attempt_id,
  });
}

function validateAttempt(input, operation, profile) {
  if (!isRecord(input) || !isRecord(input.scope) || !isRecord(input.attempt) || !isRecord(input.brief) || !isRecord(input.plan)) {
    fail("invalid_provider_input", "Trusted runtime provider input is incomplete.", { outcome: "failed" });
  }
  const expectedKind = operation === "generate" ? "image_generation" : "image_edit";
  if (input.attempt.operation_kind !== expectedKind || input.attempt.provider?.name !== "openai" ||
      input.attempt.provider?.model !== profile.model_id || input.attempt.provider?.endpoint !== (operation === "generate" ? GENERATION_ENDPOINT : EDIT_ENDPOINT) ||
      input.attempt.provider?.sdk?.name !== "native-fetch" || input.attempt.provider?.sdk?.version !== process.versions.node ||
      input.attempt.tenant_id !== input.scope.tenant_id || input.attempt.project_id !== input.scope.project_id ||
      typeof input.attempt.budget_scope_id !== "string" || !input.attempt.billable_attempt_id ||
      !isDate(input.deadline_at) || !input.signal || typeof input.signal.aborted !== "boolean" ||
      typeof input.recordTransportAttempt !== "function" || typeof input.dispatch_intent_ref !== "string" ||
      typeof input.reservation_ref !== "string" || !OPAQUE_REF.test(input.reservation_ref) ||
      typeof input.transport_attempt_id !== "string" || !OPAQUE_REF.test(input.transport_attempt_id)) {
    fail("provider_attempt_mismatch", "Metered attempt does not match the pinned image operation.", { outcome: "failed" });
  }
  const expectedPlan = operation === "generate" ? "concept.generate" : "image.edit";
  if (input.plan.operation !== expectedPlan || !Array.isArray(input.plan.steps) || input.plan.steps.length < 1 || input.plan.steps.length > 16) {
    fail("unsupported_plan", "The edit plan is outside the supported direct Images operation.", { outcome: "failed" });
  }
  if (operation === "edit") {
    const step = input.plan.steps[0];
    const parameters = step?.parameters;
    const allowedParameters = new Set(["design_version_id", "artifact_id", "instruction", "mask_source_ref"]);
    if (input.plan.steps.length !== 1 || step?.action !== "image.edit" || !isRecord(parameters) ||
        Object.keys(parameters).some((key) => !allowedParameters.has(key))) {
      fail("unsupported_plan", "Only one parent-based edit with an optional mask is supported; extra image references require a typed contract.", {
        outcome: "failed", field: "plan.steps",
      });
    }
  }
  if (input.signal.aborted) fail("cancelled_before_dispatch", "Image request was cancelled before provider dispatch.", { outcome: "failed" });
  const identities = [input.attempt.logical_operation_id, input.attempt.billable_attempt_id,
    input.transport_attempt_id, input.dispatch_intent_ref, input.reservation_ref];
  if (identities.some((id) => typeof id !== "string" || !OPAQUE_REF.test(id) || SENSITIVE_ID_VALUE.test(id)) ||
      new Set(identities).size !== identities.length) {
    fail("provider_attempt_mismatch", "Operation, billing, transport, reservation, and dispatch identities must be distinct.", { outcome: "failed" });
  }
  return input;
}

function validatedCapability(result, expected, nowMs) {
  if (!Number.isFinite(nowMs) || !isRecord(result) || result.status !== "verified" || result.eligible !== true ||
      result.revoked !== false ||
      result.operation_permission !== "allowed" || result.quota_status !== "available" ||
      result.service !== "openai" || !isDate(result.expires_at) ||
      typeof result.account_ref !== "string" || !OPAQUE_REF.test(result.account_ref) ||
      typeof result.project_ref !== "string" || !OPAQUE_REF.test(result.project_ref) ||
      typeof result.evidence_ref !== "string" || !OPAQUE_REF.test(result.evidence_ref) ||
      !HASH.test(result.evidence_sha256) || Date.parse(result.expires_at) <= nowMs ||
      result.operation !== expected.operation || result.model !== expected.model ||
      result.tenant_id !== expected.scope.tenant_id || result.project_id !== expected.scope.project_id ||
      result.budget_scope_id !== expected.budget_scope_id ||
      result.target_binding_sha256 !== expected.target_sha256 ||
      (expected.account_ref !== undefined && result.account_ref !== expected.account_ref) ||
      (expected.project_ref !== undefined && result.project_ref !== expected.project_ref)) {
    fail("model_capability_unverified", "Current per-operation capability, quota, or scope evidence is missing or mismatched.", { outcome: "unknown" });
  }
  return result;
}

function validatedAuthority(result, expected, capability, nowMs) {
  if (!Number.isFinite(nowMs) || !isRecord(result) || result.status !== "authorized" || result.revoked !== false ||
      !isRecord(result.grant) || !isRecord(result.finance)) {
    fail("authorization_unavailable", "Trusted access or Finance authority did not authorize the exact image attempt.", { outcome: "unknown" });
  }
  const grant = result.grant;
  const finance = result.finance;
  const evidenceFieldsValid = [grant, finance].every((item) =>
    typeof item.evidence_ref === "string" && OPAQUE_REF.test(item.evidence_ref) && HASH.test(item.evidence_sha256));
  const exactBinding = grant.service === "openai" &&
    grant.account_ref === capability.account_ref && grant.project_ref === capability.project_ref &&
    grant.target_binding_sha256 === expected.target_sha256 && grant.operation === expected.operation && grant.model === expected.model &&
    grant.permission === "allowed" && grant.revoked === false && grant.tenant_id === expected.scope.tenant_id && grant.project_id === expected.scope.project_id &&
    finance.reservation_ref === expected.reservation_ref && finance.billable_attempt_id === expected.billable_attempt_id &&
    finance.budget_scope_id === expected.budget_scope_id &&
    finance.grant_ref === grant.grant_ref && finance.account_ref === grant.account_ref && finance.project_ref === grant.project_ref &&
    finance.tenant_id === expected.scope.tenant_id && finance.project_id === expected.scope.project_id &&
    finance.provider === "openai" && finance.model === expected.model && finance.operation === expected.operation &&
    finance.target_binding_sha256 === expected.target_sha256 && finance.status === "held" && finance.revoked === false &&
    isRecord(finance.held_amount) && /^(?:0|[1-9]\d*)(?:\.\d{1,9})?$/.test(finance.held_amount.amount) &&
    /^[A-Z]{3}$/.test(finance.held_amount.currency) &&
    isRecord(finance.authorized_cap) && /^(?:0|[1-9]\d*)(?:\.\d{1,9})?$/.test(finance.authorized_cap.amount) &&
    /^[A-Z]{3}$/.test(finance.authorized_cap.currency) && finance.authorized_cap.currency === finance.held_amount.currency &&
    amountAtMost(finance.held_amount.amount, finance.authorized_cap.amount) &&
    typeof grant.grant_ref === "string" && OPAQUE_REF.test(grant.grant_ref) &&
    typeof finance.lease_ref === "string" && OPAQUE_REF.test(finance.lease_ref) &&
    (expected.grant_ref === undefined || grant.grant_ref === expected.grant_ref) &&
    (expected.account_ref === undefined || grant.account_ref === expected.account_ref) &&
    (expected.project_ref === undefined || grant.project_ref === expected.project_ref) &&
    (expected.lease_ref === undefined || finance.lease_ref === expected.lease_ref) && evidenceFieldsValid;
  const expiries = [grant.expires_at, finance.expires_at].map(Date.parse);
  if (!exactBinding || expiries.some((expiry) => !Number.isFinite(expiry) || expiry <= nowMs)) {
    fail("authorization_unavailable", "Grant, capability, Finance lease, or reservation is mismatched or expired.", { outcome: "unknown" });
  }
  return result;
}

function validateCredential(result, binding, authority, nowMs) {
  if (!isRecord(result) || result.status !== "resolved" || typeof result.token !== "string" ||
      result.token.length < 1 || result.token.length > 8192 || /[\r\n\0]/.test(result.token) ||
      !isRecord(result.binding) || !isRecord(result.provider_scope) || !isDate(result.expires_at) ||
      !isRecord(result.evidence) || typeof result.evidence.ref !== "string" || !OPAQUE_REF.test(result.evidence.ref) ||
      !HASH.test(result.evidence.sha256)) {
    fail("credential_unavailable", "Scoped provider credential resolution did not return safe binding evidence.", { outcome: "failed" });
  }
  const grant = authority.grant;
  if (result.binding.service !== "openai" || result.binding.account_ref !== grant.account_ref ||
      result.binding.project_ref !== grant.project_ref || result.binding.grant_ref !== grant.grant_ref ||
      result.binding.target_binding_sha256 !== binding.target_sha256 ||
      result.provider_scope.organization_id !== grant.account_ref || result.provider_scope.project_id !== grant.project_ref ||
      !Number.isFinite(nowMs) || Date.parse(result.expires_at) <= nowMs) {
    fail("credential_unavailable", "Credential account, project, grant, or target binding did not match the authorized attempt.", { outcome: "failed" });
  }
  return result;
}

function amountAtMost(value, maximum) {
  if (typeof value !== "string" || typeof maximum !== "string") return false;
  const parse = (decimal) => {
    if (!/^(?:0|[1-9]\d*)(?:\.\d{1,9})?$/.test(decimal)) return undefined;
    const [whole, fraction = ""] = decimal.split(".");
    return { units: BigInt(whole + fraction), scale: fraction.length };
  };
  const left = parse(value);
  const right = parse(maximum);
  if (!left || !right) return false;
  const scale = Math.max(left.scale, right.scale);
  return left.units * (10n ** BigInt(scale - left.scale)) <= right.units * (10n ** BigInt(scale - right.scale));
}

async function callTrustedPort(code, message, callback, outcome = "unknown") {
  try { return await callback(); }
  catch { fail(code, message, { outcome }); }
}

function maskAndReferenceBytes(input, assetPort, parentImage) {
  const step = input.plan.steps.find((item) => item?.action === "image.edit");
  if (!step || !isRecord(step.parameters) || step.parameters.design_version_id !== input.base_design?.design_version_id ||
      step.parameters.artifact_id !== input.base_design?.artifact?.artifact_id || typeof step.parameters.instruction !== "string") {
    fail("unsupported_plan", "Edit plan does not bind the exact selected parent artwork.", { outcome: "failed", field: "plan.steps" });
  }
  if (!isRecord(input.base_design.artifact) || !HASH.test(input.base_design.artifact.content_hash) ||
      !["image/png", "image/jpeg", "image/webp"].includes(input.base_design.artifact.media_type)) {
    fail("asset_invalid", "The selected parent artwork has unsupported metadata.", { outcome: "failed", field: "base_design.artifact" });
  }
  return callTrustedPort("asset_unavailable", "The immutable parent artwork could not be read.", () =>
    assetPort.readArtifact({ scope: input.scope, artifact_id: input.base_design.artifact.artifact_id,
      content_hash: input.base_design.artifact.content_hash, media_type: input.base_design.artifact.media_type }))
    .then(async (raw) => {
      if (!(raw instanceof Uint8Array) || raw.byteLength === 0 || raw.byteLength > MAX_IMAGE_BYTES || sha256(raw) !== input.base_design.artifact.content_hash) {
        fail("asset_integrity_error", "Parent artwork bytes do not match the immutable design version.", { outcome: "failed", field: "base_design.artifact" });
      }
      const bytes = Buffer.from(raw);
      const info = await inspectOpenAIImageBytes(bytes);
      if (`image/${info.format}` !== input.base_design.artifact.media_type || !parentImage) {
        fail("asset_integrity_error", "Parent artwork format does not match its immutable media type.", { outcome: "failed" });
      }
      return { bytes, info, step };
    });
}

async function prepareEditAssets(input, assetPort) {
  if (!assetPort || typeof assetPort.readArtifact !== "function") {
    fail("asset_unavailable", "A trusted immutable artifact reader is required for image edits.", { outcome: "failed" });
  }
  const parent = await maskAndReferenceBytes(input, assetPort, true);
  let mask;
  const maskRef = parent.step.parameters.mask_source_ref;
  if (maskRef !== undefined) {
    if (typeof assetPort.readReference !== "function" || typeof maskRef !== "string" || !OPAQUE_REF.test(maskRef)) {
      fail("mask_unavailable", "A scoped mask reference could not be resolved.", { outcome: "failed", field: "plan.steps.parameters.mask_source_ref" });
    }
    const rawMask = await callTrustedPort("mask_unavailable", "The scoped edit mask could not be read.", () =>
      assetPort.readReference({ scope: input.scope, source_ref: maskRef, expected_media_type: "image/png" }), "failed");
    if (!(rawMask instanceof Uint8Array) || rawMask.byteLength === 0 || rawMask.byteLength > MAX_IMAGE_BYTES) {
      fail("mask_invalid", "Mask bytes are empty or exceed the boundary limit.", { outcome: "failed" });
    }
    const bytes = Buffer.from(rawMask);
    const info = inspectPng(bytes);
    if (!info.has_alpha || !info.has_transparency || info.width !== parent.info.width || info.height !== parent.info.height) {
      fail("mask_invalid", "Mask must contain transparent alpha pixels and match parent artwork dimensions.", { outcome: "failed" });
    }
    mask = { bytes, source_ref: maskRef };
  }
  return { parent, mask };
}

function makePrompt(input, promptPort, operation) {
  if (!promptPort || typeof promptPort.render !== "function") {
    fail("prompt_unavailable", "An explicit local prompt renderer is required.", { outcome: "failed" });
  }
  return callTrustedPort("prompt_unavailable", "The local prompt renderer did not complete.", () =>
    promptPort.render({ operation, brief: input.brief, plan: input.plan,
      base_design: input.base_design ?? null, decision_result: input.decision_result }), "failed")
    .then((result) => {
      const text = typeof result === "string" ? result : result?.prompt;
      if (typeof text !== "string" || text.trim().length === 0 || Buffer.byteLength(text, "utf8") > 64_000) {
        fail("prompt_invalid", "Prompt renderer did not return bounded prompt text.", { outcome: "failed" });
      }
      return text;
    });
}

function makeBody(operation, input, config, profile, prompt, editAssets) {
  if (operation === "generate") {
    return { content_type: "application/json", body: JSON.stringify({
      model: profile.model_id,
      prompt,
      n: 1,
      size: config.size,
      quality: config.quality,
      output_format: config.output_format,
      background: config.background,
      moderation: config.moderation,
    }) };
  }
  const form = new FormData();
  form.set("model", profile.model_id);
  form.set("prompt", prompt);
  form.set("n", "1");
  form.set("size", config.size);
  form.set("quality", config.quality);
  form.set("output_format", config.output_format);
  form.set("background", config.background);
  form.set("moderation", config.moderation);
  form.append("image[]", new Blob([editAssets.parent.bytes], { type: input.base_design.artifact.media_type }), "parent-artwork");
  if (editAssets.mask) form.set("mask", new Blob([editAssets.mask.bytes], { type: "image/png" }), "edit-mask.png");
  return { content_type: undefined, body: form };
}

function assertLiveFence(input, authority, credential, nowMs, deadlineMs, expected, transportAckState) {
  if (!Number.isFinite(nowMs) || input.signal.aborted || nowMs >= deadlineMs || transportAckState !== "succeeded" ||
      Date.parse(credential.expires_at) <= nowMs ||
      Date.parse(authority.grant.expires_at) <= nowMs || Date.parse(authority.capability.expires_at) <= nowMs ||
      Date.parse(authority.finance.expires_at) <= nowMs || authority.revoked !== false ||
      authority.finance.reservation_ref !== expected.reservation_ref ||
      authority.finance.billable_attempt_id !== input.attempt.billable_attempt_id ||
      authority.grant.grant_ref !== expected.grant_ref || authority.finance.lease_ref !== expected.lease_ref ||
      authority.grant.account_ref !== expected.account_ref || authority.grant.project_ref !== expected.project_ref) {
    fail("dispatch_fence_closed", "Cancellation, deadline, revocation, or a stale Finance lease closed the dispatch fence.", { outcome: "unknown" });
  }
}

function knownProviderError(payload, status) {
  const code = typeof payload?.error?.code === "string" ? payload.error.code : "";
  const type = typeof payload?.error?.type === "string" ? payload.error.type : "";
  const marker = `${code} ${type}`.toLowerCase();
  if (/moderation|content[_-]?policy|safety[_-]?system/.test(marker)) return { code: "moderation_blocked", outcome: "failed" };
  if (/insufficient[_-]?quota|quota[_-]?exceeded|billing[_-]?hard[_-]?limit/.test(marker)) return { code: "provider_quota_exhausted", outcome: "failed" };
  if (status === 401 || /invalid[_-]?api[_-]?key|authentication/.test(marker)) return { code: "authentication_denied", outcome: "failed" };
  if (status === 403 || /permission[_-]?denied|forbidden/.test(marker)) return { code: "operation_permission_denied", outcome: "failed" };
  if (status === 429 || /rate[_-]?limit|overload/.test(marker)) return { code: "provider_rate_limited", outcome: "unknown" };
  return { code: "provider_request_failed", outcome: status >= 500 ? "unknown" : "failed" };
}

async function providerError(response, retryContext, providerRequestRef, rawProviderRequestId, transportAttemptId, now) {
  let payload;
  try { payload = await readJsonBounded(response); } catch { payload = {}; }
  const mapped = knownProviderError(payload, response.status);
  const usage = usageFromPayload(payload, transportAttemptId, rawProviderRequestId);
  let retry;
  if ((response.status === 429 && mapped.code === "provider_rate_limited") || response.status === 503) {
    const errorNow = now();
    retry = evaluateOpenAIImageRetry({
      retry_after: responseHeader(response, "retry-after"),
      attempt_number: retryContext.attempt_number,
      started_at: retryContext.started_at,
      now_at: Number.isFinite(errorNow) ? new Date(errorNow).toISOString() : "",
      deadline_at: retryContext.deadline_at,
      max_attempts: retryContext.max_attempts,
      max_elapsed_ms: retryContext.max_elapsed_ms,
      max_delay_ms: retryContext.max_delay_ms,
      next_attempt_authorized: false,
    });
  }
  fail(mapped.code, "Provider returned a bounded failure response.", {
    outcome: mapped.outcome, http_status: response.status, retry, provider_request_ref: providerRequestRef, usage,
    private_provider_request_id: rawProviderRequestId,
  });
}

/**
 * Direct Images API provider. Construction performs no I/O. Each invocation
 * makes at most one POST, after the C03 transport acknowledgement and a fresh
 * synchronous cancellation/deadline/lease fence. It has no implicit retry.
 */
export function createOpenAIImagesProvider({ model_id, configuration, capabilityPort, authorizationPort,
  credentialPort, promptPort, assetPort, fetchImpl = globalThis.fetch, now = () => Date.now(),
  idFactory = randomUUID, retryPolicy = {} }) {
  const profile = checkTargetProfile(model_id);
  const configured = validateConfiguration(configuration, profile, "generate");
  const pinnedConfiguration = Object.freeze({ quality: configured.quality, size: configured.size,
    output_format: configured.output_format, background: configured.background, moderation: configured.moderation });
  if (!capabilityPort || typeof capabilityPort.verify !== "function" || typeof capabilityPort.revalidate !== "function" ||
      !authorizationPort || typeof authorizationPort.revalidate !== "function" ||
      !credentialPort || typeof credentialPort.resolveCredential !== "function" ||
      typeof fetchImpl !== "function") {
    fail("provider_ports_unavailable", "Trusted model, access, credential, and native-fetch ports are required.", { outcome: "failed" });
  }
  const nodeVersion = process.versions.node;

  function resolveRoute({ operation }) {
    const endpoint = operation === "generate" ? GENERATION_ENDPOINT : operation === "edit" ? EDIT_ENDPOINT : undefined;
    if (!endpoint) fail("unsupported_operation", "Only Images generation and edit are supported.", { outcome: "failed" });
    return Object.freeze({ retry_mapping_ref: RETRY_MAPPING_REF, provider: Object.freeze({
      name: "openai", model: profile.model_id, endpoint,
      sdk: Object.freeze({ name: "native-fetch", version: nodeVersion }),
    }) });
  }

  async function dispatch(operation, rawInput) {
    // Capture caller-owned JSON before the first awaited port call. Later
    // mutations cannot change the prompt, provider body, or authorization hash.
    const input = validateAttempt(snapshotProviderInput(rawInput), operation, profile);
    const config = validateConfiguration(pinnedConfiguration, profile, operation);
    const endpoint = operation === "generate" ? GENERATION_ENDPOINT : EDIT_ENDPOINT;
    if (input.attempt.provider.endpoint !== endpoint) fail("provider_attempt_mismatch", "Metered endpoint does not match the requested operation.", { outcome: "failed" });

    const reservationRef = input.reservation_ref;
    if (typeof reservationRef !== "string" || !OPAQUE_REF.test(reservationRef)) {
      fail("reservation_reference_missing", "C03 reservation reference is not wired into this provider call.", { outcome: "failed", field: "reservation_ref" });
    }
    const deadlineMs = Date.parse(input.deadline_at);
    const initialNow = now();
    if (!Number.isFinite(initialNow) || initialNow >= deadlineMs || input.signal.aborted) {
      fail("deadline_or_cancelled", "The authorized image operation is no longer current.", { outcome: "failed" });
    }

    let prompt;
    let editAssets;
    if (operation === "generate") prompt = await makePrompt(input, promptPort, operation);
    else {
      editAssets = await prepareEditAssets(input, assetPort);
      prompt = await makePrompt(input, promptPort, operation);
    }
    const preparedAt = now();
    if (!Number.isFinite(preparedAt) || preparedAt >= deadlineMs || input.signal.aborted) {
      fail("deadline_or_cancelled", "The image operation expired while its immutable input was prepared.", { outcome: "failed" });
    }
    const promptSha256 = sha256(Buffer.from(prompt, "utf8"));
    const planSha256 = hashJson(input.plan);
    const parentArtifactSha256 = editAssets ? sha256(editAssets.parent.bytes) : undefined;
    const maskContentSha256 = editAssets?.mask ? sha256(editAssets.mask.bytes) : undefined;
    const inputSha256 = hashJson({
      plan_sha256: planSha256,
      prompt_sha256: promptSha256,
      ...(parentArtifactSha256 ? { parent_artifact_sha256: parentArtifactSha256 } : {}),
      ...(maskContentSha256 ? { mask_content_sha256: maskContentSha256 } : {}),
    });
    const binding = targetBinding({ attempt: input.attempt, operation, profile, config, endpoint, nodeVersion,
      deadlineAt: input.deadline_at, inputSha256, promptSha256, planSha256, parentArtifactSha256, maskContentSha256 });
    const targetSha = hashJson(binding);
    const capabilityExpected = {
      scope: input.scope,
      budget_scope_id: input.attempt.budget_scope_id,
      target_sha256: targetSha,
      model: profile.model_id,
      operation,
    };
    const capability = validatedCapability(await callTrustedPort("model_capability_unavailable",
      "Independent model eligibility verification failed.", () => capabilityPort.verify({
        scope: input.scope, attempt: input.attempt, operation, model: profile.model_id,
        target_binding: binding, target_binding_sha256: targetSha,
        reservation_ref: reservationRef, billable_attempt_id: input.attempt.billable_attempt_id,
        deadline_at: input.deadline_at, checked_at: new Date(initialNow).toISOString(),
      }), "unknown"), capabilityExpected, now());
    const authorityExpected = {
      ...capabilityExpected,
      reservation_ref: reservationRef,
      billable_attempt_id: input.attempt.billable_attempt_id,
    };
    const authority = validatedAuthority(await callTrustedPort("authorization_unavailable",
      "The independent grant and Finance verifier is unavailable.", () => authorizationPort.revalidate({
      scope: input.scope, attempt: input.attempt, operation, target_binding: binding,
      target_binding_sha256: targetSha, reservation_ref: reservationRef,
      account_ref: capability.account_ref, project_ref: capability.project_ref,
      billable_attempt_id: input.attempt.billable_attempt_id, budget_scope_id: input.attempt.budget_scope_id,
      dispatch_intent_ref: input.dispatch_intent_ref, deadline_at: input.deadline_at, phase: "preparation",
    })), authorityExpected, capability, now());
    const expected = {
      ...authorityExpected,
      grant_ref: authority.grant.grant_ref,
      account_ref: authority.grant.account_ref,
      project_ref: authority.grant.project_ref,
      lease_ref: authority.finance.lease_ref,
    };

    if (input.signal.aborted || now() >= deadlineMs) fail("deadline_or_cancelled", "The image operation expired before transport authorization.", { outcome: "failed" });
    const target = Object.freeze({ ...binding, target_binding_sha256: targetSha });
    const credential = validateCredential(await callTrustedPort("credential_unavailable",
      "Scoped provider credential resolution failed.", () => credentialPort.resolveCredential({
      service: "openai", scope: input.scope, target_binding: target, target_binding_sha256: targetSha,
      account_ref: expected.account_ref, project_ref: expected.project_ref, grant_ref: expected.grant_ref,
      reservation_ref: reservationRef, billable_attempt_id: input.attempt.billable_attempt_id,
      deadline_at: input.deadline_at, purpose: operation,
    })), { target_sha256: targetSha }, authority, now());
    const credentialCheckAt = now();
    if (input.signal.aborted || !Number.isFinite(credentialCheckAt) || credentialCheckAt >= deadlineMs) {
      fail("deadline_or_cancelled", "The image operation expired during scoped credential resolution.", { outcome: "failed" });
    }
    const request = makeBody(operation, input, config, profile, prompt, editAssets);
    const headers = Object.freeze({
      authorization: `Bearer ${credential.token}`,
      accept: "application/json",
      ...(request.content_type ? { "content-type": request.content_type } : {}),
      "OpenAI-Organization": expected.account_ref,
      "OpenAI-Project": expected.project_ref,
    });
    const transportId = checkRef(input.transport_attempt_id, "transport_attempt_id");
    let acknowledgedIntent;
    let transportAckState = "pending";
    try {
      acknowledgedIntent = await input.recordTransportAttempt(transportId);
      transportAckState = "succeeded";
    } catch {
      transportAckState = "failed";
      fail("transport_ack_unknown", "C03 did not confirm the provider transport identity.", { outcome: "unknown" });
    }
    if (acknowledgedIntent !== input.dispatch_intent_ref || input.signal.aborted || now() >= deadlineMs) {
      fail("transport_ack_mismatch", "Transport acknowledgement did not match the current dispatch fence.", { outcome: "unknown" });
    }

    // All asynchronous access checks happen after the C03 ack. Independent
    // authorities cannot provide an atomic cross-authority revocation read;
    // their sequential result is followed by this last synchronous fence.
    const postAckAuthority = validatedAuthority(await callTrustedPort("authorization_unavailable",
      "The grant and Finance verifier could not revalidate after transport authorization.", () => authorizationPort.revalidate({
      scope: input.scope, attempt: input.attempt, operation, target_binding: binding,
      target_binding_sha256: targetSha, reservation_ref: reservationRef,
      grant_ref: expected.grant_ref, account_ref: expected.account_ref, project_ref: expected.project_ref,
      finance_lease_ref: expected.lease_ref, dispatch_intent_ref: input.dispatch_intent_ref,
      budget_scope_id: expected.budget_scope_id, billable_attempt_id: expected.billable_attempt_id,
      deadline_at: input.deadline_at, phase: "post_transport_ack",
    })), expected, capability, now());
    const capabilityCheckAt = now();
    if (!Number.isFinite(capabilityCheckAt) || input.signal.aborted || capabilityCheckAt >= deadlineMs) {
      fail("dispatch_fence_closed", "Cancellation or deadline closed the post-acknowledgement dispatch fence.", { outcome: "unknown" });
    }
    const postAckCapability = validatedCapability(await callTrustedPort("model_capability_unavailable",
      "Model eligibility could not be revalidated after transport authorization.", () => capabilityPort.revalidate({
        scope: input.scope, attempt: input.attempt, operation, model: profile.model_id,
        target_binding: binding, target_binding_sha256: targetSha,
        account_ref: expected.account_ref, project_ref: expected.project_ref, grant_ref: expected.grant_ref,
        reservation_ref: reservationRef, billable_attempt_id: expected.billable_attempt_id,
        deadline_at: input.deadline_at, phase: "post_transport_ack", checked_at: new Date(capabilityCheckAt).toISOString(),
      })), { ...capabilityExpected, account_ref: expected.account_ref, project_ref: expected.project_ref }, now());
    const postAck = Object.freeze({ ...postAckAuthority, capability: postAckCapability });
    const fenceNow = now();
    assertLiveFence(input, postAck, credential, fenceNow, deadlineMs, expected, transportAckState);

    let response;
    try {
      // No await or callback occurs between the final synchronous fence and this POST.
      response = await fetchImpl(endpoint, { method: "POST", headers, body: request.body,
        signal: input.signal, redirect: "error", cache: "no-store" });
    } catch {
      fail("provider_transport_unknown", "Image provider transport ended without a confirmed response.", { outcome: "unknown" });
    }
    if (!response || typeof response.ok !== "boolean" || !Number.isInteger(response.status) || !response.body) {
      fail("provider_response_invalid", "Provider transport returned an invalid response envelope.", { outcome: "unknown" });
    }
    const rawProviderRequestId = responseHeader(response, "x-request-id");
    const providerRequestRef = safeProviderRequestRef(rawProviderRequestId);
    if (!response.ok) {
      await providerError(response, { attempt_number: input.attempt_number ?? 1,
        started_at: input.started_at ?? new Date(initialNow).toISOString(), deadline_at: input.deadline_at,
        max_attempts: retryPolicy.max_attempts ?? 3, max_elapsed_ms: retryPolicy.max_elapsed_ms ?? 60_000,
        max_delay_ms: retryPolicy.max_delay_ms ?? 10_000 }, providerRequestRef, rawProviderRequestId, transportId, now);
    }
    let payload;
    try { payload = await readJsonBounded(response); } catch (error) {
      if (error instanceof OpenAIImagesProviderError) {
        if (providerRequestRef) error.provider_request_ref = providerRequestRef;
        if (typeof rawProviderRequestId === "string") PRIVATE_PROVIDER_REQUEST_IDS.set(error, rawProviderRequestId);
      }
      throw error;
    }
    const usage = normalizeOpenAIImageUsage(payload.usage, {
      transport_attempt_id: transportId,
      provider_request_id: rawProviderRequestId,
    });
    const observedUsage = Object.hasOwn(payload, "usage") ? usage : undefined;
    if (input.signal.aborted || now() >= deadlineMs) {
      fail("provider_outcome_unknown", "Cancellation or deadline occurred after transport; output remains unpublished.", {
        outcome: "unknown", provider_request_ref: providerRequestRef, usage: observedUsage,
        private_provider_request_id: rawProviderRequestId,
      });
    }
    if (payload.error) {
      const mapped = knownProviderError(payload, response.status);
      fail(mapped.code, "Provider refused the image request.", {
        outcome: mapped.outcome, http_status: response.status, provider_request_ref: providerRequestRef, usage: observedUsage,
        private_provider_request_id: rawProviderRequestId,
      });
    }
    if (!Array.isArray(payload.data) || payload.data.length !== 1 || !isRecord(payload.data[0]) ||
        typeof payload.data[0].b64_json !== "string") {
      fail("provider_response_invalid", "Provider response did not contain one base64 image result.", {
        outcome: "unknown", provider_request_ref: providerRequestRef, usage: observedUsage,
        private_provider_request_id: rawProviderRequestId,
      });
    }
    let bytes;
    try { bytes = decodeBase64(payload.data[0].b64_json); } catch (error) {
      if (error instanceof OpenAIImagesProviderError) {
        attachUsageObservation(error, observedUsage, rawProviderRequestId);
        if (providerRequestRef) error.provider_request_ref = providerRequestRef;
      }
      throw error;
    }
    let imageInfo;
    try { imageInfo = await inspectOpenAIImageBytes(bytes); } catch (error) {
      if (error instanceof OpenAIImagesProviderError) {
        attachUsageObservation(error, observedUsage, rawProviderRequestId);
        if (providerRequestRef) error.provider_request_ref = providerRequestRef;
      }
      throw error;
    }
    if (!profileDimensionsMatch(imageInfo, profile) || imageInfo.format !== config.output_format ||
        (config.background === "transparent" && !imageInfo.has_alpha) || (config.dimensions &&
        (imageInfo.width !== config.dimensions.width || imageInfo.height !== config.dimensions.height))) {
      fail("provider_output_mismatch", "Provider image format or dimensions do not match the authorized request.", {
        outcome: "unknown", provider_request_ref: providerRequestRef, usage: observedUsage,
        private_provider_request_id: rawProviderRequestId,
      });
    }
    const decodeFinishedAt = now();
    if (input.signal.aborted || !Number.isFinite(decodeFinishedAt) || decodeFinishedAt >= deadlineMs) {
      fail("provider_outcome_unknown", "Cancellation or deadline occurred during image decoding; output remains unpublished.", {
        outcome: "unknown", provider_request_ref: providerRequestRef, usage: observedUsage,
        private_provider_request_id: rawProviderRequestId,
      });
    }
    return Object.freeze({
      artifact: Object.freeze({ artifact_id: checkRef(`artifact-${idFactory()}`, "artifact_id"), content_hash: sha256(bytes), media_type: `image/${imageInfo.format}` }),
      artifact_bytes: Uint8Array.from(bytes),
      provider: "openai",
      model: profile.model_id,
      usage,
    });
  }

  return Object.freeze({
    resolveRoute,
    async generate(input) { return dispatch("generate", input); },
    async edit(input) { return dispatch("edit", input); },
  });
}

export const OPENAI_IMAGES_ENDPOINTS = Object.freeze({ generation: GENERATION_ENDPOINT, edit: EDIT_ENDPOINT });
