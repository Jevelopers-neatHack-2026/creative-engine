const SENSITIVE_PUBLIC_FIELD = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|admission[_-]?token|client[_-]?secret|secret|password|credential|authorization|cookie|qr[_-]?payload|qr[_-]?code|working[_-]?admission|raw[_-]?response)/i;
const SENSITIVE_PUBLIC_TEXT = [
  /\bBearer\s+[A-Za-z0-9._~+/-]+={0,2}/i,
  /\b(?:admission[_ -]?token|working[_ -]?admission|qr[_ -]?(?:payload|code))\s*[:=]\s*["']?[^\s"'&,;]+/i,
  /\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|secret|password|authorization|credential|cookie)\s*[:=]\s*["']?[^\s"'&,;]+/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/i,
  /https?:\/\/[^\s"'<>]+[?&][^=\s&#]*(?:signature|sig|token|credential|secret|access[_-]?key|auth)[^=\s&#]*=[^&#\s]+/i,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /(?<!\d)(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?!\d)/,
];
const BASIC_AUTH_CANDIDATE = /\bBasic[\t ]+([A-Za-z0-9+/]+={0,2})(?![A-Za-z0-9+/=])/gi;
const MAX_BASIC_AUTH_TOKEN_CHARS = 8192;
const DEFAULT_LIMITS = Object.freeze({ maxDepth: 24, maxNodes: 8192, maxBytes: 64 * 1024 });
const ORDINARY_BEARER_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "by", "for", "from", "in",
  "is", "it", "of", "on", "or", "that", "the", "this", "to", "was", "were", "with",
]);

export class TelemetryPrivacyError extends Error {
  constructor(code = "unsafe_public_evidence") {
    super("Telemetry evidence could not be projected safely.");
    this.name = "TelemetryPrivacyError";
    this.code = code;
    this.field = "evidence";
  }
}

function hasBasicAuthMaterial(value) {
  BASIC_AUTH_CANDIDATE.lastIndex = 0;
  let match;
  while ((match = BASIC_AUTH_CANDIDATE.exec(value)) !== null) {
    const token = match[1];
    const unpadded = token.replace(/=+$/, "");
    if (unpadded.length % 4 === 1 || token.length > MAX_BASIC_AUTH_TOKEN_CHARS) continue;
    const decoded = Buffer.from(token, "base64");
    const canonical = decoded.toString("base64");
    if (canonical !== token && canonical.replace(/=+$/, "") !== token) continue;
    const colon = decoded.indexOf(0x3a);
    if (colon < 0 || [...decoded].some((byte) => byte < 0x20 || byte === 0x7f)) continue;
    return true;
  }
  return false;
}

export function containsSensitivePublicText(value) {
  if (typeof value !== "string") return false;
  if (hasBasicAuthMaterial(value)) return true;
  const bearer = /\bbearer\s+([A-Za-z0-9._~+/-]+={0,2})(?![A-Za-z0-9._~+/-=])/gi;
  let match;
  while ((match = bearer.exec(value)) !== null) {
    const candidate = match[1].replace(/=+$/, "");
    const hasPadding = match[1].includes("=");
    const hasFollowingText = value.slice(bearer.lastIndex).trim().length > 0;
    if (hasPadding || candidate.length >= 8 || !ORDINARY_BEARER_WORDS.has(candidate.toLowerCase()) || !hasFollowingText) return true;
  }
  return SENSITIVE_PUBLIC_TEXT.slice(1).some((pattern) => pattern.test(value));
}

export function isSensitivePublicField(value) {
  return typeof value === "string" && (SENSITIVE_PUBLIC_FIELD.test(value) || containsSensitivePublicText(value));
}

export function assertSafePublicIdentifier(value, { maxLength = 256 } = {}) {
  if (typeof value !== "string" || value.trim() === "" || value.length > maxLength ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/.test(value) || containsSensitivePublicText(value)) {
    throw new TelemetryPrivacyError("unsafe_public_identifier");
  }
  return value;
}

/**
 * Copy public telemetry JSON while omitting credential-shaped keys and replacing
 * credential/PII-shaped strings. Paths in the redaction report use numeric field
 * positions so the original sensitive key cannot escape in diagnostics.
 */
export function projectPublicTelemetry(value, limits = {}) {
  const maxDepth = limits.maxDepth ?? DEFAULT_LIMITS.maxDepth;
  const maxNodes = limits.maxNodes ?? DEFAULT_LIMITS.maxNodes;
  const maxBytes = limits.maxBytes ?? DEFAULT_LIMITS.maxBytes;
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1 || maxDepth > 64 ||
    !Number.isSafeInteger(maxNodes) || maxNodes < 1 || maxNodes > 100_000 ||
    !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024) {
    throw new TelemetryPrivacyError("invalid_projection_limits");
  }

  const seen = new WeakSet();
  const redactions = [];
  let nodes = 0;
  let estimatedBytes = 0;
  const addBytes = (text) => {
    estimatedBytes += Buffer.byteLength(text, "utf8");
    if (estimatedBytes > maxBytes) throw new TelemetryPrivacyError("public_evidence_too_large");
  };

  function copy(current, depth, path) {
    nodes += 1;
    if (nodes > maxNodes || depth > maxDepth) throw new TelemetryPrivacyError("public_evidence_too_complex");
    if (current === null || typeof current === "boolean") {
      estimatedBytes += 5;
      if (estimatedBytes > maxBytes) throw new TelemetryPrivacyError("public_evidence_too_large");
      return current;
    }
    if (typeof current === "string") {
      addBytes(current);
      if (containsSensitivePublicText(current)) {
        redactions.push(Object.freeze({ path, reason: "sensitive_value_redacted" }));
        return "[REDACTED]";
      }
      return current;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new TelemetryPrivacyError("invalid_public_number");
      addBytes(String(current));
      return current;
    }
    if (typeof current !== "object") throw new TelemetryPrivacyError("unsupported_public_value");
    if (seen.has(current)) throw new TelemetryPrivacyError("cyclic_public_evidence");
    seen.add(current);
    try {
      if (Array.isArray(current)) {
        if (current.length > maxNodes) throw new TelemetryPrivacyError("public_evidence_too_complex");
        const result = current.map((item, index) => copy(item, depth + 1, `${path}/item[${index}]`));
        return Object.freeze(result);
      }
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) throw new TelemetryPrivacyError("unsupported_public_object");
      const ownKeys = Reflect.ownKeys(current);
      if (ownKeys.some((key) => typeof key !== "string")) throw new TelemetryPrivacyError("symbol_public_field");
      const descriptors = Object.getOwnPropertyDescriptors(current);
      const result = Object.create(null);
      let fieldIndex = 0;
      for (const key of ownKeys) {
        const descriptor = descriptors[key];
        const childPath = `${path}/field[${fieldIndex}]`;
        fieldIndex += 1;
        if (!descriptor.enumerable) continue;
        if (!Object.hasOwn(descriptor, "value")) throw new TelemetryPrivacyError("accessor_public_field");
        addBytes(key);
        if (isSensitivePublicField(key)) {
          redactions.push(Object.freeze({ path: childPath, reason: "sensitive_field_omitted" }));
          continue;
        }
        Object.defineProperty(result, key, {
          value: copy(descriptor.value, depth + 1, childPath),
          enumerable: true,
          configurable: false,
          writable: false,
        });
      }
      return Object.freeze(result);
    } catch (error) {
      if (error instanceof TelemetryPrivacyError) throw error;
      throw new TelemetryPrivacyError();
    } finally {
      seen.delete(current);
    }
  }

  try {
    const projected = copy(value, 0, "$");
    return Object.freeze({ value: projected, redactions: Object.freeze(redactions) });
  } catch (error) {
    if (error instanceof TelemetryPrivacyError) throw error;
    throw new TelemetryPrivacyError();
  }
}
