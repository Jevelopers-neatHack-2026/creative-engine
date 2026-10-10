import { Buffer } from "node:buffer";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalHash,
  computeDesignVersionHash,
  validateCreativeBrief,
} from "../../src/contracts/index.mjs";
import { hashArtifactBytes } from "../../src/storage/content-addressed.mjs";
import { CreativeVersionStore } from "../../src/versions/store.mjs";

const briefFixture = JSON.parse(await readFile(new URL("../../fixtures/contracts/creative/creative-brief.json", import.meta.url), "utf8"));
const designFixture = JSON.parse(await readFile(new URL("../../fixtures/contracts/creative/design-version-base.json", import.meta.url), "utf8"));

export const DEFAULT_SCOPE = Object.freeze({ tenant_id: "tenant-1", project_id: "project-1", brief_id: "brief-1" });

export async function createStore(t, { now = () => Date.parse("2026-10-10T12:30:00.000Z"), ...options } = {}) {
  const root = await mkdtemp(join(tmpdir(), "creative-versions-test-"));
  const store = new CreativeVersionStore({
    databasePath: join(root, "versions.sqlite"),
    objectRoot: join(root, "objects"),
    now,
    ...options,
  });
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, store };
}

export function createBrief(scope = DEFAULT_SCOPE) {
  const candidate = structuredClone(briefFixture);
  candidate.tenant_id = scope.tenant_id;
  candidate.project_id = scope.project_id;
  candidate.brief_id = scope.brief_id;
  return validateCreativeBrief(candidate, { trustedScope: scope });
}

export function createVersion({
  scope = DEFAULT_SCOPE,
  brief = createBrief(scope),
  id = "design-v1",
  parent = null,
  bytes = Buffer.from(`synthetic artifact ${id}`),
  occurred_at = "2026-10-10T12:10:00.000Z",
  extra = {},
} = {}) {
  const candidate = {
    ...structuredClone(designFixture),
    ...structuredClone(extra),
    event_id: `event-${id}`,
    tenant_id: scope.tenant_id,
    project_id: scope.project_id,
    correlation_id: `journey-${scope.brief_id}`,
    occurred_at,
    ingested_at: occurred_at,
    design_version_id: id,
    parent_version_id: parent?.design_version_id ?? null,
    brief_hash: canonicalHash(brief),
    source_refs: brief.source_identity.map((source) => source.source_id),
    artifact: {
      artifact_id: `artifact-${id}`,
      content_hash: hashArtifactBytes(bytes),
      media_type: "image/png",
    },
  };
  candidate.design_hash = computeDesignVersionHash(candidate);
  return { design_version: candidate, artifact_bytes: Uint8Array.from(bytes), brief_snapshot: brief };
}

export function createWrite({
  scope = DEFAULT_SCOPE,
  id = "design-v1",
  parent = null,
  selection,
  action_id = `action-${id}`,
  job_id = `job-${id}`,
  actor_id = "actor-1",
  bytes,
  occurred_at,
  extra,
} = {}) {
  const brief = createBrief(scope);
  const { design_version, artifact_bytes, brief_snapshot } = createVersion({
    scope, brief, id, parent, bytes, occurred_at, extra,
  });
  return {
    scope,
    brief_id: scope.brief_id,
    actor_id,
    brief_snapshot,
    design_version,
    artifact_bytes,
    selection: selection ?? (parent ? {
      mode: "advance",
      expected_revision: 1,
      expected_selected_design_version_id: parent.design_version_id,
      expected_selected_design_hash: parent.design_hash,
    } : {
      mode: "advance",
      expected_revision: 0,
      expected_selected_design_version_id: null,
      expected_selected_design_hash: null,
    }),
    creation: {
      job_id,
      action_id,
      actor_id,
      request_hash: canonicalHash({ action_id, design_version_id: id, brief_id: scope.brief_id }),
      logical_operation_id: `logical-${id}`,
      billable_attempt_id: `billable-${id}`,
      ...(parent ? { parent_design_hash: parent.design_hash } : {}),
      transport_attempt_ids: [`transport-${id}`],
      provider_request_ids: [`provider-${id}`],
      usage_refs: [`usage-${id}`],
      trace_refs: [`trace-${id}`],
    },
    configuration_snapshot: { renderer: "fixture-renderer", schema_version: "1" },
  };
}

export function cloneWrite(input, overrides = {}) {
  const copy = structuredClone(input);
  return { ...copy, ...structuredClone(overrides) };
}
