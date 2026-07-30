# Tool Action Consent Lifecycle Implementation Plan

**Goal:** Give every governed `ToolAction` (not just quotes) an explicit, enforceable,
auditable consent lifetime — closing requirements R-048 (approval expiry) and R-049
(approval revocation) identified in Issue #243 and designed in Issue #244.

**Coordination note:** PR #245 (`agent/quote-delivery-reconciliation-hardening`,
authored by Codex) is concurrently modifying `typescript/src/actions/toolExecution.ts`
and `typescript/src/http/toolActionController.ts` (deriving execution idempotency from
the approved action, projecting reconciliation outcomes into the quote delivery
ledger). This plan deliberately **does not touch either file**. The Convex-side
consent-lifecycle machinery (schema, mutations, tests) lives entirely in
`convex/toolActions.ts` and friends, which PR #245 does not touch. The service-layer
`revoke()` capability is built and tested end-to-end through
`src/persistence/convexToolActions.ts`, but is **not** wired to an HTTP route in this
slice — that wiring, plus the execute()-time expiry/consumption enforcement, is an
explicitly deferred follow-up to be applied once PR #245 lands and `main` is updated.

## Global constraints

- Do not touch `typescript/src/actions/toolExecution.ts` or
  `typescript/src/http/toolActionController.ts` (PR #245 overlap).
- Do not touch `typescript/docs/operators/tool-action-approval.md` or
  `docs/registries/tool-registry.yaml` in place (PR #245's own Task 4 plans to edit
  both) — write a new, separate doc instead; consolidation is a follow-up once #245
  lands.
- All schema changes are additive only (new fields `v.optional`, state union widened
  by adding literals, nothing removed or narrowed) — no backfill migration required.
- No quote-sending, quote-finalization, or commercial-outcome capability is touched,
  exposed, or implied anywhere in this slice.
- No MCP tool exposes execution of any kind — only read-only status/audit inspection.
- Clock injection: every new/changed mutation and query that reasons about time takes
  an optional `now?: number` argument (defaulting to `Date.now()`), mirroring the
  existing convention in `convex/externalReconciliations.ts`'s `claimNext`/
  `resolveClaim`, so expiry tests are fully deterministic.

## State machine

Widen `TOOL_ACTION_STATES` from `["proposed", "approved", "rejected"]` to also include
`"expired"` and `"revoked"`. No `executing`/`succeeded`/`failed` states are added to
`ToolAction` itself — per `docs/operators/tool-action-approval.md`'s existing,
deliberate design ("there is deliberately no `executed` state on the `ToolAction`
record itself... execution is tracked separately, as an immutable receipt"), execution
outcome remains owned by the `toolExecutionReceipts` table and PR #245's hardening of
that layer. Duplicating it on `ToolAction` would create exactly the two-parallel-
mechanisms risk Issue #243 warned about.

```
proposed -> approved   (unchanged)
proposed -> rejected   (unchanged)
approved -> revoked    (NEW)
approved -> expired    (NEW, observed lazily on next mutation touch)
```

`rejected`, `expired`, `revoked` are terminal. `reject()` keeps its exact existing
meaning (only valid from `proposed`); `revoke()` is the only path out of `approved`.

## Expiry policy (R-048)

- `approve()` stamps `approvalExpiryPolicy: "ttl" | "non-expiring"` and, when `"ttl"`,
  `approvalExpiresAt: number`.
- Default TTL is **derived** from the action's own existing classification
  (`destructive` flag, already present) rather than a new per-family config surface:
  destructive actions get a short ceiling; non-destructive actions get a longer
  default. Both are named constants in `toolActionLogic.ts`, overridable per-call
  within a hard clamped range via an optional `approvalTtlMs` argument to `approve()`.
- `"non-expiring"` is never caller-selectable — reserved for a future, explicitly
  reviewed allowlist (empty in this slice).
- Enforcement is lazy/on-touch, matching this repo's existing convention (no
  `crons.ts` exists anywhere). `approve()`'s idempotent re-approve path is extended: if
  the stored approval has since expired, it persists the `expired` transition and
  **returns** the now-expired doc, instead of silently returning the stale
  `"approved"` doc. **Important Convex-specific correction made during
  implementation:** the original design called for this branch to throw after
  persisting — but Convex mutations are all-or-nothing transactions, so a write
  followed by a throw in the same call rolls the write back, silently discarding the
  very expiry observation it was trying to record. The corrected design returns the
  updated doc instead (mirroring how `reject()`'s own idempotent-match path already
  returns rather than throws) and pushes the "reject this as an error" decision to
  whichever non-transactional boundary layer consumes the result (the deferred HTTP
  wiring) — that layer can safely inspect `result.state !== "approved"` and turn it
  into an actual error response.
- `now === expiresAt` is treated as **expired** (`now >= expiresAt`), not valid — the
  boundary favors fail-closed.
- Convex **queries** (`get`, `listRecent`) cannot write, so they instead expose a
  computed, read-only `isApprovalExpired: boolean` without mutating the stored
  `state` — the actual persisted transition happens the next time a *mutation*
  touches the row.
- A caller-supplied `now` is only ever used for **test determinism** — it is never
  read from an HTTP request body, so a caller can never extend or fabricate approval
  authority by supplying a favorable clock value from outside.

## Revocation (R-049)

- New Convex mutation `revoke` (`convex/toolActions.ts`): `{serviceToken, projectKey,
  actionId, reason, now?}`. No `expectedRevision` — revocation doesn't interact with
  project-revision conflicts.
- Valid only from `state === "approved"`. Idempotent: same `reason` on an
  already-`revoked` action is a no-op; a different `reason` throws.
- Stamps `revokedBy: "user"`, `revokedReason`, `revokedAt`.
- Prospective-only: stops future executions, never claims to undo a completed one.
- Owner-scoped via the existing `requireOwner`/`requireAction` pattern — identical
  boundary to every other mutation in this file.

## Consumption policy (R-050, needed to give "before consumption" real meaning)

- New field `consumptionPolicy: "single-use" | "reusable"`, stamped at `approve()`
  time, **derived** from the `destructive` flag already present on every `ToolAction`
  row (destructive → `single-use`; non-destructive → `reusable`). Note: `destructive`
  is a **per-proposal**, caller-declared, server-validated field (`stage()`'s
  `validateToolAuthority` already requires `requiredAuthority: "T3"` whenever
  `destructive: true`) — it is not a fixed property of a tool/operation pair. This
  means consumption policy naturally varies per-proposal exactly the way authority
  requirements already do, using a signal the system already trusts for a materially
  similar purpose. No existing family has a fixed destructive/non-destructive
  identity to preserve or break — each proposal declares it fresh, so there is no
  single-family "behavior change" to flag here; whichever specific proposals happen
  to be marked destructive today (and are therefore already required to carry T3
  authority) simply also become single-use going forward, which is the intended,
  tightening effect of R-050.
- This is a Convex-side field only in this slice. The actual execute()-time
  consumption check (blocking a second execution against an already-consumed
  single-use action, independent of idempotency key) is deferred with the rest of the
  `toolExecution.ts` wiring, since it requires touching that file.
- **Correction found by independent review, after the execute()-time check landed:**
  the first implementation of that check (`listReceiptsForAction` on
  `ToolExecutionReceiptStore`, called at the top of `executeOnce()`) read past receipts
  *before* invoking the tool, then relied on the *next* attempt observing a saved
  receipt to detect consumption. Two different-key concurrent executions could both
  run this read before either had saved anything, so both would observe "not yet
  consumed" and both would cross the external-effect boundary — a genuine
  read-before-effect race, proven by a focused concurrent regression test
  (`Promise.all` of two different-key `execute()` calls; the buggy version invoked the
  definition twice). The fix replaces that check with an **atomic execution claim**:
  a new Convex mutation `claimSingleUseExecution` (owner + actionId scoped, new
  `singleUseClaimedAt`/`singleUseClaimId` fields on `ToolAction`, both additive) that
  Convex's own OCC serializes across any number of concurrent callers, called
  immediately before the external effect rather than at the top of the function. The
  claim is never released. `revoke()`'s own consumption check was extended to also
  treat an outstanding claim as consumption, not only a completed receipt, closing an
  adjacent gap (a claimed-but-not-yet-completed execution should not be revocable
  either). The now-superseded `listReceiptsForAction` method/query was removed rather
  than left as unused dead code.

## Concurrency

- All new/changed Convex mutations run as ordinary single Convex mutations — the
  platform's existing OCC on the `toolActions` document is sufficient; no new lease or
  lock primitive is introduced, matching how `approve`/`reject` already work today.
- A concurrency test proves two racing calls against the same document (e.g.
  concurrent `revoke` attempts, or `revoke` racing an expiry-observing `approve`
  retry) produce exactly one authoritative, non-corrupted final state — mirroring the
  existing test style in `reconciliationWorker.test.ts` ("two concurrent runOnce calls
  ... produce exactly one resolved and one idle").

## Audit trail

New `auditEvents` rows via the existing `appendAudit()` helper (no schema change,
`eventType` is a free string): `tool.action.approval-expired`, `tool.action.revoked`.
Additive to, not a replacement for, the existing `proposed`/`approved`/`rejected`
audit trail.

## Schema changes (additive only)

`toolActions` table: widen `state` union (+`"expired"`, +`"revoked"`); add
`approvalExpiryPolicy?`, `approvalExpiresAt?`, `expiredObservedAt?`,
`consumptionPolicy?`, `revokedBy?`, `revokedReason?`, `revokedAt?` — all optional.
Mirrored in `toolActionValidators.ts`. No index changes required (existing
`by_owner_and_project_key_and_state` index is not enum-bound).

## Migration safety

Pure additive widen; existing rows validate unchanged. Rows already `approved` before
this ships have no expiry/consumption fields — treated as legacy/unenforced, not
retroactively expired. Every approval created after deployment gets an explicit
classification.

## Test plan (red-green-refactor, one behavior at a time)

1. `toolActionLogic.test.ts`: TTL clamping/derivation pure functions; consumption-
   policy derivation; expiry boundary (`now === expiresAt` → expired).
2. New `convex/toolActions.test.ts` (real `convexTest` harness, mirroring
   `convex/buildLogs.test.ts`'s style): approve stamps expiry/consumption; idempotent
   re-approve of an expired approval persists `expired` + throws; `revoke` happy path,
   idempotent same-reason, different-reason throws, throws on non-approved, throws on
   already-revoked; owner isolation (owner B cannot revoke/approve/see owner A's
   action); concurrent-revoke race produces one authoritative outcome; `get`/
   `listRecent` compute `isApprovalExpired` without persisting a write.
3. `tests/convexToolActions.test.ts`: adapter-layer mapping test for `revoke()` and
   the new fields, mirroring existing `approve`/`reject` adapter tests.

## Deferred follow-up (blocked on PR #245 landing)

- Wire `revoke()` into a new `POST .../tool-actions/{actionId}/revoke` HTTP route in
  `toolActionController.ts`, gated by the same `approvalToken` as `/approve`.
- Add the execute()-time check in `toolExecution.ts`: block with `errorCode:
  "approval-expired"` / `"approval-consumed"` before attempting execution.
- Consolidate this doc's content into `docs/operators/tool-action-approval.md` once
  PR #245's own doc edits have landed, to avoid a doc-merge conflict now.

## Phase 2 (shipped in this slice): read-only inspection surfaces

- **MCP:** two new read-only tools, `list_tool_actions` and `get_tool_action`, mirroring
  the existing `list_quotes`/`get_quote` template exactly (`readAnnotations`,
  `registerAppTool`, an `operationContract.ts` entry). Both are asserted, in
  `tests/mcpToolActionInspection.test.ts`, to be `readOnlyHint: true`,
  `destructiveHint: false`, and that no MCP tool matching
  `/^(approve|revoke|reject|execute)_tool_action$|^execute$/` or
  `/^finalize_quote|^send_quote/` exists anywhere in the catalogue. `x-mcp-tool.exposed`
  flipped `false -> true` for these two OpenAPI operations only (not `approveToolAction`,
  which stays `false`).
- **HUD:** a new "GOVERNED ACTIONS" panel in Console 01 (`jarvis-console-01`), reusing
  its existing fixed-namespace precedent (`NOTES_PROJECT_ID`, since Console 01 has no
  project-selection UI) and existing panel styling. It is a bounded (`limit:
  request.pageSize`), read-only, recent-first snapshot from `toolActions.listRecent` —
  no cursor pagination exists for tool actions yet, so it is not presented as a complete
  register. It shows tool/operation, state, required authority, and — for `approved` —
  the exact expiry timestamp or a truthful `isApprovalExpired`/`revokedReason` string.
  **No approve, revoke, reject, or execute control is rendered**, per the mission's
  explicit instruction not to add approval controls until the execute()-time
  expiry/consumption enforcement (still deferred above) is actually wired in. Degraded
  state (`status: "degraded"`) shows an empty list, never a fabricated one.

## Phase 3: documentation corrections

Repo-wide search for stale ToolAction-lifecycle claims (state machine, expiry,
revocation, audit trail, MCP/HTTP surface, "actions that remain unavailable") found
exactly one file with content this slice makes inaccurate:
`typescript/docs/operators/tool-action-approval.md`. It is untouched in this PR because
PR #245's own Task 4 is concurrently editing it (per its plan and its PR description's
"Documentation" line); editing it now would conflict with in-flight work on a shared
file. `docs/registries/tool-registry.yaml` was also checked — it documents
tool/operation-to-implementation bindings (authority tiers, execution definitions), not
the `ToolAction` consent state machine, so nothing in it is made stale by this slice.
No other `.md`/`.yaml` file in the repo asserts a specific `ToolAction` state count,
expiry behavior, or revocation semantics.

The exact corrections to apply to `tool-action-approval.md`, once PR #245 lands and this
branch is rebased onto the resulting `main`, are:

1. **State machine section** — replace:

   ```text
   proposed -> approved
            -> rejected
   ```

   with:

   ```text
   proposed -> approved
            -> rejected
   approved -> revoked    (owner-initiated, before consumption)
   approved -> expired    (server-observed, lazily, on next mutation touch)
   ```

   and add one paragraph: *"`rejected`, `expired`, and `revoked` are terminal — no
   transition leaves them. An approval carries an explicit
   `approvalExpiryPolicy: "ttl" | "non-expiring"` and, when `"ttl"`, an
   `approvalExpiresAt` timestamp; `now >= approvalExpiresAt` (the boundary itself counts
   as expired) is checked and persisted the next time any mutation touches the row —
   there is no scheduled sweep. A caller-supplied clock value is accepted only for test
   determinism and is never read from an HTTP request in production, so it can never
   extend or fabricate approval authority. Revocation is owner-scoped, idempotent for a
   repeated identical reason, and prospective-only: it stops a future execution attempt
   and never claims to undo one already in flight — see Execution below for how a
   revocation racing a live execution resolves. Neither transition deletes the action or
   any audit evidence; both are recorded exactly like `approved`/`rejected` today."*

2. **Audit evidence section** — the bullet list currently reads
   `tool.action.proposed` / `.approved` / `.rejected`; add
   `tool.action.approval-expired` and `tool.action.revoked` to it.

3. **New "Consumption" note** (wherever the doc discusses `destructive`) — *"Every
   approval also carries a `consumptionPolicy: "single-use" | "reusable"`, derived from
   the proposal's own `destructive` flag (destructive -> single-use). Enforcement that
   blocks a second execution of an already-consumed single-use action independent of
   idempotency key lands with the execute()-time check described in the deferred
   follow-up below; until then this field is recorded but not yet enforced at
   execution time."*

4. **HTTP operations table** — once the deferred `POST .../tool-actions/{actionId}/revoke`
   route ships, add it as a row, gated by the same `approvalToken` as `/approve`, and
   note that revoking an action whose execution has already produced a completed
   receipt (`succeeded`/`failed`/`indeterminate`) is rejected rather than silently
   accepted (see "already consumed" in `revoke()`'s Convex-side check).

5. **Operator recovery note** (new, short paragraph) — *"An `indeterminate` execution
   receipt (see PR #245's reconciliation hardening) means the external side effect's
   outcome is not yet known — it is neither a proven success nor a proven failure.
   Revoking the governing `ToolAction` in that state does not retract the in-flight
   external attempt; reconciliation (not revocation) is the mechanism that eventually
   resolves an indeterminate receipt to its true terminal outcome. An operator who wants
   to stop *future* executions of the same proposal should revoke it; an operator asking
   'did the external write actually happen' should consult the receipt and its
   reconciliation state, not the `ToolAction`'s own `state` field."*

## Actions that remain unavailable (unchanged by this slice)

Customer quote email sending; quote finalisation through MCP or HUD; accepted/rejected
commercial-outcome changes; unrestricted generic `ToolAction` execution; production
deployment; live Outlook commissioning; credential creation/rotation; destructive record
deletion; automatic merging without exact-head human approval; fabricated telemetry.
This slice adds no new capability to any of these — it only makes existing `approved`
authority expire and become revocable, and makes that state inspectable read-only
through MCP and the Console 01 HUD.
