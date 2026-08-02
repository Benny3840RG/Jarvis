# Dashboard Operations Projection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Feed the existing daily brief into the Jarvis dashboard and render real projects, quote pipeline and maintenance state.

**Architecture:** Extend the existing MCP dashboard snapshot rather than creating another endpoint or store. `JarvisApiClient.dashboard()` reads the existing brief concurrently with current status/task/reminder reads, the MCP schema validates it, and the embedded app renders an Operations view from structured content.

**Tech Stack:** TypeScript 6, Node test runner, MCP Apps SDK, Zod, static HTML/CSS/JavaScript.

## Global Constraints

- No database or Convex schema changes.
- No permission, credential or production deployment changes.
- No fabricated CPU, GPU, token, cost, latency or historical activity telemetry.
- The operator feed remains session-only.
- Existing exports and MCP tools remain intact.
- Node version remains `>=24 <25`.

---

### Task 1: Specify the dashboard snapshot contract

**Files:**
- Create: `typescript/tests/dashboardSnapshot.test.ts`

**Interfaces:**
- Consumes: `new JarvisApiClient(config, fetchImpl)` and `client.dashboard()`.
- Produces: regression coverage requiring `DashboardSnapshot.brief` and an authenticated `GET /api/v1/brief` read.

- [ ] **Step 1: Write the failing test**

Create a fixed status, task, reminder and daily-brief fixture. Record requested paths in the fake fetch function, call `dashboard()`, then assert:
```ts
assert.deepEqual(paths.sort(), [
  "/api/v1/brief",
  "/api/v1/reminders",
  "/api/v1/status",
  "/api/v1/tasks",
]);
assert.deepEqual(snapshot.brief, BRIEF);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm run test:node -- --test-name-pattern="projects the daily brief"`

Expected: FAIL because `dashboard()` neither requests `/api/v1/brief` nor returns `snapshot.brief`.

- [ ] **Step 3: Preserve the failing test as its own commit**

Commit: `test(mcp): require daily brief dashboard projection`

### Task 2: Extend the MCP snapshot

**Files:**
- Modify: `typescript/src/mcp/jarvisApiClient.ts`
- Modify: `typescript/src/mcp/server.ts`
- Modify: `typescript/src/mcp/operationContract.ts`
- Modify: `typescript/tests/mcpOperationBinding.test.ts`
- Modify: `typescript/tests/mcpProtocol.test.ts`

**Interfaces:**
- Consumes: existing `DailyBrief`, `briefSchema`, `getDailyBrief()` and `GET /api/v1/brief`.
- Produces: `DashboardSnapshot.brief: DailyBrief` and MCP structured output validated by `briefSchema`.

- [ ] **Step 1: Implement the minimal client projection**

Add `brief: DailyBrief` to `DashboardSnapshot`. Include `this.getDailyBrief()` in the existing `Promise.all`, then return `brief` without transformation.

- [ ] **Step 2: Extend the MCP output contract**

Add `brief: briefSchema` to `dashboardOutputSchema`.

Add `{ method: "GET", path: "/api/v1/brief" }` to `show_jarvis_dashboard` in `MCP_TOOL_OPERATIONS` and to the tolerated dashboard refresh reads.

- [ ] **Step 3: Update protocol fixtures**

Serve `{ data: BRIEF }` for `/api/v1/brief` and assert the exact literal brief in `result.structuredContent`.

- [ ] **Step 4: Verify GREEN**

Run:
```bash
npm run test:node -- --test-name-pattern="projects the daily brief|dashboard|operation bindings"
npm run type-check
```

Expected: PASS.

### Task 3: Render the Operations view

**Files:**
- Modify: `typescript/src/mcp/dashboard-v1.html`
- Modify: `typescript/tests/mcpWidget.test.ts`

**Interfaces:**
- Consumes: `state.brief` from MCP structured content.
- Produces: an Operations navigation view with headline, active-project, quote-pipeline and maintenance projections.

- [ ] **Step 1: Write widget expectations**

Require the Operations view labels and renderer hooks while retaining the unsupported-telemetry guard and embedded-script syntax test.

- [ ] **Step 2: Verify RED**

Run: `npm run test:node -- --test-name-pattern="operations projection"`

Expected: FAIL because the Operations view and renderer do not exist.

- [ ] **Step 3: Implement the view**

Initialise `state.brief` to null and accept object-valued `data.brief` in `update()`. Add a navigation button and `view-operations` with:
- the brief headline and generation stamp;
- active project rows;
- quote counts and pipeline/accepted totals formatted in AUD;
- equipment due and due-soon rows.

Render explicit empty messages when the brief or any collection is empty. Keep `activity()` unchanged and labelled SESSION.

- [ ] **Step 4: Verify GREEN**

Run:
```bash
npm run test:node -- --test-name-pattern="operations projection|syntactically valid|unsupported telemetry"
npm run type-check
```

Expected: PASS.

### Task 4: Full verification and PR

**Files:**
- Review all files changed by Tasks 1–3.

**Interfaces:**
- Consumes: completed implementation.
- Produces: a reviewable GitHub pull request.

- [ ] **Step 1: Run the full gate**

Run: `npm run check`

Expected: type-check, lint, format, OpenAPI lint and all Node/Convex tests pass.

- [ ] **Step 2: Inspect the diff**

Confirm no schema, credential, permission, generated deployment or unrelated files changed.

- [ ] **Step 3: Open the PR**

Title: `feat(console): project daily operations into dashboard`

The PR body must list the real data sources, session-only activity boundary and exact checks run.
