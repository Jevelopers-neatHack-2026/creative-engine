import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const contractsRoot = path.join(root, "src", "contracts");

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(absolute) : [absolute];
  }));
  return nested.flat();
}

test("contract modules are dependency-free, acyclic, and contain no provider transport", async () => {
  const modules = (await listFiles(contractsRoot)).filter((file) => file.endsWith(".mjs"));
  const graph = new Map();
  for (const file of modules) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(source, /\bfetch\s*\(|https?\.request\s*\(|new\s+WebSocket\s*\(/);
    const imports = [...source.matchAll(/(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g)]
      .map((match) => match[1]);
    for (const specifier of imports) {
      assert.ok(specifier.startsWith("node:") || specifier.startsWith("."), path.basename(file) + " imports non-neutral " + specifier);
    }
    graph.set(file, imports.filter((specifier) => specifier.startsWith("."))
      .map((specifier) => path.resolve(path.dirname(file), specifier)));
  }

  const visiting = new Set();
  const visited = new Set();
  function visit(file) {
    if (visiting.has(file)) throw new Error("contract dependency cycle at " + path.relative(root, file));
    if (visited.has(file)) return;
    visiting.add(file);
    for (const dependency of graph.get(file) ?? []) visit(dependency);
    visiting.delete(file);
    visited.add(file);
  }
  for (const file of modules) visit(file);

  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.deepEqual(pkg.dependencies ?? {}, {});
  assert.deepEqual(pkg.devDependencies ?? {}, {});
});

test("offline mock checks fail closed when live mode is requested", () => {
  let stdout = "";
  let stderr = "";
  try {
    execFileSync("make", ["check", "TARGET=contracts", "MODE=live"], { cwd: root, encoding: "utf8" });
  } catch (error) {
    stdout = error.stdout ?? "";
    stderr = error.stderr ?? "";
    assert.equal(error.status, 2);
  }
  assert.match(stdout + stderr, /only offline mock checks are implemented/);
  assert.match(stdout + stderr, /no live provider dispatch exists/);
});
