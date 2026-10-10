import { createCreativeApi } from "creative-engine/api/v1";
import { createCreativeVersionApiPorts, CreativeVersionStore, VersionStoreError } from "creative-engine/versions";
import type { CreativeApiRequest, TrustedCreativeActor, DesignSelection } from "creative-engine/api/v1";
import type { VersionScope, VersionSelectionInput } from "creative-engine/versions";

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
const publicError = new VersionStoreError("unavailable", "handoff.durable_result_staging", true);
const readSelection = (selection: DesignSelection) => selection.design_hash;
void readSelection;
void publicError;
const scope: VersionScope = { tenant_id: "tenant-public", project_id: "project-public", brief_id: "brief-public" };
const selection: VersionSelectionInput = { mode: "advance", expected_revision: 0,
  expected_selected_design_version_id: null, expected_selected_design_hash: null };
void scope;
void selection;

// Internal transaction minting must not be part of the public declaration.
// @ts-expect-error publication transactions are created only by the paired adapter
store.createPublicationTransaction({});

// Unknown adapter options remain rejected by the public type surface.
// @ts-expect-error lease duration is bounded by the durable adapter contract
createCreativeVersionApiPorts({ store, inMemoryOnly: true });
