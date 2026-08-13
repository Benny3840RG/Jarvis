# Jarvis Test Matrix

**Specification:** Jarvis Requirements v2.2

| Requirement range | Primary verification | Mandatory negative-path coverage | Planned test family | Status |
|---|---|---|---|---|
| R-001–R-004 | Documentation review | Unsupported capability claims | `purposeScope` | Planned |
| R-005–R-014 | Unit and workflow | Mode boundary and mutation rejection | `modeClassification` | Planned |
| R-015–R-021 | Schema and governance | Missing or invalid lifecycle metadata | `requirementLifecycle` | Planned |
| R-022–R-024F | Integration and offline workflow | Stale data, duplicate sync, reordered writes | `offlineCapability` | Planned |
| R-025–R-033 | Persistence and migration | Ephemeral leakage and unrelated-state corruption | `memoryModel` | Planned |
| R-034–R-038C | Policy unit tests | Effect-only or sensitivity-only authorisation | `effectSensitivityPolicy` | Planned |
| R-039–R-043 | Integration | Duplicate execution and broken correlation chain | `idempotencyCorrelation` | Planned |
| R-044–R-054 | Workflow and security | Expired, revoked, consumed, or mismatched approval | `approvalLifecycle` | Planned |
| R-055–R-062 | Contract and integration | Tool bypass and hidden mutation on failure | `toolContracts` | Planned |
| R-063–R-066 | Security review | Secret leakage in logs, export, or evidence | `credentialHandling` | Planned |
| R-067–R-072 | Schema and migration | Ownership omission and broken restore | `dataModel` | Planned |
| R-073–R-076 | State-machine unit tests | Invalid and nondeterministic transition | `stateTransitions` | Planned |
| R-077–R-081 | Persistence and audit | History overwrite and invalid pruning | `retentionHistory` | Planned |
| R-082–R-090 | Workflow and policy | Unapproved external or destructive action | `safetyRules` | Planned |
| R-091–R-098C | End-to-end workflow | Approval bypass, false success, state crossover | `executionFlow` | Partial |
| R-099–R-104 | Failure injection and recovery | Redacted persistence failure, circuit opening, and half-open recovery | `errorRecovery`, `reliabilityController` | Partial |
| R-105–R-111 | CI meta-tests | Missing required test or evidence linkage | `traceabilityValidation` | Partial |
| R-112–R-116 | Deployment checks | Incompatible runtime and failed rollback | `releaseSafety` | Planned |
| R-117–R-121 | Runbook exercises | Recovery dependent on undocumented knowledge | `operationsRunbooks` | Planned |
| R-122–R-124 | Governance review | Roadmap item without requirement linkage | `roadmapTraceability` | Planned |
| R-125–R-127 | Definition-of-done gate | Durable-data or safety regression | `definitionOfDone` | Partial |
| R-128–R-131 | Concurrency integration | Stale and conflicting concurrent mutations | `concurrentMutation` | Partial |
| R-132–R-135 | Policy migration | Old approval widened by new policy | `policyVersioning` | Planned |
| R-136–R-140 | Temporal unit and workflow | DST gaps, duplicate local times, unsafe ambiguity | `timezoneNormalisation` | Planned |
| R-141–R-143 | Provider integration | Blind retry after indeterminate result | `indeterminateReconciliation` | Partial |
| R-144–R-150 | Namespace validation | Duplicate, recycled, shifted, or lowercase ID | `requirementsNamespace` | Planned |

## Current backup input hardening evidence

| Requirement range | Passing test | Evidence reference | Status |
|---|---|---|---|
| R-067–R-072 | `backup.test.ts` — symbolic-link backup input is refused; export, isolated verify, restore, and ID remapping remain covered | `src/backup/backup.ts` `readBackupFile`, commit `3ea76656437efc4b78254582b2dcad34f4deb372`, `docs/security/2026-08-04-priority-1-foundation-scan.md` JARVIS-SEC-005 | Partial |

## Completion rule

A requirement is not implemented until at least one passing test and one immutable evidence reference are linked in the evidence matrix.

## Current safety-binding evidence

| Requirement range | Passing tests | Evidence reference | Status |
|---|---|---|---|
| R-082–R-090 | `safetyBinder.test.ts`, `safetyCategoryMatrix.test.ts` | `src/safety/safetyBinder.ts`, `src/runtime/validation.ts`, `src/actions/toolExecution.ts` | Partial |
| R-091–R-098C | `safetyCategoryMatrix.test.ts`, `convex/orchestrationState.test.ts`, `orchestrationDurability.test.ts` | `src/safety/safetyBinder.ts`, `convex/orchestrationState.ts`, `src/orchestration/convexRunner.ts`, `src/orchestration/fingerprints.ts`, exact PR #329 workflow #1413 (31256419743), PR #335 workflow #1432 (31257664623), PR #336 workflow #1440 (31257990451), PR #344 workflow #1446 (31258557727), and PR #350 workflow #1470 (31260194108) with Copilot Check (31260194109) | Partial |
| R-099–R-104 | `convex/orchestrationState.test.ts`, `convex/externalReconciliations.test.ts` | `convex/orchestrationState.ts`, `convex/externalReconciliations.ts`; provider-authenticated offline recovery is now bound; PR #344 adds durable failure ordering coverage, while live restart drills remain open | Partial |
| R-105–R-111 | `safetyBinder.test.ts`, `safetyCategoryMatrix.test.ts`, `convex/toolActions.test.ts`, `convex/toolExecutionReceiptMetadata.test.ts`, `convex/externalReconciliations.test.ts`, `convex/orchestrationState.test.ts` | `convex/safetyBindingValidators.ts`, `convex/schema.ts`, `convex/toolActions.ts`, `convex/toolExecutionReceipts.ts`, `convex/externalReconciliations.ts`, `convex/orchestrationState.ts`; PR #336 workflow #1440 (31257990451), PR #344 workflow #1446 (31258557727), PR #352 workflow #1477 (31260896290), and Copilot Checks (31257990434, 31258557732, 31260896356) | Partial |
| R-125–R-127 | `convex/orchestrationState.test.ts` | Merged PR #329 at `2e04d101e09e1f8d43208cc4fe9e7f4eee086ba1`; offline foundation only, not commissioning evidence | Partial |
| R-128–R-131 | `convex/orchestrationState.test.ts` concurrent replay coverage | `convex/schema.ts`, `convex/orchestrationState.ts` | Partial |

The tests prove the six-category in-process contract, fail-closed negative paths, lifecycle attachment, fresh Convex readback, durable runner composition, provider-authenticated offline recovery binding, durable failure audit/lease ordering, and composition-owned plan/policy binding. They do not prove authenticated worker identity, real ingress, deployed restart behavior, or live external commissioning. Status remains partial until those gates are separately evidenced.
