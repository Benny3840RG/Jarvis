# AM-003 Create Note Commissioning Evidence

## Disposition

`AM-003 Create note` is eligible for activation on the Jarvis v2.2 development baseline.

This evidence applies only to the authorised Convex development deployment:

```text
dev:outgoing-ram-798
https://outgoing-ram-798.convex.cloud
```

Production deployment was not authorised or performed.

## Runtime implementation

Merged runtime commit:

```text
0ed8627b5b5b119444f2821bbe0a7380afb5ee87
```

Implemented binding:

```text
AM-003
→ notes:create
→ TOOL-NOTES-CREATE
→ STORE-NOTES
```

Key implementation files:

- `typescript/src/actions/createNoteTool.ts`
- `typescript/src/actions/toolExecutionFactory.ts`
- `typescript/src/notes/note.ts`
- `typescript/src/persistence/convexNotes.ts`
- `typescript/convex/notes.ts`
- `typescript/convex/noteValidators.ts`
- `typescript/convex/schema.ts`

The live runtime allowlist contains exactly `notes:create`. The authenticated cleanup mutation is not exposed through the tool allowlist.

## Pull-request verification

PR #157 final head:

```text
1f13a7984f414d0019d6f262647f87568d5dba4d
```

GitHub Actions evidence:

- TypeScript workflow run `30061513869`: success
- Governance workflow run `30061513893`: success
- MCP build: passed
- Type-check: passed
- ESLint and Convex rules: passed
- Pinned Prettier: passed
- OpenAPI validation: passed
- Full interactive CLI and persistence suite with coverage: passed
- Action-map schema, reference, semantic and generation checks: passed
- Unresolved review threads: 0
- Reviews requesting changes: 0

## Live development commissioning

Source commit commissioned:

```text
d0f6173262be9f1848640b2c271ae43b566cebc2
```

Workflow run:

```text
30061812009
```

Job:

```text
89384792987 — Sync and smoke AM-003 on authorised development
```

Every commissioning step passed:

- development-only boundary guard
- locked dependency installation
- exact-main verification gate
- Convex function sync to `dev:outgoing-ram-798`
- Notes create
- mutation-level idempotent replay
- fresh-client persistence visibility
- authenticated cleanup
- post-cleanup absence
- publication of the evidence receipt to issue #150

## Retained artifact

```text
Artifact ID: 8584817897
Name: am003-development-commissioning-30061812009
Digest: sha256:cc6fda3d71c79c8ed43dee49de2cebce9e45053fec735e291126270f5e590f7a
Expires: 2026-10-22T02:30:34Z
```

## Safety properties proven

- Owner identity is derived from the authenticated Jarvis service token.
- Notes are scoped by owner and project.
- Execution replay is bound to the canonical action fingerprint.
- Note mutation replay is independently bound to the same fingerprint.
- Changed content under a consumed key fails closed.
- Insufficient authority does not mutate the note store.
- Dry-run does not mutate the note store.
- Every non-allowlisted operation remains blocked.
- The live smoke is self-cleaning and verifies absence after cleanup.
- The smoke refuses non-development deployment identities before touching the store.

## Activation boundary

This evidence supports activation of only:

- `AM-003 Create note`
- `TOOL-NOTES-CREATE`
- `STORE-NOTES`

It does not support activation of `AM-012`, `AM-013`, `WF-QUOTE-001`, or any other external action family.
