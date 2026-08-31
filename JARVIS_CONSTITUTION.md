# JARVIS_CONSTITUTION

Status: canonical invariants
Change policy: constitutional changes are Risk 3 and require explicit operator authority.

These IDs are stable, long-lived identifiers. Existing IDs must not be silently redefined; materially changed semantics require a new ID/version.

## Constitutional laws

### JARVIS-001 — Unique completion authority
ΩΣ is the sole authority permitted to commit terminal `COMPLETE` state for governed missions/actions subject to ΩΣ completion. Other subsystems may request evaluation and provide evidence but may not manufacture or commit completion.

### JARVIS-002 — Model output is proposal, not authority
LLM/model output never constitutes execution authority, authoritative truth, accepted evidence, or completion solely because a model produced it.

### JARVIS-003 — Governed external effects
External side effects must pass through the existing governed execution boundary (ToolActions or an explicitly superseding governed capability contract). Direct provider invocation may not bypass authorisation, claims, receipts, or reconciliation requirements.

### JARVIS-004 — Durable evidence before completion
Completion decisions require durable evidence appropriate to the declared evidence requirements. Provider acknowledgement alone is not automatically proof of real-world completion.

### JARVIS-005 — Indeterminate remains indeterminate
When evidence cannot establish whether an operation succeeded, Jarvis must preserve an `INDETERMINATE` outcome until reconciliation resolves it. Ambiguity may not be coerced into success or failure for convenience.

### JARVIS-006 — HUD is not authoritative state
HUD/Totality surfaces project, request, and control authoritative state held elsewhere. UI state must not become a second authority path.

### JARVIS-007 — Authority cannot expand by delegation
Workers, models, missions, and child tasks may inherit only authority contained within their parent capability envelope. They may reduce or relinquish authority; they may not silently expand it.

### JARVIS-008 — Contradictions are preserved
Material contradictions and their resolutions are append-only records. Resolving a contradiction must not erase the conflicting evidence/history that caused it.

### JARVIS-009 — Governed knowledge promotion
Observed patterns or model-generated insights may create knowledge proposals, but governing/operational knowledge changes require the declared validation and promotion path.

### JARVIS-010 — Constitution is not self-modifiable
Autonomous workers and models may propose constitutional changes but may not authorise or commit them. Constitutional changes require explicit operator authority.

### JARVIS-011 — Deterministic admissibility
Where admissibility can be decided deterministically, models may propose but deterministic services must validate legal transition, schema, policy, authority, budget, idempotency, and evidence requirements before authoritative state changes.

### JARVIS-012 — Authoritative transition history is append-only
Material state transitions must emit durable transition/event records. Materialised projections may change, but they must remain derivable and auditable from authoritative history using a known reducer version.

### JARVIS-013 — Actor roles are distinct
`requested_by`, `evaluated_by`, `authorised_by`, and `committed_by` are distinct roles. A subsystem occupying one role does not implicitly gain authority belonging to another.

### JARVIS-014 — Stable transition identities
Governed transitions use stable transition IDs referenced by code, tests, logs, policy, and audit. Material semantic changes require versioning or a new transition ID rather than silent reinterpretation.

### JARVIS-015 — Failure classes are not interchangeable
`REJECTED`, `FAILED`, and `INDETERMINATE` have distinct semantics:
- `REJECTED`: requested transition/operation was not admissible and did not validly begin;
- `FAILED`: valid operation began and evidence establishes failure;
- `INDETERMINATE`: valid operation may have produced an effect but available evidence cannot establish outcome.

### JARVIS-016 — Retries apply to operations, not history
Retry policy governs underlying operations. Authoritative transitions/events are not blindly replayed to simulate retry. Retries must generate their own durable attempt evidence and remain idempotent where required.

### JARVIS-017 — Fail closed on authority ambiguity
Missing, expired, contradictory, or unverifiable authority/evidence required by a gate must deny or defer the transition rather than assume permission.

### JARVIS-018 — Existing authority paths are not duplicated
New subsystems must integrate with existing ΩΣ, ToolAction, claim, receipt, reconciliation, and contradiction-resolution paths where those paths are authoritative. Parallel authority implementations are forbidden unless explicitly approved as a governed migration.
