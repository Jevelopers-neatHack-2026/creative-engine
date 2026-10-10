# Creative score rubric status

**Status: pending owner publication.** This file records the rubric contract and current gap; it is not an accepted rubric and does not define score-level anchors or cutoffs.

CE-09 (#16) owns the visual compliance, defect, and repair questions and their score interpretation. CE-Q01 (#8) preserves the requirement that Score thresholds name the actual level rubric. It does not author the question text, labels, score anchors, or approval.

Before a Score question can be evaluated or promoted, its owner-published rubric must provide:

- The exact question ID and version, intended construct, and applicable output or edit scope.
- The actual ordered score levels, with an observable anchor and counterexample for every level.
- How refusals, incomplete evidence, non-inspectable output, and out-of-scope changes are represented without dropping a trial.
- The per-question numeric acceptance cutoff and the evidence supporting that decision.
- A pinned schema/rubric artifact hash and independent owner-verification evidence.

The proposal currently requires visual compliance scores of at least 4 on a 5-point scale for at least 90% of non-refusal trials, and edit-scope preservation scores of at least 4 on a 5-point scale for at least 90% of edit trials. These are proposed aggregate targets from issue #8; they do not define what an individual score level means. Refusals and failures remain separately reported and in planned-trial availability denominators.

The acceptance validator rejects a pending rubric. It accepts the rubric shape only when `status` is `accepted`, `accepted_cutoffs` contains actual level cutoffs, `rubric_sha256` is pinned, and the independent evidence verifier confirms the owner evidence. A local status string, URL, or hash does not establish acceptance. The current checked-in policy therefore keeps `status: pending-owner-rubric` and `accepted_cutoffs: null`.

No paid visual evaluation or score-based promotion is authorized by this proposal. The separate 36-generation and 36-edit workload requires its own Finance and reliability budget authorization and verified model pins.
