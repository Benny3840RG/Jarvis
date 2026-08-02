# Read-Only Quote Inspection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose lifecycle-native quote listing and detail reads through the Jarvis MCP console, then let the HUD open a sent quote from the real operations pipeline without adding any commercial mutation.

**Architecture:** Reuse the authenticated `GET /api/v1/quotes` and `GET /api/v1/quotes/{quoteId}` HTTP endpoints. `JarvisApiClient` returns the existing `QuoteSummary` and `QuoteSnapshot` types unchanged; the MCP server adds two read-only tools with strict Zod output schemas; the dashboard calls `get_quote` only when an operator selects a real pipeline row and renders a contained detail panel.

**Tech Stack:** TypeScript 6, Node test runner, MCP Apps SDK, Zod, static HTML/CSS/JavaScript.

## Global Constraints

- No Convex schema, repository, authentication, permission, credential or production deployment changes.
- No quote finalise, send, edit, delete or commercial-outcome controls.
- Quote reads remain owner-scoped by the existing authenticated HTTP repository boundary.
- Quote totals render as AUD with cent precision.
- The HUD must expose explicit loading, empty, not-found and retryable error states.
- Existing MCP tools and dashboard projections remain intact.
- Node version remains `>=24 <25`.

---

### Task 1: Require quote reads at the MCP client boundary

**Files:**
- Create: `typescript/tests/mcpQuoteInspection.test.ts`
- Modify: `typescript/src/mcp/jarvisApiClient.ts`

**Interfaces:**
- Consumes: existing `QuoteSummary`, `QuoteSnapshot`, `ListResponse<T>`, `DataResponse<T>` and authenticated `request()`.
- Produces: `listQuotes(): Promise<QuoteSummary[]>` and `getQuote(quoteId: string): Promise<QuoteSnapshot>`.

- [ ] **Step 1: Write the failing client test**

Use a recording fetch that returns literal lifecycle fixtures and assert:

```ts
const summaries = await client.listQuotes();
const snapshot = await client.getQuote("quote / 174");
assert.deepEqual(summaries, [SUMMARY]);
assert.deepEqual(snapshot, SNAPSHOT);
assert.deepEqual(paths, ["/api/v1/quotes", "/api/v1/quotes/quote%20%2F%20174"]);
```

The production break caught is removing either HTTP read or failing to encode a quote identifier.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm run test:node -- --test-name-pattern="reads quote summaries and one lifecycle snapshot"`

Expected: FAIL because `JarvisApiClient` has no `listQuotes` or `getQuote` method.

- [ ] **Step 3: Implement the minimal client methods**

```ts
async listQuotes(): Promise<QuoteSummary[]> {
  return (await this.request<ListResponse<QuoteSummary>>("GET", "/api/v1/quotes")).data;
}

async getQuote(quoteId: string): Promise<QuoteSnapshot> {
  return (
    await this.request<DataResponse<QuoteSnapshot>>(
      "GET",
      `/api/v1/quotes/${encodeURIComponent(quoteId)}`,
    )
  ).data;
}
```

- [ ] **Step 4: Run the focused test and type-check**

Run:

```bash
npm run test:node -- --test-name-pattern="reads quote summaries and one lifecycle snapshot"
npm run type-check
```

Expected: PASS.

### Task 2: Expose strict read-only MCP tools

**Files:**
- Modify: `typescript/src/mcp/server.ts`
- Modify: `typescript/src/mcp/operationContract.ts`
- Modify: `typescript/tests/mcpQuoteInspection.test.ts`
- Modify: `typescript/tests/mcpOperationBinding.test.ts`
- Modify: `typescript/tests/mcpProtocol.test.ts`

**Interfaces:**
- Consumes: `JarvisApiClient.listQuotes()`, `JarvisApiClient.getQuote()`, `QuoteSummary`, and `QuoteSnapshot`.
- Produces: `list_quotes` structured content `{ quotes, count }` and `get_quote` structured content `{ quote }`.

- [ ] **Step 1: Add failing MCP protocol assertions**

Connect an in-memory MCP client, require `list_quotes` and `get_quote` in the tool catalogue, call both tools and assert the complete literal summary/snapshot fixtures. Assert `readOnlyHint: true`, `destructiveHint: false`, and no quote mutation tool names.

- [ ] **Step 2: Verify RED**

Run: `npm run test:node -- --test-name-pattern="exposes quote inspection as read-only MCP tools"`

Expected: FAIL because neither MCP tool is registered.

- [ ] **Step 3: Add lifecycle-native schemas and handlers**

Define schemas matching `QuoteSummary`, `QuoteAggregate`, `QuoteRevisionLineItem`, `QuoteRevision`, and `QuoteSnapshot`. Register:

```ts
list_quotes -> client.listQuotes() -> { quotes, count }
get_quote({ quoteId }) -> client.getQuote(quoteId) -> { quote }
```

Both tools use `readAnnotations`. `list_quotes` is model-visible; `get_quote` is model-and-app-visible and uses the existing dashboard resource so a widget `tools/call` result can update the detail panel.

- [ ] **Step 4: Extend the operation map and live-shaped fixtures**

Add:

```ts
list_quotes: [{ method: "GET", path: "/api/v1/quotes" }],
get_quote: [{ method: "GET", path: "/api/v1/quotes/{quoteId}" }],
```

Update `TOOL_INVOCATIONS`, mock HTTP responses, and the protocol tool-name assertions with complete literal lifecycle fixtures.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
npm run test:node -- --test-name-pattern="quote inspection|operation bindings|preview protocol"
npm run type-check
```

Expected: PASS.

### Task 3: Add quote drill-down to the Operations view

**Files:**
- Modify: `typescript/src/mcp/dashboard-v1.html`
- Modify: `typescript/tests/mcpWidget.test.ts`

**Interfaces:**
- Consumes: a quote summary from `brief.quotes.awaitingResponse` and a `get_quote` tool result shaped as `{ quote: QuoteSnapshot }`.
- Produces: selectable pipeline rows and a read-only quote detail panel showing number, lifecycle state, line items, subtotal, GST, total, validity and notes.

- [ ] **Step 1: Write the failing widget behaviour test**

Extract the quote-row selection handler and renderer from the embedded script, provide a real DOM-lite fixture, and assert:

```ts
await openQuote({ id: "quote-174", number: "174" });
assert.deepEqual(calls, [{ name: "get_quote", args: { quoteId: "quote-174" } }]);
assert.equal(elements.get("quote-detail-total")?.textContent, "$3,200.50");
assert.equal(renderedItems.length, 2);
```

Also require visible `LOADING QUOTE`, `QUOTE NOT FOUND` and `RETRY` copy. The production breaks caught are wrong tool/ID wiring, stale totals, omitted line items, or a silent failure state.

- [ ] **Step 2: Verify RED**

Run: `npm run test:node -- --test-name-pattern="opens a pipeline quote in the read-only inspector"`

Expected: FAIL because pipeline rows are not interactive and no quote inspector exists.

- [ ] **Step 3: Implement the contained inspector**

Add a compact detail panel inside `view-operations`, initialise `state.selectedQuote` and `state.quoteDetailState`, and create:

```js
async function openQuote(summary) {
  state.quoteDetailState = "loading";
  renderQuoteDetail();
  try {
    const result = await callTool("get_quote", { quoteId: summary.id });
    state.selectedQuote = result?.quote || null;
    state.quoteDetailState = state.selectedQuote ? "ready" : "not-found";
  } catch (error) {
    state.selectedQuote = null;
    state.quoteDetailState = error?.status === 404 ? "not-found" : "error";
  }
  renderQuoteDetail();
}
```

Render all values with `textContent`; never inject quote text with `innerHTML`. Pipeline rows are buttons with quote number, status and cent-precise total. Retry reuses the selected summary. Empty pipeline retains the existing calm empty state.

- [ ] **Step 4: Verify GREEN and regressions**

Run:

```bash
npm run test:node -- --test-name-pattern="quote|operations projection|syntactically valid|unsupported telemetry"
npm run type-check
```

Expected: PASS.

### Task 4: Full verification and pull request

**Files:**
- Review every file changed by Tasks 1–3.

**Interfaces:**
- Consumes: completed quote inspection slice.
- Produces: a guarded, independently reviewed pull request.

- [ ] **Step 1: Run the full repository gate**

Run: `npm run check`

Expected: type-check, lint, Prettier, OpenAPI lint, Node tests and Convex tests pass.

- [ ] **Step 2: Inspect the complete diff**

Confirm the diff contains no quote mutation, schema, credential, permission, deployment, generated artefact or unrelated change.

- [ ] **Step 3: Run independent review**

Review the exact base/head diff for output-schema drift, owner-scope bypass, unsafe DOM injection, stale-selection races, malformed/404 failure handling and cent precision. Fix all Critical and Important findings through a fresh red–green cycle.

- [ ] **Step 4: Open the pull request**

Title: `feat(console): inspect quotes from operations pipeline`

The PR body must document the two HTTP reads, read-only MCP annotations, explicit failure states, absence of lifecycle mutations, and exact verification evidence.