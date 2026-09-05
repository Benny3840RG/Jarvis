# Issue 435 Reasoning Status Projection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing authenticated Jarvis status projection so operators can see the configured Totality reasoning provider/model without exposing secrets or presenting configuration as invocation evidence.

**Architecture:** Reuse the existing Totality provider/model configuration and the trusted `MODEL_PROFILES` registry. Add one bounded read-only `reasoning` projection to the existing `SystemStatus`, carry it through the existing MCP status schema/client, and render it in the existing HUD. No endpoint, telemetry store, authority path, execution path, completion authority, or persistence mechanism is added.

**Tech Stack:** TypeScript 6, NestJS/Fastify, Zod, MCP Apps, node:test, Redocly/OpenAPI.

**Spec:** GitHub issue #435.

## Global Constraints

- Development-only proving mission; no production deployment, credential change, external side effect, or authority expansion.
- Configuration must never be described as evidence of a successful model invocation.
- API keys, prompts, provider response bodies, raw model output, and unverified cost claims must not enter status or HUD output.
- Reuse the existing model-resource governance registry as the trusted identity/capability source.
- Existing ToolAction, approval, claim, lease, evidence, reconciliation, and ΩΣ boundaries stay unchanged.

---

### Task 1: HTTP reasoning configuration projection

**Files:**

- Test: `typescript/tests/systemStatusReasoning.test.ts`
- Modify: `typescript/src/http/config.ts`
- Modify: `typescript/src/http/contracts.ts`
- Modify: `typescript/src/http/systemStatusService.ts`
- Modify: `typescript/src/integrations/openai/totalityReasoner.ts`
- Modify: `typescript/src/integrations/gemini/totalityReasoner.ts`

**Interfaces:**

- Consumes: `resolveTotalityReasonerProviderName()`, provider-specific model validators, `resolveTrustedModelProfile()`.
- Produces: `ReasoningConfigurationStatus` and `SystemStatus.reasoning`.

- [ ] **Step 1: Write the failing HTTP test**
  Assert `/api/v1/status` reports `configured` for a trusted configured OpenAI identity, `not-configured` when its credential is absent, never serialises the credential, and always sets `invocationVerified: false`.
- [ ] **Step 2: Run the focused test and verify RED**
  Run: `node --import tsx --test tests/systemStatusReasoning.test.ts` from `typescript/`.
  Expected: FAIL because `reasoning` is absent from `SystemStatus`.
- [ ] **Step 3: Implement the minimal safe projection**
  Export provider model-name resolvers so runtime construction and status projection share one validation/default path. Resolve the selected provider/model from existing Totality config, verify the identity against `MODEL_PROFILES`, inspect only credential presence, and store no secret material in `HttpAppConfig` or `SystemStatus`.
- [ ] **Step 4: Run the focused test and verify GREEN**
  Run the same command; expected PASS.

### Task 2: MCP and HUD propagation

**Files:**

- Modify/Test: `typescript/src/mcp/server.ts`
- Modify: `typescript/src/mcp/dashboard-v1.html`
- Modify/Test: `typescript/tests/mcpProtocol.test.ts`
- Modify/Test: `typescript/tests/dashboardSnapshot.test.ts`
- Modify affected typed `SystemStatus` fixtures under `typescript/tests/`.

**Interfaces:**

- Consumes: `SystemStatus.reasoning` from Task 1.
- Produces: the same field through `get_jarvis_status`/dashboard structured content and a non-authoritative HUD rendering.

- [ ] **Step 1: Add failing MCP/HUD assertions**
  Assert the MCP schema accepts and preserves provider/model/status, and the dashboard resource has a dedicated reasoning configuration display plus copy stating it is configuration-only/unverified.
- [ ] **Step 2: Run focused tests and verify RED**
  Run: `node --import tsx --test tests/mcpProtocol.test.ts tests/dashboardSnapshot.test.ts`.
- [ ] **Step 3: Extend the existing status Zod schema and HUD**
  Add no new tool or endpoint. Render configured identity as provider/model and unconfigured/unavailable states explicitly; label the display as configuration/observability, not health or execution proof.
- [ ] **Step 4: Run focused tests and verify GREEN**

### Task 3: OpenAPI contract and full verification

**Files:**

- Modify: `typescript/openapi/jarvis.openapi.json`
- Modify existing OpenAPI/status contract tests where present.

**Interfaces:**

- Consumes: final `SystemStatus.reasoning` shape.
- Produces: a documented authenticated response contract with bounded, non-secret fields only.

- [ ] **Step 1: Add/extend contract assertion before schema change and verify RED**
- [ ] **Step 2: Add the OpenAPI reasoning configuration schema and require it from `SystemStatus`**
- [ ] **Step 3: Run focused OpenAPI/static checks**
  Run: `npm run openapi:lint` and relevant contract tests.
- [ ] **Step 4: Run complete verification**
  Run from `typescript/`: `npm run check`.
  Run repository automation-policy tests/checks required by the PR workflows.
- [ ] **Step 5: Review the PR diff for authority-boundary changes and secret leakage**
  Confirm no action/approval/claim/lease/ΩΣ/persistence/external-effect code changed and no API-key-like values appear in response fixtures or UI output.
- [ ] **Step 6: Record evidence on #435 and only then merge after exact-head review/checks**
