# Quote Revision, Finalisation and Delivery Design

**Issue:** #152  
**Baseline:** `03553930e20ebb08064c5c8353f77c1b324b3d8d`  
**Branch:** `feat/quote-lifecycle-152`  
**Status:** Approved architecture; implementation not yet authorised  
**Safety boundary:** Development only. No Convex or Manufact production deployment.

## 1. Purpose

Replace the current single mutable quote record with an owner-scoped model that separates:

1. the stable quote aggregate;
2. numbered commercial revisions; and
3. provider-facing delivery attempts governed by the reconciliation subsystem from issue #154.

This design is prerequisite architecture for `AM-012 Finalize quote`, `AM-013 Send quote`, and `WF-QUOTE-001`. All three remain `planned` until their separate runtime, testing, commissioning, evidence, and governance gates pass.

## 2. Existing-state problem

The current `Quote` combines content, commercial outcome, and delivery state in one object with `draft | sent | accepted | declined`. Its generic update operation can replace status and commercial content without a revision boundary.

The existing JSON and in-memory stores have no:

- authenticated owner boundary;
- revision number or immutable finalised snapshot;
- optimistic concurrency check;
- approval-bound content fingerprint;
- delivery-attempt ledger;
- provider request or correlation reference; or
- no-blind-retry reconciliation path.

Consequently, sending can be confused with acceptance, changed content can inherit stale approval, and uncertain provider outcomes can be retried unsafely.

## 3. Chosen architecture

Use three Convex record families with focused interfaces:

- `quotes`: stable identity, current-revision pointer, and current commercial status;
- `quoteRevisions`: versioned content, immutable finalisation, and historical commercial outcomes;
- `quoteDeliveryAttempts`: exact send intent, provider execution state, and reconciliation linkage.

Revisions and delivery attempts are separate records rather than embedded arrays. This prevents unbounded document growth, reduces write contention, supports indexed uniqueness checks, and keeps delivery state independent from commercial state.

### Rejected alternatives

**Single embedded quote document:** simpler initially, but broad writes, document growth, and concurrent revision/send mutations make exactly-once behaviour fragile.

**Full event sourcing:** strong auditability, but projection, replay, migration, and operational complexity exceed the current requirement. Immutable revisions and delivery attempts provide the required audit boundary without a general event store.

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

- `quoteId` is stable for the commercial opportunity.
- `ownerId` is derived only through the existing authenticated `requireOwner` boundary.
- `number` is unique within one owner.
- `aggregateVersion` increments on every aggregate mutation.
- `currentRevision` increases monotonically.
- `commercialStatus` describes the current revision only and never reflects delivery state.
- When a newer draft revision is created, the aggregate returns to `open`; the previous revision retains its historical outcome fields.

### 4.2 Quote revision

```ts
export type QuoteRevisionStatus = "draft" | "reviewed" | "finalized";
export type QuoteHistoricalOutcome = "accepted" | "declined" | "expired";

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
  historicalOutcome?: QuoteHistoricalOutcome;
  historicalOutcomeRecordedAt?: number;
  reviewedAt?: number;
  finalizedAt?: number;
  createdAt: number;
  updatedAt: number;
};
```

Rules:

- `(ownerId, quoteId, revision)` is unique.
- Totals are always derived server-side.
- Content is editable only while `status === "draft"`.
- `draft -> reviewed` occurs through `submitForReview`.
- `reviewed -> draft` occurs only through `reopenForEditing`; it clears `reviewedAt` and increments `revisionVersion`.
- `reviewed -> finalized` is the only normal finalisation path.
- Direct `draft -> finalized` is rejected. The planned `AM-012` registry transition must be corrected before activation.
- Finalised revisions are immutable, including notes, terms, validity, totals, and fingerprint.
- Editing after finalisation atomically creates revision `N + 1` in `draft`, copies the commercial content, and advances the aggregate pointer.
- `historicalOutcome` is written on the exact finalised revision accepted, declined, or expired. It remains after a later revision returns the aggregate to `open`.

### 4.3 Finalised revision fingerprint

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

The fingerprint is written exactly once during finalisation. It excludes timestamps and database IDs. Replaying finalisation for the same revision and fingerprint returns the existing result. A different fingerprint for the same revision is rejected and audited.

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

- Delivery can reference only a finalised revision whose stored fingerprint exactly matches.
- Recipient addresses are normalised deterministically before fingerprinting.
- Delivery status never changes aggregate or revision commercial outcome.
- `reconciled` is valid only after `indeterminate`; `reconciledOutcome` preserves the proven terminal result.
- Provider request and correlation identifiers are persisted through the existing external reconciliation boundary.
- An execution without a durable provider reference cannot become `succeeded`.

## 5. State machines

### Revision lifecycle

```text
createQuote -> revision 1 draft

draft -> reviewed                 submitForReview
reviewed -> draft                  reopenForEditing
reviewed -> finalized              finalizeRevision
finalized -> revision N+1 draft    createRevisionFromFinalized
```

Finalised content never transitions back to an editable state.

### Commercial lifecycle

```text
open -> accepted
open -> declined
open -> expired
accepted | declined | expired -> open only when revision N+1 is created
```

Commercial outcome commands require the current aggregate version and the exact finalised revision. Delivery success does not imply acceptance.

### Delivery lifecycle

```text
pending -> executing
executing -> succeeded
executing -> failed
executing -> indeterminate
indeterminate -> reconciled { reconciledOutcome: succeeded }
indeterminate -> reconciled { reconciledOutcome: failed }
```

There is no `indeterminate -> executing` transition. Provider-status reconciliation resolves uncertainty; the original send is not retried blindly.

## 6. Optimistic concurrency

Every write carries explicit expectations:

- aggregate changes require `expectedAggregateVersion`;
- draft edits and revision transitions require `expectedRevisionVersion`;
- finalisation requires both expected versions and the expected revision number;
- revision forking requires the aggregate pointer and finalised fingerprint to match;
- commercial outcome recording requires the expected aggregate version and target revision;
- delivery creation requires the exact stored revision fingerprint.

Any mismatch returns `quote-version-conflict` with no partial mutation. Related Convex writes occur in one mutation.

## 7. Approval and execution binding

Jarvis retains the existing approved `ToolAction` and `ToolExecutionService` authority model. No parallel approval table or approval engine is introduced.

`AM-013` approval fingerprint fields are:

```text
action_family_id
owner_id
quote_id
quote_revision
revision_fingerprint
recipient
delivery_channel
```

The delivery attempt stores the exact `approvalId` and `actionFingerprint`.

Approval consumption means:

1. the exact approved action reaches `ToolExecutionService`;
2. the exact send scope creates or replays one delivery attempt;
3. the tool-execution receipt and reconciliation record prevent a second provider execution;
4. changed revision content, revision number, recipient, or channel requires a new action and approval.

The quote domain validates authoritative quote inputs; it does not independently grant approval.

## 8. Send fingerprint and idempotency

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

Scope: `(ownerId, quoteId, revision, normalizedRecipient, channel)`.

Behaviour:

- exact duplicate returns the original attempt or receipt;
- changed fingerprint under the same scope is rejected and audited;
- different recipient or channel creates a new scope and requires new approval;
- unresolved attempts replay the original indeterminate result without calling the provider;
- reconciled attempts replay the reconciled outcome.

## 9. Convex persistence

### `quotes` indexes

- `by_owner_and_quote_id`
- `by_owner_and_number`
- `by_owner_and_client_id`
- `by_owner_and_project_id`

### `quoteRevisions` indexes

- `by_owner_quote_and_revision`
- `by_owner_and_revision_id`
- `by_owner_quote_and_status`
- `by_owner_and_fingerprint`

### `quoteDeliveryAttempts` indexes

- `by_owner_and_delivery_attempt_id`
- `by_owner_and_send_scope`
- `by_owner_quote_and_revision`
- `by_owner_and_reconciliation_id`
- `by_owner_and_status`

Authoritative paths use bounded indexed queries. Unbounded `.collect()` and post-query filtering are prohibited.

## 10. Domain interfaces

The broad `QuoteStore.update(id, update)` interface is retired in favour of controlled commands:

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

Authenticated administration endpoints:

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

The legacy generic `PATCH /api/v1/quotes/:quoteId` status mutation is removed after migration. During compatibility, it rejects `status` and all finalised-content mutation.

Tool boundaries:

- `TOOL-QUOTE-FINALIZE` invokes the controlled finalisation command.
- `TOOL-QUOTE-SEND` uses `ToolExecutionService`, an `externalProvider`, provider-attempt registration, and the reconciliation store.
- Neither tool enters the live allowlist during the initial model and lifecycle tranche.

## 12. Error model

Typed errors:

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
- `quote-persistence-failed`

Absent and cross-owner records both return the same external `404`. The internal audit stream records denied owner mismatches without exposing record existence.

## 13. Legacy migration

The JSON and in-memory stores become compatibility fixtures after Convex is authoritative.

Development-only migration:

1. reads legacy JSON without modifying it;
2. creates one aggregate and one revision per source quote;
3. maps legacy `draft` to revision `draft`, aggregate `open`;
4. maps legacy `sent` to a migration-imported finalised revision, aggregate `open`, and no delivery attempt because provider evidence is absent;
5. maps legacy `accepted` to a migration-imported finalised revision with historical and aggregate `accepted`;
6. maps legacy `declined` to a migration-imported finalised revision with historical and aggregate `declined`;
7. derives totals again from line items;
8. records source ID, destination ID, mapped state, and rejected rows;
9. uses a stable legacy-source key for idempotency; and
10. retains the source file until separately authorised cleanup.

Migration-imported finalisation is a dedicated development-only mutation. It cannot be called by HTTP, MCP, `AM-012`, or production code, and it records `source: legacy-migration`.

No production migration is part of issue #152.

## 14. Testing

### Domain

- create revision 1 draft with derived totals;
- reject arbitrary status mutation;
- enforce controlled transitions;
- reject direct draft finalisation;
- prove finalised immutability;
- fork finalised N to draft N+1;
- prove a newer revision invalidates earlier send inputs;
- preserve historical commercial outcome independently from delivery.

### Concurrency and persistence

- reject stale aggregate and revision versions;
- allocate one revision number under concurrent forks;
- enforce owner-scoped quote-number uniqueness;
- prevent cross-owner reads and writes;
- prove fresh-client restart persistence;
- prove authoritative queries are index-bounded.

### Delivery

- reject non-finalised revisions and changed fingerprints;
- reject a changed recipient under the same idempotency scope;
- replay exact duplicate without provider execution;
- persist provider request and correlation identifiers;
- create one durable indeterminate outcome on timeout;
- block blind retry while unresolved;
- reconcile proven success and failure;
- preserve commercial state through delivery and reconciliation;
- bind the exact approved action once.

### HTTP and OpenAPI

- validate controlled endpoints and request bodies;
- return `409` for version and fingerprint conflicts;
- return non-leaking `404` for absent and cross-owner records;
- remove legacy generic status mutation;
- keep totals server-derived.

### Development smoke

The self-cleaning smoke must:

1. refuse any non-`dev:` deployment before constructing stores;
2. create, review, and finalise a quote;
3. verify immutable replay through a fresh client;
4. fork a new draft and prove the old fingerprint remains unchanged;
5. create a synthetic delivery attempt;
6. register a synthetic provider reference;
7. force an indeterminate outcome;
8. recover and reconcile through fresh worker/store instances;
9. prove commercial state was unchanged; and
10. clean quote, revision, delivery, reconciliation, and receipt records.

## 15. Governance and activation

Before activation:

- correct `AM-012` state impact to `reviewed -> finalized`;
- keep `AM-012` planned until its store, tool, tests, commissioning, and evidence pass;
- keep `AM-013` planned until a real provider adapter, send tool, approval path, reconciliation tests, commissioning, and evidence pass;
- keep `WF-QUOTE-001` planned until both actions are independently commissioned;
- add real non-recycled `TEST-AM-012-*`, `TEST-AM-013-*`, `EVD-AM-012-*`, and `EVD-AM-013-*` entries;
- regenerate the action map only from the authoritative registry; and
- validate tool and state-target bindings before activation.

Storage commissioning does not authorise sending.

## 16. Security and privacy

- Every Convex query and mutation derives `ownerId` through the existing service-token boundary.
- Client, project, recipient, notes, terms, and line-item data are private.
- Provider credentials remain server-side and never enter quote records, arguments, receipts, reconciliation rows, logs, or artifacts.
- Recipient plaintext is redacted from public diagnostics and commissioning evidence.
- Fingerprints may be retained because they do not expose plaintext content.
- Cleanup is restricted to `dev:outgoing-ram-798` and synthetic smoke identifiers.

## 17. Operational boundaries

- Authorised development deployment: `dev:outgoing-ram-798`.
- Convex production requires explicit production-specific approval.
- Manufact production is untouched.
- No email provider is selected or activated by this design.
- No real quote send occurs during model, migration, lifecycle, or synthetic smoke commissioning.

## 18. Delivery sequence

1. domain contracts and canonical fingerprints;
2. Convex aggregate and revision persistence;
3. controlled HTTP administration and legacy compatibility;
4. finalisation tool binding while still planned;
5. delivery-attempt persistence and reconciliation integration;
6. synthetic development smoke and immutable storage evidence;
7. separate real-provider send implementation;
8. separate governance activation for `AM-012`, then `AM-013`.

The first runtime PR may deliver the model and controlled lifecycle without activating either action family. Provider-specific sending is a later PR and approval checkpoint.

## 19. Acceptance criteria

The design is satisfied when:

- commercial and delivery state are independent;
- every content change occurs in a numbered revision;
- historical outcomes remain attached to exact revisions;
- finalised revisions are immutable;
- finalisation and sending use exact canonical fingerprints;
- stale and concurrent writes fail closed;
- delivery attempts use durable provider references and no-blind-retry reconciliation;
- exact duplicates replay the original result;
- changed content, recipient, or channel requires new approval;
- cross-owner access is prevented without leaking existence;
- real TEST and EVD entries exist before activation;
- `AM-012`, `AM-013`, and `WF-QUOTE-001` remain planned until separate gates pass; and
- the initial implementation performs no production deployment or real external send.
