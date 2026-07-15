# Tool action approval

Jarvis stores tool actions as explicit project-scoped proposals before any external operation may be
considered. This stage provides proposal, inspection, approval, and rejection only. It does not include
an executor.

## State machine

```text
proposed -> approved
         -> rejected
```

There is deliberately no `executed` transition in this stage. Approval records operator intent; it does
not call a tool, mutate an external system, or grant Jarvis a general execution capability.

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
not permission to execute. An approved `T3` proposal is still only approved data until a later,
allowlisted executor stage is built and independently reviewed.

## Revision boundary

Staging and approval both compare the supplied revision with the authoritative project revision.
Approval fails with a conflict when the project has changed since the proposal was created. The action
must then be reviewed and restaged against current project context rather than silently replayed.

## HTTP operations

All routes require the existing Jarvis Bearer service token.

| Method | Path                                                           | Result                |
| ------ | -------------------------------------------------------------- | --------------------- |
| POST   | `/api/v1/projects/{projectId}/tool-actions`                    | Stage a proposal      |
| GET    | `/api/v1/projects/{projectId}/tool-actions`                    | List recent proposals |
| GET    | `/api/v1/projects/{projectId}/tool-actions/{actionId}`         | Inspect one proposal  |
| POST   | `/api/v1/projects/{projectId}/tool-actions/{actionId}/approve` | Approve after review  |
| POST   | `/api/v1/projects/{projectId}/tool-actions/{actionId}/reject`  | Reject with a reason  |

No `/execute` route exists. Requests to such a route return `404`.

## Audit evidence

Convex appends project-scoped audit events for:

- `tool.action.proposed`;
- `tool.action.approved`;
- `tool.action.rejected`.

Audit payloads contain identifiers and decision metadata, not service credentials. The service-token
boundary remains server-side.

## Next controlled stage

A future executor must be a separate slice with:

1. an explicit tool/operation allowlist;
2. exact argument schemas per operation;
3. authority and destructive-operation policy checks;
4. idempotency and replay protection;
5. bounded timeouts and redacted failures;
6. durable execution receipts;
7. dry-run tests and a development-only live smoke checkpoint.

Until those controls exist, approval cannot cause side effects. That is intentional.
