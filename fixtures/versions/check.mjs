import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const mode = process.env.MODE ?? process.argv[2] ?? "mock";
if (mode !== "mock") {
  process.stderr.write(`MODE=${mode} is unavailable: versions checks are offline and do not dispatch providers.\n`);
  process.exit(2);
}

const tsc = fileURLToPath(new URL("../../examples/frontend-action-roundtrip/node_modules/typescript/bin/tsc", import.meta.url));
if (!existsSync(tsc)) {
  process.stderr.write("TypeScript 5.9.3 is missing; run the offline repository bootstrap first.\n");
  process.exit(2);
}
process.stdout.write(`versions check: Node ${process.version}; mode=mock; TypeScript `);
const version = spawnSync(process.execPath, [tsc, "--version"], { encoding: "utf8", env: process.env });
if (version.error || version.status !== 0) throw version.error ?? new Error("TypeScript version probe failed");
process.stdout.write(version.stdout.trim().replace(/^Version\s+/, "") + "\n");

const test = spawnSync(process.execPath, ["--test", "tests/versions/api-integration.test.mjs", "tests/versions/store.test.mjs",
  "tests/api/creative-api.test.mjs"], { stdio: "inherit", env: process.env });
if (test.error) throw test.error;
if (test.status !== 0) process.exit(test.status ?? 2);

const types = spawnSync(process.execPath, [tsc, "--noEmit", "--strict", "--skipLibCheck", "false", "--module", "NodeNext",
  "--moduleResolution", "NodeNext", "--target", "ES2022", "tests/versions/public-consumer.mts"],
{ stdio: "inherit", env: process.env });
if (types.error) throw types.error;
process.exit(types.status ?? 2);
