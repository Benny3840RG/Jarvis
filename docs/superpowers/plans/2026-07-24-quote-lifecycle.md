# Quote Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the mutable legacy quote record with owner-scoped quote aggregates, immutable numbered revisions, controlled finalisation, provider-neutral delivery attempts, and development-only reconciliation commissioning without activating real quote sending.

**Architecture:** Add three authoritative Convex record families: `quotes`, `quoteRevisions`, and `quoteDeliveryAttempts`. Expose narrow domain repositories and controlled HTTP/tool commands; bind delivery attempts to the existing tool-execution receipt and external-reconciliation subsystems. Keep `AM-012`, `AM-013`, and `WF-QUOTE-001` planned throughout this tranche.

**Tech Stack:** TypeScript, Node test runner, Zod, Convex, NestJS, OpenAPI, existing `ToolExecutionService`, existing external reconciliation worker/store, GitHub Actions.

## Global Constraints

- Development only; no Convex or Manufact production deployment.
- Authorised Convex target is exactly `dev:outgoing-ram-798` at `https://outgoing-ram-798.convex.cloud`.
- `AM-012 Finalize quote`, `AM-013 Send quote`, and `WF-QUOTE-001` remain `planned`.
- No real email is sent and no Outlook Calendar event is created.
- Outlook identity `thebeeztreez@outlook.com` is verified integration context only; a live Outlook provider adapter is a later activation tranche.
- Every authoritative query and mutation derives `ownerId` through the existing `requireOwner` service-token boundary.
- Totals are derived server-side; client-supplied subtotal, tax, and total are rejected.
- Finalised revisions are immutable.
- Delivery state never overwrites commercial acceptance, decline, or expiry state.
- Blind retry is prohibited for unresolved external outcomes.
- Use indexed Convex queries; no unbounded authoritative `.collect()` paths.
- Preserve the current OpenAI/Gemini Totality work on baseline `03553930e20ebb08064c5c8353f77c1b324b3d8d` and later merged `main` changes.

## File Structure

### Domain

- Create `typescript/src/quotes/quoteLifecycle.ts`: domain types, command inputs, typed errors, transition guards, totals.
- Create `typescript/src/quotes/quoteFingerprints.ts`: canonical revision/send fingerprints and recipient normalization.
- Create `typescript/src/quotes/quoteRepository.ts`: aggregate/revision repository interfaces.
- Create `typescript/src/quotes/quoteDeliveryRepository.ts`: delivery repository interface.

### Convex

- Create `typescript/convex/quoteValidators.ts`: validators shared by quote functions.
- Create `typescript/convex/quotes.ts`: aggregate/revision queries and mutations.
- Create `typescript/convex/quoteDeliveries.ts`: delivery-attempt queries and mutations.
- Modify `typescript/convex/schema.ts`: three tables and bounded indexes.
- Modify `typescript/convex/_generated/api.d.ts`: generated bindings only through Convex generation.

### Adapters and HTTP

- Create `typescript/src/persistence/convexQuotes.ts`: authenticated quote repository adapter.
- Create `typescript/src/persistence/convexQuoteDeliveries.ts`: authenticated delivery adapter.
- Replace `typescript/src/http/quoteRequest.ts`: controlled request parsers with expected versions.
- Replace `typescript/src/http/quoteController.ts`: controlled revision endpoints; remove arbitrary status mutation.
- Modify `typescript/src/http/tokens.ts`, `typescript/src/http/jarvisHttpModule.ts`, and `typescript/openapi/jarvis.openapi.json`.

### Tool boundaries

- Create `typescript/src/actions/quoteFinalizeTool.ts`: `TOOL-QUOTE-FINALIZE` definition, kept outside the live allowlist.
- Create `typescript/src/actions/quoteSendTool.ts`: provider-neutral external tool definition for tests/smoke only, kept outside the live allowlist.
- Modify the existing tool-execution factory only to expose test construction helpers; do not add either quote tool to the production allowlist.

### Migration and smoke

- Create `typescript/convex/quoteMigration.ts`: development-only legacy import mutations.
- Create `typescript/src/tools/quoteLifecycleSmoke.ts`: self-cleaning development smoke.
- Modify `typescript/src/tools/runConvexSmoke.ts` to include the quote lifecycle smoke.

### Tests and governance

- Create focused tests listed in Tasks 1-8.
- Modify governance registries only after runtime tests pass; retain planned lifecycle status.

---

### Task 1: Domain contracts, transitions, and fingerprints

**Files:**
- Create: `typescript/src/quotes/quoteLifecycle.ts`
- Create: `typescript/src/quotes/quoteFingerprints.ts`
- Create: `typescript/src/quotes/quoteRepository.ts`
- Create: `typescript/src/quotes/quoteDeliveryRepository.ts`
- Test: `typescript/tests/quoteLifecycleDomain.test.ts`
- Test: `typescript/tests/quoteFingerprints.test.ts`

**Interfaces:**
- Produces `QuoteAggregate`, `QuoteRevision`, `QuoteDeliveryAttempt`, `QuoteSnapshot`.
- Produces `computeQuoteTotals`, `assertRevisionTransition`, `normalizeQuoteRecipient`, `quoteRevisionFingerprint`, and `quoteSendFingerprint`.
- Produces repository interfaces consumed by Tasks 3-7.

- [ ] **Step 1: Write failing transition and immutability tests**

```ts
it("allows draft -> reviewed -> finalized and rejects draft -> finalized", () => {
  assert.doesNotThrow(() => assertRevisionTransition("draft", "reviewed"));
  assert.doesNotThrow(() => assertRevisionTransition("reviewed", "finalized"));
  assert.throws(() => assertRevisionTransition("draft", "finalized"), QuoteInvalidTransitionError);
});

it("refuses content mutation on finalized revisions", () => {
  const revision = finalizedRevisionFixture();
  assert.throws(
    () => applyDraftPatch(revision, { notes: "changed" }, revision.revisionVersion),
    QuoteFinalizedImmutableError,
  );
});
```

- [ ] **Step 2: Run the domain test and verify RED**

Run:

```bash
cd typescript
node --import tsx --test tests/quoteLifecycleDomain.test.ts
```

Expected: FAIL because the new domain modules do not exist.

- [ ] **Step 3: Implement explicit types and typed errors**

```ts
export type QuoteRevisionStatus = "draft" | "reviewed" | "finalized";
export type QuoteCommercialStatus = "open" | "accepted" | "declined" | "expired";
export type QuoteHistoricalOutcome = Exclude<QuoteCommercialStatus, "open">;
export type QuoteDeliveryStatus =
  | "pending"
  | "executing"
  | "succeeded"
  | "failed"
  | "indeterminate"
  | "reconciled";

export class QuoteVersionConflictError extends Error {}
export class QuoteInvalidTransitionError extends Error {}
export class QuoteFinalizedImmutableError extends Error {}
export class QuoteFingerprintMismatchError extends Error {}
```

Implement only these valid revision transitions:

```ts
const ALLOWED_REVISION_TRANSITIONS = new Set([
  "draft:reviewed",
  "reviewed:draft",
  "reviewed:finalized",
]);
```

- [ ] **Step 4: Write failing canonical fingerprint tests**

```ts
it("produces the same revision fingerprint for canonical-equivalent objects", () => {
  assert.equal(
    quoteRevisionFingerprint(revisionFingerprintInput({ notes: undefined })),
    quoteRevisionFingerprint(revisionFingerprintInput({ notes: undefined })),
  );
});

it("changes the send fingerprint when recipient or revision fingerprint changes", () => {
  const base = sendFingerprintInput();
  assert.notEqual(quoteSendFingerprint(base), quoteSendFingerprint({ ...base, recipient: "other@example.com" }));
  assert.notEqual(
    quoteSendFingerprint(base),
    quoteSendFingerprint({ ...base, revisionFingerprint: "quote-revision:v1:sha256:different" }),
  );
});
```

- [ ] **Step 5: Implement canonical fingerprints**

Use Node `createHash("sha256")` and the repository's existing canonical JSON helper if present. Otherwise implement a focused recursive key-sorter in `quoteFingerprints.ts`.

```ts
export function normalizeQuoteRecipient(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new QuoteRecipientInvalidError();
  }
  return normalized;
}
```

Prefix hashes exactly with `quote-revision:v1:sha256:` and `quote-send:v1:sha256:`.

- [ ] **Step 6: Run domain/fingerprint tests and the full gate**

```bash
node --import tsx --test tests/quoteLifecycleDomain.test.ts tests/quoteFingerprints.test.ts
npm run check
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/quotes tests/quoteLifecycleDomain.test.ts tests/quoteFingerprints.test.ts
git commit -m "feat(quotes): define revision and delivery domain contracts"
```

---

### Task 2: Convex schema and atomic aggregate/revision lifecycle

**Files:**
- Create: `typescript/convex/quoteValidators.ts`
- Create: `typescript/convex/quotes.ts`
- Modify: `typescript/convex/schema.ts`
- Test: `typescript/tests/quoteConvexContracts.test.ts`
- Test: `typescript/tests/quoteConvexLifecycle.test.ts`

**Interfaces:**
- Produces Convex functions `create`, `get`, `list`, `updateDraft`, `submitForReview`, `reopenForEditing`, `finalizeRevision`, `forkRevision`, `recordCommercialOutcome`, and development cleanup.
- Every public function accepts `serviceToken`; every function calls `requireOwner` before reading records.

- [ ] **Step 1: Write failing schema/index contract tests**

Assert the schema contains:

```text
quotes.by_owner_and_quote_id
quotes.by_owner_and_number
quotes.by_owner_and_client_id
quotes.by_owner_and_project_id
quoteRevisions.by_owner_quote_and_revision
quoteRevisions.by_owner_and_revision_id
quoteRevisions.by_owner_quote_and_status
quoteRevisions.by_owner_and_fingerprint
```

- [ ] **Step 2: Run the contract test and verify RED**

```bash
node --import tsx --test tests/quoteConvexContracts.test.ts
```

Expected: FAIL because the tables/functions are absent.

- [ ] **Step 3: Add schema fields and indexes**

`quotes` stores stable identity, current revision pointer, aggregate version, and current commercial status. `quoteRevisions` stores content, revision version, lifecycle status, immutable fingerprint, and historical outcome.

Use owner-first composite indexes. Do not add a global quote-number index.

- [ ] **Step 4: Write failing atomic lifecycle tests**

Cover:

```ts
it("creates aggregate and revision 1 atomically", async () => {});
it("rejects stale aggregate and revision versions", async () => {});
it("allocates one revision number under concurrent forks", async () => {});
it("keeps finalized revision immutable", async () => {});
it("stores historical acceptance on the exact finalized revision", async () => {});
it("returns identical not-found behavior for absent and cross-owner records", async () => {});
```

- [ ] **Step 5: Implement controlled mutations**

Each write must:

1. call `requireOwner`;
2. fetch by owner-scoped index;
3. compare expected versions;
4. validate the transition;
5. update all related rows in one Convex mutation;
6. return a bounded `QuoteSnapshot`.

`finalizeRevision` must calculate and persist the fingerprint inside the authoritative mutation from stored content. It must never trust a caller-provided total or fingerprint.

`forkRevision` must atomically copy finalised content, clear finalisation/outcome fields, create revision `N + 1`, advance the aggregate pointer, increment `aggregateVersion`, and return aggregate commercial status to `open`.

- [ ] **Step 6: Generate Convex bindings and run tests**

```bash
npx convex codegen
node --import tsx --test tests/quoteConvexContracts.test.ts tests/quoteConvexLifecycle.test.ts
npm run check
```

Expected: all pass; generated API changes contain quote functions only.

- [ ] **Step 7: Commit**

```bash
git add convex tests/quoteConvexContracts.test.ts tests/quoteConvexLifecycle.test.ts
git commit -m "feat(quotes): add atomic Convex revision lifecycle"
```

---

### Task 3: Authenticated Convex quote repository adapter

**Files:**
- Create: `typescript/src/persistence/convexQuotes.ts`
- Test: `typescript/tests/convexQuotesAdapter.test.ts`
- Test: `typescript/tests/quoteRestartPersistence.test.ts`

**Interfaces:**
- Implements `QuoteRepository` from Task 1.
- Constructor accepts `{ client, serviceToken }` following existing Convex adapters.

- [ ] **Step 1: Write failing adapter-fidelity tests**

Verify exact argument preservation for quote ID, expected aggregate/revision versions, revision number, patch fields, and outcome.

```ts
assert.deepEqual(calls[0], {
  serviceToken,
  quoteId: "quote-1",
  revision: 2,
  expectedAggregateVersion: 4,
  expectedRevisionVersion: 3,
});
```

- [ ] **Step 2: Run and verify RED**

```bash
node --import tsx --test tests/convexQuotesAdapter.test.ts
```

Expected: FAIL because `ConvexQuoteRepository` is absent.

- [ ] **Step 3: Implement the adapter**

Map Convex numeric timestamps to numeric domain timestamps without timezone conversion. Preserve `null`/not-found results and typed conflict codes; do not convert every failure into a persistence outage.

- [ ] **Step 4: Write and pass fresh-client persistence test**

Create with one adapter instance, read and transition through a fresh adapter instance, and prove the same finalized fingerprint is returned.

```bash
node --import tsx --test tests/convexQuotesAdapter.test.ts tests/quoteRestartPersistence.test.ts
npm run check
```

- [ ] **Step 5: Commit**

```bash
git add src/persistence/convexQuotes.ts tests/convexQuotesAdapter.test.ts tests/quoteRestartPersistence.test.ts
git commit -m "feat(quotes): add authenticated Convex repository adapter"
```

---

### Task 4: Controlled HTTP quote administration and OpenAPI

**Files:**
- Replace: `typescript/src/http/quoteRequest.ts`
- Replace: `typescript/src/http/quoteController.ts`
- Modify: `typescript/src/http/tokens.ts`
- Modify: `typescript/src/http/jarvisHttpModule.ts`
- Modify: `typescript/openapi/jarvis.openapi.json`
- Test: `typescript/tests/quoteHttpLifecycle.test.ts`
- Modify: `typescript/tests/quoteHttp.test.ts`

**Interfaces:**
- Exposes only controlled quote endpoints from the approved spec.
- Removes request-level `status` mutation and rejects client totals.

- [ ] **Step 1: Write failing endpoint tests**

Cover:

```text
POST /api/v1/quotes
PATCH /api/v1/quotes/:quoteId/revisions/:revision
POST /api/v1/quotes/:quoteId/revisions/:revision/review
POST /api/v1/quotes/:quoteId/revisions/:revision/reopen
POST /api/v1/quotes/:quoteId/revisions/:revision/finalize
POST /api/v1/quotes/:quoteId/revisions/:revision/fork
POST /api/v1/quotes/:quoteId/commercial-outcome
GET /api/v1/quotes/:quoteId/deliveries
```

Assert:

- stale versions produce `409`;
- direct draft finalisation produces `409`;
- finalised patches produce `409`;
- cross-owner and absent records both produce the same `404` body;
- `subtotal`, `tax`, `total`, and generic `status` inputs produce `422`.

- [ ] **Step 2: Run and verify RED**

```bash
node --import tsx --test tests/quoteHttpLifecycle.test.ts
```

- [ ] **Step 3: Implement strict request parsers**

Every write request requires explicit expected versions. Reject unknown keys. Keep the existing size limits for quote numbers, descriptions, notes, line-item count, and IDs.

- [ ] **Step 4: Implement typed error mapping**

Map:

```text
quote-not-found / cross-owner -> 404
quote-version-conflict -> 409
quote-invalid-transition -> 409
quote-finalized-immutable -> 409
quote-fingerprint-mismatch -> 409
validation errors -> 422
repository outage -> 503
```

Never include recipient plaintext or cross-owner existence in diagnostic bodies.

- [ ] **Step 5: Update OpenAPI and validate**

```bash
node --import tsx --test tests/quoteHttp.test.ts tests/quoteHttpLifecycle.test.ts
npm run openapi:lint
npm run check
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/http openapi/jarvis.openapi.json tests/quoteHttp.test.ts tests/quoteHttpLifecycle.test.ts
git commit -m "feat(quotes): expose controlled revision HTTP lifecycle"
```

---

### Task 5: Planned `AM-012` finalisation tool boundary

**Files:**
- Create: `typescript/src/actions/quoteFinalizeTool.ts`
- Modify: the existing tool execution factory file only to export a test-only builder if required
- Test: `typescript/tests/quoteFinalizeTool.test.ts`
- Test: `typescript/tests/quoteAllowlistBoundary.test.ts`

**Interfaces:**
- Defines tool ID `TOOL-QUOTE-FINALIZE` and operation `quotes:finalize`.
- Consumes exact `quoteId`, `quoteRevision`, `expectedAggregateVersion`, and `expectedRevisionVersion`.
- Produces a deterministic internal tool result containing the finalized revision fingerprint.

- [ ] **Step 1: Write failing tool tests**

Prove exact replay returns the original result, changed content/version rejects, and draft finalisation rejects.

- [ ] **Step 2: Write a failing allowlist-boundary test**

Assert the production allowlist does **not** include `quotes:finalize` or `quotes:send`.

- [ ] **Step 3: Implement the internal finalisation definition**

Use existing internal execution receipts and idempotency. Do not implement a second receipt table.

The tool must load authoritative quote state and finalise via `QuoteRepository`; it must not accept caller-supplied totals or fingerprint.

- [ ] **Step 4: Run tests and full gate**

```bash
node --import tsx --test tests/quoteFinalizeTool.test.ts tests/quoteAllowlistBoundary.test.ts
npm run check
```

- [ ] **Step 5: Commit**

```bash
git add src/actions tests/quoteFinalizeTool.test.ts tests/quoteAllowlistBoundary.test.ts
git commit -m "feat(quotes): add planned finalisation tool boundary"
```

---

### Task 6: Delivery-attempt ledger and reconciliation binding

**Files:**
- Create: `typescript/convex/quoteDeliveries.ts`
- Modify: `typescript/convex/schema.ts`
- Create: `typescript/src/persistence/convexQuoteDeliveries.ts`
- Create: `typescript/src/actions/quoteSendTool.ts`
- Test: `typescript/tests/quoteDeliveryConvex.test.ts`
- Test: `typescript/tests/convexQuoteDeliveriesAdapter.test.ts`
- Test: `typescript/tests/quoteSendTool.test.ts`

**Interfaces:**
- Implements `QuoteDeliveryRepository`.
- Reuses `ExternalReconciliationStore`, `ToolExecutionReceiptStore`, and the existing external provider-attempt registration contract.
- Uses synthetic provider adapters in tests only.

- [ ] **Step 1: Write failing schema and delivery-state tests**

Cover indexes:

```text
quoteDeliveryAttempts.by_owner_and_delivery_attempt_id
quoteDeliveryAttempts.by_owner_and_send_scope
quoteDeliveryAttempts.by_owner_quote_and_revision
quoteDeliveryAttempts.by_owner_and_reconciliation_id
quoteDeliveryAttempts.by_owner_and_status
```

Cover valid transitions only:

```text
pending -> executing
executing -> succeeded | failed | indeterminate
indeterminate -> reconciled(succeeded | failed)
```

- [ ] **Step 2: Write failing no-blind-retry tests**

Prove:

- non-finalised revision is rejected;
- changed revision fingerprint is rejected;
- exact duplicate replays without provider execution;
- changed recipient creates a different send fingerprint and requires a different approved action;
- timeout creates one indeterminate delivery attempt and one reconciliation record;
- unresolved replay never invokes the provider;
- reconciliation success/failure updates delivery state but not commercial status.

- [ ] **Step 3: Implement atomic delivery mutations**

`createPending` must validate the authoritative finalised revision and exact fingerprint in the same mutation that enforces send-scope uniqueness.

`bindProviderReference` must persist provider request/correlation IDs before recoverability is claimed.

`markIndeterminate` must bind the delivery attempt to the reconciliation record/receipt without a duplicate external effect.

- [ ] **Step 4: Implement authenticated adapter**

Preserve all provider references, IDs, fingerprints, and typed collision responses exactly.

- [ ] **Step 5: Implement provider-neutral external tool definition**

The definition may be constructed only when supplied:

```ts
{
  quoteRepository,
  deliveryRepository,
  reconciliationStore,
  externalProvider,
}
```

Do not select Outlook, Gmail, SMTP, Graph, or another real provider in this tranche.

- [ ] **Step 6: Run focused tests and full gate**

```bash
npx convex codegen
node --import tsx --test \
  tests/quoteDeliveryConvex.test.ts \
  tests/convexQuoteDeliveriesAdapter.test.ts \
  tests/quoteSendTool.test.ts
npm run check
```

- [ ] **Step 7: Commit**

```bash
git add convex src/persistence src/actions tests/quoteDeliveryConvex.test.ts tests/convexQuoteDeliveriesAdapter.test.ts tests/quoteSendTool.test.ts
git commit -m "feat(quotes): add provider-neutral delivery ledger"
```

---

### Task 7: Development-only legacy migration

**Files:**
- Create: `typescript/convex/quoteMigration.ts`
- Create: `typescript/src/tools/migrateLegacyQuotes.ts`
- Test: `typescript/tests/quoteMigration.test.ts`

**Interfaces:**
- Migration functions are callable only for `dev:` deployments and synthetic/legacy source keys.
- They are not exported through HTTP, MCP, tool actions, or production runtime wiring.

- [ ] **Step 1: Write failing migration tests**

Map legacy rows exactly:

```text
draft -> revision draft, aggregate open
sent -> migration-imported finalized revision, aggregate open, no delivery attempt
accepted -> migration-imported finalized revision, historical + aggregate accepted
declined -> migration-imported finalized revision, historical + aggregate declined
```

Also prove idempotent replay by stable legacy source key and rejected-row reporting.

- [ ] **Step 2: Implement fail-closed target guard**

Reject before constructing a store unless deployment identity begins with `dev:` and equals the authorised development deployment for live execution.

- [ ] **Step 3: Implement import without modifying source JSON**

Recompute totals from line items. Record source ID, destination IDs, mapped state, and rejection reason. Mark imported finalisation with `source: "legacy-migration"`.

- [ ] **Step 4: Run tests and full gate**

```bash
node --import tsx --test tests/quoteMigration.test.ts
npm run check
```

- [ ] **Step 5: Commit**

```bash
git add convex/quoteMigration.ts src/tools/migrateLegacyQuotes.ts tests/quoteMigration.test.ts
git commit -m "feat(quotes): add development-only legacy migration"
```

---

### Task 8: Self-cleaning quote lifecycle development smoke

**Files:**
- Create: `typescript/src/tools/quoteLifecycleSmoke.ts`
- Modify: `typescript/src/tools/runConvexSmoke.ts`
- Test: `typescript/tests/quoteLifecycleSmoke.test.ts`

**Interfaces:**
- Exports `runQuoteLifecycleSmoke(config)`.
- Uses deterministic synthetic quote number, recipient, provider request ID, and cleanup key derived from run ID.

- [ ] **Step 1: Write failing smoke-contract tests**

Prove the smoke:

1. refuses a non-development deployment before constructing stores;
2. creates, reviews, and finalises a quote;
3. reads the immutable result through a fresh adapter;
4. forks revision `N + 1` and keeps the old fingerprint unchanged;
5. creates a synthetic delivery attempt;
6. registers a synthetic provider reference;
7. forces indeterminate state;
8. reconciles through fresh worker/store instances;
9. proves commercial state is unchanged; and
10. cleans quote, revisions, delivery, reconciliation, and receipt rows on success and injected failure.

- [ ] **Step 2: Implement the smoke with guaranteed cleanup**

Use `try/finally`. Cleanup must be owner-scoped and restricted to the synthetic smoke IDs. Never clean real quotes by broad timestamp or status queries.

- [ ] **Step 3: Wire into canonical Convex smoke**

Add the quote lifecycle smoke after existing internal and external-reconciliation smoke stages. Do not change production deployment commands.

- [ ] **Step 4: Run tests and full gate**

```bash
node --import tsx --test tests/quoteLifecycleSmoke.test.ts
npm run check
```

- [ ] **Step 5: Commit**

```bash
git add src/tools tests/quoteLifecycleSmoke.test.ts
git commit -m "test(quotes): add self-cleaning development smoke"
```

---

### Task 9: Governance traceability while keeping actions planned

**Files:**
- Modify: `docs/traceability/action-family-registry.yaml`
- Modify: `docs/registries/tool-registry.yaml`
- Modify: `docs/registries/state-target-registry.yaml`
- Modify: `docs/registries/test-id-registry.yaml`
- Modify: `docs/registries/evidence-id-registry.yaml`
- Regenerate: `docs/traceability/action-map.generated.md`
- Test: `typescript/tests/quoteGovernanceBoundary.test.ts`

**Interfaces:**
- Corrects `AM-012` state impact to `reviewed -> finalized`.
- Adds real, non-recycled test/evidence IDs.
- Does not set `AM-012`, `AM-013`, or `WF-QUOTE-001` active.

- [ ] **Step 1: Write failing governance-boundary test**

Assert:

```text
AM-012 lifecycle_status = planned
AM-013 lifecycle_status = planned
WF-QUOTE-001 lifecycle_status = planned
AM-012 from = reviewed
AM-012 to = finalized
TOOL-QUOTE-FINALIZE implemented = false until commissioning/activation PR
TOOL-QUOTE-SEND implemented = false
```

- [ ] **Step 2: Add traceability IDs**

Use these exact IDs:

```text
TEST-AM-012-DOMAIN-001
TEST-AM-012-PERSIST-001
TEST-AM-012-TOOL-001
TEST-AM-012-SMOKE-001
TEST-AM-013-DELIVERY-001
TEST-AM-013-RECONCILIATION-001
TEST-AM-013-APPROVAL-001
TEST-AM-013-SMOKE-001
EVD-AM-012-001
EVD-AM-013-001
```

Evidence registry entries must state `planned evidence path; not yet commissioned` until immutable artifacts exist.

- [ ] **Step 3: Validate and regenerate**

```bash
node scripts/validate-action-map.mjs
ruby ../scripts/generate-action-map.rb
node --import tsx --test tests/quoteGovernanceBoundary.test.ts
npm run check
```

Expected: all validation stages pass and generated output is clean.

- [ ] **Step 4: Commit**

```bash
git add ../docs tests/quoteGovernanceBoundary.test.ts
git commit -m "docs(governance): register planned quote lifecycle evidence"
```

---

### Task 10: Runtime PR, development commissioning, and evidence

**Files:**
- Update: `docs/superpowers/plans/2026-07-24-quote-lifecycle.md`
- Create after successful commissioning: `docs/evidence/quote-lifecycle-commissioning.md`
- Temporary one-shot workflow only during commissioning; remove it before completion.

**Interfaces:**
- Runtime PR activates no quote action family.
- Commissioning deploys only to `dev:outgoing-ram-798`.

- [ ] **Step 1: Rebase or merge current `main` into the feature branch**

Preserve all post-baseline Gemini/security/governance changes. Resolve conflicts by retaining current `main` behavior outside quote files.

- [ ] **Step 2: Run permanent verification**

```bash
cd typescript
npm ci
npm run check
```

Expected: type-check, ESLint/Convex rules, Prettier, OpenAPI lint, governance validation, full tests, and console build pass.

- [ ] **Step 3: Open a draft runtime PR**

PR title:

```text
feat(quotes): add revision-safe quote and delivery lifecycle
```

PR body must state:

- no live Outlook or other provider adapter;
- no action-family activation;
- no production deployment;
- exact permanent CI run and head SHA;
- issue #152 remains open until development commissioning evidence exists.

- [ ] **Step 4: Review exact head**

Inspect review threads, security boundaries, indexes, migrations, and allowlist tests. Fix findings test-first and rerun permanent CI.

- [ ] **Step 5: Merge only after explicit exact-head approval**

Use squash merge with expected head SHA. Do not deploy during merge.

- [ ] **Step 6: Commission authorised development only**

Run the guarded development commissioning path against:

```text
dev:outgoing-ram-798
https://outgoing-ram-798.convex.cloud
```

Required live gates:

```text
npm run check
npx convex dev --once --tail-logs disable
npm run smoke:convex
backup export and isolated verification
```

- [ ] **Step 7: Retain immutable evidence**

Record exact:

```text
runtime merge SHA
commissioning source SHA
workflow run ID
job ID
artifact ID
artifact name
SHA-256 artifact digest
development deployment identity
```

- [ ] **Step 8: Remove one-shot workflow and update evidence doc**

Confirm the temporary workflow path returns `404` after deletion.

- [ ] **Step 9: Close issue #152 only if exit criteria are met**

Issue closure must explicitly state:

- quote model/lifecycle commissioned on development;
- no real send occurred;
- `AM-012`, `AM-013`, and `WF-QUOTE-001` remain planned;
- live Outlook provider selection/activation requires a separate approved tranche.

## Self-Review Results

- **Spec coverage:** aggregate, revisions, commercial outcomes, delivery attempts, optimistic concurrency, owner scoping, finalisation fingerprints, send fingerprints, reconciliation, migration, HTTP, tools, smoke, governance, and evidence are each assigned to a task.
- **Placeholder scan:** no `TBD`, `TODO`, or unspecified implementation step remains.
- **Type consistency:** repository method names and lifecycle states match the approved design spec.
- **Scope:** the plan deliberately excludes live Outlook sending and calendar writes; those require a separate provider-activation design and approval after this foundation is commissioned.
