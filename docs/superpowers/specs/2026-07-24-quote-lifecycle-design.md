# Quote Revision, Finalisation and Delivery Design

**Issue:** #152  
**Baseline:** `03553930e20ebb08064c5c8353f77c1b324b3d8d`  
**Branch:** `feat/quote-lifecycle-152`  
**Status:** Approved architecture; implementation not yet authorised  
**Safety boundary:** Development only. No Convex or Manufact production deployment.

## 1. Purpose

Replace the current single-record quote model with an owner-scoped, revision-safe model that separates:

1. the stable commercial quote aggregate;
2. immutable and auditable quote revisions; and
3. provider-facing delivery attempts governed by the external reconciliation subsystem from issue #154.

The design is the prerequisite for `AM-012 Finalize quote`, `AM-013 Send quote`, and `WF-QUOTE-001`. Those action families and workflow remain `planned` until their runtime bindings, tests, development commissioning evidence, and governance activation are complete.

## 2. Existing-state problem

The current `Quote` type combines content, commercial outcome, and delivery state in one mutable object. Its status is `draft | sent | accepted | declined`, and the generic update method permits arbitrary status and content replacement. The JSON and in-memory stores have no owner boundary, revision number, immutable finalised snapshot, optimistic concurrency guard, approval fingerprint, delivery-attempt ledger, or reconciliation binding.

This creates four unacceptable failure modes:

- sending state can overwrite or be confused with commercial acceptance state;
- a finalised quote can be changed without producing a new auditable revision;
- an approval can silently apply to changed content or a changed recipient;
- provider uncertainty can lead to a blind duplicate send.

## 3. Chosen architecture

Use three independent Convex record families with narrow domain interfaces:

- `quotes`: stable aggregate identity and commercial outcome;
- `quoteRevisions`: versioned commercial content and finalisation lifecycle;
- `quoteDeliveryAttempts`: exact send intent, provider execution state, and reconciliation linkage.

The aggregate points to the current revision, but revisions and delivery attempts are separate records. This avoids unbounded document growth, isolates concurrent writes, permits indexed uniqueness checks, and lets delivery state evolve without mutating the commercial quote.

### Rejected alternatives

#### Single embedded quote document

Embedding all revisions and delivery attempts inside one quote document is initially simpler, but it creates document growth, write contention, broad replacement mutations, and difficult exactly-once guarantees.

#### Full event sourcing

An event-sourced quote domain would provide strong audit history, but it introduces replay, projection, migration, and operational complexity that is not justified for the current scope. The selected design retains immutable revision and attempt records without requiring a general event store.

## 4. Domain model

### 4.1 Quote aggregate

```ts
export type QuoteCommercialStatus = "open" | "accepted" | "declined" | "expired";

export type QuoteAggregate = {
  quoteId: string;
  ownerId: string;
  clientId: string;
  projectId?: string;
  number: string;
  currentRevision: number;
  currentRevisionId: string;
  aggregateVersion: number;
  commercialStatus: QuoteCommercialStatus;
  commercialRevision?: number;
  commercialRecordedAt?: number;
  createdAt: number;
  updatedAt: number;
};
```

Rules:

- `quoteId` is stable for the life of the commercial opportunity.
- `ownerId` is derived exclusively through the existing authenticated `requireOwner` boundary.
- `number` is unique per owner.
- `aggregateVersion` increments on every aggregate mutation and is required for optimistic concurrency.
- `currentRevision` is monotonically increasing and never decreases.
- `commercialStatus` is independent of delivery status.
- `accepted`, `declined`, and `expired` record the exact `commercialRevision` to which the outcome applies.
- A later revision returns the aggregate to `open`; it does not erase the historical outcome recorded against the older revision.

### 4.2 Quote revision

```ts
export type QuoteRevisionStatus = "draft" | "reviewed" | "finalized";

export type QuoteRevisionLineItem = {
  description: string;
  quantity: number;
  unitPrice: number;
};

export type QuoteRevision = {
  revisionId: string;
  ownerId: string;
  quoteId: string;
  revision: number;
  revisionVersion: number;
  status: QuoteRevisionStatus;
  lineItems: QuoteRevisionLineItem[];
  subtotal: number;
  taxRate?: number;
  tax: number;
  total: number;
  currency: "AUD";
  validUntil?: string;
  notes?: string;
  termsIncluded: boolean;
  fingerprint?: string;
  predecessorRevisionId?: string;
  reviewedAt?: number;
  finalizedAt?: number;
  createdAt: number;
  updatedAt: number;
};
```

Rules:

- Revision numbers are unique within `(ownerId, quoteId)`.
- Totals are always derived server-side from line items and tax rate.
- Content may be edited only while `status === "draft"`.
- `draft -> reviewed` is the normal review transition.
- `reviewed -> draft` is allowed only through an explicit `reopenForEditing` command. It clears `reviewedAt`, increments `revisionVersion`, and remains auditable through the updated timestamps and mutation receipt.
- `reviewed -> finalized` is the only finalisation transition. Direct `draft -> finalized` is rejected; the planned `AM-012` registry state impact must be corrected before activation.
- A finalised revision is immutable. No field, including notes, validity, totals, or terms, may be patched.
- Editing after finalisation creates revision `N + 1` in `draft` state by atomically copying the finalised content and advancing the aggregate pointer.
- The finalisation fingerprint is generated from canonical content, not timestamps or database IDs.

### 4.3 Finalised revision fingerprint

The canonical revision fingerprint is:

```text
quote-revision:v1:sha256(canonicalJson({
  ownerId,
  quoteId,
  revision,
  clientId,
  projectId,
  number,
  lineItems,
  subtotal,
  taxRate,
  tax,
  total,
  currency,
  validUntil,
  notes,
  termsIncluded
}))
```

The fingerprint is written once during finalisation and never recomputed from mutable state. A finalisation replay with the same quote, revision, and fingerprint returns the existing finalised revision. A changed fingerprint for the same revision is rejected and audited as a collision.

### 4.4 Quote delivery attempt

```ts
export type QuoteDeliveryStatus =
  | "pending"
  | "executing"
  | "succeeded"
  | "failed"
  | "indeterminate"
  | "reconciled";

export type QuoteDeliveryAttempt = {
  deliveryAttemptId: string;
  ownerId: string;
  quoteId: string;
  revision: number;
  revisionId: string;
  revisionFingerprint: string;
  recipient: string;
  channel: "email";
  sendFingerprint: string;
  idempotencyKey: string;
  approvalId: string;
  actionFingerprint: string;
  status: QuoteDeliveryStatus;
  reconciledOutcome?: "succeeded" | "failed";
  provider: string;
  providerRequestId?: string;
  providerCorrelationId?: string;
  reconciliationId?: string;
  providerErrorCode?: string;
  createdAt: number;
  executionStartedAt?: number;
  completedAt?: number;
  reconciledAt?: number;
  updatedAt: number;
};
```

Rules:

- A delivery attempt can reference only a `finalized` revision whose stored fingerprint matches the request.
- Recipient addresses are normalised deterministically before fingerprinting.
- Delivery state never changes `commercialStatus`.
- `reconciled` is used only after an earlier `indeterminate` result. `reconciledOutcome` preserves whether the provider ultimately proved success or failure.
- Provider request and correlation identifiers are persisted through the external reconciliation boundary before the attempt may be treated as recoverable.
- An attempt without a durable provider reference cannot become `succeeded`; it becomes `indeterminate` or `failed` according to the existing reconciliation rules.

## 5. State machines

### 5.1 Revision lifecycle

```text
create quote
  -> revision 1 draft

draft
  -> reviewed                 submitForReview

reviewed
  -> draft                    reopenForEditing
  -> finalized                finalizeRevision

finalized
  -> immutable
  -> new draft revision N+1   createRevisionFromFinalized
```

Invalid transitions return a typed conflict and do not mutate state.

### 5.2 Commercial lifecycle

```text
open
  -> accepted
  -> declined
  -> expired

accepted | declined | expired
  -> open only when a newer draft revision is created
```

Commercial outcome commands require the exact aggregate version and exact revision being accepted, declined, or expired. Delivery success does not imply acceptance.

### 5.3 Delivery lifecycle

```text
pending
  -> executing

executing
  -> succeeded
  -> failed
  -> indeterminate

indeterminate
  -> reconciled { reconciledOutcome: succeeded }
  -> reconciled { reconciledOutcome: failed }
```

There is no transition from `indeterminate` back to `executing`. The original external effect is never retried blindly. Only the provider-status reconciliation adapter may resolve the outcome.

## 6. Optimistic concurrency

Every write command carries explicit expected versions:

- aggregate commands require `expectedAggregateVersion`;
- draft revision edits and transitions require `expectedRevisionVersion`;
- finalisation requires both expected versions and the expected revision number;
- creating a new revision from a finalised revision requires the aggregate pointer and finalised fingerprint to match;
- commercial outcome updates require the expected aggregate version and target revision;
- delivery creation requires the exact stored revision fingerprint.

A mismatch returns `quote-version-conflict` with no partial write. Convex mutations update all related records atomically.

## 7. Approval and execution binding

Jarvis retains the existing `ToolAction` approval model. No separate approval authority or free-standing approval table is introduced.

For `AM-013 Send quote`, the approved action fingerprint must cover:

```text
action_family_id
owner_id
quote_id
quote_revision
revision_fingerprint
recipient
delivery_channel
```

The delivery attempt stores the exact `approvalId` and `actionFingerprint` from the approved `ToolAction`.

Approval consumption means:

1. the exact approved action enters `ToolExecutionService` once;
2. the delivery attempt is atomically created or replayed for the exact send fingerprint;
3. the tool-execution receipt and external reconciliation record prevent a second provider execution;
4. changed content, revision, recipient, or channel produces a different fingerprint and requires a new approval.

The quote domain does not independently decide whether approval is valid. It validates that the approved action inputs still match the authoritative finalised revision and delivery request.

## 8. Send fingerprint and idempotency

The canonical send fingerprint is:

```text
quote-send:v1:sha256(canonicalJson({
  ownerId,
  quoteId,
  revision,
  revisionFingerprint,
  normalizedRecipient,
  channel
}))
```

The idempotency scope is `(ownerId, quoteId, revision, normalizedRecipient, channel)`.

Behaviour:

- exact duplicate: return the original delivery attempt or terminal receipt;
- same scope with changed revision fingerprint: reject and audit;
- same quote revision sent to a different recipient: new scope, new approval, new attempt;
- same quote revision sent through a different channel: new scope, new approval, new attempt;
- unresolved attempt: return the original indeterminate state and never call the provider again;
- reconciled attempt: return the reconciled outcome.

## 9. Convex persistence design

### 9.1 `quotes`

Required indexes:

- `by_owner_and_quote_id`
- `by_owner_and_number`
- `by_owner_and_client_id`
- `by_owner_and_project_id`

### 9.2 `quoteRevisions`

Required indexes:

- `by_owner_quote_and_revision`
- `by_owner_and_revision_id`
- `by_owner_quote_and_status`
- `by_owner_and_fingerprint`

### 9.3 `quoteDeliveryAttempts`

Required indexes:

- `by_owner_and_delivery_attempt_id`
- `by_owner_and_send_scope`
- `by_owner_quote_and_revision`
- `by_owner_and_reconciliation_id`
- `by_owner_and_status`

All lookups use bounded indexed queries. Unbounded `.collect()` and post-query filtering are prohibited for authoritative mutation paths.

## 10. Domain interfaces

The current broad `QuoteStore.update(id, update)` interface is replaced by explicit commands:

```ts
export interface QuoteRepository {
  createQuote(input: CreateQuoteInput): Promise<QuoteSnapshot>;
  getQuote(quoteId: string): Promise<QuoteSnapshot | null>;
  listQuotes(input: ListQuotesInput): Promise<QuoteSummary[]>;
  updateDraft(input: UpdateQuoteDraftInput): Promise<QuoteSnapshot>;
  submitForReview(input: QuoteRevisionCommand): Promise<QuoteSnapshot>;
  reopenForEditing(input: QuoteRevisionCommand): Promise<QuoteSnapshot>;
  finalizeRevision(input: FinalizeQuoteRevisionInput): Promise<QuoteSnapshot>;
  createRevisionFromFinalized(input: CreateQuoteRevisionInput): Promise<QuoteSnapshot>;
  recordCommercialOutcome(input: RecordQuoteCommercialOutcomeInput): Promise<QuoteSnapshot>;
}

export interface QuoteDeliveryRepository {
  getBySendScope(input: QuoteSendScope): Promise<QuoteDeliveryAttempt | null>;
  createPending(input: CreateQuoteDeliveryInput): Promise<QuoteDeliveryAttempt>;
  markExecuting(input: StartQuoteDeliveryInput): Promise<QuoteDeliveryAttempt>;
  bindProviderReference(input: BindQuoteProviderReferenceInput): Promise<QuoteDeliveryAttempt>;
  complete(input: CompleteQuoteDeliveryInput): Promise<QuoteDeliveryAttempt>;
  markIndeterminate(input: MarkQuoteDeliveryIndeterminateInput): Promise<QuoteDeliveryAttempt>;
  reconcile(input: ReconcileQuoteDeliveryInput): Promise<QuoteDeliveryAttempt>;
}
```

No generic status setter remains.

## 11. HTTP and tool boundaries

### 11.1 HTTP quote administration

The authenticated HTTP API exposes controlled quote administration:

- `POST /api/v1/quotes`
- `GET /api/v1/quotes`
- `GET /api/v1/quotes/:quoteId`
- `PATCH /api/v1/quotes/:quoteId/revisions/:revision`
- `POST /api/v1/quotes/:quoteId/revisions/:revision/review`
- `POST /api/v1/quotes/:quoteId/revisions/:revision/reopen`
- `POST /api/v1/quotes/:quoteId/revisions/:revision/finalize`
- `POST /api/v1/quotes/:quoteId/revisions/:revision/fork`
- `POST /api/v1/quotes/:quoteId/commercial-outcome`
- `GET /api/v1/quotes/:quoteId/deliveries`

The old generic `PATCH /api/v1/quotes/:quoteId` status mutation is removed after migration. Until migration completes, it must reject `status` and any mutation of a finalised record.

### 11.2 Tool actions

- `TOOL-QUOTE-FINALIZE` consumes the controlled finalisation command and remains internal-only.
- `TOOL-QUOTE-SEND` uses `ToolExecutionService` with `externalProvider`, the exact send fingerprint, provider-attempt registration, and the reconciliation store.
- Neither tool enters the live allowlist during the initial storage and lifecycle implementation.

## 12. Error model

Typed domain errors map to HTTP problem details and tool receipts:

- `quote-not-found`
- `quote-revision-not-found`
- `quote-version-conflict`
- `quote-invalid-transition`
- `quote-finalized-immutable`
- `quote-fingerprint-mismatch`
- `quote-number-conflict`
- `quote-recipient-invalid`
- `quote-delivery-collision`
- `quote-delivery-pending-reconciliation`
- `quote-cross-owner-access-denied`
- `quote-persistence-failed`

Cross-owner access returns the same externally visible not-found response as an absent record, while an internal audit event records the denied owner mismatch. This avoids leaking record existence.

## 13. Migration and compatibility

The current JSON and in-memory quote stores remain test fixtures only after the Convex model becomes authoritative.

Development migration rules:

1. read existing JSON quotes without mutating them;
2. create one aggregate and one revision per legacy quote;
3. map legacy `draft` to revision `draft` and commercial `open`;
4. map legacy `sent` to a finalised revision with commercial `open`, but create no synthetic provider delivery attempt because provider evidence does not exist;
5. map legacy `accepted` to a finalised revision and commercial `accepted`;
6. map legacy `declined` to a finalised revision and commercial `declined`;
7. derive totals again from line items;
8. produce a migration report containing source ID, destination quote ID, mapped state, and any rejected row;
9. make migration idempotent through a stable legacy-source key;
10. retain the source file until explicit cleanup is separately authorised.

No production migration is included in this issue.

## 14. Testing requirements

### Domain tests

- create revision 1 as draft with derived totals;
- reject arbitrary status changes;
- allow only controlled transitions;
- reject direct draft finalisation;
- prove finalised revisions are immutable;
- fork a finalised revision to N+1 draft;
- invalidate prior send approval inputs after a new revision;
- preserve commercial outcome independently from delivery state.

### Concurrency and persistence tests

- reject stale aggregate version;
- reject stale revision version;
- atomically allocate one revision number under concurrent forks;
- enforce owner-scoped quote number uniqueness;
- prevent cross-owner reads and writes;
- prove fresh-client persistence after restart;
- use indexed queries for all authoritative paths.

### Delivery tests

- reject delivery for non-finalised revision;
- reject changed revision fingerprint;
- reject changed recipient under the same idempotency scope;
- replay exact duplicate without provider execution;
- persist provider request and correlation identifiers;
- produce one indeterminate record on timeout;
- block blind retry while unresolved;
- reconcile proven provider success and failure;
- preserve commercial outcome through delivery and reconciliation;
- consume the exact approved action once.

### HTTP and OpenAPI tests

- validate all controlled endpoints and request bodies;
- return `409` for version and fingerprint conflicts;
- return non-leaking `404` for absent and cross-owner records;
- remove the legacy generic status mutation contract;
- keep response totals server-derived.

### Development smoke

A self-cleaning smoke test must:

1. refuse any non-`dev:` deployment before store construction;
2. create a quote and draft revision;
3. review and finalise it;
4. verify immutable replay through a fresh client;
5. fork a new revision and prove the old fingerprint remains unchanged;
6. create a synthetic delivery attempt;
7. register a synthetic provider reference;
8. force an indeterminate outcome;
9. recover and reconcile through fresh worker/store instances;
10. verify commercial state was unchanged;
11. remove all synthetic quote, revision, delivery, reconciliation, and receipt records.

## 15. Governance and traceability

Before either action family becomes active:

- correct `AM-012` state impact to `reviewed -> finalized`;
- retain `AM-012` as `planned` until the finalisation store, tool, tests, and evidence exist;
- retain `AM-013` as `planned` until a real provider adapter, send tool, approval path, reconciliation tests, and immutable evidence exist;
- retain `WF-QUOTE-001` as `planned` until both actions are independently commissioned;
- add real, non-recycled `TEST-AM-012-*`, `TEST-AM-013-*`, `EVD-AM-012-*`, and `EVD-AM-013-*` registry entries;
- regenerate the non-authoritative action map only from the authoritative registry;
- validate tool and state-target registry bindings before activation.

Storage commissioning and action-family activation are separate checkpoints. Commissioning the quote store does not authorise sending.

## 16. Security and privacy

- Every Convex query and mutation derives `ownerId` from the existing service-token boundary.
- Client IDs, project IDs, recipients, notes, terms, and line items are private business data.
- Provider credentials remain server-side and never enter quote records, tool arguments, receipts, reconciliation records, logs, or artifacts.
- Recipient values may appear in private delivery records but must be redacted from public diagnostics and commissioning artifacts.
- Canonical fingerprints may be retained because they do not reveal plaintext quote content.
- Cleanup functions are restricted to `dev:outgoing-ram-798` and synthetic smoke identifiers.

## 17. Operational boundaries

- Development deployment: `dev:outgoing-ram-798`.
- Production deployment is prohibited without explicit production-specific approval.
- Manufact production is untouched by this design and implementation tranche.
- No email provider is selected or activated by this design.
- No quote send occurs during storage, lifecycle, migration, or smoke commissioning; the provider step remains synthetic until a later activation tranche.

## 18. Delivery sequence

Implementation is divided into independently reviewable tranches:

1. domain contracts and fingerprints;
2. Convex aggregate and revision persistence;
3. controlled HTTP administration and legacy compatibility;
4. finalisation tool binding while still planned;
5. delivery-attempt persistence and reconciliation integration;
6. synthetic development smoke and immutable storage evidence;
7. separate real-provider send implementation;
8. separate governance activation for `AM-012` and then `AM-013`.

The first implementation PR may deliver the model and controlled lifecycle without activating either action family. A provider-specific send implementation must be a later PR and a later approval checkpoint.

## 19. Acceptance criteria

The design is satisfied when:

- commercial quote state and delivery state are represented independently;
- every content change occurs in a numbered revision;
- finalised revisions are immutable;
- finalisation and delivery are bound to exact canonical fingerprints;
- stale revisions and concurrent updates fail closed;
- delivery attempts use durable provider references and no-blind-retry reconciliation;
- exact duplicate sends replay the original result;
- changed content or recipient requires a new approval;
- cross-owner access is prevented without leaking record existence;
- real TEST and EVD registry entries exist before activation;
- `AM-012`, `AM-013`, and `WF-QUOTE-001` remain planned until their separate exit criteria pass;
- no production deployment or real external send is performed by the initial implementation tranche.
