# Quote Delivery Reconciliation Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent caller retries from creating new commercial execution scopes, project terminal Outlook reconciliation into the quote delivery ledger, and make abandoned `observing` records visible through safe escalation.

**Architecture:** The maintained HTTP controller derives a stable execution idempotency key from the approved action ID instead of trusting a caller-generated retry key. Convex remains the transactional source of truth: `resolveClaim` updates the authoritative receipt, reconciliation record and matching quote delivery projection in one mutation. `claimNext` detects `observing` records older than a fixed recovery bound and escalates them rather than attempting an unsafe blind replay without an authoritative receipt.

**Tech Stack:** TypeScript, NestJS/Fastify, Convex 1.41, Node test runner, Vitest, convex-test, GitHub Actions.

## Global Constraints

- Keep `quotes:send` unavailable through MCP and the HUD in this slice.
- Add no new HTTP route and no parallel approval mechanism.
- Preserve the separate approval-token gate and current owner isolation.
- A retry of the same approved live action must use the same server-derived execution key regardless of caller input.
- A dry run must not share an execution key with a live execution.
- Resolve the external reconciliation record, authoritative receipt and matching quote delivery ledger row atomically.
- Do not fabricate a receipt for an abandoned `observing` record; escalate it after 60 seconds for operator attention.
- Add no required schema field to populated Convex tables.

---

### Task 1: Server-derived tool execution idempotency

**Files:**
- Modify: `typescript/src/actions/toolExecution.ts`
- Modify: `typescript/src/http/toolActionController.ts`
- Test: `typescript/tests/toolActionHttp.test.ts`

**Interfaces:**
- Produces: `deriveToolExecutionIdempotencyKey(actionId: string, mode: "live" | "dry-run"): string`
- Consumes: the approved `ToolAction.actionId` already loaded by `ToolActionController.execute`

- [ ] **Step 1: Write the failing HTTP regression**

Replace the existing request-forwarding expectation with a behavioural test that submits the same approved action twice using two different caller keys and proves the tool executes once and both live responses replay the same receipt. Keep a separate dry-run request and prove it does not consume the live execution.

```ts
const first = await execute({ idempotencyKey: "caller-attempt-1" });
const retry = await execute({ idempotencyKey: "caller-attempt-2" });
assert.equal(first.json().status, "succeeded");
assert.deepEqual(retry.json(), first.json());
assert.equal(executions, 1);
assert.notEqual(first.json().idempotencyKey, "caller-attempt-1");
```

Production change that must make this test fail: forwarding `parsed.idempotencyKey` into `ToolExecutionService.execute`.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm --prefix typescript test -- --test-name-pattern="derives one live execution key"`

Expected: FAIL because the two caller keys create two execution scopes and execute the tool twice.

- [ ] **Step 3: Implement the minimal stable key helper**

Use the existing canonical SHA-256 digest support in `toolExecution.ts`:

```ts
export function deriveToolExecutionIdempotencyKey(
  actionId: string,
  mode: "live" | "dry-run",
): string {
  const cleanActionId = actionId.trim();
  if (!cleanActionId) throw new Error("Tool action ID is required for execution idempotency.");
  return `tool-action-execution:v1:${mode}:${digest({ actionId: cleanActionId, mode })}`;
}
```

In `ToolActionController.execute`, continue parsing the request contract for compatibility but pass the derived key based on `action.actionId` and `parsed.dryRun`.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npm --prefix typescript test -- --test-name-pattern="derives one live execution key"`

Expected: PASS; one tool effect, identical retry receipt, distinct dry-run scope.

- [ ] **Step 5: Commit**

Commit message: `fix(actions): derive execution idempotency from approval`

### Task 2: Atomic terminal projection into the quote delivery ledger

**Files:**
- Modify: `typescript/convex/externalReconciliations.ts`
- Test: `typescript/convex/externalReconciliations.test.ts`

**Interfaces:**
- Consumes: the existing `quoteDeliveryAttempts.by_owner_and_reconciliation_id` index.
- Produces: a matching `indeterminate` quote delivery row becomes `reconciled` with `reconciledOutcome`, `reconciledAt`, `updatedAt`, and the provider error code for a failed provider result.

- [ ] **Step 1: Write the failing Convex regression**

Seed a claimed quote-send reconciliation, its authoritative indeterminate receipt, and an `indeterminate` quote delivery attempt sharing `reconciliationId`. Resolve the claim as `succeeded`, then query the delivery row and assert:

```ts
expect(delivery.status).toBe("reconciled");
expect(delivery.reconciledOutcome).toBe("succeeded");
expect(delivery.reconciledAt).toBe(now);
```

Add the failed-result case and assert `providerErrorCode` is retained. Production change that must make this test fail: removing the quote-delivery patch from `resolveClaim`.

- [ ] **Step 2: Run the Convex test and verify RED**

Run: `npm --prefix typescript run test:convex -- externalReconciliations.test.ts`

Expected: FAIL because `resolveClaim` currently updates only the receipt and external reconciliation row.

- [ ] **Step 3: Implement the atomic projection**

Inside `resolveClaim`, query the existing reconciliation index:

```ts
const delivery = await ctx.db
  .query("quoteDeliveryAttempts")
  .withIndex("by_owner_and_reconciliation_id", (q) =>
    q.eq("ownerId", ownerId).eq("reconciliationId", reconciliationId),
  )
  .unique();
```

If a row exists, require `status === "indeterminate"` or accept an already-reconciled identical outcome. Patch it in the same mutation transaction as the receipt and reconciliation updates. Reject a conflicting terminal outcome rather than overwriting it.

- [ ] **Step 4: Run the Convex test and verify GREEN**

Run: `npm --prefix typescript run test:convex -- externalReconciliations.test.ts`

Expected: PASS for succeeded, failed and idempotent-identical resolution cases.

- [ ] **Step 5: Commit**

Commit message: `fix(reconciliation): project terminal quote delivery outcome`

### Task 3: Recover abandoned observing records by escalation

**Files:**
- Modify: `typescript/convex/externalReconciliations.ts`
- Test: `typescript/convex/externalReconciliations.test.ts`

**Interfaces:**
- Produces: stale `observing` records transition to `escalated` with reason `abandoned-observing-process-interruption`.
- Preserves: fresh `observing` records remain untouched so an in-flight sender is never raced by the worker.

- [ ] **Step 1: Write the failing recovery regressions**

Seed one `observing` record with `nextAttemptAt < now - 60_000` and one fresh record; equality at exactly 60 seconds remains safe. Call `claimNext`. Assert the stale row is escalated and returns no claim; assert the fresh row remains `observing`.

Production change that must make this test fail: omitting the stale-observing query or using `args.now` without the 60-second bound.

- [ ] **Step 2: Run the Convex test and verify RED**

Run: `npm --prefix typescript run test:convex -- externalReconciliations.test.ts`

Expected: FAIL because `claimNext` currently examines only `pending` and expired `claimed` rows.

- [ ] **Step 3: Implement fail-closed recovery**

Add `const OBSERVING_RECOVERY_MS = 60_000`. Before claiming normal work, query the existing `by_owner_and_state_and_next_attempt_at` index for the oldest due `observing` row bounded by `args.now - OBSERVING_RECOVERY_MS`. Patch it to `escalated`, set `updatedAt`, `escalatedAt`, and the explicit reason, then return `null`. Do not synthesize an authoritative receipt or contact the provider.

- [ ] **Step 4: Run the Convex test and verify GREEN**

Run: `npm --prefix typescript run test:convex -- externalReconciliations.test.ts`

Expected: PASS; stale rows become visible escalation records and fresh rows are untouched.

- [ ] **Step 5: Commit**

Commit message: `fix(reconciliation): escalate abandoned observations`

### Task 4: Correct operator and governance documentation

**Files:**
- Modify: `typescript/docs/operators/tool-action-approval.md`
- Modify: `docs/registries/tool-registry.yaml`

**Interfaces:**
- Documents: Outlook provider composition is available only when explicitly enabled and correctly configured; quote send remains governed and is not exposed through MCP/HUD.

- [ ] **Step 1: Replace stale provider claims**

Remove statements that `createQuoteEmailProviderFromEnv` always returns `null`. State the exact fail-closed activation boundary: `JARVIS_OUTLOOK_ENABLED`, valid delegated OAuth configuration and refresh-token storage are required, while customer send remains approval-gated.

- [ ] **Step 2: Validate registries**

Run: `npm --prefix typescript run validate:governance`

Expected: PASS.

- [ ] **Step 3: Commit**

Commit message: `docs(outlook): correct quote delivery activation state`

### Task 5: Full verification and guarded PR

**Files:**
- Review every changed file in this branch.

- [ ] **Step 1: Run static and behavioural gates**

Run from `typescript/`: `npm run build && npm run typecheck && npm run lint && npm run format:check && npm run validate:openapi && npm test && npm run test:convex`

Expected: all commands pass with no warnings introduced by this branch.

- [ ] **Step 2: Run exact-head independent review**

Review idempotency scope separation, receipt semantics, Convex transactionality, stale-observation timing, owner isolation and the fact that quote sending remains unreachable through MCP/HUD.

- [ ] **Step 3: Prepare PR evidence**

Open a draft PR referencing Issue #243, include the repository’s required Copilot Review section, and mark ready only after CI and independent review are green.

- [ ] **Step 4: Guard landing**

Squash-merge only the exact reviewed SHA after approval; do not deploy production or send customer email as part of this slice.
