/** Reproducible offline checks and sanitized evidence. Never loads provider clients. */
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { action, fixtureState } from './state.mjs';
import { hash } from '../../src/controls/actions.mjs';
import { createControlSchema } from '../../src/controls/schema.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
const fixtureDir = join(root, 'examples/frontend-action-roundtrip');
const args = process.argv.slice(2), runBrowser = args.includes('--browser');
const output = args.includes('--out') ? args[args.indexOf('--out') + 1] : undefined;
const results = [];
function run(command, argv, cwd, label, env = {}) {
  // Keep Playwright's `node server.mjs` and its workers on this evaluated runtime.
  const result = spawnSync(command, argv, { cwd, encoding: 'utf8', env: {
    ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`, ...env } });
  process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
  results.push({ command: label, exit_code: result.status, passed: result.status === 0 });
}
run(process.execPath, ['--test', 'tests/controls/actions.test.mjs'], root, 'node --test tests/controls/actions.test.mjs');
if (runBrowser || args.includes('--types')) run(process.execPath, ['node_modules/typescript/bin/tsc', '-p', '../../tests/controls/types/tsconfig.json'],
  fixtureDir, 'tsc --strict --module NodeNext (public ESM consumer)');
if (runBrowser) run(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', '--reporter=list,json'], fixtureDir,
  'npm test (Playwright Chromium + axe)', { PLAYWRIGHT_JSON_OUTPUT_FILE: join(fixtureDir, 'test-results/browser-results.json') });
const digest = createHash('sha256');
const sourceFiles = [];
for (const dir of ['src/controls', 'tests/controls', 'examples/frontend-action-roundtrip', 'fixtures/controls']) {
  function walk(path) {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (['node_modules', 'test-results', 'playwright-report'].includes(entry.name) || /^evidence-.*\.json$/.test(entry.name)) continue;
      const name = join(path, entry.name);
      if (entry.isDirectory()) walk(name);
      else { const rel = relative(root, name); sourceFiles.push(rel); digest.update(rel); digest.update(readFileSync(name)); }
    }
  }
  walk(join(root, dir));
}
for (const rel of ['.github/workflows/controls.yml', 'docs/controls-integration.md']) {
  sourceFiles.push(rel); digest.update(rel); digest.update(readFileSync(join(root, rel)));
}
const state = fixtureState();
const evidence = { evidence_version: 'controls-offline-evidence/1.0', dependency_mode: 'mock', billing_mode: 'simulated',
  runtime: process.version, platform: process.platform, architecture: process.arch, host_validation: 'local_only',
  schema_version: 'creative-controls/1.1', action_version: 'creative-apply/1.1',
  contract_status: 'local-consumer-proposal', source_fingerprint_sha256: digest.digest('hex'), source_files: sourceFiles,
  fixture_schema_sha256: hash(createControlSchema(state)), fixture_action_sha256: hash(action(state)),
  checks: results, browser_exercised: runBrowser && results.find(r => r.command === 'npm test (Playwright Chromium + axe)')?.passed === true,
  types_checked: results.find(r => r.command === 'tsc --strict --module NodeNext (public ESM consumer)')?.passed === true,
  calls: { jev: 0, image: 0 }, approval_created: false, purchase_created: false,
  pending: ['canonical external schema publication and consumer acknowledgement', 'CE-01 API integration',
    'CE-02 actual versioned brief integration', 'CE-08 actual version store integration', 'application authentication/authorization',
    'harness outbox consumer and paid artwork dispatch', 'live providers and external release acceptance',
    'CloudLinux/CageFS x86_64 host validation (exact Node 22 patch unknown)'],
  passed: results.every(r => r.passed) };
if (output) {
  const path = join(root, output);
  mkdirSync(dirname(path), { recursive: true });
  // Explicit LF byte keeps the artifact unambiguous when copied through clients
  // that escape source text. Verify the actual emitted file, not an in-memory copy.
  writeFileSync(path, Buffer.concat([Buffer.from(JSON.stringify(evidence, null, 2), 'utf8'), Buffer.from([0x0a])]));
  const emitted = readFileSync(path);
  assert.equal(emitted.at(-1), 0x0a, 'Evidence must end with a newline byte');
  assert.deepEqual(JSON.parse(emitted.toString('utf8')), evidence, 'Emitted evidence must parse and preserve the measured result');
}
console.log(JSON.stringify(evidence, null, 2));
if (!evidence.passed) process.exitCode = 1;
