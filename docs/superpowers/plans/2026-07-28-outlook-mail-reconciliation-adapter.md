# Outlook Mail Reconciliation Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only Microsoft Graph mail adapter that safely reconciles immutable Outlook draft-message references without activating mail or calendar writes.

**Architecture:** Split provider-domain classification from HTTP transport. `OutlookMailReconciliationAdapter` implements the existing provider adapter contract against a narrow `OutlookMessageStatusClient`; `MicrosoftGraphMessageStatusClient` performs one GET-only Graph lookup through injected fetch and token-supplier dependencies. Maintained runtime composition remains unchanged and fail-closed.

**Tech Stack:** TypeScript 6, Node.js 24 built-in fetch and crypto, Node test runner, existing reconciliation worker contracts.

## Global Constraints

- Provider name is exactly `microsoft-graph-mail-v1`.
- No `POST`, `PUT`, `PATCH`, or `DELETE` request may be implemented.
- No `Mail.Send` permission, OAuth flow, refresh-token storage, email provider, calendar adapter, or live runtime activation is in scope.
- No Outlook token may be read directly from `process.env`.
- Missing mail, drafts, throttling, outages, malformed data, and authorization failures never prove provider failure.
- Errors, logs, health and thrown messages must exclude tokens, mailbox names, message IDs, Internet message IDs, response bodies and Graph request identifiers.
- Maintained HTTP and preview runtimes remain fail-closed and disabled by default.
- No live Outlook request, Convex deployment, Manufact deployment, or production deployment is performed.
- Every behavior change follows a verified red-green test cycle.

## File structure

- Create `typescript/src/reconciliation/outlookMailReconciliationAdapter.ts`: provider constant, status-client contract, reference validation, status mapping and terminal digest.
- Create `typescript/src/reconciliation/microsoftGraphMessageStatusClient.ts`: injected GET-only Graph client, bounded Retry-After parsing and redacted transport errors.
- Create `typescript/tests/outlookMailReconciliationAdapter.test.ts`: provider-domain result mapping and leak prevention.
- Create `typescript/tests/microsoftGraphMessageStatusClient.test.ts`: exact request contract and HTTP classification using an injected fetch double.
- Modify `docs/deployment.md`: implemented-but-uncomposed adapter boundary and immutable draft reference prerequisite.
- Modify `docs/superpowers/specs/2026-07-28-outlook-mail-reconciliation-adapter-design.md` only if implementation discovers a contradiction; do not silently widen scope.

---

### Task 1: Provider-domain adapter

**Files:**
- Create: `typescript/tests/outlookMailReconciliationAdapter.test.ts`
- Create: `typescript/src/reconciliation/outlookMailReconciliationAdapter.ts`

**Interfaces:**
- Consumes: `ProviderAttemptReference`, `ProviderReconciliationAdapter`, and `ProviderReconciliationResult` from `externalReconciliation.ts`.
- Produces:
  - `OUTLOOK_MAIL_RECONCILIATION_PROVIDER = "microsoft-graph-mail-v1"`
  - `OutlookMessageStatusClient.getMessageStatus(input)`
  - `OutlookMessageStatusResult`
  - `OutlookMailReconciliationAdapter`

- [ ] **Step 1: Write the failing success and unresolved tests**

Use a recording status client and real adapter. The success fixture is:

```ts
const reference = {
  provider: "microsoft-graph-mail-v1",
  providerRequestId: "immutable-message-1",
  providerCorrelationId: "jarvis-correlation-1",
};

const result = await adapter.reconcile(reference, new AbortController().signal);
assert.equal(result.status, "succeeded");
if (result.status !== "succeeded") assert.fail("Expected sent message to reconcile.");
assert.match(result.outputDigest ?? "", /^outlook-mail-status:v1:sha256:[a-f0-9]{64}$/);
```

Add separate literal assertions for:

```text
found + isDraft=true -> unresolved/outlook-message-still-draft
not-observable -> unresolved/outlook-message-not-observable
throttled/120000 -> unresolved/outlook-graph-throttled/120000
unavailable -> unresolved/outlook-graph-unavailable
rejected -> unresolved/outlook-graph-request-rejected
invalid -> unresolved/outlook-message-status-invalid
```

The production break each test catches is mapping a non-terminal provider observation to a terminal receipt, or losing the provider's bounded retry delay.

- [ ] **Step 2: Run the focused test to verify RED**

Run:

```bash
cd typescript
node --import tsx --test tests/outlookMailReconciliationAdapter.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `outlookMailReconciliationAdapter.js`.

- [ ] **Step 3: Implement the minimal adapter and result types**

Define:

```ts
export type OutlookMessageStatusResult =
  | {
      status: "found";
      immutableMessageId: string;
      isDraft: boolean;
      sentDateTime?: string;
      internetMessageId?: string;
    }
  | { status: "not-observable" }
  | { status: "throttled"; retryAfterMs?: number }
  | { status: "unavailable" }
  | { status: "rejected" }
  | { status: "invalid" };

export interface OutlookMessageStatusClient {
  getMessageStatus(input: {
    mailbox: string;
    immutableMessageId: string;
    signal: AbortSignal;
  }): Promise<OutlookMessageStatusResult>;
}
```

Construct the adapter with `{ mailbox, client }`. Require a non-empty mailbox during construction but never include it in errors. `reconcile` validates the exact provider name, non-empty request/correlation IDs, no ASCII control characters, and a maximum length of 1024 characters before calling the client.

For a found message, require:

```ts
status.immutableMessageId === reference.providerRequestId
status.isDraft === false
typeof status.sentDateTime === "string"
!Number.isNaN(Date.parse(status.sentDateTime))
```

Hash a length-prefixed canonical string containing provider, immutable ID, sent timestamp, and optional Internet message ID. Return only `outlook-mail-status:v1:sha256:<hex>`.

- [ ] **Step 4: Run the focused test to verify GREEN**

Run:

```bash
node --import tsx --test tests/outlookMailReconciliationAdapter.test.ts
```

Expected: all adapter tests pass with no console output or leaked fixture values.

- [ ] **Step 5: Add invalid-reference, mismatch and redaction tests**

Add tests proving:

- wrong provider, empty request ID, control-character ID, overlength ID, and empty correlation ID return `unresolved/outlook-provider-reference-invalid`;
- no invalid reference calls the client;
- mismatched response ID, missing/invalid sent timestamp, and malformed found data return `unresolved/outlook-message-status-invalid`;
- a thrown client error containing a token, mailbox and message ID is converted to `Error("outlook-message-status-unavailable")`;
- an already-redacted `OutlookGraphError` code is preserved without its cause text;
- the same terminal fixture produces the same digest and a changed sent timestamp produces a different digest.

The production break these tests catch is a network call with an unsafe reference, a false terminal success, or provider data leaking through worker errors.

- [ ] **Step 6: Run RED then implement redacted error handling**

First run the focused test and confirm the newly added cases fail for their expected missing validation or leak. Then add a stable exported error type:

```ts
export class OutlookReconciliationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "OutlookReconciliationError";
  }
}
```

Catch client errors and throw only this stable error. Do not preserve `cause`, stack-derived text, or the source error message.

- [ ] **Step 7: Run adapter tests and commit**

Run:

```bash
node --import tsx --test tests/outlookMailReconciliationAdapter.test.ts
```

Expected: all pass.

Commit:

```bash
git add typescript/src/reconciliation/outlookMailReconciliationAdapter.ts typescript/tests/outlookMailReconciliationAdapter.test.ts
git commit -m "feat(reconciliation): classify Outlook mail status"
```

---

### Task 2: GET-only Microsoft Graph status client

**Files:**
- Create: `typescript/tests/microsoftGraphMessageStatusClient.test.ts`
- Create: `typescript/src/reconciliation/microsoftGraphMessageStatusClient.ts`

**Interfaces:**
- Consumes: `OutlookMessageStatusClient`, `OutlookMessageStatusResult`, and `OutlookReconciliationError` from Task 1.
- Produces:
  - `AccessTokenSupplier = (signal: AbortSignal) => Promise<string>`
  - `MicrosoftGraphMessageStatusClientOptions`
  - `MicrosoftGraphMessageStatusClient`

- [ ] **Step 1: Write the failing exact-request test**

Inject a fetch function that records `RequestInfo | URL` and `RequestInit`, then returns:

```ts
new Response(
  JSON.stringify({
    id: "immutable/message 1",
    isDraft: false,
    sentDateTime: "2026-07-28T00:00:00.000Z",
    internetMessageId: "<quote-1@example.invalid>",
  }),
  { status: 200, headers: { "content-type": "application/json" } },
)
```

Call with mailbox `thebeeztreez+quotes@outlook.com` and immutable ID `immutable/message 1`. Assert the literal request contract:

```text
method: GET
origin/path: https://graph.microsoft.com/v1.0/users/thebeeztreez%2Bquotes%40outlook.com/messages/immutable%2Fmessage%201
query: $select=id,isDraft,sentDateTime,internetMessageId
Accept: application/json
Authorization: Bearer access-token
Prefer: IdType="ImmutableId"
redirect: error
body: undefined
signal: exact supplied signal
```

Assert the returned result is the literal found structure. The production break this catches is a write-capable method, unstable Outlook ID, broad response projection, unencoded path or dropped cancellation.

- [ ] **Step 2: Run the focused test to verify RED**

Run:

```bash
node --import tsx --test tests/microsoftGraphMessageStatusClient.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `microsoftGraphMessageStatusClient.js`.

- [ ] **Step 3: Implement the minimal client**

Constructor options:

```ts
export type MicrosoftGraphMessageStatusClientOptions = {
  getAccessToken: AccessTokenSupplier;
  fetch?: typeof globalThis.fetch;
  graphOrigin?: "https://graph.microsoft.com/v1.0";
};
```

Use the default origin exactly. Build the URL with `encodeURIComponent` path segments and `URLSearchParams`. Reject an empty access token with `OutlookReconciliationError("outlook-graph-authorization-failed")`. Issue one GET request with the exact headers and redirect policy above.

For HTTP 200, parse JSON as `unknown`, validate the four selected fields without coercion, and return `{ status: "invalid" }` for malformed JSON or malformed fields rather than throwing.

- [ ] **Step 4: Run the exact-request test to verify GREEN**

Run:

```bash
node --import tsx --test tests/microsoftGraphMessageStatusClient.test.ts
```

Expected: the exact-request test passes.

- [ ] **Step 5: Add HTTP classification and leak tests**

Add table-driven literal cases:

```text
404 -> not-observable
410 -> not-observable
429 + Retry-After: 120 -> throttled/120000
429 + Retry-After: 0, 301, date, junk or absent -> throttled without retryAfterMs
500, 503, 504 -> unavailable
400, 409, 422 -> rejected
401, 403 -> throw OutlookReconciliationError/outlook-graph-authorization-failed
200 malformed JSON -> invalid
200 wrong field type -> invalid
```

Add a network rejection containing `Bearer secret-token`, mailbox, ID and a Graph request identifier. Assert the thrown message is exactly `outlook-graph-request-failed` and serialized error text contains none of the fixture values. Assert a token-supplier failure is exactly `outlook-graph-token-unavailable`. Assert an already-aborted signal reaches both token supplier and fetch; no replacement controller is created.

- [ ] **Step 6: Run RED then implement classifications**

Confirm the new cases fail. Implement:

```ts
function retryAfterMilliseconds(value: string | null): number | undefined {
  if (value === null || !/^[1-9]\d*$/.test(value)) return undefined;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds <= 300 ? seconds * 1000 : undefined;
}
```

Never read or include response bodies for non-200 responses. Catch and rethrow only stable `OutlookReconciliationError` codes. Do not wrap aborts with provider details.

- [ ] **Step 7: Run both focused suites and commit**

Run:

```bash
node --import tsx --test   tests/outlookMailReconciliationAdapter.test.ts   tests/microsoftGraphMessageStatusClient.test.ts
```

Expected: all pass.

Commit:

```bash
git add typescript/src/reconciliation/microsoftGraphMessageStatusClient.ts typescript/tests/microsoftGraphMessageStatusClient.test.ts
git commit -m "feat(reconciliation): query Outlook immutable message status"
```

---

### Task 3: Operator boundary and full verification

**Files:**
- Modify: `docs/deployment.md`
- Verify: `typescript/src/http/main.ts`
- Verify: `typescript/src/preview/main.ts`
- Verify: `typescript/src/quotes/quoteEmailProvider.ts`
- Verify: `typescript/src/actions/toolExecutionFactory.ts`

**Interfaces:**
- Consumes: the adapter and Graph client from Tasks 1 and 2.
- Produces: operator documentation that distinguishes implemented reconciliation code from unapproved runtime activation.

- [ ] **Step 1: Update deployment documentation**

Under `Reconciliation runtime`, record:

- `microsoft-graph-mail-v1` is implemented as a read-only library component but not composed by HTTP or preview entrypoints;
- future send implementations must create an Outlook draft with immutable IDs, durably persist its immutable message ID before the send call, then send that existing draft;
- Graph `202 Accepted` is not terminal success;
- no token environment variable, OAuth setup, `Mail.Send` permission or activation procedure exists yet;
- enabling `JARVIS_RECONCILIATION_ENABLED=true` still fails closed in maintained runtimes.

- [ ] **Step 2: Verify the authority boundary from runtime behavior**

Run the existing quote allowlist, tool-factory and runtime-host suites together with the new tests:

```bash
cd typescript
node --import tsx --test   tests/quoteAllowlistBoundary.test.ts   tests/toolExecutionFactory.test.ts   tests/runtimeReconciliationHost.test.ts   tests/outlookMailReconciliationAdapter.test.ts   tests/microsoftGraphMessageStatusClient.test.ts
```

If `tests/toolExecutionFactory.test.ts` does not exist, use the existing test file returned by `rg -l "createToolExecutionServiceFromEnv" tests`. Expected behavior:

- quote sending remains absent when `createQuoteEmailProviderFromEnv()` returns `null`;
- enabled maintained-runtime construction without explicit factories still throws;
- no new Outlook code is imported by `http/main.ts` or `preview/main.ts`.

- [ ] **Step 3: Run the complete permanent gate**

Run:

```bash
cd typescript
npm ci
npm audit
npm run type-check
npm run lint
npm run format:check
npm run openapi:lint
npm run test:coverage
```

Also require the Jarvis Console build/type-check, automation-policy workflow and Copilot Review Check in GitHub Actions.

- [ ] **Step 4: Perform a leak and write-capability review**

Review the complete branch diff. Reject the slice if any of these appear outside tests or documentation:

```text
POST
PUT
PATCH
DELETE
sendMail
/messages/.../send
Mail.Send
JARVIS_OUTLOOK_ACCESS_TOKEN
process.env access from either new source file
imports of Outlook adapter/client from http/main.ts or preview/main.ts
```

Verify every thrown error is a stable code and every non-200 Graph path avoids parsing the response body.

- [ ] **Step 5: Commit documentation and plan evidence**

Commit:

```bash
git add docs/deployment.md docs/superpowers/plans/2026-07-28-outlook-mail-reconciliation-adapter.md
git commit -m "docs(reconciliation): define Outlook adapter boundary"
```

- [ ] **Step 6: Open a draft PR and shepherd it to readiness**

PR title:

```text
feat(reconciliation): inspect Outlook immutable message status
```

PR body must state:

- read-only GET adapter only;
- no email/calendar write and no live Outlook request;
- no runtime activation or token configuration;
- no Convex, Manufact or production deployment;
- exact RED commit/run and GREEN commit/run;
- exact current head and required CI evidence;
- future OAuth/send-provider activation remains separately gated.

Repair all deterministic CI or review findings test-first. Mark ready only when exact-head CI is green and no review thread remains. Request explicit exact-head approval before landing.
