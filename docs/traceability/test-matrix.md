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
| R-091–R-098C | End-to-end workflow | Approval bypass, false success, state crossover | `executionFlow` | Planned |
| R-099–R-104 | Failure injection | Mutation after invalid input or corrupt recovery | `errorRecovery` | Planned |
| R-105–R-111 | CI meta-tests | Missing required test or evidence linkage | `traceabilityValidation` | Planned |
| R-112–R-116 | Deployment checks | Incompatible runtime and failed rollback | `releaseSafety` | Planned |
| R-117–R-121 | Runbook exercises | Recovery dependent on undocumented knowledge | `operationsRunbooks` | Planned |
| R-122–R-124 | Governance review | Roadmap item without requirement linkage | `roadmapTraceability` | Planned |
| R-125–R-127 | Definition-of-done gate | Durable-data or safety regression | `definitionOfDone` | Planned |
| R-128–R-131 | Concurrency integration | Stale and conflicting concurrent mutations | `concurrentMutation` | Planned |
| R-132–R-135 | Policy migration | Old approval widened by new policy | `policyVersioning` | Planned |
| R-136–R-140 | Temporal unit and workflow | DST gaps, duplicate local times, unsafe ambiguity | `timezoneNormalisation` | Planned |
| R-141–R-143 | Provider integration | Blind retry after indeterminate result | `indeterminateReconciliation` | Planned |
| R-144–R-150 | Namespace validation | Duplicate, recycled, shifted, or lowercase ID | `requirementsNamespace` | Planned |

## Completion rule

A requirement is not implemented until at least one passing test and one immutable evidence reference are linked in the evidence matrix.
