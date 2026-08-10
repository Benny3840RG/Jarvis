# ΩΣ Runtime Pass 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a durable ΩΣ mission/control layer that gates selected single-use Jarvis tool actions and reconciles terminal execution receipts back into mission evidence.

**Architecture:** Keep the existing governed `toolActions` and `toolExecutionReceipts` as the only external-effect and durable-outcome boundaries. ΩΣ adds mission, evidence, validation-proof and one-shot action-contract state, then hooks only the existing atomic single-use claim and receipt mutation. Non-ΩΣ actions remain backward compatible.

**Tech Stack:** TypeScript, Convex schema/mutations/queries, Node test runner, repository `npm run check` gate, GitHub Actions.

## Global Constraints

- Do not add a parallel tool executor.
- Pass 2 contracts bind only to existing Jarvis `single-use` tool actions.
- Non-ΩΣ actions must continue to execute under existing Jarvis governance unchanged.
- ΩΣ authority may never outlive the underlying Jarvis approval.
- R3/R4 mission completion requires independent validation proof.
- Terminal `indeterminate` receipts are evidence of an indeterminate outcome, never inferred success.
- PR #361 control-plane credential hardening is a prerequisite and this branch remains stacked on its head until that PR lands.

---

### Task 1: Mission policy primitives

**Files:**
- Create: `typescript/src/omega/policy.ts`
- Create: `typescript/tests/omegaPolicy.test.ts`
- Create: `typescript/convex/omegaValidators.ts`

**Interfaces:**
- Produces: immutable mission acceptance-criteria evaluation helpers used by Convex mission mutations.
- Produces: validators for mission state, action-contract state, risk/autonomy/reversibility, evidence and validation proof fields.

- [ ] **Step 1: Add failing policy tests**

Cover: criteria begin unverified; proof must target an existing criterion; every evidence ref must exist; R3/R4 requires `independent: true`; completion requires explicit residual uncertainty within budget.

- [ ] **Step 2: Run the focused Node policy test**

Run: `cd typescript && node --test --import tsx tests/omegaPolicy.test.ts`
Expected: FAIL until the policy module exists.

- [ ] **Step 3: Implement the minimal policy module and validators**

Implement pure functions/types only; freeze returned acceptance-criteria structures so callers cannot mutate validated completion evidence after evaluation.

- [ ] **Step 4: Run focused policy tests**

Run: `cd typescript && node --test --import tsx tests/omegaPolicy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

Commit message: `feat(omega): add mission policy primitives`

### Task 2: Durable mission/evidence/proof schema and mutations

**Files:**
- Modify: `typescript/convex/schema.ts`
- Create: `typescript/convex/omegaMissions.ts`
- Test: add Convex tests in `typescript/convex/omegaMissions.test.ts`

**Interfaces:**
- Consumes: validators and policy helpers from Task 1.
- Produces: `omegaMissions`, `omegaEvidence`, and `omegaValidationProofs` tables plus mission/evidence/proof mutations and queries.

- [ ] **Step 1: Add failing Convex tests**

Cover duplicate mission IDs, evidence ownership, dangling proof criteria/evidence, R3/R4 independent-proof requirement, unresolved contracts blocking completion, and explicit residual uncertainty.

- [ ] **Step 2: Extend schema with indexed ΩΣ mission/evidence/proof tables**

Use owner-scoped compound indexes so lookups remain bounded.

- [ ] **Step 3: Implement mission lifecycle mutations**

Create mission, add evidence, record proof, move executable mission states, and complete only when policy and contract reconciliation gates pass.

- [ ] **Step 4: Run focused Convex tests**

Run: `cd typescript && npm run test:convex -- omegaMissions`
Expected: PASS using the repository's supported test invocation; if the script does not accept a filter, run the full Convex suite.

- [ ] **Step 5: Commit**

Commit message: `feat(omega): persist governed mission state`

### Task 3: One-shot action contracts

**Files:**
- Modify: `typescript/convex/schema.ts`
- Create: `typescript/convex/omegaActionContracts.ts`
- Test: `typescript/convex/omegaActionContracts.test.ts`

**Interfaces:**
- Consumes: existing `toolActions` rows and ΩΣ missions.
- Produces: one-to-one contract binding by `toolActionId`; authorization helper state consumed by the execution gate.

- [ ] **Step 1: Add failing contract tests**

Cover: mission must exist; tool action must exist in the same owner/project scope; consumption policy must be `single-use`; required authority must match; duplicate binding rejected; authorization requires approved Jarvis action; ΩΣ expiry clamped to Jarvis approval expiry.

- [ ] **Step 2: Add `omegaActionContracts` schema and indexes**

Index by owner+mission+contract ID and owner+toolActionId.

- [ ] **Step 3: Implement bind and authorize mutations**

Do not mutate or replace the underlying Jarvis tool action. Store only the ΩΣ contract state and bridge reference.

- [ ] **Step 4: Run focused contract tests**

Expected: all contract invariants pass.

- [ ] **Step 5: Commit**

Commit message: `feat(omega): bind one-shot action contracts`

### Task 4: Atomic ΩΣ execution gate

**Files:**
- Create: `typescript/convex/omegaExecutionGate.ts`
- Modify: `typescript/convex/toolActions.ts`
- Modify: `typescript/convex/toolActions.test.ts`

**Interfaces:**
- Produces: `checkOmegaExecutionGate(ctx, ownerId, action, now)` returning either `{ ok: true }` or a typed ΩΣ block reason.
- Produces: `markOmegaExecutionStarted(...)` for bound one-shot contracts.
- Consumes: existing `claimSingleUseExecution` authoritative transaction.

- [ ] **Step 1: Add failing execution-boundary regressions**

Cover: non-ΩΣ single-use action unchanged; authorized ΩΣ contract claims successfully; blocked/aborted mission fails closed; expired contract fails closed; authority mismatch fails closed; failed ΩΣ gate must not write the Jarvis single-use claim.

- [ ] **Step 2: Implement the gate helper**

Lookup by owner+toolActionId. No contract means normal Jarvis action. A contract means mission and contract invariants are mandatory.

- [ ] **Step 3: Hook the gate into `claimSingleUseExecution`**

Order: existing Jarvis state/expiry check → ΩΣ gate → existing single-use claim write → ΩΣ contract claim marker. Do not hook reusable eligibility in Pass 2.

- [ ] **Step 4: Run `toolActions` Convex tests**

Expected: existing tests plus ΩΣ regressions pass.

- [ ] **Step 5: Commit**

Commit message: `feat(omega): gate atomic tool execution`

### Task 5: Receipt-driven reconciliation

**Files:**
- Create: `typescript/convex/omegaReconciliation.ts`
- Modify: `typescript/convex/toolExecutionReceipts.ts`
- Modify/Create: receipt reconciliation tests under `typescript/convex/`.

**Interfaces:**
- Produces: `reconcileOmegaContractFromReceipt(ctx, ownerId, receipt)` idempotently converting terminal receipts into ΩΣ evidence and reconciled contract state.
- Consumes: existing durable receipt document fields including action ID, status, fingerprint and completion time.

- [ ] **Step 1: Add failing reconciliation tests**

Cover succeeded, failed and indeterminate terminal receipts; duplicate receipt replay; non-ΩΣ receipt unchanged; evidence ID stability; contract moves to `reconciled` exactly once.

- [ ] **Step 2: Implement reconciliation helper**

Never infer success from `indeterminate`. Evidence claim/classification must reflect the actual terminal status.

- [ ] **Step 3: Call reconciliation from both existing-receipt and newly-created-receipt paths**

This makes retry/idempotency paths converge to the same ΩΣ state.

- [ ] **Step 4: Run receipt and ΩΣ Convex tests**

Expected: PASS.

- [ ] **Step 5: Commit**

Commit message: `feat(omega): reconcile execution receipts`

### Task 6: Full repository verification and PR

**Files:**
- Modify as needed only for generated types/formatting/docs required by the repository gate.
- Update: `docs/traceability/evidence-matrix.md` and/or requirements/test matrices if current repository conventions require traceability for this slice.

**Interfaces:**
- Produces: a reviewable stacked PR with exact-head CI evidence.

- [ ] **Step 1: Run Convex code generation/sync where the environment permits**

Run: `cd typescript && npx convex dev --once --tail-logs disable`
Expected: generated API/data model accepts the new tables/functions.

- [ ] **Step 2: Run repository gate**

Run: `cd typescript && npm run check`
Expected: type-check, lint, formatting/static checks, Node tests and Convex tests all pass.

- [ ] **Step 3: Push/fix until GitHub Actions is green on the exact head**

Do not classify a PR as ready while a required workflow is failing or pending.

- [ ] **Step 4: Open PR stacked on `fix/convex-control-plane-credentials`**

PR body must include the repository Copilot Review section with concrete findings.

- [ ] **Step 5: After #361 lands, retarget ΩΣ PR to `main` and re-verify exact-head CI**

Do not merge without explicit per-PR landing approval for the current head SHA.
