# Jarvis Requirements v2.2

**Status:** Frozen baseline  
**Frozen:** 23 July 2026  
**Namespace:** `R-001`–`R-150`, including uppercase subordinate IDs only  
**Rule:** Existing IDs are never renumbered, recycled, or silently repurposed.

## 1. Purpose and scope

**R-001** Jarvis shall be a personal assistant designed to support tasks, reminders, notes, planning, and future automation.  
**R-002** Jarvis shall be local-first by default, with explicit operational boundaries for when data remains local and when it may be transmitted.  
**R-003** Jarvis shall remain explicit, recoverable, and safe enough for daily use.  
**R-004** Jarvis shall not claim support for capabilities that are not implemented.

## 2. Core modes

**R-005** Jarvis shall support a Chat mode for questions, summaries, and general conversation.  
**R-006** Jarvis shall support a Plan mode for breaking goals into steps.  
**R-007** Jarvis shall support an Act mode for executing approved actions.  
**R-008** Jarvis shall support a Review mode for inspecting plans, results, and failures.  
**R-009** Jarvis shall support a Research mode for gathering and summarising external information.  
**R-010** Jarvis shall support a Voice mode when voice interaction is enabled.  
**R-011** Jarvis shall classify requests into an appropriate mode or reject them safely.  
**R-012** Jarvis shall define what each mode can and cannot do.  
**R-013** Jarvis shall define whether each mode may mutate state.  
**R-014** Jarvis shall define whether each mode requires approval before execution.

## 3. Requirement lifecycle

**R-015** Every requirement shall have a lifecycle status.  
**R-016** Supported lifecycle statuses shall include implemented, partial, planned, deferred, and rejected.  
**R-017** Every requirement shall have exactly one current lifecycle status.  
**R-018** Requirement status changes shall be recorded with timestamp and actor metadata.  
**R-019** Rejected and deferred requirements shall retain a reason.  
**R-020** Implemented requirements shall reference the evidence used to verify implementation.  
**R-021** Planned requirements shall reference the target milestone or release.

## 4. Operational locality

**R-022** Jarvis shall define local-first operationally.  
**R-023** Jarvis shall document the authoritative storage location, replication behaviour, and transmission boundaries for each core data class.  
**R-024** Jarvis shall define offline capability per feature rather than assuming universal availability.  
**R-024A** Features documented as offline-capable shall continue to function offline within their declared limits.  
**R-024B** Features that require network access shall document that dependency explicitly.  
**R-024C** Jarvis shall not imply offline support for features that have not declared it.  
**R-024D** Offline-capable features shall identify whether displayed data is authoritative, cached, stale, pending synchronisation, or unavailable.  
**R-024E** Offline writes shall preserve ordering, ownership, correlation, and idempotency metadata required for safe synchronisation.  
**R-024F** Reconnection shall not silently duplicate, discard, or reorder queued mutations.

## 5. Memory model

**R-025** Jarvis shall separate ephemeral session state from durable memory.  
**R-026** Jarvis shall support durable notes.  
**R-027** Jarvis shall support user-preference memory.  
**R-028** Jarvis shall support task history.  
**R-029** Jarvis shall support structured assistant state.  
**R-030** Jarvis shall preserve sufficient metadata to identify source and time for stored memory where relevant.  
**R-031** Jarvis shall not persist ephemeral session state as durable memory unless explicitly intended.  
**R-032** Jarvis shall retrieve stored memory without corrupting unrelated state.  
**R-033** Jarvis shall version any stored structure expected to evolve.

## 6. Action effect and data sensitivity

**R-034** Jarvis shall distinguish action effect from data sensitivity as separate axes.  
**R-035** Jarvis shall classify action effect independently from data sensitivity.  
**R-036** Jarvis shall classify data sensitivity independently from action effect.  
**R-037** Jarvis shall support policies combining effect and sensitivity classifications for authorisation decisions.  
**R-038** Jarvis may execute authenticated read-only actions without per-action confirmation where the active permission scope, feature policy, and sensitivity classification permit access.  
**R-038A** Jarvis shall treat action effect and data sensitivity as separate decision dimensions.  
**R-038B** Jarvis shall not infer permission from effect classification alone.  
**R-038C** Jarvis shall not infer permission from sensitivity classification alone.

## 7. Idempotency and correlation

**R-039** Jarvis shall assign a correlation identifier to each user request or action chain.  
**R-040** Jarvis shall assign an idempotency key to each action that may be retried or deduplicated.  
**R-041** Jarvis shall prevent duplicate execution of the same logical action when its idempotency key matches an already processed action.  
**R-042** Jarvis shall retain correlation metadata across planning, approval, execution, logging, and recovery.  
**R-043** Jarvis shall expose correlation identifiers in logs and evidence records.

## 8. Approvals

**R-044** Jarvis shall bind approvals to exact action fingerprints.  
**R-045** An approval shall authorise a normalised representation of the specific action payload granted.  
**R-046** Jarvis shall invalidate approval reuse when the action fingerprint changes materially.  
**R-047** Jarvis shall record approver, approval time, scope, policy version, and action fingerprint.  
**R-048** Every approval shall define an expiry time, expiry condition, or explicit non-expiring policy classification.  
**R-049** Jarvis shall support approval revocation before consumption.  
**R-050** Jarvis shall mark approvals consumed when used unless explicitly reusable.  
**R-051** Reusable approvals shall remain constrained by their original fingerprint, policy version, scope, and lifecycle rules.  
**R-052** Standing automation authorisation shall not permit destructive, financial, credential-changing, or production-control actions unless a dedicated policy supports that class and requires separate strong approval.  
**R-053** Standing automation authorisation shall be bounded by scope, purpose, duration, and revocation rights.  
**R-054** Standing automation authorisation shall be logged and auditable.

## 9. Tool architecture

**R-055** Jarvis shall use explicit tools for internal and external actions.  
**R-056** Jarvis shall define a documented purpose for every tool.  
**R-057** Jarvis shall define inputs and outputs for every tool.  
**R-058** Jarvis shall define failure behaviour for every tool.  
**R-059** Jarvis shall require approval for risky tools.  
**R-060** Jarvis shall log tool execution in an audit trail.  
**R-061** Jarvis shall not allow tool failures to silently mutate state.  
**R-062** Jarvis shall not allow tools to bypass approval, policy, or traceability controls.

## 10. Credential handling

**R-063** Jarvis shall not store raw integration credentials as ordinary data fields.  
**R-064** Jarvis shall store only secure credential references for integrations.  
**R-065** Jarvis shall resolve credential references only through an authorised secret-handling mechanism.  
**R-066** Jarvis shall avoid exposing credential values in logs, exports, or evidence except through an explicitly authorised secure process.

## 11. Data model

**R-067** Jarvis shall define the persisted entities it owns.  
**R-068** Jarvis shall define ownership for every mutable entity.  
**R-069** Jarvis shall preserve timestamps for important records where relevant.  
**R-070** Jarvis shall version entities that may evolve.  
**R-071** Jarvis shall define relationships between persisted entities explicitly.  
**R-072** Jarvis shall support backup, restore, and migration of persisted data.

Required entities: User, Session, Note, Memory item, Task, Reminder, Plan, Plan step, Action log, Approval record, Integration credential reference.

## 12. State transitions

**R-073** Jarvis shall define valid state transitions for mutable entities.  
**R-074** Jarvis shall reject invalid state transitions.  
**R-075** Jarvis shall record relevant state transitions in history.  
**R-076** Jarvis shall produce the same transition decision for the same validated input, prior authoritative state, policy version, and relevant deterministic context.

## 13. Retention and history

**R-077** Jarvis shall define retention rules for each persisted entity class.  
**R-078** Jarvis shall define append-only history for actions, approvals, and significant state changes.  
**R-079** Jarvis shall not overwrite append-only history entries in place.  
**R-080** Jarvis shall prune or archive only where retention rules permit it.  
**R-081** Jarvis shall make history reviewable for debugging, audit, and recovery.

## 14. Safety rules

**R-082** Jarvis shall never send messages or email without confirmation except where tightly scoped standing automation authorisation explicitly permits it.  
**R-083** Jarvis shall never delete or overwrite important data without approval.  
**R-084** Jarvis shall never guess ambiguous dates or times.  
**R-085** Jarvis shall preserve ambiguous temporal text rather than invent certainty.  
**R-086** Jarvis shall never hide failed actions as success.  
**R-087** Jarvis shall never exceed the active permission scope.  
**R-088** Jarvis shall always log external actions.  
**R-089** Jarvis shall provide a recovery path for significant actions where possible.  
**R-090** Jarvis shall explain uncertainty rather than invent certainty.

## 15. Execution flow

**R-091** Jarvis shall parse each request before action.  
**R-092** Jarvis shall classify each request into a mode.  
**R-093** Jarvis shall check permissions before execution.  
**R-094** Jarvis shall load relevant memory and state before planning or acting.  
**R-095** Jarvis shall request approval before actions requiring it.  
**R-096** Jarvis shall execute approved actions only.  
**R-097** Jarvis shall log action outcomes.  
**R-098** Jarvis shall update each entity only under its documented state model and shall not apply states belonging to another entity class.  
**R-098A** Jarvis shall record pending, partial, failed, and indeterminate execution states when external outcomes are unconfirmed.  
**R-098B** Jarvis shall reconcile indeterminate external actions before retrying, finalising, or compensating a workflow.  
**R-098C** Jarvis shall not represent uncertain external outcomes as successful without sufficient evidence.

## 16. Error handling

**R-099** Jarvis shall reject invalid input without mutating state.  
**R-100** Jarvis shall explain permission errors clearly.  
**R-101** Jarvis shall report tool failures clearly.  
**R-102** Jarvis shall quarantine or safely recover corrupted storage.  
**R-103** Jarvis shall record partial execution clearly.  
**R-104** Jarvis shall define recovery behaviour for each major failure class.

## 17. Testing and evidence

**R-105** Jarvis shall support unit tests for parsing, validation, and state logic.  
**R-106** Jarvis shall support integration tests for tools and persistence.  
**R-107** Jarvis shall support workflow tests for end-to-end scenarios.  
**R-108** Jarvis shall support failure tests for invalid input and failed actions.  
**R-109** Jarvis shall support migration tests for schema changes.  
**R-110** Jarvis shall maintain a requirement-to-test-to-evidence matrix.  
**R-111** Each implemented requirement shall be traceable to at least one test and one evidence artefact.

## 18. Release strategy

**R-112** Jarvis shall define local development, preview, production, and rollback stages.  
**R-113** Jarvis shall support safe release procedures.  
**R-114** Jarvis shall support rollback when a release misbehaves.  
**R-115** Jarvis shall support backup before risky changes.  
**R-116** Jarvis shall check runtime compatibility before deployment.

## 19. Operations

**R-117** Jarvis shall document setup instructions.  
**R-118** Jarvis shall document backup and restore procedures.  
**R-119** Jarvis shall provide useful debugging logs without exposing unnecessary sensitive data.  
**R-120** Jarvis shall document incident recovery for corrupted state, failed authentication, and broken integrations.  
**R-121** Jarvis shall be operable without relying on tribal knowledge.

## 20. Roadmap linkage

**R-122** Jarvis shall distinguish implemented, partial, planned, deferred, and rejected capabilities.  
**R-123** Jarvis shall map roadmap items to relevant requirements.  
**R-124** Jarvis shall remain a living document updated when roadmap priorities change.

## 21. Definition of done

**R-125** A feature shall be done only when documented, tested, safe, and consistent with this specification.  
**R-126** A feature shall not be done if it breaks existing durable data.  
**R-127** A feature shall not be done if it violates safety rules.

## 22. Concurrency and consistency

**R-128** Jarvis shall define concurrency behaviour for every mutating operation.  
**R-129** Jarvis shall prevent duplicate, conflicting, or stale writes from silently replacing authoritative state.  
**R-130** Jarvis shall use a documented consistency mechanism such as transactions, revision checks, optimistic concurrency, or narrowly scoped locking.  
**R-131** Jarvis shall record detected concurrency conflicts and their resolution outcomes.

## 23. Policy versioning

**R-132** Jarvis shall record the policy version used for each permission, approval, and execution decision.  
**R-133** Jarvis shall preserve historical policy versions or sufficient immutable metadata to interpret past decisions.  
**R-134** A policy change shall not retroactively expand an existing approval.  
**R-135** An approval materially affected by a policy change shall be rejected or revalidated before execution.

## 24. Time and timezone handling

**R-136** Jarvis shall define explicit timezone behaviour for all time-based features.  
**R-137** Jarvis shall preserve the original temporal expression, normalised value, timezone, and resolution confidence where relevant.  
**R-138** Jarvis shall preserve timezone context for due dates, reminders, schedules, approvals, and audit timestamps.  
**R-139** Jarvis shall define daylight-saving, nonexistent-local-time, duplicated-local-time, and user-timezone-change behaviour.  
**R-140** Jarvis shall reject or request clarification for temporal input that cannot be resolved safely under the active time policy.

## 25. Indeterminate external outcomes

**R-141** Jarvis shall represent uncertain external outcomes as indeterminate until reconciled.  
**R-142** Jarvis shall not automatically retry an indeterminate external action unless reliable provider idempotency exists or the previous outcome has been reconciled.  
**R-143** Jarvis shall record reconciliation attempts, evidence, outcome, and compensating action.

## 26. Revision and freeze rules

**R-144** Requirement IDs shall remain stable once assigned.  
**R-145** Requirement IDs shall not be recycled.  
**R-146** Uppercase suffixes may be used only for genuine subordinate refinements.  
**R-147** Superseded requirements shall remain traceable.  
**R-148** Rejected requirements shall remain traceable.  
**R-149** New requirements shall receive new IDs rather than shifting existing numbering.  
**R-150** Wording changes shall be recorded in revision history.

## Frozen namespace map

| Area | IDs |
|---|---|
| Purpose and scope | R-001–R-004 |
| Core modes | R-005–R-014 |
| Requirement lifecycle | R-015–R-021 |
| Operational locality | R-022–R-024F |
| Memory | R-025–R-033 |
| Effect and sensitivity | R-034–R-038C |
| Idempotency and correlation | R-039–R-043 |
| Approvals | R-044–R-054 |
| Tools | R-055–R-062 |
| Credentials | R-063–R-066 |
| Data model | R-067–R-072 |
| State transitions | R-073–R-076 |
| Retention and history | R-077–R-081 |
| Safety | R-082–R-090 |
| Execution | R-091–R-098C |
| Error handling | R-099–R-104 |
| Testing and evidence | R-105–R-111 |
| Release | R-112–R-116 |
| Operations | R-117–R-121 |
| Roadmap | R-122–R-124 |
| Definition of done | R-125–R-127 |
| Concurrency | R-128–R-131 |
| Policy versioning | R-132–R-135 |
| Time and timezone | R-136–R-140 |
| Indeterminate outcomes | R-141–R-143 |
| Revision and freeze | R-144–R-150 |
