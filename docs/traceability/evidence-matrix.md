# Jarvis Evidence Matrix

**Specification:** Jarvis Requirements v2.2  
**Rule:** Evidence must be immutable or durably addressable and must identify the verified revision.

| Requirement range | Evidence required | Current evidence | Verification status | Verified revision | Verified by |
|---|---|---|---|---|---|
| R-001–R-004 | Approved specification and capability inventory | Master specification | Partial | v2.2 | Requirements review |
| R-005–R-014 | Mode contracts and passing mode tests | — | Unverified | — | — |
| R-015–R-021 | Lifecycle register and change history | `requirements.yaml` | Partial | v2.2 | Requirements review |
| R-022–R-024F | Locality map, offline tests, sync evidence | — | Unverified | — | — |
| R-025–R-033 | Persistence, restart, retrieval, migration evidence | — | Unverified | — | — |
| R-034–R-038C | Policy definitions and authorisation tests | — | Unverified | — | — |
| R-039–R-043 | Idempotency and correlation test artefacts | — | Unverified | — | — |
| R-044–R-054 | Approval lifecycle and fingerprint tests | — | Unverified | — | — |
| R-055–R-062 | Tool contracts, audit records, failure tests | — | Unverified | — | — |
| R-063–R-066 | Secret-storage review and redaction tests | — | Unverified | — | — |
| R-067–R-072 | Schema, ownership, backup and restore evidence | — | Unverified | — | — |
| R-073–R-076 | State diagrams and transition test results | State glossary | Partial | v2.2 | Requirements review |
| R-077–R-081 | Retention policy and append-only history tests | — | Unverified | — | — |
| R-082–R-090 | Safety policy and blocked-action evidence | — | Unverified | — | — |
| R-091–R-098C | End-to-end execution and reconciliation evidence | — | Unverified | — | — |
| R-099–R-104 | Failure injection and recovery reports | — | Unverified | — | — |
| R-105–R-111 | CI results and populated traceability links | Test and evidence matrices | Partial | v2.2 | Requirements review |
| R-112–R-116 | Release, rollback, backup and compatibility runs | — | Unverified | — | — |
| R-117–R-121 | Setup, backup and incident runbook exercises | — | Unverified | — | — |
| R-122–R-124 | Roadmap-to-requirement mapping | — | Unverified | — | — |
| R-125–R-127 | Completed feature gate records | — | Unverified | — | — |
| R-128–R-131 | Concurrent mutation and conflict evidence | — | Unverified | — | — |
| R-132–R-135 | Policy-version and revalidation evidence | — | Unverified | — | — |
| R-136–R-140 | Timezone, DST and ambiguity test evidence | — | Unverified | — | — |
| R-141–R-143 | Provider reconciliation and deduplication evidence | — | Unverified | — | — |
| R-144–R-150 | Namespace validation and frozen register | Master specification and `requirements.yaml` | Verified | v2.2 | Requirements review |

## Evidence rules

- A commit SHA, CI run, signed commissioning report, or versioned artefact is acceptable evidence.
- A conversational claim is not evidence.
- Partial evidence does not make the whole requirement range implemented.
- Evidence links must identify the code or document revision tested.
- Failed or superseded evidence remains traceable.
