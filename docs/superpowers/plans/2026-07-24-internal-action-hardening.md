# Internal Action Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the security subset required before AM-003 Create note can become active.

**Architecture:** Canonicalize security-sensitive action payloads before hashing, persist all execution decisions through the existing owner-scoped Convex receipt store, and enrich receipts with immutable request, policy, approval, actor, correlation, and source context. Preserve the fail-closed allowlist and existing in-flight fingerprint-race protection.

**Tech Stack:** TypeScript, Node test runner, Zod, Convex, GitHub Actions.

## Global Constraints

- Development only; no Convex production deployment.
- Preserve the empty runtime allowlist until AM-003 is separately commissioned.
- Use existing owner-scoped Convex persistence.
- Do not introduce a parallel or in-memory production store.
- Evidence before lifecycle activation.

---

### Task 1: Canonical action fingerprints

**Files:**
- Create: `typescript/src/actions/canonicalJson.ts`
- Modify: `typescript/src/actions/toolExecution.ts`
- Test: `typescript/tests/toolExecutionHardening.test.ts`

- [x] Define recursive key sorting and fail-closed unsupported-value handling.
- [x] Prefix fingerprints with `jarvis-action-fingerprint:v1`.
- [x] Cover equivalent key ordering, changed payloads, and unsupported values.

### Task 2: Durable terminal decisions

**Files:**
- Modify: `typescript/src/actions/toolExecution.ts`
- Test: `typescript/tests/toolExecutionHardening.test.ts`

- [x] Persist blocked outcomes.
- [x] Persist dry-run outcomes.
- [x] Preserve succeeded, failed, and indeterminate persistence.
- [x] Preserve in-flight fingerprint mismatch protection.

### Task 3: Receipt audit metadata

**Files:**
- Modify: `typescript/src/actions/toolExecution.ts`
- Modify: `typescript/src/persistence/convexToolExecutionReceipts.ts`
- Modify: `typescript/convex/toolExecutionValidators.ts`
- Modify: `typescript/convex/toolExecutionReceipts.ts`
- Modify: `typescript/convex/schema.ts`
- Test: `typescript/tests/convexToolExecutionReceipts.test.ts`

- [x] Persist request ID and actor.
- [x] Persist optional approval ID.
- [x] Persist policy version, correlation ID, and source.
- [x] Keep owner scope enforced by the existing authenticated Convex index.

### Task 4: Verification and evidence

**Files:**
- Modify after CI: issue #153 and PR evidence comment.

- [ ] Run full TypeScript CI.
- [ ] Run governance validation when applicable.
- [ ] Fix all failures from actual logs.
- [ ] Record final head SHA, workflow run IDs, test result, and review state.
- [ ] Merge only after fresh green evidence.
