# ΩΣ Completion Truth and Contradiction Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make proofs plus current evidence the only ΩΣ criterion-completion truth and add an append-only, separately authorised resolution path for exact contradiction edges.

**Architecture:** Retain `acceptanceCriteria[].status/evidenceRefs` as a backward-compatible projection but remove them from the completion-policy interface so they cannot authorise completion. Add `omegaContradictionResolutions` as an immutable owner/mission-scoped table resolving exactly one `sourceEvidenceId -> targetEvidenceId` edge, then derive unresolved critical contradictions from current certain evidence minus valid resolution records.

**Tech Stack:** TypeScript, Convex, `convex-test`/Vitest, Node test runner, GitHub Actions.

**Spec:** `docs/requirements/omega-sigma-completion-integrity.md` and `typescript/docs/architecture/omega-completion-integrity.md` (issue #378)

## Global Constraints

- Frozen Jarvis v2.2 requirements remain untouched.
- `omegaActionContracts` remains a one-to-one bridge into existing `toolActions` / claims / receipts / reconciliation; no parallel executor.
- Completion must never trust persisted criterion `status` or `evidenceRefs`.
- A proof is current only when every referenced evidence row is same-owner/same-mission and unexpired at completion time.
- R3/R4 independent proof still requires the dedicated approval-token boundary.
- Contradiction resolution is append-only and exact-edge scoped; original evidence is never mutated.
- All completion reads are bounded and indexed.
- No HTTP/MCP/OpenAPI surface, remote exposure, Outlook/Graph commissioning, Convex production deployment, or other deployment occurs in this issue.

---

### Task 1: Make the pure completion policy proof-authoritative

**Files:**
- Modify: `typescript/src/omega/policy.ts`
- Modify: `typescript/tests/omegaPolicy.test.ts`

**Interfaces:**
- Consumes: current proof records already filtered for current evidence by the Convex boundary.
- Produces: `CompletionCriterion = { criterionId: string }` and `evaluateOmegaCompletion()` that cannot consume projected mission status/evidence fields.

- [ ] **Step 1: Write the failing policy regression**

Replace status-driven fixtures with definition-only criteria and add a test proving one current passing proof is sufficient without any criterion projection:

```ts
const decision = evaluateOmegaCompletion({
  criteria: [{ criterionId: "AC-1" }],
  proofs: [{
    criterionId: "AC-1",
    result: "pass",
    independent: false,
    evidenceRefs: ["EV-1"],
  }],
  riskClass: "R2",
  unresolvedCriticalContradictions: 0,
  unreconciledExternalEffects: 0,
  residualUncertainty: 0.1,
  uncertaintyBudget: 0.2,
});
assert.deepEqual(decision, { allowed: true, failures: [] });
```

Also preserve tests for unknown criteria, missing passing proof, missing proof evidence, failed proof, R3/R4 independent proof, external reconciliation and uncertainty.

- [ ] **Step 2: Run the focused test and prove RED**

Run:

```bash
cd typescript
node --import tsx --test tests/omegaPolicy.test.ts
```

Expected: compile/test failure because `CompletionCriterion` still requires `status/evidenceRefs` and policy still reads them.

- [ ] **Step 3: Implement the minimal policy change**

Change the criterion interface and completion loop to derive completion only from proofs:

```ts
export interface CompletionCriterion {
  criterionId: string;
}

for (const criterion of input.criteria) {
  const passingProofs = input.proofs.filter(
    (proof) => proof.criterionId === criterion.criterionId && proof.result === "pass",
  );
  if (passingProofs.length === 0) {
    failures.push(`criterion-missing-passing-proof:${criterion.criterionId}`);
    continue;
  }
  if (
    riskRequiresIndependentValidation(input.riskClass) &&
    !passingProofs.some((proof) => proof.independent)
  ) {
    failures.push(`criterion-missing-independent-proof:${criterion.criterionId}`);
  }
}
```

Keep `passing-proof-missing-evidence`, unknown-criterion, current failed-proof, contradiction, reconciliation and uncertainty checks.

- [ ] **Step 4: Run the focused policy test and prove GREEN**

Run the command from Step 2. Expected: all policy tests pass.

- [ ] **Step 5: Commit**

Commit message: `refactor(omega): derive completion from proofs`

### Task 2: Add the append-only contradiction-resolution entity

**Files:**
- Modify: `typescript/convex/omegaValidators.ts`
- Modify: `typescript/convex/omegaSchema.ts`
- Create: `typescript/convex/omegaContradictionResolutions.ts`
- Create: `typescript/convex/omegaContradictionResolutions.test.ts`

**Interfaces:**
- Produces table `omegaContradictionResolutions`.
- Produces mutation `omegaContradictionResolutions.record`.
- Durable record fields: `ownerId`, `missionId`, `resolutionId`, `contradictionEvidenceId`, `contradictedEvidenceId`, `reason`, `resolvedBy`, `authority`, `resolvedAt`.

- [ ] **Step 1: Write failing Convex tests**

Cover all of these behaviours before implementation:

```ts
await t.mutation(anyApi.omegaContradictionResolutions.record, {
  serviceToken: SERVICE_TOKEN,
  approvalToken: APPROVAL_TOKEN,
  missionId: "mission-1",
  resolutionId: "resolution-1",
  contradictionEvidenceId: "EV-CONTRA",
  contradictedEvidenceId: "EV-BASE",
  reason: "Independent inspection established the base measurement was stale.",
  resolvedBy: "owner-review",
});
```

Assertions:
- no approval token rejects;
- missing/cross-mission source or target rejects;
- source not naming target in `contradicts` rejects;
- exact resolution-ID replay returns the same row;
- same ID with changed contents rejects;
- different ID for the same edge rejects;
- resolution after mission `complete`/`retired` rejects;
- concurrent different IDs targeting one edge produce at most one durable winner.

- [ ] **Step 2: Run focused Convex tests and prove RED**

Run:

```bash
cd typescript
./node_modules/.bin/vitest run --config vitest.config.mts convex/omegaContradictionResolutions.test.ts
```

Expected: fail because the table/function do not exist.

- [ ] **Step 3: Add validators and indexed schema**

Add document validator and table with these indexes:

```ts
omegaContradictionResolutions: defineTable({
  ownerId: v.string(),
  missionId: v.string(),
  resolutionId: v.string(),
  contradictionEvidenceId: v.string(),
  contradictedEvidenceId: v.string(),
  reason: v.string(),
  resolvedBy: v.string(),
  authority: v.literal("approval-token"),
  resolvedAt: v.number(),
})
  .index("by_owner_and_mission_id", ["ownerId", "missionId"])
  .index("by_owner_mission_and_resolution_id", ["ownerId", "missionId", "resolutionId"])
  .index("by_owner_mission_and_contradiction_edge", [
    "ownerId",
    "missionId",
    "contradictionEvidenceId",
    "contradictedEvidenceId",
  ]),
```

- [ ] **Step 4: Implement `record` with separate authority**

Use object-form Convex mutation with `args` and `returns`. Require owner plus `requireApprovalToken()`, exact replay semantics, source/target scoped indexed lookups, `source.contradicts.includes(targetId)`, one resolution per edge, a bounded per-mission limit, and `Date.now()` for `resolvedAt`. Never patch `omegaEvidence`.

- [ ] **Step 5: Run focused tests and prove GREEN**

Run the Step 2 command. Expected: all contradiction-resolution tests pass.

- [ ] **Step 6: Commit**

Commit message: `feat(omega): add contradiction resolutions`

### Task 3: Derive completion from current proofs and resolved contradiction edges

**Files:**
- Modify: `typescript/convex/omegaMissions.ts`
- Create: `typescript/convex/omegaCompletionTruthSecurity.test.ts`
- Preserve: existing `typescript/convex/omegaValidationSecurity.test.ts`, `omegaWaiverSecurity.test.ts`, and `omegaRuntime*.test.ts`

**Interfaces:**
- Consumes: `omegaValidationProofs`, `omegaEvidence`, `omegaContradictionResolutions`, existing `omegaActionContracts`.
- Produces: fail-closed completion input independent of mission projection fields.

- [ ] **Step 1: Write failing completion-truth tests**

Add regressions proving:

1. Directly seeded legacy mission projection `status: "satisfied"` with fake `evidenceRefs` cannot complete without a current passing proof.
2. A valid passing proof allows completion even if the persisted compatibility projection is deliberately stale/`unverified`.
3. A proof becomes non-current if **any** referenced evidence expires before completion.
4. R3/R4 still require a current independent passing proof.
5. One unresolved current certain contradiction edge blocks completion.
6. Resolving that exact edge permits completion when all other gates are satisfied.
7. Resolving one edge does not clear another edge from the same source.
8. A malformed/dangling legacy contradiction remains blocking.

- [ ] **Step 2: Run focused tests and prove RED**

Run:

```bash
cd typescript
./node_modules/.bin/vitest run --config vitest.config.mts convex/omegaCompletionTruthSecurity.test.ts
```

Expected: projected-state tests and resolution tests fail under the old completion path.

- [ ] **Step 3: Replace projected-state completion input**

In `transition(... -> complete)`:

```ts
const currentEvidenceIds = new Set(
  evidence
    .filter((item) => item.validUntil === undefined || item.validUntil > now)
    .map((item) => item.evidenceId),
);

const currentProofs = proofs
  .filter(
    (proof) =>
      proof.evidenceRefs.length > 0 &&
      proof.evidenceRefs.every((ref) => currentEvidenceIds.has(ref)),
  )
  .map((proof) => ({
    criterionId: proof.criterionId,
    result: proof.result,
    independent: proof.independent,
    evidenceRefs: proof.evidenceRefs,
  }));

const criteriaForCompletion = mission.acceptanceCriteria.map((criterion) => ({
  criterionId: criterion.criterionId,
}));
```

Do not read `criterion.status` or `criterion.evidenceRefs` while building completion input. Keep the existing `recordValidationProof` mission patch only as compatibility projection.

- [ ] **Step 4: Apply exact-edge contradiction resolution**

Read `omegaContradictionResolutions` through `by_owner_and_mission_id` with `MAX_RESOLUTIONS_PER_MISSION + 1`; fail if the bound is exceeded. Build exact edge keys and count each unmatched edge from current `certain` source evidence as unresolved.

- [ ] **Step 5: Run focused and existing ΩΣ tests**

Run:

```bash
cd typescript
node --import tsx --test tests/omegaPolicy.test.ts
./node_modules/.bin/vitest run --config vitest.config.mts convex/omega*.test.ts
```

Expected: new completion truth tests and every existing ΩΣ safety/runtime test pass.

- [ ] **Step 6: Commit**

Commit message: `fix(omega): make completion proof authoritative`

### Task 4: Record migration/security evidence and traceability

**Files:**
- Create: `docs/traceability/omega-completion-integrity-tdd.md`
- Modify: `docs/traceability/evidence-matrix.md`
- Modify only if required by repository conventions: related test/evidence registries

**Interfaces:**
- Produces: durable documentation of RED→GREEN proof, compatibility policy, and exact-head CI evidence.

- [ ] **Step 1: Record the red proof**

Document exact red commit SHA, commands/workflow runs, expected failing tests, and why the failures prove the old authority path or missing resolution entity.

- [ ] **Step 2: Record the green proof and migration truth**

State explicitly:

```text
acceptanceCriteria[].status/evidenceRefs remain compatibility projection only.
Completion consumes criterion IDs, current proofs, current evidence, exact-edge contradiction resolutions, existing reconciliation state, and uncertainty policy.
No existing mission/evidence/proof row is rewritten or deleted.
```

- [ ] **Step 3: Update traceability**

Link issue #378 / OS-CI-001–OS-CI-012 to the focused Node/Convex tests and evidence record without inventing v2.2 requirement IDs.

- [ ] **Step 4: Commit**

Commit message: `docs(omega): record completion integrity evidence`

### Task 5: Full verification and pull request

**Files:**
- No unrelated changes.

**Interfaces:**
- Produces: exact-head verified PR for issue #378.

- [ ] **Step 1: Run focused tests**

```bash
cd typescript
node --import tsx --test tests/omegaPolicy.test.ts
./node_modules/.bin/vitest run --config vitest.config.mts convex/omega*.test.ts
```

Expected: all pass.

- [ ] **Step 2: Run repository gate**

```bash
cd typescript
npm run check
```

Expected: type-check, lint, formatting/static checks, Node tests and Convex tests pass.

- [ ] **Step 3: Inspect branch scope**

Compare against the current `main` head. Reject unrelated runtime, dependency, deployment, Outlook, or production changes.

- [ ] **Step 4: Open the PR**

PR body must cite issue #378, the scoped ΩΣ requirements and architecture docs, RED→GREEN evidence, compatibility behaviour, no-deployment boundary, and the six mandatory Copilot Review lines.

- [ ] **Step 5: Verify exact-head GitHub Actions**

Require Governance validation if triggered, TypeScript checks, and Copilot Review Check to pass. Record exact run IDs in the traceability evidence and PR body.

- [ ] **Step 6: Landing gate**

Do not merge. Report the exact ready head SHA and request explicit per-PR landing confirmation only after all current-head gates are green.
