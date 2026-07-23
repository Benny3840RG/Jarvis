# Risk Register

Controlled record of operational and architectural risks, controls and residual exposure.

| Risk ID | Risk | Likelihood | Consequence | Mitigation | Residual risk | Owner | Status | Linked requirements |
|---|---|---|---|---|---|---|---|---|
| RSK-001 | Requirement IDs are accidentally renumbered, reused or reassigned. | Medium | Severe traceability loss. | Freeze R-001–R-150; validate duplicates, ranges and suffixes in CI. | Low after automated enforcement. | Architecture owner | Open | R-144–R-150 |
| RSK-002 | An approval is reused for a materially different action. | Medium | Unauthorised external side effect. | Bind approvals to exact action fingerprints and invalidate changed actions. | Low if all executing paths enforce fingerprint checks. | Policy owner | Open | R-044–R-054 |
| RSK-003 | An external action returns an indeterminate result and is incorrectly treated as success or failure. | Medium | Duplicate or missing real-world action. | Require correlation, idempotency and reconciliation before retry or completion. | Medium until every tool chain is covered. | Execution owner | Open | R-039–R-043, R-141–R-143 |
| RSK-004 | Convex production is deployed without explicit production-specific approval. | Low | High-impact environment breach. | Development-only target in canonical governance; dedicated production gate and evidence. | Low, but consequence remains high. | Program owner | Open | R-112–R-121 |
| RSK-005 | Implementation is marked complete without mapped tests and evidence. | Medium | False assurance and unsafe release. | CI traceability checks; completion requires test and evidence links. | Low after matrices are populated and enforced. | QA / Ops owner | Open | R-105–R-111, R-125–R-127 |

## Rules

- Risk IDs must match `RSK-###`; requirement-style `R-###` identifiers are prohibited.
- IDs are never recycled.
- Closed risks remain traceable with closure evidence.
- Residual risk must be reviewed whenever likelihood, consequence or mitigation changes.
