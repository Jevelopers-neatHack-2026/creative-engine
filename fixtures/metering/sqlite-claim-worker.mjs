import { DatabaseSync } from "node:sqlite";
import { createSqliteTelemetryOutbox } from "../../src/telemetry/sqlite-outbox.mjs";

const database = new DatabaseSync(process.argv[2], { timeout: 5000 });
try {
  const outbox = createSqliteTelemetryOutbox({
    database,
    clock: () => 1_000_000,
    claimLeaseMs: 30_000,
    idFactory: (kind) => `worker:${process.pid}:${kind}`,
  });
  const claimed = await outbox.claimPending({ limit: 1 });
  const response = {
    refs: claimed.records.map((record) => record.record_ref),
    claim_token: claimed.records[0]?.claim_token,
  };
  process.stdout.write(`${JSON.stringify(response)}\n`);
  if (process.argv[3] === "crash-after-claim") process.exit(73);
} finally {
  database.close();
}
