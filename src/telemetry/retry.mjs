import { recordUsageObservation, validateMeteredAttempt } from "../contracts/metering.mjs";
import { types as utilTypes } from "node:util";
import { snapshotBoundedPlainJson } from "../contracts/plain-json.mjs";
import { assertSafePublicIdentifier, containsSensitivePublicText, isSensitivePublicField, projectPublicTelemetry } from "./privacy.mjs";
import { TelemetryBoundaryError } from "./evidence.mjs";

const MAX_BATCH = 32;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateOutbox(outbox) {
  if (!isRecord(outbox) || typeof outbox.claimPending !== "function" ||
    typeof outbox.acknowledge !== "function" || typeof outbox.defer !== "function") {
    throw new TelemetryBoundaryError("observation_outbox_unavailable");
  }
}

function validateEvidenceOutbox(outbox) {
  if (!isRecord(outbox) || typeof outbox.claimPendingEvidence !== "function" ||
    typeof outbox.acknowledgeEvidence !== "function" || typeof outbox.deferEvidence !== "function") {
    throw new TelemetryBoundaryError("evidence_outbox_unavailable");
  }
}

function validateBatch(value, limit) {
  if (!isRecord(value) || value.status !== "claimed" || !Array.isArray(value.records) || value.records.length > limit) {
    throw new TelemetryBoundaryError("invalid_observation_batch");
  }
  const references = new Set();
  const claimTokens = new Set();
  const snapshots = [];
  for (const record of value.records) {
    if (!isRecord(record) || !isRecord(record.attempt) || !isRecord(record.observation) ||
      typeof record.record_ref !== "string" || typeof record.claim_token !== "string") {
      throw new TelemetryBoundaryError("invalid_observation_record");
    }
    try {
      assertSafePublicIdentifier(record.record_ref, { maxLength: 256 });
      assertSafePublicIdentifier(record.claim_token, { maxLength: 256 });
    } catch {
      throw new TelemetryBoundaryError("invalid_observation_record");
    }
    if (references.has(record.record_ref)) throw new TelemetryBoundaryError("duplicate_outbox_reference");
    if (claimTokens.has(record.claim_token)) throw new TelemetryBoundaryError("duplicate_outbox_claim_token");
    references.add(record.record_ref);
    claimTokens.add(record.claim_token);
    try {
      snapshots.push(structuredClone(record));
    } catch {
      throw new TelemetryBoundaryError("invalid_observation_record");
    }
  }
  return snapshots;
}

function validatePublicObservationIdentity(attempt, observation, scope) {
  try {
    for (const value of [scope.tenant_id, scope.project_id, scope.budget_scope_id,
      attempt.logical_operation_id, attempt.billable_attempt_id,
      attempt.provider.name, attempt.provider.model,
      observation.source_observation_id, observation.provider_name, observation.model,
      observation.provider_request_id, observation.transport_attempt_id, observation.rate_card_ref,
      observation.valuation?.rate_card_ref]) {
      if (value !== undefined) assertSafePublicIdentifier(value, { maxLength: 256 });
    }
    for (const field of observation.missing_fields ?? []) {
      if (containsSensitivePublicText(field) || isSensitivePublicField(field)) throw new Error("unsafe field");
    }
    for (const unit of observation.usage_units ?? []) {
      assertSafePublicIdentifier(unit.name, { maxLength: 256 });
      if (unit.included_in !== undefined) assertSafePublicIdentifier(unit.included_in, { maxLength: 256 });
    }
  } catch {
    throw new TelemetryBoundaryError("unsafe_observation_identity");
  }
}

async function defer(outbox, recordRef, claimToken, reason) {
  try {
    const result = await outbox.defer({ record_ref: recordRef, claim_token: claimToken, reason });
    return isRecord(result) && ["retained", "lease_lost"].includes(result.status);
  } catch {
    return false;
  }
}

async function deferEvidence(outbox, eventId, claimToken, reason) {
  try {
    const result = await outbox.deferEvidence({ event_id: eventId, claim_token: claimToken, reason });
    return isRecord(result) && ["retained", "lease_lost"].includes(result.status);
  } catch {
    return false;
  }
}

function validateEvidenceBatch(value, limit) {
  // Inspect only own data descriptors, then snapshot every record before the
  // first sink await. Keep the outbox's per-event bound rather than imposing a
  // smaller aggregate limit on a valid batch of up to MAX_BATCH events.
  let inputs;
  try {
    if (!isRecord(value) || utilTypes.isProxy(value)) throw new Error();
    const status = Object.getOwnPropertyDescriptor(value, "status");
    const records = Object.getOwnPropertyDescriptor(value, "records");
    if (!status || !Object.hasOwn(status, "value") || status.value !== "claimed" ||
      !records || !Object.hasOwn(records, "value") || !Array.isArray(records.value) || utilTypes.isProxy(records.value)) throw new Error();
    const length = Object.getOwnPropertyDescriptor(records.value, "length").value;
    if (!Number.isSafeInteger(length) || length < 0 || length > limit) throw new Error();
    inputs = [];
    for (let index = 0; index < length; index += 1) {
      const item = Object.getOwnPropertyDescriptor(records.value, String(index));
      if (!item || !Object.hasOwn(item, "value")) throw new Error();
      inputs.push(item.value);
    }
  } catch {
    throw new TelemetryBoundaryError("invalid_evidence_batch");
  }
  const eventIds = new Set();
  const references = new Set();
  const claimTokens = new Set();
  const snapshots = [];
  for (const input of inputs) {
    let record;
    try {
      record = snapshotBoundedPlainJson(input, { maxStringLength: 128 * 1024, maxKeyLength: 128 * 1024 });
    } catch {
      throw new TelemetryBoundaryError("invalid_evidence_record");
    }
    if (!isRecord(record) || !isRecord(record.event)) {
      throw new TelemetryBoundaryError("invalid_evidence_record");
    }
    try {
      assertSafePublicIdentifier(record.event.event_id, { maxLength: 256 });
      assertSafePublicIdentifier(record.record_ref, { maxLength: 256 });
      assertSafePublicIdentifier(record.claim_token, { maxLength: 256 });
      const projected = projectPublicTelemetry(record.event, { maxDepth: 24, maxNodes: 8192, maxBytes: 128 * 1024 });
      if (projected.redactions.length !== 0) throw new Error();
    } catch {
      throw new TelemetryBoundaryError("invalid_evidence_record");
    }
    if (eventIds.has(record.event.event_id)) throw new TelemetryBoundaryError("duplicate_evidence_record");
    if (references.has(record.record_ref)) throw new TelemetryBoundaryError("duplicate_evidence_reference");
    if (claimTokens.has(record.claim_token)) throw new TelemetryBoundaryError("duplicate_evidence_claim_token");
    eventIds.add(record.event.event_id);
    references.add(record.record_ref);
    claimTokens.add(record.claim_token);
    snapshots.push(record);
  }
  return Object.freeze(snapshots);
}

/** Deliver already committed evidence through an explicit record/ack port.
 * Generic SDK flush/HTTP success is not an acknowledgement for this boundary. */
export async function deliverPendingTelemetryEvidence({ outbox, sink, limit = 16 }) {
  validateEvidenceOutbox(outbox);
  if (!isRecord(sink) || typeof sink.record !== "function" ||
    !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BATCH) {
    throw new TelemetryBoundaryError("invalid_evidence_retry_request");
  }
  let claimed;
  try {
    claimed = await outbox.claimPendingEvidence({ limit });
  } catch {
    return Object.freeze({ status: "outbox_unavailable", attempted: 0, acknowledged: 0, retained: 0 });
  }
  const records = validateEvidenceBatch(claimed, limit);
  let acknowledged = 0;
  let retained = 0;
  for (const claimedRecord of records) {
    const eventId = claimedRecord.event.event_id;
    const claimToken = claimedRecord.claim_token;
    let response;
    try {
      response = await sink.record(structuredClone(claimedRecord.event));
    } catch {
      await deferEvidence(outbox, eventId, claimToken, "sink_unavailable");
      retained += 1;
      continue;
    }
    if (!isRecord(response) || !["accepted", "duplicate"].includes(response.status) || response.event_id !== eventId) {
      await deferEvidence(outbox, eventId, claimToken,
        response === undefined ? "acknowledgement_unknown" : "sink_acknowledgement_invalid");
      retained += 1;
      continue;
    }
    try {
      const persisted = await outbox.acknowledgeEvidence({ event_id: eventId, claim_token: claimToken });
      if (!isRecord(persisted) || persisted.status !== "acknowledged" || persisted.event_id !== eventId) {
        await deferEvidence(outbox, eventId, claimToken, "acknowledgement_unknown");
        retained += 1;
        continue;
      }
      acknowledged += 1;
    } catch {
      await deferEvidence(outbox, eventId, claimToken, "acknowledgement_unknown");
      retained += 1;
    }
  }
  return Object.freeze({ status: retained === 0 ? "complete" : "pending",
    attempted: records.length, acknowledged, retained });
}

/**
 * Deliver one bounded batch of already-persisted C03 usage observations. This
 * function never calls a provider or allocates a new billable attempt.
 */
export async function deliverPendingUsageObservations({
  meteringPort,
  outbox,
  trustedScopeForRecord,
  limit = 16,
}) {
  validateOutbox(outbox);
  if (typeof trustedScopeForRecord !== "function" || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BATCH) {
    throw new TelemetryBoundaryError("invalid_observation_retry_request");
  }
  let claimed;
  try {
    claimed = await outbox.claimPending({ limit });
  } catch {
    return Object.freeze({ status: "outbox_unavailable", attempted: 0, acknowledged: 0, retained: 0 });
  }
  const records = validateBatch(claimed, limit);
  let acknowledged = 0;
  let retained = 0;
  for (const pending of records) {
    const recordRef = pending.record_ref;
    const claimToken = pending.claim_token;
    let attempt;
    let scope;
    let observationId;
    try {
      scope = await trustedScopeForRecord(Object.freeze({ record_ref: recordRef }));
      if (!isRecord(scope)) throw new Error("scope");
      attempt = validateMeteredAttempt(pending.attempt, scope);
      observationId = assertSafePublicIdentifier(pending.observation.source_observation_id, { maxLength: 256 });
      validatePublicObservationIdentity(attempt, pending.observation, scope);
    } catch {
      await defer(outbox, recordRef, claimToken, "trusted_scope_or_record_unavailable");
      retained += 1;
      continue;
    }

    let authorityAck;
    try {
      authorityAck = await recordUsageObservation({
        port: meteringPort,
        attempt,
        trustedScope: scope,
        observation: pending.observation,
      });
    } catch {
      await defer(outbox, recordRef, claimToken, "metering_observation_unconfirmed");
      retained += 1;
      continue;
    }
    if (authorityAck.source_observation_id !== observationId ||
      authorityAck.effective_billable_attempt_id !== attempt.billable_attempt_id) {
      await defer(outbox, recordRef, claimToken, "metering_acknowledgement_mismatch");
      retained += 1;
      continue;
    }

    try {
      const persistedAck = await outbox.acknowledge({
        record_ref: recordRef,
        claim_token: claimToken,
        source_observation_id: observationId,
        effective_billable_attempt_id: attempt.billable_attempt_id,
        authority_status: authorityAck.status,
      });
      if (!isRecord(persistedAck) || persistedAck.status !== "acknowledged" ||
        persistedAck.source_observation_id !== observationId) {
        await defer(outbox, recordRef, claimToken, "outbox_acknowledgement_unconfirmed");
        retained += 1;
        continue;
      }
      acknowledged += 1;
    } catch {
      // Authority ack has already been confirmed. Replaying the same source ID is
      // safe because C03 receives an idempotent recordUsageObservation call.
      await defer(outbox, recordRef, claimToken, "outbox_acknowledgement_unconfirmed");
      retained += 1;
    }
  }
  return Object.freeze({
    status: retained === 0 ? "complete" : "pending",
    attempted: records.length,
    acknowledged,
    retained,
  });
}
