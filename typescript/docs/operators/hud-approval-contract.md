# HUD governed approval contract

The operator HUD is a projection and inspection surface. It is not an approval
authority and it is not an execution runtime.

```text
proposal
  → authoritative inspection
  → approval          (HTTP operator path + JARVIS_APPROVAL_TOKEN)
  → execution         (HTTP execute, service token, allowlist)
  → receipt
  → reconciliation
```

Those stages stay distinct. The HUD must not collapse them into a generic
SUCCESS state. Missing observation is **OUTCOME UNKNOWN**, never FAILURE.

## Boundary

| Surface          | May inspect proposals | May inspect quotes | May approve | May execute | Holds `JARVIS_APPROVAL_TOKEN`                        |
| ---------------- | --------------------- | ------------------ | ----------- | ----------- | ---------------------------------------------------- |
| MCP widget / HUD | yes                   | yes                | no          | no          | no                                                   |
| MCP adapter      | yes (service token)   | yes                | no          | no          | no                                                   |
| HTTP operator    | yes                   | yes                | yes         | yes         | operator-held, body of `/approve` and `/revoke` only |

The widget talks to ChatGPT Apps through `postMessage` / `tools/call`. Anything
the widget can invoke, the model can also invoke. Therefore:

- the widget never stores `JARVIS_APPROVAL_TOKEN`
- the widget never calls `/approve`, `/revoke`, or `/execute`
- MCP does not grow `approve_tool_action` / `reject_tool_action` tools
- APPROVE / REJECT in the HUD are inspect-path controls that point at the
  existing HTTP operator routes

Reject also stays off MCP. It does not require the approval token, but MCP is
agent-callable, so a widget-initiated reject would not be a human-only signal.

## Reads the HUD may use

- `GET /api/v1/projects/{projectId}/tool-actions`
- `GET /api/v1/projects/{projectId}/tool-actions/{actionId}`
- `GET /api/v1/quotes/{quoteId}`
- `GET /api/v1/reconciliations` (fail-soft; 503 outside Convex)
- `GET /api/v1/projects/{projectId}/tool-actions/{actionId}/receipts`
  (live vs dry-run are distinct; `liveReceipt` is null when only a dry-run exists)

## Writes the HUD must not perform

- `POST .../tool-actions/{actionId}/approve` (requires `approvalToken`)
- `POST .../tool-actions/{actionId}/revoke` (requires `approvalToken`)
- `POST .../tool-actions/{actionId}/execute`

Complete-task is a separate durable HTTP mutation
(`POST /api/v1/tasks/{taskId}/complete`) already bound as MCP `complete_task`.
HUD COMPLETE TASK confirmation protects against accidental interactive
activation only. It does not constitute an authorisation boundary. The existing
`complete_task` MCP capability retains its current authority. It is not quote
approval and not tool-action execution.

`quotes:send` remains uncommissioned until the delivery stack is registered.
Quote inspection succeeding is **QUOTE VERIFIED / AWAITING COMMISSIONING**, not
evidence that send is live.

## Presentation stages

See `src/hud/hudApprovalLifecycle.ts`.

Fail-closed: if a quote-send proposal cannot load the authoritative quote, the
stage is `inspection_failed` and `canSubmitApproval` is false. Uncommissioned
`quotes:send` is `awaiting_commissioning` and `canSubmitApproval` is also false.

Receipt observation is per action. `GET .../receipts` distinguishes
`awaiting_execution` (the list read succeeded and no live receipt exists) from
`outcome_unknown` (that action's receipt read failed, was unqueried, or the
register is unavailable). A successful dry-run is not a live receipt.

## Runtime presence

`deriveHudPresence` maps `SystemStatus`, reconciliation health, and proposed
count. It must not invent `listening`, `processing`, or `executing`. Those
require an explicit runtime field that does not exist on `SystemStatus` yet.

## Backend still required for full observation

- an explicit runtime presence field for listening / processing / executing
- no change to the dual-token approval architecture
