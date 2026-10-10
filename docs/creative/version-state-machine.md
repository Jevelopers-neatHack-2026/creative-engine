# Durable creative version state

`CreativeVersionStore` is the local durable adapter for immutable `DesignVersion` records and their exact artifact bytes. It stores metadata in SQLite and bytes in a content-addressed object directory. `createCreativeVersionApiPorts` binds that adapter to the API jobs and storage ports using one `DatabaseSync` connection so a successful version publication, selection update, and completed job result commit together.

The store schema is version 3. It migrates schema versions 1 and 2 additively and rejects unsupported future versions. Each version record is scoped by tenant, project, and brief and retains its parent ID/hash, brief hash, canonical design hash, artifact hash, source/configuration context, creation job/action identities, billable and transport attempt IDs, provider request IDs, usage references, and trace references. The DB foreign key keeps parent lineage inside the same brief. Reads revalidate the canonical record and rehash the bytes before returning a version or artifact.

## Publication and recovery

Generation and image edit use this sequence:

1. The API creates or replays a scoped job/action identity and the metering port reserves an attempt.
2. Before dispatch, the jobs port atomically compares the current lease/cancellation state and creative context fence while recording a transport intent.
3. The runtime persists the billable attempt, transport, provider, usage, and trace identities to the job row before staging artifact bytes.
4. The storage port snapshots the bytes, hashes the private snapshot, writes and flushes a staging file, and links it to its immutable SHA-256 path. It then records a `commit_intent` containing the design, bytes hash/length, parent and brief context, selection expectation, evidence, and action result.
5. The paired API publication opens a short SQLite `BEGIN IMMEDIATE` transaction, rechecks the active job lease and creative-context fence, validates the staged object, inserts the immutable version row, performs selection compare-and-set when requested, marks the action committed, and writes the completed job result. The SQLite transaction commits these metadata changes together.

The object write precedes the SQLite commit. A crash before a durable commit intent can leave an unreferenced object, which is harmless and not listed. A crash after the intent can be reconciled from the stored intent and bytes; recovery can commit the exact same version without another provider call. Missing or mismatched bytes, expired leases, cancellation, changed context, and stale selection stay invisible or become an explicit conflict/unknown outcome. They never trigger a new provider dispatch. Attempt evidence remains available for external reconciliation when a late worker returns after cancellation.

The paired adapter does not run provider, metering, approval, consumer, decision, inspection, or trace callbacks while its SQLite publication transaction is open. Handoff currently fails with typed `unavailable` before job creation or any verifier/context/destination/consumer callback, and the adapter also rejects handoff completion as a defense in depth. A durable external-result staging protocol is still required before this paired adapter can accept an external consumption receipt.

## Branches, selection, and restore

Versions are immutable. A normal generation or edit advances the selected pointer with an expected revision and expected prior ID/hash. If that compare-and-set is stale, the request fails instead of silently rebasing. An explicit parent branch keeps the requested parent ID/hash and does not move the selected pointer; concurrent branches from the same retained parent can coexist. Listing uses a stable `(occurred_at, design_version_id)` order and scoped keyset cursor. Compare loads both records in the same tenant/project/brief scope.

Restore validates the exact retained target and its bytes, then compare-and-sets only the selected pointer. It creates no `DesignVersion`, does not change lineage, and dispatches no provider or metering request. A selection revision advances on each successful move, including restoration to the same existing version.

## Local boundaries and durability limits

The adapter enables SQLite WAL, `synchronous=FULL`, foreign keys, and a bounded busy timeout. Object staging flushes file contents before publication and flushes the containing directories after link/unlink. Newly created object-directory entries are flushed through their parent directories. The tests exercise real process exits at four object/metadata/job boundaries and reopen the same SQLite file and object tree.

These checks establish local process-crash recovery on the test filesystem. They do not certify sudden power-loss behavior, filesystem/hardware cache guarantees, the production Linux server patch, CloudLinux/CageFS permissions or mount semantics, backup/restore, multi-host coordination, or operational retention/garbage collection. Production hosting needs a separate durability and permissions verification.

This adapter is not a financial ledger, approval issuer, renderer, provider transport, or external source-ingestion service. Metering and approval authority remain injected ports. A local test fixture or completed local job does not establish external producer/consumer acceptance or close CE-01/CE-08 owner agreements.

## Offline checks

From the repository root, the source suites are:

```sh
node --test tests/versions/api-integration.test.mjs tests/versions/store.test.mjs tests/api/creative-api.test.mjs
node examples/frontend-action-roundtrip/node_modules/typescript/bin/tsc --noEmit --strict --skipLibCheck false --module NodeNext --moduleResolution NodeNext --target ES2022 tests/versions/public-consumer.mts
```

The root `make check TARGET=versions MODE=mock` and package subpath export are serialized with the root build/CI owner and must be integrated before the versions package surface is advertised as available.
