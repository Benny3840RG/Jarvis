# Console Manufact Initialise Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Manufact verify the Console MCP server without weakening authentication on Jarvis data or mutations.

**Architecture:** A pure gateway-decision module distinguishes the MCP initialise handshake from protected traffic. The existing Hono middleware parses only the request method and maps the decision to `next`, HTTP 503 or HTTP 401.

**Tech Stack:** TypeScript, Node test runner, mcp-use/Hono middleware, GitHub Actions, Manufact Cloud.

## Global Constraints

- Only a top-level JSON-RPC `initialize` request may bypass the custom bearer-token gate.
- All tool, resource, prompt, continuation and SSE operations remain protected.
- Missing gateway configuration remains HTTP 503 for protected traffic.
- Invalid credentials remain HTTP 401.
- No secret values may enter source, tests, logs or MCP output.
- No production deployment occurs in this plan.

---

### Task 1: Gateway decision contract

**Files:**
- Create: `typescript/jarvis-console-01/gatewayAuth.ts`
- Create: `typescript/jarvis-console-01/tests/gateway-auth.test.ts`

**Interfaces:**
- Consumes: `configuredToken?: string`, `candidateToken?: string`, `rpcMethod?: string`.
- Produces: `decideGatewayAccess(input): GatewayAccessDecision` where the decision is `allow-initialize`, `allow-token`, `missing-configuration` or `unauthorized`.

- [ ] **Step 1: Write the failing test**

Cover initialise bypass, missing configuration, valid token, missing token, wrong token and prefix/suffix rejection.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd typescript && node --import tsx --test jarvis-console-01/tests/gateway-auth.test.ts`

Expected: FAIL because `gatewayAuth.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

Use SHA-256 digests plus `timingSafeEqual` for configured-token comparison. Check `rpcMethod === "initialize"` before configuration because this is the deployment-health exception.

- [ ] **Step 4: Run focused and package tests**

Run: `cd typescript && node --import tsx --test jarvis-console-01/tests/gateway-auth.test.ts && npm run test:node`

Expected: PASS.

- [ ] **Step 5: Commit**

Commit message: `fix(console): isolate gateway initialise exception`.

### Task 2: MCP middleware integration

**Files:**
- Modify: `typescript/jarvis-console-01/index.ts`
- Modify: `typescript/jarvis-console-01/tests/gateway-auth.test.ts`

**Interfaces:**
- Consumes: `decideGatewayAccess` from Task 1.
- Produces: Manufact-compatible MCP initialise response while preserving existing 503/401 responses for protected operations.

- [ ] **Step 1: Extend the failing test**

Add source-contract assertions that `index.ts` reads a cloned JSON POST body, supplies the parsed top-level method to `decideGatewayAccess`, and maps all four decisions explicitly.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd typescript && node --import tsx --test jarvis-console-01/tests/gateway-auth.test.ts`

Expected: FAIL because `index.ts` still gates every MCP request before method inspection.

- [ ] **Step 3: Write minimal integration**

Parse the method only for JSON POST `/mcp` traffic. Permit `allow-initialize` and `allow-token`; return 503 for `missing-configuration`; return 401 for `unauthorized`. Do not relax `/sse`.

- [ ] **Step 4: Run all verification**

Run: `cd typescript && npm run type-check && npm run lint && npm run format:check && npm run openapi:lint && npm run test:coverage && npm --prefix jarvis-console-01 run build && npm --prefix jarvis-console-01 run audit:ci`

Expected: every command exits 0.

- [ ] **Step 5: Commit**

Commit message: `fix(console): permit Manufact MCP initialise check`.

### Task 3: Integration evidence

**Files:**
- Modify: pull-request description only.

**Interfaces:**
- Consumes: exact branch head and CI results.
- Produces: mergeable pull request with deployment root-cause evidence and a separately locked production redeploy step.

- [ ] **Step 1: Open a draft pull request**

Record failed deployment ID, HTTP 503 evidence, security boundary and commands run.

- [ ] **Step 2: Confirm exact-head CI**

Expected: repository checks and Console checks pass at the current head.

- [ ] **Step 3: Review for auth regression**

Confirm only `initialize` bypasses bearer authentication and no secret was committed.

- [ ] **Step 4: Merge after green checks**

Merge the exact reviewed head into `main`.

- [ ] **Step 5: Preserve the production lock**

Do not update Manufact trigger configuration or redeploy until explicit production approval is given.
