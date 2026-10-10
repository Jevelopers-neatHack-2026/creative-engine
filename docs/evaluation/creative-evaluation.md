# Creative evaluation policy proposal

**Status: proposed; external acceptance pending.** This document and `evals/creative/` preserve the CE-Q01 (#8) proposal and its executable validation rules. They do not report a completed corpus, owner approval, model result, or quality measurement.

## Workloads and proposed targets

The issue's target sizes and strata are pinned by `evals/creative/validator.mjs` so local edits cannot silently lower the proposal:

- Routing: 160 calibration cases, 400 held-out cases with 50 in each of eight issue-defined intents, and a separate 160-case safety set.
- Visual inspection: 56 calibration cases and 140 held-out cases, with 20 each for valid, unchanged, wrong-subject, drift, corrupt, refusal, and poor outcomes.
- Coverage: at least 20 compound, ambiguous, missing-facts, locks, injection, stale-base, permission, and race cases; at least 60 zero-image composition and 40 typed-control zero-JEV cases.
- Proposed Choice routing requires confidence of at least 0.85 and top probability of at least 0.90. Proposed Noul decisions require yes at least 0.90 or no at most 0.10; otherwise the result is review. Score decisions require the owner-published actual-level rubric described in `creative-rubric.md`.
- The proposed visual plan is 12 briefs across four families, three generations per brief, and one edit per generation. It implies 36 generation and 36 edit trials only after separate budget authorization.

Quality and cost targets in `evals/creative/policy.json` remain proposals until Creative and fulfillment plus Finance and reliability accept them. Each report row binds the owner-published question version and schema hash, and its denominator must equal the independently frozen expected count for that question and stratum. Reports retain failures in denominators, keep false-negative and abstention counts within the denominator, report nonnegative finite p95 latency and uncertainty, and include ordered lower and upper bounds for a 95% family-bootstrap interval. Known or estimated downstream cost must be nonnegative and finite; unknown cost is explicit and prevents an economy claim.

## External ownership and acceptance

EVAL-02 remains owned by Finance and reliability, EVAL-03 by Product and frontend, and EVAL-04 by Finance and reliability. Their global meanings are preserved. CE-06 (#18) owns intent question content; CE-09 (#16) owns visual compliance, defect, and repair question content. CE-Q01 owns policy and corpus acceptance only.

The checked-in question register is intentionally empty and marked missing owner publication. Production acceptance needs an independently pinned, nonempty question inventory and complete definitions, including owner issue, owner role, question version, and fixture reference; per-question fixtures and strata; licensed source provenance; two distinct human reviewers; adjudication; owner acceptance; producer/evaluation telemetry agreement; accepted Score rubric; separate visual-trial budget authorization; and verified model/configuration/access pins for each paid workload. Each corpus sample also binds an immutable source-family identifier into its split digest. Families must remain disjoint across routing calibration, held-out, and safety splits, and across inspection calibration and held-out splits. An injected verifier in tests exercises the gate interface; it is not owner evidence and does not make the checked-in proposal accepted.

No local hash, URL, or `accepted` status authenticates its author. The acceptance gate requires an injected independent-evidence verifier; without it, acceptance fails. Synthetic fixtures are marked test-only and cannot satisfy the corpus or owner-evidence requirements. A missing item must be repaired by its accountable owner before the corresponding evaluation begins.

## Local validation

The standalone fixture and validator suite is run with:

```sh
node --test tests/evaluation/*.test.mjs
```

This checks validator behavior and test-only synthetic fixtures. It is not evidence of real corpus quality or owner acceptance. The root mock check is expected to pass when those tests pass. Production acceptance is a separate command, `make acceptance TARGET=eval-policy`; it emits machine-readable findings and exits with status 2 while owner evidence, licensed corpus, approved rubric, telemetry agreement, budget authorization, and other required evidence remain pending. The aggregate `make acceptance TARGET=all` includes CE-Q01 alongside the canonical contract owner agreements. No live provider calls or paid trials belong in either command.
