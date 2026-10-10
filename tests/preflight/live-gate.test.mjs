import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

test('live access gate emits explicit blocked cells and exits before dispatch', () => {
  const result = spawnSync(process.execPath, ['scripts/access-preflight-check.mjs', '--mode', 'live'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  assert.equal(result.status, 2, result.stderr);
  const gate = JSON.parse(result.stdout);
  assert.equal(gate.target, 'CE-A01');
  assert.equal(gate.mode, 'live');
  assert.equal(gate.status, 'blocked');
  assert.equal(gate.acceptance_allowed, false);
  assert.equal(gate.required_cell_count, 8);
  assert.equal(gate.verified_cell_count, 0);
  assert.equal(gate.provider_dispatches, 0);
  assert.equal(gate.paid_provider_calls, 0);
  assert.equal(gate.provider_credentials_read, false);
  assert.deepEqual(gate.cells.map((cell) => cell.status), Array(8).fill('blocked'));
  assert.ok(gate.missing_owner_evidence.includes('openai_generation_account_permission_and_quota'));
  assert.ok(gate.missing_owner_evidence.includes('openai_edit_account_permission_and_quota'));
  assert.ok(gate.missing_owner_evidence.includes('external_grant_and_finance_reservation'));
  assert.ok(gate.missing_owner_evidence.includes('accepted_neatlogs_readback_protocol_and_receipt'));
  assert.doesNotMatch(result.stdout, /Bearer\s|sk-[A-Za-z0-9_-]{8,}|@[A-Za-z0-9.-]+\.[A-Z]{2,}/i);
});

test('mock runtime evidence preserves the matrix and identifies synthetic dispatches without claiming acceptance', () => {
  const output = 'build/access-preflight-test-evidence.json';
  const result = spawnSync(process.execPath, ['scripts/access-preflight-check.mjs', '--mode', 'mock', '--out', output], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /8 cells, 2 synthetic adapter dispatches, acceptance pending/);
  const serialized = readFileSync(output, 'utf8');
  const evidence = JSON.parse(serialized);
  assert.equal(evidence.status, 'simulated_or_pending');
  assert.equal(evidence.mode, 'mock');
  assert.equal(evidence.acceptance_allowed, false);
  assert.equal(evidence.required_cell_count, 8);
  assert.equal(evidence.verified_cell_count, 0);
  assert.equal(evidence.paid_provider_calls, 0);
  assert.equal(evidence.provider_credentials_read, false);
  assert.equal(evidence.test_fixture_only.mock_adapter_dispatches, 2);
  assert.equal(evidence.test_fixture_only.actual_network_requests, 0);
  assert.equal(evidence.report.cells.length, 8);
  assert.equal(evidence.report.cells.find((cell) => cell.cell_id === 'image_generation').status, 'simulated');
  assert.equal(evidence.report.cells.find((cell) => cell.cell_id === 'image_edit').status, 'simulated');
  assert.equal(evidence.report.cells.find((cell) => cell.cell_id === 'harness_jev').status, 'blocked');
  assert.doesNotMatch(serialized, /Bearer\s|sk-[A-Za-z0-9_-]{8,}|@[A-Za-z0-9.-]+\.[A-Z]{2,}|signature=/i);
});
