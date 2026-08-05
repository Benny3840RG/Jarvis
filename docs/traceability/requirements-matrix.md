# Jarvis Requirements Matrix

**Specification:** Jarvis Requirements v2.2  
**Namespace status:** Frozen  
**Default lifecycle status:** Planned until assessed against implementation evidence.

| Requirement range | Area | Current status | Priority | Owner | Target milestone | Evidence state |
|---|---|---|---|---|---|---|
| R-001–R-004 | Purpose and scope | Partial | Must | Unassigned | TBD | Evidence matrix: Partial |
| R-005–R-014 | Core modes | Unverified | Must | Unassigned | TBD | Evidence matrix: Unverified |
| R-015–R-021 | Requirement lifecycle | Partial | Must | Unassigned | v2.2 governance | Evidence matrix: Partial |
| R-022–R-024F | Operational locality | Unverified | Must | Unassigned | TBD | Evidence matrix: Unverified |
| R-025–R-033 | Memory model | Unverified | Must | Unassigned | TBD | Evidence matrix: Unverified |
| R-034–R-038C | Action effect and sensitivity | Partial | Must | Unassigned | TBD | Evidence matrix: Partial |
| R-039–R-043 | Idempotency and correlation | Partial | Must | Unassigned | TBD | Evidence matrix: Partial |
| R-044–R-054 | Approvals | Partial | Must | Unassigned | TBD | Evidence matrix: Partial |
| R-055–R-062 | Tool architecture | Partial | Must | Unassigned | TBD | Evidence matrix: Partial |
| R-063–R-066 | Credential handling | Unverified | Must | Unassigned | TBD | Evidence matrix: Unverified |
| R-067–R-072 | Data model | Partial | Must | Unassigned | TBD | Evidence matrix: Partial |
| R-073–R-076 | State transitions | Partial | Must | Unassigned | TBD | Evidence matrix: Partial |
| R-077–R-081 | Retention and history | Partial | Must | Unassigned | TBD | Evidence matrix: Partial |
| R-082–R-090 | Safety rules | Partial | Must | Unassigned | TBD | Evidence matrix: Partial |
| R-091–R-098C | Execution flow | Partial | Must | Unassigned | TBD | Evidence matrix: Partial |
| R-099–R-104 | Error handling | Partial | Must | Unassigned | TBD | Evidence matrix: Partial |
| R-105–R-111 | Testing and evidence | Partial | Must | Unassigned | TBD | Evidence matrix: Partial |
| R-112–R-116 | Release strategy | Unverified | Must | Unassigned | TBD | Evidence matrix: Unverified |
| R-117–R-121 | Operations | Unverified | Must | Unassigned | TBD | Evidence matrix: Unverified |
| R-122–R-124 | Roadmap linkage | Unverified | Must | Unassigned | TBD | Evidence matrix: Unverified |
| R-125–R-127 | Definition of done | Partial | Must | Unassigned | TBD | Evidence matrix: Partial |
| R-128–R-131 | Concurrency and consistency | Partial | Must | Unassigned | TBD | Evidence matrix: Partial |
| R-132–R-135 | Policy versioning | Unverified | Must | Unassigned | TBD | Evidence matrix: Unverified |
| R-136–R-140 | Time and timezone | Unverified | Must | Unassigned | TBD | Evidence matrix: Unverified |
| R-141–R-143 | Indeterminate outcomes | Partial | Must | Unassigned | TBD | Evidence matrix: Partial |
| R-144–R-150 | Revision and freeze rules | Implemented | Must | Requirements governance | v2.2 | Evidence matrix: Verified |

## Assessment basis

Statuses above are reconciled to the implementation and evidence records on the current `main`
baseline (`211e7163a084c2af8db7ac4e10f1dafe2bc2f7ac`). `Partial` means the evidence matrix
contains implementation or test evidence but the requirement range is not fully closed.
`Unverified` means this pass found no current evidence sufficient to assess the range.
Requirement ownership and target milestones remain unchanged where no authoritative assignment was
found.

## Update rules

- Split ranges into individual rows as implementation assessment proceeds.
- An item may become `implemented` only when its test and evidence references are populated.
- Deferred and rejected items retain their IDs and reasons.
- No row may redefine an ID from the frozen namespace.
