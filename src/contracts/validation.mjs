export class ContractError extends Error {
  constructor(code, contract, field, message) {
    super(message);
    this.name = "ContractError";
    this.code = code;
    this.contract = contract;
    this.field = field;
  }
}

export function fail(code, contract, field, message) {
  throw new ContractError(code, contract, field, message);
}

export function expectObject(value, contract, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_type", contract, field, field + " must be an object.");
  }
  return value;
}

export function expectArray(value, contract, field) {
  if (!Array.isArray(value)) {
    fail("invalid_type", contract, field, field + " must be an array.");
  }
  return value;
}

export function expectString(value, contract, field, options = {}) {
  const { allowEmpty = false, maxLength = 2048 } = options;
  if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0)) {
    fail("invalid_type", contract, field, field + " must be a non-empty string.");
  }
  if (value.length > maxLength) {
    fail("out_of_bounds", contract, field, field + " exceeds the maximum length.");
  }
  return value;
}

export function expectEnum(value, allowed, contract, field) {
  if (!allowed.includes(value)) {
    fail(
      "invalid_value",
      contract,
      field,
      field + " must be one of: " + allowed.join(", ") + ".",
    );
  }
  return value;
}

export function expectFiniteNumber(value, contract, field, options = {}) {
  const { min = -Infinity, max = Infinity } = options;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail("invalid_number", contract, field, field + " must be finite.");
  }
  if (value < min || value > max) {
    fail("out_of_bounds", contract, field, field + " is outside the permitted range.");
  }
  return value;
}

export function expectInteger(value, contract, field, options = {}) {
  const { min = 0, max = Number.MAX_SAFE_INTEGER } = options;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail("invalid_integer", contract, field, field + " must be an integer in range.");
  }
  return value;
}

export function requireField(object, key, contract, path = key) {
  if (!Object.prototype.hasOwnProperty.call(object, key)) {
    fail("missing_field", contract, path, path + " is required.");
  }
  return object[key];
}

export function assertOnlyKeys(object, allowed, contract, path = "") {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) {
      const field = path ? path + "." + key : key;
      fail("unknown_field", contract, field, field + " is not part of this contract version.");
    }
  }
}

export function assertIsoDateTime(value, contract, field) {
  expectString(value, contract, field, { maxLength: 40 });
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || !/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    fail("invalid_datetime", contract, field, field + " must be an ISO date-time.");
  }
  return value;
}

export function assertHash(value, contract, field) {
  expectString(value, contract, field, { maxLength: 71 });
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) {
    fail("invalid_hash", contract, field, field + " must be a lowercase SHA-256 content hash.");
  }
  return value;
}

function normalizedKey(key) {
  return key.toLowerCase().replace(/[-_]/g, "");
}

function isSensitiveKey(key, parentPath) {
  const normalized = normalizedKey(key);
  if (parentPath === "usage" && (normalized === "inputtokens" || normalized === "outputtokens")) return false;
  return /(credential|token|secret|password|apikey|authorization|bearer|cookie)/.test(normalized);
}

export function rejectCredentialMaterial(value, contract, path = "") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectCredentialMaterial(entry, contract, path + "[" + index + "]"));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    const nextPath = path ? path + "." + key : key;
    if (isSensitiveKey(key, path)) {
      fail(
        "forbidden_sensitive_field",
        contract,
        nextPath,
        "Credential material cannot appear in creative contract outputs.",
      );
    }
    rejectCredentialMaterial(entry, contract, nextPath);
  }
}

export function sanitizeCredentialFields(value) {
  const omitted = [];

  function copy(current, path) {
    if (Array.isArray(current)) {
      return current.map((item, index) => copy(item, path + "[" + index + "]"));
    }
    if (current === null || typeof current !== "object") return current;
    const output = {};
    for (const [key, entry] of Object.entries(current)) {
      const nextPath = path ? path + "." + key : key;
      if (isSensitiveKey(key, path)) {
        omitted.push(Object.freeze({
          field_path: nextPath,
          reason: "credential_material_omitted",
        }));
      } else {
        Object.defineProperty(output, key, {
          value: copy(entry, nextPath),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
    }
    return output;
  }

  return Object.freeze({ value: copy(value, ""), omissions: Object.freeze(omitted) });
}

export function canonicalSerialize(value) {
  const seen = new Set();

  function serialize(current, path) {
    if (current === null) return "null";
    if (typeof current === "string") return JSON.stringify(current);
    if (typeof current === "boolean") return current ? "true" : "false";
    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        fail("invalid_number", "canonical-json/1", path, "Canonical JSON cannot contain a non-finite number.");
      }
      return Object.is(current, -0) ? "0" : JSON.stringify(current);
    }
    if (Array.isArray(current)) {
      if (seen.has(current)) fail("cyclic_value", "canonical-json/1", path, "Canonical JSON cannot contain cycles.");
      seen.add(current);
      const output = "[" + current.map((item, index) => serialize(item, path + "[" + index + "]")).join(",") + "]";
      seen.delete(current);
      return output;
    }
    if (typeof current === "object") {
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        fail("invalid_type", "canonical-json/1", path, "Canonical JSON accepts only plain objects.");
      }
      if (seen.has(current)) fail("cyclic_value", "canonical-json/1", path, "Canonical JSON cannot contain cycles.");
      seen.add(current);
      const keys = Object.keys(current).sort();
      const entries = keys.map((key) => {
        if (current[key] === undefined) {
          fail("invalid_type", "canonical-json/1", path + "." + key, "Canonical JSON cannot contain undefined values.");
        }
        return JSON.stringify(key) + ":" + serialize(current[key], path + "." + key);
      });
      seen.delete(current);
      return "{" + entries.join(",") + "}";
    }
    fail("invalid_type", "canonical-json/1", path, "Canonical JSON accepts only JSON values.");
  }

  return serialize(value, "$");
}

import * as cryptoModule from "node:crypto";

export function canonicalHash(value) {
  return "sha256:" + cryptoModule.createHash("sha256").update(canonicalSerialize(value), "utf8").digest("hex");
}
