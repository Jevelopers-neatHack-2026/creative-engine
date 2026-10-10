# Creative DecisionPort consumer proposal

This is a local, standalone consumer proposal for CE-C02 (#4), owned by Creative and fulfillment. It defines question examples and validators without importing the harness runtime or implementing a JEV transport. It does not claim canonical DecisionPort acceptance or active model routing. **make check TARGET=decision-contract MODE=mock** runs local fixtures only. **make acceptance TARGET=decision-contract** must fail until the external schema and consumer owner records are accepted with commit, hash, and review evidence.

## Acceptance IDs and owners

The master checklist IDs and owner roles remain unchanged:

| Acceptance ID | Global owner | Creative contribution |
| --- | --- | --- |
| CON-01 — Contract compatibility | Agent and research | Versioned request/result fixtures and typed errors |
| CON-03 — Typed bounded actions | Agent and research | Stable keyed questions, candidate allowlists and bounded policies |
| FIN-01 — Attempt level metering | Finance and reliability | Logical operation, billable attempt, attempt number/limit, budget references, explicit usage completeness |
| AGT-03 — Bounded recovery | Agent and research | Attempt cap, deadline, cancellation reference, timeout and retryable error shapes |
| AGT-04 — Untrusted content handling | Agent and research | Adversarial state is data only; results cannot grant permissions or routes |

Affected owner artifacts are shared-contracts issue #1 for neutral shape publication, agent-harness issue #5 for canonical contract/fixture coordination, and agent-harness issue #15 for sole JEV transport ownership. All remain pending. Actual active routing is a separate integration-evidence obligation; these fixtures make no live or paid call.

## Request and result envelope

DecisionPort Request/Result schema version is 1.0. The common envelope uses catalog names contract, schema_version, event_id, tenant_id, project_id, correlation_id, producer, occurred_at, ingested_at, environment, billing_mode, and source_refs. It also includes request_id, logical_operation_id, and billable_attempt_id. The caller supplies trustedScope separately; request/result body scope is compared to it and never establishes identity.

A request requires a model_policy with the pinned model identifier jev-1.13.0 and policy version, attempt_number within an attempt_limit of 1 to 3, budget_scope_ref and reservation_ref, deadline_at, cancellation_ref, and a bounded question set. The local contract rejects the moving alias jev-latest. It does not reserve or settle money. Finance owns the actual reservation and attempt accounting.

State is at most 16 KiB UTF-8. It may contain bounded text and up to 16 structured observations with observer type/ID, content hash, uncertainty status, bounded summary, and optional source reference. It has no raster field. Raw image bytes are outside this neutral interface.

Question IDs are stable lowercase identifiers, and result keys must exactly equal request question keys. Choice has 2 to 255 named eligible candidates with criteria text and returns a candidate, a finite probability distribution keyed exactly by the candidate IDs, and confidence. Score has 2 to 10 ordered labels and returns a probability-weighted score, the exact index-to-label legend, a finite distribution, and confidence. Noul returns only a probability in [0,1]; confidence is not part of that answer and is rejected if fabricated.

Each question includes question_schema_version and policy_version. Choice/Score additionally declare minimum_confidence and low_confidence_action: review. Noul declares an inclusive uncertain_probability_band with lower < upper. A result cannot claim complete when a policy trigger requires review. Missing/foreign question IDs, choice IDs, legends, probability keys, non-finite values, unsupported model/schema/policy versions, and incomplete usage are typed failures.

## Sequencing and safe outcomes

Independent questions can be planned in one batch only if none names a dependency. Dependent question IDs are ordered by a directed acyclic graph planner and run in sequential batches. The planner returns IDs only; it does not put an earlier answer into a sibling question or batch. A later dependent decision is a new request whose bounded state is created by its caller from validated evidence. This package has no hidden execution loop.

Per-question answers are tagged answered, abstain, or unavailable. Complete requires a valid answer for every question and no policy uncertainty trigger. Review requires an abstention, unavailable item, low-confidence Choice/Score answer, or Noul probability inside the declared uncertainty band. Timeout, cancellation, and unavailable results require typed error codes and cannot contain an answered result. Token usage is complete, incomplete, or unknown; unknown usage must not contain fabricated counts.

The only local fallback helper maps complete decisions to review_required because a decision result grants no authority; review remains review_required; unavailable, timeout, and cancellation map to unavailable. There are no permission, budget, approval, or tool-eligibility result fields. Untrusted source instructions may appear in bounded text or observation summaries but do not change trusted scope, budget references, operation IDs, cancellation, or question allowlists.

## Provider documentation and integration boundary

The provider-facing shape is intentionally not duplicated as a transport client. The wrapper is a local DecisionPort proposal. Official TypeSafe documentation checked on 2026-10-10 describes Choice outputs as a chosen option with probabilities and confidence, Score outputs as a weighted score with an index legend, probabilities and confidence, and Noul outputs as a probability without confidence. The API and model documentation also describe returned model and input/output usage metadata. These documents support this proposed mapping only; this work made no API call and establishes no account capability, provider response, cost, quality or active route:

- [TypeSafe API](https://docs.typesafe.ai/api)
- [TypeSafe confidence](https://docs.typesafe.ai/confidence)
- [TypeSafe Choice](https://docs.typesafe.ai/primitives/choice)
- [TypeSafe Score](https://docs.typesafe.ai/primitives/score)
- [TypeSafe Noul](https://docs.typesafe.ai/primitives/noul)
- [TypeSafe models](https://docs.typesafe.ai/models)

The neutral request's model_policy is mapped by the harness-owned adapter. Its returned model identifier is checked against the pin. The harness remains the only JEV transport owner; no network function, SDK, credential, retry loop, or provider-specific dependency lives here.

## Failure and acceptance boundary

Decision errors distinguish timeout, cancellation, provider_unavailable, malformed_response, unsupported_model, scope_mismatch, and deadline_exceeded. Each includes retryability, a safe user message, a review/unavailable fallback recommendation, and optional diagnostic and retry-after references. Retryability alone never increases the declared attempt limit or budget.

Canonical neutral shape publication, harness consumer review, and the transport-owner evidence record remain pending in [canonical-owner-agreements.json](canonical-owner-agreements.json). C02 can therefore pass its offline conformance command while the canonical acceptance gate continues to fail. A local fixture pass is not live harness conformance, active routing, or financial evidence.
