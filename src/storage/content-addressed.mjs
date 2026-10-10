import { createHash, randomUUID } from "node:crypto";
import { lstat, link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MAX_OBJECT_BYTES = 100 * 1024 * 1024;

export class ContentAddressedStorageError extends Error {
  constructor(code = "unavailable") {
    super("Content-addressed artifact storage is unavailable.");
    this.name = "ContentAddressedStorageError";
    this.code = code;
  }
}

export function hashArtifactBytes(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new ContentAddressedStorageError("invalid_bytes");
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function paths(root, contentHash) {
  if (typeof contentHash !== "string" || !HASH_PATTERN.test(contentHash)) {
    throw new ContentAddressedStorageError("invalid_hash");
  }
  const directory = resolve(root);
  const digest = contentHash.slice(7);
  const objectDirectory = join(directory, "objects", "sha256", digest.slice(0, 2));
  return {
    directory,
    objectDirectory,
    objectPath: join(objectDirectory, digest),
    stagingDirectory: join(directory, "staging"),
  };
}

async function syncDirectory(directory) {
  const handle = await open(directory, "r");
  try { await handle.sync(); }
  finally { await handle.close(); }
}

async function ensureDirectoryDurable(directory) {
  const resolved = resolve(directory);
  const missing = [];
  let current = resolved;
  for (;;) {
    try {
      const info = await lstat(current);
      if (!info.isDirectory()) throw new ContentAddressedStorageError();
      break;
    } catch (error) {
      if (error instanceof ContentAddressedStorageError) throw error;
      if (error?.code !== "ENOENT") throw error;
      missing.push(current);
      const parent = resolve(current, "..");
      if (parent === current) throw new ContentAddressedStorageError();
      current = parent;
    }
  }
  for (const child of missing.reverse()) {
    try {
      await mkdir(child, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const info = await lstat(child);
      if (!info.isDirectory()) throw new ContentAddressedStorageError();
    }
    await syncDirectory(resolve(child, ".."));
  }
}

/**
 * Write bytes to a private staging file, flush them, then publish an immutable
 * content-addressed object. The returned reference is internal; callers still
 * need a scoped metadata row before they can read the object.
 */
export async function writeContentAddressedObject(root, bytes, expectedHash) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_OBJECT_BYTES) {
    throw new ContentAddressedStorageError("invalid_bytes");
  }
  // Take ownership before the first await so the bytes that were hashed cannot
  // be replaced through a caller-owned view while directory creation is pending.
  const snapshot = Uint8Array.from(bytes);
  const actualHash = hashArtifactBytes(snapshot);
  if (actualHash !== expectedHash) throw new ContentAddressedStorageError("hash_mismatch");
  const location = paths(root, expectedHash);
  await ensureDirectoryDurable(location.directory);
  await syncDirectory(resolve(location.directory, ".."));
  await syncDirectory(location.directory);
  await ensureDirectoryDurable(resolve(location.directory, "objects"));
  await ensureDirectoryDurable(resolve(location.directory, "objects", "sha256"));
  await ensureDirectoryDurable(location.objectDirectory);
  await ensureDirectoryDurable(location.stagingDirectory);
  const temporaryPath = join(location.stagingDirectory, `${randomUUID()}.part`);
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(snapshot);
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporaryPath, location.objectPath);
      await unlink(temporaryPath);
      await syncDirectory(location.objectDirectory);
      await syncDirectory(location.stagingDirectory);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existingInfo = await lstat(location.objectPath);
      if (!existingInfo.isFile() || existingInfo.size < 1 || existingInfo.size > MAX_OBJECT_BYTES) {
        throw new ContentAddressedStorageError("hash_mismatch");
      }
      const existing = await readFile(location.objectPath);
      if (hashArtifactBytes(existing) !== expectedHash) throw new ContentAddressedStorageError("hash_mismatch");
      await unlink(temporaryPath);
      await syncDirectory(location.objectDirectory);
      await syncDirectory(location.stagingDirectory);
    }
  } catch (error) {
    if (handle) {
      try { await handle.close(); } catch { /* preserve the bounded storage error */ }
    }
    if (error instanceof ContentAddressedStorageError) throw error;
    throw new ContentAddressedStorageError("unavailable");
  }
  return Object.freeze({ content_hash: expectedHash, byte_length: snapshot.byteLength });
}

/** Read and re-hash an object; never trust a metadata hash without the bytes. */
export async function readContentAddressedObject(root, contentHash) {
  const location = paths(root, contentHash);
  let bytes;
  try {
    const info = await lstat(location.objectPath);
    if (!info.isFile() || info.size < 1 || info.size > MAX_OBJECT_BYTES) throw new Error("invalid object size");
    bytes = await readFile(location.objectPath);
  }
  catch { throw new ContentAddressedStorageError("unavailable"); }
  if (hashArtifactBytes(bytes) !== contentHash) throw new ContentAddressedStorageError("hash_mismatch");
  return Uint8Array.from(bytes);
}

/** Test/recovery helper: all callers must still verify a scoped metadata row. */
export async function objectExistsAndMatches(root, contentHash) {
  try {
    await readContentAddressedObject(root, contentHash);
    return true;
  } catch {
    return false;
  }
}
