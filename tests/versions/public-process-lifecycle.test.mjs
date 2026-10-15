import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { makePng } from "../../fixtures/models/png.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const WORKER = new URL("../../fixtures/versions/public-process-worker.mjs", import.meta.url);
const NOW = Date.parse("2026-10-10T12:30:00.000Z");
const SCOPE = { tenant_id: "tenant-api-1", project_id: "project-api-1", brief_id: "brief-api-1" };
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fixture = async (name) => JSON.parse(await readFile(new URL(`../../fixtures/api/${name}.json`, import.meta.url), "utf8"));
const principal = { actor_id: "actor-api-1", tenant_id: SCOPE.tenant_id, project_id: SCOPE.project_id,
  expires_at: "2026-10-11T00:00:00.000Z", permissions: ["creative.generate", "creative.edit", "creative.read", "creative.cancel"],
  budget_scope_id: "budget-api-1", budget_policy_version: "budget-policy/1" };

function request(action_id, operation, payload) {
  return { contract: "CreativeApiRequest", schema_version: "1.0", event_id: `event-${action_id}`,
    request_id: `request-${action_id}`, tenant_id: SCOPE.tenant_id, project_id: SCOPE.project_id,
    correlation_id: `correlation-${action_id}`, producer: "public-process-lifecycle-fixture",
    occurred_at: "2026-10-10T12:20:00.000Z", ingested_at: "2026-10-10T12:20:00.000Z",
    environment: "test", billing_mode: "simulated", source_refs: ["source-api-1"], operation, action_id, payload };
}

async function editRequest(actionId, parent) {
  const plan = await fixture("edit-plan");
  plan.base = { brief_hash: parent.brief_hash, design_hash: parent.design_hash, design_version_id: parent.design_version_id };
  for (const step of plan.steps) {
    if (step.parameters.design_version_id !== undefined) step.parameters.design_version_id = parent.design_version_id;
    if (step.parameters.artifact_id !== undefined) step.parameters.artifact_id = parent.artifact.artifact_id;
  }
  plan.expected_result.parent_version_id = parent.design_version_id;
  return request(actionId, "edit", { brief_id: SCOPE.brief_id, design_version_id: parent.design_version_id,
    selection_mode: "branch", plan });
}

// Claim capabilities exist only in this synthetic test. Retained transcripts
// replace their values with digests; assertions use the original IPC values.
function redactClaims(value) {
  return JSON.parse(JSON.stringify(value, (key, entry) => key === "claim_token" ? `sha256:${hash(entry)}` : entry));
}

async function installedProcessFixture(t, scenario) {
  const evidenceRoot = process.env.CREATIVE_MULTIPROCESS_EVIDENCE_ROOT;
  const root = evidenceRoot ? join(evidenceRoot, scenario) : await mkdtemp(join(tmpdir(), "creative-public-process-"));
  await mkdir(root, { recursive: true });
  if (evidenceRoot) assert.deepEqual(await readdir(root), [], "use a new evidence root for each run");
  const children = [];
  const records = [];
  const databasePath = join(root, "versions.sqlite");
  const objectRoot = join(root, "objects");
  const consumerRoot = join(root, "consumer");
  await mkdir(consumerRoot);
  // Keep inherited sandbox, proxy and network-control preloads intact. Only
  // names are retained below: arbitrary inherited values may be credentials.
  const childEnv = { ...process.env,
    PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`, LANG: "C.UTF-8",
    TMPDIR: root, npm_config_ignore_scripts: "true", npm_config_offline: "true",
    npm_config_audit: "false", npm_config_fund: "false" };
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await Promise.all(children.map((child) => child.recorded));
    if (!evidenceRoot) await rm(root, { recursive: true, force: true });
  });

  async function npm(label, args, cwd) {
    const started_at = new Date().toISOString();
    const result = spawnSync("npm", args, { cwd, env: childEnv, encoding: "utf8", timeout: 20_000,
      maxBuffer: 4 * 1024 * 1024 });
    const receipt = { label, command: "npm", argv: args, cwd, started_at, completed_at: new Date().toISOString(),
      pid: result.pid, exit_code: result.status, signal: result.signal, error: result.error?.message ?? null,
      stdout_sha256: hash(result.stdout ?? ""), stderr_sha256: hash(result.stderr ?? "") };
    await writeFile(join(root, `${label}.stdout`), result.stdout ?? "");
    await writeFile(join(root, `${label}.stderr`), result.stderr ?? "");
    await writeFile(join(root, `${label}.receipt.json`), `${JSON.stringify(receipt, null, 2)}\n`);
    assert.equal(result.status, 0, `${label}: ${result.error?.message ?? result.stderr}`);
    return result.stdout;
  }
  const packed = JSON.parse(await npm("pack", ["pack", "--json", "--ignore-scripts", "--pack-destination", root], ROOT))[0];
  const tarballPath = join(root, packed.filename);
  const tarballHash = hash(await readFile(tarballPath));
  assert.ok(packed.files.some((entry) => entry.path === "src/sqlite/admission.mjs"), "installed package carries shared admission");
  await npm("install", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", tarballPath], consumerRoot);
  const workerPath = join(consumerRoot, "worker.mjs");
  await copyFile(WORKER, workerPath);

  async function start(worker, options = {}) {
    const argv = [workerPath];
    const started_at = new Date().toISOString();
    const child = spawn(process.execPath, argv, { cwd: consumerRoot, env: childEnv,
      stdio: ["ignore", "pipe", "pipe", "ipc"] });
    children.push(child);
    const stdout = [];
    const stderr = [];
    const events = [];
    const waiters = new Set();
    let ended;
    let spawnError;
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    const failure = () => spawnError ?? events.find((event) => event.event === "failed")?.error;
    const deliver = () => {
      for (const waiter of [...waiters]) {
        const event = events.find(waiter.predicate);
        const error = failure();
        if (event) { waiters.delete(waiter); clearTimeout(waiter.timer); waiter.resolve(event); }
        else if (error || ended) {
          waiters.delete(waiter); clearTimeout(waiter.timer);
          waiter.reject(new Error(`${worker} ended before ${waiter.description}: ${JSON.stringify(error ?? ended)}`));
        }
      }
    };
    child.on("message", (event) => { events.push({ ...event, received_at: new Date().toISOString() }); deliver(); });
    child.on("error", (error) => { spawnError = { message: error.message }; deliver(); });
    child.recorded = new Promise((resolve, reject) => child.once("close", async (code, signal) => {
      ended = { code, signal };
      deliver();
      const out = Buffer.concat(stdout);
      const err = Buffer.concat(stderr);
      const record = { worker, executable: process.execPath, argv, cwd: consumerRoot,
        environment_variable_names: Object.keys(childEnv).sort(),
        pid: child.pid, started_at, completed_at: new Date().toISOString(), ...ended,
        stdout_sha256: hash(out), stderr_sha256: hash(err), events: redactClaims(events),
        transcript_redaction: "synthetic claim_token values replaced by SHA-256 digests" };
      try {
        await writeFile(join(root, `${worker}.stdout`), out);
        await writeFile(join(root, `${worker}.stderr`), err);
        await writeFile(join(root, `${worker}.receipt.json`), `${JSON.stringify(record, null, 2)}\n`);
        records.push(record);
        resolve(ended);
      } catch (error) { reject(error); }
    }));
    const wait = (event, commandId) => new Promise((resolve, reject) => {
      const waiter = { predicate: (entry) => entry.event === event && (commandId === undefined || entry.command_id === commandId),
        description: `${event}/${commandId ?? "any"}`, resolve, reject };
      waiter.timer = setTimeout(() => { waiters.delete(waiter); reject(new Error(`${worker} timed out waiting for ${waiter.description}`)); }, 15_000);
      waiters.add(waiter);
      deliver();
    });
    const send = (message) => child.send(message);
    let nextCommand = 0;
    const call = async (kind, event, fields = {}) => {
      const command_id = `${worker}-command-${++nextCommand}`;
      send({ kind, command_id, ...fields });
      return wait(event, command_id);
    };
    send({ worker, databasePath, objectRoot, now: NOW, scope: SCOPE,
      artifactBase64: makePng().toString("base64"), ...options });
    const ready = await wait("ready");
    assert.equal(ready.runtime, process.version);
    assert.equal(ready.database_path, databasePath);
    // Node resolves ESM entry points through symlinks (including macOS
    // /var -> /private/var). Compare the exact installed file identity.
    assert.equal(ready.module_url, pathToFileURL(await realpath(workerPath)).href);
    return { child, send, wait, call, ready,
      invoke: (body, trustedPrincipal = principal) => call("invoke", "result", { principal: trustedPrincipal, request: body }),
      close: async () => { send({ kind: "close" }); await wait("closed"); assert.deepEqual(await child.recorded, { code: 0, signal: null }); },
    };
  }
  return { root, evidenceRoot, databasePath, objectRoot, consumerRoot, tarballHash, records, start };
}

test("installed public API publishes, replays, cancels, and recovers outbox claims across independent processes",
  { timeout: 90_000 }, async (t) => {
    const { root, evidenceRoot, databasePath, objectRoot, consumerRoot, tarballHash, records, start } =
      await installedProcessFixture(t, "lifecycle");

    const seed = await start("seed", { brief: await fixture("brief") });
    const seeded = await seed.invoke(request("process-seed", "generate", { brief_id: SCOPE.brief_id, plan: await fixture("generate-plan") }));
    assert.equal(seeded.response.ok, true, JSON.stringify(seeded.response));
    assert.equal(seeded.counters.provider, 1);
    const parent = seeded.response.result.design_version;
    await seed.close();

    const branchA = await start("branch-a", { holdPublication: true });
    const branchB = await start("branch-b", { holdProvider: true });
    const requestA = await editRequest("process-branch-a", parent);
    const requestB = await editRequest("process-branch-b", parent);
    const pendingB = branchB.invoke(requestB);
    await branchB.wait("provider-held");
    const pendingA = branchA.invoke(requestA);
    assert.equal((await branchA.wait("publication-held")).transaction_open, true);
    branchB.send({ kind: "release", stage: "provider-held" });
    await branchB.wait("usage-lock-attempt");
    assert.equal((await branchA.call("transaction-state", "transaction-state")).transaction_open, true,
      "the independent B usage writer reaches its BEGIN boundary while A still owns publication");
    branchA.send({ kind: "release", stage: "publication-held" });
    const results = await Promise.all([pendingA, pendingB]);
    for (const result of results) {
      assert.equal(result.response.ok, true, JSON.stringify(result.response));
      assert.equal(result.response.result.design_version.parent_version_id, parent.design_version_id);
      assert.equal(result.counters.provider, 1);
      assert.equal(result.counters.reservations, 1);
      assert.equal(result.counters.settlements, 1);
      assert.equal(result.counters.unknown_holds, 0);
      assert.equal(result.counters.durable_observation_ids.length, 1);
    }
    assert.equal(new Set(results.map((entry) => entry.response.result.design_version.billable_attempt_id)).size, 2);
    assert.equal(new Set(results.flatMap((entry) => entry.counters.transport_ids)).size, 2);
    await branchA.close();
    await branchB.close();

    const replay = await start("replay");
    const replayed = await replay.invoke(requestA);
    assert.equal(replayed.response.ok, true, JSON.stringify(replayed.response));
    assert.equal(replayed.response.replayed, true);
    assert.deepEqual(replayed.response.result.design_version, results[0].response.result.design_version);
    const altered = structuredClone(requestA);
    altered.payload.plan.steps[0].parameters.variant_count = 2;
    const conflicted = await replay.invoke(altered);
    assert.equal(conflicted.response.ok, false);
    assert.equal(conflicted.response.error.code, "conflict");
    assert.equal(conflicted.counters.provider, 0);
    assert.equal(conflicted.counters.reservations, 0);
    await replay.close();

    const late = await start("late-result", { holdProvider: true });
    const canceller = await start("canceller");
    const pendingLate = late.invoke(await editRequest("process-cancelled-edit", parent));
    const dispatched = await late.wait("provider-held");
    const cancelled = await canceller.invoke(request("process-cancel", "cancel", { job_id: dispatched.job_id }));
    assert.equal(cancelled.response.ok, true, JSON.stringify(cancelled.response));
    assert.equal(cancelled.response.job.status, "cancelled");
    assert.equal(cancelled.counters.provider, 0);
    late.send({ kind: "release", stage: "provider-held" });
    const lateResult = await pendingLate;
    assert.equal(lateResult.response.ok, false, JSON.stringify(lateResult.response));
    assert.equal(lateResult.response.error.code, "cancelled");
    assert.equal(lateResult.counters.provider, 1);
    assert.equal(lateResult.counters.reservations, 1);
    await late.close();
    await canceller.close();

    // This reader runs only after provider/publication workers have closed.
    // It does not manipulate metadata or manufacture pending outbox records.
    const before = new DatabaseSync(databasePath, { readOnly: true });
    const versions = before.prepare("SELECT * FROM design_versions ORDER BY design_version_id").all();
    assert.equal(versions.length, 3, "root and both branches exist; cancelled late output is invisible");
    const selection = before.prepare(`SELECT design_version_id,design_hash FROM version_selections
      WHERE tenant_id=? AND project_id=? AND brief_id=?`).get(SCOPE.tenant_id, SCOPE.project_id, SCOPE.brief_id);
    assert.equal(selection.design_version_id, parent.design_version_id, "both explicit branches preserve the selected root");
    assert.equal(selection.design_hash, parent.design_hash);
    const lateJob = before.prepare("SELECT * FROM creative_jobs WHERE action_id=?").get("process-cancelled-edit");
    assert.equal(lateJob.status, "cancelled");
    assert.equal(lateJob.result_json, null);
    const lateEvidence = JSON.parse(lateJob.attempt_evidence_json);
    assert.equal(lateEvidence.transport_attempt_ids.length, 1);
    assert.equal(lateEvidence.usage_refs.length, 1);
    const usage = before.prepare("SELECT * FROM creative_telemetry_observations_v1 ORDER BY logical_operation_id").all();
    assert.equal(usage.length, 4, "seed, both branches and cancelled dispatched attempt each retain usage");
    assert.equal(new Set(usage.map((row) => row.billable_attempt_id)).size, 4);
    assert.ok(usage.every((row) => JSON.parse(row.payload_json).observation.completeness === "complete"));
    const lateUsage = usage.find((row) => row.logical_operation_id === "process-cancelled-edit");
    assert.equal(JSON.parse(lateUsage.payload_json).attempt.billable_attempt_id, lateEvidence.billable_attempt_id);
    assert.equal(JSON.parse(lateUsage.payload_json).observation.completeness, "complete");
    const pendingEvents = before.prepare("SELECT event_id FROM creative_telemetry_evidence_outbox_v1 WHERE status='pending' ORDER BY event_id").all();
    assert.ok(pendingEvents.length > 0 && pendingEvents.length <= 32);
    before.close();

    const claimA = await start("claim-a");
    const claimB = await start("claim-b");
    const claims = await Promise.all([claimA.call("claim", "claimed", { crash: true }), claimB.call("claim", "claimed", { crash: true })]);
    assert.deepEqual(await claimA.child.recorded, { code: 86, signal: null });
    assert.deepEqual(await claimB.child.recorded, { code: 86, signal: null });
    const oldClaims = claims.flatMap((entry) => entry.result.records);
    assert.equal(oldClaims.length, pendingEvents.length);
    assert.equal(new Set(oldClaims.map((entry) => entry.event.event_id)).size, pendingEvents.length,
      "independent processes never claim one evidence record twice under a live lease");
    assert.deepEqual(oldClaims.map((entry) => entry.event.event_id).sort(), pendingEvents.map((entry) => entry.event_id));

    const recovery = await start("recovery", { now: NOW + 2_000 });
    const recovered = await recovery.call("recover", "recovered");
    assert.equal(recovered.recovery.committed, 0);
    const reclaimed = await recovery.call("claim", "claimed");
    assert.deepEqual(reclaimed.result.records.map((entry) => entry.event.event_id).sort(), pendingEvents.map((entry) => entry.event_id));
    const previous = new Map(oldClaims.map((entry) => [entry.event.event_id, entry.claim_token]));
    assert.ok(reclaimed.result.records.every((entry) => entry.claim_token !== previous.get(entry.event.event_id)));
    const staleAck = await recovery.call("acknowledge", "acknowledged", { records: oldClaims });
    assert.ok(staleAck.results.every((entry) => entry.status === "lease_lost"));
    const freshAck = await recovery.call("acknowledge", "acknowledged", { records: reclaimed.result.records });
    assert.ok(freshAck.results.every((entry) => entry.status === "acknowledged"));
    const recoveredReplay = await recovery.invoke(requestB);
    assert.equal(recoveredReplay.response.ok, true, JSON.stringify(recoveredReplay.response));
    assert.equal(recoveredReplay.response.replayed, true);
    assert.equal(recoveredReplay.counters.provider, 0);
    assert.equal(recoveredReplay.counters.reservations, 0);
    await recovery.close();

    const reopened = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(reopened.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    assert.deepEqual(reopened.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(reopened.prepare("SELECT count(*) AS n FROM design_versions").get().n, 3);
    assert.deepEqual(reopened.prepare("SELECT * FROM design_versions ORDER BY design_version_id").all(), versions,
      "recovery and cross-process replay cannot mutate retained immutable versions");
    assert.deepEqual(reopened.prepare(`SELECT design_version_id,design_hash FROM version_selections
      WHERE tenant_id=? AND project_id=? AND brief_id=?`).get(SCOPE.tenant_id, SCOPE.project_id, SCOPE.brief_id), selection);
    assert.equal(reopened.prepare("SELECT count(*) AS n FROM creative_telemetry_observations_v1").get().n, 4);
    assert.equal(reopened.prepare("SELECT count(*) AS n FROM creative_telemetry_evidence_outbox_v1 WHERE status='delivered'").get().n, pendingEvents.length);
    reopened.close();
    for (const entry of [parent, ...results.map((result) => result.response.result.design_version)]) {
      const digest = entry.artifact.content_hash.slice("sha256:".length);
      assert.equal(hash(await readFile(join(objectRoot, "objects", "sha256", digest.slice(0, 2), digest))), digest);
    }
    const summary = { schema_version: "creative-public-process-lifecycle/1", runtime: process.version,
      provider_mode: "mock", commerce_mode: "simulated", artifact_origin: "independently synthetic PNG fixtures",
      native_decoder_claim: false, package_tarball_sha256: tarballHash, installed_consumer: consumerRoot,
      publication_overlap: "BEGIN boundary reached while another process owns publication; native contention not asserted here",
      worker_count: records.length, published_versions: 3, durable_usage_records: 4,
      recovered_evidence_records: pendingEvents.length, worker_pids: records.map((record) => record.pid),
      limitations: ["No live provider or Finance authority", "No power-loss or production-host qualification"],
      evidence_root: evidenceRoot ?? null };
    await writeFile(join(root, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    t.diagnostic(JSON.stringify(summary));
  });

test("installed public API retains a held outcome after actual cross-process SQLite BUSY and replays it without redispatch",
  { timeout: 90_000 }, async (t) => {
    const { root, evidenceRoot, databasePath, objectRoot, consumerRoot, tarballHash, records, start } =
      await installedProcessFixture(t, "busy");
    const seed = await start("seed", { brief: await fixture("brief") });
    const seeded = await seed.invoke(request("busy-seed", "generate", { brief_id: SCOPE.brief_id, plan: await fixture("generate-plan") }));
    assert.equal(seeded.response.ok, true, JSON.stringify(seeded.response));
    const parent = seeded.response.result.design_version;
    await seed.close();

    const publication = await start("publication", { holdPublication: true });
    const blocked = await start("blocked-usage", { holdProvider: true });
    const publicationRequest = await editRequest("busy-publication", parent);
    const blockedRequest = await editRequest("busy-usage", parent);
    const pendingBlocked = blocked.invoke(blockedRequest);
    await blocked.wait("provider-held");
    const pendingPublication = publication.invoke(publicationRequest);
    assert.equal((await publication.wait("publication-held")).transaction_open, true);
    blocked.send({ kind: "release", stage: "provider-held" });
    // Wait for the native call to throw, not just for entry to the call. Keep
    // SQLite's production busy timeout and propagate the original error.
    const contention = await blocked.wait("usage-lock-busy");
    assert.equal(contention.code, "ERR_SQLITE_ERROR");
    assert.ok([5, 6].includes(contention.errcode & 0xff));
    assert.equal((await publication.call("transaction-state", "transaction-state")).transaction_open, true);
    publication.send({ kind: "release", stage: "publication-held" });
    const [published, unavailable] = await Promise.all([pendingPublication, pendingBlocked]);
    assert.equal(published.response.ok, true, JSON.stringify(published.response));
    assert.equal(unavailable.response.ok, false, JSON.stringify(unavailable.response));
    assert.equal(unavailable.response.error.code, "unavailable");
    assert.equal(unavailable.response.error.field, "metering");
    assert.equal(unavailable.response.error.retryable, true);
    assert.equal(unavailable.counters.provider, 1);
    assert.equal(unavailable.counters.reservations, 1);
    assert.equal(unavailable.counters.settlements, 0);
    assert.equal(unavailable.counters.unknown_holds, 1);
    assert.equal(unavailable.counters.durable_observation_ids.length, 0);
    await publication.close();
    await blocked.close();

    const before = new DatabaseSync(databasePath, { readOnly: true });
    const versions = before.prepare("SELECT * FROM design_versions ORDER BY design_version_id").all();
    assert.equal(versions.length, 2, "the usage-persistence failure cannot publish a child");
    const failedJob = before.prepare("SELECT * FROM creative_jobs WHERE action_id=?").get("busy-usage");
    assert.equal(failedJob.status, "failed");
    assert.equal(failedJob.result_json, null);
    assert.equal(before.prepare("SELECT count(*) AS n FROM creative_telemetry_observations_v1").get().n, 2);
    const heldEvidence = before.prepare(`SELECT payload_json FROM creative_telemetry_evidence_outbox_v1
      WHERE json_extract(payload_json,'$.logical_operation_id')=? ORDER BY event_type`).all("busy-usage")
      .map((row) => JSON.parse(row.payload_json));
    assert.deepEqual(heldEvidence.map((event) => event.event_type), ["attempt_intent", "attempt_outcome", "transport_intent"]);
    assert.equal(new Set(heldEvidence.map((event) => event.billable_attempt_id)).size, 1);
    const outcome = heldEvidence.find((event) => event.event_type === "attempt_outcome");
    const transport = heldEvidence.find((event) => event.event_type === "transport_intent");
    assert.equal(outcome.metering_status, "dispatch_outcome_unknown");
    assert.equal(outcome.reservation_ref, transport.reservation_ref);
    assert.equal(outcome.reservation_ref, `reservation:${outcome.billable_attempt_id}`);
    assert.equal(outcome.transport_attempt_id, unavailable.counters.transport_ids[0]);
    assert.equal(outcome.transport_attempt_id, transport.transport_attempt_id);
    assert.equal(outcome.source_observation_id, undefined, "a missing durable usage row is never asserted as accepted");
    const pendingEvents = before.prepare("SELECT event_id FROM creative_telemetry_evidence_outbox_v1 WHERE status='pending' ORDER BY event_id").all();
    assert.equal(pendingEvents.length, 9);
    before.close();

    const claimant = await start("claimant");
    const claimed = await claimant.call("claim", "claimed", { crash: true });
    assert.deepEqual(await claimant.child.recorded, { code: 86, signal: null });
    assert.deepEqual(claimed.result.records.map((entry) => entry.event.event_id).sort(), pendingEvents.map((entry) => entry.event_id));
    const recovery = await start("recovery", { now: NOW + 2_000 });
    assert.equal((await recovery.call("recover", "recovered")).recovery.committed, 0);
    const reclaimed = await recovery.call("claim", "claimed");
    assert.deepEqual(reclaimed.result.records.map((entry) => entry.event.event_id).sort(), pendingEvents.map((entry) => entry.event_id));
    const oldTokens = new Map(claimed.result.records.map((entry) => [entry.event.event_id, entry.claim_token]));
    assert.ok(reclaimed.result.records.every((entry) => entry.claim_token !== oldTokens.get(entry.event.event_id)));
    assert.ok((await recovery.call("acknowledge", "acknowledged", { records: claimed.result.records }))
      .results.every((entry) => entry.status === "lease_lost"));
    assert.ok((await recovery.call("acknowledge", "acknowledged", { records: reclaimed.result.records }))
      .results.every((entry) => entry.status === "acknowledged"));
    const replayedPublication = await recovery.invoke(publicationRequest);
    assert.equal(replayedPublication.response.ok, true);
    assert.equal(replayedPublication.response.replayed, true);
    assert.deepEqual(replayedPublication.response.result.design_version, published.response.result.design_version);
    const replayedFailure = await recovery.invoke(blockedRequest);
    assert.equal(replayedFailure.response.ok, true, "a replay returns the retained failed job, not a new dispatch");
    assert.equal(replayedFailure.response.replayed, true);
    assert.equal(replayedFailure.response.job.job_id, failedJob.job_id);
    assert.equal(replayedFailure.response.job.status, "failed");
    assert.deepEqual(replayedFailure.response.job.error, JSON.parse(failedJob.error_json));
    assert.equal(replayedFailure.response.result, undefined);
    assert.equal(replayedFailure.counters.provider, 0);
    assert.equal(replayedFailure.counters.reservations, 0);
    assert.equal(replayedFailure.counters.settlements, 0);
    await recovery.close();

    const reopened = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(reopened.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    assert.deepEqual(reopened.prepare("PRAGMA foreign_key_check").all(), []);
    assert.deepEqual(reopened.prepare("SELECT * FROM design_versions ORDER BY design_version_id").all(), versions);
    assert.equal(reopened.prepare("SELECT design_version_id FROM version_selections").get().design_version_id, parent.design_version_id);
    assert.equal(reopened.prepare("SELECT count(*) AS n FROM creative_telemetry_observations_v1").get().n, 2);
    assert.equal(reopened.prepare("SELECT count(*) AS n FROM creative_telemetry_evidence_outbox_v1 WHERE status='delivered'").get().n, 9);
    reopened.close();
    for (const design of [parent, published.response.result.design_version]) {
      const digest = design.artifact.content_hash.slice("sha256:".length);
      assert.equal(hash(await readFile(join(objectRoot, "objects", "sha256", digest.slice(0, 2), digest))), digest);
    }
    const summary = { schema_version: "creative-public-process-busy/1", runtime: process.version,
      provider_mode: "mock", commerce_mode: "simulated", artifact_origin: "independently synthetic PNG fixtures",
      native_decoder_claim: false, package_tarball_sha256: tarballHash, installed_consumer: consumerRoot,
      sqlite_error: { code: contention.code, errcode: contention.errcode },
      worker_count: records.length, published_versions: 2, durable_usage_records: 2,
      unavailable_attempts_held: 1, recovered_evidence_records: 9, worker_pids: records.map((record) => record.pid),
      limitations: ["Busy usage was not persisted or settled and remains held for reconciliation",
        "No live provider or Finance authority", "No power-loss or production-host qualification"],
      evidence_root: evidenceRoot ?? null };
    await writeFile(join(root, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    t.diagnostic(JSON.stringify(summary));
  });

test("installed public history isolates tenant namespaces and rejects unauthorized or corrupt list, compare, and restore",
  { timeout: 90_000 }, async (t) => {
    const { root, evidenceRoot, databasePath, objectRoot, consumerRoot, tarballHash, records, start } =
      await installedProcessFixture(t, "history-boundaries");
    const localPrincipal = { ...principal, permissions: [...principal.permissions, "creative.restore"] };
    const foreignScope = { ...SCOPE, tenant_id: "tenant-history-b" };
    const foreignPrincipal = { ...localPrincipal, tenant_id: foreignScope.tenant_id, budget_scope_id: "budget-history-b" };
    const foreignCanary = "Synthetic foreign history canary";
    const scoped = (body, scope) => ({ ...body, tenant_id: scope.tenant_id, project_id: scope.project_id });

    async function seedNamespace(label, scope, trustedPrincipal, width) {
      const brief = { ...await fixture("brief"), tenant_id: scope.tenant_id, project_id: scope.project_id };
      if (scope === foreignScope) brief.facts.verified[0].value = foreignCanary;
      const seed = await start(`${label}-root`, { scope, brief,
        artifactBase64: makePng({ width }).toString("base64") });
      const plan = { ...await fixture("generate-plan"), tenant_id: scope.tenant_id, project_id: scope.project_id };
      plan.base.brief_hash = seed.ready.brief_hash;
      // Reuse local action IDs across tenants to prove public job deduplication
      // is scoped even when project and brief IDs are deliberately identical.
      const generated = await seed.invoke(scoped(request("history-shared-root", "generate", {
        brief_id: scope.brief_id, plan }), scope), trustedPrincipal);
      assert.equal(generated.response.ok, true, JSON.stringify(generated.response));
      assert.equal(generated.counters.provider, 1);
      assert.equal(generated.counters.reservations, 1);
      const parent = generated.response.result.design_version;
      await seed.close();
      const editor = await start(`${label}-child`, { artifactBase64: makePng({ width: width + 1 }).toString("base64") });
      const edit = scoped(await editRequest("history-shared-child", parent), scope);
      edit.payload.plan.tenant_id = scope.tenant_id;
      edit.payload.plan.project_id = scope.project_id;
      const edited = await editor.invoke(edit, trustedPrincipal);
      assert.equal(edited.response.ok, true, JSON.stringify(edited.response));
      assert.equal(edited.counters.provider, 1);
      assert.equal(edited.counters.reservations, 1);
      assert.equal(edited.response.result.design_version.parent_version_id, parent.design_version_id);
      await editor.close();
      return { parent, child: edited.response.result.design_version, brief_hash: seed.ready.brief_hash };
    }

    const local = await seedNamespace("history-a", SCOPE, localPrincipal, 16);
    const foreign = await seedNamespace("history-b", foreignScope, foreignPrincipal, 20);
    const allDesigns = [local.parent, local.child, foreign.parent, foreign.child];
    assert.equal(new Set(allDesigns.map((design) => design.artifact.content_hash)).size, 4,
      "each synthetic version has independently distinct retained bytes");
    const database = new DatabaseSync(databasePath, { readOnly: true });
    t.after(() => database.close());
    const quote = (identifier) => `"${identifier.replaceAll('"', '""')}"`;
    const snapshot = () => {
      const tables = Object.fromEntries(database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all().map(({ name }) => [name, database.prepare(`SELECT * FROM ${quote(name)}`).all()
          .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))]));
      return { tables,
        protected: Object.fromEntries(Object.entries(tables).filter(([name]) => name !== "creative_jobs")),
        foreign: Object.fromEntries(Object.entries(tables).map(([name, rows]) => [name,
          rows.filter((row) => row.tenant_id === foreignScope.tenant_id)])),
      };
    };
    const objectInventory = async () => {
      const files = [];
      const visit = async (directory, prefix = "") => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name);
          const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) await visit(path, relative);
          else {
            const bytes = await readFile(path);
            files.push({ path: relative, bytes: bytes.length, sha256: hash(bytes) });
          }
        }
      };
      await visit(objectRoot);
      return files.sort((left, right) => left.path.localeCompare(right.path));
    };
    const original = snapshot();
    const originalObjects = await objectInventory();
    assert.equal(original.tables.design_versions.length, 4);
    assert.equal(original.tables.creative_jobs.length, 4, "shared action IDs create independent tenant jobs");
    assert.equal(original.tables.version_selections.length, 2);
    const foreignMarkers = [foreignCanary, foreignScope.tenant_id, foreign.brief_hash,
      ...[foreign.parent, foreign.child].flatMap((design) => [design.design_version_id, design.design_hash,
        design.artifact.artifact_id, design.artifact.content_hash])];
    const noForeignMaterial = (response) => {
      const serialized = JSON.stringify(response);
      for (const marker of foreignMarkers) assert.equal(serialized.includes(marker), false,
        `local response must not disclose foreign state: ${marker}`);
    };
    const noWork = (reply) => assert.deepEqual(reply.counters, { provider: 0, reservations: 0,
      settlements: 0, unknown_holds: 0, transport_ids: [], durable_observation_ids: [] });
    const errorDetails = ({ diagnostic_ref, ...details }) => {
      // Diagnostics identify individual requests; their fresh opaque IDs are
      // not resource information. noForeignMaterial checks the complete error.
      assert.equal(typeof diagnostic_ref, "string");
      assert.ok(diagnostic_ref.length > 0);
      return details;
    };
    const payload = (operation, target = local.child.design_version_id) => operation === "list"
      ? { brief_id: SCOPE.brief_id, limit: 10 }
      : operation === "compare" ? { brief_id: SCOPE.brief_id,
        left_design_version_id: local.parent.design_version_id, right_design_version_id: target }
        : { brief_id: SCOPE.brief_id, target_design_version_id: target, expected_selection_revision: 1 };
    const reader = await start("history-reader");
    const listed = await reader.invoke(request("history-local-list", "list", payload("list")), localPrincipal);
    assert.equal(listed.response.ok, true, JSON.stringify(listed.response));
    assert.deepEqual(listed.response.result.items.map((entry) => entry.design_version_id).sort(),
      [local.parent.design_version_id, local.child.design_version_id].sort());
    noForeignMaterial(listed.response);
    noWork(listed);
    const compared = await reader.invoke(request("history-local-compare", "compare", payload("compare")), localPrincipal);
    assert.equal(compared.response.ok, true, JSON.stringify(compared.response));
    assert.equal(compared.response.result.left.design_hash, local.parent.design_hash);
    assert.equal(compared.response.result.right.artifact.content_hash, local.child.artifact.content_hash);
    noForeignMaterial(compared.response);
    noWork(compared);
    const foreignList = await reader.invoke(scoped(request("history-foreign-list", "list", {
      brief_id: foreignScope.brief_id, limit: 1 }), foreignScope), foreignPrincipal);
    assert.equal(foreignList.response.ok, true, JSON.stringify(foreignList.response));
    assert.ok([foreign.parent.design_version_id, foreign.child.design_version_id]
      .includes(foreignList.response.result.items[0].design_version_id));
    assert.equal(typeof foreignList.response.result.next_cursor, "string");
    noWork(foreignList);

    const cases = [];
    async function rejectsWithoutEffects(label, body, code, trustedPrincipal = localPrincipal, noJobWrite = false) {
      const before = snapshot();
      const objects = await objectInventory();
      const reply = await reader.invoke(body, trustedPrincipal);
      assert.equal(reply.response.ok, false, `${label}: ${JSON.stringify(reply.response)}`);
      assert.equal(reply.response.error.code, code, `${label}: ${JSON.stringify(reply.response)}`);
      noForeignMaterial(reply.response);
      noWork(reply);
      const after = snapshot();
      assert.deepEqual(after.protected, before.protected, `${label}: no version, selection, brief, attempt, usage or outbox mutation`);
      assert.deepEqual(after.foreign, before.foreign, `${label}: every foreign row, including jobs, remains unchanged`);
      assert.deepEqual(await objectInventory(), objects, `${label}: all retained object bytes remain unchanged`);
      if (body.operation !== "restore" || noJobWrite) assert.deepEqual(after.tables, before.tables,
        `${label}: rejection precedes any durable job write`);
      const job = database.prepare("SELECT status,result_json FROM creative_jobs WHERE tenant_id=? AND project_id=? AND action_id=?")
        .get(SCOPE.tenant_id, SCOPE.project_id, body.action_id);
      if (job) {
        assert.equal(job.status, "failed", `${label}: a rejected restore may retain only its failed local job`);
        assert.equal(job.result_json, null);
      }
      cases.push({ label, operation: body.operation, expected_public_code: code, actual_error: reply.response.error,
        response_sha256: hash(JSON.stringify(reply.response)),
        protected_before_sha256: hash(JSON.stringify(before.protected)), protected_after_sha256: hash(JSON.stringify(after.protected)),
        foreign_before_sha256: hash(JSON.stringify(before.foreign)), foreign_after_sha256: hash(JSON.stringify(after.foreign)),
        object_inventory_sha256: hash(JSON.stringify(objects)), local_failed_job_retained: Boolean(job), counters: reply.counters });
      return reply.response.error;
    }

    for (const operation of ["list", "compare", "restore"]) {
      await t.test(`${operation}: expired context and missing operation permission`, async () => {
        await rejectsWithoutEffects(`${operation}-expired`, request(`history-${operation}-expired`, operation, payload(operation)),
          "unauthorized", { ...localPrincipal, expires_at: new Date(NOW - 1).toISOString() }, true);
        const permission = operation === "restore" ? "creative.restore" : "creative.read";
        await rejectsWithoutEffects(`${operation}-permission`, request(`history-${operation}-permission`, operation, payload(operation)),
          "permission_denied", { ...localPrincipal, permissions: localPrincipal.permissions.filter((entry) => entry !== permission) }, true);
      });
      await t.test(`${operation}: request scope cannot replace trusted tenant or project`, async () => {
        for (const field of ["tenant_id", "project_id"]) {
          const body = request(`history-${operation}-forged-${field}`, operation, payload(operation));
          body[field] = field === "tenant_id" ? foreignScope.tenant_id : "project-history-foreign";
          await rejectsWithoutEffects(`${operation}-forged-${field}`, body, "scope_denied", localPrincipal, true);
        }
      });
      await t.test(`${operation}: malformed reference remains private`, async () => {
        const input = payload(operation);
        input[operation === "list" ? "brief_id" : operation === "compare" ? "right_design_version_id" : "target_design_version_id"] = "../history-private-reference";
        await rejectsWithoutEffects(`${operation}-malformed-reference`, request(`history-${operation}-malformed`, operation, input), "invalid_request");
      });
    }
    for (const side of ["left_design_version_id", "right_design_version_id"]) {
      await t.test(`compare: foreign ${side} has the same public error details as an absent version`, async () => {
        const foreignInput = { ...payload("compare"), [side]: foreign.child.design_version_id };
        const foreignError = await rejectsWithoutEffects(`compare-foreign-${side}`,
          request(`history-compare-foreign-${side}`, "compare", foreignInput), "not_found");
        const absentError = await rejectsWithoutEffects(`compare-absent-${side}`,
          request(`history-compare-absent-${side}`, "compare", { ...foreignInput, [side]: "design-history-absent" }), "not_found");
        assert.deepEqual(errorDetails(foreignError), errorDetails(absentError),
          "public error details cannot reveal whether the other tenant owns the reference");
      });
    }
    await t.test("restore: foreign target has the same public error details as an absent version", async () => {
      const foreignError = await rejectsWithoutEffects("restore-foreign", request("history-restore-foreign", "restore",
        payload("restore", foreign.child.design_version_id)), "not_found");
      const absentError = await rejectsWithoutEffects("restore-absent", request("history-restore-absent", "restore",
        payload("restore", "design-history-absent")), "not_found");
      assert.deepEqual(errorDetails(foreignError), errorDetails(absentError));
    });
    await t.test("list: a real foreign cursor and malformed cursor cannot cross scope", async () => {
      for (const [label, cursor] of [["foreign", foreignList.response.result.next_cursor], ["malformed", "not-valid-base64"]]) {
        await rejectsWithoutEffects(`list-${label}-cursor`, request(`history-list-${label}-cursor`, "list",
          { ...payload("list"), cursor }), "invalid_request");
      }
    });

    const targetDigest = local.child.artifact.content_hash.slice("sha256:".length);
    const targetPath = join(objectRoot, "objects", "sha256", targetDigest.slice(0, 2), targetDigest);
    const originalBytes = await readFile(targetPath);
    const corruptBytes = Buffer.from(originalBytes);
    corruptBytes[corruptBytes.length - 1] ^= 1;
    await writeFile(targetPath, corruptBytes);
    const corruptedRestore = request("history-restore-corrupt", "restore", payload("restore"));
    try {
      for (const operation of ["list", "compare", "restore"]) await t.test(`${operation}: stored artifact hash mismatch prevents exposure or selection`, async () => {
        // The public API's closed error set deliberately maps the Store's
        // integrity_error to failed. Do not invent a new public error code.
        await rejectsWithoutEffects(`${operation}-corrupt-bytes`, operation === "restore" ? corruptedRestore
          : request(`history-${operation}-corrupt`, operation, payload(operation)), "failed");
      });
    } finally {
      await writeFile(targetPath, originalBytes); // Explicit fixture repair, never an API recovery side effect.
    }
    await reader.close();

    const reopened = await start("history-reopened");
    for (const [target, revision] of [[local.child, 1], [local.parent, 2]]) {
      const restored = await reopened.invoke(request(`history-valid-restore-${revision}`, "restore", {
        brief_id: SCOPE.brief_id, target_design_version_id: target.design_version_id, expected_selection_revision: revision }), localPrincipal);
      assert.equal(restored.response.ok, true, JSON.stringify(restored.response));
      assert.deepEqual(restored.response.result.selection, { ...SCOPE, design_version_id: target.design_version_id,
        design_hash: target.design_hash, revision: revision + 1 });
      noForeignMaterial(restored.response);
      noWork(restored);
    }
    const beforeFailedReplay = snapshot();
    const failedReplay = await reopened.invoke(corruptedRestore, localPrincipal);
    assert.equal(failedReplay.response.ok, true);
    assert.equal(failedReplay.response.replayed, true);
    assert.equal(failedReplay.response.job.status, "failed");
    assert.equal(failedReplay.response.job.error.code, "failed");
    assert.equal(failedReplay.response.result, undefined);
    noForeignMaterial(failedReplay.response);
    noWork(failedReplay);
    assert.deepEqual(snapshot().tables, beforeFailedReplay.tables, "repairing fixture bytes never turns a failed restore replay into a selection change");
    await reopened.close();
    const final = snapshot();
    assert.deepEqual(final.tables.design_versions, original.tables.design_versions);
    assert.deepEqual(final.foreign, original.foreign);
    assert.deepEqual(await objectInventory(), originalObjects);
    assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
    const summary = { schema_version: "creative-public-history-boundaries/1", runtime: process.version,
      provider_mode: "mock", commerce_mode: "simulated", artifact_origin: "independently synthetic PNG fixtures",
      native_decoder_claim: false, package_tarball_sha256: tarballHash, installed_consumer: consumerRoot,
      worker_count: records.length, worker_pids: records.map((record) => record.pid), tenant_count: 2,
      published_versions: 4, shared_action_ids_are_tenant_scoped: true, negative_cases: cases,
      local_final_selection_revision: 3, history_operation_provider_calls: 0, history_operation_reservations: 0,
      corruption: { declared_sha256: targetDigest, injected_sha256: hash(corruptBytes), restored_sha256: hash(await readFile(targetPath)),
        repair_origin: "explicit fixture byte restoration after the negative cases" },
      immutable_rows_sha256: hash(JSON.stringify(final.tables.design_versions)),
      foreign_state_sha256: hash(JSON.stringify(final.foreign)), object_inventory: originalObjects,
      limitations: ["Trusted principals and provider/Finance boundaries are synthetic", "No live membership or external owner acceptance",
        "Public integrity failures use the existing failed error code", "No power-loss or production-host qualification"],
      evidence_root: evidenceRoot ?? null };
    await writeFile(join(root, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    t.diagnostic(JSON.stringify({ ...summary, negative_cases: cases.length }));
  });
