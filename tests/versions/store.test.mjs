import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { fork, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { canonicalHash, canonicalSerialize, computeDesignVersionHash } from "../../src/contracts/index.mjs";
import { hashArtifactBytes, readContentAddressedObject, writeContentAddressedObject } from "../../src/storage/content-addressed.mjs";
import { CreativeVersionStore, VersionStoreError } from "../../src/versions/store.mjs";
import { createBrief, createStore, createWrite, DEFAULT_SCOPE } from "./helpers.mjs";
import * as publicVersions from "creative-engine/versions";

const CRASH_WORKER = new URL("../../fixtures/versions/crash-worker.mjs", import.meta.url);
const SELECTION_WORKER = new URL("../../fixtures/versions/selection-worker.mjs", import.meta.url);

function expectStoreError(code, operation) {
  assert.throws(operation, (error) => {
    assert.equal(error instanceof VersionStoreError, true, error?.constructor?.name);
    assert.equal(error.code, code);
    assert.equal(typeof error.message, "string");
    assert.equal(error.message.length < 160, true);
    assert.equal(error.message.includes("SYNTHETIC"), false);
    return true;
  });
}

test("versions public entrypoint exposes the runtime constructors and paired adapter", () => {
  assert.equal(typeof publicVersions.CreativeVersionStore, "function");
  assert.equal(typeof publicVersions.VersionStoreError, "function");
  assert.equal(typeof publicVersions.createCreativeVersionApiPorts, "function");
});

async function expectStoreReject(code, operation) {
  await assert.rejects(operation, (error) => {
    assert.equal(error instanceof VersionStoreError, true, error?.constructor?.name);
    assert.equal(error.code, code);
    assert.equal(error.message.length < 160, true);
    return true;
  });
}

test("durable root version preserves exact bytes, context, additive fields, and stable action replay across restart", async (t) => {
  let now = Date.parse("2026-10-10T12:30:00.000Z");
  const { root, store } = await createStore(t, { now: () => now });
  const input = createWrite({ id: "version-A", extra: { vendor_id: 42, render_ref: { revision: 2 }, optional_ref: null } });
  const saved = await store.saveDesignVersion(input);
  assert.equal(saved.status, "saved");
  assert.equal(saved.replayed, false);
  assert.equal(saved.design_version.design_hash, input.design_version.design_hash);
  assert.deepEqual(store.getSelection({ scope: DEFAULT_SCOPE, brief_id: DEFAULT_SCOPE.brief_id }), {
    tenant_id: DEFAULT_SCOPE.tenant_id,
    project_id: DEFAULT_SCOPE.project_id,
    brief_id: DEFAULT_SCOPE.brief_id,
    design_version_id: "version-A",
    design_hash: input.design_version.design_hash,
    revision: 1,
  });
  assert.deepEqual(await store.getArtifactBytes({ scope: DEFAULT_SCOPE, brief_id: DEFAULT_SCOPE.brief_id,
    design_version_id: "version-A" }), input.artifact_bytes);
  const evidence = store.db.prepare("SELECT evidence_json,context_json FROM version_evidence WHERE design_version_id=?")
    .get("version-A");
  const decodedEvidence = JSON.parse(evidence.evidence_json);
  const decodedContext = JSON.parse(evidence.context_json);
  assert.equal(decodedEvidence.creation.logical_operation_id, "logical-version-A");
  assert.equal(decodedEvidence.creation.billable_attempt_id, "billable-version-A");
  assert.deepEqual(decodedEvidence.creation.transport_attempt_ids, ["transport-version-A"]);
  assert.deepEqual(decodedEvidence.creation.provider_request_ids, ["provider-version-A"]);
  assert.deepEqual(decodedEvidence.usage_refs, ["usage-version-A"]);
  assert.deepEqual(decodedEvidence.trace_refs, ["trace-version-A"]);
  assert.equal(decodedContext.brief_hash, input.design_version.brief_hash);
  assert.equal(decodedContext.permission_hash.length, 71);
  assert.equal(decodedContext.lock_hash.length, 71);
  assert.equal(decodedContext.source_identity_hash.length, 71);

  now += 7 * 24 * 60 * 60 * 1000;
  const replay = await store.saveDesignVersion(input);
  assert.equal(replay.status, "saved");
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.design_version.artifact, input.design_version.artifact);
  assert.equal(replay.design_version.vendor_id, input.design_version.vendor_id);
  assert.deepEqual(replay.design_version.render_ref, input.design_version.render_ref);
  assert.deepEqual(replay.design_version.optional_ref, input.design_version.optional_ref);
  assert.equal(store.listDesignVersions({ scope: DEFAULT_SCOPE, brief_id: DEFAULT_SCOPE.brief_id, limit: 10 }).items.length, 1);

  store.close();
  const reopened = new CreativeVersionStore({ databasePath: join(root, "versions.sqlite"),
    objectRoot: join(root, "objects"), now: () => now });
  const recovery = await reopened.recover();
  assert.deepEqual(recovery, { examined: 0, committed: 0, conflicts: 0, unknown: 0 });
  const restored = reopened.getDesignVersion({ scope: DEFAULT_SCOPE, brief_id: DEFAULT_SCOPE.brief_id,
    design_version_id: "version-A" });
  assert.equal(restored.design_hash, input.design_version.design_hash);
  assert.equal(restored.vendor_id, 42);
  assert.deepEqual(restored.render_ref, { revision: 2 });
  assert.equal(restored.optional_ref, null);
  assert.deepEqual(await reopened.getArtifactBytes({ scope: DEFAULT_SCOPE, brief_id: DEFAULT_SCOPE.brief_id,
    design_version_id: "version-A" }), input.artifact_bytes);
  const replayAfterRestart = await reopened.saveDesignVersion(input);
  assert.equal(replayAfterRestart.replayed, true);
  reopened.close();
});

test("explicit branches retain A/B/C and restore changes only the selected pointer with CAS", async (t) => {
  const { store } = await createStore(t);
  store.putBrief({ scope: { tenant_id: DEFAULT_SCOPE.tenant_id, project_id: DEFAULT_SCOPE.project_id },
    brief: createBrief() });
  const aInput = createWrite({ id: "A" });
  const a = await store.saveDesignVersion(aInput);
  const bInput = createWrite({ id: "B", parent: a.design_version,
    selection: { mode: "branch" }, occurred_at: "2026-10-10T12:11:00.000Z" });
  const cInput = createWrite({ id: "C", parent: a.design_version,
    selection: { mode: "branch" }, occurred_at: "2026-10-10T12:12:00.000Z" });
  const [b, c] = await Promise.all([store.saveDesignVersion(bInput), store.saveDesignVersion(cInput)]);
  assert.equal(b.status, "saved");
  assert.equal(c.status, "saved");
  assert.equal(b.selection, null);
  assert.equal(c.selection, null);
  assert.equal(store.listDesignVersions({ scope: DEFAULT_SCOPE, brief_id: DEFAULT_SCOPE.brief_id, limit: 10 }).items.length, 3);
  assert.equal(store.getSelection({ scope: DEFAULT_SCOPE, brief_id: DEFAULT_SCOPE.brief_id }).design_version_id, "A");
  assert.equal(b.design_version.parent_version_id, "A");
  assert.equal(c.design_version.parent_version_id, "A");
  assert.notEqual(a.design_version.artifact.content_hash, b.design_version.artifact.content_hash);
  assert.notEqual(b.design_version.artifact.content_hash, c.design_version.artifact.content_hash);

  const selectB = await store.selectDesignVersion({ scope: DEFAULT_SCOPE, brief_id: DEFAULT_SCOPE.brief_id,
    design_version_id: "B", expected_brief_hash: a.design_version.brief_hash,
    expected_target_design_hash: b.design_version.design_hash,
    expected_selected_design_version_id: "A", expected_selected_design_hash: a.design_version.design_hash,
    expected_selection_revision: 1 });
  assert.equal(selectB.status, "selected");
  assert.equal(selectB.selection.revision, 2);
  const restoreA = await store.selectDesignVersion({ scope: DEFAULT_SCOPE, brief_id: DEFAULT_SCOPE.brief_id,
    design_version_id: "A", expected_brief_hash: a.design_version.brief_hash,
    expected_target_design_hash: a.design_version.design_hash,
    expected_selected_design_version_id: "B", expected_selected_design_hash: b.design_version.design_hash,
    expected_selection_revision: 2 });
  assert.equal(restoreA.status, "selected");
  assert.equal(restoreA.selection.design_version_id, "A");
  assert.equal(restoreA.selection.revision, 3);
  assert.equal(store.listDesignVersions({ scope: DEFAULT_SCOPE, brief_id: DEFAULT_SCOPE.brief_id, limit: 10 }).items.length, 3);
  assert.deepEqual(await store.getArtifactBytes({ scope: DEFAULT_SCOPE, brief_id: DEFAULT_SCOPE.brief_id,
    design_version_id: "A" }), aInput.artifact_bytes);
  assert.equal(store.getCurrentDesignVersion({ scope: DEFAULT_SCOPE, brief_id: DEFAULT_SCOPE.brief_id }).design_hash,
    a.design_version.design_hash);

  const [left, right] = await Promise.all([
    store.selectDesignVersion({ scope: DEFAULT_SCOPE, brief_id: DEFAULT_SCOPE.brief_id,
      design_version_id: "B", expected_brief_hash: a.design_version.brief_hash,
      expected_target_design_hash: b.design_version.design_hash,
      expected_selected_design_version_id: "A", expected_selected_design_hash: a.design_version.design_hash,
      expected_selection_revision: 3 }),
    store.selectDesignVersion({ scope: DEFAULT_SCOPE, brief_id: DEFAULT_SCOPE.brief_id,
      design_version_id: "C", expected_brief_hash: a.design_version.brief_hash,
      expected_target_design_hash: c.design_version.design_hash,
      expected_selected_design_version_id: "A", expected_selected_design_hash: a.design_version.design_hash,
      expected_selection_revision: 3 }),
  ]);
  assert.deepEqual([left.status, right.status].sort(), ["selected", "stale"]);
  const current = store.getSelection({ scope: DEFAULT_SCOPE, brief_id: DEFAULT_SCOPE.brief_id });
  assert.ok(["B", "C"].includes(current.design_version_id));
  assert.equal(current.revision, 4);
});

test("standalone restore rechecks the current brief inside selection CAS after artifact IO", async (t) => {
  const { store } = await createStore(t);
  const originalBrief = createBrief();
  store.putBrief({ scope: { tenant_id: DEFAULT_SCOPE.tenant_id, project_id: DEFAULT_SCOPE.project_id }, brief: originalBrief });
  const originalBriefHash = canonicalHash(originalBrief);
  const a = await store.saveDesignVersion(createWrite({ id: "restore-fence-A" }));
  const b = await store.saveDesignVersion(createWrite({ id: "restore-fence-B", parent: a.design_version,
    selection: { mode: "branch" } }));
  const selectedB = await store.selectDesignVersion({ scope: DEFAULT_SCOPE, brief_id: DEFAULT_SCOPE.brief_id,
    design_version_id: b.design_version.design_version_id, expected_brief_hash: originalBriefHash,
    expected_target_design_hash: b.design_version.design_hash,
    expected_selected_design_version_id: a.design_version.design_version_id,
    expected_selected_design_hash: a.design_version.design_hash, expected_selection_revision: 1 });
  assert.equal(selectedB.status, "selected");

  let entered;
  const readStarted = new Promise((resolve) => { entered = resolve; });
  let release;
  const readGate = new Promise((resolve) => { release = resolve; });
  const readBytes = store.getArtifactBytes.bind(store);
  store.getArtifactBytes = async (input) => {
    const bytes = await readBytes(input);
    entered();
    await readGate;
    return bytes;
  };
  const restoring = store.selectDesignVersion({ scope: DEFAULT_SCOPE, brief_id: DEFAULT_SCOPE.brief_id,
    design_version_id: a.design_version.design_version_id, expected_brief_hash: originalBriefHash,
    expected_target_design_hash: a.design_version.design_hash,
    expected_selected_design_version_id: b.design_version.design_version_id,
    expected_selected_design_hash: b.design_version.design_hash, expected_selection_revision: 2 });
  await readStarted;
  const updatedBrief = structuredClone(originalBrief);
  updatedBrief.facts.verified[0].value = "2027-05-19";
  assert.equal(store.putBrief({ scope: { tenant_id: DEFAULT_SCOPE.tenant_id, project_id: DEFAULT_SCOPE.project_id },
    brief: updatedBrief, expected_brief_hash: originalBriefHash }).status, "saved");
  release();

  assert.deepEqual(await restoring, { status: "stale" });
  assert.deepEqual(store.getSelection({ scope: DEFAULT_SCOPE, brief_id: DEFAULT_SCOPE.brief_id }), {
    tenant_id: DEFAULT_SCOPE.tenant_id, project_id: DEFAULT_SCOPE.project_id, brief_id: DEFAULT_SCOPE.brief_id,
    design_version_id: b.design_version.design_version_id, design_hash: b.design_version.design_hash, revision: 2,
  });
  assert.equal(store.listDesignVersions({ scope: DEFAULT_SCOPE, brief_id: DEFAULT_SCOPE.brief_id, limit: 10 }).items.length, 2);
});

test("commit-intent integrity binds canonical payload and every row identity before finalize or recovery", async (t) => {
  const { store } = await createStore(t);
  const cases = ["nested_attempt_identity", "row_actor", "row_job", "row_request", "row_brief"];
  for (const kind of cases) {
    const actionId = `intent-integrity-${kind}`;
    const input = createWrite({ id: actionId, action_id: actionId, job_id: `job-${actionId}` });
    const prepared = await store.prepareDesignVersion(input);
    assert.equal(prepared.status, "prepared");
    const action = store.db.prepare(`SELECT * FROM creation_actions WHERE action_id=?`).get(actionId);
    if (kind === "nested_attempt_identity") {
      const intent = JSON.parse(action.intent_json);
      intent.evidence.creation.billable_attempt_id = "billable-substituted";
      intent.evidence.attempt_identities.billable_attempt_id = "billable-substituted";
      store.db.prepare("UPDATE creation_actions SET intent_json=? WHERE action_id=?")
        .run(canonicalSerialize(intent), actionId);
    } else if (kind === "row_actor") {
      store.db.prepare("UPDATE creation_actions SET actor_id=? WHERE action_id=?").run("actor-substituted", actionId);
    } else if (kind === "row_job") {
      store.db.prepare("UPDATE creation_actions SET job_id=? WHERE action_id=?").run("job-substituted", actionId);
    } else if (kind === "row_request") {
      store.db.prepare("UPDATE creation_actions SET request_hash=? WHERE action_id=?")
        .run(canonicalHash({ substituted: kind }), actionId);
    } else {
      store.db.prepare("UPDATE creation_actions SET brief_id=? WHERE action_id=?").run("brief-substituted", actionId);
    }

    await expectStoreReject("integrity_error", () => store.finalizeAction(DEFAULT_SCOPE, actionId));
    assert.equal(store.db.prepare("SELECT count(*) AS count FROM design_versions WHERE action_id=?").get(actionId).count, 0);
    assert.equal(store.getSelection({ scope: DEFAULT_SCOPE, brief_id: DEFAULT_SCOPE.brief_id }), null);
    const recovery = await store.recover();
    assert.equal(recovery.unknown, 1, kind);
    assert.equal(store.db.prepare("SELECT state FROM creation_actions WHERE action_id=?").get(actionId).state, "unknown");
    assert.equal(store.db.prepare("SELECT count(*) AS count FROM design_versions WHERE action_id=?").get(actionId).count, 0);
  }
});

test("separate processes race selection CAS and exactly one branch wins", async (t) => {
  const { root, store } = await createStore(t);
  store.putBrief({ scope: { tenant_id: DEFAULT_SCOPE.tenant_id, project_id: DEFAULT_SCOPE.project_id },
    brief: createBrief() });
  const a = await store.saveDesignVersion(createWrite({ id: "process-A" }));
  const b = await store.saveDesignVersion(createWrite({ id: "process-B", parent: a.design_version,
    selection: { mode: "branch" } }));
  const c = await store.saveDesignVersion(createWrite({ id: "process-C", parent: a.design_version,
    selection: { mode: "branch" } }));
  const selectionFor = (version) => ({ scope: DEFAULT_SCOPE, brief_id: DEFAULT_SCOPE.brief_id,
    design_version_id: version.design_version.design_version_id,
    expected_brief_hash: a.design_version.brief_hash,
    expected_target_design_hash: version.design_version.design_hash,
    expected_selected_design_version_id: "process-A", expected_selected_design_hash: a.design_version.design_hash,
    expected_selection_revision: 1 });
  const children = [b, c].map((version) => fork(SELECTION_WORKER.pathname, [], { stdio: ["ignore", "ignore", "inherit", "ipc"],
    serialization: "json", env: { ...process.env,
      CREATIVE_VERSION_SELECTION_INPUT: JSON.stringify({ databasePath: join(root, "versions.sqlite"),
        objectRoot: join(root, "objects"), selection: selectionFor(version) }) } }));
  t.after(() => { for (const child of children) if (child.connected) child.kill(); });
  const workers = children.map((child) => {
    let readyResolve;
    let resultResolve;
    let resultReject;
    const ready = new Promise((resolve) => { readyResolve = resolve; });
    const result = new Promise((resolve, reject) => { resultResolve = resolve; resultReject = reject; });
    child.on("message", (message) => {
      if (message?.type === "ready") readyResolve();
      else if (message?.type === "result") resultResolve(message.result);
      else if (message?.type === "error") resultReject(new Error(`selection worker: ${message.code}`));
    });
    child.once("error", resultReject);
    child.once("exit", (code) => { if (code !== 0) resultReject(new Error(`selection worker exited ${code}`)); });
    return { child, ready, result };
  });
  await Promise.all(workers.map((worker) => worker.ready));
  for (const worker of workers) worker.child.send({ type: "start" });
  const outcomes = await Promise.all(workers.map((worker) => worker.result));
  assert.deepEqual(outcomes.map((outcome) => outcome.status).sort(), ["selected", "stale"]);
  const selection = store.getSelection({ scope: DEFAULT_SCOPE, brief_id: DEFAULT_SCOPE.brief_id });
  assert.ok(["process-B", "process-C"].includes(selection.design_version_id));
  assert.equal(selection.revision, 2);
  assert.equal(store.listDesignVersions({ scope: DEFAULT_SCOPE, brief_id: DEFAULT_SCOPE.brief_id, limit: 10 }).items.length, 3);
});

test("implicit stale bases conflict, same action is idempotent, and tenant scope prevents cross-read", async (t) => {
  const { store } = await createStore(t);
  const a = await store.saveDesignVersion(createWrite({ id: "implicit-A" }));
  const b = await store.saveDesignVersion(createWrite({ id: "implicit-B", parent: a.design_version }));
  const staleInput = createWrite({ id: "implicit-C", parent: a.design_version });
  const stale = await store.saveDesignVersion(staleInput);
  assert.equal(stale.status, "stale");
  assert.equal(stale.code, "stale_version");
  assert.equal((await store.saveDesignVersion(staleInput)).replayed, true);
  assert.equal(store.getSelection({ scope: DEFAULT_SCOPE, brief_id: DEFAULT_SCOPE.brief_id }).design_version_id, "implicit-B");
  assert.deepEqual(store.listDesignVersions({ scope: DEFAULT_SCOPE, brief_id: DEFAULT_SCOPE.brief_id, limit: 10 }).items
    .map((item) => item.design_version_id).sort(), ["implicit-A", "implicit-B"]);

  const actionScope = { tenant_id: "tenant-1", project_id: "project-1", brief_id: "brief-idempotency" };
  const base = createWrite({ scope: actionScope, id: "shared-id", action_id: "tenant-local-action", job_id: "job-tenant-1" });
  const first = await store.saveDesignVersion(base);
  const replay = await store.saveDesignVersion(base);
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  const changed = structuredClone(base);
  changed.design_version.vendor_id = 42;
  changed.design_version.design_hash = computeDesignVersionHash(changed.design_version);
  await expectStoreReject("conflict", () => store.saveDesignVersion(changed));

  const otherScope = { tenant_id: "tenant-2", project_id: "project-2", brief_id: "brief-2" };
  const other = await store.saveDesignVersion(createWrite({ scope: otherScope, id: "tenant2-only",
    action_id: "tenant-local-action", job_id: "job-tenant-2", bytes: Buffer.from("different tenant bytes") }));
  assert.equal(other.status, "saved");
  assert.equal(store.getDesignVersion({ scope: actionScope, brief_id: actionScope.brief_id,
    design_version_id: "tenant2-only" }), null);
  assert.equal(await store.getArtifactBytes({ scope: actionScope, brief_id: actionScope.brief_id,
    design_version_id: "tenant2-only" }), null);
  expectStoreError("not_found", () => store.compareDesignVersions({ scope: actionScope,
    brief_id: actionScope.brief_id, left_design_version_id: "shared-id", right_design_version_id: "tenant2-only" }));
  expectStoreError("invalid_request", () => store.getDesignVersion({ scope: actionScope,
    brief_id: actionScope.brief_id, design_version_id: "../tenant-2" }));

  const objectPath = join(store.objectRoot, "objects", "sha256",
    first.design_version.artifact.content_hash.slice(7, 9), first.design_version.artifact.content_hash.slice(7));
  await writeFile(objectPath, Buffer.from("tampered bytes"));
  expectStoreError("integrity_error", () => store.getDesignVersion({ scope: actionScope,
    brief_id: actionScope.brief_id, design_version_id: "shared-id" }));
  expectStoreError("integrity_error", () => store.listDesignVersions({ scope: actionScope,
    brief_id: actionScope.brief_id, limit: 10 }));
});

test("crash recovery reconciles actual process exits at each storage boundary without redispatch", async (t) => {
  const stages = ["after_object_write", "after_commit_intent", "after_metadata_write", "after_commit"];
  for (const [index, stage] of stages.entries()) {
    const root = await mkdtemp(join(tmpdir(), `creative-version-crash-${index}-`));
    try {
      const databasePath = join(root, "versions.sqlite");
      const objectRoot = join(root, "objects");
      const input = createWrite({ id: `crash-${index}` });
      const serialized = { ...input, artifact_bytes_base64: Buffer.from(input.artifact_bytes).toString("base64") };
      delete serialized.artifact_bytes;
      const child = spawnSync(process.execPath, [CRASH_WORKER.pathname], {
        env: { ...process.env, CREATIVE_VERSION_DATABASE: databasePath, CREATIVE_VERSION_OBJECTS: objectRoot,
          CREATIVE_VERSION_CRASH_AT: stage, CREATIVE_VERSION_WRITE_JSON: JSON.stringify(serialized) },
        encoding: "utf8",
        timeout: 15_000,
      });
      assert.equal(child.status, 86, `${stage}: ${child.stderr}`);

      const reopened = new CreativeVersionStore({ databasePath, objectRoot,
        now: () => Date.parse("2026-10-10T12:30:00.000Z") });
      const recovery = await reopened.recover();
      if (stage === "after_object_write") {
        assert.deepEqual(recovery, { examined: 0, committed: 0, conflicts: 0, unknown: 0 });
        assert.equal(reopened.listDesignVersions({ scope: DEFAULT_SCOPE, brief_id: DEFAULT_SCOPE.brief_id, limit: 10 }).items.length, 0);
      } else if (stage === "after_commit") {
        assert.deepEqual(recovery, { examined: 0, committed: 0, conflicts: 0, unknown: 0 });
      } else {
        assert.deepEqual(recovery, { examined: 1, committed: 1, conflicts: 0, unknown: 0 });
      }
      if (stage !== "after_object_write") {
        const stored = reopened.getDesignVersion({ scope: DEFAULT_SCOPE, brief_id: DEFAULT_SCOPE.brief_id,
          design_version_id: `crash-${index}` });
        assert.equal(stored.design_hash, input.design_version.design_hash);
        assert.deepEqual(await reopened.getArtifactBytes({ scope: DEFAULT_SCOPE, brief_id: DEFAULT_SCOPE.brief_id,
          design_version_id: stored.design_version_id }), input.artifact_bytes);
        const replay = await reopened.saveDesignVersion(input);
        assert.equal(replay.replayed, true);
        assert.equal(reopened.listDesignVersions({ scope: DEFAULT_SCOPE, brief_id: DEFAULT_SCOPE.brief_id, limit: 10 }).items.length, 1);
      }
      reopened.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("storage schema rejects unknown majors and the import graph stays provider-independent", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "creative-version-schema-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const databasePath = join(root, "future.sqlite");
  const objectRoot = join(root, "objects");
  await mkdir(objectRoot, { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA user_version=99");
  db.close();
  expectStoreError("unsupported_version", () => new CreativeVersionStore({ databasePath, objectRoot }));

  const rootFiles = [new URL("../../src/versions/index.mjs", import.meta.url),
    new URL("../../src/storage/content-addressed.mjs", import.meta.url)];
  const visited = new Set();
  const visiting = new Set();
  const visit = async (filename) => {
    const absolute = resolve(filename);
    if (visiting.has(absolute)) throw new Error(`cyclic import: ${absolute}`);
    if (visited.has(absolute)) return;
    visiting.add(absolute);
    const source = await readFile(absolute, "utf8");
    assert.doesNotMatch(source, /(?:from\s*|import\s*)["'][^"']*(?:provider|renderer|agent-harness|ledger|transport)[^"']*["']/i);
    for (const match of source.matchAll(/\b(?:import|export)\s+(?:[^'";]*?\s+from\s*)?["']([^"']+)["']/g)) {
      if (match[1].startsWith(".")) await visit(resolve(dirname(absolute), match[1]));
    }
    visiting.delete(absolute);
    visited.add(absolute);
  };
  for (const entry of rootFiles) await visit(fileURLToPath(entry));
  const source = await readFile(new URL("../../src/versions/store.mjs", import.meta.url), "utf8");
  assert.match(source, /recover\(\)/);
  assert.match(source, /selectDesignVersion\(/);
  assert.ok(visited.size >= 5, "walks the complete local relative-import closure");
});

test("content-addressed storage snapshots caller bytes before its first await", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "creative-object-snapshot-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = Buffer.from("immutable original bytes");
  const expectedHash = hashArtifactBytes(source);
  const pending = writeContentAddressedObject(root, source, expectedHash);
  source.fill(0x78);
  const saved = await pending;
  assert.equal(saved.content_hash, expectedHash);
  assert.deepEqual(Buffer.from(await readContentAddressedObject(root, expectedHash)),
    Buffer.from("immutable original bytes"));
});

test("storage schema v2 migrates additively to private provider attribution v6", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "creative-version-v2-migration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const databasePath = join(root, "versions.sqlite");
  const objectRoot = join(root, "objects");
  const db = new DatabaseSync(databasePath);
  db.exec(`CREATE TABLE creative_jobs (
    tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, job_id TEXT NOT NULL, brief_id TEXT,
    actor_id TEXT NOT NULL, action_id TEXT NOT NULL, operation TEXT NOT NULL, request_hash TEXT NOT NULL,
    status TEXT NOT NULL, lease_hash TEXT NOT NULL, lease_expires_at TEXT NOT NULL, result_json TEXT,
    error_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY(tenant_id,project_id,job_id), UNIQUE(tenant_id,project_id,action_id)
  ) STRICT; PRAGMA user_version=2;`);
  db.close();
  const migrated = new CreativeVersionStore({ databasePath, objectRoot });
  assert.equal(migrated.db.prepare("PRAGMA user_version").get().user_version, 6);
  assert.equal(migrated.db.prepare("PRAGMA table_info(creative_jobs)").all()
    .some((column) => column.name === "attempt_evidence_json"), true);
  const dispatchColumns = migrated.db.prepare("PRAGMA table_info(creative_dispatch_intents)").all();
  for (const name of ["reservation_ref", "provider_name", "provider_model"]) {
    assert.ok(dispatchColumns.some((column) => column.name === name));
  }
  assert.ok(migrated.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='private_provider_attributions'").get());
  assert.ok(migrated.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='private_provider_attribution_pending'").get());
  assert.ok(migrated.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='private_provider_attribution_reconciliations'").get());
  migrated.close();
});
