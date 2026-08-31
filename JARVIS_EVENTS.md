# JARVIS_EVENTS

Status: canonical event contract
Initial domain: Development

## Purpose

Events are durable facts about observations, requests, decisions, operations, transitions, receipts, reconciliation, and completion. They provide causal provenance and the authoritative history from which projections can be rebuilt.

Events are not authority by themselves. An event records that an authorised subsystem committed or observed something; authority remains defined by the Constitution and transition contract.

## Canonical envelope

```ts
export type ActorRef = {
  actorType: "operator" | "control-plane" | "controller" | "worker" | "model" | "provider" | "omega" | "reconciler";
  actorId: string;
};

export type JarvisEvent = {
  eventId: string;
  eventType: string;
  subjectId: string;
  transitionId?: string;

  requestedBy?: ActorRef;
  evaluatedBy?: ActorRef;
  authorisedBy?: ActorRef;
  committedBy?: ActorRef;

  occurredAt: string;
  recordedAt: string;

  evidenceIds: string[];
  correlationId: string;
  causationId?: string;

  reducerVersion: string;
  payload: Record<string, unknown>;
};
```

## Required semantics

### eventId
Globally unique immutable event identifier.

### eventType
Stable semantic event name. Event type and transition ID are related but not identical: operations/observations may emit events without committing a state transition.

### subjectId
Stable ID of the mission/action/entity whose history contains the event.

### transitionId
Required for a committed governed transition. Must reference a stable ID in `JARVIS_TRANSITIONS.md`.

### requestedBy / evaluatedBy / authorisedBy / committedBy
Roles are recorded separately. Missing roles are allowed only when the event type legitimately does not use that role (for example a raw provider observation). A committed transition must record the authoritative committer required by its transition definition.

### occurredAt
When the real-world/system fact occurred, if known.

### recordedAt
When Jarvis durably recorded the event. Must be server-derived for authoritative writes.

### evidenceIds
References durable evidence/receipt/verification records supporting the event. IDs must never be invented by a model and treated as proven merely because they are syntactically present.

### correlationId
Groups all events belonging to one logical mission/request flow.

### causationId
References the immediate prior event that caused this event where a causal link is known. This enables `why did Jarvis do this?` traversal without inferring causality from timestamps.

### reducerVersion
Version of the deterministic reducer contract expected to consume the event when producing a projection.

## Causal chain example

```text
GitHub issue observation
  -> specification validation
  -> mission READY transition
  -> worker claim
  -> BUILDING transition
  -> verification run
  -> REVIEW transition
  -> approval
  -> merge operation receipt
  -> MERGED transition
  -> post-merge observation
  -> ΩΣ evaluation
  -> COMPLETE transition
```

Each arrow must be explainable using correlation/causation references and durable evidence.

## Projection rules

- Authoritative event history is append-only.
- Projection reducers are deterministic and versioned.
- Reducers may update materialised current-state records; callers may not bypass reducers for governed state changes.
- A projection must record sufficient metadata to identify the latest consumed event/reducer version.
- Rebuilding a projection from the same ordered event set and reducer version must produce the same governed state.
- Projection divergence cannot grant authority or completion absent the authoritative events/evidence required by the relevant transition.

## Operation attempts and retries

Each external or consequential operation attempt gets its own attempt event/receipt. Retry attempts do not overwrite prior attempts.

Example:

```text
MERGE_ATTEMPT_STARTED attempt=1
MERGE_ATTEMPT_INDETERMINATE attempt=1
RECONCILIATION_OPENED
PROVIDER_OBSERVATION merged=true
RECONCILIATION_RESOLVED
DEV_TRANSITION_READY_TO_MERGE_TO_MERGED
```

This preserves the distinction between operation retry and authoritative transition history.

## Failure-event semantics

- `*_REJECTED`: request was not admissible; no valid operation began.
- `*_FAILED`: valid operation began and evidence establishes failure.
- `*_INDETERMINATE`: effect may have occurred; reconciliation required.

A consumer must not translate `INDETERMINATE` to `FAILED` merely to simplify UI or control flow.

## Minimum Development Phase 1 event types

- `DEV_SPEC_VALIDATED`
- `DEV_TRANSITION_COMMITTED`
- `DEV_TRANSITION_REJECTED`
- `DEV_WORKER_CLAIM_CREATED`
- `DEV_LEASE_EXPIRED`
- `DEV_BUILD_RESULT_RECORDED`
- `DEV_VERIFICATION_RESULT_RECORDED`
- `DEV_REVIEW_RESULT_RECORDED`
- `DEV_REPAIR_REQUIRED`
- `DEV_MERGE_ATTEMPT_STARTED`
- `DEV_MERGE_ATTEMPT_FAILED`
- `DEV_MERGE_ATTEMPT_INDETERMINATE`
- `DEV_MERGE_RECEIPT_RECORDED`
- `DEV_RECONCILIATION_OPENED`
- `DEV_RECONCILIATION_RESOLVED`
- `DEV_POST_MERGE_OBSERVATION_RECORDED`
- `DEV_OMEGA_EVALUATION_RECORDED`

## Audit questions the event model must answer

- Who requested this transition?
- Which deterministic gate evaluated it?
- Who authorised it?
- Which component committed it?
- Which evidence supported the decision at that time?
- Which event caused this event?
- Which mission/request correlated the chain?
- What reducer version produced the current projection?
- Was an operation retried, failed, rejected, or indeterminate before the final projection?
- Did ΩΣ itself commit completion?
