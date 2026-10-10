import { createCreativeApi } from "../../src/api/v1.mjs";
import { createCreativeVersionApiPorts } from "../../src/versions/api-ports.mjs";
import { CreativeVersionStore } from "../../src/versions/store.mjs";
import { completeResearchPackage } from "./research-packages.mjs";

const databasePath = process.argv[2];
const objectRoot = process.argv[3];
if (!databasePath || !objectRoot) process.exit(70);

const now = Date.parse("2026-10-10T12:30:00.000Z");
const nowIso = new Date(now).toISOString();
const scope = Object.freeze({ tenant_id: "tenant-brief-api", project_id: "project-brief-api" });
const research = { ...completeResearchPackage(), ...scope };
const store = new CreativeVersionStore({ databasePath, objectRoot, now: () => now });
let id = 0;
const eventId = "child-crash-revocation";
let event;
const adapted = createCreativeVersionApiPorts({ store, idFactory: () => `child-fixture-${++id}`, otherPorts: {
  planning: {
    async getCurrentResearchPackage() { return research; },
    async getInvalidationEvent() { return event; },
    invalidationVerifier: {
      async verifyInvalidation({ event: normalized, trusted_scope }) {
        return { status: "verified", classification: "synthetic_test", evidence_ref: "synthetic:crash-fixture",
          event_hash: normalized.content_hash, event_id: normalized.event_id,
          tenant_id: trusted_scope.tenant_id, project_id: trusted_scope.project_id,
          verified_at: nowIso, valid_until: "2026-10-10T12:31:00.000Z" };
      },
    },
    approvalStaleness: {
      async markBriefStale() {
        const briefId = store.db.prepare(`SELECT brief_id FROM creative_briefs
          WHERE tenant_id=? AND project_id=?`).get(scope.tenant_id, scope.project_id).brief_id;
        const brief = store.getBrief({ scope, brief_id: briefId });
        const fenced = store.planningStore(scope).isPackageFenced(scope.tenant_id, scope.project_id,
          brief.research_package_ref.package_id, brief.research_package_ref.content_hash);
        if (store.db.isTransaction || !fenced) process.exit(72);
        // Simulate an abrupt worker death after the local fence commits and
        // before the application acknowledgment is stored.
        process.exit(71);
      },
    },
    producerAcknowledgment: {
      async acknowledgeInvalidation() { process.exit(73); },
    },
  },
} });
const api = createCreativeApi({ ports: adapted.ports, now: () => now, idFactory: () => `child-api-${++id}` });
const actor = { actor_id: "actor-brief-api", ...scope, expires_at: "2026-10-11T00:00:00.000Z",
  permissions: ["creative.brief.create", "creative.brief.invalidate"], budget_scope_id: "budget-brief-api",
  budget_policy_version: "budget-policy/fixture-1" };
function request(operation, action_id, payload) {
  return { contract: "CreativeApiRequest", schema_version: "1.0", event_id: `event:${action_id}`,
    request_id: `request:${action_id}`, ...scope, correlation_id: `correlation:${action_id}`,
    producer: "brief-api-crash-fixture", occurred_at: "2026-10-10T12:20:00.000Z",
    ingested_at: "2026-10-10T12:20:00.000Z", environment: "test", billing_mode: "simulated",
    source_refs: [], operation, action_id, payload };
}

const created = await api.invoke(actor, request("brief.create", "brief-before-hard-exit", {}));
if (!created.ok) process.exit(74);
const brief = created.result.brief;
event = {
  event_id: eventId,
  tenant_id: scope.tenant_id,
  project_id: scope.project_id,
  source_package_id: brief.research_package_ref.package_id,
  source_package_hash: brief.research_package_ref.content_hash,
  source_revision: 2,
  occurred_at: "2026-10-10T12:29:00.000Z",
  kind: "asset",
  reason: "asset_permission_revoked",
  assets: [{ asset_id: "asset-1", content_hash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }],
  affected_briefs: [{ brief_id: brief.brief_id, brief_hash: created.result.brief_hash }],
};
await api.invoke(actor, request("brief.invalidate", "invalidation-hard-exit", { event_id: eventId }));
process.exit(75);
