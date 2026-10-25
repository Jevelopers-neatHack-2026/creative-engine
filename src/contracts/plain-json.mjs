import { types as utilTypes } from "node:util";

/** Internal contract primitive: snapshot bounded immutable JSON before any authority await. */
export function snapshotBoundedPlainJson(value, { maxStringLength = 128_000, maxKeyLength = 256 } = {}) {
  let nodes = 0;
  let bytes = 0;
  const seen = new Set();
  const copy = (current, depth) => {
    if (++nodes > 20_000 || depth > 64) throw new Error();
    if (typeof current === "string") {
      bytes += Buffer.byteLength(current, "utf8");
      if (current.length > maxStringLength || bytes > 1024 * 1024) throw new Error();
      return current;
    }
    if (current === null || typeof current === "boolean") return current;
    if (typeof current === "number" && Number.isFinite(current)) return current;
    if (!current || typeof current !== "object" || utilTypes.isProxy(current) || seen.has(current) ||
        !Array.isArray(current) && ![Object.prototype, null].includes(Object.getPrototypeOf(current))) throw new Error();
    seen.add(current);
    if (Array.isArray(current) && current.length > 20_000) throw new Error();
    const descriptors = Object.getOwnPropertyDescriptors(current);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length > 20_000 || keys.some((key) => typeof key !== "string")) throw new Error();
    const result = Array.isArray(current) ? [] : Object.create(null);
    for (const key of keys) {
      bytes += Buffer.byteLength(key, "utf8");
      if (key.length > maxKeyLength || bytes > 1024 * 1024) throw new Error();
      const descriptor = descriptors[key];
      if (!Object.hasOwn(descriptor, "value")) throw new Error();
      if (Array.isArray(current) && key === "length") continue;
      if (Array.isArray(current) && !/^(?:0|[1-9]\d*)$/.test(key)) throw new Error();
      Object.defineProperty(result, key, { value: copy(descriptor.value, depth + 1), enumerable: true });
    }
    if (Array.isArray(current) && Object.keys(result).length !== current.length) throw new Error();
    seen.delete(current);
    return Object.freeze(result);
  };
  try {
    if (![maxStringLength, maxKeyLength].every((limit) => Number.isSafeInteger(limit) && limit >= 0 && limit <= 1024 * 1024)) throw new Error();
    const captured = copy(value, 0);
    if (Buffer.byteLength(JSON.stringify(captured), "utf8") > 1024 * 1024) throw new Error();
    return captured;
  } catch { throw new TypeError("Execution values require bounded plain JSON without accessors."); }
}
