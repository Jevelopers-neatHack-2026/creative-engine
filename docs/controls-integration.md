# Structured controls and Apply: local consumer proposal

CE-05 (#17) implements an allowlisted control producer, defensive browser consumer,
server validator, and durable creative Apply outbox. The executable roundtrip uses
**mock application identity and mock brief/version state**. Validation, SQLite
transactions, HTTP requests, browser interactions, hashes and durable restart
checks are real local execution. Provider, harness, production, approval and
financial integrations are pending. This is neither shared-contract publication
nor an external consumer acknowledgement.

## Run the checks

The production runtime target is **Node 22.23.3**, with **Node 24.15.0** retained
for local development. Engines and runtime checks allow these patch levels or
newer patches/minors within their respective 22.x/24.x lines; other majors and
earlier versions are rejected. Exact evaluated pins are listed below, not every
version admitted by that compatibility range. Production control validation/outbox
uses native Node modules and needs no npm package. The browser fixture has its own
pinned lockfile.

The official [Node 22 SQLite API](https://nodejs.org/download/release/v22.23.3/docs/api/sqlite.html)
documents `node:sqlite` from 22.5 and flag-free access from 22.13, while retaining
its experimental status. Controls use string database paths, `DatabaseSync`,
`exec`, `prepare`, statement `get`/`all`/`run`, and `close`; no loadable extension
or Node 24-only SQLite API is required. **22.13 is documented API availability,
not a tested/supported minimum for this implementation.** The evaluated Node 22
pin is 22.23.3 and needs no `--experimental-sqlite` flag.

```sh
node --test tests/controls/actions.test.mjs
npm ci --prefix examples/frontend-action-roundtrip
```

From `examples/frontend-action-roundtrip`, install the actual browser:

```sh
npx playwright install chromium
```

From the repository root, exercise both suites and write sanitized evidence:

```sh
node fixtures/controls/check.mjs --browser --out fixtures/controls/evidence-node22.json
```

To inspect the fixture manually, run `npm start` in
`examples/frontend-action-roundtrip` and open `http://127.0.0.1:4317`. It listens
only on loopback and always uses synthetic fixture identity. Its `/__fixture/*`
state/reset routes exist solely for browser tests. Do not deploy this example as
an application authentication service. Its temporary database is intentionally
removed on orderly shutdown; durable adapter tests use an explicit database path
and reopen it. Real applications own storage location and backup policies.

The dedicated `Controls offline roundtrip` workflow uses an explicit
**22.23.3 / 24.15.0** matrix and runs the same Node suite,
locked `npm ci`, Chromium and axe tests, then uploads separate
`controls-mock-evidence-node-<version>` artifacts.
Remote CI results and artifact URLs must be recorded by the supervisor after
publication. Workflow definition alone is not a successful remote CI run.
The workflow pins Ubuntu 24.04 and official `actions/checkout`, `setup-node` and
`upload-artifact` v4 tag targets to full commit SHAs. Tag refs were checked through
the official repositories' GitHub API on 2026-10-10 before pinning.

## Local contracts and migration

`src/controls/index.mjs` exports the runtime boundary; its matching `index.d.mts`
declares the ESM types. A real `.mts` consumer imports this public `.mjs` path
under TypeScript 5.9.3 with `strict`, `module: NodeNext`, `moduleResolution:
NodeNext`, no `allowJs` and no `skipLibCheck`. It exercises the schema, Apply,
outbox and wrapper APIs and checks that unsupported versions/privileged intents
produce type errors. `npm run test:types` from the nested fixture runs this
consumer; the combined `--browser` command and both CI runtimes include it.
The current supported pairs are `creative-controls/1.0` with
`creative-apply/1.0`, and `creative-controls/1.1` with `creative-apply/1.1`.
Both pairs currently use the same bounded field semantics. An older client must
explicitly negotiate a supported pair; the server never silently downgrades an
Apply payload. An application can remove older support via the trusted
`supported_schema_versions` projection. Unsupported versions and mismatched pairs
return `unsupported_version`. Unknown Apply fields are **rejected**, including
unknown additive fields. Optional `correlation_id` is accepted and conveys no
authorization. Correlation is part of the stored full action hash: changing it
under an existing action identity returns `action_conflict`. Schema labels are
rendered as text, and controls are fixed native selects; generated code, HTML,
handlers and privileged actions have no execution path.

This is a local specialization of the documented
[DesignControlSchema catalog entry](https://github.com/Jevelopers-neatHack-2026/shared-contracts/blob/c4caaccc2ea63b273eeac17ed89af8ac64f6bbde/docs/contract-catalog.md).
The catalog describes a proposed interface, not an implemented canonical schema.
CE-C01's separate local wrapper uses the following crosswalk:

| Outer local wrapper | Control producer |
| --- | --- |
| `contract: DesignControlSchema`, `schema_version: 1.0` | Wrapper contract version, independently versioned |
| `control_contract: creative-controls` | Local producer contract family |
| `control_schema_version: 1.0` or `1.1` | Suffix of the inner `schema_version` |
| `tenant_id`, `project_id` | Exact inner scope, checked against trusted context |
| `expected_versions` | Exact brief, design and composition snapshot |
| `control_schema_hash: sha256:<hex>` | SHA-256 of canonical, sorted-key inner schema JSON |
| `event_id`, `correlation_id`, producer, `occurred_at`, `ingested_at`, environment, billing mode, source references | CE-C01/common envelope responsibility |

`controlContractReference(schema)` generates the reference fields;
`assertControlContractBinding(wrapper, schema)` validates their exact equality.
It does not validate common envelope metadata or claim external agreement.
Scope, versions, hash or control-version mismatches reject the binding. No
automatic migration may expand options or permissions. Canonical publication and
affected producer/consumer review remain prerequisites to external adoption.
Serialized `valid.json`, `invalid.json`, `older.json` and `unknown-field.json`
fixtures exercise producer/consumer compatibility and typed Apply outcomes.

## Trusted state and Apply API

```js
import { ApplyStore, createControlSchema } from './src/controls/index.mjs';

const outbox = new ApplyStore('/application-owned/creative-controls.sqlite',
  trustedPrincipal => {
    // Synchronous current projection from the application's authorized state.
    const current = readCurrentAuthorizedState(trustedPrincipal);
    return {
      schema: createControlSchema(current),
      can_apply: current.can_apply,
      supported_schema_versions: ['creative-controls/1.0', 'creative-controls/1.1'],
      permitted_asset_ids: current.permitted_asset_ids,
      dispatchable_routes: current.dispatchable_routes,
    };
  });

const accepted = outbox.apply(serverAuthenticatedPrincipal, untrustedRequestBody);
const handoff = outbox.dispatch(serverAuthenticatedPrincipal, accepted.operation_id);
```

`readCurrentAuthorizedState` and `serverAuthenticatedPrincipal` above are required
application integrations, not supplied implementations. Trusted principal has
`actor_id`, `tenant_id`, and `project_id`. The request body can repeat scope for
binding but cannot supply principal, permissions, locks, asset URLs or executable
handlers. `can_apply` must reflect current actor membership and project access.
The synchronous projection must return current versions, available operations,
allowed options, defaults, locks and asset grants. Creative brief and version
stores remain their owners; the controls module stores no artwork or immutable
DesignVersion. Failure to read the projection returns `unavailable`.

Controls are derived from `available_operations` and the trusted brief projection.
Supported composition fields are name size, layout and permitted logo position;
style is an artwork edit. Logo controls require a durable permitted asset ID.
Stacked layout asks a bounded follow-up question. Its baseline is supplied by
the trusted version projection as `follow_up_answers: { q01: 'balanced' | 'name' }`;
`follow_up_locks` independently lists locked question IDs. Missing baseline data
fails closed when layout controls are available. The schema embeds that baseline
and lock state in its hash, and `defaultDraft` includes currently active answers.
A follow-up-only change emits the typed composition field `layout_emphasis`.
Unchanged active answers are also included in the composition handoff. Each
composition task carries `follow_up_state` for all exposed questions, including
inactive baselines, and acknowledgement verifies that current trusted follow-up
state matches it. This also prevents an unrelated edit from resetting a latent
selection while its conditional question is hidden.
The application/version store must persist this state with the composition
version: a subsequent size edit must preserve the selected emphasis. An inactive
question retains its trusted baseline for later reactivation, while inactive
answers must be omitted from Apply. Updating to this local schema requires a
fresh schema/hash; existing queued actions cannot be silently reinterpreted.
Locked controls and follow-up questions remain visible
and disabled in the consumer, and the server independently rejects changed locked
values. Options, follow-up answers and all three versions are checked by the
server. The fixture fixes the logo position to prove this boundary. Altered locks,
options, asset grants and permissions are checked again at dispatch.

An Apply body contains explicit versions and `intent: apply`, an opaque stable
`action_id`, scope, `brief_id`, `draft: { selections, answers }` and a SHA-256
`draft_hash` of canonical draft JSON. `control_schema_hash: sha256:<hex>` binds
the exact inner schema bytes for the explicitly negotiated consumer version.
Changed options, locks, defaults or task definitions under unchanged expected
versions return `stale_schema`. Dispatch also compares recomputed tasks against
the immutable stored tasks before returning them. An unchanged draft is rejected as
`no_changes`. Dropdown changes remain entirely local: no request, JEV call or
image call is triggered. The browser disables editing and refresh during a
pending submission, retains its action identity for retry, and announces typed
errors through a focused alert. Refresh resets the draft for fresh review and
retains an already accepted operation so it can be cancelled.

## Durable identity and typed handoffs

SQLite storage version 1 uses WAL, `synchronous=FULL`, bounded busy timeout and
`BEGIN IMMEDIATE` transactions. The action dedup row and operation/outbox row are
one record committed atomically with the sanitized audit entry. A unique
`(tenant_id, project_id, action_id)` constraint provides durable identity across
processes and restarts. An action is bound to its original actor and whole action
hash. Duplicate delivery after a lost response returns the original operation
reference; changed payload under that identity returns `action_conflict`.
One queued/ready operation per tenant/project prevents conflicting Apply actions
from silently rebasing. Stale or conflicting responses include current versions
only after authorization. Unknown storage versions fail startup rather than
silently changing persisted meaning.

Accepted operations are `creative-control-operation/1.0`, kind
`creative.control.apply`, with separate typed `composition.update` and
`artwork.edit` tasks. Compound changes produce both tasks in a single durable
operation identity. Composition tasks explicitly specify zero image and JEV
calls; all typed controls bypass classification. Apply and handoff carry
`approval: false` and `purchase: false`. Artwork choices are representable and
queued in the fixture, but dispatch returns `unavailable` because the fixture has
no billable artwork capability. No provider client is loaded by these modules.

`dispatch(principal, operation_id)` rechecks current authorization, versions,
locks, values, asset grants and eligible routes immediately before releasing a
typed handoff. It records `ready` durably; repeated retrieval returns the same
logical operation identity. **Ready means a validated handoff, not an executed
job, published artifact or reserved financial hold.** The harness remains the
owner of workflow jobs and leases. Its future consumer must deduplicate this
logical operation identity and enforce fresh authorization/version checks at the
actual billable/publication boundary. The local transaction does not atomically
lock a remote brief/version/auth store; integrated concurrency/CAS behavior at
that boundary remains pending. A ready operation continues to block another
Apply until cancellation or an authorized downstream acknowledgement.

`acknowledge(trustedConsumer, operation_id, receipt)` requires separate current
`can_acknowledge: true` authority from the trusted state callback. Ordinary browser
principals and the HTTP example cannot grant this authority or call this method.
The receipt has an opaque `completion_id`, durable `result_ref` and exact
`applied_versions`. A ready operation can complete only when the current trusted
version projection matches the receipt, unrelated versions remain unchanged, each relevant
design/composition version has changed identity, and the changed control defaults match
the stored operation. Receipt hash/storage and the completed transition are atomic.
Exact acknowledgements replay safely after restart; changed receipts conflict.
Completed rows no longer occupy the queued/ready unique slot, so the next revision
can Apply. A completed operation cannot be cancelled or redispatched. The local
test advances a declared mock consumer projection to exercise this lifecycle;
it does not generate an artifact or prove an external consumer integration.
Harness/application integration must attest the actual result and reconcile
the receipt with their immutable version store before acknowledgement.

`cancel(principal, operation_id)` can cancel the actor's own local queued/ready
handoff even after edit permission is revoked. It never changes external jobs or
financial holds. Late Apply replay or dispatch cannot revive a cancelled row.
No UI timeout releases a hold: there is no ledger/hold lifecycle in this module.
Cancellation of an already consumed external operation requires the harness's
own cancellation protocol, and is not proved here.

Audits contain typed result codes, hashes and opaque operation/audit references.
Invalid payloads, source strings, credentials and customer text are never stored
in audit records. Valid rows store only the allowlisted action and typed operation.
If audit storage fails, the transaction rolls back; the response reports
`audit_status: unavailable` rather than inventing a diagnostic reference.
Durable retention/backup and data-access policy remain application obligations.

## Executed evidence and acceptance limits

The runtime addendum was locally exercised on **Node 22.23.3 and Node 24.15.0**,
using Playwright 1.58.2, Chromium 145.0.7632.6 and axe 4.11.1. Each final combined
command passed **19 server tests, the strict NodeNext consumer typecheck, and 13
actual Chromium browser tests**, with no
skipped scenarios. `fixtures/controls/evidence-node22.json` and
`fixtures/controls/evidence-node24.json` retain the respective current results;
`evidence-run.json` preserves the original pre-addendum Node 24 run (15 + 11).
These sanitized records pin schema/action hashes and a SHA-256
fingerprint of the controls source, server/browser tests, fixture inputs/runner,
nested manifests and dependency lock, controls workflow and this documentation.
The evidence lists every hashed path; generated evidence/reports and installed
dependencies are excluded. Browser JSON output and a screenshot are generated under the ignored
`examples/frontend-action-roundtrip/test-results` directory and uploaded by CI.
No OpenAI, JEV or other paid application-provider calls were made.

The isolated Node 22 toolchain was the official `node-v22.23.3-darwin-arm64`
distribution. Its archive SHA-256
`23b25245dcfb9af7262f8ff142e9e2e0af025368117329e7a7458a51e5922f53`
matches the official
[SHASUMS256](https://nodejs.org/download/release/v22.23.3/SHASUMS256.txt) entry.
Both local runs are **macOS arm64 evidence**. The check runner puts its own Node
directory first in child-process PATH, so Playwright, the HTTP server and workers
use the same selected runtime. Node 22's experimental SQLite warnings remain
visible. The explicit Ubuntu 24.04 CI matrix is configured but not yet a recorded
remote result. **CloudLinux/CageFS x86_64 compatibility remains pending**: the
user supplied only `node22`, not an exact patch or accessible server. No server
connection, filesystem/SQLite locking probe, browser dependency install or
deployment was performed there. Local runtime compatibility does not certify
that target host; retain its exact patch, architecture, permissions and SQLite
durability/locking validation as a release prerequisite.

The browser exercised Tab navigation, native select type-ahead, skipped locked
fields, required follow-up controls, Enter submission, focus on error and
`role=status` announcements. Axe found zero violations before Apply and after
handoff. The initial ArrowDown-only macOS headless test did not commit native
selection; the executed test uses native keyboard type-ahead and Tab/Enter.
This is actual browser evidence, not a screen-reader certification or full
customer frontend acceptance.

| Cases | Actual local evidence | Remaining acceptance |
| --- | --- | --- |
| Valid draft/explicit Apply, CE-JEV-03/04/05 | No draft POSTs; one typed handoff; zero image/JEV paths; composition and artwork tasks distinct | Active harness routing and providers |
| CON-01 / CON-03 | Supported old/current pairs; unknown fields, privileged intent, invalid values/code/schema rejected; exact wrapper crosswalk | Canonical schema and affected external consumer acknowledgement |
| CON-02 | Forged tenant/project/actor denied; dispatch scope checked; browser negative requests | Actual application issuer and API/job/artifact integration |
| Duplicate/concurrent/stale, ART-01 contribution | Four simultaneous SQLite connections; lost-response browser retry; restart; three-version stale checks; conflict retains current metadata | CE-08 actual version store and integrated CAS |
| Cancellation/revocation | Real queued rows; post-validation permission/asset/lock/option/version recheck; cancelled replay denied | Harness cancellation and financial in-flight hold behavior |
| ART-02 contribution | Every selection/Apply/handoff remains nonapproval/nonpurchase | External exact-artifact approval issuer and invalidation |
| EVAL-03 / EVAL-04 contribution | Mock boundaries labelled in UI/docs/evidence; synthetic data; hashed sanitized audits | Actual release evidence and privacy review |

Original global IDs and owner roles remain as defined in the
[authoritative checklist](https://github.com/Jevelopers-neatHack-2026/integration-evals/blob/ff1f6d2df816ebbff34742f51be728fcb5c28cb5/planning/acceptance-checklist.md).
CON-01/02/03 belong to Agent and research; ART-01 to Creative and fulfillment;
ART-02 and EVAL-03 to Product and frontend; EVAL-04 to Finance and reliability.
This leaf contributes only its controls slice. CE-01 public API, CE-02 real brief,
CE-08 version persistence, neutral contract publication and application identity
are unsatisfied acceptance dependencies. The full CE-05 closure gate and release
gate remain open after offline implementation.

The fixture uses ordinary HTML and HTTP, not ChatKit. The current official
[ChatKit action documentation](https://developers.openai.com/api/docs/guides/chatkit-actions)
was read on 2026-10-10; its untrusted-action boundary informs the server validation.
There is no claim of ChatKit SDK compatibility or actual ChatKit application use.
