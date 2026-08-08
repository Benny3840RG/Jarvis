# Jarvis Requirements Matrix

**Specification:** Jarvis Requirements v2.2  
**Namespace status:** Frozen  
**Default lifecycle status:** Planned until assessed against implementation evidence.

| Requirement range | Area | Current status | Priority | Owner | Target milestone | Evidence state |
|---|---|---|---|---|---|---|
| R-001–R-004 | Purpose and scope | Partial | Must | Unassigned | TBD | Evidence matrix: Partial |
| R-005–R-014 | Core modes | Unverified | Must | Unassigned | TBD | Evidence matrix: Unverified |
| R-015–R-021 | Requirement lifecycle | Partial | Must | Unassigned | v2.2 governance | Evidence matrix: Partial |
| R-022–R-024F | Operational locality | Partial | Must | Unassigned | P1 foundations | Evidence matrix: Partial |
| R-025–R-033 | Memory model | Unverified | Must | Unassigned | TBD | Evidence matrix: Unverified |
| R-034–R-038C | Action effect and sensitivity | Partial | Must | Unassigned | TBD | Evidence matrix: Partial |
| R-039–R-043 | Idempotency and correlation | Partial | Must | Unassigned | P1 foundations | Evidence matrix: Partial |
| R-044–R-054 | Approvals | Partial | Must | Unassigned | P1 foundations | Evidence matrix: Partial |
| R-055–R-062 | Tool architecture | Partial | Must | Unassigned | P1 foundations | Evidence matrix: Partial |
| R-063–R-066 | Credential handling | Partial | Must | Unassigned | P1 foundations | Evidence matrix: Partial |
| R-067–R-072 | Data model | Partial | Must | Unassigned | P1 foundations | Evidence matrix: Partial |
| R-073–R-076 | State transitions | Partial | Must | Unassigned | P1 foundations | Evidence matrix: Partial |
| R-077–R-081 | Retention and history | Partial | Must | Unassigned | TBD | Evidence matrix: Partial |
| R-082–R-090 | Safety rules | Partial | Must | Unassigned | P1 foundations | Evidence matrix: Partial |
| R-091–R-098C | Execution flow | Partial | Must | Unassigned | P1 foundations | Evidence matrix: Partial |
| R-099–R-104 | Error handling | Partial | Must | Unassigned | P1 foundations | Evidence matrix: Partial |
| R-105–R-111 | Testing and evidence | Partial | Must | Unassigned | P1 foundations | Evidence matrix: Partial |
| R-112–R-116 | Release strategy | Partial | Must | Unassigned | P1 foundations | Evidence matrix: Partial |
| R-117–R-121 | Operations | Partial | Must | Unassigned | P3 operations gate | Evidence matrix: Partial |
| R-122–R-124 | Roadmap linkage | Partial | Must | Unassigned | P3/P4 roadmap | Evidence matrix: Partial |
| R-125–R-127 | Definition of done | Partial | Must | Unassigned | P1 foundations | Evidence matrix: Partial |
| R-128–R-131 | Concurrency and consistency | Partial | Must | Unassigned | P1 foundations | Evidence matrix: Partial |
| R-132–R-135 | Policy versioning | Unverified | Must | Unassigned | TBD | Evidence matrix: Unverified |
| R-136–R-140 | Time and timezone | Partial | Must | Unassigned | P2 runtime | Evidence matrix: Partial |
| R-141–R-143 | Indeterminate outcomes | Partial | Must | Unassigned | P2 Outlook | Evidence matrix: Partial |
| R-144–R-150 | Revision and freeze rules | Implemented | Must | Requirements governance | v2.2 | Evidence matrix: Verified |

## Assessment basis

Statuses above are reconciled to the implementation and evidence records on current main baseline 0485ba750c9f08735ab784a1a3877c84d345144d. Partial means the repository contains implementation, tests, runbooks, or governance evidence, but the requirement range is not fully closed. Unverified means this reconciliation found no current evidence sufficient to assess the range. A Partial status is not a commissioning or production claim.

The matrix records the current reality rather than leaving known foundation controls marked Unverified: loopback locality, credential handling, release/operations scaffolding, roadmap linkage, timezone handling, and indeterminate-outcome machinery have repository evidence. The maintained runtime now also has an explicit in-process integration core at the CLI seam — EventBus, ToolGateway, domain registry, memory linker, tool router, and an idempotent Convex-backed metadata event sink — plus a provider-neutral reliability controller at the HTTP status boundary. The maintained orchestration runner now has deterministic weighted dependency scheduling, trigger validation/registry, bounded step and duration execution, and fail-closed budget evidence. Live Convex commissioning, governed HTTP/MCP composition, downstream outbox consumers, durable orchestration state/recovery, live observability, and broader P4 intelligence remain open until separately verified. These slices are evidence of maintained foundations, not a claim that the full autonomous runtime is commissioned.

The 2026-08-08 dependency refresh also resolves the previously failing audit path for js-yaml, nanoid, and console dompurify; the exact-head CI run for the orchestration branch passed audit, typecheck, lint, formatting, OpenAPI, Node/Convex tests, console build/typecheck, and automation policy before merge.

## Update rules

- Split ranges into individual rows as implementation assessment proceeds.
- An item may become implemented only when its test and evidence references are populated.
- Deferred and rejected items retain their IDs and reasons.
- No row may redefine an ID from the frozen namespace.
