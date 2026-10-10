import assert from "node:assert/strict";
import test from "node:test";
import {
  CREATIVE_TELEMETRY_SCHEMA,
  createSqliteTelemetryOutbox,
  createUsageObservation,
  deliverPendingTelemetryEvidence,
  executeCreativeMeteredAttempt,
} from "creative-engine/telemetry";

test("public telemetry package subpath resolves the versioned runtime exports", () => {
  assert.equal(CREATIVE_TELEMETRY_SCHEMA, "creative.telemetry.evidence/v1");
  assert.equal(typeof createSqliteTelemetryOutbox, "function");
  assert.equal(typeof createUsageObservation, "function");
  assert.equal(typeof deliverPendingTelemetryEvidence, "function");
  assert.equal(typeof executeCreativeMeteredAttempt, "function");
});
