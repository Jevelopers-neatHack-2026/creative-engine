import test from 'node:test';
import assert from 'node:assert/strict';
import * as preflight from 'creative-engine/preflight';

test('public preflight package subpath exposes the runtime and fixed matrix', () => {
  assert.equal(preflight.ACCESS_PREFLIGHT_VERSION, 'creative.access-preflight.proposal/v1');
  assert.equal(preflight.ACCESS_CELL_DEFINITIONS.length, 8);
  assert.equal(typeof preflight.validateAccessPlan, 'function');
  assert.equal(typeof preflight.runAccessPreflight, 'function');
  assert.equal(typeof preflight.createOpenAIImagesAdapter, 'function');
});
