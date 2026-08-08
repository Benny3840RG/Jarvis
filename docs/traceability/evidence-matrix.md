# Jarvis Evidence Matrix

**Specification:** Jarvis Requirements v2.2  
**Rule:** Evidence must be immutable or durably addressable and must identify the verified revision.

| Requirement range | Evidence required | Current evidence | Verification status | Verified revision | Verified by |
|---|---|---|---|---|---|
| R-001–R-004 | Approved specification and capability inventory | Master specification | Partial | v2.2 | Requirements review |
| R-005–R-014 | Mode contracts and passing mode tests | — | Unverified | — | — |
| R-015–R-021 | Lifecycle register and change history | requirements.yaml | Partial | v2.2 | Requirements review |
| R-022–R-024F | Locality map, loopback guards, and remote-binding negative tests | HTTP/MCP listener configuration and remote-binding guards | Partial | 981ee36b | Connector review |
| R-025–R-033 | Persistence, restart, retrieval, migration evidence | — | Unverified | — | — |
| R-034–R-038C | Policy definitions and authorisation tests | — | Unverified | — | — |
| R-039–R-043 | Idempotency and correlation test artefacts | Tool-action execution idempotency and replay tests | Partial | 5fabfae1 | Connector review |
| R-044–R-054 | Approval lifecycle and fingerprint tests | ToolAction consent lifecycle schema, state literals, approve/revoke HTTP boundary, expiry/consumption execution tests, operator approval docs | Partial | 5fabfae1 | Connector review |
| R-055–R-062 | Tool contracts, audit records, failure tests | Tool action execution receipts and guarded execution tests | Partial | 5fabfae1 | Connector review |
| R-063–R-066 | Secret-storage review and redaction tests | Token-file/O_NOFOLLOW controls, service-token handling, telemetry redaction tests | Partial | 981ee36b | Connector review |
| R-067–R-072 | Schema, ownership, backup and restore evidence | ToolAction schema evidence; provider-neutral backup/restore validation | Partial | 981ee36b | Connector review |
| R-073–R-076 | State diagrams and transition test results | State glossary and ToolAction state-transition tests | Partial | 5fabfae1 | Connector review |
| R-077–R-081 | Retention policy and append-only history tests | ToolAction lifecycle audit-event hooks only | Partial | 5fabfae1 | Connector review |
| R-082–R-090 | Safety policy and blocked-action evidence | ToolAction blocked execution tests for expired, revoked, unauthorized, and consumed approvals | Partial | 5fabfae1 | Connector review |
| R-091–R-098C | End-to-end execution and reconciliation evidence | Maintained orchestration graph/runner tests cover weighted dependency ordering, trigger validation, bounded step/duration execution, and fail-closed budget evidence; PR #325 adds provider-neutral run/step semantics; merged PR #329 adds Convex-backed durable runs/steps, concurrent trigger replay protection, server-issued worker-bound leases, operation-bound reconciliation records, and fail-closed recovery; merged PR #335 composes that boundary with the maintained runner, handling replay/conflict before execution and committing lease-bound terminal state; exact workflow run #1432 (31257664623) and Copilot Check (31257664737) passed; provider-authenticated recovery and runtime ingress remain open | Partial | a08a064d | Remote CI + requirements review |
| R-099–R-104 | Failure injection and recovery reports | ReliabilityController redaction, circuit-open, cooldown, and recovery tests; truthful reconciliation health projection; bounded orchestration budget failures preserve completed-step evidence; Convex persistence records server-time checkpoints, worker-bound leases, durable reconciliation bindings, and indeterminate fail-closed recovery; PR #335 adds lease-before-execution and audit-before-durable-terminal-commit ordering with recoverable write failures; review still requires provider-authenticated evidence and live restart/restore drills | Partial | a08a064d | Remote CI + security review |
| R-105–R-111 | CI results and populated traceability links | Test and evidence matrices plus foundation, observability, dependency-audit, bounded-orchestration, durable-state, and maintained-runner CI records; PR #329 exact-head workflow #1413 (31256419743), PR #335 exact-head workflow #1432 (31257664623), and Copilot Check (31257664737) passed | Partial | a08a064d | Requirements review + remote CI |
| R-112–R-116 | Release, rollback, backup and compatibility runs | Deployment/runbook controls and backup verification/restore tests; live drills remain open | Partial | 981ee36b | Connector review |
| R-117–R-121 | Setup, backup and incident runbook exercises | Development runbooks and guarded commissioning workflows; live operational drills remain open | Partial | 981ee36b | Connector review |
| R-122–R-124 | Roadmap-to-requirement mapping | Requirements v2.2 and priority roadmap/governance records | Partial | 41858c2 | Requirements review |
| R-125–R-127 | Completed feature gate records | Merged PR verification records for foundation, observability, dependency-audit, bounded-orchestration, Convex durable-state, and maintained-runner composition slices; review records the slice as offline-only and not activation-ready | Partial | a08a064d | Connector review + security review |
| R-128–R-131 | Concurrent mutation and conflict evidence | ToolExecution single-use concurrent-consumption test and stale eligibility checks; PR #329 adds concurrent orchestration replay coverage and owner/idempotency indexes | Partial | a08a064d | Connector review + remote CI |
| R-132–R-135 | Policy-version and revalidation evidence | — | Unverified | — | — |
| R-136–R-140 | Timezone, DST and ambiguity test evidence | Reminder parsing, explicit timezone validation, and ambiguity-preserving tests | Partial | 981ee36b | Connector review |
| R-141–R-143 | Provider reconciliation and deduplication evidence | ToolAction idempotency and indeterminate execution receipt tests; PR #329 adds operation/effect-bound durable recovery records and PR #335 composes lease-bound runner terminal commits, but provider-authenticated terminal evidence and deployed provider drills remain open | Partial | a08a064d | Remote CI + security review |
| R-144–R-150 | Namespace validation and frozen register | Master specification and requirements.yaml | Verified | v2.2 | Requirements review |

## Evidence rules

- A commit SHA, CI run, signed commissioning report, or versioned artefact is acceptable evidence.
- A conversational claim is not evidence.
- Partial evidence does not make the whole requirement range implemented.
- Evidence links must identify the code or document revision tested.
- Failed or superseded evidence remains traceable.

## Current-baseline reconciliation — 2026-08-08

The historical 5fabfae1 and 981ee36b references above remain intentionally preserved as the exact revisions for the original ToolAction lifecycle and foundation verification. The current repository baseline is a08a064d876f7def00a5bb8b3ab76d66aaed4594. PR #329 was tested at its exact head in workflow run #1413 (31256419743), PR #335 at workflow #1432 (31257664623), and PR #336 at workflow #1440 (31257990451) with Copilot Check 31257990434 before merge. PR #336 merged at 54cf2c7db92a2d5fc17d41497afa228fcbd0da49. This matrix records the durable-state, maintained-runner, and offline provider-authenticated recovery evidence; authenticated worker identity, real ingress, and deployed restart/provider drills remain unclaimed.

## Approval lifecycle reconciliation — 2026-08-04

Issue #244 is stale for the core consent-lifecycle implementation target and is closed as completed. Current code includes:

- widened ToolAction states: proposed, approved, rejected, expired, revoked;
- additive schema fields for approval expiry policy, expiry time, expiry observation, consumption policy, revocation metadata, and single-use claim metadata;
- HTTP /approve and /revoke boundaries gated by the separate approval token;
- tests for TTL derivation, TTL clamping, expiry detection, revoked/expired blocking, single-use consumption, concurrent different-key single-use races, stale eligibility checks, and reusable approvals.

The R-044–R-054 row remains Partial, not Verified, because that range also includes standing automation authorisation requirements (R-052–R-054) that still require separate policy and operational evidence.
