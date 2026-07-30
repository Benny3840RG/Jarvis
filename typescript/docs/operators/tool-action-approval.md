# Tool action approval

Jarvis stores tool actions as explicit project-scoped proposals before any external operation may be
considered. Proposal, inspection, approval, and rejection are one durable stage. Execution is a second,
separately gated stage, wired to a small, reviewed allowlist: `notes:create`, `tasks:create`,
`tasks:complete`, `reminders:create`, and `reminders:cancel` (see [Execution](#execution) below).
A sixth definition, `quotes:send`, is registered only when Convex persistence and every quote-delivery
dependency — including the explicitly enabled Outlook provider — are available. `quotes:finalize` and
every other unregistered `tool:operation` pair are blocked with `errorCode: "not-allowlisted"`.
Quote send remains uncommissioned and is not exposed through MCP or the HUD.

## State machine

```text
proposed -> approved
         -> rejected
```

There is deliberately no `executed` state on the `ToolAction` record itself. Approval records operator
intent; it does not call a tool or mutate an external system. Execution is tracked separately, as an
immutable receipt keyed by the approved action and a server-derived execution scope. Caller retry keys
remain part of the HTTP compatibility contract but cannot create a new commercial execution scope.
Repeated live attempts for one approved action replay the same receipt; dry-run and live execution use
separate derived scopes. The proposal's own state does not change during execution.

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
that, requires the exact `tool`:`operation` pair to be explicitly registered server-side. The five base pairs listed above are always registered in the maintained Convex runtime.
`quotes:send` is conditionally registered only when all delivery dependencies resolve; every other
attempt is blocked with `errorCode: "not-allowlisted"` regardless of authority or approval state.

## Revision boundary

Staging and approval both compare the supplied revision with the authoritative project revision.
Approval fails with a conflict when the project has changed since the proposal was created. The action
must then be reviewed and restaged against current project context rather than silently replayed.

## HTTP operations

All routes require the existing Jarvis Bearer service token. `POST .../approve` additionally
requires `approvalToken` in its request body — a second, separately configured secret
(`JARVIS_APPROVAL_TOKEN`, with optional `JARVIS_APPROVAL_TOKEN_PREVIOUS` during rotation) that
only the human operator holds. It is checked with the same constant-time comparison as the
service token and is never accepted from, or reused by, any other route: staging, listing, and
executing all still authenticate with the shared Bearer token alone. This exists so that holding
the service token — which an AI agent staging proposals necessarily does — is not by itself proof
that a human decided to approve a specific one. If `JARVIS_APPROVAL_TOKEN` is not configured,
`/approve` fails closed with a 503 rather than accepting any token.

| Method | Path                                                           | Result                                          |
| ------ | -------------------------------------------------------------- | ----------------------------------------------- |
| POST   | `/api/v1/projects/{projectId}/tool-actions`                    | Stage a proposal                                |
| GET    | `/api/v1/projects/{projectId}/tool-actions`                    | List recent proposals                           |
| GET    | `/api/v1/projects/{projectId}/tool-actions/{actionId}`         | Inspect one proposal                            |
| POST   | `/api/v1/projects/{projectId}/tool-actions/{actionId}/approve` | Approve after review (requires `approvalToken`) |
| POST   | `/api/v1/projects/{projectId}/tool-actions/{actionId}/reject`  | Reject with a reason                            |
| POST   | `/api/v1/projects/{projectId}/tool-actions/{actionId}/execute` | Attempt execution (see below)                   |

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
   having shipped. `quotes:send` is the only conditional definition: it is included only when Convex
   persistence, the quote repository, delivery ledger, PDF artifact repository and Outlook email
   provider all resolve successfully. It remains uncommissioned and unreachable through MCP/HUD.
2. **Exact argument schemas per operation** — each registered definition carries its own zod schema;
   the action's stored `arguments` are re-validated against it immediately before any call.
3. **Authority and destructive-operation checks** — the acting authority (asserted server-side as `T3`,
   since a single Bearer service token gates this whole HTTP surface and there is no separate per-caller
   authority signal) must meet or exceed the action's `requiredAuthority`.
4. **Idempotency and replay protection** — the controller derives the execution key from the approved
   action ID and the server-selected mode (`live` or `dry-run`). The caller's `idempotencyKey` remains
   required for HTTP compatibility but is not trusted to define execution identity. Retrying one
   approved live action with any caller key returns the original receipt byte-for-byte rather than
   executing again. A `dryRun: true` request validates everything and writes a durable decision/audit
   receipt under its own derived dry-run scope, so it cannot consume or mutate the live execution scope.
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
