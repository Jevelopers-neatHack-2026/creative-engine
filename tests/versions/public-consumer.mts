import { createCreativeApi } from "../../src/api/v1.mjs";
import { createCreativeVersionApiPorts, CreativeVersionStore, VersionStoreError } from "../../src/versions/index.mjs";
import { hashArtifactBytes, writeContentAddressedObject } from "../../src/storage/content-addressed.mjs";
import type { CreativeApiRequest, TrustedCreativeActor } from "../../src/api/v1.mjs";
import type { DesignSelection } from "../../src/api/v1.mjs";

const store = new CreativeVersionStore({ databasePath: "/tmp/creative-versions.sqlite", objectRoot: "/tmp/creative-objects" });
const paired = createCreativeVersionApiPorts({ store, idFactory: () => "public-consumer-id" });
const api = createCreativeApi({ ports: paired.ports });
const actor: TrustedCreativeActor = {
  actor_id: "actor-public", tenant_id: "tenant-public", project_id: "project-public",
  expires_at: "2026-10-11T00:00:00.000Z", permissions: ["creative.read"],
  budget_scope_id: "budget-public", budget_policy_version: "budget/1",
};
const request: CreativeApiRequest = {
  contract: "CreativeApiRequest", schema_version: "1.0", event_id: "event-public", request_id: "request-public",
  tenant_id: "tenant-public", project_id: "project-public", correlation_id: "correlation-public",
  producer: "public-consumer", occurred_at: "2026-10-10T12:00:00.000Z", ingested_at: "2026-10-10T12:00:00.000Z",
  environment: "test", billing_mode: "simulated", source_refs: [], operation: "job.status", payload: { job_id: "job-public" },
};
void api.invoke(actor, request);
void hashArtifactBytes(new Uint8Array([1]));
void writeContentAddressedObject("/tmp/creative-objects", new Uint8Array([1]), `sha256:${"0".repeat(64)}`);
const publicError = new VersionStoreError("unavailable", "handoff.durable_result_staging", true);
const readSelection = (selection: DesignSelection) => selection.design_hash;
void readSelection;
void publicError;

// Internal transaction minting must not be part of the public declaration.
// @ts-expect-error publication transactions are created only by the paired adapter
store.createPublicationTransaction({});

// Unknown adapter options remain rejected by the public type surface.
// @ts-expect-error lease duration is bounded by the durable adapter contract
createCreativeVersionApiPorts({ store, inMemoryOnly: true });
