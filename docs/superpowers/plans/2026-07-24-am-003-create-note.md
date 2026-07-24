# AM-003 Create Note Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Commission `AM-003 Create note` as Jarvis's first active action family using owner-scoped Convex persistence and the hardened tool execution boundary.

**Architecture:** Add a dedicated Notes domain and Convex store with mutation-level idempotency, expose one strict `notes:create` tool definition, and register only that operation in the live allowlist. Keep the action family planned until real tests, registries, generated documentation, and fresh CI evidence all pass.

**Tech Stack:** TypeScript, Zod, Convex, Node test runner, YAML governance registries, GitHub Actions.

## Global Constraints

- Development code only; no Convex production deployment.
- Use the existing owner identity derived from `JARVIS_SERVICE_TOKEN`.
- Scope notes to the authoritative project ID carried by the approved action.
- Do not add an in-memory production store or parallel backend.
- Make note creation idempotent at both execution-receipt and note-mutation boundaries.
- Keep all other tool operations non-allowlisted.

---

### Task 1: Specify the Notes domain and tool contract

**Files:**
- Create: `typescript/src/notes/note.ts`
- Create: `typescript/src/actions/createNoteTool.ts`
- Test: `typescript/tests/createNoteTool.test.ts`

- [ ] Define note domain, sensitivity, retention, record, and store contracts.
- [ ] Define strict create-note payload validation matching AM-003.
- [ ] Pass execution fingerprint and idempotency context into the store.
- [ ] Verify valid execution, malformed input, replay, and payload mismatch.

### Task 2: Implement owner-scoped Convex persistence

**Files:**
- Create: `typescript/convex/noteValidators.ts`
- Create: `typescript/convex/notes.ts`
- Modify: `typescript/convex/schema.ts`
- Create: `typescript/src/persistence/convexNotes.ts`
- Test: `typescript/tests/convexNotes.test.ts`

- [ ] Add the durable notes table and indexed owner/project/idempotency read path.
- [ ] Implement create replay and fingerprint-conflict handling.
- [ ] Preserve source, sensitivity, retention, timestamps, and revision metadata.
- [ ] Verify adapter mapping, exact mutation arguments, and service-token isolation.

### Task 3: Register the single live operation

**Files:**
- Modify: `typescript/src/actions/toolExecution.ts`
- Modify: `typescript/src/actions/toolExecutionFactory.ts`
- Test: `typescript/tests/createNoteTool.test.ts`

- [ ] Provide execution context to tool definitions without breaking existing definitions.
- [ ] Register only `notes:create` when Convex persistence is configured.
- [ ] Keep every other tool and operation fail-closed.

### Task 4: Activate traceability only after implementation

**Files:**
- Modify: `docs/registries/tool-registry.yaml`
- Modify: `docs/registries/state-target-registry.yaml`
- Modify: `docs/registries/test-id-registry.yaml`
- Modify: `docs/registries/evidence-id-registry.yaml`
- Modify: `docs/traceability/action-family-registry.yaml`
- Regenerate: `docs/traceability/action-map.generated.md`

- [ ] Add real TEST IDs bound to committed tests.
- [ ] Add a committed commissioning evidence artifact.
- [ ] Mark tool and state target implemented.
- [ ] Mark AM-003 active only after the evidence chain is complete.

### Task 5: Verify and land

- [ ] Pass governance validation.
- [ ] Pass MCP build, type-check, lint, Prettier, OpenAPI, and full tests.
- [ ] Record final head SHA and workflow run IDs.
- [ ] Confirm no unresolved review findings.
- [ ] Merge and close issue #150 only after fresh green evidence.
