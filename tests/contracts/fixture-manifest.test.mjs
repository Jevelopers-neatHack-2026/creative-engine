import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const manifestPath = path.join(root, "fixtures", "contracts", "manifest.json");

function sha256(bytes) {
  return "sha256:" + createHash("sha256").update(bytes).digest("hex");
}

async function listJsonFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? listJsonFiles(absolute) : [absolute];
  }));
  return nested.flat().filter((file) => file.endsWith(".json"));
}

test("fixture and schema proposal hashes match the checked manifest", async () => {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const proposalPath = path.join(root, manifest.schema_proposal.path);
  assert.equal(sha256(await readFile(proposalPath)), manifest.schema_proposal.sha256);

  const fixturePaths = Object.keys(manifest.fixtures).sort();
  const actualPaths = (await listJsonFiles(path.join(root, "fixtures", "contracts")))
    .filter((file) => file !== manifestPath)
    .map((file) => path.relative(root, file).split(path.sep).join("/"))
    .sort();
  assert.deepEqual(fixturePaths, actualPaths);
  for (const [relativePath, expectedHash] of Object.entries(manifest.fixtures)) {
    assert.equal(sha256(await readFile(path.join(root, relativePath))), expectedHash, relativePath);
  }
});
