# Tool action approval

Jarvis stores tool actions as explicit project-scoped proposals before any external operation may be
considered. Proposal, inspection, approval, and rejection are one durable stage. Execution is a second,
separately gated stage, wired to a small, reviewed allowlist: `notes:create`, `tasks:create`,
`tasks:complete`, `reminders:create`, and `reminders:cancel` (see [Execution](#execution) below). Every
other `tool:operation` pair — including quote finalize/send, which have no implemented tool or state
transition yet — is blocked with `errorCode: "not-allowlisted"`.

## State machine

```text
proposed -> approved
         -> rejected
```

There is deliberately no `executed` state on the `ToolAction` record itself. Approval records operator
intent; it does not call a tool or mutate an external system. Execution is tracked separately, as an
immutable receipt keyed by the action and a caller-supplied idempotency key — an approved action can be
the subject of an execution attempt any number of times (each with its own key), without the proposal's
own state ever changing.

## Proposal requirements

Every proposal includes:

- a stable action ID and owner-scoped idempotency key;
- the originating request ID;
- a project ID and expected project revision;
- a named tool and operation;
- bounded JSON arguments;
- a plain-language rationale;
- the required tool-authority level;
- an explicit destructive flag;
- the proposing actor.

Jarvis normalises argument-object key order before persistence and rejects non-finite numbers, reserved
keys, credential-shaped keys, oversized strings, excessive depth, excessive object size, and
unsupported values. Keys such as `password`, `apiKey`, `access_token`, `Authorization`,
`clientSecret`, and equivalent punctuation or case variants are not permitted anywhere in the argument
tree. Credentials belong in server-side configuration, never in proposals or audit records.

Reusing an action ID is idempotent only when the full proposal is identical. An idempotency key is
unique to one owner and cannot be rebound to a different action ID. Concurrent staging attempts remain
inside Convex optimistic concurrency control, so only one proposal can acquire the key.

## Authority levels

| Level | Meaning in this boundary                                               |
| ----- | ---------------------------------------------------------------------- |
| `T0`  | No tool-action proposal permitted                                      |
| `T1`  | Low-authority, non-destructive proposal                                |
| `T2`  | Higher-authority, non-destructive proposal requiring operator approval |
| `T3`  | Highest authority; mandatory for proposals marked destructive          |

A destructive proposal below `T3` is rejected before persistence. This is a classification boundary,
not permission to execute. Reaching `approved` state still does not authorise a specific tool call —
`ToolExecutionService` separately checks the acting authority against `requiredAuthority`, and beyond
that, requires the exact `tool`:`operation` pair to be explicitly registered server-side. Only the five
pairs listed above are registered; every other attempt is blocked with `errorCode: "not-allowlisted"`
regardless of authority or approval state.

## Revision boundary

Staging and approval both compare the supplied revision with the authoritative project revision.
Approval fails with a conflict when the project has changed since the proposal was created. The action
must then be reviewed and restaged against current project context rather than silently replayed.

## HTTP operations

All routes require the existing Jarvis Bearer service token.

| Method | Path                                                           | Result                        |
| ------ | -------------------------------------------------------------- | ----------------------------- |
| POST   | `/api/v1/projects/{projectId}/tool-actions`                    | Stage a proposal              |
| GET    | `/api/v1/projects/{projectId}/tool-actions`                    | List recent proposals         |
| GET    | `/api/v1/projects/{projectId}/tool-actions/{actionId}`         | Inspect one proposal          |
| POST   | `/api/v1/projects/{projectId}/tool-actions/{actionId}/approve` | Approve after review          |
| POST   | `/api/v1/projects/{projectId}/tool-actions/{actionId}/reject`  | Reject with a reason          |
| POST   | `/api/v1/projects/{projectId}/tool-actions/{actionId}/execute` | Attempt execution (see below) |

## Execution

`ToolExecutionService` (`src/actions/toolExecution.ts`) is the executor referenced above as a future
stage — it now exists, is fully tested, and is wired to the `/execute` route. It satisfies the controls
that were previously listed as required before this stage could be built:

1. **Explicit allowlist** — `POST /execute` loads the approved `ToolAction`, then looks up a
   `ToolExecutionDefinition` by `tool:operation`. **The allowlist registered in
   `src/actions/toolExecutionFactory.ts` currently holds five reviewed definitions:**
   `notes:create`, `tasks:create`, `tasks:complete`, `reminders:create`, and `reminders:cancel`, each
   backed by an implemented, tested Convex-persisted store (see
   `docs/registries/tool-registry.yaml` and `state-target-registry.yaml` for exact file bindings). Any
   other `tool:operation` pair returns a receipt with `status: "blocked"` and
   `errorCode: "not-allowlisted"`, regardless of the action's own approval or authority. Registering each
   new definition remains a deliberate, separately reviewed decision — not a side effect of this stage
   having shipped.
2. **Exact argument schemas per operation** — each registered definition carries its own zod schema;
   the action's stored `arguments` are re-validated against it immediately before any call.
3. **Authority and destructive-operation checks** — the acting authority (asserted server-side as `T3`,
   since a single Bearer service token gates this whole HTTP surface and there is no separate per-caller
   authority signal) must meet or exceed the action's `requiredAuthority`.
4. **Idempotency and replay protection** — the request body's `idempotencyKey`, combined with the
   action ID, is the receipt's lookup key. Replaying the same key returns the original receipt
   byte-for-byte rather than executing again. A `dryRun: true` request validates everything but is never
   persisted, so the same key can still be used for a real attempt afterward.
5. **Bounded timeouts and redacted failures** — `timeoutMs` is clamped to 1–30000ms (default 5000ms).
   Failure receipts carry a fixed `errorCode` enum, never a raw error message or the tool's output.
6. **Durable execution receipts** — receipts are stored in the `toolExecutionReceipts` Convex table,
   scoped by owner, and are the authoritative record of every execution attempt. They are not currently
   mirrored into the general `auditEvents` table (unlike proposal/approval/rejection) — the receipts
   table is itself the complete, durable audit trail for executions specifically.
7. **Dry-run tests and live smoke checkpoints** — the executor itself is covered in
   `tests/toolExecution.test.ts` and `tests/toolActionHttp.test.ts`. Each registered definition has its
   own domain, tool, persistence, and self-cleaning development-smoke tests (for example
   `tests/notesSmoke.test.ts` and `tests/taskReminderActionsSmoke.test.ts`), matching every other
   domain's `smoke:convex` pattern.

## Audit evidence

Convex appends project-scoped audit events for:

- `tool.action.proposed`;
- `tool.action.approved`;
- `tool.action.rejected`.

Audit payloads contain identifiers and decision metadata, not service credentials. The service-token
boundary remains server-side. Execution attempts are recorded as receipts (see above), not as
`auditEvents` rows.
