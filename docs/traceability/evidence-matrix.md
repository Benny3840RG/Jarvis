# Jarvis Evidence Matrix

**Specification:** Jarvis Requirements v2.2  
**Rule:** Evidence must be immutable or durably addressable and must identify the verified revision.

| Requirement range | Evidence required | Current evidence | Verification status | Verified revision | Verified by |
|---|---|---|---|---|---|
| R-001–R-004 | Approved specification and capability inventory | Master specification | Partial | v2.2 | Requirements review |
| R-005–R-014 | Mode contracts and passing mode tests | — | Unverified | — | — |
| R-015–R-021 | Lifecycle register and change history | `requirements.yaml` | Partial | v2.2 | Requirements review |
| R-022–R-024F | Locality map, loopback guards, and remote-binding negative tests | HTTP/MCP listener configuration and remote-binding guards | Partial | `981ee36b` | Connector review |
| R-025–R-033 | Persistence, restart, retrieval, migration evidence | — | Unverified | — | — |
| R-034–R-038C | Policy definitions and authorisation tests | — | Unverified | — | — |
| R-039–R-043 | Idempotency and correlation test artefacts | Tool-action execution idempotency and replay tests | Partial | `5fabfae1` | Connector review |
| R-044–R-054 | Approval lifecycle and fingerprint tests | ToolAction consent lifecycle schema, state literals, approve/revoke HTTP boundary, expiry/consumption execution tests, operator approval docs | Partial | `5fabfae1` | Connector review |
| R-055–R-062 | Tool contracts, audit records, failure tests | Tool action execution receipts and guarded execution tests | Partial | `5fabfae1` | Connector review |
| R-063–R-066 | Secret-storage review and redaction tests | Token-file/O_NOFOLLOW controls, service-token handling, telemetry redaction tests | Partial | `981ee36b` | Connector review |
| R-067–R-072 | Schema, ownership, backup and restore evidence | ToolAction schema evidence; provider-neutral backup/restore validation | Partial | `981ee36b` | Connector review |
| R-073–R-076 | State diagrams and transition test results | State glossary and ToolAction state-transition tests | Partial | `5fabfae1` | Connector review |
| R-077–R-081 | Retention policy and append-only history tests | ToolAction lifecycle audit-event hooks only | Partial | `5fabfae1` | Connector review |
| R-082–R-090 | Safety policy and blocked-action evidence | ToolAction blocked execution tests for expired, revoked, unauthorized, and consumed approvals | Partial | `5fabfae1` | Connector review |
| R-091–R-098C | End-to-end execution and reconciliation evidence | ToolAction execution boundary tests plus maintained runner weighted ordering, immutable graph state, deep-frozen trigger validation, and bounded fail-closed execution tests; durable composition and Outlook/quote runtime remain uncommissioned | Partial | `92fee4c` | Remote CI + requirements review |
| R-099–R-104 | Failure injection and recovery reports | ReliabilityController redaction, circuit-open, cooldown, and recovery tests; truthful reconciliation health projection; HTTP persistence probe wiring; maintained runner retryable budget-stop and immutable-state negative tests; durable restart/idempotent recovery remains open | Partial | `92fee4c` | Remote CI + requirements review |
| R-105–R-111 | CI results and populated traceability links | Test and evidence matrices plus foundation/observability CI records | Partial | `981ee36b` | Requirements review + connector review |
| R-112–R-116 | Release, rollback, backup and compatibility runs | Deployment/runbook controls and backup verification/restore tests; live drills remain open | Partial | `981ee36b` | Connector review |
| R-117–R-121 | Setup, backup and incident runbook exercises | Development runbooks and guarded commissioning workflows; live operational drills remain open | Partial | `981ee36b` | Connector review |
| R-122–R-124 | Roadmap-to-requirement mapping | Requirements v2.2 and priority roadmap/governance records | Partial | `981ee36b` | Requirements review |
| R-125–R-127 | Completed feature gate records | Merged PR verification records for foundation and observability slices | Partial | `981ee36b` | Connector review |
| R-128–R-131 | Concurrent mutation and conflict evidence | ToolExecution single-use concurrent-consumption test and stale eligibility checks | Partial | `5fabfae1` | Connector review |
| R-132–R-135 | Policy-version and revalidation evidence | — | Unverified | — | — |
| R-136–R-140 | Timezone, DST and ambiguity test evidence | Reminder parsing, explicit timezone validation, and ambiguity-preserving tests | Partial | `981ee36b` | Connector review |
| R-141–R-143 | Provider reconciliation and deduplication evidence | ToolAction idempotency and indeterminate execution receipt tests; Outlook runtime remains externally blocked | Partial | `981ee36b` | Connector review |
| R-144–R-150 | Namespace validation and frozen register | Master specification and `requirements.yaml` | Verified | v2.2 | Requirements review |

## Evidence rules

- A commit SHA, CI run, signed commissioning report, or versioned artefact is acceptable evidence.
- A conversational claim is not evidence.
- Partial evidence does not make the whole requirement range implemented.
- Evidence links must identify the code or document revision tested.
- Failed or superseded evidence remains traceable.

## Current-baseline reconciliation — 2026-08-06

The historical `5fabfae1` references above remain intentionally preserved as the exact revisions for the original ToolAction lifecycle verification. The current repository baseline is `0485ba750c9f08735ab784a1a3877c84d345144d`; later rows cite historical baselines where the current implementation and merged observability/foundation controls were inspected. This matrix records evidence status, not a claim that live external commissioning has occurred.

The 2026-08-08 orchestration review evidence is intentionally partial: it proves in-process trigger validation, nested payload immutability, weighted dependency ordering, graph-state immutability, and retryable bounded stopping. It does not prove durable run recovery or production trigger activation.

## Approval lifecycle reconciliation — 2026-08-04

Issue #244 is stale for the core consent-lifecycle implementation target and is closed as completed. Current code includes:

- widened ToolAction states: `proposed`, `approved`, `rejected`, `expired`, `revoked`;
- additive schema fields for approval expiry policy, expiry time, expiry observation, consumption policy, revocation metadata, and single-use claim metadata;
- HTTP `/approve` and `/revoke` boundaries gated by the separate approval token;
- tests for TTL derivation, TTL clamping, expiry detection, revoked/expired blocking, single-use consumption, concurrent different-key single-use races, stale eligibility checks, and reusable approvals.

The R-044–R-054 row remains **Partial**, not Verified, because that range also includes standing automation authorisation requirements (R-052–R-054) that still require separate policy and operational evidence.
