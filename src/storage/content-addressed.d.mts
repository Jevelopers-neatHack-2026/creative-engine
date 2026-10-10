export type ArtifactHash = `sha256:${string}`;

export class ContentAddressedStorageError extends Error {
  readonly code: "invalid_bytes" | "invalid_hash" | "hash_mismatch" | "unavailable";
  constructor(code?: "invalid_bytes" | "invalid_hash" | "hash_mismatch" | "unavailable");
}

export function hashArtifactBytes(bytes: Uint8Array): ArtifactHash;
export function writeContentAddressedObject(
  root: string,
  bytes: Uint8Array,
  expectedHash: ArtifactHash,
): Promise<Readonly<{ content_hash: ArtifactHash; byte_length: number }>>;
export function readContentAddressedObject(root: string, contentHash: ArtifactHash): Promise<Uint8Array>;
export function objectExistsAndMatches(root: string, contentHash: ArtifactHash): Promise<boolean>;
