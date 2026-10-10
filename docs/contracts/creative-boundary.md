# Creative consumer contract proposal

This document and its validators are a local consumer proposal for CE-C01 (#3), owned by Creative and fulfillment. They do not claim that shared-contracts, event-intelligence, or the application membership owner has accepted or published these shapes. The canonical owner gate is tracked in [canonical-owner-agreements.json](canonical-owner-agreements.json); until the named owners record their artifact commit, schema hashes, and review, **make acceptance TARGET=contracts** must fail.

The local offline fixture command is **make check TARGET=contracts MODE=mock**. It verifies only the proposal and its fixtures. It does not verify the Event Intelligence producer, application authorization, an integrated UI consumer, or a live creative runtime.

The package runtime floor is Node.js 22.23.3. CI checks that exact Node 22 patch and the local development pin 24.15.0 on the named Ubuntu 24.04 runner. The local 22.23.3 binary is the official Darwin arm64 archive; no Linux-server patch or production host was inspected. Node.js documents ESM as fully supported in [the v22.23.3 ESM reference](https://nodejs.org/download/release/v22.23.3/docs/api/esm.html), and lists the patch in its [official v22 archive](https://nodejs.org/en/download/archive/v22.23.3).

## Owners and acceptance boundary

The master checklist IDs and roles remain unchanged:

| Acceptance ID | Global owner | Creative contribution |
| --- | --- | --- |
| CON-01 — Contract compatibility | Agent and research | Supported versions, migration, unknown fields, deterministic hash and consumer fixtures |
| CON-02 — Trusted scope and identity | Agent and research | Negative tenant/project/job/artifact cases against separately trusted context |
| CON-03 — Typed bounded actions | Agent and research | Fixed EditPlan action union and bounded parameter shapes |
| ARC-02 — Single data ownership | Product and frontend | Membership context is an injected trusted input, never body or browser state |
| ART-01 — Versioned design edits | Creative and fulfillment | EditPlan and immutable DesignVersion record/hash proposal |
| ART-05 — Approved asset inputs | Creative and fulfillment | Per-asset permission and evidence references; missing permission remains incomplete |

Affected owner artifacts are shared-contracts issue #1 (published schemas and alias), event-intelligence issue #3 (producer fields and correction/permission semantics), getticketstub.com issue #1 (trusted project membership), and the UI control consumer in creative-engine issue #4 (translator review). Those agreements remain pending. Their roles and anchors are also listed in the proposal manifest and machine gate.

## Wire contract and compatibility

ResearchPackage is an accepted local input alias for EventIntelligencePackage; normalized output always names EventIntelligencePackage. The current local consumer version is 1.1. Version 1.0 is the only older supported input. Unsupported 1.x versions produce unsupported_version; a different major produces unsupported_major.

| Input | Local normalized/accepted form | Result |
| --- | --- | --- |
| EventIntelligencePackage 1.1 | EventIntelligencePackage 1.1 | Validate and preserve non-sensitive additive fields |
| ResearchPackage 1.1 | EventIntelligencePackage 1.1 | Alias to the maintained contract name, then validate |
| EventIntelligencePackage or ResearchPackage 1.0 | EventIntelligencePackage 1.1 | Conservative migration; facts/permissions cannot become approved |
| EventIntelligencePackage 1.2 | None | Typed unsupported-version error |
| EventIntelligencePackage 2.x | None | Typed unsupported-major error |
| CreativeBrief, EditPlan, DesignVersion 1.0 | Same contract 1.0 | Validate exact declared core shape and any supplied references |
| DesignControlSchema 1.0 + creative-controls 1.0/1.1 | Same outer schema and referenced inner version | Hash binds the exact inner payload; mismatches fail |

The required wire envelope uses the catalog names contract, schema_version, event_id, tenant_id, project_id, correlation_id, producer, occurred_at, ingested_at, environment, billing_mode, and source_refs. Applicable workflow_id, run_id, order_id, job_id, design_version_id, artifact_id, logical_operation_id, billable_attempt_id, transport_attempt_id, and provider_request_id are optional strings. An unavailable time is never fabricated; source retrieval time uses retrieved_at_status: "unknown".

The local 1.0 migration is deliberately conservative. Every migrated fact becomes unknown; a previous value moves to candidate_values, and provenance is retained. Legacy permission claims are discarded as authority: a present old permissions field becomes {presence:"unknown",items:[]} and a missing one becomes absent. Missing optional sections become absent. Non-sensitive unknown additive fields are preserved in the normalized package as inert data and included in its canonical hash; consumers must explicitly map known fields into a CreativeBrief. They cannot infer facts, permissions, locks, or executable actions from an additive field. Sensitive credential-like keys are recursively omitted, including inside unknown future objects, and only their field paths plus credential_material_omitted are retained.

Facts and their provenance, source identity, assets, preferences, interpretations, permissions, and locks occupy distinct fields. Facts are verified, conflicting, or unknown; permission is granted, denied, or unknown. A conflicting fact, any unknown fact, or a missing per-asset reproduce: granted record keeps readiness incomplete. A public source, asset, preference, or successful model decision cannot itself create permission.

CreativeBrief preserves the same distinctions and binds its source identity, verified/unresolved fact projection, package version and content hash to a supplied normalized EventIntelligencePackage. When the package is supplied, the validator checks all package facts appear as verified or unresolved and checks their semantic keys, values, states and provenance. It also requires the permission section, asset/action pairs, statuses and evidence references to match the research package exactly; a brief cannot promote unknown or absent permission to granted. Scope comes from a separate trustedScope argument. Body fields are compared against host-provided tenant/project and, when present, job/artifact/design/brief IDs.

## Controls, edit plans, and versions

DesignControlSchema is an outer DesignControlSchema/1.0 record. control_contract: "creative-controls" and control_schema_version: "1.0" | "1.1" identify the UI-owned inner format. The producer wire schema version is the combined string, such as "creative-controls/1.1"; the outer wrapper carries the suffix in control_schema_version. The validator binds tenant_id, project_id, expected_versions and canonical SHA-256 to the supplied producer payload. The portable valid fixture is copied from controls commit `b81b08c67081bc10bbb553518a8d2353520754e7`, source `fixtures/controls/valid.json`, whose raw SHA-256 is `c1915344cf2dc8743be05148f94da76cf0c84567d81430b94fda42416ebefcee`. This is local consumer conformance only; owner agreement is pending. This is a translation boundary, not a second controls implementation; the UI store remains the control owner.

EditPlan operations and step actions are limited to concept.generate, image.edit, composition.update, and correction.apply. Each action has a fixed parameter shape, bounded counts and byte limits, and references checked against supplied source, design, artifact, asset, and fact IDs. Unknown action names and unknown parameter keys fail with typed errors. Every plan requires base.brief_hash and base.design_hash; a consumer with current versions supplies both hashes for stale-plan rejection. expected_result names DesignVersion/1.0 and its parent version.

DesignVersion records a parent ID (or null for a root), artifact content hash, source references and brief hash. Its nested artifact.artifact_id must match the separately trusted artifact identity (and any outer artifact_id). Its design_hash is canonical SHA-256 of the record with design_hash omitted. A changed field therefore requires a new design hash and a new immutable version.

Canonical JSON sorts object keys recursively, retains array order, emits no insignificant whitespace, accepts finite JSON values only, serializes negative zero as zero, and hashes UTF-8 bytes with SHA-256 using the sha256:<lowercase hex> representation. The fixture manifest records the exact schema proposal hash and fixture content hashes.

## Errors and privacy

Validators throw ContractError with typed code, contract name, field path and safe message. Compatibility, action, scope, reference, hash, and credential failures remain distinguishable. Common examples are unsupported_major, unsupported_action, scope_mismatch, invalid_reference, hash_mismatch, and forbidden_sensitive_field.

The privacy fixture uses only the literal SYNTHETIC-NOT-A-REAL-CREDENTIAL. It places a declared admission_credential in source identity, a fact whose semantic `key` is admission_credential, and source credentials in unknown nested fields. Credential values are omitted; a credential-valued verified fact is downgraded to unknown. Source identity and fact provenance remain, and redaction reasons name paths without copying values. Credential-like fields on CreativeBrief, EditPlan, DesignControlSchema, or DesignVersion outputs are rejected.

The acceptance gate requires top-level `proposal_state: "accepted"`, non-placeholder owner commits, accepted input files with matching byte and canonical schema hashes, and review JSON whose hash and contents bind the owner role, commit, hashes, and accepted inputs. It also requires a separate hash-linked independent owner-verification record. The code checks local consistency; it cannot authenticate an external owner or reviewer, so a human independent reviewer must verify the owner publication before recording that status. Existing records are pending, so the gate must fail. A local proposal or fixture pass cannot establish owner acceptance.

## Pending owner decisions

This local proposal does not settle the producer's canonical source identifiers, how the application proves project membership, the shared contract publisher's unknown-field and migration guarantees, the exact accepted UI controls payload whose hash the wrapper binds, or final approval/permission evidence semantics. The [agreement gate](canonical-owner-agreements.json) is intentionally pending for Agent and research, Product and frontend, the Event Intelligence producer, and the UI controls consumer. A successful local fixture run cannot clear it.
