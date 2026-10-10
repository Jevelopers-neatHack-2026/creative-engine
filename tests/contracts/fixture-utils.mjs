import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export async function fixture(relativePath) {
  const path = new URL("../../fixtures/contracts/" + relativePath, import.meta.url);
  return JSON.parse(await readFile(fileURLToPath(path), "utf8"));
}

export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
