# Jarvis Totality Handover Dossier

## Document control

- Project: Jarvis Totality
- Baseline: v2.2
- Frozen namespace: R-001–R-150
- Repository: `Benny3840/Jarvis`
- Authorised Convex target: `dev:outgoing-ram-798`
- Production status: prohibited without Benny's explicit, production-specific approval
- Status: conditional handover; governance framework accepted, traceability population still open

## Purpose

This dossier transfers operational understanding from architecture ownership to build-and-maintain ownership. It is the maintainer's map, not the source of normative authority. Authority and conflict resolution are defined in the [governance index](README.md).

## System mission

Jarvis is a local-first, policy-governed assistant for business, home and workshop use. It supports notes, tasks, reminders, planning, quoting, scheduling, messaging, research, approvals, reconciliation and traceable automation while remaining explicit, auditable and recoverable.

The project name does not grant unrestricted authority, access, autonomy or execution rights. Every action remains subject to policy, ownership, approval, deployment and reconciliation boundaries.

## Governing constraints

- R-001–R-127 retain their original meanings and numbering.
- R-128–R-143 contain the four accepted architectural sections.
- R-144–R-150 govern revision and freeze control.
- Requirement IDs are never renamed, recycled or reassigned.
- Uppercase suffixes are permitted only for genuine subordinate refinements.
- Approvals bind to exact action fingerprints.
- Superseded and rejected records remain traceable.
- Generated views are read-only and non-authoritative.
- Proposals and drafts do not become authorised commands merely by existing.
- Tool errors and indeterminate responses must not be treated as successful execution.

## Architecture boundaries

1. Interface layer — chat, voice and operator commands.
2. Policy layer — permissions, approvals, fingerprints and authority checks.
3. Planning layer — decomposition, drafting and estimation without hidden side effects.
4. Execution layer — registered tools and explicit external effects.
5. State layer — durable owner-scoped records and entity-specific lifecycles.
6. Evidence layer — logs, tests, approvals, reconciliation and release proof.

Policy, planning and execution must remain separate. No implementation may bypass the durable Convex-backed state or invent a parallel untracked business model.

## Deployment boundary

Development work is authorised only against `dev:outgoing-ram-798`. A production deployment is a separate high-impact action and requires explicit approval that specifically names production. Generic approval to proceed, merge or deploy development does not authorise production.

## Transfer gates

### Gate 1 — Baseline freeze

- Namespace frozen.
- Authority order published.
- State glossary controlled.
- Generated action map defined as non-authoritative.

### Gate 2 — Core state

- Notes, tasks, reminders and plans use durable state.
- Approvals and fingerprints are enforced.
- Logs and evidence capture exist.

### Gate 3 — Safety and control

- Idempotency and correlation are enforced.
- Concurrency and policy-version checks exist.
- Timezone semantics are explicit.
- Indeterminate outcomes reconcile before retry or completion.

### Gate 4 — Operational workflows

- Quotes, scheduling, messaging, supplier research and workshop planning are mapped to requirements, tests and evidence.

### Gate 5 — Acceptance

- Requirements, tests and evidence are traceable.
- Negative paths and recovery paths are proven.
- Open gaps and residual risks are accepted by the correct authority.
- Production remains untouched unless separately approved.

## Incoming owner responsibilities

- Preserve the frozen namespace and authority hierarchy.
- Keep implementation status, tests and evidence synchronised.
- Record material decisions before claiming acceptance.
- Maintain gap and risk registers throughout implementation.
- Reconcile external actions and preserve audit history.

## Current transfer condition

The governance framework is accepted. Ownership transfer remains conditional until the canonical matrices are populated and CI evidence demonstrates that namespace, traceability and deployment-boundary rules are enforced.
