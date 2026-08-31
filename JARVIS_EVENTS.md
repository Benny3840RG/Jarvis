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
  eventSchemaVersion: number;
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

## Schema/reducer compatibility

Deterministic replay requires both event-schema and reducer versioning.

Each reducer version must declare exactly which event schema versions it can read, for example:

```text
DevelopmentReducer/v1 -> EventSchema/v1
DevelopmentReducer/v2 -> EventSchema/v1, EventSchema/v2
```

A reducer must fail closed on an unsupported event schema. Historical events are never silently rewritten to current schema. If migration is required, use an explicit deterministic upcaster/migration whose version and result are testable.

## Required semantics

### eventId
Globally unique immutable event identifier. Reducers must be idempotent by event ID: replaying an already-applied event cannot change the projection a second time.

### eventType
Stable semantic event name. Event type and transition ID are related but not identical: operations/observations may emit events without committing a state transition.

### eventSchemaVersion
Version of the payload/envelope contract consumed by compatible reducer versions.

### subjectId
Stable ID of the mission/action/entity whose history contains the event.

### transitionId
Required for a committed or rejected governed transition attempt. Must reference a stable ID in `JARVIS_TRANSITIONS.yaml`.

### requestedBy / evaluatedBy / authorisedBy / committedBy
Roles are recorded separately. Missing roles are allowed only when the event type legitimately does not use that role. A committed transition must record the authoritative committer required by its transition definition.

Actor role fields are evidence about who participated; they are not authentication. The commit boundary must validate authenticated capability/claim material and bind it to the required role before emitting a committed transition event.

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
Version of the deterministic reducer contract that consumed or is expected to consume the event when producing a projection.

## Rejected transition attempts are durable

Illegal or unauthorised transition attempts fail closed **and are recorded** as `DEV_TRANSITION_REJECTED` audit events.

A rejection event records:

- requested transition ID;
- source/current state;
- requester identity;
- deterministic evaluator identity/version;
- reason codes;
- authority/claim reference if supplied;
- correlation/causation IDs;
- zero authoritative state change.

This makes attempted approval bypass, stale lease use, authority expansion, and illegal state jumps forensically queryable.

## Commit-time authority enforcement

Authority is enforced inside the trusted transition commit boundary, not inside workers.

The commit boundary must:

1. authenticate the caller/claim using trusted server-side identity material;
2. load the transition definition from `JARVIS_TRANSITIONS.yaml`;
3. verify current persisted state/version;
4. verify required evaluator/authoriser outputs;
5. verify capability envelope is sufficient and non-expanded;
6. verify lease/claim freshness where required;
7. verify the authenticated committer class equals `authoritative_committer`;
8. atomically append the transition event and advance the projection with optimistic concurrency.

A caller-supplied string such as `actorType: "omega"` never grants ΩΣ authority. ΩΣ completion requires a trusted ΩΣ execution context/credential or server-internal capability unavailable to ordinary workers.

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
- Event schemas are versioned independently from reducers.
- Reducers declare an explicit event-schema compatibility map.
- Reducers may update materialised current-state records; callers may not bypass reducers for governed state changes.
- Projection updates and event append must be atomic or transactionally equivalent.
- Projection writes use optimistic concurrency/version checks so two workers cannot both commit conflicting transitions from the same prior version.
- A projection records latest consumed event ID, projection version, and reducer version.
- Replaying the same event ID twice is a no-op on the second application.
- Rebuilding a projection from the same ordered event set, schemas/upcasters, and reducer version must produce the same governed state.
- Projection divergence cannot grant authority or completion absent authoritative events/evidence.

## Operation attempts and retries

Each external or consequential operation attempt gets its own attempt event/receipt. Retry attempts do not overwrite prior attempts.

Example:

```text
DEV_MERGE_ATTEMPT_STARTED attempt=1
DEV_MERGE_ATTEMPT_INDETERMINATE attempt=1
DEV_RECONCILIATION_OPENED
PROVIDER_OBSERVATION merged=true
DEV_RECONCILIATION_RESOLVED
DEV_TRANSITION_READY_TO_MERGE_TO_MERGED
```

This preserves the distinction between operation retry and authoritative transition history.

## INDETERMINATE resolution contract

`INDETERMINATE` is not resolved by elapsed time alone.

An indeterminate consequential operation must open/attach to a reconciliation case. Reconciliation may:

- observe authoritative provider/external state and establish success;
- observe authoritative provider/external state and establish failure;
- gather operator-supplied evidence when external observation is unavailable;
- remain open when evidence is still insufficient.

Retry is allowed only when the operation's idempotency/reconciliation policy establishes that retry cannot create an untracked duplicate effect. A timeout may trigger escalation or another observation attempt, but must not automatically promote `INDETERMINATE` to `FAILED`.

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

- Who requested this transition, including rejected attempts?
- Which deterministic gate evaluated it?
- Who authorised it?
- Which authenticated component committed it?
- Which evidence supported the decision at that time?
- Which event caused this event?
- Which mission/request correlated the chain?
- Which event-schema and reducer versions produced the current projection?
- Was an operation retried, rejected, failed, or indeterminate before the final projection?
- Can replay demonstrate idempotent application?
- Did ΩΣ itself commit completion through the trusted completion boundary?
