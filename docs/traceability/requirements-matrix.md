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
| R-132–R-135 | Policy versioning | Partial | Must | Unassigned | P4 orchestration gate | Evidence matrix: Partial |
| R-136–R-140 | Time and timezone | Partial | Must | Unassigned | P2 runtime | Evidence matrix: Partial |
| R-141–R-143 | Indeterminate outcomes | Partial | Must | Unassigned | P2 Outlook | Evidence matrix: Partial |
| R-144–R-150 | Revision and freeze rules | Implemented | Must | Requirements governance | v2.2 | Evidence matrix: Verified |

## Assessment basis

Statuses above are reconciled to the implementation and evidence records on current main baseline `dc61999f1c21f9a3a2935213f45e959ef203c06e`. Partial means the repository contains implementation, tests, runbooks, or governance evidence, but the requirement range is not fully closed. Unverified means this reconciliation found no current evidence sufficient to assess the range. A Partial status is not a commissioning or production claim.

The matrix records the current reality rather than leaving known foundation controls marked Unverified: loopback locality, credential handling, release/operations scaffolding, roadmap linkage, timezone handling, and indeterminate-outcome machinery have repository evidence. The maintained runtime now also has an explicit in-process integration core at the CLI seam — EventBus, ToolGateway, domain registry, memory linker, tool router, and an idempotent Convex-backed metadata event sink — plus a provider-neutral reliability controller at the HTTP status boundary. The maintained orchestration runner now has deterministic weighted dependency scheduling, trigger validation/registry, bounded step and duration execution, and fail-closed budget evidence. PR #325 additionally verifies a provider-neutral run/step state contract with idempotent replay/conflict handling and indeterminate-outcome fail-closed transitions. PR #329 verifies the Convex durable persistence boundary with server-issued lease grants, server-derived lifecycle clocks, operation-bound reconciliation records, concurrent replay protection, and fail-closed recovery. PR #335 then composes that boundary with the maintained runner, handling replay/conflict before execution and preserving recoverability around terminal writes. PR #336 adds provider-authenticated external reconciliation binding, safe trigger persistence, and server-derived retry classification. PR #344 closes the unleased durable failure path and verifies audit-before-fail ordering in the composed runner. PR #350 binds composition-owned policy identity and derives canonical graph plan fingerprints. PR #352 hardens the autobuild control-plane validator without expanding authority. Their exact-head workflows #1446, #1470, and #1477, with Copilot Checks (31258557732, 31260194109, 31260896356), passed, but authenticated worker identity, real ingress, and deployed restart/provider evidence remain open. Governed HTTP/MCP composition, downstream outbox consumers, production restart/recovery drills, live observability, and broader P4 intelligence remain open until separately verified. These slices are evidence of maintained foundations, not a claim that the full autonomous runtime is commissioned.

The 2026-08-08 dependency refresh also resolves the previously failing audit path for js-yaml, nanoid, and console dompurify; the exact-head CI run for the maintained-runner branch passed audit, typecheck, lint, formatting, OpenAPI, Node/Convex tests, console build/typecheck, and automation policy before merge.

## Update rules

- Split ranges into individual rows as implementation assessment proceeds.
- An item may become implemented only when its test and evidence references are populated.
- Deferred and rejected items retain their IDs and reasons.
- No row may redefine an ID from the frozen namespace.


## Current main reconciliation — 2026-08-11

The current baseline is `dc61999f1c21f9a3a2935213f45e959ef203c06e`.

- PR #361 merged the Convex control-plane credential separation at `85a631a0a8d9207765771a8e06a298a870cdf604`. Approval and delivery runtime credentials are independently validated, including previous rotation values; the exact-head TypeScript and Copilot gates passed.
- PR #365 merged the rebased console dependency and CI restoration at `d4878a1b4151d76975b49199536e9e32f9066843`. Its exact-head TypeScript, Python and Copilot gates passed.
- PR #369 merged ΩΣ Pass 2 at `dc61999f1c21f9a3a2935213f45e959ef203c06e` from exact reviewed head `18469a50e982c870376cbfad6d0001d4b9f143ed`. TypeScript checks run `31493909487` and Copilot Review Check run `31493909392` passed. The slice adds owner-scoped mission/evidence/proof/one-shot contract state, fail-closed mission execution gating, durable terminal receipt reconciliation, indeterminate-outcome handling, and hard-block/unblock safety coverage.
- The ΩΣ implementation evidence does not close the broad requirement ranges by itself: remote ingress, provider commissioning, live observability, recovery drills, production release controls and human deployment approval remain open.
- Current open commissioning/production gates are tracked by #293 (delegated Outlook OAuth), #294 (AM-013 quote delivery), #297 (Outlook reconciliation), #302 (PostHog), #303 (Sentry), #306 (remote OIDC/gateway), and #307 (production operations/recovery/deployment). No live credentials, customer effect, public exposure or production deployment was performed.
- Stale ΩΣ PR #364 was closed as superseded by #369. Its prior evidence was not reused because its later branch head did not match the claimed verified head.

