# Operations Inbox, Activity Timeline & Integration Health

Three read-only operator surfaces, each derived only from existing durable records — never fabricated,
never inferred from environment-variable presence, never a percentage without a documented formula. All
three are owner-scoped and reachable through `GET /api/v1/operations/inbox`,
`GET /api/v1/operations/activity`, and the `integrations` field of `GET /api/v1/status`, plus the
`get_operations_inbox`, `list_activity`, and `get_jarvis_status` MCP tools. None can execute, approve,
revoke, dismiss, acknowledge, or delete anything — inspection only.

## Operations Inbox

Answers: what genuinely needs the operator's attention right now, and why?

### Source-of-truth map

| Inbox source   | Backing read                                             | Status today                                  |
| --------------- | --------------------------------------------------------- | ---------------------------------------------- |
| `reminders`     | `PersistenceProvider.listReminders()`                      | Available                                       |
| `maintenance`   | `AssetStore.list()` + `deriveAssetView()`                  | Available                                       |
| `toolActions`   | Governed `ToolAction` consent-lifecycle read               | Unsupported — pending PR #246 landing on `main` |
| `reconciliation`| Reconciliation operator read model (`listForOperator`)     | Unsupported — pending PR #247 landing on `main` |
| `quoteDelivery` | Owner-wide quote-delivery-attempt read                      | Unsupported — no bounded owner-wide read exists yet, only a per-quote read |

`reminders` and `maintenance` reuse the exact domain reads `src/briefs/brief.ts` already uses — there is no
second query path for either.

### Severity

Five levels, most to least urgent: `critical > high > elevated > normal > informational`. Within one
severity, items sort by due date ascending (undated items sort last), then by a stable
`(sourceSubsystem, itemId)` tie-break — so the order is identical across renders even when timestamps and
severities are equal. See `src/operations/inboxSeverity.ts` (`compareInboxItems`).

### Per-source availability — never a zero in disguise

Every source reports one of `available | unavailable | degraded | unsupported`, plus a `checkedAt`
timestamp and, for anything but `available`, a concrete `reason`. One source's read failure never fails
the whole inbox response and never hides another source's items. The distinction that matters most:

- **`unavailable`** — the read was attempted and failed just now. Something is actually broken.
- **`unsupported`** — no read exists yet for this source (a dependency hasn't landed). This is an expected,
  calm state, not an incident.
- **Zero items** only ever means every checked source came back empty. If any source is `unavailable` or
  `degraded`, the inbox never claims "nothing needs attention" — see `inboxSummaryLabel()` in the HUD and
  the `"never reports 'nothing needs attention'..."` test in `tests/mcpOperationsHudWiring.test.ts`.

### Operator recovery

An `unavailable` source's `reason` string is the actual caught error message from that read (redacted of
secrets by the existing problem-details/error-handling boundary). Investigate that subsystem directly; the
inbox itself has no retry or repair action, by design — it is inspection-only.

## Activity Timeline

Answers: what actually happened recently, in order? `GET /api/v1/operations/activity`
(`cursor`, `limit` query params; `limit` 1–100, default 50) reads `auditEvents` — the durable audit log
already written by the tool-action and memory-change-set subsystems — across every project scope
(`by_owner_and_created_at`, an additive Convex index; the pre-existing `by_owner_and_scope_key` index could
only page through one scope at a time and could never serve a genuine cross-scope timeline).

### Event meanings

Every event's `summary` is built from a fixed, per-`eventType` whitelist of known-safe fields (see
`SUMMARISERS` in `src/operations/activityTimeline.ts`) — never the event's raw payload. Today's whitelisted
types:

| `eventType`                       | Meaning                                                    |
| ---------------------------------- | ----------------------------------------------------------- |
| `tool.action.proposed`             | A governed tool action was staged for approval               |
| `tool.action.approved`             | An operator approved a staged tool action                     |
| `tool.action.rejected`             | An operator rejected a staged tool action (reason included)   |
| `tool.action.execution-claimed`    | A single-use tool action's atomic execution claim was won     |
| `memory.change_set.proposed`       | A memory change set was staged for approval                   |
| `memory.change_set.approved`       | An operator approved a staged memory change set                |
| `memory.change_set.rejected`       | An operator rejected a staged memory change set (reason included) |
| `memory.change_set.applied`        | An approved memory change set was written to durable memory    |

An event type outside this table — including any future one an emitter adds without updating the
whitelist — falls back to a type-only summary (`"<eventType> event."`) rather than exposing its payload.
This is a deliberate fail-safe: a new emitter can never leak an unreviewed field into the timeline by
accident.

### Privacy boundary

No raw `payload` field is ever returned to a caller. Only `activityId`, `occurredAt`, `eventType`, `actor`,
`summary`, and an optional `projectKey` are exposed (`ActivityEvent` in `src/operations/activityTimeline.ts`).
The `projectKey` is omitted entirely when the underlying event was recorded without one (the `"__global__"`
scope sentinel), rather than leaking that internal sentinel string to callers.

### Unavailable vs. empty

`{status: "available", events: [], isDone: true}` means the read succeeded and there is genuinely no
activity yet. `{status: "unavailable", reason}` means the read itself failed or the deployment has no
Convex-backed reader configured. The HUD and the `list_activity` MCP tool both render these two states with
distinct copy — an empty page is never mislabelled as "unavailable", and an unavailable read is never
silently shown as an empty page.

### Deferred scope (documented, not silently dropped)

The design considered also folding `toolExecutionReceipts` and `externalReconciliations` history into this
timeline. Neither is included in this slice: `toolExecutionReceipts` has no owner-wide time-ordered index
or query yet either, and `externalReconciliations` is PR #247's (a different agent's, unmerged) owned read
surface. Adding either now would mean a second new schema index beyond the one this slice committed to,
and/or consuming a not-yet-landed capability from another branch. Extending the timeline to those sources
is a follow-up once #247 merges and an owner-wide receipts read exists.

## Integration Health

`GET /api/v1/status`'s `integrations` array reports evidence-backed commissioning state — never a
percentage without a documented formula, never inferred from an environment variable simply being set.
Today's only line item:

| `name`            | `status`                          | Evidence                                                                 |
| ------------------ | ----------------------------------- | --------------------------------------------------------------------------- |
| `quote-delivery`   | `commissioned` / `not-commissioned` | `ToolExecutionService.isRegistered("quotes", "send")` — the same conditional registration `toolExecutionFactory.ts` already performs from the real quote-repository / email-provider / delivery-repository / PDF-artifact-repository bundle. |

`not-commissioned` always carries a concrete `reason` (either "tool execution is not configured in this
deployment" or "the quotes:send tool is not registered"); `commissioned` carries no `reason` at all. This
check makes no new live call to Outlook or any other external provider — it only asks the already-running
`ToolExecutionService` what it registered at startup.

A separate `get_integration_health` MCP tool was deliberately not added: `get_jarvis_status` is already
MCP-exposed and now carries `integrations` directly, so a second tool would just duplicate the same
`SystemStatus` read.

## HUD

`src/mcp/dashboard-v1.html`'s Operations view gained two new full-width panels — "Operations inbox" and
"Activity timeline" (tagged `DURABLE`, to disambiguate it from the pre-existing session-only "Live operator
feed" panel, tagged `SESSION`) — and the Systems view's Runtime Health panel gained an "Integration
commissioning" sub-section. All three are additive: none of the pre-existing panels' IDs, markup, or
render logic were changed. `show_jarvis_dashboard`'s combiner fetches the inbox and a bounded (`limit: 5`)
activity page alongside the existing brief/tasks/reminders/quotes reads; a failure reaching either endpoint
degrades to `null` in the response (distinct from an empty inbox or activity's own `unavailable` status)
rather than failing the whole dashboard snapshot.
